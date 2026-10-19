/**
 * 「通道」面板的**纯逻辑**（T2.4/T2.5）—— 无 Vue、无 DOM、无 ctx。
 *
 * 分工：
 *  - 本模块：文件声明 → 滑杆规格 / 面板模型（纯派生）。
 *  - `useKernelChannels.ts`：把本模块包成响应式状态（Vue），求值走内核面
 *    （`evaluateMultiblockPresentation` 的唯一求值点）。
 *  - `MultiblockChannelPanel.vue`：纯展示 + 事件（props/emits）。
 *
 * ⚠️ **M6-1**：本文件原有的三个吃 `RuntimeDocument` 的旧文档入口
 * （`assembleForSelection`/`buildChannelPanelModel`/`buildMultiblockRenderView`）
 * **已删除** —— 它们生产零调用、只被切换前后的对照/面板判据消费；本批把那些判据
 * 改为「生产派生（内核读面 + 唯一求值点）+ 冻结夹具/指纹」后同批退场
 * （登记见 `application/__tests__/retirementRegistry.test.ts` 的 `M5_CLOSEOUT`）。
 * 面板模型的唯一派生入口是 {@link channelPanelModelOf}。
 *
 * **忠实展示文件声明**（计划 T2.4 硬约束）：滑杆条数 = 声明条数（`slider === true`，`hatch` 由解析器排除）、
 * 标签取 `name`（呈现名，来自文件）、上限取 `channel.domain.hi`、`0` 显示 `Not set`。
 * 本模块**不猜测通道语义**：`kind` 只用于展示与 `data-*` 观测属性，不改变任何行为分支。
 *
 * ## R2/S3：形参收成**声明事实的结构最小面**（两个载体都能喂）
 *
 * 声明侧入口（`tierSampleValues`/`channelSliderSpecs`/`clampChannelValue`/
 * `initialMultiblockSelection`/`buildChannelPanelModelOf`）吃 {@link MultiblockDeclarationFacts}，
 * 于是**解析形状**（`context/parsers/multiblockDocument`，元素多带 `raw`）与
 * **内核域声明**（`domain/multiblockDocument#MultiblockDeclaration`，元素无 `raw`）
 * 都能喂——消费者适应内核，而不是让内核去兼容旧解析形状。
 * ⇒ 本模块**不再** import 任何旧格式文档类型（`RuntimeDocument`/`AssemblyResult` 等已随旧入口删除）。
 */
import { multiblockVariantKey } from '@/context/runtimeDocument'
import type { ClampRecord } from '@/context/multiblock'
// M5-2：选择投影下沉到 domain（面板 / 装载装配 / 画面求值**同吃一处**）。
// 本模块不再自己实现，只把同一批具名符号转出给既有调用方（签名/语义不变）。
import {
  clampChannelValue,
  initialMultiblockSelection,
  snapTierToSample,
  tierSampleValues,
} from '@/domain/multiblockSelection'
import type {
  MultiblockChannelFacts,
  MultiblockDeclarationFacts,
  MultiblockRunstateFacts,
  MultiblockSelectionState,
} from '@/domain/multiblockSelection'
import type { MultiblockDeclarationView } from '@/domain/multiblockDocument'

export {
  clampChannelValue,
  initialMultiblockSelection,
  snapTierToSample,
  tierSampleValues,
}
export type {
  MultiblockChannelFacts,
  MultiblockDeclarationFacts,
  MultiblockRunstateFacts,
  MultiblockSelectionState,
}

// ---------------------------------------------------------------------------
// 面板模型（props 形状，Embed / Workbench 共用）
// ---------------------------------------------------------------------------

/** 一条通道滑杆的规格（全部来自文件声明）。 */
export interface ChannelSliderSpec {
  /** 通道 key（装配与变体键用） */
  key: string
  /** 呈现名（UI 标签；文件 `name`） */
  name: string
  /** `size` | `replace`（`hatch` 不生成滑杆） */
  kind: string
  /** 有效取值下界（`size` 型语义，仅作观测/提示） */
  min: number
  /** 有效取值上界（`size` 型语义，仅作观测/提示） */
  max: number
  /** 滑杆上限 = 取值域上界（0 = Not set 恒在下界） */
  hi: number
}

