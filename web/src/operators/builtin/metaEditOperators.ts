import type { OperatorType } from '@/operators/operatorType'

export const TooltipEditOperator: OperatorType = {
  id: 'OPERATOR_TOOLTIP_EDIT',
  label: '编辑工具提示',
  description: '修改方块工具提示文本',
  flagUndo: true,

  poll(ctx) {
    return ctx.getDoc().value !== null
  },

  exec(ctx, props) {
    const doc = ctx.getDoc().value
    if (!doc) return

    const text = props.text as string
    const pos = props.pos as { x: number; y: number; z: number }

    const newDoc = doc.clone()
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

    ctx.main.replaceDoc(newDoc)
  },
}
