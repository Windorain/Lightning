import { ref, type Ref } from 'vue'
import type { View3DFeatures } from '@/viewer/viewerConfig'
import type { ViewportCameraState } from '@/runtime/viewportCamera'
import { REGION } from '@/runtime/regionIds'

/** Main 侧逻辑相机槽位 */
export const CAMERA_KEY = {
  embed: 'embed',
  workbench: 'workbench',
} as const

export type CameraMainKey = (typeof CAMERA_KEY)[keyof typeof CAMERA_KEY]

export interface EmbedPublishSettings {
  features: View3DFeatures
  viewWidth: number
  viewHeight: number
  sceneBackgroundHex: string
}

export function defaultEmbedPublish(): EmbedPublishSettings {
  return {
    features: {
      titleBar: true,
      blockStatsSidebar: true,
      frameControls: true,
      layerBar: true,
      debugStatusBar: true,
      showAxesGizmo: true,
    },
    viewWidth: 800,
    viewHeight: 600,
    sceneBackgroundHex: '#5a5a5a',
  }
}

export function cameraMainKeyForRegion(regionId: string): CameraMainKey {
  if (regionId === REGION.WORKBENCH_VIEWPORT) return CAMERA_KEY.workbench
  return CAMERA_KEY.embed
}

export function createMainCameraStore(): {
  cameras: Record<CameraMainKey, Ref<ViewportCameraState | null>>
  embedInitialView: Ref<ViewportCameraState | null>
  embedPublish: Ref<EmbedPublishSettings>
} {
  return {
    cameras: {
      embed: ref(null),
      workbench: ref(null),
    },
    embedInitialView: ref(null),
    embedPublish: ref(defaultEmbedPublish()),
  }
}
