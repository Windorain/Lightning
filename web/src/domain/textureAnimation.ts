/**
 * `domain/textureAnimation` —— **纹理序列的共享派生**（M5-3b）。
 *
 * ## 它是什么（以及不是什么）
 *
 * 它把两条**外部声明**翻译成呈现可采样的输入：
 *
 * | 输入 | 来源 | 说明 |
 * |---|---|---|
 * | `kind` / `animation` | `domain/content#ContentResource`（mcmeta 形状） | 声明，不是播放逻辑 |
 * | `width` / `height` | 解码后的像素尺寸 | 竖条格数 = `height / width` |
 *
 * 输出是 {@link TextureAnimationBinding}：**可采样序列 + 竖条格数**。
 * 它**不含**时间：时间由 `domain/animation#sceneClockOf` 给出，采样由
 * `domain/materials#sampleTextureSequence` 做。本模块不引入任何"播放"概念
 * （无累加器、无循环句柄、无 tick 自驱）—— 那是 #249 §19.3 要退役的形态。
 *
 * ## 为什么需要"一个派生定义"
 *
 * 同一张竖条多帧贴图会被三个消费者解释：视口呈现（UV 偏移裁切）、材质面板
 * 缩略图、以及将来的 GIF/等轴导出。三处各写一遍"格数怎么算、tick 缺省是多少、
 * 索引怎么取模"，漂移的后果是**同一时刻三处显示不同帧**（A27 的同族形态）。
 * ⇒ 派生只有这一份，其余消费者调它。
 *
 * ## tick 缺省 = 1 tick = 50 ms（**不是** 1 ms）
 *
 * `domain/materials#stripTimeline` 对非法时长回落 **1 毫秒** —— 那条是**世界帧轴**
 * 的归一化（"帧为主"文档的帧清单），与纹理序列**无关**。本模块的缺省恒为
 * 1 tick = 50 ms（Minecraft 口径，与旧 `render/assets/textureStripAnimation` 同口径）。
 * 两个数字**故意不同**，判据里同时钉住（防止下一个人把它们"统一"回去）。
 *
 * ## 纯度
 *
 * 纯函数、无 IO、无时钟、无 `THREE`/DOM/Vue（`pureDomain`/架构闸门覆盖本文件）。
 */

import type { ResourceKind, TextureAnimationSpec } from '@/domain/content'
import {
  parseTextureSequence,
  type ResourceRef,
  type TextureSequence,
} from '@/domain/materials'

/** Java 版：1 tick = 50 ms（**唯一**定义；世界帧轴的 1 ms 回落是另一条轴，见文件头）。 */
export const TEXTURE_TICK_MS = 50

/** 每秒 tick 数（时长换算 `ticks / TEXTURE_TICKS_PER_SECOND`）。 */
export const TEXTURE_TICKS_PER_SECOND = 20

/**
 * 绑定形态的纹理动画输入（呈现侧采样需要的最小事实）。
 *
 * `sequence` 已经过 `domain/materials#parseTextureSequence` 校验与冻结；
 * `stripFrameCount` 是竖条格数 `height / width`（offset/repeat 的分母）。
 */
export interface TextureAnimationBinding {
  readonly sequence: TextureSequence
  /** 竖条格数 = `height / width`（>= 2；否则不是动画）。 */
  readonly stripFrameCount: number
}

/** 派生输入（`ContentResource` 的四项 + 解码后的像素尺寸）。 */
export interface TextureAnimationInput {
  readonly id: string
  readonly resource: ResourceRef
  readonly kind: ResourceKind
  readonly animation: TextureAnimationSpec | null
  readonly width: number
  readonly height: number
}

/** 正整数（tick 声明必须是正整数；非法 ⇒ `null`，由调用方回落默认）。 */
function positiveTicksOf(v: number | undefined): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null
  const ticks = Math.floor(v)
  return ticks >= 1 ? ticks : null
}

/**
 * 声明 → 可采样绑定。**`null` = 静态贴图**（不采样、不写 offset/repeat）。
 *
 * 派生规则（逐条可测；与旧链 `simpleMaterialLibrary`/`textureStripAnimation` 同结果）：
 *
 *  1. `width/height` 必须是正有限整数；否则 `null`；
 *  2. `height % width !== 0` ⇒ `null`（与旧 `frameCountFromImageSize` 抛错被
 *     try/catch 成静态**同结果**）—— **不**把资源判 failed（贴图本身没问题）；
 *  3. `n = height / width`；`n < 2` ⇒ `null`；
 *  4. `kind !== 'animated'` ⇒ `null`；`animated` 且无声明 ⇒ 按 MC 默认
 *     （`frametime=1`、顺序播放 0..n-1、不插值）；
 *  5. 帧索引取模归一（`((floor(i) % n) + n) % n`，适配器可做的归一化）；非有限索引跳过；
 *  6. tick：逐帧 `timeTicks` 非法 ⇒ 用默认；默认非法 ⇒ 1（**恒 50 ms**，见文件头）；
 *  7. `frameBlendAllowed = interpolate === true`（忠实保留声明；呈现侧是否真混合
 *     由 presenter 的显式诊断回答，不在这里假装）。
 *
 * 归一化后 `parseTextureSequence` **不可能**失败（索引已取模、时长 >= 1 tick、frames 非空）。
 * 若仍失败，说明本函数的归一化有缺陷 ⇒ **显式抛出**，不静默降级成静态贴图、
 * 也不用默认帧顶替。
 */
