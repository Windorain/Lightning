import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import ToolShelf from '../ToolShelf.vue'

export const toolShelfPanel: PanelDeclaration = {
  id: 'tool-shelf',
  label: '工具',
  spaceType: SpaceType.VIEW_3D,
  regionType: RegionType.TOOLSHELF,
  workspaces: ['preview'],

  poll(): boolean { return true },
  owner(ctx: BContext): unknown { return ctx.settings },

  layout(_ctx: BContext) {
    return { kind: 'column', align: false, items: [] }
  },

  component: ToolShelf,
}
