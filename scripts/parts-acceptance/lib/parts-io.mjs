/**
 * P3.1/P3.3/P3.4 —— 部件验收编排的 Node 侧共享工具。
 *
 * 与 `scripts/acceptance/lib/evidence.mjs`（多方块轮）的分工：本文件只放**部件轮专有**的
 * 产物/ oracle 读入与判定原语；阶段片段 / 目录快照 / 哈希等通用原语直接复用多方块轮的实现
 * （`scripts/acceptance/lib/evidence.mjs`，本轮不重造范式，见计划 §5「总入口」）。
 *
 * 无第三方依赖（Node 内置 fs/path）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// 路径常量（与 web/e2e/helpers/parts/realExport.ts 的命名逐条对齐）
// ---------------------------------------------------------------------------

export const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 仓库根（本文件位于 scripts/parts-acceptance/lib/）。 */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
/** 部件验收脚本目录。 */
export const SCRIPTS_DIR = path.resolve(HERE, '..')
/** 归档根（`.out`，gitignore）。 */
export const ARCHIVE_ROOT = path.join(SCRIPTS_DIR, '.out')
/** canonical oracle 目录（留白 #9 拍板）。 */
export const ORACLE_DIR = path.join(SCRIPTS_DIR, 'oracle')

export const REAL_EXPORT_FILES = {
  full: 'sde_parts_acceptance_export_full_a.json',
  fullB: 'sde_parts_acceptance_export_full_b.json',
  fullcubeOnly: 'sde_parts_acceptance_export_fullcube_only.json',
  degradedAe2: 'sde_parts_acceptance_export_degraded_ae2.json',
  degradedAll: 'sde_parts_acceptance_export_degraded_all.json',
  custom: 'sde_parts_acceptance_export_custom.json',
  dump: 'sde_parts_acceptance_dump.json',
  result: 'sde_parts_acceptance_result.json',
}

export const ORACLE_FILES = {
  full: 'sde_parts_acceptance_oracle_full.json',
  degradedAe2: 'sde_parts_acceptance_oracle_degraded_ae2.json',
  degradedAll: 'sde_parts_acceptance_oracle_degraded_all.json',
  custom: 'sde_parts_acceptance_oracle_custom.json',
}

/** 契约 §11 哨兵值。 */
export const LOCAL_ID_INFERRED_WILDCARD = 'inferred:*'
export const BOXCOUNT_UNCHECKED = -1
export const PROVENANCE_UNCHECKED = '*'
export const PARTS_GRID_NONE = -1

/**
 * 物品索引表（契约 §2.2）oracle 扩展的字段名与判据常量（B-2 落盘 → #39 阶段一验收扩展）。
 *
 * oracle 侧新增：
 *  - root `itemIndex`：{ <物品身份键>: { display, displayChecked, tooltipNonEmpty, source, attribution[] } }
 *  - root `itemIndexScope`：`exact`（全量轮）/ `untransformed-cells-only`（退化轮，与 countsScope 同口径）
 *  - root `hostItems`：{ damageEqualsMeta, expect{hostKey→{registry,damage}}, absent[], derive[] }
 */
export const ITEM_INDEX_FIELD = 'itemIndex'
export const HOST_ITEM_FIELD = 'hostItem'
export const ITEM_INDEX_SCOPE_EXACT = 'exact'
export const ITEM_INDEX_SCOPE_UNTRANSFORMED = 'untransformed-cells-only'
/** 归属条目来源（`none` 不是条目来源，是"无条目"的汇总状态）。 */
export const ATTRIBUTION_SOURCES = ['part', 'host', 'family']
const SOURCE_RANK = { part: 0, host: 1, family: 2 }

/** 合法族（契约 §3/§4；实测实现口径 = localId 前缀）。 */
export const FAMILIES = ['ae2', 'eio', 'fmp', 'generic', 'inferred']
/** 合法盒来源（契约 §6.4）。 */
export const BOX_PROVENANCE = [
  'both',
  'collision-derived-visual',
  'visual-only',
  'collision-only',
  'degenerate',
]

// ---------------------------------------------------------------------------
// 基础 IO
// ---------------------------------------------------------------------------

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

export function readJsonIfExists(p) {
  if (!p || !fs.existsSync(p)) return null
  try {
    return readJson(p)
  } catch {
    return null
  }
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
  return p
}

export function writeJson(p, value) {
  ensureDir(path.dirname(p))
  fs.writeFileSync(p, JSON.stringify(value, null, 1) + '\n', 'utf8')
  return p
}

export function writeText(p, text) {
  ensureDir(path.dirname(p))
  fs.writeFileSync(p, text, 'utf8')
  return p
}

