/**
 * DRW — 视口绘制运行时：mesh/材质/帧呈现 + selection outline（不 import Context）。
 */
import { ref, shallowRef, watch, type Ref, type ShallowRef } from 'vue'
import * as THREE from 'three'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import type { LoadStatus } from '@/runtime/types'
import type { StructureDefinition } from '@/render/schema/types'
import type { BlockIconCache } from '@/render/interaction/blockIconCache'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import { SelectionOutlinePass } from '@/render/postprocessing/SelectionOutlinePass'
import {
  createDrwMeshPipeline,
  type DrwComputed,
  type DrwMeshPipeline,
} from '@/runtime/drwMeshPipeline'
import type { BlockRef, SelectedEntity } from '@/context/selection'
import { SelectionHighlightProvider } from '@/render/mesh/selectionHighlightProvider'
import { bindViewportCameraSync } from '@/runtime/viewportCamera'
import type { ViewportCameraState } from '@/runtime/viewportCamera'

export type { DrwComputed } from '@/runtime/drwMeshPipeline'

export interface DRWDeps {
  docRef: Ref<RuntimeDocument | null>
  structEpochRef: Ref<number>
  currentFrameIndex: Ref<number>
  layerWorldY: Ref<number>
  framesPlaybackIsPlaying: Ref<boolean>
  structureDefinition: ShallowRef<StructureDefinition | null>
  mainMeshGroup: ShallowRef<THREE.Group | null>
  blockIconCacheOptions?: { sizePx?: number; orthoHalf?: number }
  initialWorldFrameIndex?: number
  setFrameIndex?: (index: number) => void | Promise<void>
  setFramesPlayback?: (playing: boolean) => void | Promise<void>
  showAnnotationsRef?: Ref<boolean>
  worldAnnotationGroupRef?: ShallowRef<THREE.Group | null>
  toolsOverlayGroupRef?: ShallowRef<THREE.Group | null>
  viewportCameraRef?: Ref<ViewportCameraState | null>
  cameraRef?: Ref<THREE.Camera | null>
  orbitTargetRef?: Ref<THREE.Vector3 | null>
}

export class DRW {
  readonly sceneRef = shallowRef<THREE.Scene | null>(null)
  readonly loadStatus = ref<LoadStatus>('loading')
  readonly meshBusy = ref(false)
  readonly blockIconCache = shallowRef<BlockIconCache | null>(null)
  readonly tooltipPalette = shallowRef<string[]>([])
  readonly outlinePass: SelectionOutlinePass
  readonly computed: DrwComputed
  readonly textureCache: Readonly<ShallowRef<MaterialLibraryApi | null>>

  private readonly _mesh: DrwMeshPipeline
  private stopOutlineWatch: (() => void) | null = null
  private stopCameraSync: (() => void) | null = null
  private highlightProvider = new SelectionHighlightProvider()

  constructor(deps: DRWDeps) {
    this.outlinePass = new SelectionOutlinePass(new THREE.Vector2(1024, 768))
    this._mesh = createDrwMeshPipeline({
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
      setFramesPlayback: deps.setFramesPlayback,
      showAnnotationsRef: deps.showAnnotationsRef,
      worldAnnotationGroupRef: deps.worldAnnotationGroupRef,
      toolsOverlayGroupRef: deps.toolsOverlayGroupRef,
    })
    if (deps.viewportCameraRef && deps.cameraRef && deps.orbitTargetRef) {
      this.stopCameraSync = bindViewportCameraSync(
        deps.viewportCameraRef,
        deps.cameraRef,
        deps.orbitTargetRef,
      )
    }
    this.computed = this._mesh.computed
    this.textureCache = this._mesh.textureCache
  }

  registerScene(scene: THREE.Scene): void {
    this._mesh.registerScene(scene)
  }

  init(): void {
    this._mesh.init()
  }

  loadStructureAndResources(): Promise<void> {
    return this._mesh.loadStructureAndResources()
  }

  rebuildContentMesh(): Promise<void> {
    return this._mesh.rebuildContentMesh()
  }

  bindOverlayPass(overlayPassGroup: THREE.Group): void {
    this._mesh.bindOverlayPass(overlayPassGroup)
  }

  unbindOverlayPass(): void {
    this._mesh.unbindOverlayPass()
  }

  dispose(): void {
    this.stopCameraSync?.()
    this.stopCameraSync = null
    this.stopOutlineWatch?.()
    this.stopOutlineWatch = null
    this.outlinePass.dispose()
    this._mesh.disposeCachesAndLibrary()
    this._mesh.dispose()
  }

  bindSelectionOutline(options: {
    selectionItems: Ref<Set<SelectedEntity>>
    hoveredBlock: Ref<BlockRef | null>
    highlightOnHover: Ref<boolean>
    getBlockGeometry: (pos: { x: number; y: number; z: number }) => import('@/render/schema/types').BakedQuad[] | null
    gridCenterWorld: (pos: { x: number; y: number; z: number }) => { x: number; y: number; z: number } | null
    /** Embed 侧栏按 blockId 高亮等附加遮罩 */
    extraMaskMeshes?: Ref<THREE.Mesh[]>
  }): void {
    const update = (): void => {
      if (!this.outlinePass) return
      const items = options.selectionItems.value
      const hov = options.highlightOnHover.value ? options.hoveredBlock.value : null
      let masks: THREE.Mesh[] = []
      if (!hov) {
        if (items.size > 0 && items.size <= 500) {
          masks = this.highlightProvider.build(
            items,
            options.getBlockGeometry,
            options.gridCenterWorld,
          )
        }
      } else {
        const entities = new Set(items)
        const dup = [...items].some(
          e => e.kind === 'block' && e.ref.pos.x === hov.pos.x && e.ref.pos.y === hov.pos.y && e.ref.pos.z === hov.pos.z,
        )
        if (!dup) entities.add({ kind: 'block', ref: hov })
        if (entities.size > 0 && entities.size <= 500) {
          masks = this.highlightProvider.build(
            entities,
            options.getBlockGeometry,
            options.gridCenterWorld,
          )
        }
      }
      const extra = options.extraMaskMeshes?.value ?? []
      this.outlinePass.setMaskMeshes(extra.length ? [...masks, ...extra] : masks)
    }
    const sources: unknown[] = [
      options.selectionItems,
      options.hoveredBlock,
      options.highlightOnHover,
    ]
    if (options.extraMaskMeshes) sources.push(options.extraMaskMeshes)
    this.stopOutlineWatch = watch(
      sources,
      update,
      { deep: true, flush: 'post' },
    )
    update()
  }
}
