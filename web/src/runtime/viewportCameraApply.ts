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
 *
 * ## 退役改造（#249 §15 第 1 条「原始权威对象」的渲染消费侧，P5）
 *
 * **被删除**：`applyViewportCameraFromMainInitial` 兼容别名（`export const` 转发）。
 * 它的名字里带 `Main`，是"以 `Main` 为权威"时代的遗留导出，且已无生产调用者
 * （`git grep applyViewportCameraFromMainInitial` 只剩它自己的定义）。
 * 保留它等于在渲染链上留一个指向旧权威名字的兼容门面 —— §15 明令禁止。
 *
 * **接缝声明**：本函数仍读 `ctx.main.cameras[key]` / `ctx.main.embedInitialView`
 * （上述 `ctx.main.*` 读面归口 **P1 的 `EditorClient`**，由 Lead 委托的第 2 条要求）。
 * P1 的 `ReadView` 目前**没有**相机/embed 初始视图查询（只有 objects/properties/
 * workspace/interaction 四组），故此处无法改经读面而不伪造一个不存在的查询；
 * 若强改，就变成"新 facade 内调用旧 runtime"（#1 自身负对照要判红的形态）。
 * 归口批次与退出阶段见 #256 汇报；不由本批半成品替换。
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
