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
 * ### 2b. 而**网格尺寸**相反：它是**文件声明的事实**，必须由载荷携带（#262 P11-A）
 *
 * 两者不矛盾 —— 它们是两条不同的纪律，判据也各不相同：
 *
 * | 事实 | 谁能决定 | 为什么 |
 * |---|---|---|
 * | 文档**形态** | **内容**（`multiblock` 在不在） | 形态是内容的函数；让调用方声明会造出自相矛盾的文件 |
 * | 网格**尺寸** | **文件声明**（`sizeColumn/sizeRow/sizeZSlice`） | `cells` 是稀疏键表 ⇒ 尺寸**推不出来**；按内容推会在"尾层/尾列全空"时**丢掉声明**（保存一次就缩水） |
 *
 * ⇒ 载荷带声明 ⇒ 按声明输出；不带（内核自创内容）⇒ 维持"尺寸由内容决定"。
 * 判别子与读面 `runtime/gridRead#declaredGridSize` **同一份判定**（同一事实两处消费）。
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
// `-1` 哨兵：取**适配层**的定义点（`adapters/files/legacyFields`，与编解码同层）。
//
// ## 为什么不直接 import `render/schema/types`（本批被架构闸门判红后的一处分层更正）
//
// 第一版从 `@/render/schema/types` 取它，`gate/no-private-cross-layer` 当场判红：
// `composition/` 是**新实现**层，跨层导入 `render/schema/types`（深度 3）
// 超出公共出口深度 2。判红是**对的** —— 该常量是**文件格式**的哨兵
// （"该格无 ToolTip"的编码），不是渲染层的概念；适配层已有一份同值定义
// （`legacyFields.ts:145` 逐字注明它与 `render/schema/types` 同源）。
// ⇒ 取适配层那份，既在同一层内，也不增加第三个字面量。
import { tooltipPoolOf } from '@/adapters/tooltipPool'
// 「什么算一份合法的声明尺寸」的**唯一**定义点（读面/写面共用同一判定 —— #262 P11-A）。
import { declaredGridSize } from '@/runtime/gridRead'
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
  /**
   * 落在**声明尺寸之外**的格数（`undefined` = 无此事）。
   *
   * 载荷声明了尺寸而内容越界 ⇒ 维度按**内容扩张**（见 {@link projectGridCells} 的裁决），
   * 本计数让"产物比声明大"这一事实**可观测**（不被静默吞掉）。
   * 缺席而非 `0`：与 `cellPartsGrid?` 同一"缺省即无"口径。
   */
  readonly outsideDeclaredCells?: number
}

