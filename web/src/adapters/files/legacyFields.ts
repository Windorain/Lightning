/**
 * `adapters/files/legacyFields` —— **旧线格式字段的保真读写与成对不变量**
 * （B1 §A.2 的 F-11/F-13/F-19/F-21/F-22/F-30/F-32；#260 A20）。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 问题 |
 * |---|---|---|
 * | `textureBlobIndex` 越界校验 | `render/data/bundleResolve.ts:86-105` | 只在**渲染解析**路径上，读文件时不过；且 `?? ` 回退的 snake_case 形态没有集中定义 |
 * | `tooltipPalette`/`cellTooltipGrid` 成对 | `MeshCaptureService.java:170-171,185-186`（产出侧）+ `builtinParsers.ts:102-104`（消费侧） | 成对性由"产出侧记得写"维持，读入侧不校验 |
 * | `statsTemplate`/`statsOverride` 透传 | `builtinParsers.ts:30-32,167-169` | 透传目的（"读到静默忽略"）只写在注释里 |
 * | 根级字段清单 | `builtinParsers.ts:30-38` 的 `STRUCTURE_ROOT_FIELDS`/`PART_ROOT_FIELDS` | 两条解析链各引用同一份常量**是纪律**，不是类型保证 |
 *
 * 本模块把这几条从"产出侧纪律"搬成**读入侧的单一判据**。方向很重要：产出侧的
 * 正确性无法阻挡别人写来的文件 —— 而"读别人的文件"正是适配器的全部工作。
 *
 * ## 一条明确的政策：校验的**方向**是不许静默降级，但也不许把历史文件判死
 *
 * `#260` 正文要求"旧格式适配（版本/坐标约定/调色板/字段迁移）"与"**不静默丢语义**"。
 * 两者在这里的交汇点是：
 *
 *  - **越界索引** ⇒ **必须报错**（不是"当空纹理渲染"）。B-6 的原文；
 *  - **缺失的成对网格** ⇒ **补空**（不是报错）。理由：`cellTooltipGrid` 是**新增**
 *    的叠加层（B1 F-13 记的是"产出侧无条件写出"），早于它存在的文件里**本来就没有**
 *    这一层。"缺层"与"层里说这格没有说明"在语义上确实是同一件事，补空是**如实表达**，
 *    不是降级；反之若报错，所有 2024 年以前的文件全部打不开。
 *  - **`statsTemplate`/`statsOverride`** ⇒ **透传但零语义消费**，且**必须**能被断言
 *    "没丢也没用"（B-25：读到静默忽略，不报错、不空栏）。
 */

import { invalidValue, type Result, ok, err } from '@/domain/errors'
import type { Vec3 } from '@/domain/scene'
import { mcCellToScene } from './mcAxisProfile'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// ─────────────────────────────────────────────────────────────────────────────
// F-11 / B-6：materialPalette[].textureBlobIndex
// ─────────────────────────────────────────────────────────────────────────────

/** `textureBlobIndex` 的 camelCase 权威键名（产出侧只写它）。 */
export const TEXTURE_BLOB_INDEX_FIELD = 'textureBlobIndex'

/**
 * `textureBlobIndex` 的 snake_case 回退键名（F-11 明文："同时接受 snake_case 回退，
 * 兼容双写，须保留"）。
 *
 * B1 记的是 `bundleResolve.ts:93-94` 的 `e.textureBlobIndex ?? e.texture_blob_index`。
 * 那条 `?? ` 是**唯一**一处，散落在渲染路径里 —— 本模块把它提出来做成具名常量，
 * 使"回退键叫什么"只有一处定义。
 */
export const TEXTURE_BLOB_INDEX_FALLBACK_FIELD = 'texture_blob_index'

/**
 * 读一个材质条目的 blob 下标。
 *
 * 返回 `null` 表示**没有合法下标**（缺失 / 非数 / 非有限）。`null` 与 `0` 必须可区分
 * —— `0` 是一个完全合法的下标（blob 池第一项），把它与"没有"混在一个哨兵值上，
 * 正是 `#249` §19.3 + A36 负对照「`null` 同时代表加载中/缺失/失败」的同一类错误。
 */