export function textureAnimationOf(input: TextureAnimationInput): TextureAnimationBinding | null {
  const w = input.width
  const h = input.height
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null
  if (h % w !== 0) return null
  const stripFrameCount = h / w
  if (stripFrameCount < 2) return null
  if (input.kind !== 'animated') return null

  const spec = input.animation
  const defaultTicks = positiveTicksOf(spec?.defaultFrametimeTicks) ?? 1
  const declared = spec?.frameSequence ?? []

  /** 声明里的帧项（空声明 = 顺序播放全部格）。 */
  const sourceFrames =
    declared.length === 0
      ? Array.from({ length: stripFrameCount }, (_, i) => ({ index: i }) as Readonly<{ index: number; timeTicks?: number }>)
      : declared

  const frames: { index: number; durationSeconds: number }[] = []
  for (const f of sourceFrames) {
    if (!Number.isFinite(f.index)) continue
    // 适配器归一化（取模）：声明的是"第几格"，格数由像素尺寸决定。
    const index = ((Math.floor(f.index) % stripFrameCount) + stripFrameCount) % stripFrameCount
    const ticks = positiveTicksOf(f.timeTicks) ?? defaultTicks
    frames.push({ index, durationSeconds: ticks / TEXTURE_TICKS_PER_SECOND })
  }
  if (frames.length === 0) return null

  const parsed = parseTextureSequence({
    id: input.id,
    resource: input.resource,
    frames,
    // 解析器要求默认时长为正；本处缺省恒为 1 tick（逐帧时长已在上方展开）。
    defaultDurationSeconds: defaultTicks / TEXTURE_TICKS_PER_SECOND,
    loop: 'loop',
    frameBlendAllowed: spec?.interpolate === true,
  })
  if (!parsed.ok) {
    throw new Error(
      `textureAnimationOf: 归一化后序列仍非法（${parsed.error.code}）—— 这是本函数归一化的实现缺陷，不是数据问题`,
    )
  }
  return Object.freeze({ sequence: parsed.value, stripFrameCount })
}

/**
 * 序列的**稳定键**（绑定键/同步去重键用；小的纯函数）。
 *
 * 只含"影响采样结果"的声明：每项 `index@duration` + loop + 是否允许混合。
 * 不含 id/资源 —— 那些由外层键（`textureBindingKey` / `assetId@contentVersion`）承担。
 */
export function sequenceKey(sequence: TextureSequence): string {
  const frames = sequence.frames
    .map((f) => `${f.index}@${f.duration.num}/${f.duration.den}`)
    .join(',')
  return `${frames}|${sequence.loop}|${sequence.frameBlendAllowed === true ? 'blend' : 'step'}`
}

/**
 * **动画声明**的稳定键（资源同步去重键用；`null/undefined` ⇒ `'-'`）。
 *
 * ## 为什么它必须进同步去重键
 *
 * `shared/viewport/useViewportRuntime#syncPresenterTextures` 的视频去重键原本只有
 * `assetId@contentVersion`。字节没变而**播放速度改**（mcmeta 的 `frametime`/`frames`）
 * 时，资源内容版本不变 ⇒ 不同步 ⇒ 绑定表里还是旧序列 ⇒ "改了播放速度不生效"。
 * 故该键必须再拼上本函数。
 *
 * 它保留**原始声明**（不是派生后的序列）：声明变但派生结果恰好相同时，重同步是
 * 安全且可解释的（多一次绑定重建，不少一次）。
 */
export function animationSpecKey(animation: TextureAnimationSpec | null | undefined): string {
  if (animation === null || animation === undefined) return '-'
  const defaultTicks = animation.defaultFrametimeTicks ?? 'x'
  const frames = (animation.frameSequence ?? [])
    .map((f) => `${f.index}:${f.timeTicks ?? 'x'}`)
    .join(',')
  return `d${defaultTicks}[${frames}]${animation.interpolate === true ? 'i' : '-'}`
}
