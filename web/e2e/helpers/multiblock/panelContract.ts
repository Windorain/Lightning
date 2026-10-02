/**
 * T2.6 第二阶段 · **通道面板的钉死期望值**（`web/e2e/helpers/multiblock/panelContract.ts`）。
 *
 * 为什么单独一份（而不是塞进 `contract.ts`）：
 *  - `contract.ts` 是**文档声明级**契约（`RuntimeDocument` 公开 getter），第一阶段已验收冻结；
 *  - 本文件是**面板 UI 级**契约（`[data-mb-panel="channels"]` 的 `data-*` 属性 + 滑杆
 *    `min`/`max`/`value`/数值文本），第二阶段新增，取值同样**逐项硬编码**。
 *
 * 反同义反复守则（与 `contract.ts` 同）：这里的每个数字都来自 fixture 文件声明
 * （`web/src/context/__tests__/fixtures/multiblock-*.json`，T0.5 产物，内容勿改），
 * **绝不**在断言时再读一遍被测文件/被测 DOM 来当期望值。
 *
 * 逐项出处（三类 fixture 通用）：
 *  - `sliderHref`   = 通道 `domain.max`（契约 §4.2：滑杆上限 = 取值域上界；`0` = `Not set` 恒在下界）
 *  - `valueMin/Max` = 通道 `min` / `max`（有效取值区间，`size` 型语义）
 *  - `tierMin/Max`  = `multiblock.totalTierDomain.min` / `.max`
 *  - `tierSamples`  = `multiblock.tierSample`（缺省 = 整个 totalTierDomain）
 *  - `runstates`    = `multiblock.runstates[].id` / `.name`（呈现名逐字）
 */

import { contractFor } from './contract'

/** 一条通道滑杆的钉死期望。 */
export interface PanelChannelExpectation {
  key: string
  /** 标签文本 = 文件声明的呈现名（逐字）。 */
  name: string
  /** `size` | `replace`。 */
  kind: string
  /** 滑杆下界（恒 0 = `Not set`）。 */
  sliderMin: number
  /** 滑杆上界 = `domain.max`。 */
  sliderHi: number
  /** 有效取值下界（声明 `min`）。 */
  valueMin: number
  /** 有效取值上界（声明 `max`）。 */
  valueMax: number
}

/** 一份 fixture 的钉死面板期望。 */
export interface PanelContract {
  file: string
  displayName: string
  /** 滑杆条数 = 文件声明的 `slider === true` 通道数。 */
  sliderCount: number
  channels: PanelChannelExpectation[]
  tierMin: number
  tierMax: number
  /** `data-mb-tier-samples`（逗号分隔字符串，逐字比对）。 */
  tierSamples: number[]
  /** `0` 的显示文本（契约 §5.2）。 */
  notSetText: string
  runstates: Array<{ id: string; name: string }>
  /** `doc.multiblock.notes` 条数（面板必须逐条呈现为"只提示不拒绝"的 notice）。 */
  noteCount: number
}

