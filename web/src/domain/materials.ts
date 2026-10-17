/**
 * `domain/materials` —— **材质资源引用、纹理序列与统一时间纯采样**（#249 §19.3 §7；契约 §4）。
 *
 * ## 本模块替代的旧机制（B5 退役矩阵 #11）
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | 材质面板独立 RAF 累积 | `workbench/ux/panels/useMaterialAnimation.ts` 的 `elapsed += delta` + 帧内 `while` 追赶 | `sampleTextureSequence(seq, time)` —— 时间进、样本出，**没有**累积量 |
 * | 视口各自 tick 累积纹理时间 | `shared/viewport/useMultiblockChannels.ts` 每视口 `revision`；`render/materials` 的 `accMs` | 同上；时间来自 `TimeBinding` 解析结果 |
 * | 帧混合默认淡入淡出 | 无显式声明时的隐式行为 | 无混合声明 ⇒ `mix` **恒为 0**（§19.3 + A27 负对照） |
 *
 * ## 四条硬要求及其落点
 *
 * ### 1. 半开区间与边界（#249 §19.3 明文）
 * 「序列间隔采用半开区间，恰好落在边界选**下一项**；循环末尾回起点，负时间用定义明确的
 * 取模，非循环按边界策略钳制。」
 * ⇒ `[start, start+duration)` 归本项；`t === 边界` 归**下一项**（不是上一项）。
 * 这条与旧 `useMaterialAnimation` 的 `while (elapsed >= tickMs)` 行为**不同**：
 * 后者在边界上停在本帧，会让"跳帧定位"与"连续播放到同一时刻"得到不同帧。
 *
 * ### 2. 零/负时长与非法索引在解析期拒绝（#249 §19.3）
 * `parseTextureSequence` 是**解析/校验**，`sampleTextureSequence` 只负责采样规则。
 * 采样器拿到非法序列时也会 `InvalidValue`（纵深防御），但它不承担"帮调用方修数据"的职责。
 *
 * ### 3. `TimeBinding` 默认且必验 `scene`；`runtime` 是显式可选能力（#249 §19.3）
 * 「没有安装该时间源的配置**拒绝绑定**它，不能显示支持却默默按场景时间播放。」
 * ⇒ `resolveTimeBinding(binding, available)` 对未安装的 `clock` 返回 `UnsupportedOperation`，
 * **绝不**静默回落到 `scene`。
 *
 * ### 4. 相位是**求值参数**，不复制资源（#249 §19.3 + A28）
 * 「同一材质实例默认同相位。对象级常量相位覆盖是求值/实例参数，**不复制图像资源**。」
 * ⇒ `TextureInstanceBinding` 只带 `phaseOffset`/`phaseScale`；资源身份由 `ResourceRef`
 * 承载（稳定 ID + 内容版本），URL 只是获取位置，**不作**缓存键（§19.3 + A28 负对照）。
 *
 * ## 与呈现的分工（#249 §19.3 末段）
 * 「颜色/透明度混合语义进入**呈现契约**」。本模块只产出 `{frame, nextFrame, mix}`，
 * 不定义混合公式、不碰 GPU —— 呈现由 P5 消费。
 */

import { invalidValue, unsupportedOperation, type Result, ok, err } from './errors'
import { rational, rationalToNumber, type Rational } from './animation'

// ─────────────────────────────────────────────────────────────────────────────
// 资源身份（URL 仅为获取位置）
// ─────────────────────────────────────────────────────────────────────────────

export type AssetId = string

/**
 * 资源引用（#249 §19.3）。
 *
 * 「资源引用包含稳定资源 ID 和内容版本/哈希，**URL 仅为获取位置**。」
 *
 * ⇒ 缓存键必须由 `(assetId, contentVersion)` 组成。`url` 参与任何身份判定都会让
 * "同一份内容换了个 URL"被当成新资源、或者"同一 URL 内容换了"被当成旧资源重放
 * —— 后者正是 A28 负对照「按 URL 而不按内容版本缓存」要判红的形态。
 */
export interface ResourceRef {
  readonly assetId: AssetId
  /** 内容版本/哈希。内容变了它必变（构建期保证）。 */
  readonly contentVersion: string
  /** 获取位置。**仅**用于取回，不参与身份。 */
  readonly url: string
}

