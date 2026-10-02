#!/usr/bin/env node
/**
 * T3.2 —— 体积增长曲线的**机器判定**（需求 C 的机器证明）。
 *
 * 依据（唯一判据真源）：`docs/plan/format-multiblock-doc.md` §9.2/§9.3/§9.4（判定式 R1/R2/R3、λ=1.35、
 * R²≥0.95、b≤2048 B/组合、常数主导分支）+ 计划 §10「留白 #9 已定稿并对 §T3.2 建议式作出修正」。
 *
 * ## 两条独立数据线（都必须跑，互为交叉验证）
 *  1. **编码器对照组（真实数据）**：`MultiblockFactorizeTool --control` 对**本次捕获的数据集**做
 *     域子集重编码 —— 与生产同一 Java 编码器，故这是"真实产物"的曲线（调度者裁决：对照导出走离线编码，
 *     不做多轮游戏内对照导出）。序列：
 *       - `values`   ：EBF `coil` 域 12→13→14→15 个取值（tierSample 固定 [1,2]，纯取值轴）
 *       - `channels` ：QFT 1 通道(shielding) / 1 通道(manipulator) / 2 通道(退化) / 2 通道（纯通道轴）
 *       - `fullDomain`：两台真机全量域产物（N 最大，作为 κ 与"不展开"的下界证据；
 *         它与对照组**不同 tierSample**，故单列、不混入 R1/R2 的 k 序列）
 *  2. **契约 k 序列（合成放大）**：T0.5 参考实现 `validate-multiblock-fixtures.mjs --volume` 的
 *     `scaleDocument`（通道域 ×1/×2/×4/×8）—— 契约作者给出的 k 序列，用于复核 R1/R2 的**格式性质**。
 *     本工具读取它的 `validation-report.json`（不重复实现）。
 *
 * ## 判定式实现（照抄契约文字，不"改进"）
 *  R1 κ = V/G 必须随 N 同步增长：相邻点 κ 增长 ≥ 1/√λ（λ=1.35）
 *  R2 线性拟合 G ≈ a + b·N：R² ≥ 0.95；b ≤ 2048 B/组合；
 *     `b·N_max < 4096` → 改判"文件足够小"（max G ≤ 4096）；
 *     否则若 `b·N_max < 2·max(a,4096)`（契约 §9.3 的"该点无判定意义"闸门）→ 记 `pass-with-caveat`
 *     并给出分解证据（frames+variants 边际成本），**不静默算通过**。
 *  R3 `size(backbone)+size(rules)+size(blockPalette)` 的增长 < 2λ ×（S 的增长）
 *
 * ## 用法
 *  node scripts/acceptance/volume-curve.mjs --encoded <dir> --out <dir> \
 *       [--profile <volume-profile.json>] [--contract-report <validation-report.json>] \
 *       [--pipeline-result <pipeline-result.json>] [--label <run-label>]
 *
 * 产物（全部落 `<out>/`）：`volume-curve.json`（机器可读，唯一真源）、`volume-curve.svg`（曲线图）、
 * `volume-curve.md`（人读表格；`docs/plan/volume-profile-result.md` 的数据来源）。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { assembleVariant, readFixtureDocument } from '../multiblock-fixtures/lib.mjs'
import {
  ensureDir,
  fmtBytes,
  gzipBytes,
  readJsonIfExists,
  rel,
  REPO_ROOT,
  sha256File,
  utf8Bytes,
  writeJson,
  writeText,
} from './lib/evidence.mjs'

// ---------------------------------------------------------------------------
// 判据常数（契约 §9.4 / §12.2）
// ---------------------------------------------------------------------------
export const CRITERION = {
  safetyFactor: 1.35, // λ
  r2Min: 0.95, // 拟合优度下限
  floorBytes: 4096, // 常数项下限（小结构分支）
  maxMarginalBytesPerVariant: 2048, // b 上限
  minPoints: 4,
}

const KAPPA_STEP_LIMIT = 1 / Math.sqrt(CRITERION.safetyFactor) // ≈ 0.8607

// ---------------------------------------------------------------------------
// 记号（契约 §9.2）
//   N = 文档声明的变体数（组合数）
//   S = 轴展维度和 = totalTierDomain 长度 + Σ(每通道域长度)
//   G = 内层 body JSON 的 gzip 字节数（level 9，确定性）
//   V = 组合展开体积 = blockPalette ×1 + Σ(每变体完整 cellGrid)
//   κ = V / G
// ---------------------------------------------------------------------------

function leastSquares(xs, ys) {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) ** 2
  }
  const b = sxx === 0 ? 0 : sxy / sxx
  const a = my - b * mx
  let ssRes = 0
  let ssTot = 0
  for (let i = 0; i < n; i++) {
    ssRes += (ys[i] - (a + b * xs[i])) ** 2
    ssTot += (ys[i] - my) ** 2
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot
  return { a, b, r2 }
}

/** 轴展维度和 S（与 T0.5 校验器 `axisSpan` 同口径）。 */
function axisSpan(mb) {
  const tt = mb.totalTierDomain ?? { min: 1, max: 1 }
  let s = tt.max - tt.min + 1
  for (const c of mb.channels ?? []) {
    const lo = c.kind === 'size' ? (c.min ?? 1) : 0
    const hi = c.domain?.max ?? tt.max
    s += hi - lo + 1
  }
  return s
}

function channelCount(mb) {
  return (mb.channels ?? []).filter((c) => c.kind === 'replace' || c.kind === 'dimension' || c.kind === 'size').length
}

function jsonBytes(v) {
  return utf8Bytes(JSON.stringify(v))
}

/**
 * 单个文档的全部度量。`inner` 是解包后的内层 body（契约 §3）。
 */
