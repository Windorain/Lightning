/**
 * 方块 id → 物品栏精灵（Canvas / data URL）集中缓存；单 WebGLRenderer 串行烘焙。
 */

import * as THREE from 'three'

import { findBlockPaletteEntryByBlockId } from '../data/blockRegistryResolve'
import type { MaterialLibraryApi } from '../materials/simpleMaterialLibrary'
import { buildSingleBlockPreviewFromBakedPalette } from './blockSlotBaker'
import type { StructureDefinition } from '../schema/types'

export type BlockIconCacheStatus = 'idle' | 'pending' | 'ready' | 'error'

export interface BlockIconCachedEntry {
  status: BlockIconCacheStatus
  /** ready 时可用：离屏 canvas 或占位 */
  canvas?: HTMLCanvasElement
  error?: Error
}

export interface BlockIconCacheOptions {
  /** 纹理边长（正方形） */
  sizePx?: number
  /** 正交半宽/半高；越小方块在图内越大 */
  orthoHalf?: number
  /** 背景色（与侧栏协调）；alpha 0 可透 */
  clearColor?: number
  clearAlpha?: number
}

/** 变更 ortho/size 等布局时递增，供 `setRevisionKey` 拼接以重烘 */
export const BLOCK_ICON_LAYOUT_REVISION = '1'

type ResolvedIconOpts = Required<BlockIconCacheOptions>

const defaultOpts: ResolvedIconOpts = {
  sizePx: 64,
  orthoHalf: 1.22,
  clearColor: 0x000000,
  clearAlpha: 0,
}

/** 供 `setRevisionKey` 拼接：烘焙参数变化时需重烘 */
export function blockIconBakeLayoutKey(options?: BlockIconCacheOptions): string {
  const o = { ...defaultOpts, ...options }
  return `${o.sizePx}:${o.orthoHalf}:${o.clearColor}:${o.clearAlpha}`
}

/**
 * 失效键由调用方提供：结构 id + blocks 摘要变化时整表清空。
 */
export class BlockIconCache {
  private readonly library: MaterialLibraryApi

  private readonly structure: StructureDefinition | null

  private readonly opts: ResolvedIconOpts

  private renderer: THREE.WebGLRenderer | null = null

  private readonly map = new Map<string, BlockIconCachedEntry>()

  private readonly pendingQueue: string[] = []

  private drainRunning = false

  private revision = ''

  private disposed = false

