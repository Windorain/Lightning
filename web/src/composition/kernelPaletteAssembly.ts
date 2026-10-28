/**
 * `composition/kernelPaletteAssembly` —— **旧调色板 → 内核类型化内容**。
 *
 * ## 本模块解决什么（它替代的旧机制）
 *
 * 实测的决定性事实：
 *
 * > 渲染几何的**唯一**来源是 `blockPalette[].geometry`（内嵌 BakedQuads）；
 * > 内核**只**承载 `name:meta` 字符串（`composition/kernelAssembly.ts:449`）。
 *
 * 本模块是那个缺口的补点：把旧 `Grid` 的调色板缓存 + 逐格下标，翻译成
 * `domain/blockGeometry` 的类型化资产目录与逐格资产身份。
 *
 * ## 为什么它能同时服务**帧为主**与**多方块**两条装配路径
 *
 * 两条路径的产物都是 `Grid`，而 `Grid` 的两个字段已经把全部所需事实带上了：
 *
 * | `Grid` 的字段 | 承载什么 | 来源 |
 * |---|---|---|
 * | `_paletteCache`（`Map<'#<i>', PaletteEntryMeta>`） | **每个调色板下标**的完整条目（含 `geometry`） | `_fromV2CellGrid` 逐下标 `paletteCache.set('#' + i, entry)`；`context/multiblock/palette#buildPalette` 同一手法 |
 * | `SlotBlock.paletteIndex` | 该格用的是**哪个**下标 | 解析期原样保留 |
 *
 * ⇒ "这一格是哪份几何"可以精确恢复，**不需要**回显原始 JSON，也**不需要**按
 * `name:meta` 猜（后者会把 33 种线缆塌成 1 种 —— 见 `domain/blockGeometry` 判据 2）。
 *
 * ## 键是 `#<下标>` 而不是 `name:meta`（实测，可复现）
 *
 * `pure/string#blockKey` 逐字写着：`` if (b.paletteIndex !== undefined) return '#' + … ``
 * —— 即**解析来的**方块按**下标**寻址，只有**编辑新增的**方块（无 `paletteIndex`）
 * 才回落 `name:meta`。这条区分正是位置特异几何能活下来的原因。
 * 本模块**忠实沿用**同一判据（不另立第二套）。
 *
 * ## 编辑新增的方块怎么办（如实降级，不伪造）
 *
 * 用户在 web 端手绘的方块没有 `paletteIndex`，其几何由生产代码按方块身份现算
 * （`renderMode: 'BlockModel'`，真实产物在 `context/runtimeDocument.ts:454` 同一手法）。
 * 这类条目**没有几何资产**（`geometry: null`）—— 那是**显式**事实，不是"空几何"：
 * 呈现侧据此走"按身份现算"的既有路径（能力不回退），而"这份方块有烘焙几何"
 * 与"这份方块需要现算"在类型上是两个不同的状态。
 *
 * ## 纯度
 *
 * 本模块是**装配层**（`composition/`），允许引用各层实现。
 * 它只做映射：不决定"要不要重建"、不持有状态、不做 IO。
 */

import { blockPaletteEntryKey, decodeBlockGeometry, blockGeometryAsset, type BlockGeometryAsset, type BlockPaletteEntry } from '@/domain/blockGeometry'
import { cellContent, type CellContent, type PartRecord } from '@/domain/cellContent'
import { cellPositionKey } from '@/domain/cellPosition'
import type { Grid, PaletteEntryMeta } from '@/context/grid'
import type { AssemblyDiagnostic } from './kernelAssembly'

/** 一次调色板装配的产物（类型化内容 + 诊断）。 */
export interface AssembledPalette {
  /** 逐格 → `assetId`（键与方块单元同一套；**只含**真的是烘焙几何的格）。 */
  readonly cellGeometry: Readonly<Record<string, string>>
  /**
   * 逐格 → **调色板条目内容键**（`blockPaletteEntryKey`）。
   *
   * 见 `domain/scene#ObjectDataPayload` 的 `cellPalette` 字段注释：文件的
   * **分区块状态槽**是载荷承重的（渲染侧同调色板剔除按条目判），而单元值编码
   * （`minecraft:<name>:<meta>`）表达不了它（丢命名空间、且同 name:meta 同几何
   * 但条目不同的方块分不开）。故逐格显式承载。
   */
  readonly cellPalette: Readonly<Record<string, string>>
  /**
   * 逐格 → **文件里的调色板槽位**（= legacy `SlotBlock.paletteIndex`）。
   *
   * ## 为什么在装配期原样抄下来
   *
   * `palette` 是**按内容去重的稳定序**（`entryByKey.values()`）—— 它的数组位置
   * 与文件槽位**无关**。而三个旧消费点按槽位取值，且既定口径明确
   * 「投影下标跨网格不可移植为实测事实；改下游键口径 = 行为变更不做」
   * ⇒ 槽位必须**原样承载**，不能在读取侧复算（复算会得到另一个数，
   * 因为去重序 ≠ 文件序）。
   */
  readonly cellPaletteIndex: Readonly<Record<string, number>>
  /** 资产目录（`assetId` → 资产）。多格同 id ⇒ 一份资产（共享前提）。 */
  readonly assets: Readonly<Record<string, BlockGeometryAsset>>
  /** 该网格引用的调色板条目（按内容去重后的稳定序）。 */
  readonly palette: readonly BlockPaletteEntry[]
  /** 逐格内容（部件 / 逐格说明）；空表表示该网格无逐格内容。 */
  readonly cellContent: Readonly<Record<string, CellContent>>
  readonly diagnostics: readonly AssemblyDiagnostic[]
  /** 统计（诊断与证据用）。 */
  readonly stats: AssembledPaletteStats
}

