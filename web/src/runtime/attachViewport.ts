import type { Ref, ShallowRef } from 'vue'
import * as THREE from 'three'
import type { StructureDefinition } from '@/render/schema/types'
import type { Context } from '@/runtime/context'
import type { DRW } from '@/runtime/drw'
import type { RenderEngineReadyPayload } from '@/runtime/renderEngine'
import type { ViewportBinderHandlers } from '@/runtime/viewportBinder'
import { bindViewportDom } from '@/runtime/viewportBinder'
import type { BlockRef, SelectedEntity } from '@/context/selection'
import { applyViewportCameraState } from '@/runtime/viewportCamera'
import { CAPABILITY } from '@/composition/modules'

export interface SelectionOutlineBind {
  selectionItems: Ref<Set<SelectedEntity>>
  hoveredBlock: Ref<BlockRef | null>
  highlightOnHover: Ref<boolean>
  getBlockGeometry: (pos: { x: number; y: number; z: number }) => import('@/render/schema/types').BakedQuad[] | null
  gridCenterWorld: (pos: { x: number; y: number; z: number }) => { x: number; y: number; z: number } | null
  /** B-1 部件级 mask 通道（缺省 ⇒ 整格几何，既有行为） */
  getPartMaskGeometry?: import('@/render/mesh/selectionHighlightProvider').MaskGeometrySource
  /**
   * **描边规划端口**（由调用方/装配边注入）。
   *
   * 给定时，hover/点选描边的 mask 由 `presentation/outlinePlan` 的生产实现产出
   * （见 `runtime/drw#bindSelectionOutline`）。此处**不** import `composition/`：
   * 本文件属旧层，值依赖只能由装配边下行（注入纪律）。
   */
  outlinePlans?: import('@/runtime/drw').OutlinePlanPort
  extraMaskMeshes?: Ref<THREE.Mesh[]> | import('vue').ShallowRef<THREE.Mesh[]>
}

export interface AttachViewportInput {
  drw: DRW
  payload: RenderEngineReadyPayload
  handlers: ViewportBinderHandlers
  layerPreviewMode: import('@/render/data/layerPreview').LayerPreviewMode
  structureDefinition: ShallowRef<StructureDefinition | null>
  /**
   * **视口结构层**（画面挂载点）。
   *
   * ⚠️ 它由 `useViewportRuntime` 指向**呈现会话的根对象**
   * （内核呈现根），而不再是 `DRW` 的 legacy 网格组。本函数只把它写进槽位
   * （`slot.contentGroup`），不产出任何几何。
   */
  mainMeshGroup: ShallowRef<THREE.Group | null>
  selectionOutline?: SelectionOutlineBind
  documentKeydown?: boolean
}

/**
 * 视口就绪后统一装配：DRW 场景、outline、slot 同步、DOM→WM。
 */
