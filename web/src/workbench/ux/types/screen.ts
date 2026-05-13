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

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

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
}

export interface bScreen {
  id: string
  areas: ScrArea[]
  popupRegions: ARegion[]
  bounds: { width: number; height: number }
}

export interface wmWindow {
  id: string
  screen: bScreen
  activeArea: string | null
  activeRegion: string | null
}

export interface EventHandler {
  type: 'GIZMO' | 'OPERATOR' | 'KEYMAP' | 'UI'
  handle(event: Event): { break: boolean }
}