/** 面板一次性输入（由 `channelPanelModelOf` 组装）。 */
export interface MultiblockChannelPanelModel {
  displayName: string
  tier: number
  tierMin: number
  tierMax: number
  /** 文档**实际声明**的总 Tier 取值清单（滑杆吸附目标） */
  tierSamples: number[]
  channels: ChannelSliderSpec[]
  /** `channelKey → 声明值`（0 = Not set） */
  values: Record<string, number>
  runstates: Array<{ id: string; name: string }>
  runstate: string
  /**
   * **场景数**（变体配置集合的条数；观测点）。
   *
   * M5-1：这份清单是**场景（Scene）**，不是时间轴上的帧 —— 它与播放无关。
   * 面板显示它只是为了让"文件声明了多少个变体配置"可见。
   */
  sceneCount: number
  /** 当前取值派生的变体键（观测点：装配产物确实随之变化） */
  variantKey: string
  /** 装配结果尺寸 `w×h×d`（观测点；装配失败为空串） */
  dims: string
  /** 只提示不拒绝的提示：文件软约束 notes + 回落/夹取 + 解析瑕疵 */
  notices: string[]
}

// M5-2：`MultiblockSelectionState` 与"声明事实的结构最小面"、以及
// `tierSampleValues`/`snapTierToSample`/`clampChannelValue`/`initialMultiblockSelection`
// 已下沉到 `domain/multiblockSelection`（面板 / 装载装配 / 画面求值同一实现），
// 本文件在文件头以 `export type` / `export` 转出，签名与语义不变。

// ---------------------------------------------------------------------------
// 装配提示（唯一构造点）
// ---------------------------------------------------------------------------

function formatClampText(c: ClampRecord): string {
  if ('field' in c) {
    return `取值夹取：${c.field} ${c.was} → ${c.now}（超出声明取值域）`
  }
  return `耦合夹取：${c.coupling || c.a} ${c.requires} ${c.b}：${c.bWas} → ${c.bNow}`
}

/**
 * **装配提示的唯一构造点**（R2/S3）：文件软约束 + 未命中声明组合的回落 + 夹取 + 警告。
 *
 * ## 为什么是具名函数（而不是在调用点各写一遍）
 *
 * 面板的提示是**可显示的事实**，顺序也是 ⇒ 提示文案只能有一份实现。
 * 生产装配来源是内核面（`assembleMultiblockKernelFace` 的 `report`），
 * 由 {@link channelPanelModelOf} 喂入。
 *
 * ⚠️ `report === null` = **没有装配结论**（未装配/装配失败），此时只有文件软约束提示 ——
 * 与旧实现"notes 先入表、失败再追加一条"的顺序逐字一致。
 */
export function assemblyNoticesOf(input: {
  readonly notes: readonly Readonly<{ readonly text: string }>[]
  readonly variantKey: string
  readonly declared: boolean
  readonly report: Readonly<{
    readonly variantKey: string
    readonly clamped: readonly ClampRecord[]
    readonly warnings: readonly string[]
  }> | null
}): string[] {
  const notices: string[] = input.notes.map((n) => `提示（文件声明）：${n.text}`)
  if (input.report === null) return notices
  if (!input.declared) {
    notices.push(
      `组合未声明（${input.variantKey}）：按契约回落最近已声明变体 ${input.report.variantKey}`,
    )
  }
  for (const c of input.report.clamped) notices.push(formatClampText(c))
  for (const w of input.report.warnings) notices.push(w)
  return notices
}

// ---------------------------------------------------------------------------
// 声明 → 滑杆
// ---------------------------------------------------------------------------

/** 每通道一条滑杆的规格（`slider === false` 的 `hatch` 已被解析器排除，此处不重复判断语义）。 */
export function channelSliderSpecs(decl: MultiblockDeclarationFacts): ChannelSliderSpec[] {
  return decl.channels
    .filter((c) => c.slider)
    .map((c: MultiblockChannelFacts) => ({
      key: c.key,
      name: c.name,
      kind: c.kind,
      min: c.min,
      max: c.max,
      hi: c.domain.hi,
    }))
}

// ---------------------------------------------------------------------------
// 装配产物 → 渲染视图文档
// ---------------------------------------------------------------------------

/**
 * 装配结论的**最小面**（R2/S3）：面板只用到"变体键 + 尺寸文本 + 提示"三样。
 *
 * 为什么不直接用 `MultiblockAssemblyOutcome`（它带 `AssemblyResult`）：那个类型来自
 * 旧装配器（`context/multiblock`），而内核面路径（`assembleMultiblockKernelFace`）
 * 产出的是 `report` + `Grid`，**没有** `AssemblyResult`。收成这三样后，两个来源
 * （旧文档 / 内核面）都能喂，面板本身不再依赖任何一种装配实现。
 */
