/**
 * T1.5 前置：**合成「多通道同位置相交」数据集**（guard 规则生成路径的闭环用例）。
 *
 *   node scripts/multiblock-encode/make-synthetic-overlap.mjs \
 *        --palette mod/gtnh/run/client/variant_capture/run-0015/palette.json \
 *        --out scripts/multiblock-encode/.out/synth-overlap
 *
 * 为什么需要它：`MultiblockFactorizer` 的快路径只覆盖「≤1 条替换型通道 +
 * 总 Tier + 运行态」的查表依赖；**同一格的取值同时依赖 ≥2 条替换型通道**时（通道作用域相交，
 * T0.4 记录的 `MTELapotronicSuperCapacitor` 型例外）必须按契约 §4.5.3 生成带 `guard` 的多组差异规则。
 * 真实机里只有 LSC 是已知相交实例，且它的组合积（20064）远大于可全量捕获的规模 —— 所以先用
 * **合成相交用例**把「编码 → 参考装配器 → 逐格 diff」这条闭环钉死，再用真实 LSC 数据复验。
 *
 * 数据集的形态与 T1.3 产物一致（`palette.json` + `machines/<slug>.json`），因此可以直接喂给
 * `MultiblockFactorizeTool`（离线编码）与 `verify-encoded.mjs`（闭环验证），无需任何专用分支。
 *
 * 合成结构（`SynthGuardOverlap`，全是**确定性函数**，ground-truth 网格由同一函数生成）：
 *
 * | 位置 | 依赖 | 期望的编码路径 |
 * |------|------|----------------|
 * | (0,0,0) 与 (0,1,0) | cap × glass（二维，不可分解） | **两通道键 + guard**（同一组两块 → 矩形分解） |
 * | (2,0,2) | cap × glass × extra（三维） | **三通道键 + 两条 guard clause** |
 * | (1,0,0) | cap | 单通道 `indexTable` |
 * | (1,0,1) | glass | 单通道 `indexTable` |
 * | (2,0,0) | extra | 单通道 `indexTable` |
 * | (0,0,1) | 运行态 | `runstate` 相位常量规则 |
 * | (1,1,0) | 总 Tier | `tier.overlay` 常量规则 |
 * | 其余 | 常量 | 进骨架 |
 *
 * `height` 是尺寸型通道（域 1..2，值 1 → 3 层、值 2 → 4 层），用来同时验证
 * 「尺寸型定骨架 → 骨干 → 替换型 → 运行态」的相位顺序与 guard 规则共存。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const argv = process.argv.slice(2)
function arg(name, dflt) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}

const palettePath = arg('palette', 'mod/gtnh/run/client/variant_capture/run-0015/palette.json')
const outDir = arg('out', 'scripts/multiblock-encode/.out/synth-overlap')
const slug = 'synthguardoverlap'

const src = JSON.parse(readFileSync(palettePath, 'utf8'))
const palette = {
  blockPalette: src.blockPalette,
  materialPalette: src.materialPalette ?? [],
  textureBlobs: src.textureBlobs ?? [],
  tooltipPalette: src.tooltipPalette ?? [],
}
const PAL = palette.blockPalette.length

// ---------------------------------------------------------------------------
// 机器声明
// ---------------------------------------------------------------------------

const CH = [
  { enum: 'SYNTH_CAP', id: 'cap', key: 'cap', kind: 'replace', max: 3, name: 'SYNTH_CAP' },
  { enum: 'SYNTH_GLASS', id: 'glass', key: 'glass', kind: 'replace', max: 3, name: 'SYNTH_GLASS' },
  { enum: 'SYNTH_EXTRA', id: 'extra', key: 'extra', kind: 'replace', max: 2, name: 'SYNTH_EXTRA' },
  { enum: 'STRUCTURE_HEIGHT', id: 'height', key: 'height', kind: 'dimension', max: 2, min: 3, name: 'STRUCTURE_HEIGHT' },
]
const TT = { min: 1, max: 2, default: 1 }
const RUNSTATES = [
  { id: 'idle', name: 'Idle', materialSwap: false },
  { id: 'active', name: 'Running', materialSwap: true },
]

/** 契约 §5.2 的有效值。 */
function effective(raw, tt, ch) {
  let v = raw > 0 ? raw : tt
  const lo = ch.kind === 'dimension' ? 1 : 0
  const hi = ch.max
  if (v < lo) v = lo
  if (v > hi) v = hi
  return v
}

/** 尺寸型通道：值 k → 尺寸 k（合成机：值 1 → 3 层、值 2 → 4 层，偏移量随 min 隐含）。 */
function layersOf(sizeValue) {
  return sizeValue - 1 + CH[3].min
}

/** 该格的调色板下标：**纯确定性函数**（不读游戏，ground truth 与编码输入同源但独立于编码器）。 */
function cellValue(x, y, z, step, eff, tt, rs) {
  const cap = eff.cap
  const glass = eff.glass
  const extra = eff.extra
  if ((x === 0 && y === 0 && z === 0) || (x === 0 && y === 1 && z === 0)) {
    return 1 + ((cap * 5 + glass * 3) % 12) // 两通道相交
  }
  if (x === 2 && y === 0 && z === 2) {
    return 1 + ((cap + 2 * glass + 4 * extra) % 15) // 三通道相交
  }
  if (x === 1 && y === 0 && z === 0) return 1 + (cap % 6)
  if (x === 1 && y === 0 && z === 1) return 7 + (glass % 6)
  if (x === 2 && y === 0 && z === 0) return 1 + (extra % 6)
  if (x === 0 && y === 0 && z === 1) return rs === 'active' ? 13 : 14
  if (x === 1 && y === 1 && z === 0) return 15 + (tt % 3)
  return 1
}

