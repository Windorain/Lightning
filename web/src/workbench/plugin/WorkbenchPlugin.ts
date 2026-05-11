// web/src/workbench/plugin/WorkbenchPlugin.ts

import type { Component } from 'vue'
import type { Tool } from '@/workbench/toolRegistry'
import type { SceneStorageProvider } from './FileSystemProvider'

export interface WorkbenchPlugin {
  id: string
  label: string
  storageProvider?: SceneStorageProvider
  rightPanelTabs?: Array<{
    id: string
    label: string
    component: Component
    priority?: number
  }>
  menuItems?: Array<{
    section: 'file' | 'edit' | 'view'
    label: string
    action: () => void | Promise<void>
  }>
  provideContexts?: () => Record<string, unknown>
  tools?: Tool[]
  layoutVariants?: Record<string, Component>
}
