/**
 * P3.1 · L2 断言包 —— **真实导出产物**（P1.8 建造器产物）的读入、格定位与悬停探针推导。
 *
 * 与 `fixtures.ts` 的分工：
 *  - `fixtures.ts`：手工 fixture（P0.4 交付，几何从简）的读取/变形/几何增强；
 *  - 本文件：**真实产物**（`scripts/parts-acceptance/.out/<label>/sde_parts_acceptance_export_*.json`
 *    + canonical oracle `scripts/parts-acceptance/oracle/`）。真实产物的几何/坐标/部件清单
 *    与 fixture 完全不同（15×2×13 世界、36 格意图、26 个 partLists 池），因此**期望值与探针点
 *    都从产物 + oracle 派生**，不硬编码。
 *
 * ## 反同义反复（anti-tautology）的边界 —— 必须说清楚
 *
 * 真实产物路径下期望值来自产物/oracle 文件（不可能把 36 格 598 项断言硬编码进 spec），
 * 但断言目标是：
 *   > **web 解析/渲染/悬停/统计忠实呈现文件内容**，且**悬停命中的部件身份必须等于文件里
 *   > 该格该部件自己的身份**（tooltip 文本必须含该部件 displayName，与同格其它部件区分开）。
 * 另外三条独立交叉自检保证"从产物派生期望值"本身不是恒绿：
 *  1. `PARTS_ACCEPTANCE_EXPECT_COUNTS_TOTAL`：spec 内硬编码 oracle `expectedCounts` 的
 *     **条目数与总件数**（21 条 / 57 件，来自 P1.8 release 归档实测），派生出的行集必须与之吻合；
 *  2. 悬停用例先断言**同格两个部件得到两个不同的 tooltip**，再断言各自等于自己的 displayName；
 *  3. 真实产物 vs oracle 的逐格一致性由 mod 半环（L1 内嵌验证器）与本编排的
 *     `verify-oracle.mjs`（脚本侧独立实现）**双实现**各自断言 —— L2 不重复它，只消费它。
 *
 * ## 产物缺失 = 显式失败（沿用多方块轮 T3.1 语义）
 *
 * 目录由环境变量 `PARTS_ACCEPTANCE_DIR` 指定；未设置时回退到**最近一次**含全套产物的
 * `scripts/parts-acceptance/.out/<label>[-rN]/`。两者都不可用 ⇒ 抛错并给出生成命令，
 * **绝不静默跳过**（静默跳过会让 L2 在干净检出上退化成空跑）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@playwright/test'
import { pollUntil } from '../multiblock'
import {
  clearWikiHover,
  injectHoverAtCellLocal,
  readWikiHover,
  readTooltipText,
  type CellLocalPoint,
  type WikiHoverObservation,
} from './hover'

/** `web/` 的上两级 = 仓库根（本文件位于 `web/e2e/helpers/parts/`）。 */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')

/** 产物目录的环境变量名（编排脚本 `run-parts-acceptance.ps1` 用 L2 阶段注入）。 */
export const PARTS_ACCEPTANCE_DIR_ENV = 'PARTS_ACCEPTANCE_DIR'

/** 缺省归档根（相对仓库根）。 */
export const PARTS_ARCHIVE_ROOT_REL = path.join('scripts', 'parts-acceptance', '.out')

/** canonical oracle 目录（相对仓库根；留白 #9 拍板）。 */
export const PARTS_CANONICAL_ORACLE_REL = path.join('scripts', 'parts-acceptance', 'oracle')

/** 真实产物文件名（P1.8 命名约定）。 */
export const REAL_EXPORT_FILES = {
  full: 'sde_parts_acceptance_export_full_a.json',
  fullB: 'sde_parts_acceptance_export_full_b.json',
  fullcubeOnly: 'sde_parts_acceptance_export_fullcube_only.json',
  degradedAe2: 'sde_parts_acceptance_export_degraded_ae2.json',
  degradedAll: 'sde_parts_acceptance_export_degraded_all.json',
  result: 'sde_parts_acceptance_result.json',
} as const