/** 面板契约表（三份 fixture，与 `MULTIBLOCK_CONTRACTS` 同序）。 */
export const PANEL_CONTRACTS: PanelContract[] = [
  {
    file: 'multiblock-ebf-2ch.json',
    displayName: 'Electric Blast Furnace',
    sliderCount: 3,
    channels: [
      { key: 'height', name: 'Height', kind: 'size', sliderMin: 0, sliderHi: 5, valueMin: 1, valueMax: 5 },
      { key: 'coil', name: 'Coil', kind: 'replace', sliderMin: 0, sliderHi: 3, valueMin: 1, valueMax: 3 },
      { key: 'glass', name: 'Glass', kind: 'replace', sliderMin: 0, sliderHi: 2, valueMin: 1, valueMax: 2 },
    ],
    tierMin: 1,
    tierMax: 14,
    tierSamples: [1, 2, 14],
    notSetText: 'Not set',
    runstates: [
      { id: 'idle', name: 'Idle' },
      { id: 'active', name: 'Running' },
    ],
    noteCount: 3,
  },
  {
    file: 'multiblock-tier-only.json',
    displayName: 'Tier Column',
    sliderCount: 1,
    channels: [
      { key: 'structTier', name: 'Structure Tier', kind: 'replace', sliderMin: 0, sliderHi: 3, valueMin: 1, valueMax: 3 },
    ],
    tierMin: 1,
    tierMax: 3,
    tierSamples: [1, 2, 3],
    notSetText: 'Not set',
    runstates: [{ id: 'idle', name: 'Idle' }],
    noteCount: 1,
  },
  {
    file: 'multiblock-lsc-overlap.json',
    displayName: 'Lapotronic Super Capacitor',
    sliderCount: 3,
    channels: [
      { key: 'height', name: 'Height', kind: 'size', sliderMin: 0, sliderHi: 5, valueMin: 1, valueMax: 5 },
      {
        key: 'capacitor',
        name: 'Lapotronic Capacitor',
        kind: 'replace',
        sliderMin: 0,
        sliderHi: 2,
        valueMin: 1,
        valueMax: 2,
      },
      { key: 'glass', name: 'Glass', kind: 'replace', sliderMin: 0, sliderHi: 2, valueMin: 1, valueMax: 2 },
    ],
    tierMin: 1,
    tierMax: 14,
    tierSamples: [3, 14],
    notSetText: 'Not set',
    runstates: [{ id: 'idle', name: 'Idle' }],
    noteCount: 1,
  },
]

export function panelContractFor(file: string): PanelContract {
  const p = PANEL_CONTRACTS.find((x) => x.file === file)
  if (!p) throw new Error(`T2.6：未登记的面板契约 ${file}`)
  return p
}

// ---------------------------------------------------------------------------
// 期望组合（**由文件声明的取值域显式枚举**，不依赖被测代码）
// ---------------------------------------------------------------------------

/** 一个待遍历的组合（声明值 + 运行态 + 期望变体键）。 */
export interface ExpectedCombo {
  fixtureFile: string
  /** 期望的变体键（`<通道key>:<值>|…|tt:<Tier>|runstate:<id>`，契约 §5.1）。 */
  variantKey: string
  /** 通道声明值（含 0 = Not set）。 */
  values: Record<string, number>
  totalTier: number
  runstate: string
}

/** `0..hi`（含端点）。 */
function range(lo: number, hi: number): number[] {
  const out: number[] = []
  for (let i = lo; i <= hi; i++) out.push(i)
  return out
}

/** 变体键（与契约 §5.1 同构；**硬编码格式**，不是调用被测的键构造器）。 */
export function expectedVariantKey(
  channelOrder: readonly string[],
  values: Record<string, number>,
  runstate: string,
  totalTier: number,
): string {
  const parts = channelOrder.map((k) => `${k}:${values[k] ?? 0}`)
  parts.push(`tt:${totalTier}`)
  parts.push(`runstate:${runstate}`)
  return parts.join('|')
}

/**
 * 枚举一份 fixture 的**全部已声明组合**（笛卡尔积）：
 * `∏(每通道域 0..hi) × tierSample × 运行态集`。
 *
 * 与 `contract.ts` 的 `variantCount` 交叉自检（枚举数必须相等）——
 * 这条自检让"期望值硬编码"这件事本身也可被证伪。
 */
export function enumerateExpectedCombos(file: string): ExpectedCombo[] {
  const p = panelContractFor(file)
  const c = contractFor(file)
  const keys = p.channels.map((ch) => ch.key)
  const out: ExpectedCombo[] = []
  const rec = (i: number, values: Record<string, number>): void => {
    if (i === keys.length) {
      for (const tt of p.tierSamples) {
        for (const rs of p.runstates) {
          out.push({
            fixtureFile: file,
            variantKey: expectedVariantKey(keys, values, rs.id, tt),
            values: { ...values },
            totalTier: tt,
            runstate: rs.id,
          })
        }
      }
      return
    }
    const ch = p.channels[i]!
    for (const v of range(ch.sliderMin, ch.sliderHi)) {
      values[ch.key] = v
      rec(i + 1, values)
    }
    delete values[ch.key]
  }
  rec(0, {})
  if (out.length !== c.variantCount) {
    throw new Error(
      `T2.6：${file} 的期望组合枚举数 ${out.length} ≠ 契约声明的变体数 ${c.variantCount}（期望值表自相矛盾）`,
    )
  }
  return out
}