/** 投影用的**网格内容**（类型化承载的投影面）。 */
export interface GridProjectionInput {
  readonly cells: Readonly<Record<string, string>>
  /**
   * **网格的声明尺寸**（`sizeColumn` = x 宽、`sizeRow` = y 高、`sizeZSlice` = z 深）。
   *
   * ## 为什么投影**必须**能拿到它（#262 P11-A；D-1 事实的第二处消费方）
   *
   * `cells` 是**稀疏**键表（`"x,y,z"` → 方块身份），故"网格多大"**推不出来**。
   * 修前本函数按 `max(x)+1 / max(y)+1 / max(z)+1` 推（内容包围盒）⇒
   * **声明尺寸 > 包围盒**的文档（稀疏尾层：尾切片/尾列/顶行全空）保存后 `cellGrid`
   * **缩小**，文件声明的尺寸事实在保存时**丢失**（实测：声明 6×5×4 的文档
   * 投影成 2×4×2，见 `__tests__/p11aProjectionSize.test.ts` ① 组）。
   *
   * ## 两条路径的判别子就是"载荷带没带这三个字段"（与读面同构）
   *
   * | 情形 | 来源 | 输出维度 |
   * |---|---|---|
   * | 三字段**在场** | 从文件加载的文档（`kernelAssembly#gridPayload` 抄 `Grid.width/height/depth`，D3 已接通） | **声明尺寸**（缺位补 `AIR_PALETTE_INDEX`） |
   * | 三字段**缺席** | 内核**自创**内容（无文件声明：手工构造/未来由命令新建的网格） | 内容包围盒（**维持**既有口径） |
   *
   * 与 `runtime/gridRead#declaredGridSize` 是**同一份判定**（同一事实两处消费）
   * —— 那里服务"读面尺寸"，这里服务"投影维度"。
   */
  readonly sizeColumn?: number
  readonly sizeRow?: number
  readonly sizeZSlice?: number
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
 *
 * ## 尺寸的口径（#262 P11-A）
 *
 * 输出维度 = `max(载荷声明, 内容包围盒)`（逐轴；声明缺席则退化为包围盒）。
 * 声明**大于**包围盒 ⇒ 尾层/尾列补 `AIR_PALETTE_INDEX`（声明必须活下来）；
 * 声明**小于**包围盒（畸形输入）⇒ 按内容扩张并由
 * {@link ProjectedGrid.outsideDeclaredCells} 显式计数（编码器**不得丢内容**）。
 */
export function projectGridCells(input: GridProjectionInput): ProjectedGrid {
  const cells = input.cells
  const cellGeometry = input.cellGeometry ?? {}
  const assets = input.geometry ?? {}
  const typedPalette = input.palette ?? []
  const cellContent = input.cellContent ?? {}
  const cellPalette = input.cellPalette ?? {}

  // 先解析全部单元。
  //
  // ## ⚠️ 尺寸**不是**由内容决定的（#262 P11-A 修的那条；旧注释在此逐字写反过）
  //
  // `cells` 是稀疏键表 ⇒ "网格多大"推不出来。故维度取
  // **`max(载荷声明, 内容包围盒)`**（逐轴），两条事实各有其位：
  //
  // | 输入 | 维度 | 为什么 |
  // |---|---|---|
  // | 载荷**带**声明（文件加载的文档） | 声明尺寸 | 声明是**文件的事实**：尾层/尾列全空时包围盒更小，按包围盒输出就是**保存时丢掉声明**（本批修的就是它） |
  // | 载荷**不带**声明（内核自创内容） | 内容包围盒 | 没有任何声明可依 —— **维持**既有口径（与读面 `resolveGridSize` 同构：声明优先、缺省降级） |
  //
  // ## 为什么是 `max` 而不是"严格按声明"（畸形输入的裁决）
  //
  // 内容是**用户数据**，声明是**元信息**：声明比内容小（手工构造/越界写入的畸形输入）时，
  // 「截断到声明」会**静默丢掉方块**（#171 硬底线），而「按内容扩张」只让产物比声明大
  // —— 零丢失，且从第二轮起稳定（新文件声明了更大的尺寸 ⇒ 声明 ⊇ 包围盒）。
  // 越界事实由 {@link ProjectedGrid.outsideDeclaredCells} **显式计数**（见
  // `projectKernelDocument` 的 `cellsOutsideDeclaredSize` 诊断），不静默吞。
  // 生产装配的 `cells` 由 `gridPayload` 从有界 `Grid` 迭代产出 ⇒ 该分支今天不可达；
  // 它存在是为了让"将来某条写入路径越界"**不会变成丢格或抛异常**。
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
  const declared = declaredGridSize(input)
  // 无声明 **且** 无内容 ⇒ "没有网格"（`[]`）—— 与"0 宽的网格"是两种状态
  // （见 `runtime/gridRead#resolveGridSize` 的同口径说明）。
  if (declared === null && parsed.length === 0) {
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
  // 包围盒（**仅**作降级值与下界，不再单独决定尺寸）。
  const boundsWidth = parsed.length === 0 ? 0 : maxX + 1
  const boundsHeight = parsed.length === 0 ? 0 : maxY + 1
  const boundsDepth = parsed.length === 0 ? 0 : maxZ + 1
  const width = declared === null ? boundsWidth : Math.max(declared.width, boundsWidth)
  const height = declared === null ? boundsHeight : Math.max(declared.height, boundsHeight)
  const depth = declared === null ? boundsDepth : Math.max(declared.depth, boundsDepth)
  const outsideDeclaredCells =
    declared === null
      ? 0
      : parsed.filter((c) => c.x >= declared.width || c.y >= declared.height || c.z >= declared.depth).length

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
    ? { cellGrid, blockPalette, invalidCells, ...(outsideDeclaredCells === 0 ? {} : { outsideDeclaredCells }) }
    : {
        cellGrid,
        blockPalette,
        cellPartsGrid: parts.cellPartsGrid,
        partLists: parts.partLists,
        invalidCells,
        ...(outsideDeclaredCells === 0 ? {} : { outsideDeclaredCells }),
      }
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
  /**
   * ## ⚠️ 命名空间必须回**真实**值（#301 P10f D2 修，登记 D9）
   *
   * 本函数的 `registryId` 入参是 GF-7 的单元值编码产物 —— `minecraft:<name>:<meta>`
   * 里的 `<name>` 已被 `blockCellValue` 截去命名空间（忠实于生产既有编码，
   * 见上面 ① 的说明）。于是**旧行为**把它原样写进产物的调色板 ⇒
   * `tectech:gt.godforgecasing` / `gregtech:gt.blockmachines` /
   * `appliedenergistics2:tile.BlockCableBus` 全部塌成 `minecraft:…`。
   *
   * 那是**真实的数据改写**（不是表示差异）：实测真实信封夹具 68 条调色板里
   * **66 条**命名空间被改写，`cellGrid` 逐格方块身份 **798 格中 172 格**不同
   * （探针 `temp/p10f/probe/keys4`）。消费者是**身份**语义：
   * `runtime/presentationAdapter#structureDigestOf` 的 `registryId@meta` 调色板身份、
   * `pure/itemOutlinePlan` 的 `block_state_id`、`embed/useEmbedTooltip` 的
   * `blockRegistryKeyForPalette` 注册键 —— 命名空间错 = 身份错。
   *
   * 而**类型化条目手里就有真值**（`kernelPaletteAssembly` 从文件条目原样承载）。
   *
   * ### 只在"内容键**精确**命中"时采信（不能更宽 —— 本批实测边界）
   *
   * | 命中路径 | 是否采信 `typed.registryId` | 理由 |
   * |---|---|---|
   * | ⓪ `cellPalette` 内容键精确命中（`typedExact`） | ✅ | 就是那一条，无歧义 |
   * | ① `assetId` **几何身份**命中 | ❌ **不采信** | **几何身份不唯一**：实测 `multiblock-ebf-2ch` 的 `gregtech:gt.blockcasings@11` 与 `gregtech:gt.blockmachines@1000` **共享同一个** `assetId = geo:e82d564e`（烘焙四边形逐位相同）⇒ `typedByAsset` 只留首条 ⇒ 采信它会把 EBF 控制器写成机壳（**正确的 meta + 错误的命名空间**，比"有损但一致"更坏：它让身份**不一致**且看不出来）。这正是判据"不得瞎猜"的落点。 |
   * | ② 精确三元组（键里含 `registryId` 本身） | ➖ | 采信与不采信**同值**，无差别 |
   * | ③ `(name 尾段, meta)` 兜底 | ❌ **不采信** | 同尾段不同命名空间可能有两条（`typedByNameMeta` 只留首条）⇒ 猜会**引入**错误身份 |
   *
   * ⇒ 无 `cellPalette` 时**如实保留** GF-7 的有损形态（`minecraft:<name>`）：
   * 那是"丢命名空间"，但**不会错配**（方块身份仍由 `(tail, meta)` 唯一确定）。
   * 而生产的两条投影入口（`kernelProjection#gridProjectionInputOf` 与
   * `projectMultiblockBody`）都**给出了**精确身份 ⇒ 生产产物拿到真命名空间
   * （负对照见 `p10fSaveProjection.test.ts` 的 D9 组）。
   */
  const typedIdentityExact = typedExact !== null
  const realRegistryId = typedIdentityExact && typed !== null && typed.registryId !== '' ? typed.registryId : registryId
  const out: Record<string, unknown> = {
    registryId: realRegistryId,
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
 *
 * ## 维度**继承**投影产物（#262 P11-A 的关键）
 *
 * `width/height/depth` 逐字取自 `projected.cellGrid` 的三维 —— 于是
 * `projectGridCells` 的尺寸口径（声明优先）在此**自然正确**，本函数**不**再
 * 自己判一次尺寸（那会造出第二份会漂移的判定：修了投影、忘了这里 = 保存产物仍缩水）。
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
  /**
   * `blockGrid` 载荷里有格**落在声明尺寸之外**（已按内容扩张维度，`count` = 越界格数）。
   *
   * 维度取"声明 ⊔ 包围盒"（见 `projectGridCells` 的裁决）⇒ 产物比声明**大**：
   * 消费者据此知道"这份文档的声明与内容不一致"，而不是让扩张静默发生。
   */
  | 'cellsOutsideDeclaredSize'
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
/**
 * **类型化声明的投影面**（`multiblock` 节里所有**有名字段**的值）。
 *
 * ## 为什么它必须存在（本批实测抓出的一处真实缺口）
 *
 * 第一版的 `projectMultiblockBody` 从 `declRaw` 回落声明字段 —— 即"声明仍靠原始
 * JSON"。这一点被**零回显判别实验**当场抓出：把 `declRaw` 清空后投影产物
 * **读不回**（`expected null not to be null`），证明它当时是**承重**的。
 *
 * ⇒ 本类型把声明里所有被生产解析器**校验过**的字段显式列出来。
 * 它们的值来自 `context/parsers/multiblockDocument` 产出的 `MultiblockDecl`
 * （通道有 `key`/`name`/`kind`/`min`/`max`/`domain`/`slider`；规则有 `phase`/
 * `kind`/`guard`/`sel`/`indexTable`/`indexAliases`；骨架阶有带 `cellGrid` 的
 * `sizeSteps`）—— **不是** `Record<string, unknown>` 的原文。
 *
 * 于是 `declRaw` 的角色收窄为**扩展键保真**（`viewerSemantics`/未来的族特有键），
 * 而不是"整个声明的来源"。
 */
export interface KernelTypedDeclaration {
  readonly sourceClass?: string
  readonly hasScopeOverlap: boolean
  readonly scopeOverlapNote?: string
  readonly totalTierDomain: Readonly<Record<string, unknown>>
  readonly tierSample: readonly number[]
  readonly channels: readonly Readonly<Record<string, unknown>>[]
  readonly runstates: readonly Readonly<Record<string, unknown>>[]
  readonly variants: readonly Readonly<Record<string, unknown>>[]
  readonly rules: readonly Readonly<Record<string, unknown>>[]
  readonly backbone: Readonly<Record<string, unknown>>
  readonly couplings: readonly Readonly<Record<string, unknown>>[]
  readonly couplingMode: string
  readonly notes: readonly Readonly<Record<string, unknown>>[]
  readonly paletteSource: string
  readonly geometryEncoding: string
  readonly opsLegend: Readonly<Record<string, string>>
}
export interface KernelDeclarationProjection {
  /** 声明 id（写回内层 body 的 `multiblock.id`）。 */
  readonly id: string
  readonly displayName: string
  /** **类型化声明字段**（见 {@link KernelTypedDeclaration}）——投影的**主**来源。 */
  readonly declaration: KernelTypedDeclaration
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
  /**
   * **场景声明**（写回内层 body 的 `frames` 键：变体/运行态/骨架阶/规则引用）。
   *
   * 领域叫「场景」（M5-1）；键名 `frames` 属**文件格式**，只在边界出现。
   */
  readonly scenes: readonly KernelSceneDeclaration[]
  /** 契约/payload 的 `schemaVersion`。 */
  readonly schemaVersion: number | null
  readonly multiblockCount: number
}

/** 一个**场景的声明面**（投影用；网格由 `blockGrid` 载荷另行重建）。 */
export interface KernelSceneDeclaration {
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
  /**
   * **写回态**的注解行（全保真；#301 P10f D2）。
   *
   * ## 为什么它必须与渲染态分开（不是一个可选优化）
   *
   * 本函数默认**就地合成**渲染态注解（只有 `id`/`type`/`visible`/`title`/`description`
   * —— "够画即可"）。而保存/导出需要**全保真**：漏掉 `locked` 会让"锁定即只读"
   * 失效，漏掉几何 `min`/`max`/`pos`/`points` 会让注解**位置丢失**。
   * 实测：`locked`/`frameIndex`/`created_at`/`min`/`max` 经渲染态投影后**全部变 `null`**。
   *
   * ⇒ 写回路径**必须**传本字段（来源是 `runtime/annotationRead#projectAnnotationsToLegacy`）。
   * 不传 ⇒ 保持既有渲染行为（零变化）。
   *
   * ⚠️ 本函数**不**自己实现全保真那份：再写一遍就是第二份会漂移的实现。
   */
  readonly annotationRows?: readonly Readonly<Record<string, unknown>>[]
  /** 文档 id（缺省用 `scene.id` 去掉 `-scene` 后缀）。 */
  readonly documentId?: string
  /**
   * **渲染视图模式**（#289 P10d D1 补充）：把装配出的网格注入"当前帧 + 首帧"，
   * 并**不**写 `multiblock` 节点 —— 与旧 `buildMultiblockRenderView` 同语义。
   *
   * ## 为什么需要它（本批实测抓出的一处**形态混淆**）
   *
   * 旧实现有**两个**不同的投影，它们服务于两个不同的消费者：
   *
   * | 消费者 | 函数 | 形态 |
   * |---|---|---|
   * | 保存（写回文件） | `RuntimeDocument.serialize()` | `multiblock` 节点 + **全部**变体帧（**不带** `structure`） |
   * | 渲染（DRW 的输入） | `buildMultiblockRenderView(doc, result, frameIndex)` | **没有** `multiblock` 节点 + 首帧/当前帧带装配出的 `structure` |
   *
   * 本批修"全声明帧产出"后，`projectKernelDocument` 正确地对齐了**保存**形态；
   * 而渲染侧要的是另一个形态（网格在帧里）。把两者混为一谈会让渲染拿不到网格
   * （实测：`resolveRenderBundle` 抛 `StructureData 须为 geometryPhase=baked 的终态`）。
   *
   * ## 为什么不写 `multiblock` 节点（旧注释逐字给出的理由）
   *
   * `serialize()` 会优先写多方块节点，其中的根级 `blockPalette` 是**并集调色板**
   * （下标是并集下标），而首帧 `structure` 的 `blockPalette` 是"装配网格里实际
   * 出现的方块"**重编号**后的调色板。两者混用会让 `cellGrid` 指向错误的条目
   * —— 静默渲染错方块。故渲染视图**只**保留帧内那一份自洽的 `cellGrid + blockPalette`。
   */
  readonly renderView?: Readonly<{ readonly frameIndex: number }>
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

  // ① 扩展键保真（打底；**只**为类型化未覆盖的键留位）。
  const mb: Record<string, unknown> = { ...declaration.declRaw }
  // ② **类型化字段全部覆盖**（它们赢；`KernelTypedDeclaration` 逐字段列出）。
  //
  // 写序是判据的一部分：若把 ② 与 ① 调换，"类型化内容编辑了但导出还是旧的"
  // 就会成为一个必然的静默缺陷（本文件头判据 1 要防的正是它）。
  const d = declaration.declaration
  mb.id = declaration.id
  mb.displayName = declaration.displayName
  mb.couplingMode = d.couplingMode
  mb.totalTierDomain = d.totalTierDomain
  mb.tierSample = d.tierSample
  mb.channels = d.channels
  mb.runstates = d.runstates
  mb.variants = d.variants
  mb.rules = d.rules
  mb.backbone = d.backbone
  mb.couplings = d.couplings
  mb.notes = d.notes
  mb.paletteSource = d.paletteSource
  mb.geometryEncoding = d.geometryEncoding
  mb.opsLegend = d.opsLegend
  mb.hasScopeOverlap = d.hasScopeOverlap
  if (d.sourceClass !== undefined) mb.sourceClass = d.sourceClass
  if (d.scopeOverlapNote !== undefined) mb.scopeOverlapNote = d.scopeOverlapNote
  // `viewerSemantics` **不**在此列：它是类型化未覆盖的扩展键，由 ① 的 `declRaw` 保留。
  // 这样的键每一批都可能新增，而"哪些键还没类型化"应当**显式可见**（就是这里没有的键）。
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
  // **不写 `frames`** —— 见 {@link projectMultiblockScenes} 的说明：
  // 多方块的「帧」是**场景**（变体存储原语），由该函数整份产出（不是本函数）。
  return out
}

/**
 * 多方块文档的 `frames` —— **全部声明帧**，每帧不带 `structure`。
 *
 * ## 本批（#289 P10d D1 补充）修掉的一处**真实丢失**
 *
 * 切换前的实现（`mergeDeclarationFrames`）把声明帧"合并"到**投影出的帧**上
 * （按 index 对齐），而投影帧数 = 内核里的 `blockGrid` 对象数 = **1**
 * （多方块的网格是装配产物，只有一个"当前取值"的网格）。
 * ⇒ 432 个声明帧只有第 0 帧进入产物。旧注释把它登记为"投影的既有有损点"。
 *
 * ## 为什么它不是"固有损失"（本批实测证明）
 *
 * 实测文件与旧 `serialize()`：
 *
 * | 事实 | 值 |
 * |---|---|
 * | 文件里 `frames` | **432** |
 * | 其中**带** `structure` 的 | **0** |
 * | 旧 `RuntimeDocument.serialize()` 的 `frames` | **432**（全部不带 `structure`） |
 *
 * ⇒ 多方块文档的 `frames` 是**变体存储原语**（契约 §5.3：`variant`/`runstate`/
 * `stepIndex`/`rules`），**不是**渲染网格的载体；网格来自"当前取值装配出的那一份"。
 * 故正确形态是**产出全部声明帧且不带 `structure`** —— 与旧语义逐字段对齐。
 * 先前的"1 帧"不是设计边界，是**丢失**。
 *
 * ## 为什么一个 `structure` 都不写
 *
 * 文件里那 432 帧一个都没有 `structure`（实测）。写进去会让"声明帧"伪装成
 * "渲染帧"，并让 `frameCount` 与"可渲染帧数"混淆 —— 而渲染帧的载体是
 * 帧为主形态的 `frames[].structure`（那条路径由 ① 段产出，不受本函数影响）。
 *
 * 字段顺序与旧 `serialize()` 一致（`index`/`label`/`durationMs` 打底，再写声明字段），
 * 使往返产物与旧产物**逐键可比**。
 */
function projectMultiblockScenes(
  declaration: KernelDeclarationProjection,
): Record<string, unknown>[] {
  return declaration.scenes.map((f, i) => {
    // ## M5-1：场景的 `label`/`durationMs` 是**声明**事实，不是时间轴事实
    //
    // 旧实现优先读 `content.frameAxis`（"时长轴优先，声明兜底"），那建立在
    // 「多方块帧 = 时间轴帧」的误读上。用户裁决（2026-10-18）：帧清单 = 变体配置
    // 集合（场景），与时间轴无关、永不参与播放 ⇒ 场景的标签/时长只能来自声明本身。
    // 于是即使有人把一条帧轴塞进内核内容，场景清单也不会跟着变（判据见
    // `kernelProjection.test.ts` 的"场景清单不读内核帧时长轴"）。
    const frame: Record<string, unknown> = {
      index: typeof f.index === 'number' ? f.index : i,
      label: f.label ?? null,
      durationMs:
        typeof f.durationMs === 'number' && Number.isFinite(f.durationMs) ? f.durationMs : null,
    }
    frame.variant = f.variant
    frame.runstate = f.runstate
    frame.stepIndex = f.stepIndex
    // 规则引用：解析器接受 `string`（= 声明顺序）与 `{id, order}` 两种形态，
    // 并把 `string` 归一到 `{id, order: 下标}`（`multiblockDocument:630-638`）。
    // 故**只在 `order` 不等于下标时**才写对象形态 —— 那是唯一承载额外信息的形态。
    //
    // ## 为什么这不是"省字节"而是**忠实**（本批实测）
    //
    // 第一版无条件写 `{id, order}`。实测旧 `serialize()` 写的是**裸字符串**
    // （`["coil.slot","glass.rod",…]`），于是产物在这些键上与旧产物**逐字节不同**：
    // `multiblock-ebf-2ch` 的 `frames` 从 70019 B 涨到 105443 B（+35 KB / 432 帧）。
    // 而两条形态**语义等价**（解析结果相同），故正确的做法是产出与**源**同形的那个。
    frame.rules = f.rules.map((r, k) => {
      if (typeof r === 'string') return r
      const order = r.order
      return order === undefined || order === k ? r.id : { id: r.id, order }
    })
    return frame
  })
}

/**
 * 逐格说明 → `tooltipPalette` + `cellTooltipGrid`（装配侧 `assembleTooltipContent` 的**逆**）。
 *
 * ## 本批（#289 P10d D1 补充）修掉的一处**真实丢失**
 *
 * 切换前的投影**完全不写**这两项。真实帧为主信封实测：`tooltipPalette` 16 条、
 * `cellTooltipGrid` 7×6×19、18 个格带说明 ⇒ 投影产物里**两项全缺**。
 * 而渲染侧的 tooltip 显示读的正是它们 ⇒ "切换后 tooltip 全丢"。
 *
 * ## 它是可逆的（判据是"逐格文本相同"，不是"池逐字节相同"）
 *
 * | 方向 | 输入 | 输出 |
 * |---|---|---|
 * | 装配（`kernelPaletteAssembly#assembleTooltipContent`） | `cellTooltipGrid` + `tooltipPalette` | 逐格 `cellContent[key].tooltip`（文本直落格；`-1` 吸收成**字段缺席**） |
 * | 投影（本函数） | 逐格 `cellContent[key].tooltip` | `tooltipPalette`（**内容去重**）+ `cellTooltipGrid`（`-1` = 无说明） |
 *
 * 池按**内容去重**（同文案共享一个下标）⇒ 往返后逐格文本相同，而池可能比源更紧凑
 * （源里重复的文案被合并）。这是无损的：文件格式的池本身就是一个压缩装置
 * （见 `domain/cellContent` 文件头的判据 3）。
 *
 * ## 三条必须成立的契约事实
 *
 * 1. **行序要翻回**：内核的格键是 Y-up 世界坐标（GF-7），而文件的
 *    `cellTooltipGrid` 是 `[z][row][col]` 且 **row 0 = 顶部**。
 *    装配期用 `row' = sizeRow - 1 - row`（`structureRowToWorldY`）翻过来；
 *    本函数用同一个**自逆**式子翻回去。`height` 由**带说明的格**的包围盒推 ——
 *    不用 `cellGrid` 的高度：两者必须一致，而"由说明格自身推"使本函数
 *    不依赖调用方额外传尺寸（少一个可传错的参数）。
 * 2. **`-1` 是"无说明"**（`TOOLTIP_GRID_NONE`）。内核侧"字段缺席"映回 `-1`，
 *    **不是空串** —— 空串是"显式空说明"，与"没有说明"是两回事。
 * 3. **返回 `null` = 该文档没有任何逐格说明** ⇒ 不写这两项（与装配侧
 *    "缺省 = 无逐格内容"对称）。写一个全 `-1` 的空网格会让"没有说明"
 *    与"有说明但是空"混淆。
 *
 * ## 为什么入参是**载荷**而不是文档内容三块
 *
 * 逐格说明挂在 `blockGrid` 载荷的 `cellContent` 上（网格级内容），
 * 而 `DocumentContent` 只承载资源/元数据/帧轴 —— 它**不含**逐格内容。
 * 第一版把入参写成 `DocumentContent`，函数体只能 `void content`（写不出来），
 * 那正是"参数形状选错"的信号。
 */
function tooltipPoolOfPayloads(
  payloads: readonly {
    readonly cells: Readonly<Record<string, string>>
    readonly cellContent?: CellContentTable
    /** 载荷声明的网格尺寸（说明池形状的权威；见 `adapters/tooltipPool` 判据 2）。 */
    readonly sizeColumn?: number
    readonly sizeRow?: number
    readonly sizeZSlice?: number
  }[],
): { palette: readonly string[]; grid: readonly number[][][] } | null {
  // 实现已移到 `adapters/tooltipPool`（**同 `-1` 哨兵同层**）。
  //
  // 第一版把它写在这里，于是取哨兵时连撞两道闸门：
  //  - `@/render/schema/types` 与 `@/adapters/files/legacyFields` 都是深度 3 ⇒
  //    `gate/no-private-cross-layer` 判红；
  //  - 在本层再导出哨兵 ⇒ `gate/no-barrel-smuggling` 判红。
  //
  // 两次判红指向同一件事：**这个函数放错了层** —— 它与哨兵同属"文件格式 idiom"
  // （`adapters/files/legacyFields` 的 F-13 / B-7 正是同一组）。移到 `adapters/`
  // 后两道闸门同时满足，且哨兵的值仍只有一个来源。
  //
  // 本函数仍保留在 `composition/`：它做的是"从**哪一份**载荷取"的选择
  // （多方块只有一份网格；帧为主取 `frames[0]`），那是装配策略，不是文件格式编码。
  //
  // ⚠️ **M1 P3**：声明尺寸必须**传下去**。漏传 = 说明池退回"按说明格包围盒"推导
  // ⇒ 产物 `cellTooltipGrid` 与产物 `cellGrid` 的声明**不同形**，而消费侧
  // （`kernelAssembly#tooltipContentOf`）逐字按 `sizeRow` 反解行号 ⇒ 重开时注解**搬行**。
  // 这不是形状洁癖：实测（真实信封 + 删掉最高行注解）走 `保存到文件 → 打开场景`
  // 后 17 个注解全部上移一行。
  for (const payload of payloads) {
    const pool = tooltipPoolOf(payload.cellContent, {
      width: payload.sizeColumn,
      height: payload.sizeRow,
      depth: payload.sizeZSlice,
    })
    if (pool !== null) return pool
  }
  return null
}


/**
 * `blockGrid` 载荷 → 投影输入（**唯一**的适配点）。
 *
 * 把载荷的可选字段一次性取出，使调用方不必知道"哪些字段要一起传"
 * （漏传一个的后果是逐格几何/部件/声明尺寸静默丢失）。
 *
 * ## ⚠️ 声明尺寸三字段必须在这里**传下去**（#262 P11-A 的接线本体）
 *
 * 这是 #301 P10f D3 打回的同一个坑：那次是**装配**从不填三字段（读面因此永远走
 * 包围盒降级），这次是**投影**——载荷已经带着声明，适配点若把它丢掉，
 * `projectGridCells` 就永远看不到声明 ⇒ 本批的修法**等于没修**。
 * 故本函数逐字段透传，判据由 `__tests__/p11aProjectionSize.test.ts` 的
 * ①②（保存路径）与⑦（presenter 路径）把守 —— **输入来自生产装配**，不是手工载荷。
 */
function gridProjectionInputOf(payload: {
  readonly cells: Readonly<Record<string, string>>
  readonly sizeColumn?: number
  readonly sizeRow?: number
  readonly sizeZSlice?: number
  readonly geometry?: Readonly<Record<string, BlockGeometryAsset>>
  readonly cellGeometry?: Readonly<Record<string, string>>
  readonly cellPalette?: Readonly<Record<string, string>>
  readonly palette?: readonly BlockPaletteEntry[]
  readonly cellContent?: CellContentTable
}): GridProjectionInput {
  const out: {
    cells: Readonly<Record<string, string>>
    sizeColumn?: number
    sizeRow?: number
    sizeZSlice?: number
    geometry?: Readonly<Record<string, BlockGeometryAsset>>
    cellGeometry?: Readonly<Record<string, string>>
    cellPalette?: Readonly<Record<string, string>>
    palette?: readonly BlockPaletteEntry[]
    cellContent?: CellContentTable
  } = { cells: payload.cells }
  if (payload.sizeColumn !== undefined) out.sizeColumn = payload.sizeColumn
  if (payload.sizeRow !== undefined) out.sizeRow = payload.sizeRow
  if (payload.sizeZSlice !== undefined) out.sizeZSlice = payload.sizeZSlice
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
 * 内核文档 → **逐帧的旧 `Grid`**（R1-β① C1 的 `Context#syncLegacyFromKernel` 投影面）。
 *
 * ## 它替代的旧机制（本函数存在的全部理由）
 *
 * 编辑路径在内核化之后，`Context#syncLegacyFromKernel` 必须把内核内容投影回 legacy，
 * 而**渲染链与保存链此刻仍读 legacy**（终切属后续批次）。逐格移动
 * （`application/commands#reduceMoveCells`）与逐格内容（`#reduceSetCellContent`）
 * 写的是 `blockGrid` 载荷 ⇒ 投影必须覆盖网格，否则重演 **#333**
 * （内核写了、legacy 没投影 ⇒ "提交成功但看不见"）。
 *
 * ## 为什么**不**复用 `projectToRuntimeDocument`（关键判据，勿改成"顺手复用"）
 *
 * 那条路是 `projectKernelDocument` → `plain` → `RuntimeDocument.fromV2Plain` →
 * `serialize()`。它的产物是**保存/导出的形状**（含保真字段回写、首帧展开副本、
 * 多方块内层 body），而本函数的用途是"把**当前内核内容**换成 legacy 载体" ⇒
 * 若走那条路，投影会把**上一次保存的保真字段**一并写回来，且四处 `serialize()`
 * 都是**全量重编码**（大文档上是可感的成本）。两者是**不同的投影面**，不是同一件的两种写法：
 *
 * | 投影面 | 消费者 | 形状 |
 * |---|---|---|
 * | `projectToRuntimeDocument` / `projectKernelDocument` | 保存/导出（外部格式） | 全保真 plain |
 * | **本函数** | `syncLegacyFromKernel`（渲染载体） | 逐帧 `Grid` |
 *
 * ## 与装配的**对偶性**由什么保证
 *
 * 逐格重建**唯一调用** `projectToLegacyGrid`（`:557`）—— 它与装配侧
 * `kernelAssembly#gridPayload` 用**同一张**逐格映射表（`projectGridCells` 内的
 * `cellPalette` 内容键路径）与同一个行序函数 `structureRowToWorldY`。
 * ⇒ "装配 ↔ 本投影"不可能漂移，因为两边都没有第二份实现。
 *
 * ## `null` 的语义 = **该帧确实没有网格**
 *
 * 与 `composition/kernelProjection#projectKernelDocument` 的
 * `cellGrid.length === 0 ⇒ structure: null` **同一口径**（多方块帧设计上没有网格）。
 * 调用方据此把 legacy 那一帧清成 `null`（不是"不改"）。
 *
 * @param frameObjectIds 帧下标 → 内核对象 id（装配面 `frameObjects`；缺省 = `scene.order`
 *        里 `block` 对象的顺序，与 `projectKernelDocument` 的缺省逐字同口径）。
 */
export function projectKernelGrids(input: {
  readonly scene: Scene
  readonly frameObjectIds?: readonly string[]
}): readonly (Grid | null)[] {
  const { scene } = input
  const blockObjects = objectsInOrder(scene).filter((o) => o.type === 'block')
  const ids = input.frameObjectIds ?? blockObjects.map((o) => o.id)
  const out: (Grid | null)[] = []
  for (const objectId of ids) {
    const obj = findObject(scene, objectId)
    const data = obj === undefined ? undefined : findObjectData(scene, obj.dataId)
    if (data === undefined || data.payload.kind !== 'blockGrid') {
      // 不是 `blockGrid` ⇒ 该帧在文件格式里写不出网格（与 `projectKernelDocument` 的
      // `unsupportedObjectType` 诊断同一事实）。本投影**不猜**，如实给 `null`。
      out.push(null)
      continue
    }
    const projected = projectGridCells(gridProjectionInputOf(data.payload))
    // `cellGrid` 为空 ⇒ 没有网格（不是"空网格"）—— 见 `projectKernelDocument` 同一判据。
    out.push(projected.cellGrid.length === 0 ? null : projectToLegacyGrid(gridProjectionInputOf(data.payload)).grid)
  }
  return Object.freeze(out)
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
  /** 逐帧的 `blockGrid` 载荷（逐格说明池的来源；见 `tooltipPoolOfPayloads`）。 */
  const framePayloads: {
    readonly cells: Readonly<Record<string, string>>
    readonly cellContent?: CellContentTable
    /** 声明尺寸：说明池形状的权威（漏在这里声明就会在类型上丢掉它 —— M1 P3）。 */
    readonly sizeColumn?: number
    readonly sizeRow?: number
    readonly sizeZSlice?: number
  }[] = []
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
    // 内容越出**声明**尺寸 ⇒ 维度按内容扩张（不丢格），但事实必须**可见**（不静默）。
    if (projected.outsideDeclaredCells !== undefined) {
      diagnostics.push(
        Object.freeze({
          code: 'cellsOutsideDeclaredSize' as const,
          path: `$.frames[${i}].structure.cellGrid`,
          detail: `${objectId} 有 ${projected.outsideDeclaredCells} 格落在载荷声明的尺寸之外 —— 投影按内容扩张维度（不丢格），故产物尺寸大于声明；这是"声明与内容不一致"的输入`,
          count: projected.outsideDeclaredCells,
        }),
      )
    }
    // 几何目录与逐格身份**必须成对**：只有一侧时逐格几何会静默丢失
    // （那正是"看起来能跑但画错方块"的形态，比报错更糟）。
    const geoDiag = geometryCompletenessDiagnostic(data.payload, `$.frames[${i}]`)
    if (geoDiag !== null) diagnostics.push(geoDiag)
    const contentDiag = cellContentKeyDiagnostic(data.payload, `$.frames[${i}]`)
    if (contentDiag !== null) diagnostics.push(contentDiag)
    // 逐格说明池的来源（#289 P10d D1 补充）：逐格内容挂在 `blockGrid` 上，
    // 故这里收集**载荷**而不是文档级内容 —— 见 `tooltipPoolOfPayloads` 的说明。
    framePayloads.push(data.payload)
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
  //
  // ## ⚠️ 两条口径：**渲染态**（够画）与**写回态**（全保真）—— 由 `input.annotationRows` 选择
  //
  // | 用途 | 来源 | 字段 |
  // |---|---|---|
  // | 渲染（DRW 的输入） | 本函数**就地合成**（下方） | `id`/`type`/`visible`/`title`/`description` —— "够画即可" |
  // | 写回（保存/导出） | `input.annotationRows`（调用方给） | **全保真**（含 `locked`/`created_at`/`min`/`max`/`pos`/`points`/`color`/…） |
  //
  // ## ⚠️ 为什么必须分开（本批实测抓出的能力回退风险）
  //
  // 本函数原先**只有**渲染态合成。若把保存路径直接接到它上面，
  // 那么保存一次就会**静默丢掉** `locked`（锁定即只读的判定依据！）、
  // `created_at`/`updated_at`、几何 `min`/`max`/`pos`/`points`、`color`/`renderStyle`。
  // 实测：`locked`/`frameIndex`/`created_at`/`min`/`max` 经渲染态投影后**全部变 `null`**。
  // ⇒ 那是**能力回退**（#171 的硬底线），不是"字段少几个"。
  //
  // ## 为什么全保真那份不在这里实现
  //
  // 它是 `runtime/annotationRead#projectAnnotationsToLegacy`（C′2 为本目的写的，
  // 含"字段顺序固定"与"缺席 ≠ 空"两条纪律，且有独立判据）。
  // 在此**再写一遍**就是第二份会漂移的实现 ⇒ 本函数只**接受**它，不复制它。
  const annotations: Record<string, unknown>[] =
    input.annotationRows !== undefined
      ? input.annotationRows.map((r) => ({ ...r }))
      : []
  if (input.annotationRows === undefined) {
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

  // ── ④b 逐格说明池 → `tooltipPalette` + `cellTooltipGrid`（#289 P10d D1 补充）──
  //
  // ## 为什么需要它（本批实测抓出的一处**真实丢失**）
  //
  // 切换前的投影**完全不写**这两项。真实帧为主信封实测：`tooltipPalette` 16 条、
  // `cellTooltipGrid` 7×6×19、18 个格带说明 ⇒ 投影产物里两项**全缺**。
  // 而渲染侧的 tooltip 显示（`render/interaction` 一族）读的正是它们 ⇒
  // "切换后 tooltip 全丢"。
  //
  // ## 它为什么可逆（装配侧的逆）
  //
  // 装配期 `assembleTooltipContent` 把 `cellTooltipGrid`+`tooltipPalette`
  // **归一成** `cellContent[key].tooltip`（文本直接落格，`-1` 哨兵吸收成"字段缺席"）。
  // 本函数做它的逆：把逐格文本重新聚成**池 + 下标网格**。
  //
  // 池的构造是**内容去重**（同文案共享一个下标）—— 与装配侧的"逐格承载文本"
  // 是同一份信息，只是重新压缩成文件格式的形态。故往返后**逐格文本相同**，
  // 而池可能比源更紧凑（源里重复的文案会被合并）。这是**无损**的：
  // 判据是"逐格文本相同"，不是"池逐字节相同"。
  const tooltip = tooltipPoolOfPayloads(framePayloads)

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

  // ── ④c 逐格说明池写回（见 ④b 的说明；必须在 `plain` 声明之后） ──
  if (tooltip !== null) {
    plain.tooltipPalette = tooltip.palette
    plain.cellTooltipGrid = tooltip.grid
  }

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
    // 多方块的 `frames` 键承载的是**场景**（变体存储原语，契约 §5.3）：本批修正后由
    // `declaration.scenes` **全部**产出（见 `projectMultiblockScenes`），
    // 故这里不再需要"合并声明帧到投影帧上"——那正是把 432 帧塌成 1 帧的旧做法。
    const declarationScenes = projectMultiblockScenes(input.multiblockDeclaration)
    // ── 渲染视图模式：网格注入帧、**不**写多方块节点（见 `renderView` 的说明） ──
    //
    // 旧实现是 `buildMultiblockRenderView(doc, result, frameIndex)`：把装配出的
    // 网格放到"首帧 + 当前帧"上，并清掉 `multiblock` 节点（避免并集调色板与
    // 帧内重编号调色板混用）。这里**逐字段复刻**同一语义。
    if (input.renderView !== undefined) {
      const current = Math.trunc(input.renderView.frameIndex)
      const gridStructure = structures[0]?.structure ?? null
      const frames = declarationScenes.map((frame, i) => {
        // 只给"首帧 + 当前帧"装网格（与旧语义一致：其余帧保持声明帧原样）
        if (i !== 0 && i !== current) return frame
        const withGrid: Record<string, unknown> = { ...frame }
        if (gridStructure !== null) withGrid.structure = gridStructure
        return withGrid
      })
      plain.frames = frames
      // 清掉 `multiblock` 节点（它的根级 `blockPalette` 是并集调色板 —— 见 `renderView` 的说明）
      delete plain.multiblock
      delete plain.multiblockCount
      // 顶层也要有一份自洽的 `cellGrid + blockPalette`（`serialize()` 会把首帧展开到顶层）
      const firstStructure = frames[0]?.structure as Record<string, unknown> | undefined
      if (firstStructure !== undefined) {
        for (const [k, v] of Object.entries(firstStructure)) {
          if (k === 'geometryPhase') continue
          plain[k] = v
        }
      }
    } else {
      plain.frames = declarationScenes
      plain.documentShape = 'multiblock'
    }
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
