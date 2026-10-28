/**
 * **导出完整性判据：cell-not-lost**（纯函数，无 I/O、无 Three）。
 *
 * ## 它回答的问题
 *
 * 导出件必须能对"世界里每一个有方块的格"给出交代：要么是**真实几何**（`BakedModel`），
 * 要么是**显式占位**（`CapturePlaceholder`，替身），要么被导出件根部的
 * `captureStats.declaredEmptyCells` **明确记账**（合法为空）。任何一格"世界里有人、
 * 导出件里变空气、且没有记账"都是丢失。
 *
 * 这条判据取代"截图里数洋红像素"式检查：后者对"捕获期拿不到几何 ⇒ 静默空气"
 * 这一缺口恒为 0（截图里根本没有方块可数），是假绿；本条直接比**世界格 ↔ 导出格**。
 *
 * ## 输入为什么是两份而不是一份
 *
 * 只读导出件会变成"自报自证"：文件说 `lostCells: 0` 就绿。故 `blocks` 必须来自
 * **世界侧读数**（控制面的 `read.blocks` 输出：坐标 + 方块 id），与导出件逐格对账。
 *
 * ## 记账口径（`declaredEmptyCells` 是**计数**，不是逐格清单）
 *
 * 导出件只带声明为空的**格数**，没有"哪几格"的清单（格式现状，见 `format-scene-file`
 * 的 `captureStats` 字段表）。本判据因此：
 *
 *  1. 逐格把世界方块映射到 `cellGrid`（`col = x - minX`、`row = maxY - y`、`z = z - minZ`，
 *     与导出侧 `cellGrid[z][maxY - y][x - minX]` 同口径）；
 *  2. 非空气格按真实几何 / 占位分类计数；
 *  3. 空气格按**稳定格序**（z,row,col）消耗 `declaredEmptyCells` 预算，超出的部分判丢失；
 *  4. 同时核对 `captureStats` 的五项自报值（含 `lostCells == 0` 与分项和）。
 *
 * **已知强度边界（如实登记）**：一份被篡改的导出件若同时改动 `captureStats`（例如把
 * `declaredEmptyCells` 调大来"吸收"被抠掉的格），计数级对账可以被骗过。要彻底消除这一点，
 * 需要导出格式携带**逐格** declared-empty 清单；那是格式升级，不在本判据内假装拥有。
 * 对"手工抠掉一格而统计不动"的负对照，本判据必红。
 */

/** 世界侧一格：坐标 + 方块身份（`id` 缺省时只按位置对账）。 */
export interface WorldBlockRef {
  readonly pos: readonly [number, number, number]
  readonly id?: string
}

/** 导出件里与判据相关的结构面（字段按运行时形状读取，非法值一律判红而不是猜）。 */
export interface ExportStructureSnapshot {
  readonly cellGrid?: unknown
  readonly blockPalette?: unknown
  readonly captureStats?: unknown
  readonly scanBounds?: unknown
}

/**
 * 逐格状态。`air` = 世界有方块而导出为空气，且**无法逐格证明**它属于 declared-empty
 * （文件只带计数、不带清单；见文件头「记账口径」）。
 */
export type CellNotLostStatus =
  | 'baked'
  | 'placeholder'
  | 'declared_empty'
  | 'air'
  | 'out_of_bounds'
  | 'invalid'
  | 'unmapped'

export type CellNotLostViolationCode =
  | 'missing_scan_bounds'
  | 'missing_capture_stats'
  | 'stats_mismatch'
  | 'lost_cells_nonzero'
  | 'cell_lost'
  | 'out_of_bounds'
  | 'palette_index_invalid'

export interface CellNotLostViolation {
  readonly code: CellNotLostViolationCode
  readonly detail: string
  readonly pos?: readonly [number, number, number]
}

export interface CellNotLostCell {
  readonly pos: readonly [number, number, number]
  readonly status: CellNotLostStatus
}

export interface CellNotLostReport {
  /** `true` 当且仅当 `violations` 为空（丢失、越界、统计不一致都判红）。 */
  readonly ok: boolean
  readonly worldBlocks: number
  readonly bakedCells: number
  readonly placeholderCells: number
  readonly airCells: number
  /** 导出件自报的合法为空格数（`captureStats.declaredEmptyCells`）。 */
  readonly declaredEmptyCells: number
  /** 按"空气格 − declaredEmpty 预算"算出的丢失格数。 */
  readonly lostCells: number
  /** 逐格对账（每个世界方块一项；顺序 = 输入顺序）。 */
  readonly cells: readonly CellNotLostCell[]
  readonly violations: readonly CellNotLostViolation[]
}

