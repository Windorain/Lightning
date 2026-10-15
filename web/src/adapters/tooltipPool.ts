/**
 * `adapters/tooltipPool` —— **逐格说明池的编解码**（#289 P10d D1 补充）。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | 投影**完全不写** `tooltipPalette`/`cellTooltipGrid` | `composition/kernelProjection.ts` | 由本模块把内核的逐格文本重新聚成"池 + 下标网格" |
 *
 * ## 为什么它在 `adapters/` 而不是 `composition/`
 *
 * 这是**文件格式**的编码（"池 + `-1` 下标网格"是文件形态的压缩装置），
 * 而 `adapters/files/legacyFields.ts` 已经是该 idiom 的归属地
 * （F-13 / B-7「`tooltipPalette` + `cellTooltipGrid` 成对 idioms」）。
 *
 * 第一版把它写在 `composition/kernelProjection.ts`，于是要取 `-1` 哨兵：
 *  - 从 `@/render/schema/types` 取 ⇒ `gate/no-private-cross-layer` 判红（深度 3）；
 *  - 从 `@/adapters/files/legacyFields` 取 ⇒ 同一条判红（深度 3）；
 *  - 在 `adapters/plainRoot.ts` 再导出 ⇒ `gate/no-barrel-smuggling` 判红（barrel 未登记）。
 *
 * 三次判红都指向同一件事：**这个函数放错了层**。它与哨兵同属"文件格式 idiom"，
 * 放到 `adapters/`（与 `files/*` 同层，可自由引用）后两个闸门同时满足，
 * 且哨兵的值**仍只有一个来源**。
 *
 * ## 它是装配侧 `assembleTooltipContent` 的**逆**
 *
 * | 方向 | 输入 | 输出 |
 * |---|---|---|
 * | 装配（`composition/kernelPaletteAssembly`） | `cellTooltipGrid` + `tooltipPalette` | 逐格 `cellContent[key].tooltip`（`-1` 吸收成**字段缺席**） |
 * | 投影（本模块） | 逐格 `cellContent[key].tooltip` | `tooltipPalette`（**内容去重**）+ `cellTooltipGrid`（`-1` = 无说明） |
 *
 * 池按**内容去重**（同文案共享一个下标）⇒ 往返后逐格文本相同，而池可能比源更紧凑
 * （源里重复的文案被合并）。这是无损的：判据是"逐格文本相同"，不是"池逐字节相同"。
 *
 * ## 纯度
 *
 * 无 IO、无 DOM、无时钟；输入输出都是纯数据。与 `domain/` 的纯性纪律一致
 * （本层只是"实现端口"，见 `#249 §4 规则 4`）。
 */

import { TOOLTIP_GRID_NONE } from './files/legacyFields'

/** 格坐标（Y-up 世界坐标；见 GF-7）。 */
interface CellPos {
  readonly x: number
  readonly y: number
  readonly z: number
}

/**
 * 逐格说明池的产物：池（内容去重）+ 下标网格（`[z][row][col]`，`-1` = 无说明）。
 */
export interface TooltipPool {
  readonly palette: readonly string[]
  readonly grid: readonly number[][][]
}

/**
 * 网格的**声明尺寸**（`cellGrid` 的三个维度；轴与 {@link TooltipPool} 的 `[z][row][col]` 同义）。
 *
 * 由调用方从**同一份载荷**的 `sizeColumn/sizeRow/sizeZSlice` 传入 —— 这三个字段是
 * 装配期从文件 `cellGrid` 的维度写下的（`kernelAssembly#gridPayload`），
 * 故它就是"说明网格该有多大"的**唯一权威**。
 */
export interface TooltipPoolDeclaredSize {
  /** x 宽（`cellGrid` 的第三维长度）。 */
  readonly width?: number
  /** y 高（`cellGrid` 的第二维长度 = `sizeRow`）。 */
  readonly height?: number
  /** z 深（`cellGrid` 的第一维长度）。 */
  readonly depth?: number
}

/** 合法声明分量（正整数）⇒ 原值；其余（缺省/0/负数/非整数）⇒ 0（等于"无声明"）。 */
function declaredAxis(v: number | undefined): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0
}