/** 三份 fixture 的全部期望组合（432 + 12 + 108 = 552）。 */
export function enumerateAllExpectedCombos(): ExpectedCombo[] {
  return PANEL_CONTRACTS.flatMap((p) => enumerateExpectedCombos(p.file))
}

/**
 * 性能控制：mobile 项目只跑一个**抽样子集**（每 fixture：每通道 min/max 两端 + 运行态两态）。
 *
 * 抽样规则（固定、可复现，不随机）：
 *  - 取值：`全 0`（Not set 基线）、`每通道 1`（有效下界）、`每通道 hi`（域上界）；
 *  - 每个取值 × 每个 tierSample × 每个运行态。
 *  - tier-only 只有单通道单运行态，故其子集自动退化为 3 × 3 × 1 = 9 条。
 */
export function sampleCombos(file: string): ExpectedCombo[] {
  const p = panelContractFor(file)
  const keys = p.channels.map((ch) => ch.key)
  const picks: Array<Record<string, number>> = [Object.fromEntries(keys.map((k) => [k, 0]))]
  picks.push(Object.fromEntries(p.channels.map((ch) => [ch.key, ch.valueMin])))
  picks.push(Object.fromEntries(p.channels.map((ch) => [ch.key, ch.sliderHi])))
  const out: ExpectedCombo[] = []
  for (const values of picks) {
    for (const tt of p.tierSamples) {
      for (const rs of p.runstates) {
        out.push({
          fixtureFile: file,
          variantKey: expectedVariantKey(keys, values, rs.id, tt),
          values: { ...values },
          totalTier: tt,
          runstate: rs.id,
        })
      }
    }
  }
  return out
}

/** 三份 fixture 的 mobile 抽样子集（≈ 3×(3×3×2) + 9 + …；实测条数见报告）。 */
export function sampleAllCombos(): ExpectedCombo[] {
  return PANEL_CONTRACTS.flatMap((p) => sampleCombos(p.file))
}

// ---------------------------------------------------------------------------
// 尺寸变化方向契约（T2.6 第 3 条）
// ---------------------------------------------------------------------------

/**
 * 「Tier / 尺寸型通道增大 → 结构尺寸非递减」的**逐档期望值**（不是"只比大小"这么弱）。
 *
 * 保守口径：只断言**非递减** + 至少一档严格变大（契约允许同一阶被多个取值映射到，
 * 例如 EBF `height:0`(Not set) 与 `coil` 回落导致的夹取）。实测每档取值见报告。
 */
export interface SizeDirectionCase {
  file: string
  /** 被驱动的轴：`tier` 或某通道 key。 */
  axis: string
  /** 依序驱动的取值。 */
  values: number[]
  /** 其余通道/tier 的固定取值（避免其它轴干扰）。 */
  fixed: { totalTier: number; runstate: string; values: Record<string, number> }
  /** 断言哪个尺寸分量（`h` = cellGrid[0].length，即 [d,h,w] 的第 2 维）。 */
  dim: 'w' | 'h' | 'd'
  /** 期望的**逐档实测值**（硬编码；至少一档严格递增）。 */
  expectDims: number[]
}

export const SIZE_DIRECTION_CASES: SizeDirectionCase[] = [
  {
    file: 'multiblock-ebf-2ch.json',
    axis: 'height',
    values: [1, 2, 3, 4, 5],
    fixed: { totalTier: 1, runstate: 'idle', values: { coil: 0, glass: 0 } },
    dim: 'h',
    expectDims: [1, 2, 3, 4, 5],
  },
  {
    file: 'multiblock-tier-only.json',
    axis: 'tier',
    values: [1, 2, 3],
    fixed: { totalTier: 1, runstate: 'idle', values: { structTier: 0 } },
    dim: 'h',
    expectDims: [3, 4, 5],
  },
]