export const CANONICAL_ORACLE_FILES = {
  full: 'sde_parts_acceptance_oracle_full.json',
  degradedAe2: 'sde_parts_acceptance_oracle_degraded_ae2.json',
  degradedAll: 'sde_parts_acceptance_oracle_degraded_all.json',
} as const

/** 产物缺失时给出的确切生成命令（不是"跳过"）。 */
export const REAL_EXPORT_COMMAND = 'npm run acceptance:parts   # 仓库根（mod 半环：建造 → 导出 → oracle）'

// ---------------------------------------------------------------------------
// 归档目录解析
// ---------------------------------------------------------------------------

export interface PartsArchive {
  dir: string
  source: 'env' | 'default'
  envValue: string | null
  candidates: string[]
  /** 归档里实际存在的产物文件（相对文件名）。 */
  files: string[]
}

function hasFullExport(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, REAL_EXPORT_FILES.full)).isFile()
  } catch {
    return false
  }
}

/** 最近修改的 `.out/<label>` 归档目录（含全套产物者）。 */
function latestDefaultArchive(): string | null {
  const root = path.join(REPO_ROOT, PARTS_ARCHIVE_ROOT_REL)
  let entries: string[]
  try {
    entries = fs.readdirSync(root)
  } catch {
    return null
  }
  const hits = entries
    .map((e) => path.join(root, e))
    .filter((p) => {
      try {
        return fs.statSync(p).isDirectory() && hasFullExport(p)
      } catch {
        return false
      }
    })
    .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return hits.length > 0 ? hits[0]!.p : null
}

/**
 * 解析产物目录。**不抛错**（供诊断用例/报告使用）；正常路径用 `resolvePartsArchive()`。
 * 相对路径的解析顺序：① 仓库根；② 进程 CWD。
 */
export function resolvePartsArchiveInfo(): PartsArchive {
  const envValue = (process.env[PARTS_ACCEPTANCE_DIR_ENV] ?? '').trim()
  const candidates: string[] = []
  if (envValue.length > 0) {
    candidates.push(path.isAbsolute(envValue) ? envValue : path.resolve(REPO_ROOT, envValue))
    if (!path.isAbsolute(envValue)) {
      const fromCwd = path.resolve(process.cwd(), envValue)
      if (!candidates.includes(fromCwd)) candidates.push(fromCwd)
    }
  } else {
    const latest = latestDefaultArchive()
    candidates.push(latest ?? path.join(REPO_ROOT, PARTS_ARCHIVE_ROOT_REL, '<无归档>'))
  }
  for (const c of candidates) {
    if (hasFullExport(c)) {
      return {
        dir: c,
        source: envValue.length > 0 ? 'env' : 'default',
        envValue: envValue || null,
        candidates,
        files: fs.readdirSync(c).filter((f) => f.endsWith('.json')).sort(),
      }
    }
  }
  return {
    dir: candidates[0]!,
    source: envValue.length > 0 ? 'env' : 'default',
    envValue: envValue || null,
    candidates,
    files: [],
  }
}

/** 取产物目录；**缺产物即显式失败**（验收管线语义：不静默跳过）。 */
export function resolvePartsArchive(): PartsArchive {
  const info = resolvePartsArchiveInfo()
  if (hasFullExport(info.dir)) return info
  const checked = info.candidates
    .map((c) => `    - ${c}${fs.existsSync(c) ? '（存在，但没有 ' + REAL_EXPORT_FILES.full + '）' : '（不存在）'}`)
    .join('\n')
  throw new Error(
    `P3.1：真实导出产物目录不可用 —— 找不到 ${REAL_EXPORT_FILES.full}。\n` +
      `  环境变量 ${PARTS_ACCEPTANCE_DIR_ENV} = ${info.envValue === null ? '<未设置>' : JSON.stringify(info.envValue)}（来源：${info.source}）\n` +
      `  已检查的候选路径：\n${checked}\n` +
      `  验收管线语义：**产物缺失必须显式失败，不得静默跳过**。\n` +
      `  生成产物：${REAL_EXPORT_COMMAND}`,
  )
}