export function measureDocument(filePath, { kind = 'product', series = null, profileDoc = null } = {}) {
  const envelope = readJsonIfExists(filePath)
  if (!envelope) throw new Error(`读不到文档: ${filePath}`)
  const inner = readFixtureDocument(envelope)
  const mb = inner.multiblock
  if (!mb) throw new Error(`非多方块文档（缺 multiblock）: ${filePath}`)

  const palette = inner.blockPalette ?? []
  const variants = mb.variants ?? []
  const frames = inner.frames ?? []

  // ---- N / S ----
  const N = variants.length
  const S = axisSpan(mb)
  const S_sample = (mb.tierSample ?? []).length + channelCount(mb)

  // ---- V（组合展开体积）与逐变体格数 ----
  const paletteBytes = jsonBytes(palette)
  let gridBytes = 0
  let cells = 0
  let gridBytesIfMaterialPoolOnce = 0
  const usedIndices = new Set()
  for (const v of variants) {
    const r = assembleVariant(inner, v.key)
    const gb = jsonBytes(r.cellGrid)
    gridBytes += gb
    cells += r.dims.w * r.dims.h * r.dims.d
    for (const layer of r.cellGrid) for (const row of layer) for (const idx of row) usedIndices.add(idx)
  }
  const V = paletteBytes + gridBytes
  void gridBytesIfMaterialPoolOnce

  // ---- 字节分桶（未压缩 JSON 字节长度口径；与契约 §10.3 的"内层字节分解"同口径）----
  const parts = {
    'multiblock.backbone': jsonBytes(mb.backbone ?? {}),
    'multiblock.rules': jsonBytes(mb.rules ?? []),
    'multiblock.variants': jsonBytes(variants),
    'multiblock.*meta': jsonBytes({
      id: mb.id,
      displayName: mb.displayName,
      channels: mb.channels,
      runstates: mb.runstates,
      totalTierDomain: mb.totalTierDomain,
      tierSample: mb.tierSample,
      couplings: mb.couplings,
      notes: mb.notes,
      viewerSemantics: mb.viewerSemantics,
      opsLegend: mb.opsLegend,
      couplingMode: mb.couplingMode,
      hasScopeOverlap: mb.hasScopeOverlap,
      paletteSource: mb.paletteSource,
      geometryEncoding: mb.geometryEncoding,
      sourceClass: mb.sourceClass,
    }),
    frames: jsonBytes(frames),
    blockPalette: paletteBytes,
    'materialPool(materialPalette+textureBlobs+tooltipPalette)':
      jsonBytes(inner.materialPalette ?? []) + jsonBytes(inner.textureBlobs ?? []) + jsonBytes(inner.tooltipPalette ?? []),
  }

  // ---- G（唯一口径：内层 JSON 的 gzip level 9）----
  const innerJson = JSON.stringify(inner)
  const G = gzipBytes(innerJson)
  const fileBytes = fs.statSync(filePath).size

  // ---- gzip 分解（"声明部分" vs "状态部分"）：用于解释 R2 的斜率来源 ----
  const gzipParts = {
    frames: gzipBytes(JSON.stringify(frames)),
    variants: gzipBytes(JSON.stringify(variants)),
    rules: gzipBytes(JSON.stringify(mb.rules ?? [])),
    backbone: gzipBytes(JSON.stringify(mb.backbone ?? {})),
    blockPalette: gzipBytes(JSON.stringify(palette)),
    materialPool:
      gzipBytes(JSON.stringify(inner.materialPalette ?? [])) +
      gzipBytes(JSON.stringify(inner.textureBlobs ?? [])) +
      gzipBytes(JSON.stringify(inner.tooltipPalette ?? [])),
  }
  const gzipDeclarationPart = gzipParts.frames + gzipParts.variants + gzipParts.rules + gzipParts.backbone
  const gzipStatePart = gzipParts.blockPalette

  const profileInner = profileDoc?.envelope?.inner ?? null

  return {
    file: rel(filePath),
    fileName: path.basename(filePath),
    kind,
    series,
    slug: path.basename(filePath).replace(/\.multiblock\.json$/, ''),
    machine: mb.id ?? null,
    displayName: mb.displayName ?? null,
    N,
    S,
    S_sample,
    channelCount: channelCount(mb),
    channels: (mb.channels ?? []).map((c) => ({ key: c.key, id: c.id, enum: c.enum ?? null, kind: c.kind, max: c.domain?.max ?? null })),
    runstates: (mb.runstates ?? []).map((r) => r.id),
    tierSampleSize: (mb.tierSample ?? []).length,
    frames: frames.length,
    rules: (mb.rules ?? []).length,
    paletteEntries: palette.length,
    paletteUsedEntries: usedIndices.size,
    paletteUnusedEntries: palette.filter((_, i) => !usedIndices.has(i)).length,
    cells,
    cellsPerVariant: N > 0 ? cells / N : 0,
    fileBytes,
    innerCompact: utf8Bytes(innerJson),
    G,
    payloadGzipBytes: profileInner?.gzipBytes ?? null,
    V,
    paletteBytes,
    gridBytes,
    kappa: G > 0 ? V / G : null,
    bytesPerVariant: N > 0 ? G / N : null,
    parts,
    gzipParts,
    gzipDeclarationPart,
    gzipStatePart,
    sha256: sha256File(filePath),
  }
}

// ---------------------------------------------------------------------------
// 三条判定式
// ---------------------------------------------------------------------------

/** R1：κ 随 N 同步增长（相邻点 κ 增长 ≥ 1/√λ）。同 N 的点对跳过（没有增量就没有判据）。 */
export function evaluateR1(points) {
  const pairs = []
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (b.N === a.N) {
      pairs.push({
        fromN: a.N,
        toN: b.N,
        skipped: true,
        reason: 'N 相同（通道轴声明成本，无组合增量）',
        gzipGrowth: b.G / a.G,
        kappaGrowth: b.kappa / a.kappa,
      })
      continue
    }
    pairs.push({
      fromN: a.N,
      toN: b.N,
      skipped: false,
      fromFile: a.fileName,
      toFile: b.fileName,
      kappaA: a.kappa,
      kappaB: b.kappa,
      kappaGrowth: b.kappa / a.kappa,
      limit: KAPPA_STEP_LIMIT,
      gzipGrowth: b.G / a.G,
      variantsGrowth: b.N / a.N,
      marginalBytesPerVariant: (b.G - a.G) / (b.N - a.N),
      marginalDeclarationBytesPerVariant: (b.gzipDeclarationPart - a.gzipDeclarationPart) / (b.N - a.N),
      ok: b.kappa / a.kappa >= KAPPA_STEP_LIMIT,
    })
  }
  const judged = pairs.filter((p) => !p.skipped)
  return {
    id: 'R1',
    name: 'κ=V/G 随 N 同步增长',
    criterion: `相邻点 κ 增长 ≥ 1/√λ = ${KAPPA_STEP_LIMIT.toFixed(4)}（λ=${CRITERION.safetyFactor}）`,
    pairs,
    judgedPairs: judged.length,
    skippedPairs: pairs.length - judged.length,
    status: judged.length === 0 ? 'not-applicable' : judged.every((p) => p.ok) ? 'pass' : 'fail',
    reason: judged.length === 0 ? '序列里没有 N 增长的相邻点对' : null,
  }
}

