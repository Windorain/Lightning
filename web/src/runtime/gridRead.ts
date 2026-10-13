/**
 * `runtime/gridRead` —— **网格读面**（#301 P10f D3；D 映射表 §B′ 的"网格读面扩展"）。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | `ctx.getDoc().value?.frame(i)?.grid` —— 15 处消费点直读旧 `Grid` | `context/queries.ts`（9 处）、`runtime/hover/access.ts`（2）、`editors/workbench-rna.ts`（2）、`operators/builtin/moveTranslate.ts`（1）、`workbench/ux/panels/TooltipEditorPanel.vue`（1） | 统一形状的 `KernelGridView`：**内核 `blockGrid` 载荷**为权威，`InputSource` 由 `Context` 按 GF-16 分流 |
 *
 * ## 为什么需要"统一形状"（而不是让调用方各判一次）
 *
 * 内核 `blockGrid` 与 legacy `Grid` 的形状**不同**（前者是稀疏键表 + 目录，
 * 后者是稠密三维数组 + 惰性 `PaletteCache`）。若每个调用点自己适配，
 * 就有 15 份会漂移的适配 —— 而本工程已三度实测"两份实现必然漂移"。
 * ⇒ 适配**只在本模块**发生一次，两种来源都归一成 `KernelGridView`。
 *
 * ## 为什么是纯函数（而不是 `Context` 方法里的几行 if）
 *
 * 与 `runtime/frameDeclarations`、`runtime/sideTableResolution` **同一判据**：
 * 判定必须能被测试**直接注入**（装配失败/缺 shape/空网格/空 parts 四态），
 * 而"在测试里复刻一份判定"等于两份实现。
 * ⇒ 决定在本模块，`Context` 只"取事实 + 分流 + 交结果"。
 *
 * ## ⚠️ 三个"看似等价实则不然"的口径（逐条实测，务必保留）
 *
 * | 陷阱 | 正确口径 |
 * |---|---|
 * | 用 `cells` 的包围盒当网格尺寸 | **必须**用声明的 `sizeColumn/sizeRow/sizeZSlice`（D-1 裁决）；缺省才降级推导，且**空网格 ⇒ 尺寸全 0 而不是 1** |
 * | 用 `cells` 的 GF-7 编码反推方块身份 | `cells` 的值**就是** `minecraft:<name>:<meta>`（GF-7 丢命名空间）。要真身份必须经 `cellPalette` 的**内容键** → `palette` 表 —— 与投影侧 `D9` 的收紧**同一条规则**（不按几何猜） |
 * | 把 `paletteIndex` 当成跨网格可移植的标识 | 它是**投影下标**（R-WK-09 裁决 4）。本读面按 `cellPalette` → `palette` 的**位置**复算，故与 legacy 同序；但它**只在本网格内**有意义 |
 */

import type { Document } from '@/domain/document'
import { findObjectData } from '@/domain/scene'
import type { CellContent, CellContentTable } from '@/domain/cellContent'
import { cellPositionKey } from '@/domain/cellPosition'
import type { PartRecord } from '@/pure/partTypes'
import { blockPaletteEntryKey, type BlockGeometryAsset, type BlockPaletteEntry } from '@/domain/blockGeometry'
import { decodeBakedGeometry } from '@/render/mesh/bakedGeometryDecode'
import type { BakedQuad, BakedQuadsGeometry } from '@/render/schema/types'

/**
 * `domain/cellContent#PartRecord` → 本读面的 `PartRecord`（**纯类型收窄，零运行期开销**）。
 *
 * ## 为什么两个类型并存，而这里要转
 *
 * | 侧 | 类型 | 为什么 |
 * |---|---|---|
 * | 内核 | `domain/cellContent#PartRecord`（全 `readonly`） | `domain/` 是纯核心，不得 import 旧层 `pure/`（#249 §4 规则 1 + `kernel-legacy-isolation` 闸门）⇒ **就地声明** |
 * | 消费面 | `pure/partTypes#PartRecord`（`boxes: PartBox[]` 等可变数组） | `pure/partHit`/`pure/partMask` 的既有签名 |
 *
 * 两者的**字段名与结构逐项相同**（逐字段核对：`localId`/`typeKey`/`boxes`/
 * `displayName`/`tooltip`/`items`/`source`/`properties`），差别**只在** `readonly` 修饰符。
 *
 * ⚠️ 转换是**单向且只读**的：读面返回的数组与 legacy `Grid.partsAt` 一样是
 * "导出时快照、勿改"（契约 §12：web 端任何编辑不重算）。往它里面写不会生效
 * （装配侧的对象是冻结的）—— 故这是类型收窄，不是可变性授权。
 */