export function readTextureBlobIndex(entry: unknown): number | null {
  if (!isPlainObject(entry)) return null
  const raw =
    entry[TEXTURE_BLOB_INDEX_FIELD] !== undefined
      ? entry[TEXTURE_BLOB_INDEX_FIELD]
      : entry[TEXTURE_BLOB_INDEX_FALLBACK_FIELD]
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return Math.floor(raw)
}

/** 材质索引缺陷（结构化）。 */
export interface MaterialIndexDefect {
  readonly code: 'TextureBlobIndexMissing' | 'TextureBlobIndexOutOfRange'
  readonly at: string
  readonly index: number
  readonly blobCount: number
}

/**
 * 校验材质表条目对 blob 池的引用（B-6 的负对照落点）。
 *
 * **越界即报错**：`textureBlobIndex=5` 而池里只有 3 项时，旧实现若"当空纹理渲染"，
 * 用户看到的是"这个方块没有贴图"而不是"文件坏了" —— 那是 `#249` §12
 * 「不能静默丢失无法解释的语义」要判红的形态（A20 负对照 c：必须报错）。
 *
 * 池为空或缺席时**不校验**：空文档本来就没有贴图（`bundleResolve.ts:112-113`
 * 的"空文档无 textureBlobs 时跳过"是既有事实，保留它不是放宽 —— 放宽会是
 * "有池但不校验"）。
 */
export function checkMaterialBlobIndexes(palette: unknown, blobCount: number, at = 'materialPalette'): readonly MaterialIndexDefect[] {
  if (!Array.isArray(palette) || blobCount <= 0) return Object.freeze([])
  const out: MaterialIndexDefect[] = []
  palette.forEach((entry, i) => {
    const idx = readTextureBlobIndex(entry)
    if (idx === null) {
      out.push(Object.freeze({ code: 'TextureBlobIndexMissing' as const, at: `${at}[${i}]`, index: -1, blobCount }))
      return
    }
    if (idx < 0 || idx >= blobCount) {
      out.push(Object.freeze({ code: 'TextureBlobIndexOutOfRange' as const, at: `${at}[${i}]`, index: idx, blobCount }))
    }
  })
  return Object.freeze(out)
}

/** 对**文档**跑材质索引校验（根级 `materialPalette`；World 与 Structure 同一位置）。 */
export function checkDocumentMaterialIndexes(doc: unknown): readonly MaterialIndexDefect[] {
  if (!isPlainObject(doc)) return Object.freeze([])
  const blobs = Array.isArray(doc.textureBlobs) ? doc.textureBlobs.length : 0
  const out: MaterialIndexDefect[] = [...checkMaterialBlobIndexes(doc.materialPalette, blobs, 'materialPalette')]
  if (Array.isArray(doc.frames)) {
    doc.frames.forEach((frame, i) => {
      if (!isPlainObject(frame)) return
      const structure = frame.structure
      if (!isPlainObject(structure)) return
      // 帧内也可能自带 materialPalette（`format-scene-file.md:64`：`shape:"structure"`
      // 的产物**没有**跨帧调色板提升，故 palette 落在帧/根上）。同一判据覆盖两者。
      for (const d of checkMaterialBlobIndexes(structure.materialPalette, blobs, `frames[${i}].structure.materialPalette`)) out.push(d)
    })
  }
  return Object.freeze(out)
}

/** 缺陷 → 结构化错误（第一个；`InvalidValue` —— 值本身不合法，契约 §3.2）。 */
export function materialIndexError(doc: unknown): ReturnType<typeof invalidValue> | null {
  const defects = checkDocumentMaterialIndexes(doc)
  if (defects.length === 0) return null
  const first = defects[0]!
  return invalidValue({ reason: first.code, at: first.at, index: first.index, blobCount: first.blobCount })
}

/** `Result` 形态：索引合法则 `ok(void)`，越界即显式拒绝（**不当空纹理**）。 */
export function requireMaterialIndexes(doc: unknown): Result<null> {
  const e = materialIndexError(doc)
  return e === null ? ok(null) : err(e)
}

// ─────────────────────────────────────────────────────────────────────────────
// F-13 / B-7：tooltipPalette + cellTooltipGrid 成对 idioms
// ─────────────────────────────────────────────────────────────────────────────

/** `-1` = 该格无说明（`render/schema/types.ts:145` `TOOLTIP_GRID_NONE`）。 */
export const TOOLTIP_GRID_NONE = -1

