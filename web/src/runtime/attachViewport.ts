import { watch, type Ref, type ShallowRef } from 'vue'
import * as THREE from 'three'
import type { StructureDefinition } from '@/render/schema/types'
import type { Context } from '@/runtime/context'
import type { DRW } from '@/runtime/drw'
import type { RenderEngineReadyPayload } from '@/runtime/renderEngine'
import type { ViewportBinderHandlers } from '@/runtime/viewportBinder'
import { bindViewportDom } from '@/runtime/viewportBinder'
import type { BlockRef, SelectedEntity } from '@/context/selection'
import { disposeAnnotationOverlay } from '@/runtime/viewportAnnotations'

export interface SelectionOutlineBind {
  selectionItems: Ref<Set<SelectedEntity>>
  hoveredBlock: Ref<BlockRef | null>
  highlightOnHover: Ref<boolean>
  getBlockGeometry: (pos: { x: number; y: number; z: number }) => import('@/render/schema/types').BakedQuad[] | null
  gridCenterWorld: (pos: { x: number; y: number; z: number }) => { x: number; y: number; z: number } | null
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
      await drw.renderAssets.rebuildContentMesh()
    } catch (e) {
      console.error(`[attachViewport] rebuildContentMesh ${regionId}`, e)
    }
  }

  slot.orbitTarget.value = payload.orbitTarget
  slot.camera.value = payload.camera
  slot.domElement.value = payload.domElement
  slot.contentGroup.value = mainMeshGroup.value ?? new THREE.Group()
  slot.definition.value = structureDefinition.value ?? null
  slot.layerPreview.value = layerPreviewMode
  slot.overlayGroup.value = payload.layers.overlay

  const unbindDom = bindViewportDom(ctx, regionId, payload.domElement, handlers, { documentKeydown })

  if (selectionOutline) {
    drw.bindSelectionOutline(selectionOutline)
  }

  const syncRenderView = (): void => {
    ctx.renderView[regionId] = {
      loadStatus: drw.loadStatus.value,
      hasWorldMultiFrame: drw.computed.hasWorldMultiFrame.value,
      worldFrameCount: drw.computed.worldFrameCount.value,
    }
  }
  syncRenderView()
  const stopRenderViewWatch = [
    watch(drw.loadStatus, syncRenderView),
    watch(drw.computed.hasWorldMultiFrame, syncRenderView),
    watch(drw.computed.worldFrameCount, syncRenderView),
  ]

  return () => {
    stopRenderViewWatch.forEach(s => s())
    delete ctx.renderView[regionId]
    unbindDom()
    disposeAnnotationOverlay(regionId)
  }
}
