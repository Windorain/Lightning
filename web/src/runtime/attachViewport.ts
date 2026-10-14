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

  await ctx.getOperators().exec('OPERATOR_INIT_VIEWPORT_CAMERA', { _regionId: regionId })

  return () => {
    unbindDom()
    drw.unbindOverlayPass()
    // P6 实测：**不**在此归零槽位 —— 本 unbind 会被"重挂前的 detach"调用。
    // 详见 `docs`/提交说明；归零在组件卸载点由调用方做（`WorkbenchViewport`）。
  }
}
