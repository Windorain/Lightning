import type { Context } from '@/runtime/context'
import { REGION } from '@/runtime/regionIds'
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
  owner(ctx: Context): unknown { return ctx.requireRegion(REGION.WORKBENCH_TOOLSHELF).state.tool },

  layout(_ctx: Context) {
    return { kind: 'column', align: false, items: [] }
  },

  component: ToolShelf,
}