function partsAsPure(parts: readonly CellContentPartRecord[] | undefined): readonly PartRecord[] | null {
  if (parts === undefined) return null
  return parts as unknown as readonly PartRecord[]
}

/** 只为上面的转换取一个名字（避免在签名处写 `import(...)` 内联类型）。 */
type CellContentPartRecord = NonNullable<CellContent['parts']>[number]

/** 方块位置（与 legacy `GridPos` 同形，Y-up）。 */
export interface KernelGridPos {
  readonly x: number
  readonly y: number
  readonly z: number
}

/**
 * 一格的**读面视图**（两种来源归一后的形状）。
 *
 * ⚠️ 刻意**不**暴露 `SlotBlock`：那是旧数据模型的对象。调用方要的三件事实是
 * "方块身份 / 部件 / 调色板条目"，本类型逐项给出。
 */
export interface KernelGridCellView {
  readonly pos: KernelGridPos
  /** GF-7 编码身份（`minecraft:<name>:<meta>`）—— 与 legacy `SlotBlock.name/meta` **同源同形**。 */
  readonly name: string
  readonly meta: number
  /** legacy `paletteIndex`（**本网格内**的下标；`undefined` = 该来源未承载）。 */
  readonly paletteIndex: number | undefined
}

/**
 * 调色板条目视图（`palette` 表的一项）。
 *
 * ## 字段面为什么与**类型化条目**逐项相同（不是"挑几个够用的"）
 *
 * 消费点 `context/queries#getBlockPaletteEntry` 的返回形状被 3 个面板读
 * （`blockInspector` 读 `renderMode`/`facing`/`nbt`；`TooltipEditorPanel` 读 `tooltip`；
 * `getBlockGeometry` 读 `geometry`）。若本视图只挑几个字段，
 * 就要么在 `queries` 里写一层字段名映射（第二份会漂移的清单），
 * 要么改面板（超出"同义迁移"的范围）。
 *
 * ⇒ 逐项对齐 `domain/blockGeometry#BlockPaletteEntry`，并额外给 `raw`
 * （消费点要读本视图未类型化的键时用；**不得**改它）。
 *
 * ⚠️ 与 legacy `PaletteEntryMeta` 的**两处**字段名不同（各自是旧形态的历史名）：
 * `thumbnail`（旧：`thumbnailPNG`）、`meta`（旧条目里有，但 `PaletteEntryMeta` 的类型未列）。
 * `queries#getBlockPaletteEntry` 的消费点**只读** `renderMode`/`facing`/`nbt`/`tooltip`/`geometry`
 * ⇒ 无需为这两处差异做映射（实测三方消费者逐字段核对）。
 */
export interface KernelPaletteEntryView {
  /** 资产身份（内容派生；同内容 ⇒ 同 id）。 */
  readonly assetId: string
  readonly registryId: string
  readonly meta: number
  readonly renderMode: string
  /**
   * **解码后的四边形**（`null` = 该条目无几何）。
   *
   * ## 为什么要归一（而不是两侧各给各的形态）
   *
   * 内核侧承载的是**类型化资产**（`BlockGeometryAsset`，含 `quads` + `mesh`），
   * 而 legacy `PaletteEntryMeta.geometry` 是**文件原文**（`BakedQuadsGeometry`）
   * ⇒ 两者形状不同。唯一消费点（`context/queries#getBlockGeometry`）要的是
   * **解码后的四边形**，故本视图给那一件 —— 归一发生在**本模块**（一处），
   * 而不是让消费点去分辨"我拿到的是哪一种形态"（那就是 15 处会漂移的适配）。
   */
  readonly geometry: readonly BakedQuad[] | null
  readonly occludesAdjacentFaces?: boolean
  readonly facing?: string
  readonly nbt?: Readonly<Record<string, unknown>>
  readonly thumbnail?: string
  readonly tooltip?: readonly string[]
  /** 条目原文（**不改**）。 */
  readonly raw: Readonly<Record<string, unknown>>
}

/**
 * **网格读面**（内核与 legacy 的共同形状）。
 *
 * 只读视图：所有返回的数组/对象**不得**被调用方修改（与 legacy `Grid.partsAt`
 * 的"只读视图勿改"同口径，但本类型在**类型上**就是 `readonly`）。
 */
