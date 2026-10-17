/**
 * 材质库：使用已预取的纹理与 MaterialRegistryData（由 StructureData / World 各帧 materialPalette 汇总）中的动画描述，创建 MeshBasicMaterial。
 * 不在此模块内发起网络请求。
 *
 * ## P10 #261 退役改造（B5 #11 `material-viewport-tick`；R-WK-03 明列）
 *
 * ## 被删除的机制
 *
 * 旧实现有一套**每材质自持的毫秒累加器**：`applyAnimatedStrip` 里
 * `accMs += dtMs`，再由 `while (accMs >= dur)` 消费整段时长并前推 `frameSeq`，
 * 每步直接改 `tex.offset.y`。时间从 `tick(deltaMs)` 进来，而 `tick` 由
 * `renderEngine` 的 RAF 经 `clock.getDelta()` 喂 —— 那是 #249 §7 与 §19.3
 * 明令禁止的"材质/视口自行累计 tick"。
 *
 * 它的两个可观测后果：
 *  - **跳帧不一致**：累加器在边界上的历史不同 ⇒ "连续播放到 t" 与
 *    "直接定位到 t" 给出不同帧（旧 `while` 在边界上停在本帧）；
 *  - **无时间权威**：时间不在 `EditContext` 上 ⇒ 两个 Area 各播各的，
 *    面板缩略图与视口可以显示不同帧。
 *
 * ## 替代：时间进、帧出（**没有累加器**）
 *
 * 现在的时间**只有一个来源**：`EditContext.time`（经 `composition/kernelRuntime`
 * 的 `sceneSeconds()` 换算成秒）。{@link SimpleMaterialLibrary.setSceneTime}
 * 接收那个秒数，用 `domain/materials#sampleStripFrameAt` 的**离散阶跃采样**
 * 算出每个动画纹理应显示哪一帧，再写 `tex.offset.y`。
 *
 * 于是：
 *  - "同一时间 ⇒ 同一帧"是结构性质（纯函数，无历史）；
 *  - 拖动定位与连续播放共用一条求值路径（A09/A27）；
 *  - `tick` / `registerTick` / `accMs` **全部消失** ——
 *    "每材质每帧累计"这条路径在类型上不存在。
 *
 * ## 为什么仍要写 `tex.offset.y`（而不是让着色器自己采样）
 *
 * 帧条偏移是**纹理状态**（`THREE.Texture.offset`），改它的代价远低于
 * 每帧重传 uniform 或改材质。本批保留"写 offset"这一呈现手段，
 * 删掉的是"**谁**决定写什么"里的累加器 —— 决定权从材质库的私有历史
 * 移到了显式传入的场景时间。
 */

import * as THREE from 'three'

import {
  frameCountFromImageSize,
  resolveAnimationTimeline,
  type ParsedMcmeta,
} from '../assets/textureStripAnimation'
import { batchMaterialCacheKey, type BatchDescriptor } from '../mesh/batchDescriptor'
import type { MaterialBlendMode, MaterialEntry, MaterialRegistryData } from '../schema/types'
import { sampleStripFrameAt, stripTimeline, type StripTimeline } from '@/domain/materials'

/**
 * 嵌入/预览配置中使用的材质库公开接口（避免 Vue 模板对 class 私有字段的推断问题）。
 *
 * ## P10 #261：`tick(deltaMs)` 已删除，改为 `setSceneTime(seconds)`
 *
 * 两个签名的差别不是"换个名字"，而是**语义方向**：
 *  - 旧的 `tick(deltaMs)` 是**增量**输入 ⇒ 接收方必须自持累加状态，
 *    于是"当前是第几帧"是材质库的**私有历史**；
 *  - 新的 `setSceneTime(seconds)` 是**绝对**输入 ⇒ 接收方是**无状态**的
 *    纯映射（时间 → 帧），同一输入恒得同一输出。
 *
 * 后者使"两个 Area 显示同一帧"（同一 `EditContext.time` ⇒ 同一次调用 ⇒
 * 同一结果）成为结构事实，而旧形态下它只是"两个库恰好被喂了相同增量"
 * 这一偶然事实。
 */
