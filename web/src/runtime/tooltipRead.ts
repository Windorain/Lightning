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
export function projectCellTooltipsToLegacy(doc: Document): LegacyCellTooltips | null {
  // 遍历序 = `scene.order`（与投影侧 `objectsInOrder(scene)` 同序：两者都是
  // `Scene.order` 的机械展开）。**不**按对象 id 排序 —— id 里有 `frame-<i>`
  // 但那是装配的命名约定（投影层明文不得依赖它）。
  for (const objectId of doc.scene.order) {
    const obj = findObject(doc.scene, objectId)
    if (obj === undefined || obj.type !== 'block') continue
    const data = findObjectData(doc.scene, obj.dataId)
    if (data === undefined || data.payload.kind !== 'blockGrid') continue
    const pool: TooltipPool | null = tooltipPoolOf(data.payload.cellContent)
    if (pool !== null) return { palette: pool.palette, grid: pool.grid }
  }
  return null
}