export interface KernelGridView {
  readonly width: number
  readonly height: number
  readonly depth: number
  /** 非空格数（legacy `Grid.count()` 同义）。 */
  count(): number
  at(pos: KernelGridPos): KernelGridCellView | null
  forEach(fn: (cell: KernelGridCellView) => void): void
  blocks(): readonly KernelGridCellView[]
  partsAt(pos: KernelGridPos): readonly PartRecord[] | null
  /** 逐格说明（内核 `cellContent` 的 `tooltip`；`undefined` = 该格无说明）。 */
  tooltipAt(pos: KernelGridPos): string | undefined
  /** 调色板条目（按内容键精确命中；取不到 ⇒ `null`，**不猜**）。 */
  paletteEntryOf(pos: KernelGridPos): KernelPaletteEntryView | null
  /**
   * **与 `(name, meta)` 相符的调色板条目的内容键**（R1-β① C3；`setCellIdentity` 的
   * `paletteRef` 来源）。
   *
   * ## 为什么要有它（它是 GF-7 在**写侧**的闭合件）
   *
   * 面板提交的是显示形态 `minecraft:<name>:<meta>`，而 `cells` 承载的名字**已截去
   * 命名空间**（`pure/gridTypes.ts:18`）⇒ 由名字反拼引用（`` `minecraft:${name}` ``）
   * 会把 `ae2:`/`appliedenergistics2:` 之类改写成 `minecraft:`。本方法只**查**
   * 调色板里已存在的条目并返回**它自己的**内容键 —— 命名空间来自文档，不来自拼接。
   *
   * ## 唯一性要求（**不猜**）
   *
   * `name` 是 `registryId` 的**尾段**。同一尾段 + 同一 meta 可能对应多条
   * 不同命名空间的条目 ⇒ 此时返回 `null`（**歧义即拒绝**），
   * **不**取首条（那正是 `kernelProjection.ts:500`/`:502` 两条"不采信"路径的理由：
   * 猜会**引入**错误身份）。0 条命中同样返回 `null`。
   *
   * @returns 内容键（`blockPaletteEntryKey`，与 `cellPalette` 同一套编码）；
   *   `null` = 无命中或有歧义 ⇒ 调用方**如实拒绝**，不得反拼兜底。
   */
  identityRefOf(pos: KernelGridPos, name: string, meta: number): string | null
  /** 该格的**解码后四边形**（内核：`cellGeometry` → 资产 `quads`；取不到 ⇒ `null`）。 */
  geometryOf(pos: KernelGridPos): readonly BakedQuad[] | null
  /** 世界空间体素中心（与 legacy `Grid.centerWorld` 逐字同式）。 */
  centerWorld(pos: KernelGridPos): KernelGridPos
}

// ─────────────────────────────────────────────────────────────────────────────
// 尺寸（D-1：声明优先，缺省降级为包围盒推导）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **载荷声明的网格尺寸**（`null` = 没有一份有效的声明 ⇒ 调用方必须降级）。
 *
 * ## 为什么它是一个**独立导出**（而不是 `resolveGridSize` 的私有分支）
 *
 * 「什么算一份合法的声明尺寸」是**一个事实**，而它有**两个消费侧**：
 *
 * | 侧 | 消费点 | 用它做什么 |
 * |---|---|---|
 * | 读 | `resolveGridSize`（本模块） | 网格的尺寸（拾取/居中的基准） |
 * | 写 | `composition/kernelProjection#projectGridCells`（#262 P11-A） | 投影产物 `cellGrid` 的维度（**文件声明的事实不得在保存时丢**） |
 *
 * 两侧若各写一份判定，就会漂移（本工程已三度实测"两份实现必然漂移"）；
 * 而**判别子**（"载荷带没带声明"）必须两侧同构 —— 这正是 #262 要修的那条欠账。
 *
 * ## 判据（`>= 0` 的整数三元组才算声明）
 *
 * - 三者**缺一不可**：只写两个 ⇒ 没有完整声明 ⇒ 降级（不猜第三个）；
 * - `0` 是**合法**声明（"0 宽的网格"是真实状态，与"字段缺席"**必须**可区分 ——
 *   见 `domain/scene#ObjectDataPayload.sizeColumn` 的说明与 `resolveGridSize` 的口径）；
 * - 负数/非整数 ⇒ 非法声明 ⇒ 降级（如实降级，不抛：纯层不抛，见 `domain/errors`）。
 */
