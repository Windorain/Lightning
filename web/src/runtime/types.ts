import type { Ref, ShallowRef } from 'vue'
import type * as THREE from 'three'
import type { ExportFileInfo } from '@/workbench/sdeApi'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import type { StructureDefinition } from '@/render/schema/types'
import type { MoveGizmo } from '@/workbench/tools/gizmos'

export type LoadStatus = 'loading' | 'ok' | 'error'
export type WorkbenchWorkspaceMode = 'sde' | 'local-file' | 'local-bundle'
export type UIWorkspace = 'preview' | 'wiki' | 'export' | 'materials'

export interface MaterialQueryItem {
  materialId: string
  kind: 'static16' | 'animated'
  blend?: 'opaque' | 'cutout' | 'translucent'
  locator?: string
  emissive?: number
  animation?: {
    defaultFrametimeTicks?: number
    frameSequence?: Array<{ index: number; timeTicks?: number }>
    interpolate?: boolean
  }
  textureDataUrl: string | null
  atlas?: string | null
  linear?: boolean
  useMipmaps?: boolean
}

export interface BlockTypeStat {
  count: number
}

export interface ConnectionState {
  apiBase: string
  token: string
  connected: boolean | null
  exports: ExportFileInfo[]
  exportsLoading: boolean
  selectedExportName: string | null
}

export interface ContextSettings {
  replaceBrush: string | null
  fillBrush: string | null
  generateType: string | null
  dragSensitivity: number
  snapEnabled: boolean
  confirmDirty?: (message: string) => boolean
  theme?: 'dark' | 'light'
  language?: 'zh' | 'en'
}

export interface ViewportSlot {
  readonly id: string
  camera: Ref<THREE.Camera | null>
  contentGroup: ShallowRef<THREE.Group | null>
  domElement: Ref<HTMLElement | null>
  definition: ShallowRef<StructureDefinition | null>
  layerPreview: Ref<LayerPreviewMode | null>
  gizmo: ShallowRef<MoveGizmo | null>
  overlayGroup: Ref<THREE.Group | null>
  wireframe: ShallowRef<THREE.LineSegments | null>
  orbitTarget: Ref<THREE.Vector3 | null>
}

export interface RenderViewState {
  loadStatus: LoadStatus
  hasWorldMultiFrame: boolean
  worldFrameCount: number
}