/** 成对化的结果。 */
export interface TooltipPairing {
  /** 说明池（缺省 ⇒ 空数组，**不是** `undefined`）。 */
  readonly tooltipPalette: readonly string[]
  /** 逐格下标网格（缺省 ⇒ 按 `cellGrid` 形状填满 `-1`）。 */
  readonly cellTooltipGrid: readonly (readonly (readonly number[])[])[]
  /** 本次是否**补**了缺失的一半（诊断用：区分"文件本来成对"与"我们补的"）。 */
  readonly synthesized: 'none' | 'grid' | 'palette'
}

/**
 * 把"成对 idioms"变成**读入侧的不变量**（B-7）。
 *
 * 三条判据：
 *  1. 有网格无池 ⇒ 池补空数组（网格里只应有 `-1`；有非 `-1` 而无池是**真缺陷**，
 *     报 `InvalidValue` 而不是补一个空池把说明弄丢）；
 *  2. 有池无网格 ⇒ 按 `cellGrid` 形状补 `-1` 网格（早于该层的文件）；
 *  3. `cellTooltipGrid` 非 `-1` 的下标越界 ⇒ **报错**（与材质索引同一政策：
 *     越界是"无法解释的语义"，不是"没有说明"）。
 *
 * `cellGrid` 形状不可得时（没有 `cellGrid` 的文件）⇒ 网格按 `-1` 单层空网格补，
 * 由调用方决定是否继续；本函数**不**凭空造网格维度。
 */
export function pairTooltipIdioms(structure: unknown): Result<TooltipPairing> {
  if (!isPlainObject(structure)) {
    return err(invalidValue({ reason: 'tooltipPairingNotObject' }))
  }
  const paletteRaw = structure.tooltipPalette
  const gridRaw = structure.cellTooltipGrid
  const palette = Array.isArray(paletteRaw) ? paletteRaw.filter((x): x is string => typeof x === 'string') : null
  const grid = Array.isArray(gridRaw) ? gridRaw : null

  if (grid !== null) {
    // 网格里出现非 -1 下标时，池**必须**存在且覆盖它 —— 否则那是丢失的说明。
    const referenced = collectGridIndices(grid)
    const bad = referenced.filter((i) => i !== TOOLTIP_GRID_NONE && (palette === null || i < 0 || i >= palette.length))
    if (bad.length > 0) {
      return err(invalidValue({ reason: 'TooltipIndexOutOfRange', index: bad[0]!, tooltipCount: palette?.length ?? 0 }))
    }
    if (palette === null) {
      return ok(Object.freeze({ tooltipPalette: Object.freeze([]), cellTooltipGrid: grid, synthesized: 'palette' as const }))
    }
    return ok(Object.freeze({ tooltipPalette: Object.freeze([...palette]), cellTooltipGrid: grid, synthesized: 'none' as const }))
  }

  // 无网格：按 cellGrid 形状补 -1 网格。`cellGrid` 缺席时补空网格（调用方按 shape 判定）。
  const shape = gridShapeOf(structure.cellGrid)
  const filled = fillGrid(shape, TOOLTIP_GRID_NONE)
  return ok(
    Object.freeze({
      tooltipPalette: Object.freeze(palette === null ? [] : [...palette]),
      cellTooltipGrid: filled,
      synthesized: 'grid' as const,
    }),
  )
}

function collectGridIndices(grid: unknown): number[] {
  const out: number[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x)
      return
    }
    if (typeof v === 'number' && Number.isFinite(v)) out.push(Math.floor(v))
  }
  walk(grid)
  return out
}

/**
 * 取出网格里出现的全部整数下标（供诊断与断言复用）。
 *
 * 与内部遍历是**同一个**实现（下面的具名导出只是它的公共别名）——
 * 导出它的理由：测试要能独立验证"网格里到底有哪些下标"，
 * 而不是只能通过 `pairTooltipIdioms` 的成功/失败间接推断。
 */
export function collectGridIndicesPublic(grid: unknown): readonly number[] {
  return Object.freeze(collectGridIndices(grid))
}