export function rel(p, base = REPO_ROOT) {
  return path.relative(base, p).replace(/\\/g, '/')
}

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const [k, v] = a.includes('=') ? a.slice(2).split(/=(.*)/s) : [a.slice(2), undefined]
    if (v !== undefined) out[k] = v
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i]
    else out[k] = true
  }
  return out
}

// ---------------------------------------------------------------------------
// 归档 / oracle 定位
// ---------------------------------------------------------------------------

export function hasFullExport(dir) {
  return fs.existsSync(path.join(dir, REAL_EXPORT_FILES.full))
}

/** 最近的含全套产物的归档目录（`.out/<label>`）。 */
export function latestArchive() {
  if (!fs.existsSync(ARCHIVE_ROOT)) return null
  const hits = fs
    .readdirSync(ARCHIVE_ROOT)
    .map((e) => path.join(ARCHIVE_ROOT, e))
    .filter((p) => {
      try {
        return fs.statSync(p).isDirectory() && hasFullExport(p)
      } catch {
        return false
      }
    })
    .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return hits.length > 0 ? hits[0].p : null
}

/** 解析归档目录（`--archive` 优先，其次最近归档）；不可用即抛错（不静默跳过）。 */
export function resolveArchive(explicit) {
  if (explicit) {
    const p = path.resolve(explicit)
    if (!hasFullExport(p)) throw new Error(`归档目录里没有 ${REAL_EXPORT_FILES.full}：${p}`)
    return p
  }
  const latest = latestArchive()
  if (!latest) {
    throw new Error(`找不到任何含 ${REAL_EXPORT_FILES.full} 的归档目录（${ARCHIVE_ROOT}）`)
  }
  return latest
}

/** canonical oracle 路径；缺失回退归档副本。 */
export function resolveOraclePath(kind, archiveDir) {
  const canonical = path.join(ORACLE_DIR, ORACLE_FILES[kind])
  if (fs.existsSync(canonical)) return { path: canonical, source: 'canonical' }
  if (archiveDir) {
    const archived = path.join(archiveDir, ORACLE_FILES[kind])
    if (fs.existsSync(archived)) return { path: archived, source: 'archive' }
  }
  throw new Error(`oracle 缺失：${canonical}${archiveDir ? ` / ${path.join(archiveDir, ORACLE_FILES[kind])}` : ''}`)
}

// ---------------------------------------------------------------------------
// 产物结构访问
// ---------------------------------------------------------------------------

export function gridValue(grid, zi, ri, ci) {
  const slice = grid?.[zi]
  const row = slice?.[ri]
  const v = row?.[ci]
  return typeof v === 'number' ? v : -2
}

export function cellParts(exportRoot, zi, ri, ci) {
  const idx = gridValue(exportRoot.cellPartsGrid, zi, ri, ci)
  if (idx < 0) return []
  const list = exportRoot.partLists?.[idx]
  return Array.isArray(list) ? list : []
}

/** 逐格展开（池去重下**每格引用都算一次**，与 web 侧 collectPartsForStats / L1 verifier 同口径）。 */
export function forEachCellParts(exportRoot, fn) {
  const grid = exportRoot.cellPartsGrid
  if (!Array.isArray(grid)) return 0
  let n = 0
  for (let z = 0; z < grid.length; z++) {
    for (let r = 0; r < (grid[z]?.length ?? 0); r++) {
      for (let c = 0; c < (grid[z]?.[r]?.length ?? 0); c++) {
        const idx = grid[z][r][c]
        if (typeof idx !== 'number' || idx <= PARTS_GRID_NONE) continue
        const list = exportRoot.partLists?.[idx]
        if (!Array.isArray(list)) continue
        for (const p of list) {
          fn(p, { z, r, c, idx })
          n++
        }
      }
    }
  }
  return n
}

/** 按 typeKey 聚合 items[].count（L1 verifier 同口径：只累加 count，不数条目）。 */
export function aggregateCountsByTypeKey(exportRoot) {
  const counts = new Map()
  forEachCellParts(exportRoot, (p) => {
    const sum = (p.items ?? []).reduce((a, it) => a + (Number(it.count) || 0), 0)
    counts.set(p.typeKey, (counts.get(p.typeKey) ?? 0) + sum)
  })
  return counts
}

/** 部件格数 / 满方块格数（按 cellPartsGrid 统计）。 */
export function exportStats(exportRoot) {
  let cells = 0
  let partCells = 0
  let parts = 0
  const grid = exportRoot.cellPartsGrid
  for (let z = 0; z < (grid?.length ?? 0); z++) {
    for (let r = 0; r < (grid[z]?.length ?? 0); r++) {
      for (let c = 0; c < (grid[z]?.[r]?.length ?? 0); c++) {
        cells++
        const idx = grid[z][r][c]
        if (typeof idx === 'number' && idx > PARTS_GRID_NONE) {
          partCells++
          parts += (exportRoot.partLists?.[idx] ?? []).length
        }
      }
    }
  }
  return { cells, partCells, parts, partLists: (exportRoot.partLists ?? []).length }
}