export interface AssembledPaletteStats {
  /** 非空气格数。 */
  readonly cells: number
  /** 参与装配的调色板下标数（含 air）。 */
  readonly paletteIndexes: number
  /** 有烘焙几何的调色板下标数。 */
  readonly withGeometry: number
  /** 唯一几何资产数（< `withGeometry` 即发生了共享）。 */
  readonly uniqueAssets: number
  /** 逐格内容条目数。 */
  readonly contentCells: number
  /** 带部件的格数。 */
  readonly partCells: number
}

/** 诊断构造器（装配层的稳定码联合在本模块之外，故此处收 `string`）。 */
export type PaletteDiagnosticSink = (code: string, path: string, detail: string) => AssemblyDiagnostic

/** 诊断码（本模块产出；由调用方并入 `AssemblyDiagnostic[]`）。 */
export const PALETTE_DIAGNOSTIC_CODES = Object.freeze({
  decodeSkippedQuads: 'blockGeometrySkippedQuads',
  geometryWithoutAsset: 'blockGeometryNoAsset',
} as const)

/**
 * 逐格 + 调色板缓存 → 内核类型化内容。
 *
 * ## 调用点
 *
 * 帧为主路径（`assembleKernelDocument` ③）与多方块路径（⑧）**共用**本函数 ——
 * 于是"两条路径的几何承载方式是否一致"这个问题在结构上不存在（同一实现）。
 */