export function declaredGridSize(payload: {
  readonly sizeColumn?: number
  readonly sizeRow?: number
  readonly sizeZSlice?: number
}): { readonly width: number; readonly height: number; readonly depth: number } | null {
  const w = payload.sizeColumn
  const h = payload.sizeRow
  const d = payload.sizeZSlice
  if (w === undefined || h === undefined || d === undefined) return null
  if (![w, h, d].every((n) => Number.isInteger(n) && n >= 0)) return null
  return { width: w, height: h, depth: d }
}

/**
 * 网格尺寸解析（**声明优先**）。
 *
 * ## 为什么降级分支要单独可测
 *
 * `sizeColumn/sizeRow/sizeZSlice` 是 D3 新加的承载字段 ⇒ 旧形态的载荷**没有**它们。
 * 降级分支因此**不是死代码**（历史文档/测试夹具/外部构造都会走它），
 * 且它的正确性直接决定拾取 Y 坐标（见 `domain/scene` 的字段说明）。
 *
 * ⚠️ 空网格 ⇒ `0×0×0`（**不是** `1×1×1`）：`max` 的初值不能是 `0`。
 */
export function resolveGridSize(payload: {
  readonly cells: Readonly<Record<string, string>>
  readonly sizeColumn?: number
  readonly sizeRow?: number
  readonly sizeZSlice?: number
}): { readonly width: number; readonly height: number; readonly depth: number } {
  return declaredGridSize(payload) ?? boundsSizeOf(payload.cells)
}

/** 包围盒推导（**仅**在载荷未声明尺寸时使用）。 */
function boundsSizeOf(cells: Readonly<Record<string, string>>): {
  readonly width: number
  readonly height: number
  readonly depth: number
} {
  let maxX = -1
  let maxY = -1
  let maxZ = -1
  for (const key of Object.keys(cells)) {
    const [x, y, z] = key.split(',').map(Number)
    if (x === undefined || y === undefined || z === undefined) continue
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }
  // `-1 + 1 = 0` ⇒ 空网格给 `0×0×0`（见上文）。
  return { width: maxX + 1, height: maxY + 1, depth: maxZ + 1 }
}

// ─────────────────────────────────────────────────────────────────────────────
// 内核来源
// ─────────────────────────────────────────────────────────────────────────────

/** `blockGrid` 载荷的内部形状（本模块只读它；**不**导出，避免第二份形状定义）。 */
type BlockGridPayload = {
  readonly cells: Readonly<Record<string, string>>
  readonly sizeColumn?: number
  readonly sizeRow?: number
  readonly sizeZSlice?: number
  readonly cellContent?: CellContentTable
  readonly cellPalette?: Readonly<Record<string, string>>
  readonly cellPaletteIndex?: Readonly<Record<string, number>>
  readonly palette?: readonly unknown[]
  readonly cellGeometry?: Readonly<Record<string, string>>
  readonly geometry?: Readonly<Record<string, BlockGeometryAsset>>
}

/**
 * **内核文档 → 网格读面**（`frameIndex` 指定取哪一帧的 `blockGrid` 对象）。
 *
 * ## 怎么找到"第 N 帧的网格"（这是唯一的约定，且不依赖命名）
 *
 * 装配期把每帧的网格建成一个 `block` 对象（`kernelAssembly` 的帧循环）。
 * 本函数按 `scene.order` 遍历 `block` 对象，**按出现序**取第 `frameIndex` 个。
 *
 * ⚠️ **刻意不用对象 id 里的 `frame-<i>` 前缀**：那是装配的命名约定，
 * 而投影层明文不得依赖它（`runtime/tooltipRead:69` 记录了同一条口径）。
 * 用 `scene.order` 的出现序与装配的遍历序**同源**。
 *
 * @returns `null` = 该帧没有可解释的 `blockGrid`（如实降级，**不**伪造空网格）
 */
export function kernelGridOf(doc: Document | undefined, frameIndex: number): KernelGridView | null {
  if (doc === undefined) return null
  const payload = blockGridPayloadAt(doc, frameIndex)
  if (payload === null) return null
  return gridViewOfPayload(payload)
}