/** 资源状态：五态互不兼表（#249 §19.3 + A36 负对照「`null` 同时代表加载中/缺失/失败」）。 */
export type ResourceState =
  | { readonly kind: 'unrequested' }
  | { readonly kind: 'loading'; readonly requested: ResourceRef }
  | { readonly kind: 'available'; readonly resolved: ResourceRef }
  | { readonly kind: 'missing'; readonly requested: ResourceRef }
  | { readonly kind: 'failed'; readonly requested: ResourceRef; readonly code: string }

/**
 * 缓存身份键。
 *
 * 为什么是"内容版本"而不是 URL：见 `ResourceRef` 注释。把 URL 拼进来会让
 * "按 URL 缓存"通过一条**看起来也在用内容版本**的路径悄悄复活（键里既有 URL 又有版本，
 * 于是同内容不同 URL 全部 miss，但**同 URL 不同内容**也可能因为别的原因命中）。
 * 因此这里**只**用 `(assetId, contentVersion)`，`url` 完全不出现。
 */
export function resourceCacheKey(ref: ResourceRef): string {
  return `${ref.assetId}\u0000${ref.contentVersion}`
}

/** 两个资源引用是否指同一份内容（忽略 URL）。 */
export function sameResourceContent(a: ResourceRef, b: ResourceRef): boolean {
  return a.assetId === b.assetId && a.contentVersion === b.contentVersion
}

// ─────────────────────────────────────────────────────────────────────────────
// 纹理序列
// ─────────────────────────────────────────────────────────────────────────────

/** 一帧在序列里的持续时间（正有理秒）。 */
export interface SequenceFrame {
  /** 帧索引（指向资源内的帧区域/帧条位置）。 */
  readonly index: number
  /** 本帧正时长（秒）。解析期保证 `> 0`。 */
  readonly duration: Rational
}

/**
 * 循环方式。
 *
 * - `loop`：末尾回到起点（#249 §19.3）；
 * - `clamp`：非循环，边界按策略钳制（停在首/末帧）；
 * - `once`：与 `clamp` 的区别在于**语义声明**（一次性播放），采样结果相同但
 *   调用方（呈现/导出）据此决定是否报告"已播完"。保留两者是因为 #249 §19.3
 *   把"循环方式"与"非循环按边界策略钳制"分成两条要求，合并会让前者无法被断言。
 */
export type LoopMode = 'loop' | 'clamp' | 'once'

/**
 * 纹理序列（#249 §19.3「保存资源引用、帧区域/索引、有序播放列表、每项正时长、
 * 循环方式和是否允许帧混合」）。
 *
 * `frameBlendAllowed` 是**声明**：为 `false` 时 `sampleTextureSequence` 的 `mix` 恒为 0。
 * 缺省（`undefined`）同样视为不允许 —— 「无混合声明则 mix 恒 0」（A27 负对照
 * 「默认淡入淡出」的判定点）。
 */
export interface TextureSequence {
  readonly id: string
  readonly resource: ResourceRef
  /** 有序播放列表（顺序即播放顺序，"第 i 项"由本数组定义，不由索引排序定义）。 */
  readonly frames: readonly SequenceFrame[]
  readonly loop: LoopMode
  readonly frameBlendAllowed?: boolean
}

/** 序列声明中的原始帧（解析输入形态；时长以秒为数值，便于从 mcmeta tick 换算）。 */
export interface RawSequenceFrame {
  readonly index: number
  /** 本帧时长（秒）。`undefined` = 用 `defaultDuration`。 */
  readonly durationSeconds?: number
}

export interface RawTextureSequence {
  readonly id: string
  readonly resource: ResourceRef
  readonly frames: readonly RawSequenceFrame[]
  readonly defaultDurationSeconds: number
  readonly loop: LoopMode
  readonly frameBlendAllowed?: boolean
}

/**
 * 解析/校验序列（#249 §19.3：「零/负时长及非法索引在解析/校验时拒绝」）。
 *
 * 三条拒绝（每条都有对应负对照）：
 *  1. `frames` 为空 ⇒ 拒绝（空列表没有"下一项"可言，采样会变成未定义行为）；
 *  2. 任一时长 `<= 0` 或非有限 ⇒ 拒绝（**不**用"默认 1ms"顶替 —— 那会让
 *     一份坏数据在播放时表现为"跑得飞快"而不是报错）；
 *  3. 索引非整数/为负 ⇒ 拒绝。
 *
 * 为什么拒绝而不是夹取：`#249` §7「非法组合产生可诊断求值失败，不悄悄夹取」。
 * 旧 `textureStripAnimation.resolveAnimationTimeline` 对帧索引做 `((i % n) + n) % n`
 * 静默取模 —— 那是适配器**可以**做的归一化（它确实在解释外部格式），但核心序列
 * 一旦接受非法索引，呈现就无法区分"用户声明了第 -1 帧"与"用户没写清楚"。
 */
