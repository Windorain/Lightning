/**
 * `domain/multiblock` —— **通道定义 / 有效值 / 通用阶跃轨道**（#249 §3.3 §7；契约 §6.2）。
 *
 * ## 本模块替代的旧机制（B5 退役矩阵 #4 的求值半边）
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | 每视口独立暂存通道取值 | `shared/viewport/useMultiblockChannels.ts`（每视口一份 `state` + `revision`） | 通道取值属 `EditContext`（#249 §3.4），投影由 `domain/multiblockSelection` + `domain/animation#resolveEffectiveValue` 承担 |
 * | 各视口各自把取值差异经 `bindMultiblockMeshSync` 推给 DRW 重建 | 同上 | 装配结果是求值产物，由呈现消费；**没有**"值变了就手动 rebuild"的链（#249 §15 第 5 条） |
 * | 通道取值夹取后继续渲染 | `multiblockChannelUi.clampChannelValue` + `assembleForSelection` 的 clamp | 夹取/回落落在**投影**（`domain/multiblockSelection#clampChannelValue`/装配器 report），本模块只做值域类型与通用轨道 |
 *
 * ## M5-5 退役：本模块的「第二条求值/写权」已删
 *
 * 曾经并存的 `evaluateChannelAssembly` / `validateChannelValues` / `channelWriteAuthority`
 * （以及只为它们服务的 `AssembledChannels`/`AssemblyInput`）**零生产消费者**，
 * 且与生产的求值口径相反（生产是"只夹取不拒绝"）⇒ M5-5 同批删除，
 * 求值的唯一权威是 `context/multiblock#assembleSelection` + `composition/kernelMultiblockEvaluation`，
 * 写权按 `domain/scene` 的 `ObjectData.source` 判定。防回流判据见
 * `domain/__tests__/multiblockChannelTimeEntry.test.ts` 与 `application/__tests__/retirementRegistry.test.ts`。
 *
 * ## 写权判定（#249 §3.3 明文）
 *
 * 「多方块声明作为**只读内容定义**…生成对象可查询和拾取，但其写能力为**只读**…
 * 若它与可编辑对象同文档出现，写权**按拥有者/内容来源**判断，**不使用整份文档一个布尔值**
 * 粗略代替。」
 *
 * `domain/scene` 的 `ObjectData.source` 已经承载"来源"，本模块把多方块生成物的来源
 * 显式标为 `'content'`（`generatedObjectWriteAuthority` 转发按来源判定）。
 * 逐通道写权曾是本模块的第二个答案（`channelWriteAuthority`），但生产从未消费它
 * （G4：写权按对象来源，不按通道）⇒ M5-5 删除，避免"域层已支持逐通道"的假象。
 *
 * ## 通道动画复用通用架构（#249 §7 明文；M5-1 修订）
 *
 * 「通道动画的扩展方式是注册**属性描述、取值策略和求值依赖**；**不新增调度环、
 * 专用轨道执行器或"若 multiblock 则另一套播放"**。」
 *
 * ⇒ 本模块**不含**任何播放循环、定时器或轨道执行器。它只提供**通用**构件：
 *  - `channelStepTrack`：用 `domain/animation` 的 `step` 采样策略构造轨道
 *    （轨道目标用**通用属性面**直接构造 `PropertyRef`，不再有中间寻址包装）；
 *  - 约束列表构造（`range`/`enum`/`coupling`）——**与轨道校验同一套** `ParameterConstraint` 纯值，
 *    校验由 `domain/animation#validateParameterSet` 执行（本模块不新造校验器）。
 *
 * ## M5-1（2026-10-18 用户裁决）：场景清单**不是**时间轨道来源
 *
 * 多方块文档的帧清单 = **变体配置集合（场景，Scene）**，与时间轴无关、永不参与播放。
 * 故本模块**不再**提供"帧清单 → 阶跃关键帧"的桥：原 `sizeChannelStepKeys`
 * （把 `frame.stepIndex` 折成 `min + stepIndex` 的时轴关键帧）已同批删除。
 * `channelStepTrack` 仍接受调用方显式给的关键帧 —— 它是**通用**轨道构造器，
 * 不读取任何帧/场景清单。
 */

import { invalidValue, type DomainError, type Result, ok, err } from './errors'
import {
  resolveEffectiveValue,
  sampleTrack,
  type AnimationTrack,
  type EffectiveValueLayer,
  type ParameterCandidate,
  type ParameterConstraint,
  type TimeValue,
  type TrackValue,
} from './animation'
import { entityRef, propertyRef } from './identity'
import { findObject, findObjectData, type Scene } from './scene'

