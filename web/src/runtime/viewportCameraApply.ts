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
  // `ensureCamera`：键空间按 region 开放（#282），新视口的键可能尚未创建。
  const camRef = ctx.main.ensureCamera(key)
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
        ctx.viewports.markInitialCameraFitted(vp.id)
        return
      }
    } else if (result.reason === 'group has no geometry bounds') {
      /**
       * **内容尚未落地**（M8-7 / P4 回归修复）：
       *
       * 视口在"首帧呈现 apply"之前就会被挂载（M8-5 起 `loadStatus='ok'` 不再等纹理解码），
       * 此时内容组存在但**没有任何几何**，`fitCameraToGroup` 返回
       * `{ok:false, reason:'group has no geometry bounds'}`。
       *
       * 旧实现此时直接落"定义缺省兜底"（zoom 1 / target=定义 focus）—— 那不是一个错误值，
       * 而是一个**永远不该被用户看到**的初始视角：机器被画小约 2.3 倍，且之后按 M7 的
       * "内容投影不得重置用户机位"纪律**不会**再 fit。
       *
       * ⇒ 登记"待做"，由**首个成功的呈现 apply** 补做一次（`useViewportRuntime`），
       * 判据是"相机仍等于登记时那一份"（= 用户没动过）。用户先动过 ⇒ 放弃补偿（`'user'`）。
       * 真的**始终没有几何**（空文档）时不会补做 —— 那属于"定义里没有内容"，
       * 由下面的 fallback 分支承担。
       */
      ctx.viewports.markInitialFitPending(vp.id, ctx.getDocumentRevision().value, camRef.value)
      return
    }
  }

  // 3. Fallback — 安全默认值（真的没有可框选的内容时才落到这里）
  camRef.value = resolveInitialViewportCamera({ definition: def })
  ctx.viewports.markInitialCameraFallback(vp.id)
}