  private loadFromBase64PNG(b64: string): Promise<HTMLCanvasElement> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        const s = this.opts.sizePx
        const canvas = document.createElement('canvas')
        canvas.width = s
        canvas.height = s
        const ctx = canvas.getContext('2d')
        if (!ctx) { reject(new Error('2D context unavailable')); return }
        ctx.drawImage(img, 0, 0, s, s)
        resolve(canvas)
      }
      img.onerror = () => reject(new Error('thumbnailPNG 解码失败'))
      img.src = `data:image/png;base64,${b64}`
    })
  }

  /** 按 blockId 通知，避免一图就绪时侧栏所有行一起 flush（O(行数×完成次数)） */
  private readonly listenersById = new Map<string, Set<() => void>>()

  constructor(
    library: MaterialLibraryApi,
    options?: BlockIconCacheOptions,
    structure?: StructureDefinition | null,
  ) {
    this.library = library
    this.structure = structure ?? null
    this.opts = { ...defaultOpts, ...options } as ResolvedIconOpts
  }

  /** 当结构或方块表变更时调用，会 dispose 旧图并清空队列 */
  setRevisionKey(key: string): void {
    if (this.revision === key) return
    this.revision = key
    this.clearEntries()
  }

  get(blockId: string): BlockIconCachedEntry {
    return this.map.get(blockId) ?? { status: 'idle' }
  }

  /** 指定 id 烘焙完成或失败时触发，供 Vue 仅刷新对应槽位 */
  subscribe(blockId: string, listener: () => void): () => void {
    let set = this.listenersById.get(blockId)
    if (!set) {
      set = new Set()
      this.listenersById.set(blockId, set)
    }
    set.add(listener)
    return () => {
      set!.delete(listener)
      if (set!.size === 0) this.listenersById.delete(blockId)
    }
  }

  private notifyBlock(blockId: string): void {
    const set = this.listenersById.get(blockId)
    if (!set) return
    for (const fn of set) {
      try {
        fn()
      } catch {
        /* ignore */
      }
    }
  }

  /** 整表清空后通知仍订阅的组件（如 revision 变更） */
  private notifyAllSubscribers(): void {
    for (const set of this.listenersById.values()) {
      for (const fn of set) {
        try {
          fn()
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** 去重后请求烘焙；同一 id 只排队一次 */
  ensure(blockIds: string[]): void {
    if (this.disposed) return
    const seen = new Set<string>()
    for (const id of blockIds) {
      if (seen.has(id)) continue
      seen.add(id)
      const row = this.map.get(id)
      if (row?.status === 'ready' || row?.status === 'pending') continue
      this.map.set(id, { status: 'pending' })
      this.pendingQueue.push(id)
    }
    void this.drainQueue()
  }

  private async drainQueue(): Promise<void> {
    if (this.drainRunning || this.disposed) return
    this.drainRunning = true
    try {
      while (this.pendingQueue.length > 0 && !this.disposed) {
        const id = this.pendingQueue.shift()!
        const current = this.map.get(id)
        if (!current || current.status !== 'pending') continue
        await this.bakeOne(id)
      }
    } finally {
      this.drainRunning = false
    }
  }

  private ensureRenderer(): THREE.WebGLRenderer {
    if (this.renderer) return this.renderer
    const r = new THREE.WebGLRenderer({
      alpha: this.opts.clearAlpha < 1,
      antialias: false,
      preserveDrawingBuffer: true,
    })
    r.setPixelRatio(1)
    r.outputColorSpace = THREE.SRGBColorSpace
    const s = this.opts.sizePx
    r.setSize(s, s, false)
    r.setClearColor(this.opts.clearColor, this.opts.clearAlpha)
    this.renderer = r
    return r
  }

  private async bakeOne(blockId: string): Promise<void> {
    if (this.disposed) return
    const paletteEntry = this.structure ? findBlockPaletteEntryByBlockId(this.structure, blockId) : undefined

    if (!paletteEntry) {
      this.map.set(blockId, {
        status: 'error',
        error: new Error(`方块未注册: ${blockId}`),
      })
      this.notifyBlock(blockId)
      return
    }

    // 优先使用 Java 端 renderBlockAsItem 预渲染的缩略图
    if (paletteEntry.thumbnailPNG) {
      try {
        const canvas = await this.loadFromBase64PNG(paletteEntry.thumbnailPNG)
        this.map.set(blockId, { status: 'ready', canvas })
        this.notifyBlock(blockId)
        return
      } catch {
        // 回退到 WebGL 烘焙
      }
    }

    let group: THREE.Group | null = null
    let disposeMesh: (() => void) | null = null

    try {
      const built = await buildSingleBlockPreviewFromBakedPalette(
        paletteEntry,
        this.structure!.materialPalette,
        this.library,
      )
      group = built.group
      disposeMesh = built.dispose

      const renderer = this.ensureRenderer()
      const s = this.opts.sizePx
      const scene = new THREE.Scene()
      scene.add(group)

      const ambient = new THREE.AmbientLight(0xffffff, 0.72)
      const dirKey = new THREE.DirectionalLight(0xffffff, 0.88)
      dirKey.position.set(0, 0, -6)
      const dirFill = new THREE.DirectionalLight(0xffffff, 0.32)
      dirFill.position.set(5, 8, 4)
      scene.add(ambient, dirKey, dirFill)

      const half = this.opts.orthoHalf
      const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 80)
      cam.position.set(0, 0, -4.2)
      cam.lookAt(0, 0, 0)
      cam.updateProjectionMatrix()

      renderer.setClearColor(this.opts.clearColor, this.opts.clearAlpha)
      renderer.setSize(s, s, false)
      this.library.tick(16)
      renderer.render(scene, cam)

      const src = renderer.domElement
      const canvas = document.createElement('canvas')
      canvas.width = s
      canvas.height = s
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('2D context unavailable')
      ctx.drawImage(src, 0, 0)

      this.map.set(blockId, { status: 'ready', canvas })
      this.notifyBlock(blockId)
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      this.map.set(blockId, { status: 'error', error: err })
      this.notifyBlock(blockId)
    } finally {
      disposeMesh?.()
    }
  }

  private clearEntries(): void {
    for (const v of this.map.values()) {
      if (v.canvas) {
        v.canvas.width = 0
        v.canvas.height = 0
      }
    }
    this.map.clear()
    this.pendingQueue.length = 0
    this.notifyAllSubscribers()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearEntries()
    this.renderer?.dispose()
    this.renderer?.forceContextLoss?.()
    this.renderer = null
    this.listenersById.clear()
  }
}