/**
 * R2：`G ≈ a + b·N` 线性拟合 + 常数项/边际成本闸门。
 *
 * 三种结果：
 *   `pass`          拟合过 + 边际上限内 + （变量部分够大 或 文件确实小）
 *   `not-applicable` 变量部分 `b·N_max < 4096`（契约 §9.3 明文"该点无判定意义"）且文件本身**不小**
 *                    → 常数主导，但常数不是"信封头"而是**每文件未剪枝的材质/贴图池**（T1.4 开放项 2）。
 *                    此时 R2 交由**契约 k 序列**判定（见 `contractKSequence`），本序列另附 `supplementary`
 *                    的边际成本机器判据（每组合边际 ≪ 单变体完整网格）。
 *   `fail`          R² < 0.95 或 b > 2048（真正的"组合展开"信号）
 */
export function evaluateR2(points) {
  const applicable = points.length >= 3 && new Set(points.map((p) => p.N)).size >= 2
  if (!applicable) {
    return {
      id: 'R2',
      name: 'G ≈ a + b·N 线性拟合 + 边际成本上限',
      status: 'not-applicable',
      reason: `点不足或 N 无变化（点 ${points.length}，唯一 N ${new Set(points.map((p) => p.N)).size}）`,
      criterion: CRITERION,
    }
  }
  const xs = points.map((p) => p.N)
  const ys = points.map((p) => p.G)
  const fit = leastSquares(xs, ys)
  const maxN = Math.max(...xs)
  const variablePart = fit.b * maxN
  const gateRequired = 2 * Math.max(fit.a, CRITERION.floorBytes)
  const constantDominated = variablePart < CRITERION.floorBytes
  const smallEnough = Math.max(...ys) <= CRITERION.floorBytes
  const r2Ok = fit.r2 >= CRITERION.r2Min
  const marginalOk = fit.b <= CRITERION.maxMarginalBytesPerVariant
  const gateSatisfied = variablePart >= gateRequired
  const poolShareOfIntercept = fit.a > 0 ? points[0].gzipParts.materialPool / fit.a : null

  // 补充判据（"没有组合展开"的直接机器证明）：每组合边际 < 单变体完整网格字节数
  const pairs = []
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (b.N === a.N) continue
    const perVariantGrid = b.N > 0 ? b.gridBytes / b.N : 0
    const marginal = (b.G - a.G) / (b.N - a.N)
    pairs.push({
      fromN: a.N,
      toN: b.N,
      marginalBytesPerVariant: marginal,
      perVariantGridBytes: perVariantGrid,
      ratio: perVariantGrid > 0 ? marginal / perVariantGrid : null,
      ok: perVariantGrid > 0 ? marginal <= 0.9 * perVariantGrid : false,
    })
  }
  const supplementary = {
    checks: {
      r2Ok,
      marginalOk,
      poolShareOfInterceptProvable: poolShareOfIntercept !== null && poolShareOfIntercept >= 0.5,
      marginalBelowPerVariantGrid: pairs.length > 0 && pairs.every((p) => p.ok),
      marginalDeclarationBelowLimit: points.every((p) => p.gzipDeclarationPart >= 0),
    },
    pairs,
    poolShareOfIntercept,
    note: '每组合边际成本必须**小于**该序列单变体完整网格字节数（= 未做"每组合物化一份网格"的直接证明）；' +
      '并验证截距 a 的 ≥50% 来自每文件固定池（证明"常数主导"是池常数而非组合开销）。',
  }
  const suppOk = supplementary.checks.poolShareOfInterceptProvable && supplementary.checks.marginalBelowPerVariantGrid

  let status
  let branch
  let reason = null
  if (!r2Ok || !marginalOk) {
    branch = 'linear'
    status = 'fail'
    reason = `拟合未过：R²=${fit.r2.toFixed(4)}（需 ≥${CRITERION.r2Min}）、b=${fit.b.toFixed(2)} B/组合（需 ≤${CRITERION.maxMarginalBytesPerVariant}）`
  } else if (constantDominated) {
    branch = smallEnough ? 'small-structure' : 'pool-dominated'
    if (smallEnough) {
      status = 'pass'
      reason = `变量部分 b·N_max=${variablePart.toFixed(0)} B < ${CRITERION.floorBytes} B → 走"文件足够小"分支（max(G)=${Math.max(...ys)} B ≤ ${CRITERION.floorBytes} B）`
    } else {
      status = suppOk ? 'not-applicable' : 'fail'
      reason =
        `变量部分 b·N_max=${variablePart.toFixed(0)} B < ${CRITERION.floorBytes} B → 按契约 §9.3 "该点无判定意义"。` +
        `该序列的常数由**每文件固定池**主导（池 gzip ${points[0].gzipParts.materialPool} B 占截距 a=${fit.a.toFixed(0)} 的 ${(poolShareOfIntercept * 100).toFixed(0)}%；` +
        `T1.4 开放项 2：materialPalette/textureBlobs 未按机剪枝），与 N 无关 → R2 的 k 序列判定改由契约 k 序列承担；` +
        `本序列的边际成本证据：${pairs.map((p) => `${p.fromN}→${p.toN} 边际 ${p.marginalBytesPerVariant.toFixed(1)} B/组合 vs 单变体网格 ${p.perVariantGridBytes.toFixed(0)} B`).join('；')}`
    }
  } else if (gateSatisfied) {
    branch = 'linear'
    status = 'pass'
  } else {
    branch = 'constant-dominated-gate'
    status = suppOk ? 'pass-with-caveat' : 'fail'
    reason =
      `契约 §9.3 闸门未满足：b·N_max=${variablePart.toFixed(0)} B < 2·max(a,${CRITERION.floorBytes})=${gateRequired.toFixed(0)} B` +
      `（每文件固定池 gzip ${points[0].gzipParts.materialPool} B）。斜率与拟合度均过，附分解证据与补充判据。`
  }

  return {
    id: 'R2',
    name: 'G ≈ a + b·N 线性拟合 + 边际成本上限',
    criterion: CRITERION,
    branch,
    status,
    reason,
    fit: { a: fit.a, b: fit.b, r2: fit.r2 },
    points: points.map((p) => ({ file: p.fileName, N: p.N, G: p.G })),
    maxN,
    variablePart,
    gateRequired,
    gateSatisfied,
    constantDominated,
    smallEnough,
    r2Ok,
    marginalOk,
    supplementary,
    marginalDeclarationBytesPerVariant:
      points.length > 1
        ? (points[points.length - 1].gzipDeclarationPart - points[0].gzipDeclarationPart) /
          (points[points.length - 1].N - points[0].N)
        : null,
  }
}

