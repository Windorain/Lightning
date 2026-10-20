/**
 * `runtime/tooltipRead` —— **内核逐格说明的读取面 / 回写面**（#301 P10f D2 收尾，回 **#333**）。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | `doc.tooltipPalette` / `doc.cellTooltipGrid` 直读直写（两个平行数组 + 下标配对） | `editors/property-writers.ts:166-180`、`operators/builtin/metaEditOperators.ts` | 从内核 `blockGrid.cellContent[].tooltip` 投影出**同形状**的侧表 |
 *
 * ## ⚠️ 为什么必须存在（**#333** 的成因就是它缺席）
 *
 * D0 段二把"逐格说明编辑"迁到内核命令（`setCellTooltip`），而
 * `Context#syncLegacyFromKernel` 的**文件头自己写明**：
 *
 * > 「网格/材质/帧轴本批**不写**，故无需回写；**将来若要写它们，必须同时扩本方法**
 * > （成对铁律第④项：同一事实的全部消费者同批迁移）。」
 *
 * ⇒ 那次迁移**违反了它自己引用的纪律**：内核写了 `cellContent.tooltip`、legacy 侧表
 * 未被投影，而**面板与保存读 legacy** ⇒ 表现为"提交成功但值没出现"
 * （e2e `input-routing.spec.ts` 的 A25-3b 双 project 确定性红）。
 * 本模块 + `Context#syncLegacyFromKernel` 的扩展就是那条纪律的**补做**。
 *
 * ## 为什么在 `runtime/` 而不是 `composition/`
 *
 * 与 `runtime/annotationRead` 同一判据：本模块**不依赖任何 composition 模块** ——
 * 它只做"从内核载荷取逐格文本 → 重聚成文件格式的池+网格"，而那一步的
 * **编码实现**（含 `-1` 哨兵与行序翻转）已在 `adapters/tooltipPool`（深度 2）
 * ⇒ `runtime/` 引它合规，且**不存在第二份编码**。
 *
 * ## ⚠️ "取哪一份载荷"的选择规则必须与投影侧**同一条**
 *
 * | 侧 | 位置 | 规则 |
 * |---|---|---|
 * | 保存/导出投影 | `composition/kernelProjection#tooltipPoolOfPayloads` | 按**文档顺序**取**第一个**有池的 `blockGrid` 载荷 |
 * | 本模块 | {@link projectCellTooltipsToLegacy} | 同一条（同一份 `tooltipPoolOf` + 同一遍历序） |
 *
 * 两条为什么必须一致：装配期把**同一份**文档级说明复制到**每一个**帧对象
 * （`kernelAssembly` 的帧循环）⇒ 正常情形下各帧的池相同、取哪一份都等价；
 * 但若它们不一致（历史缺陷/外部构造），两侧取值不同会导致
 * "**存出来的**与**面板看到的**不一样"。
 *
 * ⇒ 该不变量由判据把守（`p10fPanelTooltipWrite.test.ts` 的"两侧投影必须一致"组），
 * 而不是只靠这段注释。
 */

import type { Document } from '@/domain/document'
import { findObject, findObjectData } from '@/domain/scene'
import { tooltipPoolOf, type TooltipPool } from '@/adapters/tooltipPool'

/** 逐格说明侧表的**文件格式形状**（`tooltipPalette` + `cellTooltipGrid` 成对）。 */
export interface LegacyCellTooltips {
  readonly palette: readonly string[]
  readonly grid: readonly number[][][]
}

/**
 * 内核文档 → legacy 逐格说明侧表（`tooltipPalette` + `cellTooltipGrid`）。
 *
 * @returns `null` = 内核里**没有任何**逐格说明（调用方据此把 legacy 侧表**清成没有**，
 *          见 `RuntimeDocument#withCellTooltips` 的 `undefined` 语义）。
 *
 * ⚠️ 返回 `null` 与"返回空池"**不是**一回事：前者是"没有这一对字段"，
 * 后者是"字段存在但为空"（文件里写 `[]`）。本工程口径是「缺席 ≠ 空」
 * （`domain/cellContent` 判据 3），故必须能区分。`tooltipPoolOf` 已经是这个口径
 * （`entries.length === 0 ⇒ null`），本函数**透传**它、不重新判定。
 */