// ---------------------------------------------------------------------------
// 契约结构校验（静态，独立于 oracle）
// ---------------------------------------------------------------------------

const REQUIRED_PART_FIELDS = ['localId', 'typeKey', 'boxes', 'displayName', 'tooltip', 'items', 'source']
const REQUIRED_SOURCE_FIELDS = ['family', 'fallback', 'boxProvenance', 'tier']

/**
 * 契约 §2/§3/§4/§6 的**结构**判据（不需要 oracle）：五要素齐全、来源四元组齐全且自洽、
 * 盒数值静态合理（允许越界；不允许反向盒/全轴退化盒）、localId 命名空间与族一致。
 * 返回 `{ violations: string[], notes: string[] }`。
 */
export function checkPartStructure(exportRoot) {
  const violations = []
  const notes = []
  const grid = exportRoot.cellPartsGrid
  const lists = exportRoot.partLists
  const cellGrid = exportRoot.cellGrid
  const hasParts = Array.isArray(grid) || Array.isArray(lists)
  if (!hasParts) return { violations, notes }
  if (!Array.isArray(grid) || !Array.isArray(lists)) {
    violations.push('cellPartsGrid/partLists 必须成对出现（契约 §2）')
    return { violations, notes }
  }
  // 形状对齐 cellGrid
  const shape = (g) => [g?.length ?? 0, g?.[0]?.length ?? 0, g?.[0]?.[0]?.length ?? 0].join('x')
  if (Array.isArray(cellGrid) && shape(grid) !== shape(cellGrid)) {
    violations.push(`cellPartsGrid 形状 ${shape(grid)} ≠ cellGrid 形状 ${shape(cellGrid)}（契约 §2 同形同下标）`)
  }
  const familiesSeen = new Set()
  const provenanceSeen = new Set()
  const tiersSeen = new Set()
  let degenerateBoxes = 0
  for (let li = 0; li < lists.length; li++) {
    const list = lists[li]
    if (!Array.isArray(list) || list.length === 0) {
      violations.push(`partLists[${li}] 必须是非空数组（部件池条目；空列表不应入池）`)
      continue
    }
    const ids = new Set()
    for (let pi = 0; pi < list.length; pi++) {
      const p = list[pi]
      const at = `partLists[${li}][${pi}]`
      for (const f of REQUIRED_PART_FIELDS) {
        if (p?.[f] === undefined) violations.push(`${at} 缺五要素字段 ${f}（契约 §3）`)
      }
      if (typeof p.localId !== 'string' || !p.localId.includes(':')) {
        violations.push(`${at} localId 必须为 <族前缀>:<族内定位符>（契约 §4；实际 ${JSON.stringify(p.localId)}）`)
      } else {
        const prefix = p.localId.split(':')[0]
        if (!FAMILIES.includes(prefix)) violations.push(`${at} localId 族前缀非法：${prefix}（契约 §4）`)
        if (ids.has(p.localId)) violations.push(`${at} 同格 localId 重复：${p.localId}（契约 §4）`)
        ids.add(p.localId)
        if (p.source && p.source.family !== prefix) {
          violations.push(`${at} source.family=${p.source?.family} ≠ localId 前缀 ${prefix}（契约 §4）`)
        }
      }
      const src = p.source
      if (src) {
        for (const f of REQUIRED_SOURCE_FIELDS) {
          if (src[f] === undefined) violations.push(`${at} source 缺四元组字段 ${f}（契约 §3）`)
        }
        if (src.family !== undefined && !FAMILIES.includes(src.family)) {
          violations.push(`${at} source.family 非法：${src.family}`)
        }
        if (src.boxProvenance !== undefined && !BOX_PROVENANCE.includes(src.boxProvenance)) {
          violations.push(`${at} source.boxProvenance 非法：${src.boxProvenance}（契约 §6.4）`)
        }
        if (src.tier !== undefined && ![1, 2, 3].includes(src.tier)) {
          violations.push(`${at} source.tier 非法：${src.tier}`)
        }
        if (src.tier !== undefined && src.fallback !== undefined && src.fallback !== (src.tier !== 1)) {
          violations.push(`${at} source.fallback=${src.fallback} 与 tier=${src.tier} 不自洽（档 1 才非兜底）`)
        }
        familiesSeen.add(src.family)
        provenanceSeen.add(src.boxProvenance)
        tiersSeen.add(src.tier)
      }
      if (!Array.isArray(p.boxes) || p.boxes.length === 0) {
        violations.push(`${at} boxes 必须至少 1 个（契约 §3③）`)
      } else {
        for (let bi = 0; bi < p.boxes.length; bi++) {
          const b = p.boxes[bi]
          const bx = `${at}.boxes[${bi}]`
          if (!Array.isArray(b.min) || !Array.isArray(b.max) || b.min.length !== 3 || b.max.length !== 3) {
            violations.push(`${bx} min/max 必须是长度 3 的数组`)
            continue
          }
          for (let a = 0; a < 3; a++) {
            if (!Number.isFinite(b.min[a]) || !Number.isFinite(b.max[a])) {
              violations.push(`${bx} 坐标必须有限数值`)
              break
            }
            if (b.min[a] > b.max[a]) violations.push(`${bx} min[${a}]=${b.min[a]} > max[${a}]=${b.max[a]}（反向盒）`)
          }
          const ext = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]
          if (ext.every((e) => e <= 0)) violations.push(`${bx} 全轴零厚度（退化盒）`)
          else if (ext.some((e) => e <= 0)) degenerateBoxes++
          if (b.kind !== 'visual' && b.kind !== 'collision') {
            violations.push(`${bx} kind 非法：${b.kind}（契约 §6.4 视觉/碰撞）`)
          }
        }
      }
      if (!Array.isArray(p.tooltip) || p.tooltip.length === 0) {
        violations.push(`${at} tooltip 为空（优先级链必须任何情况有话说，契约 §8）`)
      }
      if (typeof p.displayName !== 'string' || p.displayName.length === 0) {
        violations.push(`${at} displayName 为空（契约 §3④ 尊重游戏内显示名）`)
      }
      if (!Array.isArray(p.items)) {
        violations.push(`${at} items 必须是数组（空数组 = 显式"无"，契约 §3⑤）`)
      } else {
        for (let ii = 0; ii < p.items.length; ii++) {
          const it = p.items[ii]
          if (typeof it?.registry !== 'string' || it.registry.length === 0) {
            violations.push(`${at}.items[${ii}] 缺 registry`)
          }
          if (!Number.isInteger(it?.damage)) violations.push(`${at}.items[${ii}] damage 必须整数`)
          if (!Number.isInteger(it?.count) || it.count < 0) violations.push(`${at}.items[${ii}] count 必须非负整数`)
        }
      }
    }
  }
  // 池化（契约 §2.1）：池条数 < 部件格数 ⇒ 去重生效（**不作为违例**，只登记观察）
  const st = exportStats(exportRoot)
  notes.push(
    `部件池 ${st.partLists} 条 / 部件格 ${st.partCells} 个 / 部件实例 ${st.parts} 个；` +
      `族 {${[...familiesSeen].sort().join(',')}} 档位 {${[...tiersSeen].sort().join(',')}} ` +
      `来源 {${[...provenanceSeen].sort().join(',')}}；某轴零厚度盒 ${degenerateBoxes} 个（平面类部件，如实快照）`,
  )
  return { violations, notes }
}