export interface ChannelPanelOutcome {
  /** **场景数**（变体配置集合的条数；M5-1：场景不是时间轴帧）。 */
  readonly sceneCount: number
  /** 当前取值派生的变体键（观测点）。 */
  readonly variantKey: string
  /** 装配尺寸文本（`formatDims` 的产出）；`''` = 本次没有装配结果。 */
  readonly dims: string
  readonly notices: readonly string[]
}

/**
 * **面板模型（声明事实版）**：声明 + 取值 + 装配结论 → 面板一次性输入。
 *
 * 这是面板模型的**唯一组装实现**（旧文档版适配器已随 M6-1 删除）。
 */
export function buildChannelPanelModelOf(
  decl: MultiblockDeclarationFacts,
  state: MultiblockSelectionState,
  outcome: ChannelPanelOutcome,
): MultiblockChannelPanelModel {
  const domain = decl.totalTierDomain
  return {
    displayName: decl.displayName,
    tier: state.totalTier,
    tierMin: Math.trunc(domain.min),
    tierMax: Math.trunc(domain.max),
    tierSamples: tierSampleValues(decl),
    channels: channelSliderSpecs(decl),
    values: { ...state.values },
    runstates: decl.runstates.map((r) => ({ id: r.id, name: r.name })),
    runstate: state.runstate,
    sceneCount: outcome.sceneCount,
    variantKey: outcome.variantKey,
    dims: outcome.dims,
    notices: [...outcome.notices],
  }
}

/**
 * 装配结论的**最小面**（面板只读"变体键 + 尺寸 + 夹取/警告"）。
 *
 * 结构类型：装配根产物（`MultiblockKernelFaceAssembly['report']`）与旧
 * `AssemblyResult['report']` 都能喂 —— 面板本身不依赖任何一种装配实现。
 */
export interface ChannelPanelAssemblyFacts {
  readonly report: {
    readonly variantKey: string
    readonly dims: Readonly<{ w: number; h: number; d: number }>
    readonly clamped: readonly ClampRecord[]
    readonly warnings: readonly string[]
  }
}

/**
 * **面板模型（生产唯一派生）**：声明读视图 + 当前取值 + 装配结论 → 面板一次性输入。
 *
 * 它替代旧文档版 `buildChannelPanelModel`（M6-1）：旧版要一份 `RuntimeDocument`
 * 才能取声明与场景数，而生产面板的输入早已是内核读面（声明 = `DocumentContent.multiblock`、
 * 场景数 = 声明里的 `scenes`、尺寸/提示 = 唯一求值点的装配报告）。
 * ⇒ 调用方不再需要旧文档，面板模型只有一个派生入口（`useKernelChannels#panel` 与判据同吃）。
 */
export function channelPanelModelOf(
  decl: MultiblockDeclarationView,
  state: MultiblockSelectionState,
  sceneCount: number,
  face: ChannelPanelAssemblyFacts | null,
): MultiblockChannelPanelModel {
  // 变体键走**契约的唯一派生规则**（`multiblockVariantKey`）—— 不是 report 里的
  // "回落后的实际变体"：面板要报的是**当前取值派生**的键（两者在未声明组合上不同）。
  const variantKey = multiblockVariantKey(decl, { ...state.values }, state.runstate, state.totalTier)
  return buildChannelPanelModelOf(decl, state, {
    sceneCount,
    variantKey,
    dims: face === null ? '' : formatDims(face.report.dims),
    notices: assemblyNoticesOf({
      notes: decl.notes,
      variantKey,
      // 「该组合是否已声明」用**索引视图**判（唯一索引实现；键面不含 raw）。
      declared: decl.variantByKey.has(variantKey),
      report: face === null ? null : face.report,
    }),
  })
}

/** `0` = 未设置（契约 §5.2：0 与"不设置"在数据层等价）。 */
export function formatChannelValue(value: number): string {
  return value === 0 ? 'Not set' : String(value)
}

/** `w×h×d`（观测用）。 */
export function formatDims(dims: { w: number; h: number; d: number }): string {
  return `${dims.w}×${dims.h}×${dims.d}`
}
