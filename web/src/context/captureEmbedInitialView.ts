import * as THREE from 'three'
import type { Context } from '@/runtime/context'
import { resolveEmbedViewportRegionId } from '@/runtime/embedViewportRegion'
import { CAMERA_KEY } from '@/runtime/mainCameras'
import { captureViewportCamera } from '@/runtime/viewportCamera'
import { cloneViewportCameraState } from '@/context/embedInitialView'

/**
 * 从 Wiki 预览视口抓取全量视角，落到**宿主初始视图状态**（含文档 `meta` 载体）。
 *
 * ## R1-β① C3：本函数**不再**经 `Context#legacyDocumentModel()` 取旧文档本体
 *
 * 依据**裁决④**（#385 评论 6988）+ GF-8 / GF-21：#385 评论 7025 实测本函数
 * 是"旧数据模型本体"取值口的**恰两处**消费者之一，而它要写的是**观察视角**
 * （`meta.embed_initial_view`）——那是「3D 编辑器实例/宿主初始视图状态」，
 * **不**是"写模型仍是旧文档"这件事。裁决④据此要求给它**具名宿主装配面**。
 *
 * ## 落点与语义
 *
 * 落点收口到 `Context#setHostEmbedInitialView`（**原地**写 `doc.meta` + 镜像
 * `Main.embedInitialView`，**不**推进 `documentRevision`）——语义与迁移前**逐点相同**；
 * 本函数只负责"从视口抓取"这一半（区域解析 + 相机/轨道目标取值 + 复制成冻结值）。
 *
 * `Main.cameras[CAMERA_KEY.embed]` 的同步留在这里：它是**活视口机位槽**的动作，
 * 不是"宿主初始视图状态"本身（后者由上面那个装配面表达）。
 *
 * @returns `true` = 已抓到视角并落到宿主初始视图状态；`false` = 无文档/无预览视口
 */
export function capturePreviewToDocument(ctx: Context): boolean {
  // #301 P10f D3（R1）：存在性走 GF-15 读面。
  if (!ctx.hasLoadedDocument()) return false

  const regionId = resolveEmbedViewportRegionId(ctx)
  const slot = ctx.viewports.get(regionId)
  const camera = slot?.camera.value as THREE.Camera | null
  const orbitTarget = slot?.orbitTarget.value as THREE.Vector3 | null
  if (!camera || !orbitTarget) return false

  const captured = captureViewportCamera(camera, orbitTarget)
  if (!captured) return false

  const state = cloneViewportCameraState(captured)
  // ⚠️ 文档缺席时**如实失败**（`false`）——原实现在此之前用旧数据模型取值口的
  // `null` 表达同一事实；现在该事实由宿主装配面自己回答（`main.doc` 为空 ⇒ `false`）。
  if (!ctx.setHostEmbedInitialView(state)) return false
  ctx.main.cameras[CAMERA_KEY.embed].value = state
  return true
}
