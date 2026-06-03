export enum SpaceType {
  VIEW_3D      = 'VIEW_3D',
  PROPERTIES   = 'PROPERTIES',
  OUTLINER     = 'OUTLINER',
  INFO         = 'INFO',
  PREFERENCES  = 'PREFERENCES',
}

export enum RegionType {
  MAIN         = 'MAIN',
  HEADER       = 'HEADER',
  TOOLSHELF    = 'TOOLSHELF',
  PROPERTIES   = 'PROPERTIES',
  FOOTER       = 'FOOTER',
}

import type { Rect } from '@/shared/types'
export type { Rect }

export interface ScrArea {
  id: string
  spaceType: SpaceType
  regions: ARegion[]
  splitDir: 'none' | 'h' | 'v'
  parentArea: string | null
}

export interface ARegion {
  id: string
  type: RegionType
  bounds: Rect
  panels: import('./panel').PanelDeclaration[]
  visible: boolean
  collapsed: boolean
  handlers: EventHandler[]
  /** 该 region 使用的 keymap 标识（用于 region 特定 keymap 加载） */
  keymapId?: string
}

/** @deprecated 布局真源为 `runtime/screenRoot` 的 `ScreenRoot` */
export interface bScreen {
  id: string
  areas: ScrArea[]
  popupRegions: ARegion[]
  bounds: { width: number; height: number }
}

export interface EventHandler {
  type: 'GIZMO' | 'KEYMAP'
  handle(event: Event): { break: boolean }
}