export function parseTextureSequence(raw: RawTextureSequence): Result<TextureSequence> {
  if (raw.frames.length === 0) {
    return err(invalidValue({ reason: 'textureSequenceEmpty', sequence: raw.id }))
  }
  if (!Number.isFinite(raw.defaultDurationSeconds) || raw.defaultDurationSeconds <= 0) {
    return err(
      invalidValue({
        reason: 'textureSequenceNonPositiveDefaultDuration',
        sequence: raw.id,
        duration: String(raw.defaultDurationSeconds),
      }),
    )
  }
  const frames: SequenceFrame[] = []
  for (let i = 0; i < raw.frames.length; i++) {
    const f = raw.frames[i]
    const seconds = f.durationSeconds ?? raw.defaultDurationSeconds
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return err(
        invalidValue({
          reason: 'textureSequenceNonPositiveDuration',
          sequence: raw.id,
          slot: i,
          duration: String(seconds),
        }),
      )
    }
    if (!Number.isInteger(f.index) || f.index < 0) {
      return err(
        invalidValue({ reason: 'textureSequenceIllegalFrameIndex', sequence: raw.id, slot: i, index: String(f.index) }),
      )
    }
    // 时长换算为有理秒：毫秒输入（如 50ms = 1 tick）→ 1/20 s 这类值用整数比表示更精确。
    frames.push(Object.freeze({ index: f.index, duration: secondsToRational(seconds) }))
  }
  return ok(
    Object.freeze({
      id: raw.id,
      resource: raw.resource,
      frames: Object.freeze(frames),
      loop: raw.loop,
      ...(raw.frameBlendAllowed === undefined ? {} : { frameBlendAllowed: raw.frameBlendAllowed }),
    }),
  )
}

/** 秒 → 有理数（最多 1e-6 秒精度；超出精度的输入在判定上不产生差异）。 */
function secondsToRational(seconds: number): Rational {
  if (Number.isInteger(seconds)) return rational(seconds, 1)
  return rational(Math.round(seconds * 1e6), 1e6)
}

/** 序列总时长（有理数精确累加）。 */
export function sequenceDuration(seq: TextureSequence): Rational {
  let acc = rational(0, 1)
  for (const f of seq.frames) {
    acc = rational(acc.num * f.duration.den + f.duration.num * acc.den, acc.den * f.duration.den)
  }
  return acc
}

/**
 * 纹理样本（#249 §19.3 逐字）。
 *
 * `mix` **无帧混合时恒为 0**。注意 `nextFrame` 在无混合时仍如实给出"下一项"——
 * 它是诊断与呈现可用的信息，不是"正在混合"的暗示。判定"是否混合"看 `mix`。
 */
export interface TextureSample {
  readonly frame: number
  readonly nextFrame: number
  readonly mix: number
}

/**
 * 纯采样（#249 §19.3 的冻结签名落地）。
 *
 * 规则（逐条可测，对应验收 A27）：
 *  1. **半开区间**：`[start, start+duration)` 归本项；`t` 恰在边界 ⇒ **下一项**；
 *  2. **循环**：`loop` 时按总时长取模（末尾回起点）；
 *  3. **负时间**：定义明确取模 —— 用 `((t % T) + T) % T` 的**有理数**版本，
 *     故 `t = -1s` 与 `t = T-1s` 等价（同一帧），不产生负索引；
 *  4. **非循环**（`clamp`/`once`）：早于 0 取首项、晚于总时长取末项（钳制，不外推）；
 *  5. **无混合声明**：`mix` 恒 0，且不产生两帧权重。
 */