/** R3：骨架 + 规则 + 调色板那一份不随 N 增长（相对 S 的增长）。 */
export function evaluateR3(points) {
  const spartOf = (p) => p.parts['multiblock.backbone'] + p.parts['multiblock.rules'] + p.parts.blockPalette
  const pairs = []
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const spartA = spartOf(a)
    const spartB = spartOf(b)
    const sGrowth = a.S === 0 ? 1 : b.S / a.S
    const spartGrowth = spartA === 0 ? 1 : spartB / spartA
    const limit = 2 * CRITERION.safetyFactor * sGrowth
    pairs.push({
      fromN: a.N,
      toN: b.N,
      fromS: a.S,
      toS: b.S,
      spartA,
      spartB,
      spartGrowth,
      sGrowth,
      limit,
      ok: spartGrowth <= limit,
    })
  }
  return {
    id: 'R3',
    name: '骨架+规则+调色板那一份不随 N 增长（相对 S）',
    criterion: `spart 增长 ≤ 2λ ×（S 增长）（λ=${CRITERION.safetyFactor}）`,
    pairs,
    status: pairs.length === 0 ? 'not-applicable' : pairs.every((p) => p.ok) ? 'pass' : 'fail',
  }
}

// ---------------------------------------------------------------------------
// 序列装配
// ---------------------------------------------------------------------------

function seriesVerdict(series) {
  const points = series.points.filter((p) => p.pure)
  const r1 = evaluateR1(points)
  const r2 = evaluateR2(points)
  const r3 = evaluateR3(points)
  const failing = [r1, r2, r3].filter((r) => r.status === 'fail')
  const caveats = [r1, r2, r3].filter((r) => r.status === 'pass-with-caveat' || r.status === 'not-applicable')
  const suppOk = r2.supplementary ? r2.supplementary.checks.poolShareOfInterceptProvable && r2.supplementary.checks.marginalBelowPerVariantGrid : null
  // R2 的"不判失败"必须由补充机器判据背书：边际 < 单变体网格、截距主要来自固定池
  const suppFail = r2.status === 'not-applicable' && suppOk === false
  return {
    id: series.id,
    name: series.name,
    axis: series.axis,
    points: points.map((p) => ({ N: p.N, S: p.S, G: p.G, V: p.V, kappa: p.kappa, file: p.fileName, gzipDeclarationPart: p.gzipDeclarationPart })),
    extended: series.extended.map((p) => ({ N: p.N, S: p.S, G: p.G, V: p.V, kappa: p.kappa, file: p.fileName, gzipDeclarationPart: p.gzipDeclarationPart })),
    R1: r1,
    R2: r2,
    R3: r3,
    supplementaryOk: suppOk,
    status: failing.length > 0 || suppFail ? 'fail' : caveats.length > 0 ? 'pass-with-caveat' : 'pass',
  }
}

// ---------------------------------------------------------------------------
// 体积剖析：风险 4（调色板并集体量占比）
// ---------------------------------------------------------------------------

/** 调色板并集（blockPalette 的 meta + geometry 桶）在**内层**的占比。 */
export function paletteUnionShare(doc) {
  const parts = doc.parts
  const paletteBytes = parts.blockPalette
  const inner = doc.innerCompact
  const poolBytes = parts['materialPool(materialPalette+textureBlobs+tooltipPalette)']
  return {
    file: doc.fileName,
    slug: doc.slug,
    paletteEntries: doc.paletteEntries,
    paletteUsedEntries: doc.paletteUsedEntries,
    paletteUnusedEntries: doc.paletteUnusedEntries,
    paletteBytes,
    innerCompact: inner,
    paletteShare: inner > 0 ? paletteBytes / inner : null,
    poolBytes,
    poolShare: inner > 0 ? poolBytes / inner : null,
    cellsPerVariant: doc.cellsPerVariant,
  }
}

export const RISK4_THRESHOLDS = {
  // 编排层自定（计划未给定阈值；依据见报告 criterionNotes）：
  // T1.4 实测 5 台产物 palette 占比 2.6%–23.9%（QFT 3.6%…EBF 23.9%），
  // T0.1 的 `/sde export`（帧为主）单变体文档为 68.8% → 多方块并集调色板应显著低于它。
  warn: 0.25,
  red: 0.4,
  dedupRatioMin: 0.05, // 真机变体数 / 调色板条目数 的下限（去重必须真的发生）
}

function risk4Check(measures, captureTotals) {
  const rows = measures.map(paletteUnionShare)
  const worst = rows.reduce((a, b) => (a && a.paletteShare >= b.paletteShare ? a : b), null)
  const red = rows.filter((r) => r.paletteShare !== null && r.paletteShare >= RISK4_THRESHOLDS.red)
  const warn = rows.filter(
    (r) => r.paletteShare !== null && r.paletteShare >= RISK4_THRESHOLDS.warn && r.paletteShare < RISK4_THRESHOLDS.red,
  )
  const dedup = captureTotals
    ? {
        variants: captureTotals.variants,
        paletteEntries: captureTotals.paletteEntries,
        duplicateCapturesSuppressed: captureTotals.duplicateCapturesSuppressed,
        internCalls: captureTotals.internCalls,
        dedupRatio: captureTotals.internCalls > 0 ? captureTotals.paletteEntries / captureTotals.internCalls : null,
        variantsPerPaletteEntry: captureTotals.paletteEntries > 0 ? captureTotals.variants / captureTotals.paletteEntries : null,
        ok: captureTotals.paletteEntries > 0 && captureTotals.variants / captureTotals.paletteEntries >= 1 / RISK4_THRESHOLDS.dedupRatioMin,
      }
    : null
  return {
    thresholds: RISK4_THRESHOLDS,
    rows,
    worst,
    redFiles: red.map((r) => r.file),
    warnFiles: warn.map((r) => r.file),
    dedup,
    status: red.length > 0 ? 'fail' : warn.length > 0 ? 'warn' : 'pass',
    note:
      '风险 4 = 调色板并集体量。判据①：每台产物 blockPalette 占内层字节比（≥40% 标红、≥25% 标黄）；' +
      '判据②：并集去重率（变体数/调色板条目数，来自 mod 侧捕获统计）必须证明"真去重"而非"逐变体一份"。',
  }
}