export function assemblePaletteContent(
  grid: Grid,
  diag: PaletteDiagnosticSink,
): AssembledPalette {
  const cache = grid.getPaletteCache()
  const assets: Record<string, BlockGeometryAsset> = {}
  const cellGeometry: Record<string, string> = {}
  const cellPalette: Record<string, string> = {}
  /** 逐格 → 文件槽位（见 `AssembledPalette.cellPaletteIndex` 的说明）。 */
  const cellPaletteIndex: Record<string, number> = {}
  const content: Record<string, CellContent> = {}
  const diagnostics: AssemblyDiagnostic[] = []

  /** 调色板下标 → 条目（去重后按内容键索引；`null` = 无几何）。 */
  const entryByKey = new Map<string, BlockPaletteEntry>()
  /** 调色板下标 → `assetId`（`''` = 无几何）。 */
  const assetIdByIndex = new Map<number, string>()
  /** 调色板下标 → 该下标对应的**条目内容键**（`''` = 无缓存条目的编辑新增方块）。 */
  const entryKeyByIndex = new Map<number, string>()
  /** 已被解过码的下标（同一份缓存条目只解一次 —— 多格共享时避免重复解码）。 */
  const decoded = new Set<number>()
  let paletteIndexes = 0
  let withGeometry = 0
  let cells = 0
  let partCells = 0

  const indexOfBlock = (b: { readonly paletteIndex?: number }): number | undefined =>
    typeof b.paletteIndex === 'number' ? b.paletteIndex : undefined

  /** 取（或建）某调色板下标对应的类型化条目；返回其 `assetId` 与**内容键**。 */
  const resolveIndex = (index: number, pos: { x: number; y: number; z: number }): { assetId: string; entryKey: string } => {
    const hit = entryKeyByIndex.get(index)
    if (hit !== undefined) {
      return { assetId: assetIdByIndex.get(index) ?? '', entryKey: hit }
    }
    paletteIndexes += 1
    const meta = cache.get(`#${index}`) as PaletteEntryMeta | undefined
    if (meta === undefined) {
      // 编辑新增的方块无缓存条目（`renderMode: 'BlockModel'`，几何由生产按身份现算）。
      // **显式**登记为无几何条目，不伪造一个空几何。
      assetIdByIndex.set(index, '')
      entryKeyByIndex.set(index, '')
      return { assetId: '', entryKey: '' }
    }
    const entry = entryFromLegacy(index, meta, decoded, diagnostics, diag, pos)
    // 去重键用**条目全部内容**（`blockPaletteEntryKey`）——实测：只按
    // (registryId, meta, assetId) 会合并本该分开的条目，从而改变渲染侧的
    // 同调色板邻面剔除结果（4882 → 4862 三角形）。见该函数的注释。
    const key = blockPaletteEntryKey(entry)
    if (!entryByKey.has(key)) entryByKey.set(key, entry)
    if (entry.geometry !== null) {
      withGeometry += 1
      if (!Object.prototype.hasOwnProperty.call(assets, entry.assetId)) assets[entry.assetId] = entry.geometry
    }
    assetIdByIndex.set(index, entry.assetId)
    entryKeyByIndex.set(index, key)
    return { assetId: entry.assetId, entryKey: key }
  }

  grid.forEach((pos, block) => {
    cells += 1
    const cellKey = cellPositionKey(pos)
    const index = indexOfBlock(block)
    if (index !== undefined) {
      const resolved = resolveIndex(index, pos)
      if (resolved.assetId !== '') cellGeometry[cellKey] = resolved.assetId
      // 逐格条目键：**无条件**记录（无几何的条目也要能投影回它的呈现提示）
      cellPalette[cellKey] = resolved.entryKey
      // 文件槽位：与 `cellPalette` 同条件记录（两者描述的是**同一格**的同一个条目，
      // 一个是身份（内容键）、一个是槽位（文件表达手段）⇒ 缺一即不成对）。
      cellPaletteIndex[cellKey] = index
    }

    // ── 逐格内容（**部件**）──────────────────────────────────────────────
    //
    // 只处理部件：它的数据源是 `Grid._cellParts`（解析期已随宿主格落定），
    // 故在逐格遍历里天然可得。
    //
    // **逐格说明**（`cellTooltipGrid` + `tooltipPalette`）**不在这里**：
    // 它的数据源是**文档级**字段（池 + 与 `cellGrid` 同形的下标网格），
    // 而本函数的输入只有 `Grid`（它不携带那两层）。把它硬塞进来会要求本函数
    // 额外接收文档级参数 —— 而那正是"两条装配路径的调用面漂移"的来源。
    // ⇒ 由 `assembleKernelDocument` 在**文档粒度**统一处理（见那里的 ⑦）。
    const parts = grid.partsAt(pos)
    if (parts !== null && parts.length > 0) {
      // `Grid.partsAt` 返回旧层 `PartRecord[]`（`pure/partTypes`）。内核承载的是
      // `domain/cellContent#PartRecord` —— 两者**逐字段同形**（都是契约 §3 的五要素），
      // 因为契约是同一份（`docs/contracts/format-parts-contract.md`）。
      // 这里用**结构赋值**而不是逐字段重建：重建会引入"哪些字段被搬了"的第二份清单，
      // 而漂移的后果是"部件的某个字段在往返后消失"（静默丢语义）。
      content[cellKey] = cellContent({ parts: parts as unknown as readonly PartRecord[] })
      partCells += 1
    }
  })

  return Object.freeze({
    cellGeometry: Object.freeze(cellGeometry),
    cellPalette: Object.freeze(cellPalette),
    cellPaletteIndex: Object.freeze(cellPaletteIndex),
    assets: Object.freeze(assets),
    palette: Object.freeze([...entryByKey.values()]),
    cellContent: Object.freeze(content),
    diagnostics: Object.freeze(diagnostics),
    stats: Object.freeze({
      cells,
      paletteIndexes,
      withGeometry,
      uniqueAssets: Object.keys(assets).length,
      contentCells: Object.keys(content).length,
      partCells,
    }),
  })
}

/**
 * 逐格说明（`tooltipPalette` + `cellTooltipGrid`）→ 内核逐格内容。
 *
 * ## 为什么不从 `blockPalette[i].tooltip` 读
 *
 * 两种形态在真实产物里**都存在**，且语义不同：
 *
 * | 形态 | 位置 | 语义 |
 * |---|---|---|
 * | `blockPalette[i].tooltip` | 条目级 | 「这个方块**是什么**」——随方块身份走 |
 * | `tooltipPalette` + `cellTooltipGrid` | 文档级 + 下标网格 | 「这一格**人工标注**了什么」——叠加层，`-1` = 无 |
 *
 * 前者已由 {@link assemblePaletteContent} 作为条目字段承载（`BlockPaletteEntry.tooltip`），
 * 故本函数只处理后者。两者若混成一个字段，就会让"改一句标注"看起来像
 * "改了这个方块的定义"（而后者会换几何资产身份）。
 *
 * ## 下标网格的 `-1` 哨兵在此**被吸收**
 *
 * `TOOLTIP_GRID_NONE = -1` 是文件格式的哨兵。内核的 `CellContent.tooltip`
 * 用**字段缺席**表达"无"（见 `domain/cellContent` 判据 3）—— 于是 `-1`
 * 不会有第二个消费者需要重新解释它。
 *
 * ## 行序翻转（本函数是**投影侧**的翻转点）
 *
 * `cellTooltipGrid` 的 row 0 = 顶部；内核键是世界坐标（`y = 0` 为底）。
 * 翻转沿用 `structureRowToWorldY` —— 与解析期（`_fromV2CellGrid`）**同一个函数**，
 * 故两处不可能漂移（`render/data/grid.ts` 再导出它，本模块经公共出口取）。
 */