// ─────────────────────────────────────────────────────────────────────────────
// 通道定义（值类型 / 合法域 / 约束）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 通道的取值语义。
 *
 * 与旧 `MultiblockChannelKind`（`'size' | 'replace' | 'hatch'`）的关系：那是**装配器**
 * 对通道用途的分类（用于写网格）。本枚举描述的是**值域形态**，因为求值面只关心
 * "能不能插值、怎么量化"。两者不是替代关系：适配器（P9/#260 方向）负责把外部声明
 * 翻译成这里的值域形态；旧装配器由 P6 在通道面板重写时退役（删除点见汇报）。
 */
export type ChannelValueKind = 'integer' | 'number' | 'enum' | 'boolean'

/** 通道值域（合法域 + 约束）。 */
export interface ChannelDomain {
  readonly kind: ChannelValueKind
  /** 数值型的下界（含）。 */
  readonly min?: number
  /** 数值型的上界（含）。 */
  readonly max?: number
  /** 枚举型的合法成员。 */
  readonly allowed?: readonly (string | number)[]
  /** 量化策略（受限整数通道；#249 §7「可显式注册量化策略」）。 */
  readonly step?: number
  /** `0` 是否表示"未设置"（旧声明的约定；仅作诊断标注，不改变校验）。 */
  readonly zeroMeansUnset?: boolean
}

/**
 * 通道定义（#249 §3.3「通道定义描述值类型、合法域及约束」）。
 */
export interface ChannelDefinition {
  /** 本文档内唯一键（稳定）。 */
  readonly key: string
  /** 呈现名（UI 标签；来自文件声明，不做 capitalize 猜测）。 */
  readonly name: string
  readonly domain: ChannelDomain
  /** 声明级联约束（对本通道与其它通道的耦合）。 */
  readonly constraints?: readonly ParameterConstraint[]
  /**
   * 归属：`'content'` = 只读内容声明（多方块生成物），`'document'` = 用户可发布默认值。
   * 这是"写权按拥有者"在通道层的落点。
   */
  readonly source: 'content' | 'document'
}

/** 一组通道定义（一个多方块声明的求值输入）。 */
export interface ChannelSet {
  readonly id: string
  readonly channels: readonly ChannelDefinition[]
}

export function findChannel(set: ChannelSet, key: string): ChannelDefinition | undefined {
  return set.channels.find((c) => c.key === key)
}

// ─────────────────────────────────────────────────────────────────────────────
// 通道 → 轨道目标（让通用轨道能寻址通道）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 通道的具名拥有者。
 *
 * 用 `objectData` 而非 `document`：通道取值是**内容定义**的一部分，写在数据层
 * 与"对象/数据分离"（#249 §3.1）一致；用文档级拥有者会让"同文档内哪个多方块的哪个通道"
 * 无法从引用本身分辨。
 */
export const MULTIBLOCK_OWNER_KIND = 'objectData' as const

// ─────────────────────────────────────────────────────────────────────────────
// 约束构造（复用通用纯校验，不新造校验器）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 由通道定义派生约束列表。
 *
 * 关键：产出的类型是 `domain/animation` 的 `ParameterConstraint` —— 通道校验与
 * 轨道校验走**同一套**纯校验器（`domain/animation#validateParameterSet`，由调用方执行）。
 * 造第二套"通道专用校验"正是 #249 §7 禁止的"若 multiblock 则另一套"。
 */
export function channelConstraints(set: ChannelSet): readonly ParameterConstraint[] {
  const out: ParameterConstraint[] = []
  for (const ch of set.channels) {
    const d = ch.domain
    if (d.kind === 'integer' || d.kind === 'number') {
      if (d.min !== undefined && d.max !== undefined) {
        out.push(Object.freeze({ kind: 'range', key: ch.key, min: d.min, max: d.max }))
      }
      // 整数域的"取值必须是整数"用 custom 表达（`range` 只管区间）。
      if (d.kind === 'integer') {
        out.push(
          Object.freeze({
            kind: 'custom' as const,
            id: `integer:${ch.key}`,
            keys: Object.freeze([ch.key]),
            check: (c: ParameterCandidate) => {
              const v = c[ch.key]
              return v === undefined || (typeof v === 'number' && Number.isInteger(v))
            },
          }),
        )
      }
    } else if (d.kind === 'enum' && d.allowed) {
      out.push(Object.freeze({ kind: 'enum', key: ch.key, allowed: d.allowed }))
    } else if (d.kind === 'boolean') {
      out.push(
        Object.freeze({
          kind: 'custom' as const,
          id: `boolean:${ch.key}`,
          keys: Object.freeze([ch.key]),
          check: (c: ParameterCandidate) => {
            const v = c[ch.key]
            return v === undefined || v === 0 || v === 1
          },
        }),
      )
    }
    for (const c of ch.constraints ?? []) out.push(c)
  }
  return Object.freeze(out)
}

