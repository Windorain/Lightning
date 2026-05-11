/**
 * 材质库：使用已预取的纹理与 MaterialRegistryData（由 StructureData / World 各帧 materialPalette 汇总）中的动画描述，创建 MeshStandardMaterial。
 * 不在此模块内发起网络请求。
 */

import * as THREE from 'three'

import {
  frameCountFromImageSize,
  resolveAnimationTimeline,
  type ParsedMcmeta,
} from '../assets/textureStripAnimation'
import { batchMaterialCacheKey, type BatchDescriptor } from '../mesh/batchDescriptor'
import type { MaterialBlendMode, MaterialEntry, MaterialRegistryData } from '../schema/types'

/** 嵌入/预览配置中使用的材质库公开接口（避免 Vue 模板对 class 私有字段的推断问题） */
export interface MaterialLibraryApi {
  tick(deltaMs: number): void
  getMaterialForBatch(descriptor: BatchDescriptor): Promise<THREE.MeshStandardMaterial>
  dispose(): void
  /** 一旦为 true，进行中的 buildBlockMesh 应放弃结果，不再挂场景 */
  isDisposed(): boolean
}

function createFaceMaterial(
  tex: THREE.Texture,
  tint: THREE.Color,
  blend: MaterialBlendMode,
  useVertexColor: boolean,
): THREE.MeshStandardMaterial {
  const baseColor = useVertexColor ? new THREE.Color(0xffffff) : tint
  if (blend === 'cutout' || blend === 'translucent') {
    const cutout = blend === 'cutout'
    return new THREE.MeshStandardMaterial({
      map: tex,
      color: baseColor,
      vertexColors: useVertexColor,
      transparent: true,
      alphaTest: cutout ? 0.5 : 0,
      /**
       * 体素结构以 batch mesh 为单位排序，无法按像素排序半透明；不写深度会导致透明与不透明邻接处错乱。
       * 与邻面剔除配合，多层纯玻璃重叠已减少；真流体等若需可后续单独材质策略。
       */
      depthWrite: true,
      roughness: 0.85,
      metalness: 0.05,
      /** 透明批次与不透明均开 offset 时共面处易错乱；透明单独关闭 */
      polygonOffset: false,
    })
  }
  return new THREE.MeshStandardMaterial({
    map: tex,
    color: baseColor,
    vertexColors: useVertexColor,
    roughness: 0.85,
    metalness: 0.05,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  })
}

function materialEntryToParsedMcmeta(entry: MaterialEntry, frameCount: number): ParsedMcmeta {
  if (entry.animation) {
    const a = entry.animation
    return {
      animation: {
        defaultFrametimeTicks: a.defaultFrametimeTicks ?? 1,
        frameSequence: (a.frameSequence ?? []).map((f) => ({
          index: f.index,
          timeTicks: f.timeTicks,
        })),
        interpolate: a.interpolate === true,
      },
    }
  }
  // 仅 kind === animated 时启用竖条帧动画，避免把大量 static16 误判为动画导致每材质每帧 tick（卡顿）
  if (entry.kind === 'animated' && frameCount >= 2) {
    return {
      animation: {
        defaultFrametimeTicks: 1,
        frameSequence: [],
        interpolate: false,
      },
    }
  }
  return {}
}

function shouldAnimateStrip(parsed: ParsedMcmeta, frameCount: number): boolean {
  if (frameCount < 2) return false
  return parsed.animation !== undefined
}