interface StatsFields {
  cellsWithBlock: number
  bakedCells: number
  placeholderCells: number
  declaredEmptyCells: number
  lostCells: number
}

interface ScanBoundsFields {
  minX: number
  maxY: number
  minZ: number
}

function finiteInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null
}

function readScanBounds(raw: unknown): ScanBoundsFields | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const minX = finiteInt(o.minX)
  const maxY = finiteInt(o.maxY)
  const minZ = finiteInt(o.minZ)
  if (minX === null || maxY === null || minZ === null) return null
  return { minX, maxY, minZ }
}

function readStats(raw: unknown): StatsFields | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const cellsWithBlock = finiteInt(o.cellsWithBlock)
  const bakedCells = finiteInt(o.bakedCells)
  const placeholderCells = finiteInt(o.placeholderCells)
  const declaredEmptyCells = finiteInt(o.declaredEmptyCells)
  const lostCells = finiteInt(o.lostCells)
  if (
    cellsWithBlock === null ||
    bakedCells === null ||
    placeholderCells === null ||
    declaredEmptyCells === null ||
    lostCells === null
  ) {
    return null
  }
  if ([cellsWithBlock, bakedCells, placeholderCells, declaredEmptyCells, lostCells].some((n) => n < 0)) {
    return null
  }
  return { cellsWithBlock, bakedCells, placeholderCells, declaredEmptyCells, lostCells }
}

function cellGridAt(grid: unknown, z: number, row: number, col: number): number | null {
  if (!Array.isArray(grid)) return null
  const slice = grid[z]
  if (!Array.isArray(slice)) return null
  const r = slice[row]
  if (!Array.isArray(r)) return null
  return finiteInt(r[col])
}

function paletteEntryAt(palette: unknown, index: number): unknown {
  if (!Array.isArray(palette)) return undefined
  return palette[index]
}

function isAirPaletteEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false
  const registryId = (entry as Record<string, unknown>).registryId
  if (typeof registryId !== 'string') return false
  const id = registryId.toLowerCase()
  return id === 'air' || id === 'minecraft:air'
}

function isPlaceholderPaletteEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false
  return (entry as Record<string, unknown>).renderMode === 'CapturePlaceholder'
}

function isAirBlockId(id: string | undefined): boolean {
  if (id === undefined) return false
  const v = id.toLowerCase()
  return v === 'air' || v === 'minecraft:air'
}

/**
 * 逐格对账。**输入不被修改**；相同输入给出逐字节相同的报告（可复现证据的前提）。
 *
 * `rootBlockPalette` 是 World 形态契约的**根级共享调色板**（真实导出件把
 * `blockPalette` 放在文档根、帧内 `structure` 不带它；以 `structure.blockPalette` 在场为准）。
 * 这里显式接住它，而不是要求调用方先把文档改写成另一种形态——判据要能直接吃产物。
 */
