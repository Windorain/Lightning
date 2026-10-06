/**
 * T0.5 fixture 生成器 —— 生成 3 份"多方块为主"文档 fixture。
 *
 *   node scripts/multiblock-fixtures/generate-fixtures.mjs
 *
 * 产物落 `web/src/context/__tests__/fixtures/`：
 *   - multiblock-ebf-2ch.json     多通道（height 尺寸型 + coil/glass 双替换型）+ 运行态两态
 *   - multiblock-tier-only.json   仅总 Tier（另有一个无书面取值域的通道，0 = Not set 回落 Tier）
 *   - multiblock-lsc-overlap.json 作用域相交例外（同一区域被两通道叠加改写）+ 通道耦合夹取
 *
 * 三条设计纪律（都直接来自体积剖析 T0.1）：
 *   ① **规则表按引用复用**：差异规则存在 `multiblock.rules` 一次，frame 只存 `{variantKey, stepIndex, runstate, rules:[id…]}`。
 *      若把 ops 放进 frame（每个变体一份），文件体积会随**组合数**增长 —— 第一稿实测正是如此，已被本生成器修正。
 *   ② **调色板是并集**：所有变体共用根级 `blockPalette`，按内容签名全局去重。
 *   ③ **每帧自带 cellGrid 参考网格**（`frame.cellGrid`）：它不是"组合展开"，而是 11.4 KB 全量级别的
 *      可校验产物 —— 生成器用它证明"规则表能逐格还原每个变体"，校验器逐帧 diff 它。真实导出可省。
 *
 * fixture 是**合成开发样品**（真实文件由游戏内导出产出）：几何/取值域按 GT 真实语义建模，
 * 但结构是手写的确定性骨架。生成是纯函数（无时间/随机），重复运行逐字节一致（幂等）。
 *
 * ⚠ **`source` 串是历史标签，不是可解析的路径**：本文件写进 fixture 的 `source`（如 `probe-channels.md §3.3`）
 * 指向治理前的过程性探针报告，那些报告已按 #51 裁决从仓库删除，标签从此只作"这条事实从哪来"的出处记号
 * （判据真源 = `docs/contracts/format-multiblock-doc.md`）。**故意不改这些标签**：它们会逐字节写进已提交的
 * fixture，改文案会造成一次纯粹的重生成 diff（无信息增量）。已提交 fixture 本体同理不动。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { airEntry, entrySignature, variantKey, assembleVariant, resolveVariantValues } from './lib.mjs'
import { OPS_LEGEND } from './ops-legend.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', '..', 'web', 'src', 'context', '__tests__', 'fixtures')

// ---------------------------------------------------------------------------
// 几何：16 单位制的单位立方体（与既有 bakedQuadsJsonV1 契约一致）
// ---------------------------------------------------------------------------

const FACE_VERTS = [
  [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], // -z
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], // +z
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], // -y
  [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]], // +y
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], // -x
  [[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]], // +x
]
const FACE_UV = [[0, 0], [1, 0], [1, 1], [0, 1]]

/**
 * 单位立方体：**2 面**（-z / +z）× 4 顶点 × {x,y,z,u,v,brightness,color}。
 *
 * 为什么开发样品给 2 面而不是 6 面：调色板几何是**唯一的体积大头**（一个 6 面立方体
 * 在紧凑 JSON 里约 2.0 KiB/条），而 fixture 的价值在结构而非几何保真度。2 面已足以让
 * 每个条目是"带几何的、可渲染的、签名唯一的"条目。真实产物是逐面真实捕获的完整几何。
 */
function cubeGeometry() {
  const quads = []
  for (const f of [0, 1]) {
    quads.push({
      materialIndex: f,
      vertices: FACE_VERTS[f].map(([x, y, z], i) => ({
        x: x * 16,
        y: y * 16,
        z: z * 16,
        u: FACE_UV[i][0],
        v: FACE_UV[i][1],
        brightness: 0.85,
        color: 16777215,
      })),
    })
  }
  return { encoding: 'bakedQuadsJsonV1', quads }
}

/** 调色板生成器：air 固定下标 0，其余按插入顺序，按内容签名去重。 */
function makePalette() {
  const entries = [airEntry()]
  const index = new Map([[entrySignature(entries[0]), 0]])
  const add = (registryId, meta, extra = {}) => {
    const entry = {
      registryId,
      meta,
      renderMode: 'BakedModel',
      geometry: cubeGeometry(),
      occludesAdjacentFaces: true,
      ...extra,
    }
    const sig = entrySignature(entry)
    if (index.has(sig)) return index.get(sig)
    index.set(sig, entries.length)
    entries.push(entry)
    return entries.length - 1
  }
  return { entries, add }
}

