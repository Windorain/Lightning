/**
 * DRW — 视口绘制运行时：mesh/材质/帧呈现，watch Main ref（不 import Context）。
 */
import { ref, shallowRef, watch, type Ref, type ShallowRef } from 'vue'
import * as THREE from 'three'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import type { LoadStatus } from '@/runtime/types'
import type { StructureDefinition } from '@/render/schema/types'
import type { BlockIconCache } from '@/render/interaction/blockIconCache'
import { SelectionOutlinePass } from '@/render/postprocessing/SelectionOutlinePass'
import { createRenderAssets, type RenderAssets, type RenderAssetsComputed } from '@/context/renderAssets'
import type { ViewportSlot } from '@/runtime/types'
import type { BlockRef, SelectedEntity } from '@/context/selection'
import { SelectionHighlightProvider } from '@/render/mesh/selectionHighlightProvider'

export interface DRWDeps {
  docRef: Ref<RuntimeDocument | null>
  structEpochRef: Ref<number>
  currentFrameIndex: Ref<number>
  layerWorldY: Ref<number>
  framesPlaybackIsPlaying: Ref<boolean>
  structureDefinition: ShallowRef<StructureDefinition | null>
  mainMeshGroup: ShallowRef<THREE.Group | null>
  slot: ViewportSlot
  blockIconCacheOptions?: { sizePx?: number; orthoHalf?: number }
  initialWorldFrameIndex?: number
  setFrameIndex?: (index: number) => void | Promise<void>
}

export class DRW {
  readonly sceneRef = shallowRef<THREE.Scene | null>(null)
  readonly loadStatus = ref<LoadStatus>('loading')
  readonly meshBusy = ref(false)
  readonly blockIconCache = shallowRef<BlockIconCache | null>(null)
  readonly tooltipPalette = shallowRef<string[]>([])
  readonly outlinePass: SelectionOutlinePass
  readonly renderAssets: RenderAssets

  readonly computed: RenderAssetsComputed

  private stopOutlineWatch: (() => void) | null = null
  private highlightProvider = new SelectionHighlightProvider()

  constructor(deps: DRWDeps) {
    this.outlinePass = new SelectionOutlinePass(new THREE.Vector2(1024, 768))
    this.renderAssets = createRenderAssets({
      docRef: deps.docRef,
      loadStatus: this.loadStatus,
      meshBusy: this.meshBusy,
      blockIconCache: this.blockIconCache,
      tooltipPalette: this.tooltipPalette,
      structureDefinition: deps.structureDefinition,
      mainMeshGroup: deps.mainMeshGroup,
      sceneRef: this.sceneRef,
      worldFrameIndex: deps.currentFrameIndex,
      layerWorldY: deps.layerWorldY,
      framesPlaybackIsPlaying: deps.framesPlaybackIsPlaying,
      blockIconCacheOptions: deps.blockIconCacheOptions ?? {},
      initialWorldFrameIndex: deps.initialWorldFrameIndex,
      structEpochRef: deps.structEpochRef,
      setFrameIndex: deps.setFrameIndex,
    })
    this.computed = this.renderAssets.computed
  }

  registerScene(scene: THREE.Scene): void {
    this.sceneRef.value = scene
    this.renderAssets.registerScene(scene)
  }

  init(): void {
    this.renderAssets.init()
  }

  dispose(): void {
    this.stopOutlineWatch?.()
    this.stopOutlineWatch = null
    this.outlinePass.dispose()
    this.renderAssets.disposeCachesAndLibrary()
    this.renderAssets.dispose()
  }

  /**
   * watch selection + hover → outline pass（对标 Blender 视口 overlay derive）。
   */
  bindSelectionOutline(options: {
    selectionItems: Ref<Set<SelectedEntity>>
    hoveredBlock: Ref<BlockRef | null>
    highlightOnHover: Ref<boolean>
    getBlockGeometry: (pos: { x: number; y: number; z: number }) => import('@/render/schema/types').BakedQuad[] | null
    gridCenterWorld: (pos: { x: number; y: number; z: number }) => { x: number; y: number; z: number } | null
  }): void {
    const update = (): void => {
      if (!this.outlinePass) return
      const items = options.selectionItems.value
      const hov = options.highlightOnHover.value ? options.hoveredBlock.value : null
      if (!hov) {
        if (items.size === 0 || items.size > 500) {
          this.outlinePass.setMaskMeshes([])
          return
        }
        const masks = this.highlightProvider.build(
          items,
          options.getBlockGeometry,
          options.gridCenterWorld,
        )
        this.outlinePass.setMaskMeshes(masks)
        return
      }
      const entities = new Set(items)
      const dup = [...items].some(
        e => e.kind === 'block' && e.ref.pos.x === hov.pos.x && e.ref.pos.y === hov.pos.y && e.ref.pos.z === hov.pos.z,
      )
      if (!dup) entities.add({ kind: 'block', ref: hov })
      if (entities.size > 500) {
        this.outlinePass.setMaskMeshes([])
        return
      }
      const masks = this.highlightProvider.build(
        entities,
        options.getBlockGeometry,
        options.gridCenterWorld,
      )
      this.outlinePass.setMaskMeshes(masks)
    }
    this.stopOutlineWatch = watch(
      [options.selectionItems, options.hoveredBlock, options.highlightOnHover],
      update,
      { deep: true, flush: 'post' },
    )
    update()
  }
}
