import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout } from '../types/layout'
import type { BlockRef } from '@/workbench/selectionContext'
import TooltipEditorPanel from './TooltipEditorPanel.vue'

function selectedBlock(ctx: BContext): BlockRef | null {
  const items = [...ctx.selection.items.value].filter(e => e.kind === 'block')
  if (items.length !== 1) return null
  return items[0]!.ref
}

export const tooltipEditorPanel: PanelDeclaration = {
  id: 'tooltip-editor',
  label: 'Tooltip 编辑',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,
  workspaces: ['preview'],

  poll(ctx: BContext): boolean {
    return selectedBlock(ctx) !== null
  },

  component: TooltipEditorPanel,

  layout(_ctx: BContext): UILayout {
    return { kind: 'column', align: false, items: [] }
  },
}