/**
 * 组合声明：声明集合 = ∏(每通道取值域) × **总 Tier 抽样清单** × 运行态集。
 *
 * 总 Tier 在真实产物里应给全 `totalTierDomain`；fixture 用代表值抽样（`tierSample`），
 * 因为其目标是"每个声明组合都能装配 + 覆盖各取值"而非穷举总 Tier。无论抽样与否，
 * **声明即完备**：不允许漏掉抽样清单里的任何组合。
 */
function declareCombinations({ channels, totalTierDomain, tierSample, runstates }) {
  const keys = channels.map((c) => c.key)
  const domains = channels.map((c) => ({ lo: 0, hi: c.domain?.max ?? totalTierDomain.max }))
  const variants = []
  const rec = (i, values) => {
    if (i === keys.length) {
      for (const tt of tierSample) {
        if (tt < totalTierDomain.min || tt > totalTierDomain.max) {
          throw new Error(`tierSample ${tt} 越出 totalTierDomain ${totalTierDomain.min}..${totalTierDomain.max}`)
        }
        for (const rs of runstates) {
          variants.push({ key: variantKey(channels, values, rs.id, tt), totalTier: tt, values: { ...values }, runstate: rs.id })
        }
      }
      return
    }
    for (let v = domains[i].lo; v <= domains[i].hi; v++) {
      values[keys[i]] = v
      rec(i + 1, values)
    }
    delete values[keys[i]]
  }
  rec(0, {})
  return variants
}

/**
 * 为一个变体算出它的 frame 描述。
 *
 * **frame 里不存 cellGrid**：存了就等于组合展开（每个组合一份完整网格），
 * 实测会让 gzip 体积随组合数增长 —— 正是需求 C 要消灭的模式。
 * 参考网格（"规则表能逐格还原每个变体"的证据）由校验器的 `--verify-grids` 全量重建。
 * 本函数仍会跑一次装配器：**生成期就断言规则表自洽**，出问题立刻炸在生成端。
 */
function buildFrame({ doc, mb, variant, allRules, activeRuleIds }) {
  const probe = {
    ...doc,
    multiblock: { ...mb, rules: allRules, variants: [variant] },
    frames: [
      {
        index: 0,
        variant: variant.key,
        runstate: variant.runstate,
        stepIndex: variant.stepIndex ?? 0,
        rules: activeRuleIds,
      },
    ],
  }
  assembleVariant(probe, variant.key)
  return {
    index: 0,
    variant: variant.key,
    runstate: variant.runstate,
    stepIndex: variant.stepIndex ?? 0,
    rules: [...activeRuleIds],
  }
}

// ---------------------------------------------------------------------------
// fixture #1 —— EBF 风格：height 尺寸型 + coil/glass 双替换型 + 运行态两态
// ---------------------------------------------------------------------------

/**
 * 3×3×h 塔式机器（h = height 取值 1..5，直接等于层数）。
 * 骨架（**只有机壳**）：底壳 y=0、外围竖壳 y∈{1,3,5,…}、顶盖 y=h-1（h≥5 时顶盖加倍）。
 * 规则填充的空腔：
 *   - (1,1,1) 线圈槽        —— coil 通道（`indexTable` 查表，一条规则覆盖全部取值）
 *   - (1,y,1) y∈[2,h-2] 玻璃棒 —— glass 通道（**一条沿 y 的区间规则**覆盖整根）
 *   - (1,h-1,1) 控制器      —— 运行态规则（材质层两态差异）
 * 三个位置集合两两不相交 → 替换型通道作用域不相交（probe-channels.md §3.3）。
 */
