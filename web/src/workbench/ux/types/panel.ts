import type { BContext } from '@/workbench/context/bContext'
import type { UILayout } from './layout'
import type { SpaceType, RegionType } from './screen'

export interface PanelDeclaration {
  id: string
  label: string
  icon?: string
  spaceType: SpaceType
  regionType: RegionType
  poll(ctx: BContext): boolean
  layout(ctx: BContext): UILayout
}