export function cellNotLostOf(input: {
  readonly structure: ExportStructureSnapshot
  readonly rootBlockPalette?: unknown
  readonly blocks: readonly WorldBlockRef[]
}): CellNotLostReport {
  const { structure } = input
  const palette = structure.blockPalette ?? input.rootBlockPalette
  // 世界侧的空气条目不算"有方块"（read.blocks 默认也不返回空气；这里防御性过滤）。
  const blocks = input.blocks.filter((b) => !isAirBlockId(b.id))
  const violations: CellNotLostViolation[] = []
  const cells: CellNotLostCell[] = []

  const bounds = readScanBounds(structure.scanBounds)
  const stats = readStats(structure.captureStats)
  if (bounds === null) {
    violations.push({
      code: 'missing_scan_bounds',
      detail: '导出件缺少可用的 scanBounds（minX/maxY/minZ）；没有坐标映射就无法逐格对账——不可判不等于通过',
    })
  }
  if (stats === null) {
    violations.push({
      code: 'missing_capture_stats',
      detail: '导出件缺少可用的 captureStats 五项计数；合法为空无法对账——不可判不等于通过',
    })
  }

  let bakedCells = 0
  let placeholderCells = 0
  const airCells: { pos: readonly [number, number, number]; key: string }[] = []

  for (const b of blocks) {
    const [x, y, z] = b.pos
    if (bounds === null) {
      cells.push({ pos: b.pos, status: 'unmapped' })
      continue
    }
    const col = x - bounds.minX
    const row = bounds.maxY - y
    const zSlice = z - bounds.minZ
    const idx = cellGridAt(structure.cellGrid, zSlice, row, col)
    if (idx === null) {
      violations.push({
        code: 'out_of_bounds',
        detail: `世界方块 ${b.id ?? '(未知)'} 在 (${x},${y},${z}) 落在导出网格外（col=${col}, row=${row}, z=${zSlice}）`,
        pos: b.pos,
      })
      cells.push({ pos: b.pos, status: 'out_of_bounds' })
      continue
    }
    const entry = paletteEntryAt(palette, idx)
    if (entry === undefined) {
      violations.push({
        code: 'palette_index_invalid',
        detail: `格 (${x},${y},${z}) 的调色板下标 ${idx} 越界（blockPalette 长度不足）`,
        pos: b.pos,
      })
      cells.push({ pos: b.pos, status: 'invalid' })
      continue
    }
    if (isAirPaletteEntry(entry)) {
      airCells.push({ pos: b.pos, key: `${zSlice}/${row}/${col}` })
      cells.push({ pos: b.pos, status: 'air' }) // 待记账判定后可能改写为 declared_empty
      continue
    }
    if (isPlaceholderPaletteEntry(entry)) {
      placeholderCells += 1
      cells.push({ pos: b.pos, status: 'placeholder' })
    } else {
      bakedCells += 1
      cells.push({ pos: b.pos, status: 'baked' })
    }
  }

  const declaredEmptyCells = stats?.declaredEmptyCells ?? 0
  const lostCells = Math.max(0, airCells.length - declaredEmptyCells)
  // 稳定格序：按 cellGrid 下标排（不是输入顺序），使报告可复现。
  airCells.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  if (airCells.length > 0) {
    // 计数级对账：空气格数不超过声明数 ⇒ 全部视为已记账；超出 ⇒ **不能**逐格判定
    // "哪几格是漏的"（文件没有清单），故全部标成 `air` 并报一条"至少 N-M 格未记账"，
    // 同时列出全部空气格坐标供人核对。不把预算硬分配给某几格 —— 那会诬告合法为空。
    const covered = airCells.length <= declaredEmptyCells
    const status: CellNotLostStatus = covered ? 'declared_empty' : 'air'
    for (const cell of airCells) {
      const at = cells.findIndex((c) => c.pos === cell.pos)
      if (at >= 0) cells[at] = { pos: cell.pos, status }
    }
    if (!covered) {
      violations.push({
        code: 'cell_lost',
        detail:
          `世界有方块而导出为空气的格 ${airCells.length} 个（` +
          airCells.map((c) => `(${c.pos[0]},${c.pos[1]},${c.pos[2]})`).join('、') +
          `），declaredEmptyCells=${declaredEmptyCells} ⇒ 至少 ${airCells.length - declaredEmptyCells} 格未记账`,
      })
    }
  }
  if (stats !== null) {
    if (stats.cellsWithBlock !== blocks.length) {
      violations.push({
        code: 'stats_mismatch',
        detail: `captureStats.cellsWithBlock=${stats.cellsWithBlock} 与世界侧方块数 ${blocks.length} 不一致`,
      })
    }
    if (stats.bakedCells !== bakedCells) {
      violations.push({
        code: 'stats_mismatch',
        detail: `captureStats.bakedCells=${stats.bakedCells} 与逐格真实几何计数 ${bakedCells} 不一致`,
      })
    }
    if (stats.placeholderCells !== placeholderCells) {
      violations.push({
        code: 'stats_mismatch',
        detail: `captureStats.placeholderCells=${stats.placeholderCells} 与逐格占位计数 ${placeholderCells} 不一致`,
      })
    }
    const sum = stats.bakedCells + stats.placeholderCells + stats.declaredEmptyCells + stats.lostCells
    if (sum !== stats.cellsWithBlock) {
      violations.push({
        code: 'stats_mismatch',
        detail: `captureStats 分项和 ${sum} != cellsWithBlock ${stats.cellsWithBlock}（记账不闭合）`,
      })
    }
    if (stats.lostCells !== lostCells) {
      violations.push({
        code: 'stats_mismatch',
        detail: `captureStats.lostCells=${stats.lostCells} 与跨文件逐格对账算出的丢失格数 ${lostCells} 不一致`,
      })
    }
    if (stats.lostCells !== 0) {
      violations.push({
        code: 'lost_cells_nonzero',
        detail: `captureStats.lostCells=${stats.lostCells}（必须为 0）`,
      })
    }
  }

  return Object.freeze({
    ok: violations.length === 0,
    worldBlocks: blocks.length,
    bakedCells,
    placeholderCells,
    airCells: airCells.length,
    declaredEmptyCells,
    lostCells,
    cells: Object.freeze(cells),
    violations: Object.freeze(violations),
  })
}
