/**
 * 装配器 —— **查表装配，零求值**。
 *
 * 装配顺序（硬约束）：**尺寸型 → 骨干 → 替换型 → 运行态**。
 * 实现上 = "取骨架阶 → 深拷贝 → 按 (phase, order) 稳定排序后依次应用规则表"，
 * 只有查表 + 索引 + 深拷贝 + 排序 + 区间写入；不含任何 GT/StructureLib 语义、不调用任何未知函数。
 *
 * 内容差异全部来自声明数据：`index` / `indexRole` / `indexTable` / `indexAliases`。
 * 非法组合只**夹取**（域夹取 §5.2 + 耦合夹取 §7.2），不拒绝 —— `report.rejections` 恒为空。
 *
 * 与参考蓝本 `scripts/multiblock-fixtures/lib.mjs` 的对应关系：
 *   `assembleVariant` / `resolveVariantValues` / `expandOp` / `evalGuard` / `applyCouplings` 逐一对照移植。
 */
import { Grid } from '@/context/grid'
import { structureRowToWorldY } from '@/pure/vec'
import type { SlotBlock } from '@/pure/gridTypes'
import { buildPalette, type MultiblockPalette } from './palette'
import { applyIndexAliases, expandOp, resolveRuleIndex } from './rules'
import {
  channelBounds,
  evalGuard,
  parseVariantKey,
  resolveVariantValues,
  stepIndexForEffective,
  tierSampleOf,
  variantKeyOf,
} from './values'
import type {
  AssemblyReport,
  AssemblyResult,
  Dims,
  MultiblockChannel,
  MultiblockDecl,
  MultiblockFrame,
  MultiblockInnerDocument,
  MultiblockSelection,
  MultiblockVariant,
} from './types'

/** 相位排名（契约 §5.4）：尺寸型已由 stepIndex 完成，剩下三档。 */
const PHASE_RANK: Record<string, number> = { backbone: 0, replace: 1, runstate: 2 }

export interface AssembleOptions {
  /** 覆盖"声明值"（用于域外取值：变体定位用夹取后的值，解析用原始值以便如实落 clamped） */
  overrideValues?: Record<string, number>
  /** 追加到报告的诊断 */
  extraWarnings?: string[]
}

// ---------------------------------------------------------------------------
// 只读访问器（供通道面板与 UI 接线）
// ---------------------------------------------------------------------------

function requireMultiblock(doc: MultiblockInnerDocument): MultiblockDecl {
  const mb = doc?.multiblock
  if (!mb || typeof mb !== 'object') {
    throw new Error('多方块装配：内层 body 缺 multiblock 对象（documentShape 判别见契约 §2）')
  }
  return mb
}

/** 通道清单（契约 §4.2，UI 只渲染这份声明）。 */
export function listChannels(doc: MultiblockInnerDocument): MultiblockChannel[] {
  return requireMultiblock(doc).channels ?? []
}

/** 运行态清单（契约 §7.1，含呈现名）。 */
export function listRunstates(doc: MultiblockInnerDocument): MultiblockDecl['runstates'] {
  return requireMultiblock(doc).runstates ?? []
}

/** 变体清单（契约 §5.1，键即主键）。 */
export function listVariants(doc: MultiblockInnerDocument): MultiblockVariant[] {
  return requireMultiblock(doc).variants ?? []
}

/** 某变体键的全部帧（声明顺序；契约 §5.3 每变体 ≥1 帧，通常恰好 1 帧）。 */
export function listVariantFrames(doc: MultiblockInnerDocument, variantKey: string): MultiblockFrame[] {
  return (doc.frames ?? []).filter((f) => f.variant === variantKey)
}

/** 总 Tier 抽样清单（UI 滑杆上限 = `totalTierDomain.max`，抽样清单用于定位已声明变体）。 */
export function listTierSample(doc: MultiblockInnerDocument): number[] {
  return tierSampleOf(requireMultiblock(doc))
}