export function sampleTextureSequence(
  sequence: TextureSequence,
  time: number,
): Result<TextureSample> {
  const frames = sequence.frames
  if (frames.length === 0) {
    return err(invalidValue({ reason: 'textureSequenceEmpty', sequence: sequence.id }))
  }
  if (!Number.isFinite(time)) {
    return err(invalidValue({ reason: 'textureSampleTimeNotFinite', sequence: sequence.id, time: String(time) }))
  }

  const total = sequenceDuration(sequence)
  if (total.num <= 0) {
    return err(invalidValue({ reason: 'textureSequenceZeroTotalDuration', sequence: sequence.id }))
  }

  // ── 归一化到 [0, total) 或钳制（用有理数比较，避免浮点边界抖动）──
  const tMs = Math.round(time * 1e6)
  const totalMs = Math.round(rationalToNumber(total) * 1e6)
  let t = tMs
  if (t < 0) {
    if (sequence.loop === 'loop') {
      // 负数取模：`-1ms % 1000ms` 在 JS 里是 -1，需显式回正。
      t = ((tMs % totalMs) + totalMs) % totalMs
    } else {
      t = 0
    }
  } else if (t >= totalMs) {
    if (sequence.loop === 'loop') {
      t = tMs % totalMs
    } else {
      // 非循环：钳到末项（返回末项自身，nextFrame 也是末项 —— 没有"下一项"）。
      const last = frames[frames.length - 1]
      return ok(Object.freeze({ frame: last.index, nextFrame: last.index, mix: 0 }))
    }
  }

  // ── 定位项目：[start, start+duration) ──
  let start = 0
  for (let i = 0; i < frames.length; i++) {
    const durMs = Math.round(rationalToNumber(frames[i].duration) * 1e6)
    const end = start + durMs
    if (t < end) {
      const nextIndex = (i + 1) % frames.length
      const blend = sequence.frameBlendAllowed === true
      if (!blend) {
        return ok(Object.freeze({ frame: frames[i].index, nextFrame: frames[nextIndex].index, mix: 0 }))
      }
      // 允许混合：权重是**本项内进度**。注意最后一项在 loop 下混合到首项，
      // 在 clamp/once 下"下一项"没有实际含义 ⇒ 不混合（mix 0），避免把末帧淡到首帧。
      const isLast = i === frames.length - 1
      if (isLast && sequence.loop !== 'loop') {
        return ok(Object.freeze({ frame: frames[i].index, nextFrame: frames[i].index, mix: 0 }))
      }
      const fraction = durMs === 0 ? 0 : (t - start) / durMs
      return ok(
        Object.freeze({
          frame: frames[i].index,
          nextFrame: frames[nextIndex].index,
          mix: fraction,
        }),
      )
    }
    start = end
  }

  // 理论不可达（t < total 且区间完整覆盖 [0,total)）；如到达则显式失败而非猜。
  return err(invalidValue({ reason: 'textureSequenceIntervalNotCovered', sequence: sequence.id, time: String(time) }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 统一时间绑定（#249 §19.3）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 时间源标识。
 *
 * `scene` = 场景时间（**默认且必验**）；`runtime` 是显式可选能力，由运行体系注入逻辑时钟。
 */
export type ClockId = string

/**
 * 时间绑定（#249 §19.3 逐字形态）。
 *
 * 「有效时间由**时间源、常量速度和偏移**构成」——`scale` 是常量速度，`offset` 是常量相位。
 * 二者都是**求值参数**，不复制资源（A28）。
 */
export type TimeBinding =
  | { readonly source: 'scene'; readonly scale: number; readonly offset: number }
  | { readonly source: 'runtime'; readonly clock: ClockId; readonly scale: number; readonly offset: number }

/** 已安装的能力（由装配层提供；P4 只读它，不自己探测环境）。 */
export interface AvailableTimeSources {
  /** 是否安装运行时间源（未安装 ⇒ 拒绝绑定 `runtime`）。 */
  readonly runtimeClocks: readonly ClockId[]
}

export const SCENE_TIME_ONLY: AvailableTimeSources = Object.freeze({ runtimeClocks: Object.freeze([]) as readonly ClockId[] })

/** 默认绑定：场景时间、常量速度 1、无偏移（#249 §19.3「本次默认且必验的是 scene 绑定」）。 */
export const DEFAULT_TIME_BINDING: TimeBinding = Object.freeze({ source: 'scene', scale: 1, offset: 0 })

/**
 * 校验时间绑定（**拒绝**未安装的时间源，不静默回落）。
 *
 * A27/A28 的判定点：「runtime 为显式可选能力，未安装该时间源的配置**拒绝绑定**它，
 * 不能显示支持却默默按场景时间播放」。
 * ⇒ 这里返回 `UnsupportedOperation` 而不是"降级成 scene"。
 */
export function resolveTimeBinding(
  binding: TimeBinding,
  available: AvailableTimeSources = SCENE_TIME_ONLY,
): Result<TimeBinding> {
  if (!Number.isFinite(binding.scale) || !Number.isFinite(binding.offset)) {
    return err(invalidValue({ reason: 'timeBindingNotFinite', source: binding.source }))
  }
  if (binding.source === 'runtime') {
    if (!available.runtimeClocks.includes(binding.clock)) {
      return err(
        unsupportedOperation({
          reason: 'runtimeClockNotInstalled',
          clock: binding.clock,
          binding: 'runtime',
        }),
      )
    }
  }
  return ok(binding)
}

/**
 * 由绑定算出**有效时间**（求值参数层，不涉及资源）。
 *
 * 「不同相位不应错误共享最终采样结果缓存」（#249 §19.3）⇒ 有效时间必须把
 * `scale`/`offset` 算进去，使缓存键（`EvaluationKey.time`）随之不同。
 */
export function effectiveTime(seconds: number, binding: TimeBinding): number {
  return seconds * binding.scale + binding.offset
}

/**
 * 对象级实例绑定（#249 §19.3 + A28）。
 *
 * 「同一材质实例默认同相位。对象级**常量相位覆盖**是求值/实例参数，**不复制图像资源**。」
 * ⇒ 本类型**只**含相位参数，**没有**资源字段 —— 想复制资源在这里无处可写。
 * 这是 A28 负对照「每对象复制图像」在类型层面的排除。
 */
export interface TextureInstanceBinding {
  /** 实例自身的相位偏移（秒）。 */
  readonly phaseOffset: number
  /** 实例自身的相位速度倍率（常量）。 */
  readonly phaseScale: number
}

export const DEFAULT_INSTANCE_BINDING: TextureInstanceBinding = Object.freeze({ phaseOffset: 0, phaseScale: 1 })

/**
 * 实例样本：把实例相位叠加到序列时间上再采样。
 *
 * 关键性质（A28 可断言）：**同一序列 + 同一时间 + 不同实例相位 ⇒ 不同样本，
 * 但资源引用完全相同**。函数签名里没有"资源"出口，资源只从 `sequence.resource` 读。
 */
export function sampleTextureInstance(
  sequence: TextureSequence,
  instance: TextureInstanceBinding,
  baseSeconds: number,
): Result<TextureSample> {
  return sampleTextureSequence(sequence, baseSeconds * instance.phaseScale + instance.phaseOffset)
}

/**
 * 帧混合许可（判定"A27 无混合声明则权重为 0"的显式入口）。
 *
 * 单独一个函数而不是直接读字段，是为了让"许可"这个词有一处落点：
 * 显示侧（P5）应问本函数，而不是各自解释 `frameBlendAllowed === true` 的缺省含义。
 */
export function frameBlendAllowed(seq: TextureSequence): boolean {
  return seq.frameBlendAllowed === true
}

// ─────────────────────────────────────────────────────────────────────────────
// 帧条（texture strip）的**统一离散阶跃采样**（P10：#249 §7「通道动画复用通用
// 属性、轨道和采样策略（离散值阶跃），不另建专用播放循环」）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一帧在帧条里的**停留时长**（毫秒）。
 *
 * 与 {@link SequenceFrame.duration} 的关系：后者是**有理秒**（精确判定用），
 * 前者是渲染侧帧条换算用的毫秒整数。两者由 {@link frameDurationsMs} 从**同一个**
 * 输入派生，故不会各自解释同一份 mcmeta。
 */
export interface StripTimeline {
  /** 每个播放项的帧下标（指向纹理竖条内的位置）。 */
  readonly frameIndices: readonly number[]
  /** 与 `frameIndices` 一一对应的停留毫秒（恒 `> 0`）。 */
  readonly durationMs: readonly number[]
}

/**
 * 帧条的**离散阶跃**时间轴。
 *
 * ## 为什么需要它（以及它替代了什么）
 *
 * 旧机制（`render/materials/simpleMaterialLibrary.ts` 的 `applyAnimatedStrip`）
 * 自持一个 `accMs` 累加器：每帧 `accMs += dtMs`，再用
 * `while (accMs >= dur)` 消费整段时长并前推 `frameSeq`。那是 #249 §7 与 §19.3
 * 明令禁止的"材质/视口自行累计 tick"——它的两个可观测后果：
 *  - **跳帧不一致**：同一时刻，"连续播放到 t" 与 "直接定位到 t" 会因累加器
 *    在边界上的不同历史而给出不同帧（旧实现的 `while` 在边界上停在本帧）；
 *  - **无时间权威**：时间不在 `EditContext` 上，故两个 Area 各播各的。
 *
 * 本函数把"帧条"表达成**通用离散阶跃采样**的输入（`frameIndices` + `durationMs`），
 * 于是渲染侧可以直接用 {@link sampleStripFrameAt} —— 时间进、帧下标出，
 * **没有累加器、没有循环句柄**，且与 `domain/animation#sampleTrack` 的 `step`
 * 策略同一语义（半开区间、边界取下一项）。
 *
 * ## 边界语义（与 `sampleTextureSequence` 一致，逐条可测）
 *
 *  - **半开区间**：`[start, start+duration)` 归本项；`t` 恰在边界 ⇒ **下一项**；
 *  - **循环**：按总时长取模（末尾回起点）；
 *  - **负时间**：`((t % T) + T) % T`，与 `t = T-1` 等价；
 *  - **非循环**：早于 0 取首项、晚于总时长取末项（钳制，不外推）。
 */
export function sampleStripFrameAt(timeline: StripTimeline, timeMs: number): number {
  const n = timeline.frameIndices.length
  if (n === 0) return 0
  const total = totalDurationMs(timeline)
  if (total <= 0) return timeline.frameIndices[0] ?? 0

  let t = Number.isFinite(timeMs) ? Math.floor(timeMs) : 0
  // 取模回正（负数取模在 JS 里保持符号，必须显式回正 —— 与 `sampleTextureSequence` 同法）。
  t = ((t % total) + total) % total

  let start = 0
  for (let i = 0; i < n; i++) {
    const end = start + timeline.durationMs[i]!
    if (t < end) return timeline.frameIndices[i] ?? 0
    start = end
  }
  // 理论不可达（t < total 且区间完整覆盖 [0,total)）；到达则取末项而不是猜。
  return timeline.frameIndices[n - 1] ?? 0
}

/** 帧条总时长（毫秒）。 */
export function totalDurationMs(timeline: StripTimeline): number {
  let acc = 0
  for (const d of timeline.durationMs) acc += d
  return acc
}

/**
 * **世界帧轴**的缺省帧时长（毫秒）：非法/缺省时长回落值。
 *
 * ⚠️ 它**只服务"帧为主"文档的世界帧轴**（M5-1 之后多方块不再提供帧轴）。
 * **纹理序列不得复用它**：纹理的 tick 缺省恒为 1 tick = 50 ms
 * （`domain/textureAnimation#TEXTURE_TICK_MS`）。两个数字**故意不同** ——
 * 1 ms 与 50 ms 是两条不同的时间轴，判据里同时钉住（防止下一个人把它们"统一"回去）。
 */
export const WORLD_FRAME_AXIS_FALLBACK_MS = 1

/**
 * 由 mcmeta 形态的**原始**帧时长构造时间轴（毫秒整数，`<= 0` 回落到
 * {@link WORLD_FRAME_AXIS_FALLBACK_MS}）。
 *
 * ## 为什么非法时长在这里**回落**而不是拒绝（与 `parseTextureSequence` 的分工）
 *
 * `parseTextureSequence` 是**核心序列**的解析：它面对的是"用户声明的序列"，
 * 非法时长必须显式拒绝（#249 §19.3「零/负时长及非法索引在解析/校验时拒绝」）。
 *
 * 本函数面对的是**外部格式（mcmeta）的解释**：mcmeta 允许省略时长
 * （用 `defaultFrametimeTicks`）、也允许写出 `0`（Minecraft 自身把它当 1 tick）。
 * 那是**适配器可以做的归一化** —— 与 `domain/materials` 文件头里
 * "适配器可以做的归一化"同一口径。故这里回落成 `WORLD_FRAME_AXIS_FALLBACK_MS`（1 毫秒），
 * **不**把外部格式的宽松解释升级成核心的拒绝。
 */
export function stripTimeline(
  frameIndices: readonly number[],
  durationMs: readonly number[],
): StripTimeline {
  const durations: number[] = []
  for (let i = 0; i < frameIndices.length; i++) {
    const raw = durationMs[i]
    durations.push(
      typeof raw === 'number' && Number.isFinite(raw) && raw > 0
        ? Math.floor(raw)
        : WORLD_FRAME_AXIS_FALLBACK_MS,
    )
  }
  return Object.freeze({ frameIndices: Object.freeze([...frameIndices]), durationMs: Object.freeze(durations) })
}

// ─────────────────────────────────────────────────────────────────────────────
// 序列循环计划（GIF 导出的**唯一**时间权威；M5-4）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一条动画帧条的**声明**（已由适配器归一：毫秒整数、恒 `> 0`）。
 *
 * 单位链只有一条，任何一环都不得各自换算：
 * `mcmeta tick × 50ms`（`render/assets/textureStripAnimation#resolveAnimationTimeline`）
 * → **毫秒整数**（`StripTimeline.durationMs`）→ 本文件的 `durationsMs`
 * → {@link SequenceLoopPlan.delayCs}（GIF 的厘秒）。
 */
export interface LoopStrip {
  /** 稳定标识（materialId），用于确定性排序与诊断。 */
  readonly id: string
  readonly frameCount: number
  readonly durationsMs: readonly number[]
}

/**
 * 一个**共同循环**的逐帧采样计划。
 *
 * `atMs[i]` 是第 i 帧的**起始时刻**；`delayCs[i]` 是它在 GIF 里的停留
 * （厘秒，恒 `>= 1`）。两者一一对应，且 `Σ delayCs === Math.round(totalMs/10)`
 * —— "GIF 总时长 == 声明总时长"因此是可断言的**整数事实**，不是浮点近似。
 */
export interface SequenceLoopPlan {
  readonly frameCount: number
  /** 一个循环的总时长（毫秒，整数）。 */
  readonly totalMs: number
  /** 采样点（毫秒，严格升序，全部 `< totalMs`）。 */
  readonly atMs: readonly number[]
  /** 与 atMs 一一对应的 GIF 停留（厘秒；恒 `>= 1`；Σ = round(totalMs/10)）。 */
  readonly delayCs: readonly number[]
}

/** 场景 GIF 的硬上限（超限**显式失败**，不截断、不抽帧 —— 截断会让"循环"不闭合）。 */
export const LOOP_LIMITS = Object.freeze({ maxFrames: 240, maxTotalMs: 30_000 })

function gcdInt(a: number, b: number): number {
  let x = a
  let y = b
  while (y !== 0) {
    const t = x % y
    x = y
    y = t
  }
  return x
}

function lcmInt(a: number, b: number): number {
  return (a / gcdInt(a, b)) * b
}

/**
 * 把多条动画帧条排成**一个共同循环**的逐帧时间计划。
 *
 * ## 为什么是 LCM 而不是"取最长的一条"
 *
 * 多条动画长度不成倍数时，"最长那条的一个循环"结束时其它序列**不在相位 0**
 * ⇒ 产物自称"循环"但接缝可见。LCM 是"所有序列同时回到相位 0"的最小长度；
 * 单序列时二者等价。代价是上限写死并**显式失败**（`textureLoopTooLong`）。
 *
 * ## 边界必须包含**每个序列的每一次重启**
 *
 * 只取"一个周期内的帧边界"在单序列时正确，多序列时会漏掉短序列在共同循环内的
 * 重启点（例：序列 A 周期 100ms、B 周期 150ms、L=300ms ⇒ A 在 100/200 也重启）。
 * 漏掉它们会让 GIF 在 A 的一个循环里显示同一帧 —— 画面不动而计划"成功"。
 * 故本函数按 `base = 0, T, 2T, … < L` 展开每条序列的周期边界。
 *
 * ## 时长分配（最大余数法 + 最小 1 厘秒）
 *
 * 先取 `max(1, floor(holdMs/10))`，再把差额按小数余数从大到小分配（余数相同按
 * 下标升序），最后逐项校准到 `Σ == Math.round(totalMs/10)`。
 *
 * ## 显式失败面
 *
 * - 空表 ⇒ `InvalidValue`（不产出 1 帧假 GIF）；
 * - 帧数/时长声明不合法 ⇒ `InvalidValue`；
 * - 超过 {@link LOOP_LIMITS} ⇒ `UnsupportedOperation#textureLoopTooLong`；
 * - 总长短于"每帧至少 1 厘秒"的物理下限（`totalMs/10 < frameCount`）⇒
 *   `UnsupportedOperation#textureLoopTooShort`（不把 GIF 的 1 厘秒地板伪装成
 *   "总时长与声明一致"）。
 */
export function planSequenceLoop(
  strips: readonly LoopStrip[],
  limits: { readonly maxFrames: number; readonly maxTotalMs: number } = LOOP_LIMITS,
): Result<SequenceLoopPlan> {
  if (!Array.isArray(strips) || strips.length === 0) {
    return err(invalidValue({ reason: 'noAnimatedSequences' }))
  }

  const totals: number[] = []
  const cycleBoundaries: number[][] = []
  let upperBoundFrames = 0
  for (const strip of strips) {
    const durations = strip.durationsMs
    if (!Array.isArray(durations) || !Number.isInteger(strip.frameCount) || strip.frameCount < 1
      || durations.length !== strip.frameCount) {
      return err(invalidValue({
        reason: 'invalidStripDurations',
        id: strip.id,
        frameCount: Number.isFinite(strip.frameCount) ? strip.frameCount : 0,
        durations: Array.isArray(durations) ? durations.length : 0,
      }))
    }
    const bounds: number[] = []
    let total = 0
    for (let i = 0; i < durations.length; i++) {
      const d = durations[i]
      if (typeof d !== 'number' || !Number.isInteger(d) || d <= 0) {
        return err(invalidValue({
          property: 'durationsMs',
          reason: 'nonPositiveDuration',
          id: strip.id,
          index: i,
          value: typeof d === 'number' && Number.isFinite(d) ? d : String(d),
        }))
      }
      bounds.push(total)
      total += d
    }
    if (total <= 0) {
      return err(invalidValue({ reason: 'emptyStrip', id: strip.id }))
    }
    totals.push(total)
    cycleBoundaries.push(bounds)
    upperBoundFrames += bounds.length
  }

  let totalMs = 1
  for (const t of totals) totalMs = lcmInt(totalMs, t)
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    return err(invalidValue({ reason: 'loopLengthOverflow' }))
  }
  if (totalMs > limits.maxTotalMs) {
    return err(unsupportedOperation({
      reason: 'textureLoopTooLong',
      frames: upperBoundFrames,
      totalMs,
      maxFrames: limits.maxFrames,
      maxTotalMs: limits.maxTotalMs,
    }))
  }

  const boundarySet = new Set<number>()
  for (let s = 0; s < strips.length; s++) {
    const period = totals[s]!
    const bounds = cycleBoundaries[s]!
    for (let base = 0; base < totalMs; base += period) {
      for (const b of bounds) boundarySet.add((base + b) % totalMs)
    }
  }
  const boundaries = [...boundarySet].sort((a, b) => a - b)
  if (boundaries.length === 0) {
    return err(invalidValue({ reason: 'emptyLoop' }))
  }
  if (boundaries.length > limits.maxFrames) {
    return err(unsupportedOperation({
      reason: 'textureLoopTooLong',
      frames: boundaries.length,
      totalMs,
      maxFrames: limits.maxFrames,
      maxTotalMs: limits.maxTotalMs,
    }))
  }

  const targetSum = Math.round(totalMs / 10)
  if (targetSum < boundaries.length) {
    return err(unsupportedOperation({
      reason: 'textureLoopTooShort',
      frames: boundaries.length,
      totalMs,
      maxTotalMs: limits.maxTotalMs,
    }))
  }

  const holdMs = boundaries.map((b, i) => (i + 1 < boundaries.length ? boundaries[i + 1]! : totalMs) - b)
  const quotas = holdMs.map((h) => h / 10)
  const delayCs = quotas.map((q) => Math.max(1, Math.floor(q)))
  let sum = delayCs.reduce((a, b) => a + b, 0)

  if (sum < targetSum) {
    const order = quotas
      .map((q, i) => ({ i, frac: q - Math.floor(q) }))
      .sort((a, b) => (b.frac - a.frac) || (a.i - b.i))
    let k = 0
    while (sum < targetSum && k < order.length) {
      const at = order[k]!.i
      delayCs[at] = delayCs[at]! + 1
      sum += 1
      k += 1
    }
  } else if (sum > targetSum) {
    const order = quotas
      .map((q, i) => ({ i, frac: q - Math.floor(q), reducible: delayCs[i]! > 1 }))
      .filter((x) => x.reducible)
      .sort((a, b) => (a.frac - b.frac) || (a.i - b.i))
    let k = 0
    while (sum > targetSum && order.length > 0 && k < order.length * 2) {
      const at = order[k % order.length]!.i
      if (delayCs[at]! > 1) {
        delayCs[at] = delayCs[at]! - 1
        sum -= 1
      }
      k += 1
    }
  }

  if (sum !== targetSum) {
    return err(invalidValue({ reason: 'delaySumMismatch', expected: targetSum, actual: sum }))
  }

  return ok(Object.freeze({
    frameCount: boundaries.length,
    totalMs,
    atMs: Object.freeze(boundaries),
    delayCs: Object.freeze(delayCs),
  }))
}


