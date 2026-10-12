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
  // #301 P10f D3（R1）：存在性走 GF-15 读面。
  if (!ctx.hasLoadedDocument()) return false
  // ⚠️ 本处要的是**本体**（下面 `setDocumentEmbedInitialView` 原地写 `doc.meta`）——
  // 换克隆会让写入静默丢失，换 `setDocument(clone)` 会顺带 bump `documentRevision`
  // ⇒ 相机自动初始化被重置（行为变更）。故走唯一保留的旧数据模型取值口
  // （登记 `legacy-document-in-place-edit`）。
  const doc = ctx.legacyDocumentModel()
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