/** 某通道在给定总 Tier 下的滑杆范围：`0`（Not set）到 `hi`。 */
export function channelRange(
  doc: MultiblockInnerDocument,
  channelKey: string,
  totalTier: number,
): { min: number; max: number } | undefined {
  const ch = requireMultiblock(doc).channels.find((c) => c.key === channelKey)
  if (!ch) return undefined
  const { lo, hi } = channelBounds(ch, totalTier)
  return { min: lo, max: hi }
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

function cloneGrid(g: number[][][]): number[][][] {
  return g.map((slice) => slice.map((row) => row.slice()))
}

function shadeReport(base: AssemblyReport, frame: MultiblockFrame, ordinal: number, stepIndex: number, dims: Dims): AssemblyReport {
  return {
    ...base,
    frameIndex: frame.index ?? ordinal,
    stepIndex,
    dims,
    effective: { ...base.effective },
    clamped: base.clamped.map((c) => ({ ...c })),
    rejections: [...base.rejections],
    warnings: [...base.warnings],
    rulesApplied: [],
    opsApplied: 0,
  }
}

/** 装配单个 frame：取骨架阶 → 深拷贝 → 按 (phase, order) 稳定排序应用规则 → 越界断言。 */
function assembleFrame(
  mb: MultiblockDecl,
  frame: MultiblockFrame,
  ordinal: number,
  baseReport: AssemblyReport,
  effective: Record<string, number>,
  palette: MultiblockPalette,
): AssemblyResult {
  if (frame.stepIndex === undefined) throw new Error(`frame ${frame.index ?? ordinal} 缺 stepIndex（关联骨架阶）`)
  const sizeSteps = mb.backbone?.sizeSteps ?? []
  const step = sizeSteps[frame.stepIndex]
  if (!step) throw new Error(`frame ${frame.index ?? ordinal} 的 stepIndex=${frame.stepIndex} 越界（共 ${sizeSteps.length} 阶）`)

  // ★ 必须深拷贝：同阶骨架可能被多个 frame 复用
  const grid = cloneGrid(step.cellGrid)
  const dims = shapeOf(grid)
  const report = shadeReport(baseReport, frame, ordinal, frame.stepIndex, dims)

  // 尺寸型交叉复核（诊断用；契约 §5.4 以 frame.stepIndex 为准）
  const expectedStep = stepIndexForEffective(mb, effective)
  if (expectedStep !== undefined && expectedStep !== frame.stepIndex) {
    report.warnings.push(
      `frame ${report.frameIndex} 的 stepIndex=${frame.stepIndex} 与尺寸型通道解析出的阶 ${expectedStep} 不一致（以 frame.stepIndex 为准）`,
    )
  }
  if (step.w !== dims.w || step.hh !== dims.h || step.d !== dims.d) {
    report.warnings.push(
      `骨架阶 ${frame.stepIndex} 声明尺寸 ${step.w}x${step.hh}x${step.d} 与实际 cellGrid 形状 ${dims.w}x${dims.h}x${dims.d} 不一致（以 cellGrid 为准）`,
    )
  }

  const channelByKey = new Map((mb.channels ?? []).map((c) => [c.key, c]))
  const ruleSpec = new Map((mb.rules ?? []).map((r) => [r.id, r]))
  const refs = Array.isArray(frame.rules) ? frame.rules : []

  // 1) 收集生效规则：guard 通过者；相位 + 引用顺序（同 phase 内"后写者胜"）
  const ops: Array<{ rule: MultiblockDecl['rules'][number]; rank: number; order: number }> = []
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]!
    const id = typeof ref === 'string' ? ref : ref.id
    const order = typeof ref === 'string' ? i : ref.order ?? i
    const spec = ruleSpec.get(id)
    if (!spec) throw new Error(`frame ${report.frameIndex} 引用了未声明规则: ${id}`)
    if (!evalGuard(spec.guard, effective, channelByKey)) continue
    ops.push({ rule: spec, rank: PHASE_RANK[spec.phase ?? 'replace'] ?? 1, order })
  }
  // Array.prototype.sort 在 ES2019+ 保证稳定：同 (phase, order) 保持引用顺序
  ops.sort((a, b) => a.rank - b.rank || a.order - b.order)

  // 2) 逐规则应用：整表替换（indexAliases）→ 解析下标（纯查表）→ 区间写入
  for (const { rule } of ops) {
    const index = resolveRuleIndex(rule, step, effective)
    if (rule.indexAliases) applyIndexAliases(grid, rule.indexAliases, dims)
    const writes = expandOp(rule, dims)
    for (const w of writes) grid[w.z]![w.y]![w.x] = index
    report.opsApplied += writes.length
    report.rulesApplied.push(rule.id)
  }

  // 3) 越界断言：装配结果必须落在并集调色板内（契约 §5.4）
  const paletteSize = palette.entries.length
  for (let z = 0; z < dims.d; z++) {
    for (let y = 0; y < dims.h; y++) {
      for (let x = 0; x < dims.w; x++) {
        const v = grid[z]![y]![x]!
        if (!Number.isInteger(v) || v < 0 || v >= paletteSize) {
          throw new Error(
            `装配越界: (${x},${y},${z}) = ${v}，调色板长度 ${paletteSize}（frame ${report.frameIndex}）`,
          )
        }
      }
    }
  }

  return {
    variantKey: frame.variant,
    frameIndex: report.frameIndex,
    stepIndex: frame.stepIndex,
    runstate: report.runstate,
    totalTier: report.totalTier,
    dims,
    cellGrid: grid,
    grid: toGrid(grid, dims, palette),
    blocks: palette.slots,
    effective,
    report,
  }
}

