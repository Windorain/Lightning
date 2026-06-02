import type { OperatorType } from '@/workbench/operators/operatorType'
import { replaceDoc } from '@/workbench/context/replaceDoc'

export const TooltipEditOperator: OperatorType = {
  id: 'OPERATOR_TOOLTIP_EDIT',
  label: '编辑工具提示',
  description: '修改方块工具提示文本',
  flagUndo: true,

  poll(bctx) {
    return bctx.doc.value !== null
  },

  exec(bctx, props) {
    const doc = bctx.doc.value
    if (!doc) return

    const text = props.text as string
    const pos = props.pos as { x: number; y: number; z: number }

    const newDoc = doc.clone()
    const tooltipPalette = (newDoc.tooltipPalette as string[]) ?? []
    const cellTooltipGrid = (newDoc.cellTooltipGrid as number[][][]) ?? []

    let idx = text ? tooltipPalette.indexOf(text) : -1
    if (idx === -1 && text) {
      idx = tooltipPalette.length
      tooltipPalette.push(text)
    }

    if (!cellTooltipGrid[pos.z]) cellTooltipGrid[pos.z] = []
    if (!cellTooltipGrid[pos.z][pos.y]) cellTooltipGrid[pos.z][pos.y] = []
    cellTooltipGrid[pos.z][pos.y][pos.x] = text ? idx : -1

    replaceDoc(bctx, newDoc)
  },
}
