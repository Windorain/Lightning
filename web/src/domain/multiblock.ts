/**
 * `domain/multiblock` —— **通道定义、纯装配求值、写权按拥有者判定**（#249 §3.3 §7；契约 §6.2）。
 *
 * ## 本模块替代的旧机制（B5 退役矩阵 #4 的求值半边）
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | 每视口独立暂存通道取值 | `shared/viewport/useMultiblockChannels.ts`（每视口一份 `state` + `revision`） | 通道取值属 `EditContext`（#249 §3.4），装配是**纯函数** `evaluateChannelAssembly` |
 * | 各视口各自把取值差异经 `bindMultiblockMeshSync` 推给 DRW 重建 | 同上 | 装配结果是求值产物，由呈现消费；**没有**"值变了就手动 rebuild"的链（#249 §15 第 5 条） |
 * | 通道取值夹取后继续渲染 | `multiblockChannelUi.clampChannelValue` + `assembleForSelection` 的 clamp | `validateChannelValues` **不夹取**，非法组合产生可诊断失败（#249 §7） |
 *
 * ## 写权判定（#249 §3.3 明文）
 *
 * 「多方块声明作为**只读内容定义**…生成对象可查询和拾取，但其写能力为**只读**…
 * 若它与可编辑对象同文档出现，写权**按拥有者/内容来源**判断，**不使用整份文档一个布尔值**
 * 粗略代替。」
 *
 * `domain/scene` 的 `ObjectData.source` 已经承载"来源"，本模块把多方块生成物的来源
 * 显式标为 `'content'`，并提供 `channelWriteAuthority` 支持**逐通道**的写权
 * （手动预览值可改，声明本身不可改）—— 那是"文档级布尔"无法表达的粒度。
 *
 * ## 通道动画复用通用架构（#249 §7 明文）
 *
 * 「通道动画的扩展方式是注册**属性描述、取值策略和求值依赖**；**不新增调度环、
 * 专用轨道执行器或"若 multiblock 则另一套播放"**。本次通过至少一条**阶跃通道轨道**
 * 证明该路径。」
 *
 * ⇒ 本模块**不含**任何播放循环、定时器或轨道执行器。它只提供：
 *  - `channelToPropertyRef`：把通道映射到一个 `PropertyRef`（于是通用轨道能寻址它）；
 *  - `channelStepTrack`：用 `domain/animation` 的 `step` 采样策略构造轨道；
 *  - 约束列表构造（`range`/`enum`/`coupling`）供 `validateParameterSet` 复用。
 * 验收 F1 的证据就是这条路径（见 `domain/__tests__/animationTrack.test.ts`）。
 */

import { invalidValue, type DomainError, type Result, ok, err } from './errors'
import {
  propertyKey,
  resolveEffectiveValue,
  sampleTrack,
  validateParameterSet,
  type AnimationTrack,
  type EffectiveValueLayer,
  type ParameterConstraint,
  type TimeValue,
  type TrackValue,
} from './animation'
import { entityRef, propertyRef, type PropertyRef } from './identity'
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
// 通道 → PropertyRef（让通用轨道能寻址通道）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 通道的具名拥有者。
 *
 * 用 `objectData` 而非 `document`：通道取值是**内容定义**的一部分，写在数据层
 * 与"对象/数据分离"（#249 §3.1）一致；用文档级拥有者会让"同文档内哪个多方块的哪个通道"
 * 无法从引用本身分辨。
 */
export const MULTIBLOCK_OWNER_KIND = 'objectData' as const

/** 把通道键映射成可寻址属性引用（通用轨道目标）。 */
export function channelToPropertyRef(set: ChannelSet, channelKey: string): Result<PropertyRef> {
  const ch = findChannel(set, channelKey)
  if (!ch) return err(invalidValue({ reason: 'channelNotDeclared', channel: channelKey, channelSet: set.id }))
  return ok(
    propertyRef(entityRef(MULTIBLOCK_OWNER_KIND, set.id, undefined), `channel.${ch.key}`),
  )
}

/** 反向：属性引用是否是某通道（供有效值解析/写入拒绝识别通道写）。 */
export function channelKeyOfProperty(ref: PropertyRef): string | null {
  if (!ref.property.startsWith('channel.')) return null
  return ref.property.slice('channel.'.length)
}

