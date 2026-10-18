/**
 * 方块 id → 物品栏精灵（Canvas / data URL）集中缓存；单 WebGLRenderer 串行烘焙。
 *
 * ── P2.4 部件物品图标通道（留白 #7 拍板登记，见 BlockStatsSidebar.vue 文件头）──
 *
 * 统计栏部件行的图标键 = **部件物品身份键**（`registry:damage[#nbt]`，契约 §5），
 * 与宿主方块键（`registryId` / `registryId@meta`）不撞名（损伤值段用 `:`、宿主 meta 段用 `@`），
 * 两族键共用同一张缓存表。部件物品图标按以下**键控通道 + 回退链**解析：
 *  1. **嵌入纹理通道**：导出时嵌入的部件物品图标纹理（P1.7/P1.8 产物），
 *     经 `setPartIconTextureSource` 以 `物品身份键 → base64 PNG` 解析器接入；
 *  2. **宿主调色板回退**：物品键 → 宿主方块键候选（`partItemKeyToBlockIdCandidates`，
 *     如 `minecraft:stone_slab:0` → `minecraft:stone_slab`），复用宿主
 *     thumbnailPNG 优先 / WebGL 烘焙兜底路径；
 *  3. **占位**：无纹理且无宿主几何 ⇒ `error` 条目，调用方渲染空槽位（与宿主图标失败同形态）。
 * 本轮 fixture 无部件图标纹理，通道 1 由 `setPartIconTextureSource` 键控注入验证；
 * 真实图标数据流由 P1.7/P1.8 产物接入后验证（通道与回退语义在此锁定）。
 */

import * as THREE from 'three'

import { findBlockPaletteEntryByBlockId } from '../data/blockRegistryResolve'
import type { MaterialLibraryApi } from '../materials/simpleMaterialLibrary'
import { buildSingleBlockPreviewFromBakedPalette } from './blockSlotBaker'
import type { BlockPaletteEntry, StructureDefinition } from '../schema/types'

/**
 * 部件物品图标纹理源：物品身份键（`registry:damage[#nbt]`）→ base64 PNG；
 * 返回 null = 该键无嵌入纹理（走回退链）。数据源 = 导出时嵌入的纹理体系（P1.7/P1.8）。
 */
export type PartIconTextureSource = (itemKey: string) => string | null

/**
 * 部件物品身份键 → 宿主方块调色板键候选（回退通道用，有序，先精确后宽泛）。
 * `registry:damage[#nbt]`：damage > 0 先试 `registry@damage` 再试 `registry`；
 * damage = 0 先 `registry`（宿主键省略 `@0`）再 `registry@0`。
 * 物品与方块注册名不同名（AE2/FMP 物品）时全部落空 ⇒ 调用方走占位。
 */
export function partItemKeyToBlockIdCandidates(itemKey: string): string[] {
  const noNbt = itemKey.split('#', 1)[0]!
  const idx = noNbt.lastIndexOf(':')
  if (idx <= 0) return [noNbt]
  const registry = noNbt.slice(0, idx)
  const damage = Number(noNbt.slice(idx + 1))
  if (!Number.isInteger(damage) || damage < 0) return [noNbt]
  return damage === 0 ? [registry, `${registry}@0`] : [`${registry}@${damage}`, registry]
}

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

/**
 * 图标烘焙上下文丢失时的**显式失败**（M8-3 / S0-A D10）。
 *
 * 图标缓存用**独立** WebGLRenderer（不占视口画布）。它的上下文丢失时，
 * `renderer.render()` 会按 three 的实现**静默返回**，随后 `drawImage(src)` 会把一张
 * 空画布拷进缓存并标成 `ready` ⇒ 图标永久空白且无报错（SPEC §10.7:309 禁止的
 * "静默错误"）。⇒ 烘焙前后都检查上下文：丢失就抛这个稳定原因，由 `bakeOne` 落
 * `status: 'error'`（可见、可重试），**绝不**缓存空白。
 */
export const ICON_BAKE_CONTEXT_LOST = 'icon-bake:webgl-context-lost'

/**
 * 烘焙上下文是否已不可用（取不到上下文也算不可用 —— 不拿空白冒充图标）。
 *
 * 纯函数（只读守卫）；`isContextLost()` 在个别实现上可能抛，按不可用处理。
 */