export function assembleTooltipContent(input: {
  readonly cellTooltipGrid: readonly (readonly (readonly number[])[])[] | undefined
  readonly tooltipPalette: readonly unknown[] | undefined
  readonly sizeRow: number
}): Readonly<Record<string, CellContent>> {
  const grid = input.cellTooltipGrid
  const palette = input.tooltipPalette
  if (!Array.isArray(grid) || !Array.isArray(palette)) return Object.freeze({})
  const out: Record<string, CellContent> = {}
  for (let z = 0; z < grid.length; z++) {
    const slice = grid[z]
    if (!Array.isArray(slice)) continue
    for (let row = 0; row < slice.length; row++) {
      const rowArr = slice[row]
      if (!Array.isArray(rowArr)) continue
      const y = input.sizeRow - 1 - row
      for (let x = 0; x < rowArr.length; x++) {
        const idx = rowArr[x]
        if (typeof idx !== 'number' || idx < 0 || idx >= palette.length) continue
        const text = palette[idx]
        if (typeof text !== 'string') continue
        out[cellPositionKey({ x, y, z })] = cellContent({ tooltip: text })
      }
    }
  }
  return Object.freeze(out)
}

/** 旧调色板条目 → 内核类型化条目（含几何解码与诊断）。 */
function entryFromLegacy(
  index: number,
  meta: PaletteEntryMeta,
  decoded: Set<number>,
  diagnostics: AssemblyDiagnostic[],
  diag: PaletteDiagnosticSink,
  pos: { x: number; y: number; z: number },
): BlockPaletteEntry {
  const registryId = typeof meta.registryId === 'string' ? meta.registryId : ''
  const metaNum = typeof (meta as { meta?: unknown }).meta === 'number' ? ((meta as unknown as { meta: number }).meta) : 0
  let geometry: BlockGeometryAsset | null = null
  if (!decoded.has(index)) {
    decoded.add(index)
    const dec = decodeBlockGeometry(meta.geometry as never)
    if (dec !== null) {
      if (dec.skipped.length > 0) {
        // **不静默**：被跳过的四边形逐条报出（"少画了一个面"必须是可见事实）。
        diagnostics.push(
          diag(
            PALETTE_DIAGNOSTIC_CODES.decodeSkippedQuads,
            `$.blockPalette[${index}]`,
            `调色板条目 ${registryId}:${metaNum} 有 ${dec.skipped.length} 个四边形被跳过（首个原因：${dec.skipped[0]!.reason} @ quads[${dec.skipped[0]!.quadIndex ?? '-'}]）`,
          ),
        )
      }
      geometry = blockGeometryAsset(dec.quads)
      if (geometry === null && dec.quads.length > 0) {
        diagnostics.push(diag(PALETTE_DIAGNOSTIC_CODES.geometryWithoutAsset, `$.blockPalette[${index}]`, `调色板条目 ${registryId}:${metaNum} 的拓扑不合法（${dec.quads.length} 个四边形未产出资产）`))
      }
    }
  }
  void pos
  const entry: {
    assetId: string
    registryId: string
    meta: number
    renderMode: string
    geometry: BlockGeometryAsset | null
    occludesAdjacentFaces?: boolean
    facing?: BlockPaletteEntry['facing']
    nbt?: Readonly<Record<string, unknown>>
    thumbnail?: string
    tooltip?: readonly string[]
  } = {
    assetId: geometry?.id ?? '',
    registryId,
    meta: metaNum,
    renderMode: typeof meta.renderMode === 'string' ? meta.renderMode : 'BakedModel',
    geometry,
  }
  if (typeof meta.occludesAdjacentFaces === 'boolean') entry.occludesAdjacentFaces = meta.occludesAdjacentFaces
  if (typeof meta.facing === 'string') entry.facing = meta.facing as BlockPaletteEntry['facing']
  if (meta.nbt !== undefined && meta.nbt !== null) entry.nbt = meta.nbt
  if (typeof meta.thumbnailPNG === 'string') entry.thumbnail = meta.thumbnailPNG
  if (Array.isArray(meta.tooltip)) entry.tooltip = Object.freeze([...meta.tooltip])
  return Object.freeze(entry)
}
