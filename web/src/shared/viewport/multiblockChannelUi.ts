/**
 * 「通道」面板的**纯逻辑**（T2.4/T2.5）—— 无 Vue、无 DOM、无 ctx。
 *
 * 分工：
 *  - 本模块：文件声明 → 滑杆规格 / 初始取值 / 面板模型；当前取值 → 装配（T2.2 装配器）→ 渲染视图文档。
 *  - `useMultiblockChannels.ts`：把本模块包成响应式状态（Vue）。
 *  - `MultiblockChannelPanel.vue`：纯展示 + 事件（props/emits）。
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
 * 旧文档版入口（`assembleForSelection`/`buildChannelPanelModel`/`buildMultiblockRenderView`）
 * 仍吃 `RuntimeDocument`，注释里各写了**退出条件**。
 */
import {
  RuntimeDocument,
  RuntimeFrame,
  multiblockVariantKey,
} from '@/context/runtimeDocument'
import {
  assembleSelection,
  type AssemblyResult,
  type ClampRecord,
  type MultiblockInnerDocument,
} from '@/context/multiblock'
import { formatUnknownError } from '@/util/formatUnknownError'
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

/** 面板一次性输入（由 `buildChannelPanelModel` 组装）。 */
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

/** 装配结论：结果 + 是否命中声明组合 + 提示。 */
export interface MultiblockAssemblyOutcome {
  result: AssemblyResult | null
  variantKey: string
  /** 变体键是否命中 `decl.variantByKey`（未命中时由 T2.2 回落并落提示） */
  declared: boolean
  notices: string[]
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
// 当前取值 → 装配
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
 * ## 为什么要抽成具名函数（而不是在两个调用点各写一遍）
 *
 * 它现在有**两个**调用方，各自吃不同的装配来源：
 *  - 旧文档路径 `assembleForSelection`（`assembleSelection` 的 `AssemblyResult`）；
 *  - 内核面路径 `useKernelChannels`（`assembleMultiblockKernelFace` 的 `report`）。
 *
 * 两处各写一遍 ⇒ "提示文案/顺序"会有第二份判据（而且面板的提示是**可显示的事实**，
 * 顺序也是）。故这里只保留**一个**实现，两个来源都喂它。
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

/**
 * 装配当前取值（**唯一装配入口**，UI 不直接调用 T2.2）。
 *
 * 守卫（计划 T2.4/T2.5 明文）：先用 `multiblockVariantKey` + `decl.variantByKey` 判断组合是否已声明；
 * 未声明时**不拒绝**（契约 §5.2 推论 3：只夹取/回落），落一条提示后交给 `assembleSelection`。
 * 装配异常一律在此捕获（`result: null` + 提示），不得穿透到 UI。
 */
export function assembleForSelection(
  doc: RuntimeDocument,
  state: MultiblockSelectionState,
): MultiblockAssemblyOutcome {
  const mb = doc.multiblock
  if (!mb) return { result: null, variantKey: '', declared: false, notices: [] }

  const decl = mb.decl
  const variantKey = multiblockVariantKey(decl, state.values, state.runstate, state.totalTier)
  const declared = decl.variantByKey.has(variantKey)

  const inner = doc.multiblockSource as MultiblockInnerDocument | null
  if (!inner) {
    const notices = assemblyNoticesOf({ notes: decl.notes, variantKey, declared, report: null })
    notices.push('文档未携带可装配的内层 body（multiblockSource 为空）')
    return { result: null, variantKey, declared, notices }
  }

  try {
    const result = assembleSelection(inner, {
      totalTier: state.totalTier,
      values: { ...state.values },
      runstate: state.runstate,
    })
    // 文件软约束（`notes`）+ 声明回落 + 夹取 + 警告：**唯一**构造点（见 `assemblyNoticesOf`）。
    return {
      result,
      variantKey,
      declared,
      notices: assemblyNoticesOf({ notes: decl.notes, variantKey, declared, report: result.report }),
    }
  } catch (e) {
    const notices = assemblyNoticesOf({ notes: decl.notes, variantKey, declared, report: null })
    notices.push(`装配失败（已保留上一次可渲染结果）：${formatUnknownError(e)}`)
    return { result: null, variantKey, declared, notices }
  }
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
 * 这是两个入口的**唯一实现**；`buildChannelPanelModel`（旧文档版）只是它的适配器。
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
 * 面板模型（**旧文档路径**）。
 *
 * ⚠️ 它现在只做一件事：从旧文档取出声明事实 + 把旧装配结论折成最小面，
 * 然后**委托**给 `buildChannelPanelModelOf`（同一实现 —— 这里不复制任何面板逻辑）。
 *
 * 退出条件（与 `assembleForSelection` 同批）：旧文档路径的最后一个调用者消失时，
 * 本函数与其 `RuntimeDocument` 形参一并删除。今天的调用者只有
 * `useKernelChannels`（**已改吃内核面**，见其 `:266-271`）与两个旧形状的测试。
 */
export function buildChannelPanelModel(
  doc: RuntimeDocument,
  state: MultiblockSelectionState,
  outcome: MultiblockAssemblyOutcome,
): MultiblockChannelPanelModel | null {
  const mb = doc.multiblock
  if (!mb) return null
  return buildChannelPanelModelOf(mb.decl, state, {
    // 文件格式键 `frames` 就是场景清单（见 `adapters/files/multiblockDeclaration#sceneOf`）。
    sceneCount: doc.frames.length,
    variantKey: outcome.variantKey,
    dims: outcome.result ? formatDims(outcome.result.dims) : '',
    notices: outcome.notices,
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

/**
 * 用装配产物构造**渲染视图文档**（**切换前的参照实现**；见下方状态说明）。
 *
 * ## ⚠️ 本函数在生产路径上**已退役**（#289 P10d D2）
 *
 * 生产渲染路径现在走 **内核求值**：`composition/kernelRenderView#kernelRenderViewOf`
 * （`assembleKernelDocument` → `projectKernelDocument({ renderView })`）。
 * 实测两条路径**逐三角形一致**（`tier-only` 12 / `ebf-2ch` 12 / `lsc-overlap` 40）。
 *
 * ## 为什么**保留**它（而不是按 #171 立即删除）
 *
 * 它是**切换前后的对照参照**：`composition/__tests__/renderCutoverParity.test.ts` 的
 * "before" 侧必须走**切换前真正吃的那条路**，否则比较的不是"切换前后的渲染输入"
 * 而是"两个不同的东西"（对齐会失去意义）。
 *
 * 这与"半成品替换"的区别是**可判定的**：
 *  - 它的**唯一**消费者是对照测试（生产零调用点）；
 *  - 它的替代物已交付且**逐位一致**（不是"另一个还没接上的东西"）；
 *  - 它的存在使"渲染链切换没有改变画面"这条判据**可复算** —— 删了它就只剩断言、没有参照。
 *
 * ⇒ 归 **D4**（终切批）处置：届时对照判据改为"与冻结的几何指纹比"，
 * 本函数随 `AssemblyResult` 一族一起退场（已登记在 `retirementRegistry` 的
 * `raw-authority-object` 批次内）。
 *
 * ## 原始说明（保留：它是"为什么必须这样做"的理由）
 *
 * 多方块文档的 `frame.grid` 恒为 `null`（设计如此，网格是装配产物），
 * 而渲染路径（`drwMeshPipeline`）只能吃 `doc.serialize()`，对 `format_version:"2.0"` 文档
 * 解析的是**顶层展开（首帧 structure）**——故：把装配出的 `Grid` 放到首帧
 * （同时放到当前帧下标，兼容"按当前帧解析"的实现），顶层即可解析出装配结构。
 *
 * ⚠️ **刻意不传 `multiblock`（也不传 `_extra`）**：`serialize()` 会优先写入 `extra`/多方块节点，
 * 其中的根级 `blockPalette` 是**并集调色板**（下标是并集下标），而首帧 `structure` 的
 * `blockPalette` 是 `_gridToV2` 依据"装配网格里实际出现的方块"**重编号**后的调色板。
 * 两者混用会让 `cellGrid` 指向错误的调色板条目 —— 静默渲染错方块。
 * 不传多方块节点 ⇒ 顶层只有首帧 structure 一份自洽的 `cellGrid + blockPalette`。
 */
export function buildMultiblockRenderView(
  doc: RuntimeDocument,
  result: AssemblyResult | null,
  frameIndex: number,
): RuntimeDocument {
  if (!doc.isMultiblock || !result) return doc
  const grid = result.grid
  const current = Math.trunc(frameIndex)
  const frames = doc.frames.map((f, i) => {
    if (i !== 0 && i !== current) return f
    return new RuntimeFrame(f.index, f.label, grid, f.durationMs, f.multiblock)
  })
  return new RuntimeDocument({
    formatVersion: doc.formatVersion,
    id: doc.id,
    frames,
    meta: doc.meta,
    annotations: doc.annotations,
    labels: doc.labels,
    textureBlobs: doc.textureBlobs ?? null,
    tooltipPalette: doc.tooltipPalette ?? null,
    cellTooltipGrid: doc.cellTooltipGrid ?? null,
    materialPalette: doc.materialPalette ?? null,
    playback: doc.playback ?? null,
    multiblock: null,
  })
}
