import * as THREE from 'three'
import type { Context } from '@/runtime/context'
import { resolveViewportSlot } from '@/runtime/context'
import { cloneViewportCameraState } from '@/context/embedInitialView'
import { fitCameraToGroup, type FitCameraResult } from '@/render/interaction/initialCamera'
import type { CameraMainKey } from '@/runtime/mainCameras'
import {
  captureViewportCamera,
  resolveInitialViewportCamera,
} from '@/runtime/viewportCamera'

/**
 * INIT / RESET：有 embed_initial_view 快照则整包恢复；
 * 有 mesh 时精确 fit；否则 fallback 到安全默认值。
 */
export function applyViewportCameraFromDocumentInitial(
  ctx: Context,
  props?: Record<string, unknown>,
): void {
  const vp = resolveViewportSlot(ctx, props)
  const key: CameraMainKey = vp.cameraMainKey
  const def = vp.definition.value
  const camRef = ctx.main.cameras[key]
  const snapshot = ctx.main.embedInitialView.value

  // 1. Snapshot — embed_initial_view 优先
  if (snapshot) {
    camRef.value = cloneViewportCameraState(snapshot)
    return
  }

  // 2. Fit — 有 mesh 时精确适配包围盒
  const group = vp.contentGroup.value
  const camera = vp.camera.value
  const orbit = vp.orbitTarget.value
  const dom = vp.domElement.value
  const canFit = group && camera && orbit && dom && group.children.length > 0

  if (canFit) {
    const preset = resolveInitialViewportCamera({ definition: def })
    const result: FitCameraResult = fitCameraToGroup(
      camera as THREE.OrthographicCamera,
      group,
      orbit,
      dom,
      {
        yawDeg: preset.yawDeg,
        elevationDeg: preset.elevationDeg,
        minDistance: preset.distance,
        zoom: preset.zoom,
      },
    )
    if (result.ok) {
      const captured = captureViewportCamera(camera, orbit)
      if (captured) {
        camRef.value = captured
        return
      }
    }
  }

  // 3. Fallback — 安全默认值
  camRef.value = resolveInitialViewportCamera({ definition: def })
}

/** @deprecated 使用 applyViewportCameraFromDocumentInitial */
export const applyViewportCameraFromMainInitial = applyViewportCameraFromDocumentInitial