/** 按 `scene.order` 的出现序取第 `frameIndex` 个 `blockGrid` 载荷。 */
function blockGridPayloadAt(doc: Document, frameIndex: number): BlockGridPayload | null {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) return null
  let seen = 0
  for (const objectId of doc.scene.order) {
    const obj = doc.scene.objects[objectId]
    if (obj === undefined || obj.type !== 'block') continue
    const data = findObjectData(doc.scene, obj.dataId)
    if (data === undefined || data.payload.kind !== 'blockGrid') continue
    if (seen === frameIndex) return data.payload as unknown as BlockGridPayload
    seen += 1
  }
  return null
}

/**
 * 由 `blockGrid` 载荷构造读面（**适配只在这里发生**）。
 *
 * 导出是为了让测试能直接喂载荷（判据打的必须是生产代码本身，不是复刻）。
 */
export function gridViewOfPayload(payload: BlockGridPayload): KernelGridView {
  const size = resolveGridSize(payload)
  const cells = payload.cells
  const cellContent: CellContentTable | undefined = payload.cellContent
  const cellPalette = payload.cellPalette
  const palette = payload.palette
  const cellGeometry = payload.cellGeometry
  const geometry = payload.geometry
  /**
   * 逐格 → **文件槽位**（legacy `paletteIndex`）。
   *
   * ⚠️ 它**不是** `palette` 数组的位置：那份数组是按内容去重的稳定序
   * （`kernelPaletteAssembly` 的 `entryByKey.values()`），与文件槽位无关。
   * 故这里**只**能读承载值，**不得**在读取侧复算（复算会得到另一个数
   * —— 见 `domain/scene#ObjectDataPayload` 的 `cellPaletteIndex` 说明）。
   */
  const cellPaletteIndex: Readonly<Record<string, number>> | undefined = payload.cellPaletteIndex

  /**
   * 内容键 → `palette` 表下标（**本网格内**）。
   *
   * 每次调用重建会退化成 O(n²)（`paletteEntryOf` 在最坏情况下被调用 W×H×D 次），
   * 故**惰性建一次**索引（纯函数内的临时可变结构，不逃逸 —— #249 §2 明文允许）。
   *
   * ⚠️ 索引键是**条目内容键**（`blockPaletteEntryKey`），与 `cellPalette` 的取值
   * **同一套编码** —— 不是 `registryId`：后者会让"同 registryId 不同 meta/nbt"
   * 的条目互相命中（D9 实测过的错配形态）。
   *
   * 惰性索引用到 `blockPaletteEntryKey`（`domain/blockGeometry`）—— 与装配侧
   * （`kernelPaletteAssembly`）**同一个函数**，故编码不可能漂移。
   */
  let paletteIndexOfKey: Map<string, number> | null = null
  const indexOfContentKey = (key: string): number => {
    if (paletteIndexOfKey === null) {
      paletteIndexOfKey = new Map<string, number>()
      if (palette !== undefined) {
        for (let i = 0; i < palette.length; i++) {
          const entry = palette[i]
          if (entry === null || typeof entry !== 'object') continue
          const k = blockPaletteEntryKey(entry as BlockPaletteEntry)
          // 首个命中获胜（与装配侧的"按内容去重后的稳定序"同口径）。
          if (k !== '' && !paletteIndexOfKey.has(k)) paletteIndexOfKey.set(k, i)
        }
      }
    }
    return paletteIndexOfKey.get(key) ?? -1
  }

  const cellViewOf = (pos: KernelGridPos): KernelGridCellView | null => {
    const id = cells[cellPositionKey(pos)]
    if (id === undefined) return null
    const parsed = parseGf7(id)
    return Object.freeze({
      pos: Object.freeze({ x: pos.x, y: pos.y, z: pos.z }),
      name: parsed.name,
      meta: parsed.meta,
      paletteIndex: paletteIndexAt(pos),
    })
  }

  const paletteIndexAt = (pos: KernelGridPos): number | undefined => {
    // 文件槽位（承载值；见上方 `cellPaletteIndex` 的说明）。
    return cellPaletteIndex?.[cellPositionKey(pos)]
  }

  /** 该格的调色板**条目**（经 `cellPalette` 内容键 → `palette` 表精确命中）。 */
  const paletteEntryAt = (pos: KernelGridPos): KernelPaletteEntryView | null => {
    const key = cellPalette?.[cellPositionKey(pos)]
    if (key === undefined) return null
    const idx = indexOfContentKey(key)
    if (idx < 0) return null
    const entry = palette?.[idx]
    if (entry === null || typeof entry !== 'object') return null
    return paletteEntryViewOf(entry as Record<string, unknown>, quadsOfAsset(entry))
  }

  const contentAt = (pos: KernelGridPos): CellContent | undefined =>
    cellContent?.[cellPositionKey(pos)]

  return Object.freeze({
    width: size.width,
    height: size.height,
    depth: size.depth,
    count(): number {
      return Object.keys(cells).length
    },
    at: cellViewOf,
    forEach(fn: (cell: KernelGridCellView) => void): void {
      // 遍历序 = 键的插入序（装配期按 z→row→x 填，故与 legacy `forEach` 同序）。
      for (const key of Object.keys(cells)) {
        const parsed = parsePositionKey(key)
        if (parsed === null) continue
        const view = cellViewOf(parsed)
        if (view !== null) fn(view)
      }
    },
    blocks(): readonly KernelGridCellView[] {
      const out: KernelGridCellView[] = []
      for (const key of Object.keys(cells)) {
        const parsed = parsePositionKey(key)
        if (parsed === null) continue
        const view = cellViewOf(parsed)
        if (view !== null) out.push(view)
      }
      return Object.freeze(out)
    },
    partsAt(pos: KernelGridPos): readonly PartRecord[] | null {
      return partsAsPure(contentAt(pos)?.parts)
    },
    tooltipAt(pos: KernelGridPos): string | undefined {
      return contentAt(pos)?.tooltip
    },
    paletteEntryOf(pos: KernelGridPos): KernelPaletteEntryView | null {
      return paletteEntryAt(pos)
    },
    identityRefOf(_pos: KernelGridPos, name: string, meta: number): string | null {
      // 扫 `palette` 表（**不是** `cellPalette`：后者只覆盖"当前有方块的那些格"，
      // 而身份写要回答"这个身份在本文档调色板里存在吗"）。
      // 命中条件：`registryId` 的**尾段**等于 `name`（`name` 已截前缀），且 `meta` 相等。
      if (palette === undefined || name === '') return null
      let hit: string | null = null
      for (const entry of palette) {
        if (entry === null || typeof entry !== 'object') continue
        const typed = entry as BlockPaletteEntry
        if (tailOfRegistryId(String(typed.registryId ?? '')) !== name) continue
        if (Number(typed.meta ?? 0) !== meta) continue
        const key = blockPaletteEntryKey(typed)
        if (key === '') continue
        // 歧义 ⇒ 拒绝（**不**取首条）。
        if (hit !== null && hit !== key) return null
        hit = key
      }
      return hit
    },
    geometryOf(pos: KernelGridPos): readonly BakedQuad[] | null {
      const assetId = cellGeometry?.[cellPositionKey(pos)]
      if (assetId === undefined || geometry === undefined) return null
      return quadsOfAsset(geometry[assetId])
    },
    centerWorld(pos: KernelGridPos): KernelGridPos {
      // 与 legacy `Grid.centerWorld` **逐字同式**（网格居中于原点，方块中心偏移 +0.5）。
      return Object.freeze({
        x: pos.x - size.width / 2 + 0.5,
        y: pos.y - size.height / 2 + 0.5,
        z: pos.z - size.depth / 2 + 0.5,
      })
    },
  })
}