/** 生成物对象的写权（转发 `domain/scene` 的按来源判定，供多方块消费者统一入口）。 */
export function generatedObjectWriteAuthority(scene: Scene, objectId: string): 'writable' | 'readOnly' | 'missing' {
  const obj = findObject(scene, objectId)
  if (!obj) return 'missing'
  const data = findObjectData(scene, obj.dataId)
  if (!data) return 'missing'
  return data.source === 'content' ? 'readOnly' : 'writable'
}

// ─────────────────────────────────────────────────────────────────────────────
// 阶跃通道轨道（验收 F1 / #249 §7 明文要求的证明路径）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 由通道定义构造一条**阶跃**轨道。
 *
 * 这是 #249 §7 那句要求的字面落地：
 * 「通道动画的扩展方式是注册属性描述、取值策略和求值依赖；不新增调度环、
 * 专用轨道执行器或"若 multiblock 则另一套播放"。**本次通过至少一条阶跃通道轨道
 * 证明该路径**。」
 *
 * ⇒ 返回的是**通用** `AnimationTrack`（`domain/animation` 的类型），
 * 采样走通用 `sampleTrack`，与变换/形变轨道**完全同一套**代码。
 * 本函数只做"通道值域 → 轨道参数"的翻译，不引入任何执行器。
 */
export function channelStepTrack(
  set: ChannelSet,
  channelKey: string,
  keys: readonly { readonly time: TimeValue; readonly value: number }[],
  enabled = true,
): Result<AnimationTrack> {
  const ch = findChannel(set, channelKey)
  if (!ch) return err(invalidValue({ reason: 'channelNotDeclared', channel: channelKey, channelSet: set.id }))
  // 轨道目标走**通用属性面**（M6-1）：通道键 → `channel.<key>` 属性引用，唯一拥有者
  // 是 `objectData`（通道取值是内容定义的一部分，见 {@link MULTIBLOCK_OWNER_KIND}）。
  const target = propertyRef(entityRef(MULTIBLOCK_OWNER_KIND, set.id, undefined), `channel.${ch.key}`)
  return ok(
    Object.freeze({
      id: `track:${set.id}:${channelKey}`,
      target,
      valueType: ch.domain.kind === 'integer' ? 'integer' : ch.domain.kind === 'boolean' ? 'boolean' : ch.domain.kind === 'enum' ? 'enum' : 'number',
      // 台阶离散通道：阶跃（#249 §7「枚举、布尔、离散通道：阶跃」）。
      interpolation: 'step' as const,
      enabled,
      keys: Object.freeze(keys.map((k) => Object.freeze({ time: k.time, value: k.value as TrackValue }))),
      ...(ch.domain.kind === 'enum' && ch.domain.allowed ? { legalValues: Object.freeze([...ch.domain.allowed]) as readonly TrackValue[] } : {}),
      ...(ch.domain.kind === 'integer' ? { quantization: Object.freeze({ kind: 'integer' as const }) } : {}),
    }),
  )
}

/**
 * 在给定时间求一条通道轨道（**纯**；复用通用采样器）。
 *
 * 这是"同时间同结果"在通道面上的入口：同一 `(track, time)` 恒得同一取值，
 * 与视口数量、刷新率、是否正在播放**全部无关**。
 */
export function sampleChannelAt(
  track: AnimationTrack,
  time: TimeValue,
): Result<TrackValue> {
  const s = sampleTrack(track, time)
  if (!s.ok) return s
  return ok(s.value.value)
}

/**
 * 通道的**有效值**：手动预览值 / 轨道采样 / 暂存覆盖按优先级解析。
 *
 * 「动画输出覆盖当前求值参数，**不反写**手动取值」（#249 §3.3）——
 * 本函数只读三层、只返回赢家，没有任何写回路径，故"不反写"是结构性质。
 */