export function iconBakeContextLost(gl: { isContextLost(): boolean } | null | undefined): boolean {
  if (gl === null || gl === undefined) return true
  try {
    return gl.isContextLost()
  } catch {
    return true
  }
}

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

  /** 图标烘焙上下文是否已丢失（丢失期**不得**入缓存；见 ICON_BAKE_CONTEXT_LOST）。 */
  private contextLost = false

  /** 烘焙画布上的设备事件监听（拆解时显式注销 —— 与视口侧同一条 D11 纪律）。 */
  private contextListeners: { canvas: HTMLCanvasElement; onLost: (ev: Event) => void; onRestored: () => void } | null = null

  /** 部件物品图标纹理源（通道 1；P1.7/P1.8 产物接入点） */
  private partIconSource: PartIconTextureSource | null = null

  /** 已登记为"部件物品身份键"的缓存键（bake 分流依据；与宿主键同表不撞名） */
  private readonly partIconKeys = new Set<string>()

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

  /** 构造时注入的结构（统计栏等消费方读取文档根字段 / 回退通道取调色板用） */
  getStructure(): StructureDefinition | null {
    return this.structure
  }

  /**
   * 接入/更换部件物品图标纹理源（通道 1）。更换后已烘部件条目全部作废重烘，
   * 宿主条目不受影响。`null` = 无嵌入纹理（纯回退链）。
   */
  setPartIconTextureSource(source: PartIconTextureSource | null): void {
    if (this.partIconSource === source) return
    this.partIconSource = source
    const keys = [...this.partIconKeys]
    for (const key of keys) {
      const v = this.map.get(key)
      if (v?.canvas) {
        v.canvas.width = 0
        v.canvas.height = 0
      }
      this.map.delete(key)
    }
    if (this.disposed || keys.length === 0) return
    this.ensurePartIcons(keys)
    for (const key of keys) this.notifyBlock(key)
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

  /**
   * 部件物品图标通道入口：登记物品身份键并排队烘焙（通道/回退链见文件头拍板）。
   * 与 `ensure` 同表缓存；键一旦被登记为部件键，后续 bake 走部件回退链而非宿主查找。
   */
  ensurePartIcons(itemKeys: string[]): void {
    if (this.disposed) return
    const seen = new Set<string>()
    for (const key of itemKeys) {
      if (seen.has(key)) continue
      seen.add(key)
      this.partIconKeys.add(key)
      const row = this.map.get(key)
      if (row?.status === 'ready' || row?.status === 'pending') continue
      this.map.set(key, { status: 'pending' })
      this.pendingQueue.push(key)
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
    // 独立上下文的丢失/恢复：丢失期置位（阻断空白入库），恢复后重试因丢失失败的图标。
    const canvasEl = r.domElement
    const onLost = (ev: Event): void => {
      ev.preventDefault()
      this.contextLost = true
    }
    const onRestored = (): void => {
      this.contextLost = false
      this.retryContextLossFailures()
    }
    canvasEl.addEventListener('webglcontextlost', onLost, false)
    canvasEl.addEventListener('webglcontextrestored', onRestored, false)
    this.contextListeners = { canvas: canvasEl, onLost, onRestored }
    this.renderer = r
    return r
  }

  private async bakeOne(blockId: string): Promise<void> {
    if (this.disposed) return
    if (this.partIconKeys.has(blockId)) return this.bakePartIcon(blockId)
    const paletteEntry = this.structure ? findBlockPaletteEntryByBlockId(this.structure, blockId) : undefined

    if (!paletteEntry) {
      this.map.set(blockId, {
        status: 'error',
        error: new Error(`方块未注册: ${blockId}`),
      })
      this.notifyBlock(blockId)
      return
    }

    try {
      const canvas = await this.bakePaletteEntryCanvas(paletteEntry)
      this.map.set(blockId, { status: 'ready', canvas })
      this.notifyBlock(blockId)
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      this.map.set(blockId, { status: 'error', error: err })
      this.notifyBlock(blockId)
    }
  }

  /**
   * 部件物品图标烘焙（键控通道 + 回退链，见文件头拍板）：
   * 嵌入纹理（通道 1）→ 宿主调色板回退（通道 2，thumbnailPNG/WebGL）→ 占位（通道 3）。
   */
  private async bakePartIcon(itemKey: string): Promise<void> {
    if (this.disposed) return

    // 通道 1：导出时嵌入的部件物品图标纹理
    const embedded = this.partIconSource?.(itemKey) ?? null
    if (embedded) {
      try {
        const canvas = await this.loadFromBase64PNG(embedded)
        this.map.set(itemKey, { status: 'ready', canvas })
        this.notifyBlock(itemKey)
        return
      } catch {
        // 解码失败：落回退链
      }
    }

    // 通道 2：物品键 → 宿主方块键候选，复用宿主 thumbnailPNG 优先 / WebGL 兜底
    if (this.structure) {
      for (const candidate of partItemKeyToBlockIdCandidates(itemKey)) {
        const paletteEntry = findBlockPaletteEntryByBlockId(this.structure, candidate)
        if (!paletteEntry) continue
        try {
          const canvas = await this.bakePaletteEntryCanvas(paletteEntry)
          this.map.set(itemKey, { status: 'ready', canvas })
          this.notifyBlock(itemKey)
          return
        } catch {
          // 试下一候选
        }
      }
    }

    // 通道 3：占位（调用方渲染空槽位，与宿主图标失败同形态）
    this.map.set(itemKey, {
      status: 'error',
      error: new Error(`部件物品图标不可用: ${itemKey}`),
    })
    this.notifyBlock(itemKey)
  }

  /**
   * 宿主调色板条目 → 图标 canvas：Java 端 renderBlockAsItem 预渲染缩略图优先，
   * 缺失/解码失败时 WebGL 烘焙兜底。
   */
  private async bakePaletteEntryCanvas(paletteEntry: BlockPaletteEntry): Promise<HTMLCanvasElement> {
    if (paletteEntry.thumbnailPNG) {
      try {
        return await this.loadFromBase64PNG(paletteEntry.thumbnailPNG)
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
      // **P10 #261**：旧实现是 `this.library.tick(16)` —— 在烘焙前把材质库的
      // 时间**前推 16ms**（一个"拍脑袋"的固定 dt，目的是让图标不总是第一帧）。
      // 那属于被退役的 `material-tick` 机制（每材质累计 tick）。
      //
      // 替代：在**定义好的烘焙时间**做一次纯采样。取 0 秒是刻意的 ——
      // 图标是**静态缩略图**，它不该随播放位置变化（否则同一方块在不同时刻
      // 烘焙出不同图标，缓存键就无法表达"这份图标代表什么"）。
      // 采样到 0 秒 ⇒ 图标恒显示时长轴上第 0 秒对应的帧，与播放无关。
      //
      // 这与 `bakeRevisionKey`（`setRevisionKey` 设的缓存键）是同一政策的两半：
      // 键说"这份图标由哪些输入决定"，而本行说"那些输入里时间取哪个值"。
      this.library.setSceneTime(0)
      // D10：丢失期**不得**渲染后拷一张空画布进缓存。
      if (this.contextLost || iconBakeContextLost(renderer.getContext())) {
        throw new Error(ICON_BAKE_CONTEXT_LOST)
      }
      renderer.render(scene, cam)
      // 渲染中途丢失同样不可信（render 会静默返回）—— 落缓存前再验一次。
      if (this.contextLost || iconBakeContextLost(renderer.getContext())) {
        throw new Error(ICON_BAKE_CONTEXT_LOST)
      }

      const src = renderer.domElement
      const canvas = document.createElement('canvas')
      canvas.width = s
      canvas.height = s
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('2D context unavailable')
      ctx.drawImage(src, 0, 0)

      return canvas
    } finally {
      disposeMesh?.()
    }
  }

  /**
   * 恢复后重试**因上下文丢失而失败**的图标（只动这一类错误，不碰真实资源错误）。
   */
  private retryContextLossFailures(): void {
    const hostKeys: string[] = []
    const partKeys: string[] = []
    for (const [key, entry] of [...this.map.entries()]) {
      if (entry.status !== 'error' || entry.error?.message !== ICON_BAKE_CONTEXT_LOST) continue
      this.map.delete(key)
      if (this.partIconKeys.has(key)) partKeys.push(key)
      else hostKeys.push(key)
    }
    if (hostKeys.length > 0) this.ensure(hostKeys)
    if (partKeys.length > 0) this.ensurePartIcons(partKeys)
  }

  private clearEntries(): void {
    for (const v of this.map.values()) {
      if (v.canvas) {
        v.canvas.width = 0
        v.canvas.height = 0
      }
    }
    this.map.clear()
    this.partIconKeys.clear()
    this.pendingQueue.length = 0
    this.notifyAllSubscribers()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearEntries()
    if (this.contextListeners !== null) {
      this.contextListeners.canvas.removeEventListener('webglcontextlost', this.contextListeners.onLost, false)
      this.contextListeners.canvas.removeEventListener('webglcontextrestored', this.contextListeners.onRestored, false)
      this.contextListeners = null
    }
    this.renderer?.dispose()
    this.renderer?.forceContextLoss?.()
    this.renderer = null
    this.listenersById.clear()
  }
}