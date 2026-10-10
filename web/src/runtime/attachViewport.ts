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
  extraMaskMeshes?: Ref<THREE.Mesh[]> | import('vue').ShallowRef<THREE.Mesh[]>
}

export interface AttachViewportInput {
  drw: DRW
  payload: RenderEngineReadyPayload
  handlers: ViewportBinderHandlers
  layerPreviewMode: import('@/render/data/layerPreview').LayerPreviewMode
  structureDefinition: ShallowRef<StructureDefinition | null>
  mainMeshGroup: ShallowRef<THREE.Group | null>
  selectionOutline?: SelectionOutlineBind
  documentKeydown?: boolean
  rebuildMesh?: boolean
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
    selectionOutline, documentKeydown, rebuildMesh = true,
  } = input
  const slot = ctx.viewports.get(regionId) ?? ctx.viewports.register(regionId)

  ctx.viewports.activeId.value = regionId

  drw.registerScene(payload.mainScene)
  drw.init()

  drw.outlinePass.setCamera(payload.camera as THREE.Camera)
  payload.renderer.setOutlinePass(drw.outlinePass)

  if (rebuildMesh) {
    try {
      await drw.rebuildContentMesh()
    } catch (e) {
      console.error(`[attachViewport] rebuildContentMesh ${regionId}`, e)
    }
  }

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
    /**
     * **归零槽位**（B5 #10「关闭 Area 释放运行资源」；P6 实测补）。
     *
     * 旧实现只做上面两件事，槽位字段（`camera`/`domElement`/`definition`/
     * `contentGroup`/`overlayGroup`/`layerPreview`/`orbitTarget`）全部留在原处。
     * 于是卸载之后：
     *  - 组件已经 `drw.dispose()`，但槽位仍指向**已 dispose 的** mesh group
     *    与相机 ⇒ 任何经 `__vm__` 观测面读槽位的消费者都会读到**陈旧成功**
     *    （e2e 的 `readContentMesh`/`waitForRenderedGrid`/
     *    `readDefinitionRootFields`/`readCameraDirectionForCell` 全属此类）；
     *  - 这正是 A13「关闭后实例/监听/作业回到预期基线」在**槽位层**的缺口：
     *    资源还了，但"这个视口还活着吗"的答案仍是"活着"。
     *
     * 归零后 `isSlotLive(slot) === false`，stale 读取变成可断言的否定面。
     * `unbindDom()` 内部已 `ed.unregisterRegion(regionId)`（见 `bindViewportDom`），
     * 故 scale 上的监听也一并回基线。
     */
    ctx.viewports.reset(regionId)
  }
}
