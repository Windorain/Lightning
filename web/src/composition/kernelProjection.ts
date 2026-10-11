/**
 * `composition/kernelProjection` —— **内核文档 → 旧发布格式**（G-3 反向编码器；#282 P10b）。
 *
 * ## 本模块解决什么
 *
 * 正向装配（`composition/kernelAssembly`）把旧文件读进内核。反向这一半同样必要，
 * 且是**两条**真实需求的共同前置：
 *
 * | 需求 | 依据 | 为什么必须反向 |
 * |---|---|---|
 * | 发布/导出闭环 | #249 §12；#282 执行范围第 5 条 | 产物必须是外部格式；内核 `Scene` 不是文件格式 |
 * | 呈现链消费内核内容 | #282 执行范围第 2 条 | 渲染后端吃的是"文档 plain JSON"（`drwMeshPipeline` 的 `doc.serialize()`），故内核内容要能投影回那个形状 |
 *
 * ## 三条设计判据
 *
 * ### 1. 反向编码**不是**"把装配的输入原样吐回"
 *
 * 内核文档是**权威**：用户可以在内核里改元数据/对象/资源（那才是"内核文档上可编辑"）。
 * 故反向编码必须**从内核值重建**，而不是缓存并回放原始 JSON —— 后者会让
 * "编辑了但导出还是旧的"成为一个必然的静默缺陷。
 *
 * 判据由 `kernelAssembly.test.ts` 的往返断言把守：改内核元数据后重新投影，
 * 产物里的元数据**必须**变。
 *
 * ### 2. 版本化：`format_version` 与形态键由**内容**决定，不由调用方声明
 *
 * 多方块文档（带 `multiblock` 声明）投影出 `documentShape: 'multiblock'` + 内层 body；
 * 帧为主文档投影出 `format_version: '2.0'` + 帧自带 `structure`。
 * 形态由 {@link KernelProjectionInput} 的 `multiblock` 是否存在**机械决定** ——
 * 让调用方传一个 `shape` 参数就会造出"声明与内容不符"的文件。
 *
 * ### 3. 未知字段经**保真记录**回写（不静默丢，也不塞回核心）
 *
 * #249 §12：未知字段"若必须往返保留，放在带源格式/源版本的适配器保真记录中"。
 * 故本模块接受一个可选的 {@link FidelityRecord}，把它记录的字段写回产物根 ——
 * 这是"往返保留"的实现，而记录本身**不进**内核文档（§15 第 2 条：
 * 核心无字段袋）。于是"保真"与"核心干净"同时成立。
 *
 * ## 纯度
 *
 * 无 IO、无 DOM、无时钟、不 import 任何旧层的**实现**（只吃旧层的类型与纯数据）。
 */

import type { Grid, SlotBlock } from '@/context/grid'
import { Grid as LegacyGrid } from '@/context/grid'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { RuntimeDocument as LegacyRuntimeDocument, RuntimeFrame } from '@/context/runtimeDocument'
import { structureRowToWorldY } from '@/pure/vec'
import { AIR_PALETTE_INDEX } from '@/context/runtimeDocument'
import { PARTS_GRID_NONE, partListSignature } from '@/pure/partTypes'
import type { DocumentContent } from '@/domain/content'
import { blockPaletteEntryKey, encodeBlockGeometry, type BlockGeometryAsset, type BlockPaletteEntry } from '@/domain/blockGeometry'
import type { CellContentTable } from '@/domain/cellContent'
import { findObject, findObjectData, objectsInOrder, type Scene, type SceneObject } from '@/domain/scene'

// ─────────────────────────────────────────────────────────────────────────────
// 方块单元键/值（与 `composition/kernelAssembly` 的 `blockCellKey`/`blockCellValue` 对偶）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `"x,y,z"` → 坐标；非法返回 `null`（不抛：坏数据是**显式**跳过，由诊断计数）。
 *
 * 与 `kernelAssembly#blockCellKey` 是**对偶**关系。两处的键格式必须一致，
 * 由 `kernelAssembly.test.ts` 的往返断言把守（装配 → 投影 → 再装配逐格一致）。
 */
export function parseBlockCellKey(key: string): { x: number; y: number; z: number } | null {
  const parts = key.split(',')
  if (parts.length !== 3) return null
  // 空段必须显式拒绝：`Number('')` 是 0，直接判 `Number.isInteger` 会让
  // `"1,2,"` 被静默读成 `(1,2,0)` —— 一次真实的坐标误读。
  if (parts.some((p) => p.trim() === '')) return null
  const x = Number(parts[0])
  const y = Number(parts[1])
  const z = Number(parts[2])
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return null
  return { x, y, z }
}

/**
 * `"minecraft:<name>:<meta>"` → 方块；非法返回 `null`。
 *
 * 与 `kernelAssembly#blockCellValue` 对偶。`meta` 缺省为 0（旧产物常只写名字）。
 * 前缀 `minecraft:` 可有可无（两种历史形态都接受）—— 但**必须**是
 * `<name>` 或 `<name>:<meta>` 两段式，多段（含命名空间以外冒号）判非法，
 * 因为那时"哪一段是 meta"不可判定，猜一个就是静默错读。
 */