function gridShapeOf(cellGrid: unknown): readonly [number, number, number] {
  if (!Array.isArray(cellGrid) || cellGrid.length === 0) return Object.freeze([0, 0, 0] as const)
  const rows = Array.isArray(cellGrid[0]) ? (cellGrid[0] as unknown[]).length : 0
  const firstRow = Array.isArray(cellGrid[0]) && Array.isArray((cellGrid[0] as unknown[])[0]) ? ((cellGrid[0] as unknown[])[0] as unknown[]).length : 0
  return Object.freeze([cellGrid.length, rows, firstRow] as const)
}

function fillGrid(shape: readonly [number, number, number], value: number): readonly (readonly (readonly number[])[])[] {
  const [z, row, col] = shape
  const out: number[][][] = []
  for (let i = 0; i < z; i++) {
    const slice: number[][] = []
    for (let r = 0; r < row; r++) {
      const line: number[] = []
      for (let c = 0; c < col; c++) line.push(value)
      slice.push(line)
    }
    out.push(slice)
  }
  return Object.freeze(out.map((s) => Object.freeze(s.map((r) => Object.freeze(r)))))
}

// ─────────────────────────────────────────────────────────────────────────────
// F-14：cellGrid[z][row][col]，row 0 = 顶部
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `cellGrid` 的朝向换算**不在本模块** —— 它是轴序知识，唯一实现在
 * `adapters/files/mcAxisProfile`（"row 0 = 顶部"的依据与推导逐条写在那里）。
 * 本模块只留一个转发，避免出现第二条 `sizeRow-1-row`。
 *
 * ## 为什么是转发**函数**而不是 `export { … } from`
 *
 * 本仓的边界闸门把「新实现里的 `export … from`」一律判红
 * （`tests/architecture/kernel-legacy-isolation.test.ts` 的「内核不得重新导出任何模块」：
 * 转出口是"新门面包旧核心"的入口形态，且无法从语法上区分"兼容门面"与"无害别名"）。
 * 一条具名转发函数表达同一件事，且**不带**那条禁令要防的形态 ——
 * 它是本模块**新增**的行为，不是把别处的实现偷偷挂上本模块的公开面。
 */
export function cellGridIndexToScene(col: number, row: number, zSlice: number, rowCount: number): Vec3 {
  return mcCellToScene(col, row, zSlice, rowCount)
}

// ─────────────────────────────────────────────────────────────────────────────
// F-21 / F-22 / B-13：itemIndex 单一数据源
// ─────────────────────────────────────────────────────────────────────────────

/** 文档根级 `itemIndex` 字段名（与 `pure/itemIndex.ts:44` 同源事实，此处只作读写键）。 */
export const ITEM_INDEX_FIELD = 'itemIndex'

/** `blockPalette[].hostItem` 字段名（F-22）。 */
export const HOST_ITEM_FIELD = 'hostItem'

/**
 * 读文档根级 `itemIndex`（**原始**形态）。
 *
 * ## 为什么本模块只"取出来"而**不**建第二套反查索引
 *
 * B1 的 F-21 记的硬约束是「**单一数据源**：消费侧只从本表生成反查索引，
 * **不**从 `partLists`/`cellGrid` 二次推导」（`format-parts-contract.md:174-176`）。
 * 反查索引的实现已存在（`pure/itemIndex.ts` 的 `buildItemHitIndex`，但那是**旧层**，
 * `adapters` 不得 import）。⇒ 本模块只负责**把线格式的字段取出来并校验形状**，
 * 反查索引的构造由后续批次的类型化模型承担（P10 接线，已登记）。
 *
 * 这个切分本身也是"不静默"的：把 `partLists` 当备用来源推导一次，就会产生
 * "文件里没有 `itemIndex` 时界面也能出说明"的假象 —— 而真实原因是**推导出了**
 * 与文件不一致的身份。
 */
export function readItemIndex(doc: unknown): Readonly<Record<string, unknown>> | null {
  if (!isPlainObject(doc)) return null
  const raw = doc[ITEM_INDEX_FIELD]
  if (!isPlainObject(raw)) return null
  return raw
}

/**
 * `itemIndex` 的键集是否**覆盖**所有部件的物品键（B-13 可执行判据）。
 *
 * 判据来源：`format-parts-contract.md` 的键集要求「键集 = 全部部件的全部 `items[]` 条目」。
 * 本函数只**报告**缺失的键，不改写表 —— 补键等于替导出侧修数据，那会掩盖真实的
 * 导出缺陷（#249 §12「不静默丢语义」的对偶：也不静默补语义）。
 */