// ---------------------------------------------------------------------------
// oracle ↔ 导出文件逐格核对（L1 语义的独立 Node 复算）
// ---------------------------------------------------------------------------

function findByLocalId(list, localId) {
  return list.find((p) => p?.localId === localId) ?? null
}

/**
 * 逐格核对（口径与 L1 内嵌验证器一致，独立实现）：
 *  - `expectFullCube` ⇒ 该格必须 -1；否则必须 ≥0；
 *  - 哨兵格（oracle 单条 `inferred:*`）⇒ 只断言 条数≥1 / localId 前缀 / typeKey / 族 / 档位；
 *  - 其余格 ⇒ 部件数、逐部件 localId（按 id 匹配，不依赖顺序）/typeKey/items 条数/tier/盒数/来源 精确。
 */
export function verifyCells(oracle, exportRoot) {
  const checks = []
  const push = (ok, msg) => checks.push({ ok, msg })
  const grid = exportRoot.cellPartsGrid
  const lists = exportRoot.partLists
  if (!Array.isArray(grid) || !Array.isArray(lists)) {
    push(false, '导出文件缺 cellPartsGrid/partLists（契约 §2）')
    return checks
  }
  let fullCubeCells = 0
  let partCells = 0
  let wildcardCells = 0
  for (const cell of oracle.cells ?? []) {
    const [zi, ri, ci] = cell.grid ?? []
    const at = `${JSON.stringify(cell.pos)}(${cell.zone})`
    const idx = gridValue(grid, zi, ri, ci)
    if (cell.expectFullCube) {
      fullCubeCells++
      push(idx === PARTS_GRID_NONE, `${at} 满方块格 cellPartsGrid 应为 -1（实际 ${idx}）`)
      continue
    }
    partCells++
    push(idx >= 0, `${at} 部件格应有 partLists 下标（实际 ${idx}）`)
    if (idx < 0 || idx >= lists.length) continue
    const actual = lists[idx] ?? []
    const expected = cell.parts ?? []
    const wildcard =
      expected.length === 1 && expected[0].localId === LOCAL_ID_INFERRED_WILDCARD
    if (wildcard) {
      wildcardCells++
      const exp = expected[0]
      push(actual.length >= 1, `${at} 退化档 3 应至少 1 个 inferred 部件（实际 ${actual.length}）`)
      for (let i = 0; i < actual.length; i++) {
        const p = actual[i]
        push(
          String(p.localId).startsWith('inferred:'),
          `${at} part${i} localId 应为 inferred:*（实际 ${p.localId}）`,
        )
        push(p.typeKey === exp.typeKey, `${at} part${i} typeKey 应为 ${exp.typeKey}（实际 ${p.typeKey}）`)
        push(p.source?.family === 'inferred', `${at} part${i} source.family 应为 inferred（实际 ${p.source?.family}）`)
        push(p.source?.tier === 3, `${at} part${i} source.tier 应为 3（实际 ${p.source?.tier}）`)
        push(p.source?.fallback === true, `${at} part${i} source.fallback 应为 true`)
      }
      continue
    }
    push(actual.length === expected.length, `${at} 部件数应为 ${expected.length}（实际 ${actual.length}）`)
    for (const exp of expected) {
      const act = findByLocalId(actual, exp.localId)
      push(act !== null, `${at} 缺部件 ${exp.localId}`)
      if (!act) continue
      const what = `${at} ${exp.localId}`
      push(act.typeKey === exp.typeKey, `${what} typeKey 应为 ${exp.typeKey}（实际 ${act.typeKey}）`)
      const itemEntries = Array.isArray(act.items) ? act.items.length : -1
      push(itemEntries === exp.itemCount, `${what} items 条数应为 ${exp.itemCount}（实际 ${itemEntries}）`)
      const prefix = String(exp.localId).split(':')[0]
      push(
        act.source?.family === prefix,
        `${what} source.family 应为 ${prefix}（实际 ${act.source?.family}）`,
      )
      push(act.source?.tier === exp.boxTier, `${what} source.tier 应为 ${exp.boxTier}（实际 ${act.source?.tier}）`)
      push(
        act.source?.fallback === (exp.boxTier !== 1),
        `${what} source.fallback 应为 ${exp.boxTier !== 1}（实际 ${act.source?.fallback}）`,
      )
      if (exp.boxCount !== BOXCOUNT_UNCHECKED) {
        const boxes = Array.isArray(act.boxes) ? act.boxes.length : -1
        push(boxes === exp.boxCount, `${what} 盒数应为 ${exp.boxCount}（实际 ${boxes}）`)
      }
      if (exp.boxProvenance !== PROVENANCE_UNCHECKED) {
        push(
          act.source?.boxProvenance === exp.boxProvenance,
          `${what} boxProvenance 应为 ${exp.boxProvenance}（实际 ${act.source?.boxProvenance}）`,
        )
      }
    }
  }
  return Object.assign(checks, { fullCubeCells, partCells, wildcardCells })
}

