import type { Context } from '@/runtime/context'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout } from '../types/layout'
import type { BlockRef } from '@/context/selection'
import TooltipEditorPanel from './TooltipEditorPanel.vue'

function selectedBlock(ctx: Context): BlockRef | null {
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

  poll(ctx: Context): boolean {
    return selectedBlock(ctx) !== null
  },

  component: TooltipEditorPanel,

  layout(_ctx: Context): UILayout {
    return { kind: 'column', align: false, items: [] }
  },
}
