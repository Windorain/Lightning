import type { OperatorType } from '@/workbench/operators/operatorType'

export const SceneMetaEditOperator: OperatorType = {
  id: 'OPERATOR_SCENE_META_EDIT',
  label: '编辑场景信息',
  description: '修改场景元数据（名称、作者等）',
  flagUndo: true,

  poll(bctx) {
    return bctx.scene.scene.value !== null
  },

  exec(bctx, props) {
    const doc = bctx.scene.scene.value as Record<string, any> | null
    if (!doc) return
    const field = props.field as string
    const value = props.value as string | null
    if (!field) return
    if (value === null || value === '') {
      delete doc[field]
    } else {
      doc[field] = value
    }
    bctx.scene.markDirty()
  },
}

export const TooltipEditOperator: OperatorType = {
  id: 'OPERATOR_TOOLTIP_EDIT',
  label: '编辑工具提示',
  description: '修改方块工具提示文本',
  flagUndo: true,

  poll(bctx) {
    return bctx.scene.scene.value !== null
  },

  exec(bctx, props) {
    const doc = bctx.queries.getDocument()
    if (!doc) return

    const text = props.text as string
    const pos = props.pos as { x: number; y: number; z: number }

    if (!doc.tooltipPalette) doc.tooltipPalette = []
    if (!doc.cellTooltipGrid) doc.cellTooltipGrid = []

    const palette: string[] = doc.tooltipPalette
    let idx = text ? palette.indexOf(text) : -1
    if (idx === -1 && text) {
      idx = palette.length
      palette.push(text)
    }

    const grid: number[][][] = doc.cellTooltipGrid
    if (grid) {
      if (!grid[pos.z]) grid[pos.z] = []
      if (!grid[pos.z][pos.y]) grid[pos.z][pos.y] = []
      grid[pos.z][pos.y][pos.x] = text ? idx : -1
    }

    bctx.scene.markDirty()
  },
}
