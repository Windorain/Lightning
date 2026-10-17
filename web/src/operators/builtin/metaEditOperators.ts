import type { OperatorType } from '@/operators/operatorType'
import { KERNEL_CONTEXT_ID } from '@/runtime/kernelSession'
import { settlementOf } from '@/domain/editSettlement'
import { fallbackToLegacyOn } from '@/runtime/rejectionNotice'

export const TooltipEditOperator: OperatorType = {
  id: 'OPERATOR_TOOLTIP_EDIT',
  label: '编辑工具提示',
  description: '修改方块工具提示文本',
  flagUndo: true,

  poll(ctx) {
    return ctx.hasLoadedDocument()
  },

  exec(ctx, props) {
    // #301 P10f D3（R1）：存在性走 GF-15 读面。
    if (!ctx.hasLoadedDocument()) return

    const text = props.text as string
    const pos = props.pos as { x: number; y: number; z: number }

    // #301 P10f D0：**内核写优先**（本文件原先直接改 legacy 侧表）。
    //
    // `submitContentEdit` 一步完成"① 内核命令 + ② 投影回写"；
    // 成功 ⇒ legacy 侧表已被回写成最新，**不得**再走下面的 legacy 路径
    // （再写一次会以旧侧表覆盖回写产物）。
    //
    // ⚠️ 命令是**文档级**的（无 `objectId`）：它对该文档**每个**含此格的
    // `blockGrid` 对象原子写入 —— 理由见 `SetCellTooltipCommand` 的说明
    // （投影只取第一份池，只写一帧会让其余帧的说明静默丢失）。
    //
    // `text` 的映射：旧路径写 `-1` 哨兵表示"无说明"，且 `''` 与"无"同处理；
    // 内核 `null` = 删除、`''` = 显式空。⇒ 空串按"删除"传 `null`，
    // 保持与旧行为**逐字节一致**（旧路径对空串写的就是 `-1`）。
    // ⚠️ **`pos.y` 是「行号」，不是世界 Y**（本批实测抓出的自身错误，务必保留本说明）。
    //
    // 调用方（`TooltipEditorPanel.vue:58`）传的是
    // `row = h - 1 - item.pos.y`（**自上而下**的行序），而装配侧要紧回来
    // （`kernelPaletteAssembly.ts:260` 的 `y = sizeRow - 1 - row`）。
    // 本算子原先直接把 `pos.y` 当**下标**写进 `cellTooltipGrid[z][y][x]`，
    // 即它一直吃的是"行号"。我第一版把 `pos.y` 当**世界 Y** 传给内核命令
    // ⇒ 会写到**镜像的那一行**（`#80` 回归锁当场判红，见 `tooltipEditWrite.test.ts`）。
    //
    // ⇒ 必须在本算子内把**行号**翻回世界 Y，且高度用**当前帧**的高度
    // （各帧网格可以不同尺寸；面板侧 `h` 取的也是当前帧）。
    const frameHeight = ctx.kernelGrid(0)?.height ?? 0
    const worldY = frameHeight > 0 ? frameHeight - 1 - pos.y : pos.y

    // M4-3 R3：取**结算**（三分派）而不是布尔 —— 布尔把"被拒"与"未装配"压成同一个 false，
    // 于是"这一格被内核拒绝"会静默回落 legacy 写，把拒绝抹成成功。
    const settled = settlementOf(
      ctx.submitContentEditSettlement({
        kind: 'setCellTooltip',
        contextId: KERNEL_CONTEXT_ID,
        cells: [{ x: pos.x, y: worldY, z: pos.z }],
        text: text === '' ? null : text,
      }),
    )
    // 被拒 ⇒ 底栏成句原因**且不回落**；未装配 ⇒ 既有 legacy 回落。
    if (!fallbackToLegacyOn(ctx, settled, 'metaEdit')) return

    // 回落：未装配（GF-16 = false）/ 无会话 ⇒ legacy 是权威（能力不回退）。
    const newDoc = ctx.frozenDocumentValue()
    if (!newDoc) return
    // #80 修复：`?? []` 曾经造出**孤儿数组**——文字 push 进局部数组后被丢弃，而网格下标
    // 却写进了文档（悬空下标）。修复 = 变更后的两个字段一律写回 newDoc：文档缺调色板时
    // 新建空调色板（契约 §逐格说明的成对 idioms 在写入侧对齐：tooltipPalette / cellTooltipGrid
    // 同生共死，serialize() 只在字段为真时落盘，旧文件不受影响）。
    const mutable = newDoc as unknown as {
      tooltipPalette?: string[]
      cellTooltipGrid?: number[][][]
    }
    const tooltipPalette = (mutable.tooltipPalette ??= [])
    const cellTooltipGrid = (mutable.cellTooltipGrid ??= [])

    let idx = text ? tooltipPalette.indexOf(text) : -1
    if (idx === -1 && text) {
      idx = tooltipPalette.length
      tooltipPalette.push(text)
    }

    if (!cellTooltipGrid[pos.z]) cellTooltipGrid[pos.z] = []
    if (!cellTooltipGrid[pos.z][pos.y]) cellTooltipGrid[pos.z][pos.y] = []
    cellTooltipGrid[pos.z][pos.y][pos.x] = text ? idx : -1

    ctx.setDocument(newDoc)
  },
}