/**
 * 条目 → 读面视图。
 *
 * @param decoded 已归一为"解码后的四边形"的几何（`null` = 无几何）—— **由调用方**
 *   按各自来源算好（内核：资产 `quads`；legacy：`decodeBakedGeometry`），
 *   使本函数不必知道两种承载形态。
 */
function paletteEntryViewOf(
  entry: Record<string, unknown>,
  decoded: readonly BakedQuad[] | null,
): KernelPaletteEntryView {
  const tooltip = entry.tooltip
  return Object.freeze({
    assetId: String(entry.assetId ?? ''),
    registryId: String(entry.registryId ?? ''),
    meta: typeof entry.meta === 'number' ? entry.meta : 0,
    renderMode: typeof entry.renderMode === 'string' ? entry.renderMode : '',
    geometry: decoded,
    ...(typeof entry.occludesAdjacentFaces === 'boolean'
      ? { occludesAdjacentFaces: entry.occludesAdjacentFaces }
      : {}),
    ...(typeof entry.facing === 'string' ? { facing: entry.facing } : {}),
    ...(entry.nbt === null || entry.nbt === undefined
      ? {}
      : { nbt: entry.nbt as Readonly<Record<string, unknown>> }),
    ...(typeof entry.thumbnail === 'string'
      ? { thumbnail: entry.thumbnail }
      : typeof entry.thumbnailPNG === 'string'
        ? { thumbnail: entry.thumbnailPNG }
        : {}),
    ...(Array.isArray(tooltip) ? { tooltip: tooltip as readonly string[] } : {}),
    raw: entry,
  })
}

