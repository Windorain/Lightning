import type { Context } from '@/runtime/context'
import type { UIWorkspace } from '@/runtime/types'
import type { UILayout } from './layout'
import type { SpaceType, RegionType } from './screen'
import type { Component } from 'vue'

export interface PanelDeclaration {
  id: string
  label: string
  icon?: string
  spaceType: SpaceType
  regionType: RegionType
  /** The workspace(s) where this panel should appear. Undefined = all workspaces. */
  workspaces?: UIWorkspace[]
  poll(ctx: Context): boolean
  layout(ctx: Context): UILayout
  /** The owner object passed to RNAWidget for property get/set. null = no owner. */
  owner?(ctx: Context): unknown
  /** Optional custom Vue component. When set, takes precedence over layout() for rendering. */
  component?: Component
}