/**
 * 逐格说明 → `tooltipPalette` + `cellTooltipGrid`。
 *
 * ## 四条契约事实
 *
 * 1. **行序要翻回**：内核的格键是 Y-up 世界坐标（GF-7），而文件的
 *    `cellTooltipGrid` 是 `[z][row][col]` 且 **row 0 = 顶部**。
 *    装配期用 `row' = sizeRow - 1 - row` 翻过来；本函数用同一个**自逆**式子翻回去。
 * 2. **形状的权威是载荷声明，**不是**说明格的包围盒**（M1 P3 实测修的）：
 *    消费侧（`kernelAssembly#tooltipContentOf`）**逐字**用 `grid.height` 反解行号，
 *    其注释即写明「说明网格与 `cellGrid` **同形**」。于是若这里按包围盒输出，
 *    "最高一行没有说明"的文档会得到一个**比声明矮**的 `cellTooltipGrid`
 *    ——重开时同一个注解会被 `sizeRow - 1 - row` 映到**另一格**（静默搬行）。
 *    实测（真实信封，删掉最高行注解后走 `保存到文件 → 打开场景`）：
 *    `cellGrid` 声明 `7x6x19` 而产物 `cellTooltipGrid` 为 `7x5x16`，
 *    重开后 17 个注解**全部上移一行**。
 *    ⇒ 尺寸取 **`max(声明, 说明格包围盒)`**（逐轴）：
 *     - 声明更大：尾行/尾列补 `-1`（声明是文件的事实，与 `projectGridCells` 同口径）；
 *     - 声明更小或缺失（畸形/自造内容）：按包围盒**扩张**，绝不截断注解
 *       （截断即丢用户数据，见 #171 硬底线）。
 *    包围盒仍**是**下界，故"无声明"时行为与修复前**逐字相同**。
 * 3. **`-1` 是"无说明"**（`TOOLTIP_GRID_NONE`）。内核侧"字段缺席"映回 `-1`，
 *    **不是空串** —— 空串是"显式空说明"，与"没有说明"是两回事。
 * 4. **返回 `null` = 该文档没有任何逐格说明** ⇒ 调用方不写这两项（与装配侧
 *    "缺省 = 无逐格内容"对称）。写一个全 `-1` 的空网格会让"没有说明"
 *    与"有说明但是空"混淆。
 *
 * @param cells 逐格内容（键 = `` `${x},${y},${z}` ``，值只需 `tooltip` 字段）
 * @param declared 同一份载荷的声明尺寸（缺省 ⇒ 只用包围盒；见判据 2）
 */
export function tooltipPoolOf(
  cells: Readonly<Record<string, { readonly tooltip?: string }>> | undefined,
  declared?: TooltipPoolDeclaredSize,
): TooltipPool | null {
  if (cells === undefined) return null
  const entries: { pos: CellPos; tooltip: string }[] = []
  for (const [key, content] of Object.entries(cells)) {
    const tooltip = content.tooltip
    if (typeof tooltip !== 'string') continue
    const pos = parseKey(key)
    if (pos === null) continue
    entries.push({ pos, tooltip })
  }
  if (entries.length === 0) return null
  // 包围盒 = 尺寸的**下界**（网格必须覆盖全部带说明的格，否则它们会被静默丢弃）；
  // 上界由载荷声明给出（见文件头判据 2）。
  let maxX = 0
  let maxY = 0
  let maxZ = 0
  for (const e of entries) {
    if (e.pos.x > maxX) maxX = e.pos.x
    if (e.pos.y > maxY) maxY = e.pos.y
    if (e.pos.z > maxZ) maxZ = e.pos.z
  }
  // 尺寸 = max(载荷声明, 说明格包围盒)（逐轴；见文件头判据 2）。
  const boundsWidth = maxX + 1
  const boundsHeight = maxY + 1
  const boundsDepth = maxZ + 1
  const width = Math.max(boundsWidth, declaredAxis(declared?.width))
  const height = Math.max(boundsHeight, declaredAxis(declared?.height))
  const depth = Math.max(boundsDepth, declaredAxis(declared?.depth))
  // 池：按**内容去重**（同文案共享一个下标）；首见顺序 ⇒ 稳定可复现。
  const palette: string[] = []
  const indexOfText = new Map<string, number>()
  const grid: number[][][] = []
  for (let z = 0; z < depth; z++) {
    const slice: number[][] = []
    for (let row = 0; row < height; row++) slice.push(new Array(width).fill(TOOLTIP_GRID_NONE))
    grid.push(slice)
  }
  for (const e of entries) {
    let idx = indexOfText.get(e.tooltip)
    if (idx === undefined) {
      idx = palette.length
      palette.push(e.tooltip)
      indexOfText.set(e.tooltip, idx)
    }
    // 行序翻回（row 0 = 顶部）；与装配期同一个**自逆**式子。
    const row = height - 1 - e.pos.y
    grid[e.pos.z]![row]![e.pos.x] = idx
  }
  return { palette, grid }
}

/**
 * 解析格键 `` `${x},${y},${z}` ``。
 *
 * **空段显式拒绝**：`"1,2,"` 不得被读成 `(1,2,0)` —— 那是一次真实的坐标误读
 * （与 `composition/kernelProjection#parseBlockCellKey` 同一判据；本层不 import
 * 上层，故自带一份**局部**实现，判据却不放宽）。
 */
function parseKey(key: string): CellPos | null {
  const parts = key.split(',')
  if (parts.length !== 3) return null
  const out: number[] = []
  for (const p of parts) {
    if (p === '') return null
    const n = Number(p)
    if (!Number.isFinite(n) || !Number.isInteger(n)) return null
    out.push(n)
  }
  return { x: out[0]!, y: out[1]!, z: out[2]! }
}
