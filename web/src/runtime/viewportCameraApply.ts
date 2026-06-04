import * as THREE from 'three'
import type { Context } from '@/runtime/context'
import { resolveViewportSlot } from '@/runtime/context'
import { cloneViewportCameraState } from '@/context/embedInitialView'
import { fitCameraToGroup } from '@/render/interaction/initialCamera'
import type { CameraMainKey } from '@/runtime/mainCameras'
import {
  captureViewportCamera,
  resolveInitialViewportCamera,
} from '@/runtime/viewportCamera'

/** INIT / RESET：有文档嵌入初始快照则整包恢复；否则 fit 结构 + 默认等轴 */
export function applyViewportCameraFromDocumentInitial(
  ctx: Context,
  props?: Record<string, unknown>,
): void {
  const vp = resolveViewportSlot(ctx, props)
  const key: CameraMainKey = vp.cameraMainKey
  const def = vp.definition.value
  const camRef = ctx.main.cameras[key]
  const snapshot = ctx.main.embedInitialView.value

  if (snapshot) {
    camRef.value = cloneViewportCameraState(snapshot)
    return
  }

  const group = vp.contentGroup.value
  const camera = vp.camera.value
  const orbit = vp.orbitTarget.value
  const dom = vp.domElement.value
  if (!group || !camera || !orbit || !dom) {
    camRef.value = resolveInitialViewportCamera({ definition: def })
    return
  }

  const preset = resolveInitialViewportCamera({ definition: def })
  fitCameraToGroup(
    camera as THREE.OrthographicCamera,
    group,
    orbit,
    dom,
    {
      yawDeg: preset.yawDeg,
      elevationDeg: preset.elevationDeg,
      distance: preset.distance,
      zoom: preset.zoom,
    },
  )
  camRef.value = captureViewportCamera(camera, orbit) ?? preset
}

/** @deprecated 使用 applyViewportCameraFromDocumentInitial */
export const applyViewportCameraFromMainInitial = applyViewportCameraFromDocumentInitial