function applyAnimatedStrip(
  tex: THREE.Texture,
  parsed: ParsedMcmeta,
  frameCount: number,
  registerTick: (fn: (dtMs: number) => void) => void,
): void {
  const { frames, durationMsPerFrame } = resolveAnimationTimeline(parsed, frameCount)
  if (frames.length === 0) return

  tex.repeat.set(1, 1 / frameCount)
  tex.offset.set(0, 0)

  let frameSeq = 0
  let accMs = 0

  const applyFrameAtIndex = (i: number) => {
    const f = frames[i % frames.length].index
    const clamped = Math.max(0, Math.min(frameCount - 1, f))
    tex.offset.y = clamped / frameCount
  }

  applyFrameAtIndex(0)

  const MAX_ADVANCES_PER_TICK = 48
  registerTick((dtMs) => {
    accMs += dtMs
    const len = frames.length
    if (len === 0) return
    let advances = 0
    let dur = durationMsPerFrame[frameSeq % len]
    if (dur <= 0) dur = 1
    while (accMs >= dur && advances < MAX_ADVANCES_PER_TICK) {
      accMs -= dur
      frameSeq = (frameSeq + 1) % len
      applyFrameAtIndex(frameSeq)
      advances++
      dur = durationMsPerFrame[frameSeq % len]
      if (dur <= 0) dur = 1
    }
  })
}

function configureTextureForEntry(
  tex: THREE.Texture,
  entry: MaterialEntry,
  registerTick: (fn: (dtMs: number) => void) => void,
): void {
  tex.colorSpace = THREE.SRGBColorSpace
  tex.flipY = false
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping

  const img = tex.image as HTMLImageElement | { width: number; height: number }
  const w = 'naturalWidth' in img ? img.naturalWidth || img.width : img.width
  const h = 'naturalHeight' in img ? img.naturalHeight || img.height : img.height

  let nFrames = 1
  try {
    nFrames = frameCountFromImageSize(w, h)
  } catch {
    nFrames = 1
  }

  const parsed = materialEntryToParsedMcmeta(entry, nFrames)
  if (shouldAnimateStrip(parsed, nFrames)) {
    applyAnimatedStrip(tex, parsed, nFrames, registerTick)
  } else {
    tex.repeat.set(1, 1)
    tex.offset.set(0, 0)
  }
}

export class SimpleMaterialLibrary implements MaterialLibraryApi {
  private readonly textureByMaterialId = new Map<string, THREE.Texture>()

  private readonly materialByBatchKey = new Map<string, THREE.MeshStandardMaterial>()

  private readonly tickFns: Array<(dtMs: number) => void> = []

  private disposed = false

  /**
   * @param preloaded 须已含 registry 中全部 materialId；纹理由 previewSession 按 palette 预取并传入
   */
  constructor(registry: MaterialRegistryData, preloaded: Map<string, THREE.Texture>) {
    for (const [materialId, tex] of preloaded) {
      const entry = registry.materials[materialId]
      if (!entry) continue
      configureTextureForEntry(tex, entry, (fn) => this.registerTick(fn))
      this.textureByMaterialId.set(materialId, tex)
    }
  }

  tick(deltaMs: number): void {
    if (this.disposed) return
    // 避免切回标签页等导致单帧 delta 极大，在数百个动画回调里把主线程卡死
    const dt = Math.min(256, Math.max(0, deltaMs))
    for (const fn of this.tickFns) {
      fn(dt)
    }
  }

  private registerTick(fn: (dtMs: number) => void): void {
    this.tickFns.push(fn)
  }

  isDisposed(): boolean {
    return this.disposed
  }

  async getMaterialForBatch(descriptor: BatchDescriptor): Promise<THREE.MeshStandardMaterial> {
    if (this.disposed) {
      throw new Error('MaterialLibrary 已释放')
    }
    const key = batchMaterialCacheKey(descriptor)
    const hit = this.materialByBatchKey.get(key)
    if (hit) return hit

    const { materialId, blend, tint } = descriptor
    const tex = this.textureByMaterialId.get(materialId)
    if (!tex) throw new Error(`纹理未预取: ${materialId}`)

    const mat = createFaceMaterial(tex, tint, blend, descriptor.useVertexColor === true)
    this.materialByBatchKey.set(key, mat)
    return mat
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.tickFns.length = 0

    for (const mat of this.materialByBatchKey.values()) {
      mat.dispose()
    }
    this.materialByBatchKey.clear()

    for (const tex of this.textureByMaterialId.values()) {
      tex.dispose()
    }
    this.textureByMaterialId.clear()
  }
}