function ebfFixture() {
  const p = makePalette()
  const P = {
    casing: p.add('gregtech:gt.blockcasings', 11, { tooltip: ['Heat Proof Machine Casing'] }),
    coil1: p.add('gregtech:gt.blockcasings5', 1, { tooltip: ['Cupronickel Coil Block'] }),
    coil2: p.add('gregtech:gt.blockcasings5', 4, { tooltip: ['Kanthal Coil Block'] }),
    coil3: p.add('gregtech:gt.blockcasings5', 5, { tooltip: ['Nichrome Coil Block'] }),
    glass1: p.add('gregtech:gt.blockglass1', 0, { tooltip: ['Borosilicate Glass'] }),
    glass2: p.add('gregtech:gt.blockglass1', 1, { tooltip: ['Reinforced Glass'] }),
    controllerIdle: p.add('gregtech:gt.blockmachines', 1000, { tooltip: ['Electric Blast Furnace'] }),
    controllerActive: p.add('gregtech:gt.blockmachines', 1000, {
      tooltip: ['Electric Blast Furnace (running)'],
      nbt: { activeFace: true },
    }),
  }
  // 取值 0（未设置）→ 有效值回落总 Tier；本机总 Tier 抽样固定为 2，故"未设置"分支落到第 2 档。
  // 表长 = 域上界 + 1，第 0 档就是"未设置"（**不另设"未设置方块"**：GT 里通道值不可为 0，
  // "未设置"的物理形态是该通道键不存在，其位置由主通道值决定 —— 见 format 文档 §3.2）。
  const COIL = [P.coil1, P.coil1, P.coil2, P.coil3]
  const GLASS = [P.glass1, P.glass1, P.glass2]

  const channels = [
    {
      enum: 'STRUCTURE_HEIGHT',
      id: 'height',
      key: 'height',
      name: 'Height',
      kind: 'size',
      min: 1,
      max: 5,
      axis: 'y',
      unit: 'layers',
      valueSemantics: 'clamped-offset',
      domainSource: 'game-lang',
      domain: { min: 1, max: 5 },
    },
    { enum: 'HEATING_COIL', id: 'coil', key: 'coil', name: 'Coil', kind: 'replace', slot: 'coil-slot', min: 1, max: 3, domainSource: 'game-lang', domain: { max: 3 } },
    { enum: 'BOROGLASS', id: 'glass', key: 'glass', name: 'Glass', kind: 'replace', slot: 'glass-rod', min: 1, max: 2, domainSource: 'game-lang', domain: { max: 2 } },
  ]

  const runstates = [
    { id: 'idle', name: 'Idle', materialSwap: true },
    { id: 'active', name: 'Running', materialSwap: true },
  ]

  /** 骨架：(1,1,1) 与顶盖中央是空气（留给规则），其余按塔式机壳铺满。 */
  function casingTower(h) {
    const grid = []
    for (let z = 0; z < 3; z++) {
      const slice = []
      for (let y = 0; y < h; y++) {
        const row = []
        for (let x = 0; x < 3; x++) {
          const border = x === 0 || x === 2 || z === 0 || z === 2
          const isBase = y === 0
          const isTop = y === h - 1
          const isRib = y % 2 === 1
          row.push(border || isBase || isTop || isRib ? P.casing : 0)
        }
        slice.push(row)
      }
      grid.push(slice)
    }
    if (h >= 3) grid[1][1][1] = 0 // 线圈槽（h≥3 才存在 y=1 层）
    grid[1][h - 1][1] = 0 // 控制器槽
    return grid
  }

  const sizeSteps = []
  for (let h = 1; h <= 5; h++) {
    sizeSteps.push({ channel: 'height', layers: h, w: 3, hh: h, d: 3, roles: { casing: P.casing, controllerFace: P.controllerIdle }, cellGrid: casingTower(h) })
  }

  const variants = declareCombinations({ channels, totalTierDomain: { min: 1, max: 14, default: 2 }, tierSample: [1, 2, 14], runstates })
  // 每个变体的骨架阶 = height 有效值（经尺寸域夹取）− min
  for (const v of variants) {
    const eff = v.values.height || v.totalTier
    const o = Math.min(Math.max(eff, 1), 5)
    v.stepIndex = o - 1
    v.height = o
  }

  const rules = [
    {
      id: 'coil.slot',
      phase: 'replace',
      legend: 'coil.replace',
      kind: 'setCell',
      x: 1,
      y: 1,
      z: 1,
      channel: 'coil',
      indexTable: COIL,
    },
    {
      id: 'glass.rod',
      phase: 'replace',
      legend: 'glass.replace',
      kind: 'fill',
      sel: { x: 1, y: [2, 4], z: 1 },
      channel: 'glass',
      indexTable: GLASS,
    },
    { id: 'runstate.face', phase: 'runstate', legend: 'runstate.face', kind: 'setCell', x: 1, y: 4, z: 1, index: P.controllerIdle },
  ]

  // 运行态规则按态各一条（规则表里两条，frame 只引用自己那条）
  const runstateRules = runstates.map((rs) => ({
    id: `runstate.face.${rs.id}`,
    phase: 'runstate',
    legend: 'runstate.face',
    kind: 'setCell',
    x: 1,
    y: 4,
    z: 1,
    index: rs.id === 'active' ? P.controllerActive : P.controllerIdle,
  }))
  const allRules = [...rules.filter((r) => r.id !== 'runstate.face'), ...runstateRules]

  // (1,h-1,1) 的 y 随 h 变化：用"每阶一个 y"的规则集（尺寸差异 = 顶盖位置差异）
  const controllerRules = []
  for (let h = 1; h <= 5; h++) {
    for (const rs of runstates) {
      controllerRules.push({
        id: `runstate.face.h${h}.${rs.id}`,
        phase: 'runstate',
        legend: 'runstate.face',
        kind: 'setCell',
        x: 1,
        y: h - 1,
        z: 1,
        index: rs.id === 'active' ? P.controllerActive : P.controllerIdle,
      })
    }
  }
  const finalRules = [...allRules.filter((r) => !r.id.startsWith('runstate.face.')), ...controllerRules]

  const mb = {
    id: 'gregtech:metaTileEntity_electricBlastFurnace',
    displayName: 'Electric Blast Furnace',
    sourceClass: 'gregtech.api.metatileentity.implementations.MTEElectricBlastFurnace',
    hasScopeOverlap: false,
    totalTierDomain: { min: 1, max: 14, default: 2, source: 'probed' },
    tierSample: [1, 2, 14],
    channels,
    runstates,
    couplingMode: 'none',
    couplings: [],
    notes: [
      {
        kind: 'note',
        text: '本机无通道间约束：coil 与 glass 作用于不相交的位置集合，故 couplings:[] + 不拒绝任何组合（装配按各通道独立生效）。',
        source: 'probe-channels.md §3.3 / §4.4 缺省行为表',
      },
      {
        kind: 'note',
        text: '「玻璃 ≥ 能量仓等级」这类约束的另一方是可变结构内容而非通道，格式内无法求值 → 软约束 note，不参与装配夹取。',
        source: 'probe-channels.md §4.3 / §4.4',
      },
      {
        kind: 'note',
        text: 'TESR（shader/VAO + 延迟后处理）活动表现、运行中才生成的附属渲染方块 → 本轮显式"不覆盖"。',
        source: 'probe-run-state.md §3.2 / §5',
      },
    ],
    viewerSemantics: {
      frameIsVariant: true,
      playback: 'variant-frames',
      layerPreview: 'supported',
      runstateCoverage: { kind: 'texture-material-swap', geometryDelta: false, tesr: 'not-covered' },
    },
    paletteSource: 'union-all-variants',
    opsLegend: OPS_LEGEND,
    geometryEncoding: 'bakedQuadsJsonV1',
    backbone: { kind: 'sizeSteps', sizeChannel: 'height', sizeSteps },
    rules: finalRules,
    variants: variants.map((v) => ({ key: v.key, totalTier: v.totalTier, values: v.values, runstate: v.runstate, height: v.height })),
  }

  const doc = {
    schemaVersion: 1,
    multiblockCount: 1,
    multiblock: mb,
    blockPalette: p.entries,
    materialPalette: [
      { locator: 'gregtech:textures/blocks/machines/casing', atlas: 'blocks', blend: 'opaque', textureBlobIndex: 0 },
      { locator: 'gregtech:textures/blocks/machines/coil', atlas: 'blocks', blend: 'opaque', textureBlobIndex: 1 },
      { locator: 'gregtech:textures/blocks/machines/glass', atlas: 'blocks', blend: 'translucent', textureBlobIndex: 2 },
      { locator: 'gregtech:textures/blocks/machines/controller', atlas: 'blocks', blend: 'opaque', textureBlobIndex: 3 },
    ],
    textureBlobCount: 4,
    tooltipPalette: [],
  }
  const frames = variants.map((v, i) => {
    const ruleIds = ['coil.slot', 'glass.rod', `runstate.face.h${v.height}.${v.runstate}`]
    const f = buildFrame({
      doc,
      mb,
      variant: { ...v, height: v.height },
      allRules: mb.rules,
      activeRuleIds: ruleIds,
    })
    f.index = i
    return f
  })
  return {
    doc: {
      format_version: '2.0',
      schemaVersion: 1,
      documentShape: 'multiblock',
      id: 'fixture:multiblock/ebf-2ch',
      meta: {
        id: 'fixture:multiblock/ebf-2ch',
        mode: 'multiblock',
        label: 'Fixture — EBF (height + coil + glass, two runstates)',
        author: 'T0.5 fixture generator (synthetic)',
        description:
          '手写合成样品（非真实导出）。3×3×h 塔式机器：height 尺寸型通道定骨干，coil/glass 双替换型通道叠加，运行态两态只差异材质。',
        modSource: 'lightning.fixture',
        fixtureSynthetic: true,
      },
      multiblockCount: 1,
      multiblock: mb,
      frames,
    },
    palette: p,
    materialPalette: doc.materialPalette,
    textureBlobCount: doc.textureBlobCount,
    tooltipPalette: [],
  }
}