/** 网格形状：`[z][y][x]`（契约 §4.4）。退化网格返回 0 维而非抛错。 */
function shapeOf(grid: number[][][]): Dims {
  const d = grid.length
  const h = d > 0 ? grid[0]!.length : 0
  const w = h > 0 ? grid[0]![0]!.length : 0
  return { w, h, d }
}

/**
 * 契约朝向 → 既有 Grid（Y-up）。
 * 契约 `cellGrid[z][y][x]` 的 row 0 = 顶部；既有 Grid 的 y = 0 = 底部，
 * 故 `y = structureRowToWorldY(row, h)`（与 `RuntimeDocument._fromV2CellGrid` 同口径）。
 */
function toGrid(cellGrid: number[][][], dims: Dims, palette: MultiblockPalette): Grid {
  const cells: (SlotBlock | null)[][][] = []
  for (let z = 0; z < dims.d; z++) {
    const rawSlice = cellGrid[z]!
    const slice: (SlotBlock | null)[][] = []
    for (let row = 0; row < dims.h; row++) {
      const rawRow = rawSlice[row]!
      const outRow: (SlotBlock | null)[] = new Array(dims.w).fill(null)
      for (let x = 0; x < dims.w; x++) {
        const idx = rawRow[x]!
        const blk = palette.slots[idx]
        if (blk) outRow[x] = blk
      }
      slice[structureRowToWorldY(row, dims.h)] = outRow
    }
    cells.push(slice)
  }
  return new Grid(dims.w, dims.h, dims.d, cells, new Map(palette.cache))
}

/**
 * 装配一个**已声明**的变体键（契约 §5.4 的 ASSEMBLE）：返回首个 frame 的结果。
 * 变体键未声明 / 变体无 frame → 抛错（这是文档完整性问题，不是"非法组合"）。
 */
export function assembleVariant(
  doc: MultiblockInnerDocument,
  variantKey: string,
  options: AssembleOptions = {},
): AssemblyResult {
  return assembleVariantFrames(doc, variantKey, options)[0]!
}

/** 装配一个变体的**全部帧**（声明顺序）。 */
export function assembleVariantFrames(
  doc: MultiblockInnerDocument,
  variantKey: string,
  options: AssembleOptions = {},
): AssemblyResult[] {
  const mb = requireMultiblock(doc)
  const variant = (mb.variants ?? []).find((v) => v.key === variantKey)
  if (!variant) throw new Error(`未声明的变体键: ${variantKey}`)
  const frames = listVariantFrames(doc, variantKey)
  if (frames.length === 0) {
    throw new Error(`变体 ${variantKey} 没有任何 frame（Frame 是唯一变体存储原语，契约 §5.3）`)
  }
  const { effective, report } = resolveVariantValues(mb, variantKey, variant, options.overrideValues)
  for (const w of options.extraWarnings ?? []) report.warnings.push(w)

  const palette = buildPalette(doc)
  return frames.map((frame, i) => assembleFrame(mb, frame, i, report, effective, palette))
}

/**
 * **UI 接线入口**：`{totalTier, values, runstate}` → 装配结果。
 *
 * 不拒绝任何组合（契约 §5.2/§5.4 的「只夹取不拒绝」）：
 *   1. 总 Tier 先按 `totalTierDomain` 夹取，再对齐到**已声明**的 `tierSample`（未声明则回落最近抽样，落 warning）；
 *   2. 每个通道的声明值按取值域 `0..max` 夹取（域外 99 → 域上界，落 `report.clamped`）；
 *   3. 运行态未声明 → 回落 `runstates[0]`（落 warning）；
 *   4. 变体定位不到（组合未声明）→ 回落最近的已声明变体（落 warning），**不抛错**。
 *
 * 变体键由 `{通道声明值, tt, runstate}` 唯一派生（契约 §5.1），故调用方无需知道键的形状。
 */