export function missingItemIndexKeys(
  itemIndex: Readonly<Record<string, unknown>> | null,
  partItemKeys: readonly string[],
): readonly string[] {
  const have = new Set(itemIndex ? Object.keys(itemIndex) : [])
  const missing = new Set<string>()
  for (const k of partItemKeys) if (!have.has(k)) missing.add(k)
  return Object.freeze([...missing].sort())
}

// ─────────────────────────────────────────────────────────────────────────────
// F-30 / B-25：statsTemplate / statsOverride —— 透传但语义作废
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 语义已作废、只保留线格式的根级字段（F-30 / B-25）。
 *
 * `format-parts-contract.md:351-374` 的兼容口径原文是**静默忽略**：
 * 「读到后**静默忽略**，不报错、不空栏」。
 *
 * 「不空栏」是关键的一条：旧的统计面板若因为读不到语义而显示空白，用户会以为
 * 数据丢了 —— 而实际上是**这套语义已被整套移除**（三级配置废弃）。
 * 本模块因此提供 {@link statsFieldsCarried} 让调用方能**断言**"字段被原样带过来了"，
 * 从而把"我们没丢它"与"我们没有用它"两件事同时变成可检查的事实。
 */
export const DEPRECATED_STATS_FIELDS = Object.freeze(['statsTemplate', 'statsOverride'] as const)

/** 字段名是否属于"语义已作废但线格式保留"的那一组。 */
export function isDeprecatedStatsField(key: string): boolean {
  return (DEPRECATED_STATS_FIELDS as readonly string[]).includes(key)
}

/**
 * 从文档里取出这些字段的**原样值**（缺席即缺项）。
 *
 * 返回 `Record` 而不是数组：下游要按字段名写回原位，`Array` 会逼它再匹配一次名字。
 * **不做任何默认值填充** —— 填一个 `{}` 会让"文件里没有"与"文件里是空对象"
 * 变得不可区分，而那正是 A36 负对照的同一类错误。
 */
export function statsFieldsCarried(doc: unknown): Readonly<Record<string, unknown>> {
  if (!isPlainObject(doc)) return Object.freeze({})
  const out: Record<string, unknown> = {}
  for (const key of DEPRECATED_STATS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(doc, key)) out[key] = doc[key]
  }
  return Object.freeze(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// F-19 / F-32：根级透传清单
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **裸结构**根级透传字段（F-32 的 `STRUCTURE_ROOT_FIELDS` 事实，逐项对齐
 * `builtinParsers.ts:35-38`）。
 */
export const STRUCTURE_ROOT_FIELDS: readonly string[] = Object.freeze([
  'materialPalette',
  'textureBlobs',
  'tooltipPalette',
  'cellTooltipGrid',
  'playback',
  ...DEPRECATED_STATS_FIELDS,
  'partIconTextures',
  ITEM_INDEX_FIELD,
])

/**
 * **World** 根级透传字段（F-32 的另一半；两条链**必须**同一份清单，
 * 否则 World 根会丢 `itemIndex`）。
 */
export const WORLD_ROOT_FIELDS: readonly string[] = Object.freeze([
  'materialPalette',
  'blockPalette',
  'textureBlobs',
  'tooltipPalette',
  'cellTooltipGrid',
  'playback',
  ...DEPRECATED_STATS_FIELDS,
  'partIconTextures',
  ITEM_INDEX_FIELD,
])

/**
 * 按清单搬运字段（`copyIfPresent` 语义）。
 *
 * #249 §12 与 `format-scene-file.md:156` 的 `copyIfPresent` 原文：
 * 「文档本来没有的键**不会凭空出现**」。
 *
 * 这是"命令通道产物逐字节不变"（B-1）的结构性前提：若搬运时给缺席的键填默认值，
 * 输出就会多出键 ⇒ 字节变化。故本函数**只**在源里 `hasOwnProperty` 时写入。
 */
export function copyFieldsIfPresent(
  src: unknown,
  keys: readonly string[],
  dst: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!isPlainObject(src)) return dst
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(src, key)) dst[key] = src[key]
  }
  return dst
}