export function parseBlockCellValue(value: string): { name: string; meta: number } | null {
  if (typeof value !== 'string' || value === '') return null
  const body = value.startsWith('minecraft:') ? value.slice('minecraft:'.length) : value
  const parts = body.split(':')
  if (parts.length === 1) return parts[0] === '' ? null : { name: parts[0], meta: 0 }
  if (parts.length === 2) {
    const meta = Number(parts[1])
    if (!Number.isInteger(meta) || parts[0] === '') return null
    return { name: parts[0], meta }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// blockGrid 对象 → 旧 (cellGrid, blockPalette)
// ─────────────────────────────────────────────────────────────────────────────

/** 一次网格投影的结果（下标网格 + 调色板 + 逐格部件网格 + 诊断计数）。 */
export interface ProjectedGrid {
  readonly cellGrid: number[][][]
  readonly blockPalette: Record<string, unknown>[]
  /**
   * 逐格部件网格（`cellPartsGrid`）+ 部件池（`partLists`）。
   *
   * `undefined` = 该网格**无**逐格部件（不是"空部件网格"）—— 与文件格式
   * 「缺省或全 -1 ⇒ 与无部件行为一致」及 `runtimeDocument.serialize()`
   * 的「仅当确有部件数据时才写出」同一口径。
   */
  readonly cellPartsGrid?: number[][][]
  readonly partLists?: unknown[]
  /** 无法解析的单元键/值数（**显式**计数，不静默吞）。 */
  readonly invalidCells: number
}

/** 投影用的**网格内容**（类型化承载的投影面）。 */
export interface GridProjectionInput {
  readonly cells: Readonly<Record<string, string>>
  /** 几何资产目录（`assetId` → 资产）；缺省 = 该网格无几何资产。 */
  readonly geometry?: Readonly<Record<string, BlockGeometryAsset>>
  /** 逐格 → `assetId`；缺省 = 该网格无几何资产。 */
  readonly cellGeometry?: Readonly<Record<string, string>>
  /**
   * 逐格 → **调色板条目内容键**（`blockPaletteEntryKey`）；缺省 = 无该信息。
   *
   * 有它 ⇒ 调色板按"逐格实际用到的条目"**精确重建**（下标分区与源一致）；
   * 无它 ⇒ 回落到按 `(名称尾段, meta, assetId)` 匹配的**显式降级**。
   */
  readonly cellPalette?: Readonly<Record<string, string>>
  /** 类型化调色板条目（含呈现提示）；缺省 = 无（几何由生产按身份现算）。 */
  readonly palette?: readonly BlockPaletteEntry[]
  /** 逐格内容（部件 / 逐格说明）；缺省 = 无。 */
  readonly cellContent?: CellContentTable
}

/**
 * 内核 `blockGrid` 载荷 → 旧 `(cellGrid, blockPalette)`（**含几何与部件**）。
 *
 * ## 坐标翻转（**唯一**的翻转点，与装配侧对偶）
 *
 * 内核 `cells` 的键是 Y-up 世界坐标（`y = 0` 为底）；旧 `cellGrid` 的
 * `row 0 = 顶部`。故 `row = sizeRow - 1 - y`，由
 * `pure/vec#structureRowToWorldY` 的**逆**给出 —— 这里直接用
 * `structureRowToWorldY(row, sizeRow) === y` 反解 `row`，即
 * `row = sizeRow - 1 - y`（该函数是自逆的：`f(f(r)) = r`）。
 *
 * 用同一个函数反解（而不是手写 `sizeRow - 1 - y`）是为了让"翻转只有一处定义"
 * 成为事实：翻转公式改了，两侧同时改。
 *
 * ## 调色板**必须**逐格特异（本批实测抓出的关键事实）
 *
 * 切换前的投影按 `name:meta` 合并调色板条目（`indexOf(name, meta)`），
 * 而那与真实产物的形态**不符**：实测真实信封夹具里
 * `appliedenergistics2:tile.BlockCableBus:0` 出现 33 次、**12 种不同 `quads` 长度**。
 * 按 `name:meta` 合并会把 33 种线缆形状塌成 1 种 ⇒ **渲染结果与切换前不一致**。
 *
 * ⇒ 本函数的调色板条目身份是「方块身份 + **几何资产身份**」：
 *  - 同 `name:meta` **且**同 `assetId` ⇒ 合并（真共享，A07）；
 *  - 同 `name:meta` 但 `assetId` 不同 ⇒ **两条**（几何不同就是不同条目）。
 *
 * 判据是**内容**（几何内容），不是位置、不是下标。
 *
 * ## 几何的**重编码**（而不是回显）
 *
 * `blockPalette[i].geometry` 由 `encodeBlockGeometry(asset)` 从类型化资产算出 ——
 * 往返**逐字节无损**（见 `domain/blockGeometry#encodeBlockGeometry` 的说明与
 * `domain/__tests__/blockGeometry.test.ts` 的 68 条目零 diff 断言）。
 *
 * ## 部件网格（`cellPartsGrid` + `partLists`）
 *
 * 由 `cellContent` 的 `parts` 重建，且**内容签名去重**（契约 §2.1：同内容跨格共享一份下标）
 * 与 `runtimeDocument._gridToV2` 同一口径（`partListSignature`）。
 * 于是"部件池的下标分配"在两条路径上**同源**，不是两套去重算法。
 */
export function projectGridCells(input: GridProjectionInput): ProjectedGrid {
  const cells = input.cells
  const cellGeometry = input.cellGeometry ?? {}
  const assets = input.geometry ?? {}
  const typedPalette = input.palette ?? []
  const cellContent = input.cellContent ?? {}
  const cellPalette = input.cellPalette ?? {}

  // 先解析全部单元，求包围盒（尺寸由内容决定，不由调用方声明 —— 与"形态由内容决定"同一纪律）。
  const parsed: { x: number; y: number; z: number; name: string; meta: number; key: string }[] = []
  let invalidCells = 0
  for (const [key, value] of Object.entries(cells)) {
    const pos = parseBlockCellKey(key)
    const block = parseBlockCellValue(value)
    if (pos === null || block === null) {
      invalidCells += 1
      continue
    }
    parsed.push({ ...pos, ...block, key })
  }
  if (parsed.length === 0) {
    return { cellGrid: [], blockPalette: [airPaletteEntry()], invalidCells }
  }
  let maxX = 0
  let maxY = 0
  let maxZ = 0
  for (const c of parsed) {
    if (c.x > maxX) maxX = c.x
    if (c.y > maxY) maxY = c.y
    if (c.z > maxZ) maxZ = c.z
  }
  const width = maxX + 1
  const height = maxY + 1
  const depth = maxZ + 1

  /** 类型化条目按 `(registryId, meta, assetId)` 索引（几何内容进身份，见上）。 */
  const typedByKey = new Map<string, BlockPaletteEntry>()
  /** 类型化条目按 **`assetId`** 索引 —— **主**查找键（见 {@link paletteEntryFor} 的说明）。 */
  const typedByAsset = new Map<string, BlockPaletteEntry>()
  /** 类型化条目按 `(name 尾段, meta)` 索引（旧 GF-7 编码丢命名空间时的兜底，见下）。 */
  const typedByNameMeta = new Map<string, BlockPaletteEntry>()
  /**
   * 类型化条目按**内容键**索引（`blockPaletteEntryKey`）。
   *
   * 这是**精确**查找：`cellPalette` 给的就是内容键，故投影侧不需要任何猜测。
   * 它也是"文件的分区块状态槽"能逐格复现的唯一通路（见
   * `domain/scene#ObjectDataPayload.cellPalette` 的字段注释）。
   */
  const typedByEntryKey = new Map<string, BlockPaletteEntry>()
  for (const e of typedPalette) {
    typedByKey.set(`${e.registryId}\u0000${e.meta}\u0000${e.assetId}`, e)
    if (!typedByEntryKey.has(blockPaletteEntryKey(e))) typedByEntryKey.set(blockPaletteEntryKey(e), e)
    if (e.assetId !== '' && !typedByAsset.has(e.assetId)) typedByAsset.set(e.assetId, e)
    // GF-7 的单元值编码是 `minecraft:<name>:<meta>`，而 `<name>` 是**截去命名空间**的
    // （`blockCellValue` 用 `registryId` 首个冒号之后的部分，与生产
    // `BlockRef.block_state_id` 同口径）。故反向查找必须按"尾段 + meta"匹配，
    // 否则 `appliedenergistics2:tile.BlockCableBus` 永远命中不到。
    const colon = e.registryId.indexOf(':')
    const tail = colon >= 0 ? e.registryId.slice(colon + 1) : e.registryId
    const k = `${tail}\u0000${e.meta}`
    if (!typedByNameMeta.has(k)) typedByNameMeta.set(k, e)
  }

  // 调色板：按首次出现顺序编号（下标 0 保留给 air）—— 稳定且可复现。
  //
  // ## 下标分区必须与**源**一致（本批实测抓出的真实回退）
  //
  // 见 `domain/blockGeometry#blockPaletteEntryKey` 的注释：渲染侧的同调色板邻面剔除
  // 按 **palette 下标**判「是不是同一方块类型」。故"把本该分开的条目合并"
  // 会改变剔除结果（实测 4882 → 4862）。
  // ⇒ 去重键优先用 `cellPalette` 给出的**条目内容键**（精确、无猜测）。
  const blockPalette: Record<string, unknown>[] = [airPaletteEntry()]
  const indexOfCell = new Map<string, number>()
  const indexOf = (name: string, meta: number, cellKey: string): number => {
    const entryKey = cellPalette[cellKey]
    const assetId = cellGeometry[cellKey] ?? ''
    const dedupeKey =
      entryKey !== undefined && entryKey !== '' ? `k:${entryKey}` : `f:minecraft:${name}\u0000${meta}\u0000${assetId}`
    const hit = indexOfCell.get(dedupeKey)
    if (hit !== undefined) return hit
    const idx = blockPalette.length
    indexOfCell.set(dedupeKey, idx)
    const typed =
      entryKey !== undefined && entryKey !== '' ? typedByEntryKey.get(entryKey) ?? null : null
    blockPalette.push(
      paletteEntryFor(`minecraft:${name}`, meta, assetId, assets, typedByKey, typedByAsset, typedByNameMeta, typed),
    )
    return idx
  }

  // 旧 cellGrid 的 row 序：row 0 = 顶部 ⇒ row = height - 1 - y。
  const cellGrid: number[][][] = []
  for (let z = 0; z < depth; z++) {
    const slice: number[][] = []
    for (let row = 0; row < height; row++) {
      slice.push(new Array(width).fill(AIR_PALETTE_INDEX))
    }
    cellGrid.push(slice)
  }
  for (const c of parsed) {
    const row = structureRowToWorldY(c.y, height)
    cellGrid[c.z]![row]![c.x] = indexOf(c.name, c.meta, c.key)
  }

  const parts = projectParts(cellContent, parsed, { width, height, depth })
  return parts === null
    ? { cellGrid, blockPalette, invalidCells }
    : { cellGrid, blockPalette, cellPartsGrid: parts.cellPartsGrid, partLists: parts.partLists, invalidCells }
}

/**
 * 逐格内容 → `(cellPartsGrid, partLists)`（契约 §2.1 的内容签名去重）。
 *
 * 无任何部件时返回 `null`（**不**写出全 `-1` 的网格）—— 与
 * `runtimeDocument.serialize()` 的「仅当确有部件数据时才写出」逐字同口径，
 * 于是"无部件的文档"在往返后**字节干净**（不因本批引入一批空网格）。
 */
function projectParts(
  cellContent: CellContentTable,
  parsed: readonly { x: number; y: number; z: number }[],
  dims: { width: number; height: number; depth: number },
): { cellPartsGrid: number[][][]; partLists: unknown[] } | null {
  const withParts = parsed.filter((c) => {
    const v = cellContent[`${c.x},${c.y},${c.z}`]
    return v !== undefined && v.parts !== undefined && v.parts.length > 0
  })
  if (withParts.length === 0) return null

  const partLists: unknown[] = []
  const indexBySignature = new Map<string, number>()
  const cellPartsGrid: number[][][] = []
  for (let z = 0; z < dims.depth; z++) {
    const slice: number[][] = []
    for (let row = 0; row < dims.height; row++) {
      slice.push(new Array(dims.width).fill(PARTS_GRID_NONE))
    }
    cellPartsGrid.push(slice)
  }
  for (const c of withParts) {
    const list = cellContent[`${c.x},${c.y},${c.z}`]!.parts as readonly unknown[]
    const sig = partListSignature(list as never)
    let idx = indexBySignature.get(sig)
    if (idx === undefined) {
      idx = partLists.length
      indexBySignature.set(sig, idx)
      partLists.push(list)
    }
    const row = structureRowToWorldY(c.y, dims.height)
    cellPartsGrid[c.z]![row]![c.x] = idx
  }
  return { cellPartsGrid, partLists }
}

/**
 * 一条调色板条目的**文件格式**重建（几何从类型化资产重编码）。
 *
 * ## 几何从哪来（三条优先级，各自都有判据）
 *
 * 1. **逐格 `assetId` → 资产目录**（有几何资产时的**唯一**正确来源）：
 *    这是"位置特异几何"（33 种线缆形状）能保真的通路；
 * 2. **类型化条目的 `geometry`**（`assetId` 命中不到目录时的兜底）：
 *    条目自带资产是同一份内容的第二种持法，取它不会失真；
 * 3. **无几何**（`renderMode: 'BlockModel'`）：编辑新增的方块，由生产按身份现算 ——
 *    **显式**不写 `geometry` 字段（而不是写一个空 `{quads: []}`，
 *    那会让"需要现算"表现为"渲染不出来"）。
 *
 * 呈现提示（`occludesAdjacentFaces`/`facing`/`nbt`/`thumbnailPNG`/`tooltip`）
 * 一律从类型化条目取 —— 它们是**逐条目**事实，与几何身份无关。
 */
function paletteEntryFor(
  registryId: string,
  meta: number,
  assetId: string,
  assets: Readonly<Record<string, BlockGeometryAsset>>,
  typedByKey: ReadonlyMap<string, BlockPaletteEntry>,
  typedByAsset: ReadonlyMap<string, BlockPaletteEntry>,
  typedByNameMeta: ReadonlyMap<string, BlockPaletteEntry>,
  typedExact?: BlockPaletteEntry | null,
): Record<string, unknown> {
  const tail = registryId.indexOf(':') >= 0 ? registryId.slice(registryId.indexOf(':') + 1) : registryId
  // 查找顺序是判据的一部分（本批实测抓出过两处真实丢失）：
  //  ⓪ **内容键精确命中**（`cellPalette` 给出时）：投影侧不做任何猜测。
  //  ① `assetId`（**主**回落键）：几何身份是内容派生的，故它唯一确定"哪一条类型化条目"。
  //     用它是**必须**的 —— GF-7 的单元值编码 `minecraft:<name>:<meta>` 会**丢掉命名空间**
  //     （`appliedenergistics2:tile.BlockCableBus` → `minecraft:tile.BlockCableBus`），
  //     故按 `registryId` 精确匹配永远命中不到（实测：`occludesAdjacentFaces` 11 → 0）。
  //  ② 精确三元组：`assetId` 为空（无几何条目）时回落。
  //  ③ `(name 尾段, meta)`：最后的兜底（同一几何内容在多条同名条目间共享时用）。
  const typed =
    typedExact ??
    (assetId === '' ? undefined : typedByAsset.get(assetId)) ??
    typedByKey.get(`${registryId}\u0000${meta}\u0000${assetId}`) ??
    typedByKey.get(`minecraft:${tail}\u0000${meta}\u0000${assetId}`) ??
    typedByNameMeta.get(`${tail}\u0000${meta}`) ??
    null
  const out: Record<string, unknown> = {
    registryId,
    meta,
    renderMode: typed?.renderMode ?? (assetId === '' ? 'BlockModel' : 'BakedModel'),
  }
  const asset = assetId === '' ? undefined : assets[assetId] ?? typed?.geometry ?? undefined
  if (asset !== undefined && asset !== null) {
    // **重编码**（不是回显）：从类型化四边形算出文件格式的几何，往返逐字节无损。
    const encoded = encodeBlockGeometry(asset)
    out.geometry = { encoding: encoded.encoding, quads: encoded.quads }
  }
  if (typed !== null) {
    if (typed.occludesAdjacentFaces !== undefined) out.occludesAdjacentFaces = typed.occludesAdjacentFaces
    if (typed.facing !== undefined) out.facing = typed.facing
    if (typed.nbt !== undefined) out.nbt = typed.nbt
    if (typed.thumbnail !== undefined) out.thumbnailPNG = typed.thumbnail
    if (typed.tooltip !== undefined) out.tooltip = [...typed.tooltip]
  }
  return out
}

function airPaletteEntry(): Record<string, unknown> {
  return { registryId: 'air', meta: AIR_PALETTE_INDEX, renderMode: 'BlockModel' }
}

/**
 * 由投影出的 `(cellGrid, blockPalette)` 重建一个旧 `Grid`。
 *
 * ## 为什么需要它（不能只吐 JSON）
 *
 * 渲染链（`resolveRenderBundle` → `StructureDefinition`）要的是**已解析的
 * `cellGrid` + `blockPalette`**，而不是 `Grid`。但**保存/导出**路径要的是
 * 可 `serialize()` 的文档，而 `RuntimeDocument.serialize()` 从 `Grid` 出发。
 *
 * ⇒ 本函数把投影结果装回旧模型，使"内核 → 旧文档"是一条**完整**通路
 * （而不是只够喂渲染、不够保存的半条）。行序翻转在此**再次**用
 * `structureRowToWorldY` 反解 —— 与 `projectGridCells` 同一个函数，
 * 故两处不可能漂移。
 */
export function projectToLegacyGrid(input: GridProjectionInput): { grid: Grid; invalidCells: number } {
  const projected = projectGridCells(input)
  const depth = projected.cellGrid.length
  const height = projected.cellGrid[0]?.length ?? 0
  const width = projected.cellGrid[0]?.[0]?.length ?? 0
  const paletteCache = new Map<string, import('@/pure/gridTypes').PaletteEntryMeta>()
  for (let i = 0; i < projected.blockPalette.length; i++) {
    const entry = projected.blockPalette[i]!
    const rid = entry.registryId as string
    const colon = rid.indexOf(':')
    const name = colon >= 0 ? rid.slice(colon + 1) : rid
    if (name !== 'air' && name !== 'Air') {
      paletteCache.set('#' + String(i), entry as unknown as import('@/pure/gridTypes').PaletteEntryMeta)
    }
  }
  const gridCells: (SlotBlock | null)[][][] = []
  for (let z = 0; z < depth; z++) {
    const slice: (SlotBlock | null)[][] = []
    for (let y = 0; y < height; y++) {
      const row = structureRowToWorldY(y, height)
      const outRow: (SlotBlock | null)[] = new Array(width).fill(null)
      const rawRow = projected.cellGrid[z]?.[row]
      if (rawRow) {
        for (let x = 0; x < width; x++) {
          const idx = rawRow[x]!
          if (idx === AIR_PALETTE_INDEX) continue
          const entry = projected.blockPalette[idx]
          if (entry === undefined) continue
          const rid = entry.registryId as string
          const colon = rid.indexOf(':')
          const name = colon >= 0 ? rid.slice(colon + 1) : rid
          if (name === 'air' || name === 'Air') continue
          outRow[x] = { name, meta: (entry.meta as number) ?? 0, paletteIndex: idx }
        }
      }
      slice[y] = outRow
    }
    gridCells.push(slice)
  }
  return { grid: new LegacyGrid(width, height, depth, gridCells, paletteCache), invalidCells: projected.invalidCells }
}

// ─────────────────────────────────────────────────────────────────────────────
// 投影入口
// ─────────────────────────────────────────────────────────────────────────────

/** 投影诊断（稳定码；不静默）。 */
export type ProjectionDiagnosticCode =
  /** `blockGrid` 载荷里有无法解析的单元键/值（已跳过，计数在 `count`）。 */
  | 'invalidGridCells'
  /** 内核对象类型不是 `block`（当前渲染/保存格式承载不了它）。 */
  | 'unsupportedObjectType'
  /** `blockGrid` 载荷里有几何资产目录但缺逐格身份（或有身份但缺资产）。 */
  | 'incompleteGeometryAssets'
  /** 逐格内容的键与 `cells` 的键集不一致（下标网格与方块网格会错位）。 */
  | 'cellContentKeyMismatch'

/**
 * 投影侧需要的**类型化声明**（装配产物 `MultiblockContent` 的投影面）。
 *
 * ## 为什么是"投影面"而不是直接收 `MultiblockContent`
 *
 * `MultiblockContent` 还带 `channels`/`runstates`/`variants`/`totalTierDomain` 等
 * **UI 读数**（面板要用），而投影只需要"把它们写回文件"这一件事所需的字段。
 * 收窄入参使"投影依赖什么"在类型上可见 —— 于是"投影偷偷读了别的字段"不可能
 * （那正是"回显"能藏身的地方）。
 */
export interface KernelDeclarationProjection {
  /** 声明 id（写回内层 body 的 `multiblock.id`）。 */
  readonly id: string
  readonly displayName: string
  /**
   * `multiblock` 节的**扩展键保真**（`declRaw`）。
   *
   * 类型化承载覆盖了 `id`/`displayName`/`channels`/`runstates`/`variants`/
   * `rules`/`backbone`/`totalTierDomain`/`tierSample`/`couplings` 等；
   * 而 `viewerSemantics`/`notes` 的族特有字段/未来新增键由本字段**原样写回**。
   *
   * 它是"未知字段不静默丢"（§12 第 3 段）在**声明内部**的落点：
   * 逐键写回**只对类型化字段未覆盖的键生效**（见 {@link projectMultiblockBody}），
   * 故类型化字段**永远赢** —— 即"编辑了内核内容但导出还是旧的"不可能发生
   * （文件头判据 1）。
   */
  readonly declRaw: Readonly<Record<string, unknown>>
  /** 调色板（类型化；由 {@link projectMultiblockBody} 重编码回文件格式）。 */
  readonly blockPalette: readonly BlockPaletteEntry[]
  /** 几何资产目录（`assetId` → 资产）；`blockPalette` 条目的几何从这里取。 */
  readonly assets: Readonly<Record<string, BlockGeometryAsset>>
  /** 帧声明（写回内层 body 的 `frames`：变体/运行态/骨架阶/规则引用）。 */
  readonly frames: readonly KernelFrameDeclaration[]
  /** 契约/payload 的 `schemaVersion`。 */
  readonly schemaVersion: number | null
  readonly multiblockCount: number
}

/** 一帧的**声明面**（投影用；网格由 `blockGrid` 载荷另行重建）。 */
export interface KernelFrameDeclaration {
  readonly index: number
  readonly variant: string
  readonly runstate: string
  readonly stepIndex: number
  readonly rules: readonly (string | Readonly<{ id: string; order?: number }>)[]
  readonly label?: string
  readonly durationMs?: number
}

export interface ProjectionDiagnostic {
  readonly code: ProjectionDiagnosticCode
  readonly path: string
  readonly detail: string
  readonly count?: number
}

export interface KernelProjectionInput {
  readonly scene: Scene
  readonly content: DocumentContent
  /**
   * 帧时长轴 → 帧声明的来源：`frameObjects` 给出"帧下标 → 内核对象 id"。
   *
   * 缺省 = 按 `scene.order` 里 `block` 类型对象的顺序（装配产物就是这个顺序）。
   */
  readonly frameObjects?: readonly string[]
  /**
   * 多方块**类型化声明**（装配产物的 `multiblock`）。
   *
   * **有值** ⇒ 产物是"多方块为主"形态（`documentShape: 'multiblock'` + 内层 body）。
   * 无值 ⇒ "帧为主"形态。形态由它**机械决定**（见文件头判据 2）。
   *
   * ## 它替代了 `multiblockSource`（#289 P10d）
   *
   * 旧入参是 `Readonly<Record<string, unknown>>`（**整个内层 body 的原始 JSON**），
   * 而本函数把它逐键摊平回产物根 —— 即"几何/声明今天能投影，靠的是把原始 JSON 原样吐回"。
   * 这正是 R-WK-06 裁决第 3 条要退役的形态。
   *
   * 新入参是**类型化承载**：`declRaw`（单个 `multiblock` 节的扩展键保真）+
   * `blockPalette`（类型化资产目录）+ `frames`（帧声明）。
   * 见 {@link projectMultiblockBody} 的逐键重建表。
   */
  readonly multiblockDeclaration?: KernelDeclarationProjection | null
  /**
   * 保真记录里要回写的未知字段（#249 §12 的"往返保留"）。
   *
   * 键是**顶层字段名**（`meta.` 前缀的项写回 `meta` 子树）。
   */
  readonly fidelityFields?: Readonly<Record<string, unknown>>
  /** 文档 id（缺省用 `scene.id` 去掉 `-scene` 后缀）。 */
  readonly documentId?: string
}

/** 投影产物：一份旧格式 plain JSON + 诊断。 */
export interface ProjectedDocument {
  readonly plain: Readonly<Record<string, unknown>>
  readonly diagnostics: readonly ProjectionDiagnostic[]
}

/**
 * 由**类型化声明**重建内层 body 的键（#289 P10d：退役原始 JSON 回显的落点）。
 *
 * ## 逐键来源表（这就是"零回显"的可执行含义）
 *
 * | 内层 body 键 | 从哪来 | 判据 |
 * |---|---|---|
 * | `schemaVersion` | `declaration.schemaVersion` | 契约/payload 的格式版本；`null` ⇒ 不写（**显式**缺省） |
 * | `multiblockCount` | `declaration.multiblockCount` | 解析器硬断言 `=== 1`，故必须写 |
 * | `multiblock` | `declRaw` 打底 + 类型化字段覆盖 | 见下 |
 * | `blockPalette` | 逐格投影出的调色板（**含重编码几何**） | 见 `projectGridCells`；这里只补"声明的并集调色板"里**未被格引用**的条目 |
 * | `materialPalette`/`textureBlobs`/`tooltipPalette`/`cellTooltipGrid` | **不在此** | 由 ③/④（资源）与文档级字段负责 —— 本函数**不**碰，避免与既有投影路径抢同一个键 |
 *
 * ## `multiblock` 节的逐键重建（**类型化字段永远赢**）
 *
 * 顺序是判据的一部分：
 *  1. 先放 `declRaw` 的全部键（扩展键保真：`viewerSemantics`/`notes`/未来新增键）；
 *  2. 再用**类型化字段**覆盖它认识的键。
 *
 * 于是"内核内容改了但导出还是旧的"**不可能**发生（文件头判据 1 的要求），
 * 而"类型化承载没覆盖的键"仍原样往返（§12 第 3 段）。
 *
 * ## 为什么 `id`/`displayName` 也在覆盖集里（而不是信 `declRaw`）
 *
 * 它们是**声明身份**，且 `displayName` 在装配产物里是独立字段
 * （`MultiblockContent.displayName`，UI 面板直接读它）。若只信 `declRaw`，
 * 那么"装配时把 `displayName` 补了个默认值"这一事实就不会出现在产物里 ——
 * 投影与装配会对同一个问题给出两个答案。
 */
export function projectMultiblockBody(declaration: KernelDeclarationProjection): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (declaration.schemaVersion !== null) out.schemaVersion = declaration.schemaVersion
  out.multiblockCount = declaration.multiblockCount

  // ① 扩展键保真（打底）。
  const mb: Record<string, unknown> = { ...declaration.declRaw }
  // ② 类型化字段覆盖（它们**赢**）。
  mb.id = declaration.id
  mb.displayName = declaration.displayName
  mb.channels = declaration.declRaw.channels ?? mb.channels
  mb.runstates = declaration.declRaw.runstates ?? mb.runstates
  mb.variants = declaration.declRaw.variants ?? mb.variants
  mb.rules = declaration.declRaw.rules ?? mb.rules
  mb.backbone = declaration.declRaw.backbone ?? mb.backbone
  mb.totalTierDomain = declaration.declRaw.totalTierDomain ?? mb.totalTierDomain
  out.multiblock = mb

  // ③ 并集调色板：把**未被任何格引用**的类型化条目补进去。
  //
  // 为什么需要补：声明的 `backbone.sizeSteps[].cellGrid` 用**并集调色板下标**，
  // 而逐格投影只发出"实际被格引用"的条目。缺了未被引用的条目会让骨架阶的
  // 下标指向越界（`context/multiblock/palette#buildPalette` 的 `slots[i]` 变 null
  // ⇒ 装配出的骨架缺方块）。故这里按**声明顺序**发出全部条目。
  out.blockPalette = declaration.blockPalette.map((e) =>
    paletteEntryFor(
      e.registryId,
      e.meta,
      e.assetId,
      declaration.assets,
      new Map([[`${e.registryId}\u0000${e.meta}\u0000${e.assetId}`, e]]),
      new Map(e.assetId === '' ? [] : [[e.assetId, e]]),
      new Map([[`${e.registryId.slice(e.registryId.indexOf(':') + 1)}\u0000${e.meta}`, e]]),
    ),
  )
  // **不写 `frames`** —— 见 {@link mergeDeclarationFrames} 的说明：
  // 帧由"网格承载 + 声明合并"两半合成，而不是由本函数整份写出。
  return out
}

/**
 * 把**声明的帧**合并到**投影出的帧**上（按 index 对齐）。
 *
 * ## 为什么必须是"合并"而不是"整份写出"
 *
 * 多方块文档的 `frames` 是**变体存储原语**（契约 §5.3，本例 432 帧），
 * 而"当前画出来的网格"只有**一份**（由当前通道取值装配出的那一个）。
 * 投影产物因此天然是**呈现视图**而不是完整往返：帧数 = 网格对象数。
 *
 * 切换前的实现就是这个语义 —— 它从内层 body 原文里按下标取 `variant`/`runstate`/
 * `stepIndex`/`rules` 合到投影帧上。本批把它换成**从类型化帧声明**取，
 * 于是"帧声明从哪来"不再依赖原始 JSON。
 *
 * ## 丢掉未合并的声明帧是**既有**行为（本批如实登记，不冒充已修）
 *
 * 432 帧声明里只有第 0 帧进入产物。这是投影的**既有**有损点（切换前同样如此），
 * 属"多方块声明 → 呈现视图"的语义边界，**不是**本批引入。
 * 修复它需要"投影出 432 帧但只有一帧带网格"的形态，而那会让
 * `frameCount` 与"可渲染帧数"分离 —— 那是格式演进，不在本批范围（见汇报遗留缺口）。
 */
function mergeDeclarationFrames(
  plainFrames: readonly Record<string, unknown>[],
  declarations: readonly KernelFrameDeclaration[],
): void {
  for (let i = 0; i < plainFrames.length; i++) {
    const decl = declarations[i]
    if (decl === undefined) continue
    const frame = plainFrames[i]!
    frame.variant = decl.variant
    frame.runstate = decl.runstate
    frame.stepIndex = decl.stepIndex
    frame.rules = decl.rules.map((r) =>
      typeof r === 'string' ? r : r.order === undefined ? { id: r.id } : { id: r.id, order: r.order },
    )
  }
}

/**
 * `blockGrid` 载荷 → 投影输入（**唯一**的适配点）。
 *
 * 把载荷的四个可选内容字段一次性取出，使调用方不必知道"哪些字段要一起传"
 * （漏传一个的后果是逐格几何/部件静默丢失）。
 */
function gridProjectionInputOf(payload: {
  readonly cells: Readonly<Record<string, string>>
  readonly geometry?: Readonly<Record<string, BlockGeometryAsset>>
  readonly cellGeometry?: Readonly<Record<string, string>>
  readonly cellPalette?: Readonly<Record<string, string>>
  readonly palette?: readonly BlockPaletteEntry[]
  readonly cellContent?: CellContentTable
}): GridProjectionInput {
  const out: {
    cells: Readonly<Record<string, string>>
    geometry?: Readonly<Record<string, BlockGeometryAsset>>
    cellGeometry?: Readonly<Record<string, string>>
    cellPalette?: Readonly<Record<string, string>>
    palette?: readonly BlockPaletteEntry[]
    cellContent?: CellContentTable
  } = { cells: payload.cells }
  if (payload.geometry !== undefined) out.geometry = payload.geometry
  if (payload.cellGeometry !== undefined) out.cellGeometry = payload.cellGeometry
  if (payload.cellPalette !== undefined) out.cellPalette = payload.cellPalette
  if (payload.palette !== undefined) out.palette = payload.palette
  if (payload.cellContent !== undefined) out.cellContent = payload.cellContent
  return out
}

/** 几何目录与逐格身份的**成对性**诊断（只有一侧 ⇒ 显式报出，不静默画错）。 */
function geometryCompletenessDiagnostic(
  payload: { readonly cellGeometry?: Readonly<Record<string, string>>; readonly geometry?: Readonly<Record<string, unknown>> },
  path: string,
): ProjectionDiagnostic | null {
  const hasCells = payload.cellGeometry !== undefined && Object.keys(payload.cellGeometry).length > 0
  const hasAssets = payload.geometry !== undefined && Object.keys(payload.geometry).length > 0
  if (hasCells === hasAssets) return null
  return Object.freeze({
    code: 'incompleteGeometryAssets' as const,
    path: `${path}.structure`,
    detail: hasCells
      ? '有逐格几何身份但缺资产目录 —— 逐格几何将退化为按身份现算（内容不同却同名同 meta 的方块会画错）'
      : '有几何资产目录但缺逐格身份 —— 目录不会被任何格引用（几何静默不生效）',
  })
}

/** 逐格内容的键是否都落在 `cells` 的键集内（否则下标网格会与方块网格错位）。 */
function cellContentKeyDiagnostic(
  payload: { readonly cells: Readonly<Record<string, string>>; readonly cellContent?: CellContentTable },
  path: string,
): ProjectionDiagnostic | null {
  const content = payload.cellContent
  if (content === undefined) return null
  const keys = Object.keys(content)
  if (keys.length === 0) return null
  const orphans = keys.filter((k) => !Object.prototype.hasOwnProperty.call(payload.cells, k))
  if (orphans.length === 0) return null
  return Object.freeze({
    code: 'cellContentKeyMismatch' as const,
    path: `${path}.structure.cellContent`,
    detail: `逐格内容有 ${orphans.length} 个键不在 cells 的键集内（首个：${orphans[0]}）—— 部件/说明会挂到不存在的格上`,
    count: orphans.length,
  })
}

/**
 * 内核文档 → 旧格式 plain JSON（**G-3 反向编码器**）。
 *
 * 逐项映射（与正向装配对偶）：
 *
 * | 内核 | 旧格式 | 说明 |
 * |---|---|---|
 * | `DocumentContent.metadata` | `meta.{name,author,description,tags,origin,created_at_ms}` + 根 `label` | 展示名同时写根 `label`（真实产物的键，见装配侧的实测说明） |
 * | `DocumentContent.frameAxis` | `frames[].{index,label,durationMs}` | 时长轴 |
 * | `DocumentContent.resources` | `textureBlobs` + `materialPalette` | 内嵌字节回 `textureBlobs`，声明回 `materialPalette` |
 * | `block` 对象的 `blockGrid` | `frames[].structure.{cellGrid,blockPalette}` | 逐格重建 |
 * | `multiblockSource` | 根 `documentShape`/`multiblock`/… + 内层 body | 多方块形态 |
 * | `annotation` 对象 | `annotations[]` | 反向合成 title/description |
 */
export function projectKernelDocument(input: KernelProjectionInput): ProjectedDocument {
  const { scene, content } = input
  const diagnostics: ProjectionDiagnostic[] = []
  const documentId = input.documentId ?? (scene.id.endsWith('-scene') ? scene.id.slice(0, -'-scene'.length) : scene.id)

  // ── ① 方块对象 → 每帧一个 structure ──
  const blockObjects: SceneObject[] = objectsInOrder(scene).filter((o) => o.type === 'block')
  const frameObjectIds = input.frameObjects ?? blockObjects.map((o) => o.id)
  const structures: { index: number; label: string | null; durationMs: number | null; structure: Record<string, unknown> | null }[] = []
  const axisFrames = content.frameAxis.frames
  for (let i = 0; i < frameObjectIds.length; i++) {
    const objectId = frameObjectIds[i]!
    const obj = findObject(scene, objectId)
    if (obj === undefined) {
      diagnostics.push(
        Object.freeze({ code: 'unsupportedObjectType' as const, path: `$.frames[${i}]`, detail: `帧对象 ${objectId} 在内核场景里不存在` }),
      )
      continue
    }
    const data = findObjectData(scene, obj.dataId)
    if (data === undefined || data.payload.kind !== 'blockGrid') {
      diagnostics.push(
        Object.freeze({
          code: 'unsupportedObjectType' as const,
          path: `$.frames[${i}]`,
          detail: `对象 ${objectId} 的载荷不是 blockGrid（实际 ${data?.payload.kind ?? '缺失'}）—— 当前文件格式承载不了它`,
        }),
      )
      continue
    }
    const projected = projectGridCells(gridProjectionInputOf(data.payload))
    if (projected.invalidCells > 0) {
      diagnostics.push(
        Object.freeze({
          code: 'invalidGridCells' as const,
          path: `$.frames[${i}].structure.cellGrid`,
          detail: `${objectId} 有无法解析的单元键/值`,
          count: projected.invalidCells,
        }),
      )
    }
    // 几何目录与逐格身份**必须成对**：只有一侧时逐格几何会静默丢失
    // （那正是"看起来能跑但画错方块"的形态，比报错更糟）。
    const geoDiag = geometryCompletenessDiagnostic(data.payload, `$.frames[${i}]`)
    if (geoDiag !== null) diagnostics.push(geoDiag)
    const contentDiag = cellContentKeyDiagnostic(data.payload, `$.frames[${i}]`)
    if (contentDiag !== null) diagnostics.push(contentDiag)
    const axis = axisFrames[i] ?? axisFrames[0]
    structures.push({
      index: axis?.index ?? i,
      label: axis?.label ?? obj.name,
      durationMs: axis?.durationMs ?? null,
      structure:
        projected.cellGrid.length === 0
          ? null
          : {
              geometryPhase: 'baked' as const,
              cellGrid: projected.cellGrid,
              blockPalette: projected.blockPalette,
              // 部件网格（契约 §2）：无部件时**不写**（与 `serialize()` 同口径）。
              ...(projected.cellPartsGrid === undefined ? {} : { cellPartsGrid: projected.cellPartsGrid, partLists: projected.partLists }),
            },
    })
  }

  // ── ② 注解对象 → annotations[] ──
  const annotations: Record<string, unknown>[] = []
  for (const obj of objectsInOrder(scene)) {
    if (obj.type !== 'annotation') continue
    const data = findObjectData(scene, obj.dataId)
    if (data === undefined || data.payload.kind !== 'annotation') continue
    const text = data.payload.text ?? ''
    // 反向合成：`title\n\ndescription` → 两个字段（正向合成的逆）。
    const [title, ...rest] = text.split('\n\n')
    annotations.push({
      id: obj.id.startsWith('annotation:') ? obj.id.slice('annotation:'.length) : obj.id,
      type: data.payload.shape,
      visible: obj.visible,
      title: title ?? '',
      description: rest.join('\n\n'),
    })
  }

  // ── ③ 资源 → textureBlobs + materialPalette ──
  //
  // ## `textureBlobs` 的**两种**形状（由契约决定，不是实现选择）
  //
  // | 文档形态 | `textureBlobs` | 依据 |
  // |---|---|---|
  // | 帧为主（V2Plain/World） | **对象**（`{"0": "<base64>", …}`） | `RuntimeDocument.serialize()` 的既有形态；`render/data/buildMaterialLibrary` 按键读 |
  // | 多方块（`documentShape: multiblock`） | **数组**（`["<base64>", …]`） | `docs/contracts/format-multiblock-doc.md:108` 逐字要求「`"textureBlobs": [ … ]`」，且 `multiblockDocument` 的解析器**显式拒绝**对象形态（实测报 `textureBlobs 必须是数组（实际 object）`） |
  //
  // ⇒ 由 `multiblockDeclaration` 的存在机械决定用哪种（与形态判别同一纪律）。
  // 这是本文件被真实夹具测试抓出的第一个缺陷：只写对象形态会让多方块产物
  // **无法被生产解析器读回**（往返断链）。
  const isMultiblock = input.multiblockDeclaration != null
  const textureBlobs: Record<string, string> = {}
  const textureBlobList: string[] = []
  const materialPalette: Record<string, unknown>[] = []
  for (let i = 0; i < content.resources.length; i++) {
    const r = content.resources[i]!
    const entry: Record<string, unknown> = { kind: r.kind }
    if (r.blend !== null) entry.blend = r.blend
    if (r.emissive !== null) entry.emissive = r.emissive
    if (r.animation !== null) entry.animation = r.animation
    if (r.atlas !== null) entry.atlas = r.atlas
    if (r.linear !== null) entry.linear = r.linear
    if (r.useMipmaps !== null) entry.useMipmaps = r.useMipmaps
    if (r.ref.url !== '') entry.locator = r.ref.url
    if (r.payload !== null) {
      textureBlobs[String(i)] = r.payload
      // 数组形态按**调色板下标**对齐（下标即索引），故空洞补空串 ——
      // 用 `push` 会让"外链资源"把后续下标整体前移，使 `textureBlobIndex` 指错条目。
      while (textureBlobList.length < i) textureBlobList.push('')
      textureBlobList.push(r.payload)
      entry.textureBlobIndex = i
    }
    materialPalette.push(entry)
  }

  // ── ④ 元数据（含根级 label —— 真实产物的展示名键） ──
  const meta: Record<string, unknown> = {
    name: content.metadata.name,
    author: content.metadata.author,
    description: content.metadata.description,
    tags: [...content.metadata.tags],
    origin: { ...content.metadata.origin },
  }
  if (content.metadata.createdAtMs !== null) meta.created_at_ms = content.metadata.createdAtMs

  // ── ⑤ 形态：由 `multiblockDeclaration` 的存在**机械决定** ──
  const plain: Record<string, unknown> = {
    format_version: '2.0',
    id: documentId,
    label: content.metadata.name,
    meta,
    frames: structures.map((s) => {
      const frame: Record<string, unknown> = { index: s.index, label: s.label, durationMs: s.durationMs }
      if (s.structure !== null) frame.structure = s.structure
      return frame
    }),
    annotations,
    labels: [],
  }
  if (isMultiblock) {
    // 多方块形态：数组（契约 `format-multiblock-doc.md:108` 逐字要求）
    if (textureBlobList.length > 0) plain.textureBlobs = textureBlobList
  } else if (Object.keys(textureBlobs).length > 0) {
    // 帧为主形态：对象（`RuntimeDocument.serialize()` 的既有形态）
    plain.textureBlobs = textureBlobs
  }
  if (materialPalette.length > 0) plain.materialPalette = materialPalette

  if (input.multiblockDeclaration != null) {
    // 多方块为主：由**类型化承载**重建内层 body 的声明节点（#289 P10d）。
    //
    // ## 这一行是本批退役"原始 JSON 回显"的落点
    //
    // 切换前这里是：
    //   `for (const [k, v] of Object.entries(input.multiblockSource)) { if (!(k in plain)) plain[k] = v }`
    // —— 把整份内层 body 的**原始 JSON 逐键摊平回产物根**。那是 R-WK-06 裁决第 3 条
    // 与 #249 §12 明文禁止的形态（「不能将原始 JSON 重新塞进核心」）。
    //
    // 现在改为**从类型化字段重建**：`multiblock` 节的每一个键都由装配期承载的类型化
    // 数据算出（`blockPalette` 由资产目录重编码、`frames` 由帧声明重建、其余由声明字段直译）。
    // ⇒ 判据是可执行的：把 `declRaw` 删掉后，本函数**仍**产出可被生产解析器读回的声明
    // （见 `__tests__/kernelProjection.test.ts` 的"去掉 declRaw 仍能读回"）。
    const rebuilt = projectMultiblockBody(input.multiblockDeclaration)
    for (const [k, v] of Object.entries(rebuilt)) {
      if (!(k in plain)) plain[k] = v
    }
    // 声明的帧**合并**到投影出的帧上（按 index 对齐）——见 `mergeDeclarationFrames`。
    mergeDeclarationFrames(plain.frames as Record<string, unknown>[], input.multiblockDeclaration.frames)
    plain.documentShape = 'multiblock'
  }

  // ── ⑥ 保真字段回写（§12 的"往返保留"；`meta.` 前缀写回 meta 子树） ──
  for (const [key, value] of Object.entries(input.fidelityFields ?? {})) {
    if (key.startsWith('meta.')) {
      meta[key.slice('meta.'.length)] = value
    } else if (!(key in plain)) {
      plain[key] = value
    }
  }

  return Object.freeze({ plain: Object.freeze(plain), diagnostics: Object.freeze(diagnostics) })
}

/**
 * 内核文档 → 旧 `RuntimeDocument`（供渲染链与保存链消费）。
 *
 * 这是"内核为权威"的落点：渲染/保存不再读旧文档，而是读**从内核投影出来的**文档。
 * 旧 `RuntimeDocument` 因此降级为**传输形状**（呈现后端要的形状），不再是权威。
 */
export function projectToRuntimeDocument(input: KernelProjectionInput): {
  readonly doc: RuntimeDocument
  readonly diagnostics: readonly ProjectionDiagnostic[]
} {
  const projected = projectKernelDocument(input)
  const plain = projected.plain
  // 走 `fromV2Plain` 而不是手工 new：它已经处理帧/网格/注解/调色板的解析，
  // 且"投影 → 解析"这条往返本身就是要被断言的性质（见测试）。
  const doc = LegacyRuntimeDocument.fromV2Plain(plain as Record<string, unknown>)
  if (doc === null) {
    // 投影出的产物必须能被生产解析器读回 —— 读不回说明投影产出了非法形状。
    // 这是一个**实现缺陷**（不是业务失败），故用空文档 + 诊断表达，
    // 而不是抛异常（纯层不抛；见 `domain/errors` 的纪律）。
    return {
      doc: LegacyRuntimeDocument.empty(),
      diagnostics: Object.freeze([
        ...projected.diagnostics,
        Object.freeze({
          code: 'unsupportedObjectType' as const,
          path: '$',
          detail: '投影产物无法被 fromV2Plain 读回（投影产出了非法形状）',
        }),
      ]),
    }
  }
  return { doc, diagnostics: projected.diagnostics }
}

/** 未使用占位：保持 `RuntimeFrame` 类型可达（下游类型推导用）。 */
export type { RuntimeFrame }