/**
 * `expectedCounts` 比对。
 *  - `exact`：双向精确（多算/漏算都报）；
 *  - `subset`：契约 §11 退化轮口径（`countsScope=untransformed-cells-only`）——
 *    只要求在册条目在导出聚合里**精确相等**（非在册键不判）。
 */
export function verifyExpectedCounts(oracle, exportRoot, mode = 'auto') {
  const counts = aggregateCountsByTypeKey(exportRoot)
  const m = mode === 'auto' ? (oracle.countsScope === 'untransformed-cells-only' ? 'subset' : 'exact') : mode
  const checks = []
  const push = (ok, msg) => checks.push({ ok, msg })
  const expected = new Map((oracle.expectedCounts ?? []).map((e) => [e.typeKey, e.count]))
  for (const [key, want] of expected) {
    const got = counts.get(key) ?? 0
    push(got === want, `expectedCounts[${key}] 应为 ${want}（实际 ${got}）`)
  }
  if (m === 'exact') {
    for (const [key, got] of counts) {
      if (!expected.has(key)) push(false, `expectedCounts 未登记但导出出现：${key}=${got}（多算）`)
    }
  }
  return Object.assign(checks, { mode: m, entries: expected.size, keysInExport: counts.size })
}

/** 池化证据（契约 §2.1）：同内容多格共享同一下标（按 oracle 指定的同构格对）。 */
export function verifyDedup(oracle, exportRoot, pairs) {
  const checks = []
  const push = (ok, msg) => checks.push({ ok, msg })
  const grid = exportRoot.cellPartsGrid
  for (const [a, b] of pairs) {
    const ia = gridValue(grid, ...a)
    const ib = gridValue(grid, ...b)
    push(ia >= 0 && ia === ib, `同构格 ${JSON.stringify(a)} 与 ${JSON.stringify(b)} 应共享 partLists 下标（实际 ${ia} / ${ib}）`)
  }
  const st = exportStats(exportRoot)
  push(
    st.partLists <= st.partCells,
    `partLists 池条数（${st.partLists}）应 ≤ 部件格数（${st.partCells}）：去重全局生效`,
  )
  return checks
}

