/**
 * worldFrameController — 多帧世界文档的帧切换/播放控制。
 *
 * 抽取自 renderAssets.ts 的帧播放逻辑，包含：
 * - 帧索引归一化
 * - 自动播放（定时器循环）
 * - 帧切换 → resolveRenderBundle → 更新 structureDefinition / tooltipPalette / blockIconCache → presentContentMesh
 */
import { type Ref, type ShallowRef } from 'vue'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import type { StructureDefinition } from '@/render/schema/types'
import {
  isWorldDocument,
  resolveRenderBundle,
  type RenderBundleResolveResult,
} from '@/render/data/bundleResolve'

export const DEFAULT_WORLD_FRAME_DWELL_MS = 50

export function normalizeWorldFrameListIndex(w: { frames: unknown[] }, raw: number): number {
  const n = w.frames.length
  if (n === 0) return 0
  const i = Math.floor(raw)
  return ((i % n) + n) % n
}

export interface WorldFrameControllerDeps {
  docRef: Ref<RuntimeDocument | null>
  worldFrameIndex: Ref<number>
  framesPlaybackIsPlaying: Ref<boolean>
  structureDefinition: ShallowRef<StructureDefinition | null>
  tooltipPalette: ShallowRef<string[]>
  textureCache: ShallowRef<MaterialLibraryApi | null>
  rebuildBlockIconCache: (lib: MaterialLibraryApi, definition: StructureDefinition) => void
  runMesh: <T>(fn: () => Promise<T>) => Promise<T>
  presentContentMesh: () => Promise<void>
}

export interface WorldFrameController {
  setCurrentWorldFrame(index: number): Promise<void>
  toggleWorldFramesPlayback(): void
  clearWorldPlaybackSchedule(): void
}

export function createWorldFrameController(deps: WorldFrameControllerDeps): WorldFrameController {
  const {
    docRef,
    worldFrameIndex,
    framesPlaybackIsPlaying,
    structureDefinition,
    tooltipPalette,
    textureCache,
    rebuildBlockIconCache,
    runMesh,
    presentContentMesh,
  } = deps

  let worldPlaybackTimeoutId: ReturnType<typeof setTimeout> | null = null

  // ---- Playback schedule ----

  function clearWorldPlaybackSchedule(): void {
    if (worldPlaybackTimeoutId !== null) {
      clearTimeout(worldPlaybackTimeoutId)
      worldPlaybackTimeoutId = null
    }
  }

  function dwellMsForCurrentWorldFrame(): number {
    const doc = docRef.value
    if (!doc || doc.frameCount === 0) return DEFAULT_WORLD_FRAME_DWELL_MS
    const f = doc.frame(worldFrameIndex.value)
    const d = f?.durationMs
    if (typeof d === 'number' && Number.isFinite(d) && d > 0) return d
    return DEFAULT_WORLD_FRAME_DWELL_MS
  }

  function scheduleNextWorldFrameStep(): void {
    clearWorldPlaybackSchedule()
    if (!framesPlaybackIsPlaying.value) return

    const doc = docRef.value
    if (!doc || doc.frameCount < 2) return
    const n = doc.frameCount
    const delay = dwellMsForCurrentWorldFrame()
    const fromIndex = worldFrameIndex.value

    worldPlaybackTimeoutId = setTimeout(() => {
      worldPlaybackTimeoutId = null
      if (!framesPlaybackIsPlaying.value) return
      let next = fromIndex + 1
      if (next >= n) next = 0
      void setCurrentWorldFrame(next).then(() => {
        if (framesPlaybackIsPlaying.value) scheduleNextWorldFrameStep()
      }).catch(() => { framesPlaybackIsPlaying.value = false })
    }, delay)
  }

  // ---- Public API ----

  function toggleWorldFramesPlayback(): void {
    if (framesPlaybackIsPlaying.value) {
      framesPlaybackIsPlaying.value = false
      clearWorldPlaybackSchedule()
      return
    }
    framesPlaybackIsPlaying.value = true
    scheduleNextWorldFrameStep()
  }

  async function setCurrentWorldFrame(rawNext: number): Promise<void> {
    const doc = docRef.value
    if (!doc || doc.frameCount === 0) return
    return runMesh(async () => {
      const plain = doc.serialize()
      if (!isWorldDocument(plain) || plain.frames.length === 0) return
      const idx = normalizeWorldFrameListIndex(plain, rawNext)
      worldFrameIndex.value = idx

      const resolved: RenderBundleResolveResult = resolveRenderBundle({ document: plain }, idx)
      structureDefinition.value = resolved.definition
      tooltipPalette.value = resolved.tooltipPalette

      const lib = textureCache.value
      if (!lib || lib.isDisposed()) return

      rebuildBlockIconCache(lib, resolved.definition)
      await presentContentMesh()
    })
  }

  return {
    setCurrentWorldFrame,
    toggleWorldFramesPlayback,
    clearWorldPlaybackSchedule,
  }
}