// ---------------------------------------------------------------------------
// fixture #2 —— 仅总 Tier（无具名通道的域来源）
// ---------------------------------------------------------------------------

/**
 * 1×1 柱：总 Tier 决定柱高（Tier 1..3 → 3/4/5 格）。
 * 外加一个「无书面取值域」的裸替换型通道 `structTier`（0..3，0 = Not set 回落总 Tier），
 * 覆盖 probe-channels.md §2.2 中 6 个无 lang 声明 id 的情形（`domainSource: "probed"`）。
 * 不声明第二运行态 → 运行态轴单态 idle（T2.4 的"只显示 Tier 滑杆"对照）。
 */
function tierOnlyFixture() {
  const p = makePalette()
  const P = {
    casing: p.add('fixture:block/casing', 0, { tooltip: ['Structure Casing'] }),
    core: p.add('fixture:block/tier_core', 0, { tooltip: ['Tier Core'] }),
    tier1: p.add('fixture:block/tier_core', 1, { tooltip: ['Tier 1 Core'] }),
    tier2: p.add('fixture:block/tier_core', 2, { tooltip: ['Tier 2 Core'] }),
    tier3: p.add('fixture:block/tier_core', 3, { tooltip: ['Tier 3 Core'] }),
  }
  const TIER = [P.core, P.tier1, P.tier2, P.tier3]

  const channels = [
    { enum: null, id: 'structTier', key: 'structTier', name: 'Structure Tier', kind: 'replace', slot: 'core-column', min: 1, max: 3, domainSource: 'probed', domain: { max: 3 } },
  ]
  const runstates = [{ id: 'idle', name: 'Idle', materialSwap: false }]
  const variants = declareCombinations({ channels, totalTierDomain: { min: 1, max: 3, default: 1 }, tierSample: [1, 2, 3], runstates })
  for (const v of variants) {
    v.height = 2 + v.totalTier
    v.stepIndex = v.totalTier - 1
  }

  function column(height) {
    const grid = []
    for (let z = 0; z < 1; z++) {
      const slice = []
      for (let y = 0; y < height; y++) slice.push([y === 0 ? P.casing : P.core])
      grid.push(slice)
    }
    return grid
  }

  const sizeSteps = []
  for (let tt = 1; tt <= 3; tt++) {
    const height = 2 + tt
    sizeSteps.push({ channel: 'totalTier', layers: height, w: 1, hh: height, d: 1, roles: { casing: P.casing, core: P.core }, cellGrid: column(height) })
  }

  const topRules = []
  for (let tt = 1; tt <= 3; tt++) {
    const height = 2 + tt
    for (let st = 1; st <= 3; st++) {
      topRules.push({
        id: `core.top.tt${tt}.st${st}`,
        phase: 'replace',
        legend: 'totalTier.top',
        kind: 'setCell',
        x: 0,
        y: height - 1,
        z: 0,
        index: TIER[st],
      })
    }
  }

  const mb = {
    id: 'fixture:multiblock/tierOnlyColumn',
    displayName: 'Tier Column',
    sourceClass: 'fixture.TierOnlyColumn',
    hasScopeOverlap: false,
    totalTierDomain: { min: 1, max: 3, default: 1, source: 'probed' },
    tierSample: [1, 2, 3],
    channels,
    runstates,
    couplingMode: 'none',
    couplings: [],
    notes: [
      {
        kind: 'note',
        text: '本机未探测到任何通道间约束 → 缺省行为 couplings:[] + 不拒绝任何组合（装配按各通道独立生效）。',
        source: 'probe-channels.md §4.4 缺省行为表',
      },
    ],
    viewerSemantics: { frameIsVariant: true, playback: 'variant-frames', layerPreview: 'supported', runstateCoverage: { kind: 'none', geometryDelta: false, tesr: 'not-covered' } },
    paletteSource: 'union-all-variants',
    opsLegend: OPS_LEGEND,
    geometryEncoding: 'bakedQuadsJsonV1',
    backbone: { kind: 'sizeSteps', sizeChannel: 'totalTier', sizeSteps },
    rules: topRules,
    variants: variants.map((v) => ({ key: v.key, totalTier: v.totalTier, values: v.values, runstate: v.runstate, height: v.height })),
  }

  const doc = {
    schemaVersion: 1,
    multiblockCount: 1,
    multiblock: mb,
    blockPalette: p.entries,
    materialPalette: [
      { locator: 'fixture:textures/casing', atlas: 'blocks', blend: 'opaque', textureBlobIndex: 0 },
      { locator: 'fixture:textures/core', atlas: 'blocks', blend: 'opaque', textureBlobIndex: 1 },
    ],
    textureBlobCount: 2,
    tooltipPalette: [],
  }

  const frames = variants.map((v, i) => {
    // structTier = 0（Not set）时不引用任何 top 规则 → 柱顶保持骨架里的 core（未设置基线）
    const ids = v.values.structTier > 0 ? [`core.top.tt${v.totalTier}.st${v.values.structTier}`] : []
    const f = buildFrame({ doc, mb, variant: v, allRules: mb.rules, activeRuleIds: ids })
    f.index = i
    return f
  })

  return {
    doc: {
      format_version: '2.0',
      schemaVersion: 1,
      documentShape: 'multiblock',
      id: 'fixture:multiblock/tier-only',
      meta: {
        id: 'fixture:multiblock/tier-only',
        mode: 'multiblock',
        label: 'Fixture — Tier-only multiblock',
        author: 'T0.5 fixture generator (synthetic)',
        description:
          '手写合成样品（非真实导出）。仅总 Tier 决定柱高；另一个通道无书面取值域（domainSource=probed），0 = Not set 且回落总 Tier。',
        modSource: 'lightning.fixture',
        fixtureSynthetic: true,
      },
      multiblockCount: 1,
      multiblock: mb,
      frames,
    },
    palette: p,
    materialPalette: doc.materialPalette,
    textureBlobCount: doc.textureBlobCount,
    tooltipPalette: [],
  }
}