// ---------------------------------------------------------------------------
// 物品索引表（契约 §2.2）—— oracle ↔ 导出文件核对（#39 阶段一扩展）
// ---------------------------------------------------------------------------

/** 归属条目身份（与 web `pure/itemIndex.ts#normalizeHits` 同一口径）。 */
function attrKey(a) {
  return `${a?.source}|${a?.frame}|${a?.grid?.[0]},${a?.grid?.[1]},${a?.grid?.[2]}|${a?.localId ?? ''}`
}

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v)
}

/** oracle 里带哨兵的格（退化档 3 岛序号/盒数不可静态预测）—— 退化轮允许的多出归属只能落在这些格上。 */
function sentinelGrids(oracle) {
  const out = new Set()
  for (const cell of oracle?.cells ?? []) {
    const [zi, ri, ci] = cell.grid ?? []
    const parts = cell.parts ?? []
    const wild =
      (parts.length === 1 && parts[0]?.localId === LOCAL_ID_INFERRED_WILDCARD) ||
      parts.some((p) => p?.boxCount === BOXCOUNT_UNCHECKED)
    if (wild) out.add(`${zi},${ri},${ci}`)
  }
  return out
}

/**
 * 物品索引表核对（契约 §2.2 硬约束 + oracle 逐键期望）。
 *
 * 判据分两层：
 *  A. **文件自洽**（独立于 oracle）：条目形状、`source` = 首条归属来源（空数组 ⇒ `none`）、
 *     说明行非空（空值语义：至少 display 一行）、归属按来源权威度分组（part → host → family）
 *     且 `(source,frame,grid,localId)` 不重复、`display` 非空；
 *  B. **oracle 逐键比对**：键集（exact 双向 / 退化轮只要求在册键必在）、`display`（
 *     `displayChecked:false` ⇒ 只断言非空）、`source`、归属条目（逐条匹配；
 *     `localId:"inferred:*"` = 通配，要求该格至少一条 inferred 归属）。退化轮允许实际多出的
 *     归属，但**只能落在 oracle 的哨兵格上**（其余位置多出 = 归属指向了错误格，判红）。
 */