export interface ChannelEffectiveInput {
  /** 发布默认值（文档层）。 */
  readonly publishedDefault?: number
  /** 编辑上下文手动预览值（`EditContext.channelValues`）。 */
  readonly manualPreview?: number
  readonly track?: AnimationTrack
  readonly time?: TimeValue
  /** 活动编辑操作的暂存覆盖。 */
  readonly stagingOverride?: number
}

export interface ChannelEffective {
  readonly value: number
  readonly source: EffectiveValueLayer['kind']
}

export function resolveChannelEffective(input: ChannelEffectiveInput): Result<ChannelEffective> {
  const layers: EffectiveValueLayer[] = []
  if (input.publishedDefault !== undefined) layers.push({ kind: 'base', value: input.publishedDefault })
  if (input.manualPreview !== undefined) layers.push({ kind: 'manualPreview', value: input.manualPreview })
  if (input.track && input.track.enabled && input.time) {
    const s = sampleTrack(input.track, input.time)
    if (!s.ok) return err(s.error)
    layers.push({ kind: 'trackSample', value: s.value.value })
  }
  if (input.stagingOverride !== undefined) layers.push({ kind: 'stagingOverride', value: input.stagingOverride })

  const resolved = resolveEffectiveValue(layers)
  if (!resolved.ok) return resolved
  const v = resolved.value.value
  if (typeof v !== 'number') {
    return err(invalidValue({ reason: 'channelEffectiveNotNumeric', source: resolved.value.source, property: String(v) }))
  }
  return ok(Object.freeze({ value: v, source: resolved.value.source }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 声明（声明半）→ 通道集合（求值半入口）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 声明侧通道的**最小读面**（结构化输入）。
 *
 * ## 为什么是结构类型而不是 import 声明半的类型
 *
 * 声明半是 `domain/multiblockDocument#MultiblockChannel`（22 字段的声明承载），
 * 而求值半只用到其中四个：键、呈现名、值域上下界与值域形态。若这里 import 那份类型，
 * 求值半就被绑在**声明承载的完整形状**上 —— 声明半每加一个字段（G3 已发生过一次）
 * 都要重新审求值半。结构类型让"求值半读了什么"在签名上可见（与
 * `domain/multiblockDocument` 文件头"声明半 vs 求值半"的分工一致）。
 */
export interface DeclaredChannelLike {
  /** 声明里的通道键（`decl.channels[].key`）。 */
  readonly key: string
  /** 呈现名（UI 标签）。 */
  readonly name: string
  /** 声明侧的值域形态（`'size' | 'replace' | 'hatch'`；此处只作诊断标注）。 */
  readonly kind: string
  /** 有效取值下界（含）。 */
  readonly min: number
  /** 有效取值上界（含）。 */
  readonly max: number
}

/**
 * 把一份**多方块声明**的通道清单翻成求值半的 {@link ChannelSet}。
 *
 * ## 为什么值域一律收成 `integer`（不按 `kind` 猜 `boolean`）
 *
 * 契约 §4.2 给三类通道（`size`/`replace`/`hatch`）都声明了 `min`/`max`/`domain`，
 * 即**它们的取值都是一个数值域**；`kind` 描述的是装配用途，不是值的"能不能插值"形态
 * （见 {@link ChannelValueKind} 的说明）。把 `hatch` 猜成 `boolean` 会凭空造出一个
 * 声明里没有的形态 —— 那正是"用当前实现替代对象身份"的同族错误。故三类一律
 * `'integer'`（离散、阶跃、受限整数），并把量化策略交给调用方
 * （{@link channelStepTrack} 会为 `integer` 附 `{ kind: 'integer' }`）。
 *
 * ## 为什么 `source` 恒为 `'content'`
 *
 * 这些通道来自**多方块生成物的只读声明**（#249 §3.3），不是用户发布的文档默认值。
 * 写权按对象数据来源判定（`domain/scene#ObjectData.source`：`'content'` ⇒ 只读）；
 * 需要表示"文档发布"的调用方自行覆盖该字段，本函数不猜。
 */
export function channelSetOfDeclaration(
  declarationId: string,
  channels: readonly DeclaredChannelLike[],
): ChannelSet {
  return Object.freeze({
    id: declarationId,
    channels: Object.freeze(
      channels.map((ch) =>
        Object.freeze({
          key: ch.key,
          name: ch.name,
          domain: Object.freeze({ kind: 'integer' as const, min: ch.min, max: ch.max }),
          source: 'content' as const,
        }),
      ),
    ),
  })
}


/** 未使用占位：保持 `DomainError` 类型可达（下游 `import type`）。 */
export type { DomainError }
