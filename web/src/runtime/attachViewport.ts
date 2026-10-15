import type { Ref, ShallowRef } from 'vue'
import * as THREE from 'three'
import type { StructureDefinition } from '@/render/schema/types'
import type { Context } from '@/runtime/context'
import type { DRW } from '@/runtime/drw'
import type { RenderEngineReadyPayload } from '@/runtime/renderEngine'
import type { ViewportBinderHandlers } from '@/runtime/viewportBinder'
import { bindViewportDom } from '@/runtime/viewportBinder'
import type { BlockRef, SelectedEntity } from '@/context/selection'

export interface SelectionOutlineBind {
  selectionItems: Ref<Set<SelectedEntity>>
  hoveredBlock: Ref<BlockRef | null>
  highlightOnHover: Ref<boolean>
  getBlockGeometry: (pos: { x: number; y: number; z: number }) => import('@/render/schema/types').BakedQuad[] | null
  gridCenterWorld: (pos: { x: number; y: number; z: number }) => { x: number; y: number; z: number } | null
  /** B-1 部件级 mask 通道（缺省 ⇒ 整格几何，既有行为） */
  getPartMaskGeometry?: import('@/render/mesh/selectionHighlightProvider').MaskGeometrySource
  /**
   * **R1-A C9：描边规划端口**（由调用方/装配边注入）。
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
   * ⚠️ R1-β① C8 起它由 `useViewportRuntime` 指向**呈现会话的根对象**
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

  // R1-β① C8：`drw.rebuildContentMesh()` 的调用已删除 —— 本函数不再产出几何
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
    touchScreenGestures: ctx.isEmbed(),
  })

  if (selectionOutline) {
    drw.bindSelectionOutline(selectionOutline)
  }

  /**
   * **初始机位（自动框选）只施加一次** —— M1 缺陷修复（用户实测："第一次编辑
   * 导致视口复位"；根因与运行期证据见 `runtime/viewportCameraInit.ts` 文件头）。
   *
   * ## 改动前后的差别（这就是本行）
   *
   * | | 触发面 | 后果 |
   * |---|---|---|
   * | 改动前 | **每一次**本函数被调用（= `@ready`，宿主重挂即触发） | 内容投影让 `materialLibrary` 瞬时为空 ⇒ 宿主重挂 ⇒ **重新 fit，用户机位被丢弃** |
   * | 改动后 | ①该视口还没有相机状态，或 ②**换了一份文档**（窄信号 `documentRevision`） | 内容投影只更新画面，**不动**用户机位 |
   *
   * 判据是纯函数 + 按 region 的台账（`ctx.viewports.claimInitialViewportCamera`），
   * 台账随槽位拆解清除 ⇒ "关掉再打开 Area"仍会重新框选。
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

  return () => {
    unbindDom()
    drw.unbindOverlayPass()
    // P6 实测：**不**在此归零槽位 —— 本 unbind 会被"重挂前的 detach"调用。
    // 详见 `docs`/提交说明；归零在组件卸载点由调用方做（`WorkbenchViewport`）。
  }
}