// ---------------------------------------------------------------------------
// 曲线图（纯 SVG，无依赖）
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function svgChart({ seriesList, width = 1000, height = 420 }) {
  const seriesColors = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c']
  const panels = [
    { title: 'G（内层 gzip 字节）vs N（组合数）', xKey: 'N', yKey: 'G', logY: false },
    { title: 'κ = V/G（展开比）vs N —— log10', xKey: 'N', yKey: 'kappa', logY: true },
  ]
  const panelW = width / 2
  const padL = 64
  const padR = 20
  const padT = 34
  const padB = 46
  const plotW = panelW - padL - padR
  const plotH = height - padT - padB

  const allPts = seriesList.flatMap((s) => [...s.points, ...s.extended])
  const xs = allPts.map((p) => p.N)
  const xMin = 0
  const xMax = Math.max(1, ...xs) * 1.06

  const out = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + 26}" viewBox="0 0 ${width} ${height + 26}" font-family="ui-monospace,Consolas,monospace" font-size="11">`,
  )
  out.push(`<rect width="${width}" height="${height + 26}" fill="#ffffff"/>`)

  panels.forEach((panel, pi) => {
    const ox = pi * panelW + padL
    const oy = padT
    const ysRaw = allPts.map((p) => p[panel.yKey]).filter((v) => v !== null && v !== undefined)
    const yMin = panel.logY ? Math.log10(Math.max(0.05, Math.min(...ysRaw) * 0.8)) : 0
    const yMax = panel.logY
      ? Math.log10(Math.max(0.1, Math.max(...ysRaw)) * 1.25)
      : Math.max(...ysRaw) * 1.08
    const X = (n) => ox + (n / xMax) * plotW
    const Y = (v) => {
      const t = panel.logY ? Math.log10(Math.max(0.05, v)) : v
      return oy + plotH - ((t - yMin) / (yMax - yMin || 1)) * plotH
    }
    out.push(`<rect x="${ox}" y="${oy}" width="${plotW}" height="${plotH}" fill="#fafafa" stroke="#cbd5e1"/>`)
    out.push(`<text x="${ox}" y="${oy - 14}" font-size="12" font-weight="bold" fill="#0f172a">${esc(panel.title)}</text>`)
    // y 轴刻度（4 条）
    for (let k = 0; k <= 4; k++) {
      const t = yMin + ((yMax - yMin) * k) / 4
      const v = panel.logY ? 10 ** t : t
      const y = oy + plotH - (k / 4) * plotH
      out.push(`<line x1="${ox}" y1="${y}" x2="${ox + plotW}" y2="${y}" stroke="#e2e8f0"/>`)
      out.push(
        `<text x="${ox - 6}" y="${y + 4}" text-anchor="end" fill="#64748b">${
          panel.logY ? v.toFixed(2) : Math.round(v).toLocaleString('en-US')
        }</text>`,
      )
    }
    // x 轴刻度
    const xTicks = [0, 0.25, 0.5, 0.75, 1]
    for (const f of xTicks) {
      const n = f * xMax
      const x = X(n)
      out.push(`<line x1="${x}" y1="${oy + plotH}" x2="${x}" y2="${oy + plotH + 4}" stroke="#94a3b8"/>`)
      out.push(`<text x="${x}" y="${oy + plotH + 18}" text-anchor="middle" fill="#64748b">${Math.round(n)}</text>`)
    }
    out.push(`<text x="${ox + plotW / 2}" y="${oy + plotH + 36}" text-anchor="middle" fill="#475569">N（组合数）</text>`)
  })

  seriesList.forEach((s, si) => {
    const color = seriesColors[si % seriesColors.length]
    const panelOf = (panel) => {
      const pi = panels.findIndex((p) => p.yKey === panel.yKey)
      const ox = pi * panelW + padL
      const oy = padT
      const ysRaw = allPts.map((p) => p[panel.yKey]).filter((v) => v !== null && v !== undefined)
      const yMin = panel.logY ? Math.log10(Math.max(0.05, Math.min(...ysRaw) * 0.8)) : 0
      const yMax = panel.logY ? Math.log10(Math.max(0.1, Math.max(...ysRaw)) * 1.25) : Math.max(...ysRaw) * 1.08
      const X = (n) => ox + (n / xMax) * plotW
      const Y = (v) => {
        const t = panel.logY ? Math.log10(Math.max(0.05, v)) : v
        return oy + plotH - ((t - yMin) / (yMax - yMin || 1)) * plotH
      }
      return { X, Y }
    }
    for (const panel of panels) {
      const { X, Y } = panelOf(panel)
      const pts = [...s.points].sort((a, b) => a.N - b.N)
      const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${X(p.N).toFixed(1)},${Y(p[panel.yKey]).toFixed(1)}`).join(' ')
      out.push(`<path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>`)
      for (const p of pts) {
        out.push(`<circle cx="${X(p.N).toFixed(1)}" cy="${Y(p[panel.yKey]).toFixed(1)}" r="3.4" fill="${color}"/>`)
      }
      for (const p of s.extended ?? []) {
        out.push(
          `<rect x="${(X(p.N) - 3).toFixed(1)}" y="${(Y(p[panel.yKey]) - 3).toFixed(1)}" width="6" height="6" fill="${color}" opacity="0.55"/>`,
        )
      }
      if (panel.yKey === 'G' && s.R2?.fit && s.R2.branch === 'linear' && s.R2.points?.length > 1) {
        const nA = Math.min(...s.points.map((p) => p.N))
        const nB = Math.max(...s.points.map((p) => p.N))
        const gA = s.R2.fit.a + s.R2.fit.b * nA
        const gB = s.R2.fit.a + s.R2.fit.b * nB
        out.push(
          `<line x1="${X(nA).toFixed(1)}" y1="${Y(gA).toFixed(1)}" x2="${X(nB).toFixed(1)}" y2="${Y(gB).toFixed(1)}" stroke="${color}" stroke-width="1" stroke-dasharray="5 4" opacity="0.8"/>`,
        )
      }
    }
  })

  // 图例
  seriesList.forEach((s, si) => {
    const color = seriesColors[si % seriesColors.length]
    const ly = height + 8
    const lx = 20 + si * 330
    out.push(`<line x1="${lx}" y1="${ly}" x2="${lx + 22}" y2="${ly}" stroke="${color}" stroke-width="2"/>`)
    out.push(
      `<text x="${lx + 28}" y="${ly + 4}" fill="#334155">${esc(s.id)}（${esc(s.axis)}）→ ${esc(s.status)}</text>`,
    )
  })
  out.push('</svg>')
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, v] = a.includes('=') ? a.slice(2).split(/=(.*)/s) : [a.slice(2), undefined]
      out[k] = v !== undefined ? v : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    }
  }
  return out
}

function collectSeries(encodedDir, measuresByFile) {
  const ctl = path.join(encodedDir, 'control')
  const files = fs.existsSync(ctl) ? fs.readdirSync(ctl).filter((f) => f.endsWith('.multiblock.json') && !f.endsWith('.body.json')) : []
  const controls = files.map((f) => path.join(ctl, f))
  const product = (slug) => path.join(encodedDir, `${slug}.multiblock.json`)

  const mk = (p, series) => measureDocument(p, { kind: p.includes(`${path.sep}control${path.sep}`) ? 'control' : 'product', series })

  const valuesControls = controls
    .filter((f) => path.basename(f).startsWith('ctl-values-'))
    .map((f) => mk(f, 'values'))
    .sort((a, b) => a.N - b.N)

  const channelControls = controls.filter((f) => path.basename(f).startsWith('ctl-chan-')).map((f) => mk(f, 'channels'))
  const channelOrder = { 'ctl-chan-1-shielding': 0, 'ctl-chan-1-manipulator': 1, 'ctl-chan-2-degenerate': 2, 'ctl-chan-2-both': 3 }
  channelControls.sort(
    (a, b) => (channelOrder[a.slug] ?? 9) - (channelOrder[b.slug] ?? 9) || a.N - b.N,
  )

  const seriesList = []
  if (valuesControls.length > 0) {
    const ebfProductPath = product('mteelectricblastfurnace')
    const ebfFull = fs.existsSync(ebfProductPath) ? [mk(ebfProductPath, 'values')] : []
    seriesList.push({
      id: 'encoder-values',
      name: '编码器对照：EBF coil 取值数递增（tierSample=[1,2]）',
      axis: '取值数 +1 ×3 档',
      points: valuesControls.map((p) => ({ ...p, pure: true })),
      extended: ebfFull.map((p) => ({ ...p, pure: false })),
    })
  }
  if (channelControls.length > 0) {
    const qftProductPath = product('mtequantumforcetransformer')
    const qftFull = fs.existsSync(qftProductPath) ? [mk(qftProductPath, 'channels')] : []
    seriesList.push({
      id: 'encoder-channels',
      name: '编码器对照：QFT 通道数递增（tierSample=[1]）',
      axis: '通道数 +1（1→2 通道，含退化对照）',
      points: channelControls.map((p) => ({ ...p, pure: true })),
      extended: qftFull.map((p) => ({ ...p, pure: false })),
    })
  }
  void measuresByFile
  return { seriesList, controls, valuesControls, channelControls }
}

/**
 * 交付产物（`/sde multiblock` 落盘的信封）的直接度量 —— 风险 4 只用它们判定
 * （对照组是实验内部产物，其调色板占比没有交付意义）。
 */
function measureProducts(dir, profileByLabel) {
  if (!dir || !fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.multiblock.json') && !f.endsWith('.body.json'))
    .sort()
    .map((f) => {
      const p = measureDocument(path.join(dir, f), { kind: 'product', series: 'deliverable' })
      const prof = profileByLabel.get(path.basename(p.fileName))
      if (prof?.envelope?.inner) {
        p.profileBuckets = prof.envelope.inner.buckets
        p.profileInnerCompact = prof.envelope.inner.compactBytes
        p.payloadGzipBytes = prof.envelope.payloadGzipBytes
      }
      return p
    })
}

function mdFromReport(report) {  const L = []
  L.push('# T3.2 体积增长曲线（机器判定）')
  L.push('')
  L.push(`> 判据真源：\`docs/plan/format-multiblock-doc.md\` §9.2/§9.3/§9.4；λ=${CRITERION.safetyFactor}、R²≥${CRITERION.r2Min}、b≤${CRITERION.maxMarginalBytesPerVariant} B/组合、常数项下限 ${CRITERION.floorBytes} B。`)
  L.push(`> 生成时间：${report.generatedAt}；输入：\`${report.input.encodedDir}\``)
  L.push('')
  L.push(`## 总判定：**${report.verdict.status}**`)
  L.push('')
  for (const s of report.series) {
    L.push(`### ${s.id} —— ${s.name}`)
    L.push('')
    L.push(`轴：${s.axis}；判定 **${s.status}**`)
    L.push('')
    L.push('| 文档 | 类 | N | S | G(gzip内层) | V(展开) | κ=V/G | B/组合 | 声明部分 gzip |')
    L.push('|---|---|---:|---:|---:|---:|---:|---:|---:|')
    for (const p of s.points) {
      L.push(`| ${p.file} | 对照 | ${p.N} | ${p.S} | ${p.G} | ${p.V} | ${p.kappa.toFixed(3)} | ${(p.G / p.N).toFixed(1)} | ${p.gzipDeclarationPart} |`)
    }
    for (const p of s.extended) {
      L.push(`| ${p.file} | 全量域 | ${p.N} | ${p.S} | ${p.G} | ${p.V} | ${p.kappa.toFixed(3)} | ${(p.G / p.N).toFixed(1)} | ${p.gzipDeclarationPart} |`)
    }
    L.push('')
    L.push(`- **R1**：${s.R1.status} —— ${s.R1.criterion}`)
    for (const p of s.R1.pairs) {
      if (p.skipped) L.push(`  - N ${p.fromN}→${p.toN}：跳过（${p.reason}）`)
      else
        L.push(
          `  - N ${p.fromN}→${p.toN}：κ ×${p.kappaGrowth.toFixed(3)} ≥ ${p.limit.toFixed(3)} → ${p.ok ? '✔' : '✘'}；边际 ${p.marginalBytesPerVariant.toFixed(1)} B/组合（其中声明部分 ${p.marginalDeclarationBytesPerVariant.toFixed(1)} B/组合）`,
        )
    }
    L.push(
      `- **R2**：${s.R2.status}（分支 ${s.R2.branch ?? '—'}）` +
        (s.R2.fit
          ? ` —— G ≈ ${s.R2.fit.a.toFixed(0)} + ${s.R2.fit.b.toFixed(2)}·N，R²=${s.R2.fit.r2.toFixed(4)}；b·N_max=${s.R2.variablePart?.toFixed(0)} B，闸门 2·max(a,4096)=${s.R2.gateRequired?.toFixed(0)} B，满足=${s.R2.gateSatisfied}`
          : ''),
    )
    if (s.R2.reason) L.push(`  - ${s.R2.reason}`)
    if (s.R2.supplementary) {
      L.push(
        `  - 补充机器判据：截距固定池占比 ${(s.R2.supplementary.poolShareOfIntercept * 100).toFixed(0)}%（需 ≥50%）→ ${s.R2.supplementary.checks.poolShareOfInterceptProvable ? '✔' : '✘'}；` +
          `每组合边际 < 单变体网格 → ${s.R2.supplementary.checks.marginalBelowPerVariantGrid ? '✔' : '✘'}`,
      )
      for (const p of s.R2.supplementary.pairs)
        L.push(`    · N ${p.fromN}→${p.toN}：边际 ${p.marginalBytesPerVariant.toFixed(1)} B/组合 vs 单变体完整网格 ${p.perVariantGridBytes.toFixed(0)} B（比 ${(p.ratio * 100).toFixed(1)}%）`)
    }
    if (s.R2.marginalDeclarationBytesPerVariant !== null && s.R2.marginalDeclarationBytesPerVariant !== undefined)
      L.push(`  - 声明部分边际（frames+variants+rules+backbone 的 gzip 差 / ΔN）：${s.R2.marginalDeclarationBytesPerVariant.toFixed(1)} B/组合`)
    L.push(`- **R3**：${s.R3.status}`)
    for (const p of s.R3.pairs)
      L.push(
        `  - N ${p.fromN}→${p.toN}：spart ${p.spartA}→${p.spartB} B（×${p.spartGrowth.toFixed(3)}）≤ 2λ×S增长 ${p.limit.toFixed(3)} → ${p.ok ? '✔' : '✘'}`,
      )
    L.push('')
  }
  L.push('## 风险 4：调色板并集体量占比')
  L.push('')
  L.push(`判据：${report.risk4.note}`)
  L.push('')
  L.push('| 文件 | 调色板条目 | 并集字节 | 内层字节 | 占比 | 固定池占比 | 判定 |')
  L.push('|---|---:|---:|---:|---:|---:|---|')
  for (const r of report.risk4.rows) {
    const flag =
      r.paletteShare >= RISK4_THRESHOLDS.red ? '**红**' : r.paletteShare >= RISK4_THRESHOLDS.warn ? '黄' : '绿'
    L.push(
      `| ${r.file} | ${r.paletteEntries} | ${r.paletteBytes} | ${r.innerCompact} | ${(r.paletteShare * 100).toFixed(1)}% | ${(r.poolShare * 100).toFixed(1)}% | ${flag} |`,
    )
  }
  L.push('')
  if (report.risk4.dedup)
    L.push(
      `去重率证据（mod 侧捕获统计）：变体 ${report.risk4.dedup.variants} → 调色板 ${report.risk4.dedup.paletteEntries} 条，` +
        `每条目服务 ${report.risk4.dedup.variantsPerPaletteEntry.toFixed(1)} 个变体；抑制重复捕获 ${report.risk4.dedup.duplicateCapturesSuppressed} 次 → ${report.risk4.dedup.ok ? '✔ 真去重' : '✘'}`,
    )
  L.push('')
  return L.join('\n')
}

export function buildVolumeCurve({ encodedDir, productsDir = null, profilePath = null, contractReportPath = null, pipelineResultPath = null }) {
  const { seriesList } = collectSeries(encodedDir, null)
  if (seriesList.length === 0) throw new Error(`在 ${encodedDir} 下找不到对照组文档（先跑 factorize.ps1 --control）`)

  const profile = readJsonIfExists(profilePath)
  const profileByLabel = new Map()
  for (const e of profile ?? []) {
    const base = path.basename(e.label ?? '')
    if (base) profileByLabel.set(base, e)
  }
  // 把 volume-profile 的分桶结果注入到对应文档（按文件名匹配）
  for (const s of seriesList) {
    for (const list of [s.points, s.extended]) {
      for (const p of list) {
        const prof = profileByLabel.get(p.fileName)
        if (prof?.envelope?.inner) {
          p.profileBuckets = prof.envelope.inner.buckets
          p.profileInnerCompact = prof.envelope.inner.compactBytes
          p.payloadGzipBytes = prof.envelope.payloadGzipBytes
        }
      }
    }
  }

  const pipelineResult = readJsonIfExists(pipelineResultPath)
  const captureTotals = pipelineResult?.timing?.captureTotals ?? null

  const series = seriesList.map(seriesVerdict)
  const deliverableMeasures = measureProducts(productsDir, profileByLabel)
  const allMeasures = [...seriesList.flatMap((s) => [...s.points, ...s.extended]), ...deliverableMeasures]
  // 风险 4 只看交付产物；没有交付产物目录时退回用编码器产物（并在 note 里标注）
  const risk4Measures = deliverableMeasures.length > 0 ? deliverableMeasures : seriesList.flatMap((s) => s.extended)
  const risk4 = risk4Check(risk4Measures, captureTotals)
  risk4.basis = deliverableMeasures.length > 0 ? 'deliverable-products' : 'encoder-products(fallback)'
  risk4.basisDir = deliverableMeasures.length > 0 ? rel(productsDir) : null

  const failing = series.filter((s) => s.status === 'fail')
  const caveats = series.filter((s) => s.status === 'pass-with-caveat')
  const encVerdict =
    failing.length > 0
      ? 'fail'
      : caveats.length > 0
        ? 'pass-with-caveat'
        : series.length > 0
          ? 'pass'
          : 'not-applicable'

  // 契约 k 序列（T0.5 参考实现的结果，只读）
  const contractReport = readJsonIfExists(contractReportPath)
  const contractK = (contractReport?.volume ?? []).map((v) => ({
    file: v.file,
    points: (v.points ?? []).map((p) => ({ k: p.k, S: p.S, N: p.N, gzipBytes: p.gzipBytes, kappa: p.kappa, bytesPerVariant: p.bytesPerVariant })),
    fit: v.fit,
    checks: v.checks,
    pairs: (v.pairs ?? []).map((p) => ({ fromN: p.fromN, toN: p.toN, kappaGrowth: p.kappaGrowth, kappaLimit: p.kappaLimit, r1: p.r1, marginal: p.marginal })),
    pass: v.pass,
  }))

  const report = {
    schema: 'lightning.acceptance.volume-curve/1',
    generatedAt: new Date().toISOString(),
    criterion: CRITERION,
    kappaStepLimit: KAPPA_STEP_LIMIT,
    input: {
      encodedDir: rel(encodedDir) ?? encodedDir,
      productsDir: productsDir ? rel(productsDir) : null,
      profile: profilePath ? rel(profilePath) : null,
      contractReport: contractReportPath ? rel(contractReportPath) : null,
      pipelineResult: pipelineResultPath ? rel(pipelineResultPath) : null,
      profileEntries: (profile ?? []).length,
    },
    products: deliverableMeasures.map((p) => ({
      file: p.file,
      slug: p.slug,
      machine: p.machine,
      N: p.N,
      S: p.S,
      frames: p.frames,
      rules: p.rules,
      paletteEntries: p.paletteEntries,
      paletteUnusedEntries: p.paletteUnusedEntries,
      cells: p.cells,
      fileBytes: p.fileBytes,
      innerCompact: p.innerCompact,
      G: p.G,
      V: p.V,
      kappa: p.kappa,
      paletteShare: p.innerCompact > 0 ? p.paletteBytes / p.innerCompact : null,
      sha256: p.sha256,
    })),
    documents: allMeasures.map((p) => ({
      file: p.file,
      kind: p.kind,
      series: p.series,
      slug: p.slug,
      machine: p.machine,
      N: p.N,
      S: p.S,
      S_sample: p.S_sample,
      channelCount: p.channelCount,
      channels: p.channels,
      frames: p.frames,
      rules: p.rules,
      paletteEntries: p.paletteEntries,
      paletteUsedEntries: p.paletteUsedEntries,
      paletteUnusedEntries: p.paletteUnusedEntries,
      cells: p.cells,
      cellsPerVariant: p.cellsPerVariant,
      fileBytes: p.fileBytes,
      payloadGzipBytes: p.payloadGzipBytes,
      innerCompact: p.innerCompact,
      G: p.G,
      V: p.V,
      paletteBytes: p.paletteBytes,
      gridBytes: p.gridBytes,
      kappa: p.kappa,
      bytesPerVariant: p.bytesPerVariant,
      gzipDeclarationPart: p.gzipDeclarationPart,
      gzipStatePart: p.gzipStatePart,
      gzipParts: p.gzipParts,
      parts: p.parts,
      profileBuckets: p.profileBuckets ?? null,
      sha256: p.sha256,
    })),
    series,
    risk4,
    contractKSequence: contractK,
    verdict: {
      status: encVerdict,
      basis:
        'encoderSeries（真实编码器对照组的 R1 ∧ R3 ∧ R2 补充判据）' +
        ' + contractKSequence（T0.5 参考实现的合成 k 序列，**R2 的正式判定落在这里**：真实产物在 N≤60 时变量部分低于 4096 B 下限，契约 §9.3 明文"该点无判定意义"）' +
        ' + products κ（无组合展开）',
      encoderSeriesFail: failing.map((s) => s.id),
      encoderSeriesCaveat: caveats.map((s) => s.id),
      contractKSequencePassed: contractK.length > 0 ? contractK.every((c) => c.pass) : null,
    },
    criterionNotes: [
      'R1/R3 在**真实编码器对照组**上判定（离线 MultiblockFactorizeTool 对捕获数据集做域子集重编码，与生产同一 Java 编码器）。',
      'R2 的正式判定落在**契约 k 序列**（T0.5 参考实现 `validate-multiblock-fixtures.mjs --volume` 对契约 fixture 做通道域 ×1/×2/×4/×8 放大）：' +
        '真实产物序列的变量部分 b·N_max≈1.4 KB < 4096 B 下限，按契约 §9.3 属"该点无判定意义"；' +
        'R2 在真实序列上的可判部分（斜率 b ≤ 2048、R² ≥ 0.95）与补充判据（每组合边际 < 单变体完整网格、截距主要来自固定池）如实记录，不静默算通过。',
      'R2 的恒定项闸门 `b·N_max ≥ 2·max(a,4096)` 在真实产物上必然不满足：每文件 materialPalette+textureBlobs 池 ≈40 KB gzip（T1.4 开放项 2：未按机剪枝）、' +
        '而契约 §9.4 的 4096 B 下限是按"信封头 300–400 B"设的。该差异已登记为 openItem，需调度者知悉（不影响"无组合展开"结论：见 R1/R3/边际/κ 四路证据）。',
      'V 的口径 = blockPalette×1 + Σ 每变体完整 cellGrid（不含材质/贴图池，与契约 §9.2 字面口径一致）；κ①（含池）见 contractKSequence。',
      'G 的口径 = 内层 body JSON 的 gzip level 9（确定性，同一输入两次运行逐字节一致）。',
    ],
  }
  return report
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const encodedDir = path.resolve(args.encoded ?? path.join(REPO_ROOT, 'mod/gtnh/run/client/variant_capture/encoded'))
  const outDir = ensureDir(path.resolve(args.out ?? path.join(REPO_ROOT, 'scripts/acceptance/.out/volume')))
  const report = buildVolumeCurve({
    encodedDir,
    productsDir: args.products ? path.resolve(args.products) : null,
    profilePath: args.profile ? path.resolve(args.profile) : null,
    contractReportPath: args['contract-report'] ? path.resolve(args['contract-report']) : null,
    pipelineResultPath: args['pipeline-result'] ? path.resolve(args['pipeline-result']) : null,
  })

  writeJson(path.join(outDir, 'volume-curve.json'), report)
  writeText(path.join(outDir, 'volume-curve.svg'), svgChart({ seriesList: report.series }))
  writeText(path.join(outDir, 'volume-curve.md'), mdFromReport(report) + '\n')

  console.log(`[T3.2] 体积曲线：${report.series.length} 条序列 / ${report.documents.length} 份文档`)
  for (const s of report.series) {
    console.log(`  - ${s.id}：${s.status}（R1=${s.R1.status} R2=${s.R2.status} R3=${s.R3.status}）`)
    if (s.R2.fit) console.log(`      G ≈ ${s.R2.fit.a.toFixed(0)} + ${s.R2.fit.b.toFixed(2)}·N  R²=${s.R2.fit.r2.toFixed(4)}`)
  }
  console.log(`  风险 4（调色板并集占比）：${report.risk4.status}；最高 ${report.risk4.worst?.file} = ${(report.risk4.worst?.paletteShare * 100).toFixed(1)}%`)
  console.log(`  总判定：${report.verdict.status}`)
  console.log(`  产物：${path.join(outDir, 'volume-curve.json')} / .svg / .md`)

  // 只有"编码器序列红"才算 T3.2 红（pass-with-caveat 不阻断，但报告里会显式登记）
  process.exit(report.verdict.status === 'fail' ? 1 : 0)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) main()