export function verifyItemIndex(oracle, exportRoot) {
  const checks = []
  const push = (ok, msg) => checks.push({ ok, msg })
  const expected = oracle?.[ITEM_INDEX_FIELD]
  const actual = exportRoot?.[ITEM_INDEX_FIELD]
  const scope = oracle?.itemIndexScope ?? ITEM_INDEX_SCOPE_EXACT
  const subset = scope === ITEM_INDEX_SCOPE_UNTRANSFORMED

  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    push(false, `oracle 缺 ${ITEM_INDEX_FIELD} 期望（契约 §2.2 扩展；#39 阶段一）`)
    return Object.assign(checks, { expectedKeys: 0, actualKeys: 0, attrsChecked: 0, scope })
  }
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    push(false, `导出文件缺 ${ITEM_INDEX_FIELD}（含部件文档必须落盘，契约 §2.2）`)
    return Object.assign(checks, { expectedKeys: Object.keys(expected).length, actualKeys: 0, attrsChecked: 0, scope })
  }

  const expectedKeys = Object.keys(expected).sort()
  const actualKeys = Object.keys(actual).sort()
  const missing = expectedKeys.filter((k) => !(k in actual))
  push(missing.length === 0, `itemIndex 缺期望键：${missing.join(', ')}`)
  const extra = actualKeys.filter((k) => !(k in expected))
  if (subset) {
    if (extra.length > 0) checks.push({ ok: true, msg: `note: 退化轮 itemIndex 多出未登记键 ${extra.join(', ')}（变换格产出，口径同 countsScope）` })
  } else {
    push(extra.length === 0, `itemIndex 多出未登记键：${extra.join(', ')}`)
  }

  let attrsChecked = 0
  let wildcardChecked = 0
  const sentinels = sentinelGrids(oracle)

  // ── A. 文件自洽（对实际出现的每个键）───────────────────────────────────
  for (const key of actualKeys) {
    const e = actual[key]
    const at = `itemIndex[${key}]`
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      push(false, `${at} 必须是对象`)
      continue
    }
    push(typeof e.display === 'string' && e.display.length > 0, `${at} display 必须为非空字符串（缺省兜底 = 键本身）`)
    push(
      Array.isArray(e.tooltip) && e.tooltip.length > 0 && e.tooltip.every((l) => typeof l === 'string'),
      `${at} tooltip 必须为非空字符串数组（空值语义：至少 display 一行）`,
    )
    const attrs = Array.isArray(e.attribution) ? e.attribution : null
    if (attrs === null) {
      push(false, `${at} attribution 必须是数组（空数组 = 显式"无对应"）`)
      continue
    }
    const wantSource = attrs.length === 0 ? 'none' : attrs[0]?.source
    push(
      e.source === wantSource,
      `${at} source 必须 = attribution 首条来源（空数组 ⇒ none；期望 ${wantSource}，实际 ${e.source}）`,
    )
    let prevRank = -1
    let orderOk = true
    const seen = new Set()
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i]
      const aat = `${at}.attribution[${i}]`
      if (!ATTRIBUTION_SOURCES.includes(a?.source)) push(false, `${aat} source 非法：${a?.source}`)
      if (!isInt(a?.frame) || a.frame < 0) push(false, `${aat} frame 必须为非负整数（实际 ${a?.frame}）`)
      if (!Array.isArray(a?.grid) || a.grid.length !== 3 || !a.grid.every(isInt)) {
        push(false, `${aat} grid 必须是长度 3 的整数数组（[zSlice,row,column]）`)
      }
      if (a?.source === 'part' && (typeof a.localId !== 'string' || a.localId.length === 0)) {
        push(false, `${aat} source=part 必须带 localId（部件级定位）`)
      }
      const rank = SOURCE_RANK[a?.source]
      if (rank !== undefined) {
        if (rank < prevRank) orderOk = false
        prevRank = Math.max(prevRank, rank)
      }
      const id = attrKey(a)
      if (seen.has(id)) push(false, `${aat} 归属重复（${id}）`)
      seen.add(id)
    }
    push(orderOk, `${at} attribution 必须按来源权威度分组（part → host → family）`)
  }

  // ── B. oracle 逐键比对 ────────────────────────────────────────────────
  for (const key of expectedKeys) {
    const exp = expected[key]
    const act = actual[key]
    const at = `itemIndex[${key}]`
    if (!act) continue
    if (exp.displayChecked !== false) {
      push(act.display === exp.display, `${at} display 应为 ${JSON.stringify(exp.display)}（实际 ${JSON.stringify(act.display)}）`)
    }
    push(exp.tooltipNonEmpty === false || (Array.isArray(act.tooltip) && act.tooltip.length > 0), `${at} 说明行必须非空`)
    push(act.source === exp.source, `${at} source 应为 ${exp.source}（实际 ${act.source}）`)
    const attrs = Array.isArray(act.attribution) ? act.attribution : []
    const used = new Array(attrs.length).fill(false)
    for (const want of exp.attribution ?? []) {
      attrsChecked++
      if (want.localId === LOCAL_ID_INFERRED_WILDCARD) {
        wildcardChecked++
        const hit = attrs.some(
          (a, i) =>
            a?.source === want.source &&
            a?.frame === want.frame &&
            a?.grid?.[0] === want.grid[0] &&
            a?.grid?.[1] === want.grid[1] &&
            a?.grid?.[2] === want.grid[2] &&
            String(a?.localId ?? '').startsWith('inferred:'),
        )
        push(hit, `${at} 期望格 [${want.grid}] 至少一条 inferred:* 的 ${want.source} 归属（退化档岛序号不可预测）`)
        continue
      }
      const idx = attrs.findIndex(
        (a, i) => !used[i] && a?.source === want.source && a?.frame === want.frame && a?.grid?.[0] === want.grid[0] && a?.grid?.[1] === want.grid[1] && a?.grid?.[2] === want.grid[2] && (a?.localId ?? null) === (want.localId ?? null),
      )
      if (idx < 0) {
        push(false, `${at} 缺期望归属 ${JSON.stringify(want)}`)
      } else {
        used[idx] = true
        push(true, `${at} 归属 ${JSON.stringify(want)}`)
      }
    }
    // 未匹配的实际归属：exact 轮一律判红；退化轮只允许落在 oracle 哨兵格
    for (let i = 0; i < attrs.length; i++) {
      if (used[i]) continue
      const a = attrs[i]
      const g = `${a?.grid?.[0]},${a?.grid?.[1]},${a?.grid?.[2]}`
      if (subset && sentinels.has(g)) {
        checks.push({ ok: true, msg: `note: ${at} 多出变换格归属 ${attrKey(a)}（退化轮口径放行）` })
      } else {
        push(false, `${at} 多出未登记归属 ${attrKey(a)}`)
      }
    }
  }

  return Object.assign(checks, {
    expectedKeys: expectedKeys.length,
    actualKeys: actualKeys.length,
    attrsChecked,
    wildcardChecked,
    scope,
  })
}