/** 内核资产 → 解码后四边形（`null` = 无几何资产）。 */
function quadsOfAsset(asset: unknown): readonly BakedQuad[] | null {
  if (asset === null || typeof asset !== 'object') return null
  const q = (asset as { readonly quads?: unknown }).quads
  return Array.isArray(q) ? (q as readonly BakedQuad[]) : null
}

/** legacy 文件原文 → 解码后四边形（解码失败 ⇒ `null`，与旧 `getBlockGeometry` 的 `catch` 同口径）。 */
function quadsOfLegacyGeometry(raw: unknown): readonly BakedQuad[] | null {
  if (raw === null || raw === undefined) return null
  try {
    return decodeBakedGeometry(raw as BakedQuadsGeometry)
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 旧来源 → 同一形状（**回落分支也归本模块**，故消费点零分支）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 旧 `Grid`（`context/grid`）→ 同一读面形状。
 *
 * ## 为什么这里是**唯一**允许 `import` 旧 `Grid` 形状的地方
 *
 * 消费点若各自 `instanceof Grid` 或读 `.cells` 私有结构，就会把旧数据模型
 * 泄漏到 15 处。收在本模块 ⇒ 旧模型只有**一个**引用点，退出时一处即净。
 *
 * ## 与内核分支的两处**刻意**不同
 *
 * | 项 | 内核 | legacy |
 * |---|---|---|
 * | `paletteEntryOf` | 按 `cellPalette` 内容键 → `palette` 位置 | 按 `paletteIndex` → `PaletteCache`（`'#'+idx` 键；见 legacy `getPaletteEntry` 的口径） |
 * | `geometryOf` | `cellGeometry` → `geometry` 目录 | `paletteCache` 条目的 `geometry` 字段 |
 *
 * 两者**语义相同**（都回答"这一格用哪个条目/哪份几何"），差别只在数据模型的
 * 承载方式 —— 这正是本模块存在的理由。
 */

/** 旧 `Grid` 的**结构性**接口（只列本模块用到的成员；不 `import` 类以避免硬依赖）。 */
export interface LegacyGridLike {
  readonly width: number
  readonly height: number
  readonly depth: number
  count(): number
  at(pos: { x: number; y: number; z: number }): LegacySlotBlockLike | null
  forEach(fn: (pos: { x: number; y: number; z: number }, block: LegacySlotBlockLike) => void): void
  partsAt(pos: { x: number; y: number; z: number }): readonly PartRecord[] | null
  /**
   * **原地移动一格**（写操作）。
   *
   * ⚠️ 它**只**供 {@link LegacyGridLike} 的"编辑句柄"用途（
   * `operators/builtin/moveTranslate` 把 grid 捕获进撤销闭包）——
   * **读面**（`KernelGridView`）**没有**这个方法，那正是 B′ 撤回理由①的落点：
   * 读面每次新建对象 ⇒ 在它上面 `moveBlock` 的改动会**静默丢失**。
   */
  moveBlock(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): boolean
  getPaletteCache(): Map<string, LegacyPaletteEntryLike>
  centerWorld(pos: { x: number; y: number; z: number }): { x: number; y: number; z: number }
}

export interface LegacySlotBlockLike {
  readonly name: string
  readonly meta: number
  readonly paletteIndex?: number
}

export interface LegacyPaletteEntryLike {
  readonly registryId?: string
  readonly meta?: number
  readonly nbt?: string
  readonly occludesAdjacentFaces?: boolean
  readonly facing?: string
  readonly tooltip?: string
  readonly geometry?: unknown
  readonly [key: string]: unknown
}

/**
 * 旧网格 → 读面。
 *
 * ⚠️ **逐格说明（`tooltipAt`）在 legacy 分支返回 `undefined`**：
 * legacy 的逐格说明**不在网格上**（它在文档根的 `tooltipPalette`/`cellTooltipGrid`
 * 两个旁表里），故本函数**无从**回答。这不是缺陷而是刻意的分工：
 * 逐格说明有**自己**的读面（`Context#cellTooltips`），消费点按事实选读面，
 * 而不是让一个读面假装知道另一份事实（那正是 D8 的形态）。
 */
export function gridViewOfLegacy(grid: LegacyGridLike): KernelGridView {
  const cacheKeyOf = (idx: number): string => `#${String(idx)}`
  const entryOf = (idx: number | undefined): LegacyPaletteEntryLike | null => {
    if (idx === undefined) return null
    return grid.getPaletteCache().get(cacheKeyOf(idx)) ?? null
  }
  const viewOf = (pos: { x: number; y: number; z: number }, block: LegacySlotBlockLike): KernelGridCellView =>
    Object.freeze({
      pos: Object.freeze({ x: pos.x, y: pos.y, z: pos.z }),
      name: block.name,
      meta: block.meta,
      paletteIndex: block.paletteIndex,
    })

  return Object.freeze({
    width: grid.width,
    height: grid.height,
    depth: grid.depth,
    count(): number {
      return grid.count()
    },
    at(pos: KernelGridPos) {
      const b = grid.at(pos)
      return b === null ? null : viewOf(pos, b)
    },
    forEach(fn: (cell: KernelGridCellView) => void): void {
      grid.forEach((pos, block) => fn(viewOf(pos, block)))
    },
    blocks(): readonly KernelGridCellView[] {
      const out: KernelGridCellView[] = []
      grid.forEach((pos, block) => out.push(viewOf(pos, block)))
      return Object.freeze(out)
    },
    partsAt(pos: KernelGridPos) {
      return grid.partsAt(pos)
    },
    tooltipAt() {
      return undefined
    },
    paletteEntryOf(pos: KernelGridPos): KernelPaletteEntryView | null {
      const b = grid.at(pos)
      if (b === null) return null
      const e = entryOf(b.paletteIndex)
      if (e === null) return null
      return paletteEntryViewOf(e as Record<string, unknown>, quadsOfLegacyGeometry(e.geometry))
    },
    identityRefOf(): string | null {
      // **legacy 侧如实为 `null`**：`cellPalette`（含真 `registryId` 的内容键）是
      // **内核 `blockGrid` 载荷**的概念，旧 `Grid` 只有 `paletteIndex` 槽位，
      // 没有任何内容键形态可返回。
      //
      // 这不是"缺实现"，而是**事实**：身份写的权威在内核（`setCellIdentity` 写的是
      // `cells` + `cellPalette` 两表）。未装配内核时无从表达 ⇒ 返回 `null`，
      // 由调用方**如实拒绝**（`identity-not-in-palette`），
      // **不**回落到旧 `setBlock`（那正是 GF-7 丢命名空间的写点，已退役）。
      return null
    },
    geometryOf(pos: KernelGridPos): readonly BakedQuad[] | null {
      const b = grid.at(pos)
      if (b === null) return null
      return quadsOfLegacyGeometry(entryOf(b.paletteIndex)?.geometry)
    },
    centerWorld(pos: KernelGridPos) {
      return grid.centerWorld(pos)
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部
// ─────────────────────────────────────────────────────────────────────────────

function parsePositionKey(key: string): KernelGridPos | null {
  const parts = key.split(',')
  if (parts.length !== 3) return null
  const [x, y, z] = parts.map(Number)
  if (x === undefined || y === undefined || z === undefined) return null
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  return { x, y, z }
}

/**
 * GF-7 编码（`minecraft:<name>[:<meta>]`）→ `{name, meta}`。
 *
 * ## 为什么这里**不**做命名空间还原（D9 的教训）
 *
 * `cells` 的值**从构造起就是有损的**（GF-7 把它编码成 `minecraft:<name>:<meta>`），
 * 真实命名空间只活在 `cellPalette` 的**内容键**里。D9 的实测结论是：
 * 按几何身份（`assetId`）猜命名空间会**错配**（EBF 两方块共享同一 `assetId`）。
 * ⇒ 本函数**只**解出 `name`/`meta`（即 legacy `SlotBlock` 的两个字段，语义逐字相同），
 * 命名空间由 `paletteEntryOf` 经**内容键精确命中**给出 —— 两条事实分两个入口，
 * 不混成一个"看起来完整"的身份。
 */
function parseGf7(id: string): { readonly name: string; readonly meta: number } {
  const parts = id.split(':')
  if (parts.length === 1) return { name: parts[0] ?? '', meta: 0 }
  if (parts.length === 2) return { name: parts[1] ?? '', meta: 0 }
  const meta = Number(parts[2])
  return { name: parts[1] ?? '', meta: Number.isFinite(meta) ? meta : 0 }
}