// ---------------------------------------------------------------------------
// fixture #3 —— 作用域相交例外（同区域叠加）+ 通道耦合夹取
// ---------------------------------------------------------------------------

/**
 * 模型化 `MTELapotronicSuperCapacitor` 的两条真实事实（probe-channels.md §3.4 / §4.1.2）：
 *   ① **同一片顶盖中央区被两条通道叠加改写**（capacitor 写 (1,0,0)/(1,0,1)，glass 写 (0,0,1)）
 *      → `hasScopeOverlap: true`，多个规则组 + 可选 guard 表达。
 *   ② **通道耦合**：`couplingMode: "clamp"`；非法组合被**夹取**并落 `report.clamped`
 *      （不拒绝装配，保证"滑杆任意位置都有确定结果"）。
 */
function lscFixture() {
  const p = makePalette()
  const P = {
    casing: p.add('fixture:block/lsc_casing', 0, { tooltip: ['Capacitor Casing'] }),
    capLow: p.add('fixture:block/lsc_capacitor', 0, { tooltip: ['Low Capacitor'] }),
    capHigh: p.add('fixture:block/lsc_capacitor', 1, { tooltip: ['High Capacitor'] }),
    glassLow: p.add('fixture:block/lsc_glass', 0, { tooltip: ['Low Glass'] }),
    glassHigh: p.add('fixture:block/lsc_glass', 1, { tooltip: ['High Glass'] }),
  }
  const CAP = [P.capLow, P.capLow, P.capHigh]
  const GLASS = [0, P.glassLow, P.glassHigh]

  const channels = [
    { enum: 'STRUCTURE_HEIGHT', id: 'height', key: 'height', name: 'Height', kind: 'size', min: 1, max: 5, axis: 'y', unit: 'layers', valueSemantics: 'clamped-offset', domainSource: 'game-lang', domain: { min: 1, max: 5 } },
    { enum: 'LSC_CAPACITOR', id: 'capacitor', key: 'capacitor', name: 'Lapotronic Capacitor', kind: 'replace', slot: 'top-plate-center', min: 1, max: 2, domainSource: 'game-lang', domain: { max: 2 } },
    { enum: 'BOROGLASS', id: 'glass', key: 'glass', name: 'Glass', kind: 'replace', slot: 'top-plate-center', min: 1, max: 2, domainSource: 'game-lang', domain: { max: 2 } },
  ]
  const runstates = [{ id: 'idle', name: 'Idle', materialSwap: false }]
  const variants = declareCombinations({ channels, totalTierDomain: { min: 1, max: 14, default: 3 }, tierSample: [3, 14], runstates })
  for (const v of variants) {
    const eff = v.values.height || v.totalTier
    const o = Math.min(Math.max(eff, 1), 5)
    v.height = o
    v.stepIndex = o - 1
  }

  function hulk(h) {
    const grid = []
    for (let z = 0; z < 3; z++) {
      const slice = []
      for (let y = 0; y < h; y++) {
        const row = []
        for (let x = 0; x < 3; x++) {
          const border = x === 0 || x === 2 || z === 0 || z === 2
          row.push(border || y === 0 || y === h - 1 ? P.casing : 0)
        }
        slice.push(row)
      }
      grid.push(slice)
    }
    return grid
  }

  const sizeSteps = []
  for (let h = 1; h <= 5; h++) {
    sizeSteps.push({ channel: 'height', layers: h, w: 3, hh: h, d: 3, roles: { casing: P.casing, capSlot: 0, glassSlot: 0 }, cellGrid: hulk(h) })
  }

  const rules = [
    { id: 'cap.plate', phase: 'replace', legend: 'cap.replace', kind: 'fill', sel: { x: 1, y: 0, z: [0, 1] }, index: P.capLow },
    {
      id: 'glass.plate',
      phase: 'replace',
      legend: 'glass.intersect',
      kind: 'setCell',
      x: 0,
      y: 0,
      z: 1,
      channel: 'glass',
      indexTable: GLASS,
      guard: { clauses: [{ channel: 'glass', not: true, value: 0 }] },
    },
  ]
  const topRules = []
  for (let h = 1; h <= 5; h++) {
    topRules.push({ id: `topcap.h${h}`, phase: 'replace', legend: 'size.topcap', kind: 'setCell', x: 1, y: h - 1, z: h - 1, index: P.casing })
  }
  // 耦合夹取后的电容档：每个可能的目标档一条规则（id 形如 cap.clamped.<k>），由 frame 按需引用。
  // 这是"多组差异规则 + 可选 guard"表达例外的具体落法：规则表里静态存在，frame 选择用哪一条。
  const clampRules = []
  for (let k = 1; k <= 2; k++) {
    clampRules.push({ id: `cap.clamped.${k}`, phase: 'replace', legend: 'cap.clamped', kind: 'setCell', x: 1, y: 0, z: 0, index: CAP[k] })
  }

  const mb = {
    id: 'fixture:multiblock/lapotronicSuperCapacitor',
    displayName: 'Lapotronic Super Capacitor',
    sourceClass: 'kekztech.KekzTechMetaTileEntityLapotronicSuperCapacitor',
    hasScopeOverlap: true,
    scopeOverlapNote:
      '顶盖中央区同时被 capacitor 与 glass 的规则改写（模型化 MTELapotronicSuperCapacitor 的 CellElement 双通道读取，probe-channels.md §3.4）。',
    totalTierDomain: { min: 1, max: 14, default: 3, source: 'probed' },
    tierSample: [3, 14],
    channels,
    runstates,
    couplingMode: 'clamp',
    couplings: [
      {
        id: 'capacitor-ge-glass',
        a: 'capacitor',
        b: 'glass',
        requires: 'ge',
        kind: 'value',
        source:
          'probe-channels.md §4.1.2 的 clamp 型模型（真实约束是「玻璃等级 ≥ 电容等级」的 min-glass 下限；此处方向互换以让两侧取值都可被用户触达，语义等价为"两通道不得交叉"）',
      },
    ],
    notes: [
      {
        kind: 'note',
        text: '结构定义里出现"一个位置由多通道共同决定"时，该位置**不得进入查表骨干**，必须整体落入差异规则。',
        source: 'probe-channels.md §4.4 缺省行为表',
      },
    ],
    viewerSemantics: { frameIsVariant: true, playback: 'variant-frames', layerPreview: 'supported', runstateCoverage: { kind: 'none', geometryDelta: false, tesr: 'not-covered' } },
    paletteSource: 'union-all-variants',
    opsLegend: OPS_LEGEND,
    geometryEncoding: 'bakedQuadsJsonV1',
    backbone: { kind: 'sizeSteps', sizeChannel: 'height', sizeSteps },
    rules: [...rules, ...clampRules, ...topRules],
    variants: variants.map((v) => ({ key: v.key, totalTier: v.totalTier, values: v.values, runstate: v.runstate, height: v.height })),
  }

  const doc = {
    schemaVersion: 1,
    multiblockCount: 1,
    multiblock: mb,
    blockPalette: p.entries,
    materialPalette: [
      { locator: 'fixture:textures/lsc_casing', atlas: 'blocks', blend: 'opaque', textureBlobIndex: 0 },
      { locator: 'fixture:textures/lsc_capacitor', atlas: 'blocks', blend: 'opaque', textureBlobIndex: 1 },
      { locator: 'fixture:textures/lsc_glass', atlas: 'blocks', blend: 'translucent', textureBlobIndex: 2 },
    ],
    textureBlobCount: 3,
    tooltipPalette: [],
  }

  const frames = variants.map((v, i) => {
    // 用与装配器同源的取值解析拿到"夹取后的有效值"，据此选择规则（含耦合落点）
    const { effective } = resolveVariantValues(doc, v.key, v)
    const capEff = effective.get('capacitor')
    const capRule = capEff >= 1 && capEff <= 2 ? `cap.clamped.${capEff}` : null
    const ids = ['cap.plate', ...(capRule ? [capRule] : []), 'glass.plate', `topcap.h${v.height}`]
    const f = buildFrame({ doc, mb, variant: v, allRules: mb.rules, activeRuleIds: ids })
    f.index = i
    return f
  })

  return {
    doc: {
      format_version: '2.0',
      schemaVersion: 1,
      documentShape: 'multiblock',
      id: 'fixture:multiblock/lsc-overlap',
      meta: {
        id: 'fixture:multiblock/lsc-overlap',
        mode: 'multiblock',
        label: 'Fixture — Overlapping scope + clamped coupling',
        author: 'T0.5 fixture generator (synthetic)',
        description:
          '手写合成样品（非真实导出）。同一片顶盖中央区被两通道叠加改写（作用域相交例外），并带一条 clamp 型通道耦合（非法组合被夹取）。',
        modSource: 'lightning.fixture',
        fixtureSynthetic: true,
      },
      multiblockCount: 1,
      multiblock: mb,
      frames,
    },
    palette: p,
    materialPalette: doc.materialPalette,
    textureBlobCount: doc.textureBlobCount,
    tooltipPalette: [],
  }
}

