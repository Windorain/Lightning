import type { Ref, ShallowRef } from 'vue'
import type * as THREE from 'three'
import type { ExportFileInfo } from '@/workbench/sdeApi'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import type { StructureDefinition } from '@/render/schema/types'
import type { MoveGizmo } from '@/workbench/tools/gizmos'
import type { CameraMainKey } from '@/runtime/mainCameras'
import type { SelectionOutlinePass } from '@/render/postprocessing/SelectionOutlinePass'

export type LoadStatus = 'loading' | 'ok' | 'error'
export type WorkbenchWorkspaceMode = 'sde' | 'local-file' | 'local-bundle' | 'wiki-data'
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

export type { ToolSettings } from '@/runtime/contextAccess'

export interface ViewportSlot {
  readonly id: string
  camera: Ref<THREE.Camera | null>
  contentGroup: ShallowRef<THREE.Group | null>
  domElement: Ref<HTMLElement | null>
  definition: ShallowRef<StructureDefinition | null>
  layerPreview: Ref<LayerPreviewMode | null>
  gizmo: ShallowRef<MoveGizmo | null>
  overlayGroup: Ref<THREE.Group | null>
  /** DRW overlay pass 内工具预览 / gizmo 子树 */
  toolsOverlayGroup: ShallowRef<THREE.Group | null>
  /** DRW 主场景深度注解（box overlay=false） */
  worldAnnotationGroup: ShallowRef<THREE.Group | null>
  wireframe: ShallowRef<THREE.LineSegments | null>
  orbitTarget: Ref<THREE.Vector3 | null>
  /** 绑定的 Main.cameras 键 */
  cameraMainKey: CameraMainKey
  /**
   * 该视口的描边 mask pass（`useViewportRuntime` 装配后写入）。
   * B-1：描边粒度是 mask 几何的直接函数，暴露它是**公开观测点**（e2e 读
   * `maskScene` 断言「同格不同部件 ⇒ mask 不同」），也是排障入口。
   */
  outlinePass: SelectionOutlinePass | null
  /**
   * 该视口的**呈现会话**（`BatchedPresenter` 的生产接线）。
   *
   * ## 为什么暴露在 `ViewportSlot` 上
   *
   * 两个理由，都不是"为了测试方便"：
   *
   *  1. **它是视口级资源**（每视口一套 GPU 批次 + 独立设备作用域），
   *     与 `outlinePass` 同一归属 —— 放别处会让"一个视口有哪些 GPU 资源"
   *     散在两个地方（释放时漏一处 = 资源泄漏）；
   *  2. **它是公开观测点**：e2e 需要断言"内核链真的画到了屏幕"
   *     （逐像素证据），而那要求能从页面里读到这个会话。
   *
   * `null` = 该视口尚未装配运行时（组件挂载早于装配）；与 `outlinePass` 同口径。
   */
  presenterSurface: import('@/composition/presenterSession').PresenterSession | null
}