// ─────────────────────────────────────────────────────────────────────────────
// 约束构造（复用通用纯校验，不新造校验器）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 由通道定义派生约束列表。
 *
 * 关键：产出的类型是 `domain/animation` 的 `ParameterConstraint` —— 通道校验与
 * 轨道校验走**同一套**纯校验器（`validateParameterSet`）。
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
            kind: 'custom',
            id: `integer:${ch.key}`,
            keys: Object.freeze([ch.key]),
            check: (c: Readonly<Record<string, number>>) => {
              const v = c[ch.key]
              return v === undefined || Number.isInteger(v)
            },
          }),
        )
      }
    } else if (d.kind === 'enum' && d.allowed) {
      out.push(Object.freeze({ kind: 'enum', key: ch.key, allowed: d.allowed }))
    } else if (d.kind === 'boolean') {
      out.push(
        Object.freeze({
          kind: 'custom',
          id: `boolean:${ch.key}`,
          keys: Object.freeze([ch.key]),
          check: (c: Readonly<Record<string, number>>) => {
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

/**
 * 校验一组通道取值（**完整候选参数集**，不夹取）。
 *
 * `provided` 只需含被设置的通道；未提供的通道视为"未设置"，其约束被跳过
 * （`validateParameterSet` 对 `undefined` 是 skip 语义 —— 那是"没设置"而不是"设置了 0"，
 * 两者在旧声明里靠在表里写 0 区分，见 `ChannelDomain.zeroMeansUnset`）。
 */
export function validateChannelValues(
  set: ChannelSet,
  provided: Readonly<Record<string, number>>,
): Result<Readonly<Record<string, number>>> {
  for (const key of Object.keys(provided)) {
    if (!findChannel(set, key)) {
      return err(invalidValue({ reason: 'channelNotDeclared', channel: key, channelSet: set.id }))
    }
  }
  const v = validateParameterSet(channelConstraints(set), provided)
  if (!v.ok) return v
  return ok(v.value.values)
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯装配求值
// ─────────────────────────────────────────────────────────────────────────────

/** 装配产物（**求值结果**，不是文档内容）。 */
export interface AssembledChannels {
  readonly setId: string
  /** 校验通过的取值（与输入逐位相同 —— 本函数不夹取、不修正）。 */
  readonly values: Readonly<Record<string, number>>
  /** 本次求值实际检查过的约束 id（证据：证明校验真的跑了，而非"没报错因为没查"）。 */
  readonly checkedConstraints: readonly string[]
  /** 装配出的单元（键 = 位置，值 = 内容标识）。 */
  readonly cells: Readonly<Record<string, string>>
  /** 内容版本：由**输入**决定（同输入同版本），供求值键使用。 */
  readonly contentVersion: number
}

/**
 * 装配规则：由位置与取值算出一个单元的内容标识。
 *
 * 规则**从通道定义与内容声明派生**（由调用方传入），本模块不做"若 kind === 'size' 则…"
 * 这类分支 —— 那是 #249 §13 禁止的"改核心 switch"。P6 在通道面板重写时会传入
 * 真正的规则表；本批用最小规则证明「取值变化 ⇒ 装配产物变化 ⇒ 求值键变化」这条链。
 */
export type AssemblyRule = (values: Readonly<Record<string, number>>, position: string) => string | null

export interface AssemblyInput {
  readonly set: ChannelSet
  readonly values: Readonly<Record<string, number>>
  /** 要装配的位置集合（**完整**集合；动态集合的成员变化由依赖图跟踪，见 application/evaluation）。 */
  readonly positions: readonly string[]
  readonly rule: AssemblyRule
}

/**
 * 纯装配求值（#249 §3.3「纯装配求值」）。
 *
 * 四条性质：
 *  1. **纯**：相同 `(set, values, positions, rule)` 恒得相同产物（含 `contentVersion`）；
 *  2. **不夹取**：非法取值返回 `InvalidValue`（转调 `validateChannelValues`）；
 *  3. **只读内容**：产物是求值结果，**不写文档**；写权判定见 `channelWriteAuthority`；
 *  4. **空结果可表达**：所有位置都装配不出内容 ⇒ 空 `cells`（不是 `null`，
 *     避免"`null` 兼表失败与空"这一 A36 负对照形态）。
 */
export function evaluateChannelAssembly(input: AssemblyInput): Result<AssembledChannels> {
  const validated = validateChannelValues(input.set, input.values)
  if (!validated.ok) return validated

  const cells: Record<string, string> = {}
  for (const pos of input.positions) {
    const content = input.rule(validated.value, pos)
    if (content !== null) cells[pos] = content
  }

  const checked = validateParameterSet(channelConstraints(input.set), validated.value)
  const checkedConstraints = checked.ok ? checked.value.satisfied : Object.freeze([] as string[])

  return ok(
    Object.freeze({
      setId: input.set.id,
      values: validated.value,
      checkedConstraints,
      cells: Object.freeze(cells),
      // 内容版本由输入派生（纯摘要），故"取值集合相同 ⇒ 版本相同"可直接断言。
      contentVersion: assemblyDigest(validated.value, input.positions, cells),
    }),
  )
}

/** 装配产物的内容摘要（纯；FNV-1a，与 `domain/identity` 同族算法，不引入 IO）。 */
function assemblyDigest(
  values: Readonly<Record<string, number>>,
  positions: readonly string[],
  cells: Readonly<Record<string, string>>,
): number {
  const parts: string[] = []
  for (const k of Object.keys(values).sort()) parts.push(`${k}=${values[k]}`)
  parts.push('|')
  for (const p of [...positions].sort()) parts.push(p)
  parts.push('|')
  for (const k of Object.keys(cells).sort()) parts.push(`${k}:${cells[k]}`)
  const serialized = parts.join(',')
  let h = 0x811c9dc5
  for (let i = 0; i < serialized.length; i++) {
    h ^= serialized.charCodeAt(i) & 0xff
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

// ─────────────────────────────────────────────────────────────────────────────
// 写权（按拥有者 / 逐通道，不是文档级布尔）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 通道的写权。
 *
 * `'declarationReadOnly'`：**声明本身**（类型/合法域）不可改 —— 它来自文件内容；
 * `'valueWritable'`：**手动预览取值**可改（#249 §3.3「手动预览取值属编辑上下文」）。
 *
 * 分成两个字段（而不是一个三值枚举）是因为它们**同时**成立：
 * 一个 content 来源通道的取值可写、而它的声明不可写。用一个枚举表达会逼调用方
 * 在"能改值"与"能改声明"之间选一个，从而把"文档级布尔粗略代替"换个形状复活。
 */
export interface ChannelWriteAuthority {
  readonly declareEditable: boolean
  readonly valueEditable: boolean
  /** 拒绝原因（仅当 `valueEditable === false`）。 */
  readonly reason?: string
}

/**
 * 逐通道写权判定（#249 §3.3）。
 *
 * 「不使用整份文档一个布尔值粗略代替」⇒ 本函数**按通道**返回，
 * 且同一声明里不同通道可以给出不同答案（例如声明级只读 + 该通道被文档默认值发布）。
 */
export function channelWriteAuthority(ch: ChannelDefinition): ChannelWriteAuthority {
  if (ch.source === 'content') {
    // 多方块生成物：声明不可改；取值可手动预览（属 EditContext）。
    return Object.freeze({ declareEditable: false, valueEditable: true, reason: 'contentOwnedDeclaration' })
  }
  return Object.freeze({ declareEditable: true, valueEditable: true })
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
  const target = channelToPropertyRef(set, channelKey)
  if (!target.ok) return target
  return ok(
    Object.freeze({
      id: `track:${set.id}:${channelKey}`,
      target: target.value,
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

/** 通道属性键（供文档的驱动集合与缓存键使用；与 `propertyKey` 同一算法）。 */
export function channelPropertyKey(set: ChannelSet, channelKey: string): Result<string> {
  const ref = channelToPropertyRef(set, channelKey)
  if (!ref.ok) return err(ref.error)
  return ok(propertyKey(ref.value))
}

/** 未使用占位：保持 `DomainError` 类型可达（下游 `import type`）。 */
export type { DomainError }