// ---------------------------------------------------------------------------
// 落盘：Envelope 信封（payload = base64(未压缩 JSON 文本)，保证可读 + 可逐行 diff）
// ---------------------------------------------------------------------------

const PNG_BLOB =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const INNER_KEYS = ['schemaVersion', 'multiblockCount', 'multiblock', 'blockPalette', 'materialPalette', 'textureBlobs', 'tooltipPalette', 'frames']

function toEnvelope(spec, filename) {
  const { doc, palette, materialPalette, textureBlobCount, tooltipPalette } = spec
  const inner = {
    schemaVersion: doc.schemaVersion,
    multiblockCount: doc.multiblockCount,
    multiblock: doc.multiblock,
    blockPalette: palette.entries,
    materialPalette,
    textureBlobs: Array.from({ length: textureBlobCount }, () => PNG_BLOB),
    tooltipPalette,
    frames: doc.frames,
  }
  for (const k of Object.keys(inner)) {
    if (!INNER_KEYS.includes(k)) throw new Error(`inner 里出现未登记键: ${k}`)
  }
  // 内层 body 用 1 空格缩进：payload 是"数据"，缩进让 base64 解码后可直接人眼逐行 diff
  //（代价 = 结构性空白，不影响任何格式结论；真实产物的内层是紧凑单行）。
  const payload = Buffer.from(JSON.stringify(inner, null, 1), 'utf8').toString('base64')
  const meta = { ...doc.meta, documentShape: 'multiblock', fixtureFile: filename }
  return {
    documentFormat: 'Envelope',
    payloadEncoding: 'base64(json)',
    payloadNote:
      "fixture 专用：payload = base64(未压缩 JSON)，便于人工阅读与逐行 diff。真实 /sde multiblock 产物为 base64(gzip(JSON))，两者共用同一读取路径（format 文档 §8.3）。查看方式：node -e \"const d=require('./multiblock-ebf-2ch.json');console.log(JSON.stringify(JSON.parse(Buffer.from(d.payload,'base64')),null,1))\"",
    meta,
    payload,
  }
}

const FIXTURES = [
  ['multiblock-ebf-2ch.json', ebfFixture()],
  ['multiblock-tier-only.json', tierOnlyFixture()],
  ['multiblock-lsc-overlap.json', lscFixture()],
]

function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const lines = []
  for (const [name, spec] of FIXTURES) {
    const env = toEnvelope(spec, name)
    const text = JSON.stringify(env) + '\n'
    writeFileSync(join(OUT_DIR, name), text, 'utf8')
    const mb = spec.doc.multiblock
    const rules = mb.rules.length
    const frame = Buffer.byteLength(JSON.stringify(spec.doc.frames[0]), 'utf8')
    lines.push(
      `${name.padEnd(30)} palette=${String(spec.palette.entries.length).padStart(2)} ` +
        `channels=${mb.channels.length} rules=${String(rules).padStart(3)} variants=${String(mb.variants.length).padStart(4)} ` +
        `frames=${String(spec.doc.frames.length).padStart(4)} 文字段=${String(frame).padStart(4)}B 文件=${Buffer.byteLength(text, 'utf8')}B`,
    )
  }
  console.log('生成 fixture 完成 → ' + OUT_DIR)
  for (const l of lines) console.log('  ' + l)
}

main()