export async function attachViewport(
  ctx: Context,
  regionId: string,
  input: AttachViewportInput,
): Promise<() => void> {
  const {
    drw, payload, handlers, layerPreviewMode, structureDefinition, mainMeshGroup,
    selectionOutline, documentKeydown,
  } = input
  const slot = ctx.viewports.get(regionId) ?? ctx.viewports.register(regionId)

  ctx.viewports.activeId.value = regionId

  drw.registerScene(payload.mainScene)
  drw.init()

  drw.outlinePass.setCamera(payload.camera as THREE.Camera)
  payload.renderer.setOutlinePass(drw.outlinePass)

  // `drw.rebuildContentMesh()` 的调用已删除 —— 本函数不再产出几何
  // （画面由呈现会话产出，见 `AttachViewportInput.mainMeshGroup` 的说明）。
  drw.bindOverlayPass(payload.layers.overlay)

  slot.orbitTarget.value = payload.orbitTarget
  slot.camera.value = payload.camera
  slot.domElement.value = payload.domElement
  slot.contentGroup.value = mainMeshGroup.value ?? new THREE.Group()
  slot.definition.value = structureDefinition.value ?? null
  slot.layerPreview.value = layerPreviewMode
  slot.overlayGroup.value = payload.layers.overlay

  const unbindDom = bindViewportDom(ctx, regionId, payload.domElement, handlers, {
    documentKeydown,
    // 本行原来把 `touchScreenGestures` 直接写成宿主身份判断（嵌入 ⇒ true）。
    // 它的事实是"本实例的指针面是
    // **屏上手势面**（手指/触控笔算屏幕指针，见 `embed/touchPointer`）"——现在由装配声明
    // （`EMBED_PROFILE` 的 `interaction.screenGestures`）回答，宿主名不再进入共享装配边。
    touchScreenGestures: ctx.hasCapability(CAPABILITY.SCREEN_GESTURES),
  })

  if (selectionOutline) {
    drw.bindSelectionOutline(selectionOutline)
  }

  /**
   * **初始机位（自动框选）只施加一次** —— 用户实测缺陷的修复（"第一次编辑
   * 导致视口复位"；根因与运行期证据见 `runtime/viewportCameraInit.ts` 文件头）。
   *
   * ## 改动前后的差别（这就是本行）
   *
   * | | 触发面 | 后果 |
   * |---|---|---|
   * | 改动前 | **每一次**本函数被调用（= `@ready`，宿主重挂即触发） | 内容投影让 `materialLibrary` 瞬时为空 ⇒ 宿主重挂 ⇒ **重新 fit，用户机位被丢弃** |
   * | 改动后 | ①该视口还没有相机状态，或 ②**换了一份文档**（窄信号 `documentRevision`） | 内容投影只更新画面，**不动**用户机位 |
   *
   * 📌 **补充**：上表"宿主重挂"这一触发面**已按 SPEC §7.3/§7.4 删除** ——
   * 两个宿主模板的 `v-if` 不再包含 `materialLibrary`（资源瞬时态不再决定画布寿命），
   * 故内容投影连"重挂"都不会发生。本台账仍保留：它管的是"谁可以框选"（换文档 / 首次），
   * 与挂载次数解耦；回退保护见 `e2e/kernel-viewport-host-lifetime.spec.ts`。
   *
   * 判据是纯函数 + 按 region 的台账（`ctx.viewports.claimInitialViewportCamera`）。
   *
   * 📌 **台账不随槽位拆解清除**："关掉再打开 Area 仍会重新框选"
   * 这条旧行为被删除，因为它是"承载重建 ⇒ 重新 fit"的同一误判（工作区往返时
   * 呈现组件卸载会走到 `unregister`）。现行语义只有两条：该视口没有机位状态，
   * 或换了一份文档。判据见 `e2e/kernel-workspace-camera-roundtrip.spec.ts`。
   * 槽位拆解后重挂，由下面的"把现有逻辑机位施加到新相机"负责恢复取景。
   *
   * ⚠️ **不是**"把政策塞进组件回调"：本函数是装配边（`HostBase.attachViewport`
   * 的唯一实现体），纪律只此一处；两个宿主（工作台/嵌入）都不需要自己记状态。
   * `EmbedViewport.vue` 侧原有的 `didInitCamera` 纪律与其同源（同一窄信号）。
   */
  const cameraRef = ctx.main.ensureCamera(slot.cameraMainKey)
  const shouldInitCamera = ctx.viewports.claimInitialViewportCamera(
    regionId,
    ctx.getDocumentRevision().value,
    cameraRef.value !== null,
  )
  if (shouldInitCamera) {
    await ctx.getOperators().exec('OPERATOR_INIT_VIEWPORT_CAMERA', { _regionId: regionId })
  }

  /**
   * **画面相机必须与逻辑机位一致** —— 本行补的是"不重新框选"的必要一半。
   *
   * ## 为什么必须有它（端到端判据当场抓出的第二环）
   *
   * 宿主重挂（上面那段说明的同一事件）会走 `RenderEngine.mount` ⇒ **新建一个
   * THREE 相机**（`View3DRenderer` 的默认姿态）。而"逻辑机位 → 画面相机"的同步
   * 只有 `bindViewportCameraSync` 的 `watch(stateRef)` 一处 —— 它由**状态变化**
   * 驱动，不是由"装上了新相机"驱动。
   *
   * 于是只做"不重新 fit"会得到更坏的形态：逻辑机位（`main.cameras[key]`）保住了，
   * 但画面停在新建相机的默认姿态 ⇒ 用户看到的视角照样跳走，且与状态不一致。
   * 实测（`kernel-viewport-camera.spec.ts` 修复中途的运行读数）：
   * 编辑后 `logical` 逐字段等于挪动值，而 `engine` 的 `matrixWorld` 变成单位矩阵、
   * `zoom` 2.4 → 1（新相机默认）。
   *
   * ⇒ 装配点补一次"把**现有**逻辑机位施加到当前相机"（与 watch 调的是**同一个**
   * `applyViewportCameraState`，不是新算法）。语义上它是**同步**、不是**框选**：
   * 首次装载那条路仍由上面的 `OPERATOR_INIT_VIEWPORT_CAMERA`（自动框选）承担。
   */
  const cameraState = cameraRef.value
  const engineCamera = slot.camera.value
  const engineOrbit = slot.orbitTarget.value
  if (cameraState && engineCamera && engineOrbit) {
    applyViewportCameraState(engineCamera, engineOrbit, cameraState)
  }

  return () => {
    unbindDom()
    drw.unbindOverlayPass()
    // 实测：**不**在此归零槽位 —— 本 unbind 会被"重挂前的 detach"调用。
    // 详见 `docs`/提交说明；归零在组件卸载点由调用方做（`WorkbenchViewport`）。
  }
}