export interface MaterialLibraryApi {
  /**
   * 按**场景时间**（秒）更新全部动画纹理的帧偏移。
   *
   * 无状态：重复调用同一秒数得同一结果；倒退定位给出倒退后的帧
   * （不是"只能向前"的累积量）。
   */
  setSceneTime(seconds: number): void
  /**
   * 本库**实际**会随场景时间采样的帧条（含每帧停留毫秒）。空数组 = 没有动画材质。
   *
   * ## 为什么从这里取，而不是再从 plain doc 解析一遍（M5-4）
   *
   * `configureTextureForEntry` 是**唯一**决定"这是不是动画条 / 几帧 / 每帧多久"的地方
   * （内部走 `resolveAnimationTimeline`）。第二份解析必然漂移，而漂移的表现正是
   * "GIF 的帧时长与画面看到的帧不同步"——故 GIF 计划只读这一个出口。
   */
  animatedSequences(): readonly AnimatedTextureSequence[]
  getMaterialForBatch(descriptor: BatchDescriptor): Promise<THREE.MeshBasicMaterial>
  dispose(): void
  /** 一旦为 true，进行中的 buildBlockMesh 应放弃结果，不再挂场景 */
  isDisposed(): boolean
}


function createFaceMaterial(
  tex: THREE.Texture,
  tint: THREE.Color,
  blend: MaterialBlendMode,
  useVertexColor: boolean,
): THREE.MeshBasicMaterial {
  const baseColor = useVertexColor ? new THREE.Color(0xffffff) : tint
  if (blend === 'cutout' || blend === 'translucent') {
    const cutout = blend === 'cutout'
    return new THREE.MeshBasicMaterial({
      map: tex,
      color: baseColor,
      vertexColors: useVertexColor,
      transparent: true,
      alphaTest: cutout ? 0.5 : 0,
      depthWrite: true,
    })
  }
  return new THREE.MeshBasicMaterial({
    map: tex,
    color: baseColor,
    vertexColors: useVertexColor,
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

/**
 * 一个动画纹理的**采样登记**（时间 → 帧偏移的纯映射）。
 *
 * 它是**值**，不含历史：`applyFrameOffset` 每次都从 `timeline` + 传入的秒数
 * 现算。旧形态这里是一个闭包（`registerTick((dtMs) => { accMs += … })`），
 * 闭包里藏着 `accMs` 与 `frameSeq` 两个可变状态 —— 那正是被删除的机制。
 */
interface AnimatedStrip {
  readonly tex: THREE.Texture
  readonly timeline: StripTimeline
  readonly frameCount: number
  /** 材质身份（materialId）；GIF 计划的稳定排序与诊断用。 */
  readonly materialId: string
}

/** 材质库对外报告的**实际**动画序列（M5-4：GIF 时间计划的输入）。 */
export interface AnimatedTextureSequence {
  readonly materialId: string
  readonly frameCount: number
  readonly durationsMs: readonly number[]
}

/**
 * 帧条配置（P10 #261 退役改造）。
 *
 * ## 与旧 `applyAnimatedStrip` 的差别（逐条对照）
 *
 * | | 旧 | 新 |
 * |---|---|---|
 * | 输入 | `registerTick` 回调 + 闭包里的 `accMs`/`frameSeq` | 无回调；登记一个 {@link AnimatedStrip} 值 |
 * | 谁推进 | `renderEngine` 的 RAF 喂 `tick(deltaMs)` | 宿主把 `EditContext.time` 换算成秒后喂 `setSceneTime` |
 * | 帧怎么定 | `while (accMs >= dur)` 消费整段时长 | `sampleStripFrameAt(timeline, ms)` 纯采样 |
 * | 边界行为 | 边界停在本帧（累加器历史相关） | 半开区间：边界取**下一项**（与 `sampleTrack` 的 `step` 同义） |
 * | 倒退定位 | 不可表达（`accMs` 只增） | 直接可用（时间进、帧出） |
 *
 * ## 为什么不再需要 `MAX_ADVANCES_PER_TICK` 那个夹取
 *
 * 旧实现夹取的是"一次 tick 里最多前推多少帧"—— 因为累加器可能一次积压很多
 * （切标签页回来）。纯采样**没有积压**：它只看"现在是几秒"，
 * 于是"积压"这个状态不存在，夹取也随之不需要。
 *
 * 单帧 delta 的上限仍在（`composition/kernelRuntime` 的 `maxDeltaSeconds`），
 * 但它的作用变了：旧的是"防止累加器爆炸"，新的是"防止时间瞬移"
 * （切回标签页时不要把播放位置跳到很晚）—— 后者是**产品决策**，
 * 归装配层，而不是材质库的自我保护。
 */
function configureAnimatedStrip(
  tex: THREE.Texture,
  parsed: ParsedMcmeta,
  frameCount: number,
  materialId: string,
): AnimatedStrip | null {
  const { frames, durationMsPerFrame } = resolveAnimationTimeline(parsed, frameCount)
  if (frames.length === 0) return null

  tex.repeat.set(1, 1 / frameCount)
  tex.offset.set(0, 0)

  const timeline = stripTimeline(
    frames.map((f) => f.index),
    durationMsPerFrame,
  )
  // 初值：场景时间 0 对应的帧（与旧实现"先 applyFrameAtIndex(0)"同一呈现起点，
  // 但取值路径是采样而不是"下标 0"—— 时间 0 落在哪一项由时长轴决定）。
  applyFrameOffset(tex, timeline, frameCount, 0)
  return Object.freeze({ tex, timeline, frameCount, materialId })
}

/** 把采样出的帧写成纹理 V 偏移（呈现手段；帧的选择由纯采样决定）。 */
function applyFrameOffset(tex: THREE.Texture, timeline: StripTimeline, frameCount: number, seconds: number): void {
  const frame = sampleStripFrameAt(timeline, seconds * 1000)
  const clamped = Math.max(0, Math.min(frameCount - 1, frame))
  tex.offset.y = clamped / frameCount
}

function configureTextureForEntry(
  tex: THREE.Texture,
  entry: MaterialEntry,
  materialId: string,
): AnimatedStrip | null {
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
    return configureAnimatedStrip(tex, parsed, nFrames, materialId)
  }
  tex.repeat.set(1, 1)
  tex.offset.set(0, 0)
  return null
}

export class SimpleMaterialLibrary implements MaterialLibraryApi {
  private readonly textureByMaterialId = new Map<string, THREE.Texture>()

  private readonly materialByBatchKey = new Map<string, THREE.MeshBasicMaterial>()

  /**
   * 动画纹理的采样登记（**值**，不是回调）。
   *
   * 旧形态是 `tickFns: Array<(dtMs: number) => void>` —— 一组闭包，
   * 每个闭包自持 `accMs`/`frameSeq`。现在这里只有不可变的登记项，
   * "当前是第几帧"不存储（每次从时间现算）。
   */
  private readonly animatedStrips: AnimatedStrip[] = []

  /** 最近一次收到的场景时间（秒）；供诊断与"重复调用同值"的短路。 */
  private sceneSeconds = 0

  private disposed = false

  /**
   * @param preloaded 须已含 registry 中全部 materialId；纹理由 previewSession 按 palette 预取并传入
   */
  constructor(registry: MaterialRegistryData, preloaded: Map<string, THREE.Texture>) {
    for (const [materialId, tex] of preloaded) {
      const entry = registry.materials[materialId]
      if (!entry) continue
      const strip = configureTextureForEntry(tex, entry, materialId)
      if (strip) this.animatedStrips.push(strip)
      this.textureByMaterialId.set(materialId, tex)
    }
  }

  /**
   * 按场景时间（秒）更新全部动画纹理。
   *
   * 三条性质（对应 A09/A27 的判据）：
   *  1. **纯**：同一 `seconds` 恒得同一组偏移（重复调用无副作用差异）；
   *  2. **可倒退**：`seconds` 变小 ⇒ 帧随之回退（不是"只能向前"的累积量）；
   *  3. **无夹取**：没有 `Math.min(256, …)` 一类的自我保护 ——
   *     时间的合法性由**上游**保证（`composition/kernelRuntime` 的
   *     `maxDeltaSeconds` 是产品决策），本层不重复设防（重复设防会让
   *     "时间到底被谁改了"有两个答案）。
   */
  setSceneTime(seconds: number): void {
    if (this.disposed) return
    const s = Number.isFinite(seconds) ? seconds : 0
    this.sceneSeconds = s
    for (const strip of this.animatedStrips) {
      applyFrameOffset(strip.tex, strip.timeline, strip.frameCount, s)
    }
  }

  /**
   * 本库**实际**会随场景时间采样的帧条（M5-4）。
   *
   * 返回的是登记项的快照：`durationsMs` 与 `frameCount` 来自 `resolveAnimationTimeline`
   * 的同一份解释（`timeline.durationMs`），因此与 `setSceneTime` 的采样**同源**。
   */
  animatedSequences(): readonly AnimatedTextureSequence[] {
    return this.animatedStrips.map((s) => ({
      materialId: s.materialId,
      frameCount: s.frameCount,
      durationsMs: s.timeline.durationMs,
    }))
  }

  /** 最近一次收到的场景时间（秒）；诊断与测试用。 */
  get sceneTime(): number {
    return this.sceneSeconds
  }

  isDisposed(): boolean {
    return this.disposed
  }

  async getMaterialForBatch(descriptor: BatchDescriptor): Promise<THREE.MeshBasicMaterial> {
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
    this.animatedStrips.length = 0

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
