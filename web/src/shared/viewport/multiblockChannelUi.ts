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
 */
import {
  RuntimeDocument,
  RuntimeFrame,
  multiblockVariantKey,
  type MultiblockChannelDecl,
  type MultiblockDecl,
} from '@/context/runtimeDocument'
import {
  assembleSelection,
  type AssemblyResult,
  type ClampRecord,
  type MultiblockInnerDocument,
} from '@/context/multiblock'
import { formatUnknownError } from '@/util/formatUnknownError'

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
  /** 当前取值派生的变体键（观测点：装配产物确实随之变化） */
  variantKey: string
  /** 装配结果尺寸 `w×h×d`（观测点；装配失败为空串） */
  dims: string
  /** 只提示不拒绝的提示：文件软约束 notes + 回落/夹取 + 解析瑕疵 */
  notices: string[]
}

/** 当前取值选择（视图本地状态，与 `assembleSelection` 的输入同形）。 */
export interface MultiblockSelectionState {
  totalTier: number
  values: Record<string, number>
  runstate: string
}

/** 装配结论：结果 + 是否命中声明组合 + 提示。 */
export interface MultiblockAssemblyOutcome {
  result: AssemblyResult | null
  variantKey: string
  /** 变体键是否命中 `decl.variantByKey`（未命中时由 T2.2 回落并落提示） */
  declared: boolean
  notices: string[]
}

// ---------------------------------------------------------------------------
// 声明 → 滑杆 / 初始取值
// ---------------------------------------------------------------------------

/** 总 Tier 抽取值清单：显式 `tierSample` 优先，缺省 = 整个 `totalTierDomain`。 */
export function tierSampleValues(decl: MultiblockDecl): number[] {
  const sample = decl.tierSample
  if (Array.isArray(sample) && sample.length > 0) {
    return [...sample].map((n) => Math.trunc(n)).sort((a, b) => a - b)
  }
  const out: number[] = []
  for (let i = Math.trunc(decl.totalTierDomain.min); i <= Math.trunc(decl.totalTierDomain.max); i++) out.push(i)
  return out
}

/**
 * Tier 吸附：把任意 Tier 值吸附到最近的**已声明**抽样值（并列取较小者）。
 *
 * 依据 T2.2 移交注意②：未落在 `tierSample` 的 Tier 会被装配器回落最近抽样并落 warning。
 * 滑杆吸附后 UI 只会停在已声明组合上，warning 不再因滑杆产生（文档瑕疵仍照实提示）。
 */
export function snapTierToSample(samples: readonly number[], tier: number): number {
  if (samples.length === 0) return Math.trunc(tier)
  const target = Math.trunc(tier)
  let best = samples[0]!
  for (const v of samples) {
    const d = Math.abs(v - target)
    const bd = Math.abs(best - target)
    if (d < bd || (d === bd && v < best)) best = v
  }
  return best
}

/** 每通道一条滑杆的规格（`slider === false` 的 `hatch` 已被解析器排除，此处不重复判断语义）。 */
export function channelSliderSpecs(decl: MultiblockDecl): ChannelSliderSpec[] {
  return decl.channels
    .filter((c) => c.slider)
    .map((c: MultiblockChannelDecl) => ({
      key: c.key,
      name: c.name,
      kind: c.kind,
      min: c.min,
      max: c.max,
      hi: c.domain.hi,
    }))
}

/**
 * 通道取值夹到声明取值域 `0..domain.hi`（滑杆理论上到不了域外，这里仍是**不信任输入**的一道闸）。
 * 未声明的通道 key → `null`（调用方忽略该次改动）。
 */
export function clampChannelValue(
  decl: MultiblockDecl,
  key: string,
  value: number,
): number | null {
  const ch = decl.channels.find((c) => c.key === key)
  if (!ch) return null
  const v = Math.trunc(value)
  if (!Number.isFinite(v)) return 0
  return Math.min(Math.max(v, 0), ch.domain.hi)
}

/** 初始取值：Tier = `domain.default ?? max`（吸附抽样）、所有通道 Not set(0)、运行态 = 声明首项。 */
export function initialMultiblockSelection(decl: MultiblockDecl): MultiblockSelectionState {
  const domain = decl.totalTierDomain
  const samples = tierSampleValues(decl)
  const rawDefault = Math.trunc(domain.default ?? domain.max)
  const inDomain = Math.min(Math.max(rawDefault, Math.trunc(domain.min)), Math.trunc(domain.max))
  const values: Record<string, number> = {}
  // 契约 §5.1：变体声明值**每个通道都有**（未设置写 0）——故全部通道入表，滑杆只覆盖其中一部分
  for (const c of decl.channels) values[c.key] = 0
  return {
    totalTier: snapTierToSample(samples, inDomain),
    values,
    runstate: decl.runstates[0]?.id ?? '',
  }
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

  // 文件软约束（`notes`）：只提示，不参与装配（契约 §7.3）
  const notices: string[] = decl.notes.map((n) => `提示（文件声明）：${n.text}`)

  const inner = doc.multiblockSource as MultiblockInnerDocument | null
  if (!inner) {
    notices.push('文档未携带可装配的内层 body（multiblockSource 为空）')
    return { result: null, variantKey, declared, notices }
  }

  try {
    const result = assembleSelection(inner, {
      totalTier: state.totalTier,
      values: { ...state.values },
      runstate: state.runstate,
    })
    if (!declared) {
      notices.push(
        `组合未声明（${variantKey}）：按契约回落最近已声明变体 ${result.report.variantKey}`,
      )
    }
    for (const c of result.report.clamped) notices.push(formatClampText(c))
    for (const w of result.report.warnings) notices.push(w)
    return { result, variantKey, declared, notices }
  } catch (e) {
    notices.push(`装配失败（已保留上一次可渲染结果）：${formatUnknownError(e)}`)
    return { result: null, variantKey, declared, notices }
  }
}

// ---------------------------------------------------------------------------
// 装配产物 → 渲染视图文档
// ---------------------------------------------------------------------------

/** 面板模型：声明 + 当前取值 + 装配结论 → 面板一次性输入。 */
export function buildChannelPanelModel(
  doc: RuntimeDocument,
  state: MultiblockSelectionState,
  outcome: MultiblockAssemblyOutcome,
): MultiblockChannelPanelModel | null {
  const mb = doc.multiblock
  if (!mb) return null
  const domain = mb.decl.totalTierDomain
  return {
    displayName: mb.decl.displayName,
    tier: state.totalTier,
    tierMin: Math.trunc(domain.min),
    tierMax: Math.trunc(domain.max),
    tierSamples: tierSampleValues(mb.decl),
    channels: channelSliderSpecs(mb.decl),
    values: { ...state.values },
    runstates: mb.decl.runstates.map((r) => ({ id: r.id, name: r.name })),
    runstate: state.runstate,
    variantKey: outcome.variantKey,
    dims: outcome.result ? formatDims(outcome.result.dims) : '',
    notices: outcome.notices,
  }
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
