import * as THREE from 'three'
import type { Context } from '@/runtime/context'
import { resolveEmbedViewportRegionId } from '@/runtime/embedViewportRegion'
import { CAMERA_KEY } from '@/runtime/mainCameras'
import { captureViewportCamera } from '@/runtime/viewportCamera'
import {
  cloneViewportCameraState,
  setDocumentEmbedInitialView,
} from '@/context/embedInitialView'

/** 从 Wiki 预览视口抓取全量视角，写入 doc.meta 与 Main.embedInitialView */
export function capturePreviewToDocument(ctx: Context): boolean {
  const doc = ctx.getDoc().value
  if (!doc) return false

  const regionId = resolveEmbedViewportRegionId(ctx)
  const slot = ctx.viewports.get(regionId)
  const camera = slot?.camera.value as THREE.Camera | null
  const orbitTarget = slot?.orbitTarget.value as THREE.Vector3 | null
  if (!camera || !orbitTarget) return false

  const captured = captureViewportCamera(camera, orbitTarget)
  if (!captured) return false

  const state = cloneViewportCameraState(captured)
  setDocumentEmbedInitialView(doc, state)
  ctx.main.embedInitialView.value = state
  ctx.main.cameras[CAMERA_KEY.embed].value = state
  return true
}