export function assembleSelection(
  doc: MultiblockInnerDocument,
  selection: MultiblockSelection = {},
): AssemblyResult {
  const mb = requireMultiblock(doc)
  const warnings: string[] = []

  // ---- 1) 总 Tier ----
  const ttDomain = mb.totalTierDomain ?? { min: 1, max: 1 }
  const fallbackTier = Math.floor(ttDomain.default ?? ttDomain.max ?? 1)
  const requestedRaw = Number.isFinite(selection.totalTier)
    ? Math.floor(selection.totalTier as number)
    : fallbackTier
  const domainTier = Math.min(Math.max(requestedRaw, ttDomain.min), ttDomain.max)
  let totalTier = domainTier
  const sample = tierSampleOf(mb)
  if (sample.length > 0 && !sample.includes(totalTier)) {
    const snapped = nearest(sample, totalTier)
    warnings.push(`总 Tier ${totalTier} 未在 tierSample 中声明，装配回落到最近的已声明取值 ${snapped}`)
    totalTier = snapped
  }

  // ---- 2) 通道声明值（域外夹取；Not set 保持 0）----
  const wanted = selection.values ?? {}
  const declared: Record<string, number> = {}
  const overrides: Record<string, number> = {}
  for (const ch of mb.channels ?? []) {
    const { hi } = channelBounds(ch, totalTier)
    const raw = wanted[ch.key]
    const clamped = Math.min(Math.max(Math.floor(raw ?? 0), 0), hi)
    declared[ch.key] = clamped
    const rawFloored = Math.floor(raw ?? 0)
    if (raw !== undefined && rawFloored !== clamped) overrides[ch.key] = rawFloored
  }
  for (const k of Object.keys(wanted)) {
    if (!(mb.channels ?? []).some((c) => c.key === k)) warnings.push(`取值选择含未声明通道 ${k}，已忽略`)
  }

  // ---- 3) 运行态 ----
  const runstates = mb.runstates ?? []
  let runstate = selection.runstate ?? runstates[0]?.id ?? 'idle'
  if (runstates.length > 0 && !runstates.some((r) => r.id === runstate)) {
    warnings.push(`运行态 ${runstate} 未声明，回落到 ${runstates[0]!.id}`)
    runstate = runstates[0]!.id
  }

  // ---- 4) 变体定位（不拒绝：回落最近的已声明变体）----
  const key = variantKeyOf(mb.channels ?? [], declared, runstate, totalTier)
  let variant = (mb.variants ?? []).find((v) => v.key === key)
  if (!variant) {
    const fallback = nearestDeclaredVariant(mb, declared, runstate, totalTier)
    if (!fallback) throw new Error(`装配失败：变体 ${key} 未声明，且找不到可回落的已声明变体`)
    warnings.push(`变体 ${key} 未声明，装配回落到最近的已声明变体 ${fallback.key}`)
    variant = fallback
  }

  const res = assembleVariant(doc, variant.key, { overrideValues: overrides, extraWarnings: warnings })
  if (requestedRaw !== domainTier) {
    // 总 Tier 域外夹取：与通道同口径落 report.clamped（契约 §7.3），顺序在通道之前
    res.report.clamped.unshift({ field: 'totalTier', was: requestedRaw, now: domainTier, reason: 'domain' })
  }
  return res
}

/** 取数组中最接近 `value` 的元素（并列取较小者）。 */
function nearest(values: number[], value: number): number {
  let best = values[0]!
  for (const v of values) {
    if (Math.abs(v - value) < Math.abs(best - value)) best = v
    else if (Math.abs(v - value) === Math.abs(best - value) && v < best) best = v
  }
  return best
}

/** 变体的运行态：优先字段，缺省从变体键反解（键是主键，契约 §5.1）。 */
function runstateOfVariant(v: MultiblockVariant): string {
  return v.runstate ?? parseVariantKey(v.key).runstate ?? 'idle'
}

/** 最近的已声明变体：优先"通道声明值相同 + 运行态相同"（差异仅在总 Tier）。 */
function nearestDeclaredVariant(
  mb: MultiblockDecl,
  declared: Record<string, number>,
  runstate: string,
  totalTier: number,
): MultiblockVariant | undefined {
  const all = mb.variants ?? []
  const sameValues = all.filter((v) => {
    if (runstateOfVariant(v) !== runstate) return false
    return (mb.channels ?? []).every((c) => (v.values?.[c.key] ?? 0) === (declared[c.key] ?? 0))
  })
  if (sameValues.length > 0) {
    const keys = sameValues.map((v) => v.totalTier ?? mb.totalTierDomain?.default ?? 1)
    const target = nearest(keys, totalTier)
    return sameValues.find((v) => (v.totalTier ?? mb.totalTierDomain?.default ?? 1) === target)
  }
  const sameRunstate = all.filter((v) => runstateOfVariant(v) === runstate)
  if (sameRunstate.length === 0) return all[0]
  // 逐通道 L1 距离最小的变体（确定性：并列取声明顺序靠前者）
  let best = sameRunstate[0]!
  let bestDist = Infinity
  for (const v of sameRunstate) {
    let dist = Math.abs((v.totalTier ?? 1) - totalTier)
    for (const c of mb.channels ?? []) {
      dist += Math.abs((v.values?.[c.key] ?? 0) - (declared[c.key] ?? 0))
    }
    if (dist < bestDist) {
      bestDist = dist
      best = v
    }
  }
  return best
}