/** 读归档里的 JSON 产物（缺失即显式失败）。 */
export function loadArchiveJson(dir: string, relName: string): Record<string, unknown> {
  const p = path.join(dir, relName)
  if (!fs.existsSync(p)) {
    throw new Error(`P3.1：产物缺失 ${p}（归档目录 ${dir}）—— 显式失败，不静默跳过。生成：${REAL_EXPORT_COMMAND}`)
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
}

/**
 * canonical oracle 路径（留白 #9：`scripts/parts-acceptance/oracle/`）。
 * 归档目录里也有 oracle 副本；canonical 优先（它才是「被 L1 逐轮刷新」的权威），
 * 缺失时回退归档副本。
 */
export function resolveOraclePath(dir: string, kind: keyof typeof CANONICAL_ORACLE_FILES): {
  path: string
  source: 'canonical' | 'archive'
} {
  const canonical = path.join(REPO_ROOT, PARTS_CANONICAL_ORACLE_REL, CANONICAL_ORACLE_FILES[kind])
  if (fs.existsSync(canonical)) return { path: canonical, source: 'canonical' }
  const archived = path.join(dir, CANONICAL_ORACLE_FILES[kind])
  if (fs.existsSync(archived)) return { path: archived, source: 'archive' }
  throw new Error(
    `P3.1：oracle 缺失（canonical=${canonical} / archive=${archived}）—— 显式失败。生成：${REAL_EXPORT_COMMAND}`,
  )
}

// ---------------------------------------------------------------------------
// 真实产物形态（契约 §2/§3/§11）
// ---------------------------------------------------------------------------

export interface RealPartBox {
  min: [number, number, number]
  max: [number, number, number]
  kind: 'visual' | 'collision' | string
}

export interface RealPart {
  localId: string
  typeKey: string
  boxes: RealPartBox[]
  displayName: string
  tooltip: string[]
  items: Array<{ registry: string; damage: number; count: number; nbtDiscriminator?: string; display?: string }>
  source: { family: string; fallback: boolean; boxProvenance: string; tier: number }
  properties?: Record<string, string>
}

export interface RealExportDoc {
  /** 原始 JSON（可直接注入：生产拖放路径接受 V2 plain / baked 结构）。 */
  raw: Record<string, unknown>
  cellGrid: number[][][]
  cellPartsGrid: (number | null)[][][] | null
  partLists: RealPart[][] | null
  blockPalette: unknown[]
  statsTemplate: unknown
  partIconTextures: Record<string, string> | null
  dims: { w: number; h: number; d: number }
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** 解析真实导出文件的部件结构（**只读**；不修文件、不补字段）。 */
export function parseRealExport(raw: Record<string, unknown>): RealExportDoc {
  const cellGrid = asArray(raw.cellGrid) as number[][][]
  const d = cellGrid.length
  const h = d > 0 ? (cellGrid[0]?.length ?? 0) : 0
  const w = h > 0 ? (cellGrid[0]?.[0]?.length ?? 0) : 0
  const cellPartsGridRaw = raw.cellPartsGrid
  const partListsRaw = raw.partLists
  return {
    raw,
    cellGrid,
    cellPartsGrid: Array.isArray(cellPartsGridRaw) ? (cellPartsGridRaw as (number | null)[][][]) : null,
    partLists: Array.isArray(partListsRaw) ? (partListsRaw as RealPart[][]) : null,
    blockPalette: asArray(raw.blockPalette),
    statsTemplate: raw.statsTemplate ?? null,
    partIconTextures:
      raw.partIconTextures && typeof raw.partIconTextures === 'object'
        ? (raw.partIconTextures as Record<string, string>)
        : null,
    dims: { w, h, d },
  }
}

/** 某格的部件清单（`cellPartsGrid[z][row][col]` → `partLists[idx]`；-1/越界 ⇒ `[]`）。 */
export function partsAtGrid(doc: RealExportDoc, grid: GridIndex): RealPart[] {
  const idx = doc.cellPartsGrid?.[grid.z]?.[grid.row]?.[grid.col]
  if (typeof idx !== 'number' || idx < 0) return []
  return doc.partLists?.[idx] ?? []
}

// ---------------------------------------------------------------------------
// oracle（契约 §11：ground truth）
// ---------------------------------------------------------------------------

export interface OraclePartExpectation {
  localId: string
  typeKey: string
  itemCount: number
  boxTier: number
  boxCount: number
  boxProvenance: string
}

export interface OracleCell {
  pos: [number, number, number]
  zone: string
  /** `[zi, ri, ci]`（契约 §11 格映射通道；`cellPartsGrid` 下标）。 */
  grid: [number, number, number]
  host: string
  expectFullCube: boolean
  parts: OraclePartExpectation[]
}

export interface OracleDoc {
  schema: string
  structure: string
  zones: string[]
  gridIndex: { origin: [number, number, number]; size: [number, number, number]; rowAxis: string }
  cells: OracleCell[]
  countsScope: string
  expectedCounts: Array<{ typeKey: string; display: string; count: number }>
  raw: Record<string, unknown>
}

export function parseOracle(raw: Record<string, unknown>): OracleDoc {
  const gridIndex = (raw.gridIndex ?? {}) as OracleDoc['gridIndex']
  return {
    schema: String(raw.schema ?? ''),
    structure: String(raw.structure ?? ''),
    zones: asArray(raw.zones).map(String),
    gridIndex: {
      origin: (gridIndex.origin ?? [0, 0, 0]) as [number, number, number],
      size: (gridIndex.size ?? [0, 0, 0]) as [number, number, number],
      rowAxis: String(gridIndex.rowAxis ?? ''),
    },
    cells: asArray(raw.cells) as OracleCell[],
    countsScope: String(raw.countsScope ?? 'all'),
    expectedCounts: asArray(raw.expectedCounts) as OracleDoc['expectedCounts'],
    raw,
  }
}

/** `[zi, ri, ci]` → 投影注入用的格下标（`injectHoverAtCellLocal` 的 `CellLocalPoint` 字段）。 */
export interface GridIndex {
  z: number
  row: number
  col: number
}

/** 读 oracle（canonical 优先，归档回退）；缺失即显式失败。 */
export function loadOracle(
  archiveDir: string,
  kind: keyof typeof CANONICAL_ORACLE_FILES,
): { oracle: OracleDoc; path: string; source: 'canonical' | 'archive' } {
  const r = resolveOraclePath(archiveDir, kind)
  return {
    oracle: parseOracle(JSON.parse(fs.readFileSync(r.path, 'utf8')) as Record<string, unknown>),
    path: r.path,
    source: r.source,
  }
}

// ---------------------------------------------------------------------------
// 文档根字段在"落盘 → 运行时定义"链上的存活观测（P3.1 偏差锁）
// ---------------------------------------------------------------------------

export interface DefinitionRootFieldsObservation {
  /** 运行时 `StructureDefinition` 是否带 `statsTemplate`（文档默认统计层，契约 §9）。 */
  hasStatsTemplate: boolean
  statsTemplate: unknown
  /** 运行时定义是否带 `statsOverride`（文档覆盖层，契约 §9）。 */
  hasStatsOverride: boolean
  /** 运行时定义是否带 `partIconTextures`（部件物品图标纹理，契约 §2）。 */
  hasPartIconTextures: boolean
  partIconTextureKeys: number
}

/**
 * 读**渲染定义根**上的文档级字段存活情况（`ctx.viewports.get(rid).definition.value`）。
 *
 * 用途：真实导出是 `geometryPhase=baked` 的 StructureData，走 `StructureDataParser`；
 * fixture 是 V2Plain（`format_version` + `frames`），走 `V2PlainParser`（未知根字段进 `_extra`
 * 兜底）。两条解析链对文档根字段的处置不同 ⇒ 必须实测，不能假设。
 */
export async function readDefinitionRootFields(
  page: Page,
  region: string,
): Promise<DefinitionRootFieldsObservation> {
  return await page.evaluate((rid) => {
    const def = (window as any).__vm__?.viewports?.get(rid)?.definition?.value ?? null
    const st = def ? (def as Record<string, unknown>).statsTemplate : undefined
    const so = def ? (def as Record<string, unknown>).statsOverride : undefined
    const pit = def ? (def as Record<string, unknown>).partIconTextures : undefined
    return {
      hasStatsTemplate: st !== undefined && st !== null,
      statsTemplate: st ?? null,
      hasStatsOverride: so !== undefined && so !== null,
      hasPartIconTextures: pit !== undefined && pit !== null && typeof pit === 'object',
      partIconTextureKeys:
        pit && typeof pit === 'object' ? Object.keys(pit as Record<string, unknown>).length : 0,
    }
  }, region)
}

export function gridIndexOf(oracleCell: OracleCell): GridIndex {
  const [z, row, col] = oracleCell.grid
  return { z, row, col }
}

/**
 * oracle 格 → **Grid API 坐标**（`Grid.partsAt({x,y,z})` 的 Y-up 空间）。
 *
 * 两套下标必须分清楚（P3.1 实测擒获）：
 *  - oracle `grid:[zi,ri,ci]` + `gridIndex.rowAxis='y-top-first'` ⇒ `row` 是**自上而下**的行号；
 *  - `Grid`/`readPartsObservation` 的 `pos.y` 是 **Y-up**（y=0 = 结构底部），
 *    且 x=列、z=切片 ⇒ `y = height - 1 - row`。
 *
 * 导出文件的 `cellPartsGrid[z][row][col]` 用的是 oracle 那一套（row 同为 top-first），
 * 所以文件侧直接用 `gridIndexOf()`，页面侧必须过本函数。
 */
export function gridApiPosOf(
  oracleCell: OracleCell,
  gridIndexSize: [number, number, number],
): { x: number; y: number; z: number } {
  const [z, row, col] = oracleCell.grid
  const h = gridIndexSize[1]
  return { x: col, y: h - 1 - row, z }
}

/** 取某分区的格（按 oracle 顺序稳定）。 */
export function cellsOfZone(oracle: OracleDoc, zone: string): OracleCell[] {
  return oracle.cells.filter((c) => c.zone === zone)
}

// ---------------------------------------------------------------------------
// 探针点推导（真实几何 + oracle 格定位）
// ---------------------------------------------------------------------------

const EPS = 1e-3

/**
 * 为一个部件盒生成候选探针点（格内局部坐标）。
 *
 * 为什么需要"候选"而不是一个点：悬停是**真实 raycast**（射线命中宿主格几何 → 命中点换算
 * 格内坐标 → 部件盒判定）。真实导出的几何由 mod 捕获链产出，某个盒的某个面在导出几何里
 * 未必有对应三角形，且同格多部件的盒互相重叠（命中点可能落进邻部件的盒）。因此按
 * 「盒面中心 → 面中心内缩 → 盒内 3×3×3 采样」的顺序给候选，调用方按序试到命中目标部件为止。
 *
 * `cameraHint` = 相机位置（世界坐标）与该格中心（世界坐标）之差；候选按「面法线与
 * `-cameraDir` 对齐程度」排序，让面向相机的面先试（减少无效探测）。
 */
export function probeCandidatesForPart(
  part: RealPart,
  opts?: { cameraDir?: [number, number, number] | null; visualOnly?: boolean },
): CellLocalPoint[] {
  const visualOnly = opts?.visualOnly ?? true
  const boxes = part.boxes.filter((b) => (visualOnly ? b.kind === 'visual' : true))
  const use = boxes.length > 0 ? boxes : part.boxes
  const out: CellLocalPoint[] = []
  const seen = new Set<string>()
  const push = (lx: number, ly: number, lz: number) => {
    const k = `${lx.toFixed(4)},${ly.toFixed(4)},${lz.toFixed(4)}`
    if (seen.has(k)) return
    seen.add(k)
    out.push({ col: 0, row: 0, z: 0, lx, ly, lz })
  }

  const camDir = opts?.cameraDir ?? null
  const norm = (v: [number, number, number]): [number, number, number] => {
    const L = Math.hypot(v[0], v[1], v[2]) || 1
    return [v[0] / L, v[1] / L, v[2] / L]
  }
  const toCam = camDir ? norm(camDir) : null

  for (const b of use) {
    const cx = (b.min[0] + b.max[0]) / 2
    const cy = (b.min[1] + b.max[1]) / 2
    const cz = (b.min[2] + b.max[2]) / 2
    const faces: Array<{ n: [number, number, number]; p: [number, number, number] }> = [
      { n: [-1, 0, 0], p: [b.min[0] + EPS, cy, cz] },
      { n: [1, 0, 0], p: [b.max[0] - EPS, cy, cz] },
      { n: [0, -1, 0], p: [cx, b.min[1] + EPS, cz] },
      { n: [0, 1, 0], p: [cx, b.max[1] - EPS, cz] },
      { n: [0, 0, -1], p: [cx, cy, b.min[2] + EPS] },
      { n: [0, 0, 1], p: [cx, cy, b.max[2] - EPS] },
    ]
    if (toCam) {
      faces.sort((a, z) => {
        const da = a.n[0] * toCam[0] + a.n[1] * toCam[1] + a.n[2] * toCam[2]
        const dz = z.n[0] * toCam[0] + z.n[1] * toCam[1] + z.n[2] * toCam[2]
        return dz - da
      })
    }
    for (const f of faces) push(f.p[0], f.p[1], f.p[2])
    // 面向相机的方向再内缩一点（避免正好落在盒边界上被"最小体积重叠取舍"判给邻盒）
    for (const f of faces) {
      const t = 0.06
      push(f.p[0] + (cx - f.p[0]) * t, f.p[1] + (cy - f.p[1]) * t, f.p[2] + (cz - f.p[2]) * t)
    }
    // 盒内 3×3×3 采样（偏相机侧）
    for (const fx of [0.3, 0.5, 0.7]) {
      for (const fy of [0.3, 0.5, 0.7]) {
        for (const fz of [0.3, 0.5, 0.7]) {
          push(
            b.min[0] + (b.max[0] - b.min[0]) * fx,
            b.min[1] + (b.max[1] - b.min[1]) * fy,
            b.min[2] + (b.max[2] - b.min[2]) * fz,
          )
        }
      }
    }
  }
  return out
}

/** 读视图相机位置与目标格中心（世界坐标）之差，供候选排序。 */
export async function readCameraDirectionForCell(
  page: Page,
  region: string,
  grid: GridIndex,
): Promise<[number, number, number] | null> {
  return await page.evaluate(
    ({ rid, g }) => {
      const ctx = (window as any).__vm__
      const slot = ctx?.viewports?.get(rid)
      const cam = slot?.camera?.value
      const def = slot?.definition?.value
      if (!cam || !def) return null
      const cg = def.cellGrid as number[][][]
      const d = cg.length
      const h = d > 0 ? cg[0].length : 0
      const w = h > 0 ? cg[0][0].length : 0
      const worldY = h - 1 - g.row
      const center = { x: g.col - w / 2 + 0.5, y: worldY - h / 2 + 0.5, z: g.z - d / 2 + 0.5 }
      return [cam.position.x - center.x, cam.position.y - center.y, cam.position.z - center.z]
    },
    { rid: region, g: grid },
  )
}

/**
 * 在目标格内找到一个能命中**指定部件**的探针点：按候选顺序注入 `pointermove`
 * 并读公开悬停状态，命中 `expectLocalId` 即返回（含 tooltip 文本）。
 *
 * 失败（遍历完全部候选仍未命中该部件）⇒ 抛错并带上最后一次观测，**不允许静默放过**
 * —— "真实几何下悬停不可达该部件"本身就是必须报红的结论（要区分"实现没命中"与
 * "该部件在导出几何里没有任何可命中三角形"则由调用方的对照断言承担）。
 */
export async function probePartHover(
  page: Page,
  args: {
    region: string
    grid: GridIndex
    part: RealPart
    /** 允许命中的部件身份集合（缺省 = 仅该部件自己）。 */
    expectLocalId?: string
    cameraDir?: [number, number, number] | null
    maxCandidates?: number
    perCandidateTimeoutMs?: number
  },
): Promise<{ point: CellLocalPoint; hover: WikiHoverObservation; tooltip: string | null; attempts: number }> {
  const want = args.expectLocalId ?? args.part.localId
  const candidates = probeCandidatesForPart(args.part, { cameraDir: args.cameraDir ?? null }).slice(
    0,
    args.maxCandidates ?? 48,
  )
  const trace: string[] = []
  let attempts = 0
  for (const c of candidates) {
    attempts++
    const pt: CellLocalPoint = { ...args.grid, lx: c.lx, ly: c.ly, lz: c.lz }
    await injectHoverAtCellLocal(page, pt)
    const hit = await pollUntil(
      async () => {
        const h = await readWikiHover(page)
        if (!h) return null
        if (h.part?.localId === want) return h
        trace.push(`${c.lx.toFixed(3)},${c.ly.toFixed(3)},${c.lz.toFixed(3)}→${h.part?.localId ?? `host:${h.blockId}`}`)
        return null
      },
      `部件命中（${want}）`,
      args.perCandidateTimeoutMs ?? 500,
      25,
    ).catch(() => null)
    if (hit) {
      const tooltip = await pollUntil(() => readTooltipText(page), 'tooltip DOM', 10_000, 40).catch(() => null)
      return { point: pt, hover: hit as WikiHoverObservation, tooltip: tooltip ?? null, attempts }
    }
  }
  await clearWikiHover(page)
  throw new Error(
    `P3.1：在真实导出几何下未能命中部件 ${want}（格 z=${args.grid.z} row=${args.grid.row} col=${args.grid.col}，` +
      `尝试 ${attempts} 个候选点）。最后一次观测：${JSON.stringify(trace.slice(-6))}\n` +
      `  这意味着"该部件的盒在导出几何里没有可命中的三角形，或命中总被判给邻部件" —— 必须报红，不允许静默放过。`,
  )
}

/**
 * 反向对照：断言该格**存在**至少一个能命中 `otherLocalId` 的探针点
 * （用于"同格不同部件不同说明"的对照面；失败同样报红）。
 */
export async function probeAnyOfParts(
  page: Page,
  args: {
    region: string
    grid: GridIndex
    parts: RealPart[]
    cameraDir?: [number, number, number] | null
  },
): Promise<Array<{ part: RealPart; point: CellLocalPoint; hover: WikiHoverObservation; tooltip: string | null; attempts: number }>> {
  const out: Array<{ part: RealPart; point: CellLocalPoint; hover: WikiHoverObservation; tooltip: string | null; attempts: number }> = []
  for (const p of args.parts) {
    await clearWikiHover(page)
    const r = await probePartHover(page, {
      region: args.region,
      grid: args.grid,
      part: p,
      cameraDir: args.cameraDir ?? null,
    })
    out.push({ part: p, ...r })
  }
  return out
}

/** 断言悬停 tooltip 只呈现该部件自己的说明（与同格其它部件区分）。 */
export function expectTooltipOfPart(tooltip: string | null, part: RealPart): void {
  expect(tooltip, `tooltip 必须非空（部件 ${part.localId}）`).not.toBeNull()
  expect(tooltip!, `tooltip 必须含部件显示名 ${part.displayName}`).toContain(part.displayName)
}