function variantKey(values, tt, rs) {
  const parts = CH.map((c) => `${c.key}:${values[c.key] ?? 0}`)
  parts.push(`tt:${tt}`)
  parts.push(`runstate:${rs}`)
  return parts.join('|')
}

// ---------------------------------------------------------------------------
// 变体枚举（∏ 域 × tierSample × 运行态 = 完备组合集）
// ---------------------------------------------------------------------------

const tierSample = []
for (let t = TT.min; t <= TT.max; t++) tierSample.push(t)

const variants = []
const domains = CH.map((c) => c.max + 1)
const combos = []
;(function rec(i, cur) {
  if (i === CH.length) {
    combos.push([...cur])
    return
  }
  for (let v = 0; v < domains[i]; v++) {
    cur.push(v)
    rec(i + 1, cur)
    cur.pop()
  }
})(0, [])

for (const tt of tierSample) {
  for (const combo of combos) {
    const values = {}
    CH.forEach((c, i) => {
      values[c.key] = combo[i]
    })
    const eff = {}
    CH.forEach((c, i) => {
      eff[c.key] = effective(combo[i], tt, c)
    })
    const step = eff.height - 1
    const w = 3
    const h = layersOf(eff.height)
    const d = 3
    for (const rs of RUNSTATES) {
      const cellGrid = []
      for (let z = 0; z < d; z++) {
        const slice = []
        for (let y = 0; y < h; y++) {
          const row = []
          for (let x = 0; x < w; x++) row.push(cellValue(x, y, z, step, eff, tt, rs.id))
          slice.push(row)
        }
        cellGrid.push(slice)
      }
      variants.push({
        index: variants.length,
        key: variantKey(values, tt, rs.id),
        values: { ...values },
        totalTier: tt,
        runstate: rs.id,
        effective: { ...eff },
        grid: { origin: [0, 0, 0], size: [w, h, d], cellGrid },
      })
    }
  }
}

// ---------------------------------------------------------------------------
// 落盘（T1.3 数据集形态）
// ---------------------------------------------------------------------------

const channels = CH.map((c) => {
  const o = {
    enum: c.enum,
    id: c.id,
    key: c.key,
    name: c.name,
    kind: c.kind,
    domain: { min: c.kind === 'dimension' ? 1 : 0, max: c.max },
    max: c.max,
    domainSource: 'synthetic',
    discoverySource: 'synthetic(guard 闭环用例)',
    registryAgreement: 'not-applicable',
    expectedStates: [],
    notes: [
      '合成通道：仅用于 T1.5 的 guard 规则生成闭环，不对应任何真实 GT 机器（真实相交实例是 MTELapotronicSuperCapacitor）。',
    ],
  }
  if (c.kind === 'dimension') {
    o.min = c.min
    o.valueSemantics = `clamped-offset（值 1 → 尺寸 ${c.min}）`
  } else {
    o.valueSemantics = 'channel-data（0 = 未设置 → 回落总 Tier）'
  }
  return o
})

const machineJson = {
  schema: 'lightning.multiblock.variant-capture/1',
  generatedBy: 'scripts/multiblock-encode/make-synthetic-overlap.mjs（合成相交用例，非游戏捕获）',
  machine: {
    fqcn: 'lightning.synthetic.SynthGuardOverlap',
    simpleName: 'SynthGuardOverlap',
    displayName: 'Synthetic Guard Overlap',
    mteId: -1,
    role: '合成「多通道同位置相交」用例（T1.5 guard 路径闭环）',
    allowEscapeHatch: false,
  },
  factsSource: '',
  channels,
  totalTierDomain: { min: TT.min, max: TT.max, default: TT.default, source: 'synthetic' },
  tierSample,
  tierSamplePolicy: 'full(synthetic 1..2)',
  runstates: RUNSTATES,
  gridConvention: {
    origin: '合成：无控制器偏移',
    cellGrid: '[z][row][x]；row 0 = 顶部',
    value: '全局 blockPalette 下标；0 = 空气',
    variantKey: '<通道key>:<声明值> 按 channels 顺序用 | 连接，再按序追加 tt:<总Tier>、runstate:<id>（契约 §5.1）',
  },
  variantCount: variants.length,
  variants,
  paletteRefs: [...new Set(variants.flatMap((v) => v.grid.cellGrid.flat(3)))].sort((a, b) => a - b),
  notes: [
    `合成用例：${CH.length} 条通道（cap/glass/extra 替换型 + height 尺寸型）、域 ${domains.join('×')} × tierSample ${tierSample} × 运行态 ${RUNSTATES.length} = ${variants.length} 变体。`,
    'grid 由 make-synthetic-overlap.mjs 的确定性函数生成（与编码器相互独立），供逐格 diff 用。',
  ],
}

for (const v of variants) {
  for (const slice of v.grid.cellGrid) {
    for (const row of slice) {
      for (const x of row) {
        if (x < 0 || x >= PAL) throw new Error(`合成网格下标越界: ${x}（调色板 ${PAL}）`)
      }
    }
  }
}

mkdirSync(join(outDir, 'machines'), { recursive: true })
writeFileSync(join(outDir, 'palette.json'), JSON.stringify(palette))
writeFileSync(join(outDir, 'machines', `${slug}.json`), JSON.stringify(machineJson, null, 1))

console.log(
  `[synth-overlap] ${outDir}: ${variants.length} 变体（域 ${domains.join('×')} × tt ${tierSample.join(',')} × rs ${RUNSTATES.length}），` +
    `调色板 ${PAL} 条（来自 ${palettePath}）`,
)
