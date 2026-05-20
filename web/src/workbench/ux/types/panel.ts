import type { BContext } from '@/workbench/context/bContext'
import type { UILayout } from './layout'
import type { SpaceType, RegionType } from './screen'
import type { Component } from 'vue'

export interface PanelDeclaration {
  id: string
  label: string
  icon?: string
  spaceType: SpaceType
  regionType: RegionType
  poll(ctx: BContext): boolean
  layout(ctx: BContext): UILayout
  /** The owner object passed to RNAWidget for property get/set. null = no owner. */
  owner?(ctx: BContext): unknown
  /** Optional custom Vue component. When set, takes precedence over layout() for rendering. */
  component?: Component
}