/**
 * `blockPalette[].hostItem`（契约 §2.2 层②）核对。
 *
 * 口径（oracle `hostItems`）：
 *  - `expect[<宿主 registry:meta>]`：**字面值**必须精确（registry + damage）；
 *  - `absent[]`：无物品形态的宿主 ⇒ 字段必须缺席（不猜）；
 *  - `derive[]`：字面值静态不可推导（宿主方块的 ItemBlock 注册名需运行时查表）⇒
 *    只断言"若在则 damage = 该条目 meta 且 registry 非空"，并把实际观测登记进 note，
 *    **不硬编码猜测值**（阶段二在游戏内产出实测字面值后改列 `expect`）；
 *  - 未登记宿主 ⇒ 判红（新增宿主必须补 oracle）。
 *  - 恒定口径：任何 `hostItem` 的 `damage` 必须等于其所在调色板条目的 `meta`。
 */
export function verifyHostItems(oracle, exportRoot) {
  const checks = []
  const push = (ok, msg) => checks.push({ ok, msg })
  const spec = oracle?.hostItems
  const palette = exportRoot?.blockPalette
  if (!spec || typeof spec !== 'object') {
    push(false, 'oracle 缺 hostItems 期望（契约 §2.2 层② 扩展；#39 阶段一）')
    return Object.assign(checks, { paletteEntries: 0, withHostItem: 0, derived: 0 })
  }
  if (!Array.isArray(palette)) {
    push(false, '导出文件缺 blockPalette（契约 §2）')
    return Object.assign(checks, { paletteEntries: 0, withHostItem: 0, derived: 0 })
  }
  const expect = spec.expect ?? {}
  const absent = new Set(spec.absent ?? [])
  const derive = new Set(spec.derive ?? [])
  let entries = 0
  let withHostItem = 0
  let derived = 0
  const observedDerive = []
  for (let i = 0; i < palette.length; i++) {
    const e = palette[i]
    if (!e || typeof e !== 'object') continue
    const registryId = String(e.registryId ?? '')
    if (registryId === '' || registryId === 'air' || registryId === 'minecraft:air') continue
    entries++
    const key = `${registryId}:${e.meta}`
    const hostItem = e[HOST_ITEM_FIELD]
    if (hostItem !== undefined) withHostItem++
    if (hostItem !== undefined && spec.damageEqualsMeta !== false) {
      push(hostItem?.damage === e.meta, `blockPalette[${i}] hostItem.damage=${hostItem?.damage} 必须 = 条目 meta=${e.meta}（契约 §2.2 层②）`)
    }
    if (key in expect) {
      const want = expect[key]
      push(hostItem !== undefined, `blockPalette[${i}] 宿主 ${key} 必须带 hostItem（契约 §2.2 层②）`)
      if (hostItem !== undefined) {
        push(hostItem?.registry === want.registry, `blockPalette[${i}] 宿主 ${key} hostItem.registry 应为 ${want.registry}（实际 ${hostItem?.registry}）`)
        push(hostItem?.damage === want.damage, `blockPalette[${i}] 宿主 ${key} hostItem.damage 应为 ${want.damage}（实际 ${hostItem?.damage}）`)
      }
    } else if (absent.has(key)) {
      push(hostItem === undefined, `blockPalette[${i}] 宿主 ${key} 无物品形态 ⇒ hostItem 必须缺席（不猜）`)
    } else if (derive.has(key)) {
      derived++
      if (hostItem !== undefined) {
        push(typeof hostItem.registry === 'string' && hostItem.registry.length > 0, `blockPalette[${i}] 宿主 ${key} hostItem.registry 必须为非空字符串`)
        observedDerive.push(`${key}→${hostItem.registry}:${hostItem.damage}`)
      } else {
        observedDerive.push(`${key}→<缺席>`)
      }
    } else {
      push(false, `blockPalette[${i}] 宿主 ${key} 未在 oracle hostItems（expect/absent/derive）登记`)
    }
  }
  if (observedDerive.length > 0) {
    checks.push({ ok: true, msg: `note: 待阶段二落字面值的宿主实测观测：${observedDerive.join(', ')}` })
  }
  return Object.assign(checks, { paletteEntries: entries, withHostItem, derived })
}

export function summarizeChecks(checks) {
  const failed = checks.filter((c) => !c.ok)
  return { total: checks.length, failed: failed.length, failedChecks: failed.map((c) => c.msg) }
}