/**
 * 按**内核格坐标**（Y-up 世界坐标）从池里读一格说明文本。
 *
 * ## 为什么这个函数必须存在（M1 P2 运行期实测的"面板读到镜像行"）
 *
 * 池的编码是 `grid[z][row][col]` 且 **`row 0 = 顶部`**（`adapters/tooltipPool`
 * 的 `row = height - 1 - y`），与文件格式同形。**写**侧（`setCellTooltip` 的 `cells`）
 * 与**核**侧（`cellContent` 的格键）用的都是世界坐标，故任何"按世界坐标读池"的
 * 消费点都必须做**同一个自逆翻转** —— 漏掉它就会读到**镜像那一行**的另一格。
 *
 * P2 实测（真实信封、非构造）：
 * ```
 * 面板坐标 = 9,2,5（= 内核格 x=9,y=2,z=5）
 * 写入后：池 grid[5][3][9] = "MARKER-A"（写入落点正确，与文档网格逐格 diff 一致）
 * 而 RNA 读面用 grid[z][y][x] = grid[5][2][9] ⇒ 读到 "" （另一格的空值）
 * ```
 * 表现为"选中一格、面板 Tooltip 恒为空，输入后仍然显示空"——**假象是"没写进去"**。
 *
 * 高度取**池自身**的行数：读的是池，就必须按池的编码反解。M1 P3 起池的形状
 * 由**载荷声明**决定（`tooltipPoolOf` 的 `declared` 参数：`max(声明, 包围盒)`），
 * 故这里的"池自身行数"就是装配侧 `sizeRow` 的同一个值 —— 两处不再可能漂移。
 * （P3 之前池按说明格包围盒推高度，只在"最高一行有说明"时与装配侧相等；
 * 那正是"保存到文件 → 打开场景"里注解整体搬行的成因，已修。）
 */
export function cellTooltipTextAt(
  tips: LegacyCellTooltips,
  cell: { readonly x: number; readonly y: number; readonly z: number },
): string {
  const slice = tips.grid[cell.z]
  if (slice === undefined) return ''
  const height = slice.length
  if (height === 0) return ''
  const row = height - 1 - cell.y
  if (row < 0) return ''
  const idx = slice[row]?.[cell.x]
  if (idx === undefined || idx < 0) return ''
  return tips.palette[idx] ?? ''
}

export function projectCellTooltipsToLegacy(doc: Document): LegacyCellTooltips | null {
  // 遍历序 = `scene.order`（与投影侧 `objectsInOrder(scene)` 同序：两者都是
  // `Scene.order` 的机械展开）。**不**按对象 id 排序 —— id 里有 `frame-<i>`
  // 但那是装配的命名约定（投影层明文不得依赖它）。
  for (const objectId of doc.scene.order) {
    const obj = findObject(doc.scene, objectId)
    if (obj === undefined || obj.type !== 'block') continue
    const data = findObjectData(doc.scene, obj.dataId)
    if (data === undefined || data.payload.kind !== 'blockGrid') continue
    // 声明尺寸**同传**：侧表的形状必须与保存投影（`kernelProjection#tooltipPoolOfPayloads`）
    // 和装配侧（`kernelAssembly#tooltipContentOf` 的 `sizeRow` 反解）**同形**。
    // 漏传会让"最高一行没有说明"的文档得到一个更矮的网格 ⇒ 行号整体错位（M1 P3 实测）。
    const pool: TooltipPool | null = tooltipPoolOf(data.payload.cellContent, {
      width: data.payload.sizeColumn,
      height: data.payload.sizeRow,
      depth: data.payload.sizeZSlice,
    })
    if (pool !== null) return { palette: pool.palette, grid: pool.grid }
  }
  return null
}
