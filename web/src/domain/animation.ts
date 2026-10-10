/**
 * `domain/animation` —— **时间、轨道、采样与插值、有效值优先级**（#249 §3.3 §7；契约 §4 §5.2）。
 *
 * ## 本模块替代的旧机制（B5 退役矩阵 #8 / #11 / #6 的业务面）
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | 帧序列兼任动画、专用轮播 | `runtime/main.ts` 的 `framesPlaybackIsPlaying` / `currentFrameIndex` | 通用轨道：任何可寻址属性都能被轨道驱动，**没有**"帧专用播放调度器"（#8） |
 * | 材质/视口各自 tick 累积纹理时间 | `shared/viewport/useMultiblockChannels.ts` 每视口 `revision`；`useMaterialAnimation.ts` 的 `elapsed += delta` | 时间**只**来自显式传入的 `TimeValue`，采样是纯函数（#11） |
 * | 多 RAF 分别推进业务 | `useMaterialAnimation` 独立 `requestAnimationFrame` | 本模块**没有任何**循环/时钟/句柄；推进由宿主显式驱动（#6） |
 *
 * ## 四条硬要求及其落点
 *
 * ### 1. 「给定时间直接求值，不通过"已经播放过多少次回调"累积内容」（#249 §7）
 * `sampleTrack(track, time)` 是纯函数：同一 `(track, time)` 恒得同一结果。
 * 时间拖动、跳帧、反向定位**共用**它 —— 没有"只能向前"的累积状态，
 * 因此倒退定位与正向播放走的是同一条求值路径（这是 A09 负对照
 * 「每帧 setter 写基础值」在结构上无法表达的形态）。
 *
 * ### 2. 「播放采样率与显示刷新率解耦」（#249 §7）
 * 时间以**有理帧率**（`FrameRate = {num, den}`）+ 帧号表达，秒数 = `frame·den/num`。
 * 显示刷新率（每秒画几次）与采样率（每秒取几个时间点）在类型上就是两个量：
 * 本模块只接受 `TimeValue`，**不接受**"上一帧过了多久"这种累积输入。
 * `Playhead` 的推进经 `advancePlayhead(playhead, elapsedSeconds)` 显式给出经过的
 * **逻辑**秒数 —— 由宿主决定从哪读那个秒数（P4 不读墙钟，见 §2.1「不读全局时钟」）。
 *
 * ### 3. 采样策略由**属性值类型与定义**选择（#249 §7）
 *  - 连续数值 / 向量：按定义允许的插值；
 *  - 旋转：`slerp`（**最短路径**、结果归一化）—— 不把四元数当四个数各自线性插值；
 *  - 枚举 / 布尔 / 离散通道：`step`（阶跃）；
 *  - 受限整数：显式量化策略（`quantize`），量化后**仍**要过合法域校验；
 *  - 非法取值产生**可诊断求值失败**，不静默夹取（`sampleTrack` 返回 `Result`）。
 *
 * ### 4. 多通道耦合对**完整候选参数集**纯校验（#249 §7）
 * `validateParameterSet(constraints, candidate)` 一次看完整集合再判定，
 * 非法组合返回 `InvalidValue`，**不**夹取、不"装作目标已实现"。
 *
 * ## 有效值优先级（#249 §7 逐字落点）
 *
 * `文档基础值/发布默认值 → 编辑上下文手动预览值 → 已启用轨道的时间采样 → 活动编辑操作的暂存覆盖`
 *
 * 后者覆盖前者，但**不反写**前者（#249 §3.3「动画输出覆盖当前求值参数，**不反写**手动取值」）。
 * `resolveEffectiveValue` 只做选择，不写任何一层；`stagingOverride` 属 `EditContext`，
 * 因此"两个视口读同一份"（A05）在本层就成立。
 */

import { invalidValue, type DomainError, type Result, ok, err } from './errors'
import {
  findObject,
  type Quat,
  type Scene,
  type Vec3,
} from './scene'
import { samePropertyRef, type EntityRef, type PropertyRef } from './identity'

// ─────────────────────────────────────────────────────────────────────────────
// 有理数与帧率（#249 §7「以可序列化时间值及有理帧率表达」）
// ─────────────────────────────────────────────────────────────────────────────

/** 有理数。约定 `den > 0`，且已约分（`rational()` 负责）。 */
export interface Rational {
  readonly num: number
  readonly den: number
}

/** 整数最大公约数（纯；用于约分）。 */
function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a))
  let y = Math.abs(Math.trunc(b))
  while (y !== 0) {
    const t = x % y
    x = y
    y = t
  }
  return x === 0 ? 1 : x
}

/**
 * 造一个有理数并约分。
 *
 * 为什么必须约分而不是"直接存两个数"：`sameRational` 与 `compareRational` 若不做
 * 规范化，`2/4` 与 `1/2` 会被判为不同的**采样时间**，于是"同时间同结果"（A09）
 * 依赖调用方碰巧用了同一种写法 —— 那不是一个可断言的性质。
 */
export function rational(num: number, den = 1): Rational {
  if (!Number.isFinite(num) || !Number.isFinite(den)) return Object.freeze({ num: 0, den: 1 })
  if (den === 0) return Object.freeze({ num: 0, den: 1 })
  const sign = den < 0 ? -1 : 1
  const n = Math.trunc(num) * sign
  const d = Math.abs(Math.trunc(den))
  const g = gcd(n, d)
  return Object.freeze({ num: Math.trunc(n / g), den: Math.trunc(d / g) })
}

/** 有理数转数值（**只**用于最终产出数值；判定一律走精确比较）。 */
export function rationalToNumber(r: Rational): number {
  return r.num / r.den
}

export function sameRational(a: Rational, b: Rational): boolean {
  return a.num === b.num && a.den === b.den
}

/** 精确比较两个有理数（交叉相乘，整数域内不丢精度）。 */
export function compareRational(a: Rational, b: Rational): number {
  const left = a.num * b.den
  const right = b.num * a.den
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function subtractRational(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den - b.num * a.den, a.den * b.den)
}

export function multiplyRational(a: Rational, b: Rational): Rational {
  return rational(a.num * b.num, a.den * b.den)
}

/**
 * 有理帧率：`framesPerSecond = num / den`。
 *
 * 为什么不用单个 `number`：29.97 = 30000/1001 这类速率在二进制浮点下不可精确表示，
 * 时间比较与区间判定会随播放时长漂移（"跳帧后结果与连续播放不同"正是它的表现）。
 */
export interface FrameRate {
  readonly num: number
  readonly den: number
}

/**
 * 帧率的可写形态：整数（`20` = 20/1）或显式有理数（`{num:30000, den:1001}`）。
 *
 * 保留整数形态是为了「既有值仍是合法值」：`EditContext.time` 从 P1 起就是
 * `{frame, fps}`，把 `fps` 变成"只能是对象"会逼所有既有消费者改形态，
 * 而它们表达的东西（20 fps）并没有变。**这是 P4 对 GF-3 的确认**（见文件末注释）。
 */
export type FrameRateSpec = number | FrameRate

export const DEFAULT_FRAME_RATE: FrameRate = Object.freeze({ num: 20, den: 1 })

/**
 * 规范化帧率。非法（非有限、非正）返回 `InvalidValue` —— 与 P1
 * `reduceSetTime` 的 `fpsMustBePositive` 拒绝保持同一判据与同一 `reason`。
 */
export function frameRateOf(spec: FrameRateSpec): Result<FrameRate> {
  const raw = typeof spec === 'number' ? { num: spec, den: 1 } : spec
  if (!Number.isFinite(raw.num) || !Number.isFinite(raw.den)) {
    return err(invalidValue({ reason: 'fpsMustBePositive', fps: String(spec) }))
  }
  if (raw.den === 0 || raw.num <= 0 || raw.den < 0) {
    return err(invalidValue({ reason: 'fpsMustBePositive', fps: `${raw.num}/${raw.den}` }))
  }
  const r = rational(raw.num, raw.den)
  if (r.num <= 0) return err(invalidValue({ reason: 'fpsMustBePositive', fps: `${raw.num}/${raw.den}` }))
  return ok(r)
}

/** 秒/帧的数值形态（呈现与统计用；**判定**不得依赖它，见 `compareTime`）。 */
export function framesPerSecond(spec: FrameRateSpec): number {
  const r = frameRateOf(spec)
  return r.ok ? rationalToNumber(r.value) : 0
}

export function sameFrameRate(a: FrameRateSpec, b: FrameRateSpec): boolean {
  const ra = frameRateOf(a)
  const rb = frameRateOf(b)
  if (!ra.ok || !rb.ok) return false
  return sameRational(ra.value, rb.value)
}

// ─────────────────────────────────────────────────────────────────────────────
// 时间值
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 时间值（#249 §7）。**可序列化、无时钟句柄** —— 它不含"现在是几点"的信息，
 * 只有"在哪个帧率下走到第几帧"。谁提供"现在"由宿主决定（§9「时钟以输入注入」）。
 */
export interface TimeValue {
  readonly frame: number
  readonly fps: FrameRateSpec
}

export const TIME_ZERO: TimeValue = Object.freeze({ frame: 0, fps: 20 })

export function timeValue(frame: number, fps: FrameRateSpec = 20): TimeValue {
  return Object.freeze({ frame: Number.isFinite(frame) ? frame : 0, fps })
}

/** 时间 → 秒（有理数，精确）。`frame` 非整数时按 1e-6 精度放缩以保持交叉相乘可用。 */
export function secondsOf(t: TimeValue): Rational {
  const rate = frameRateOf(t.fps)
  const num = rate.ok ? rate.value.num : DEFAULT_FRAME_RATE.num
  const den = rate.ok ? rate.value.den : DEFAULT_FRAME_RATE.den
  const frame = Number.isFinite(t.frame) ? t.frame : 0
  if (Number.isInteger(frame)) return rational(frame * den, num)
  // 亚帧时间（拖动定位的中间态）：放缩到百万分之一帧，避免交叉相乘退化成浮点比较。
  return rational(Math.round(frame * 1e6) * den, num * 1e6)
}

/** 秒 → 时间（有理帧率下构造）。 */
export function timeFromSeconds(seconds: number, fps: FrameRateSpec = 20): TimeValue {
  const rate = frameRateOf(fps)
  const f = rate.ok ? rationalToNumber(rate.value) : 20
  return timeValue(seconds * f, fps)
}

/**
 * 精确比较两个时间。
 *
 * `-1 / 0 / 1`。整数帧一律走交叉相乘（精确）；亚帧值退化为放缩后的整数比较
 * （见 `secondsOf`），仍是纯函数、同输入同输出。
 */
export function compareTime(a: TimeValue, b: TimeValue): number {
  return compareRational(secondsOf(a), secondsOf(b))
}

export function sameTime(a: TimeValue, b: TimeValue): boolean {
  return compareTime(a, b) === 0
}

/** 按秒推进（播放推进的**唯一**入口；增量是显式输入，不读墙钟）。 */
export function advanceTime(t: TimeValue, deltaSeconds: number): TimeValue {
  return timeValue(t.frame + deltaSeconds * framesPerSecond(t.fps), t.fps)
}

/** 取整帧（渲染/呈现取整只发生在边界；求值一律用精确时间）。 */
export function timeAtFrame(t: TimeValue, frame: number): TimeValue {
  return timeValue(frame, t.fps)
}

/** 人类可读时间（诊断用，不参与判定）。 */
export function formatTime(t: TimeValue): string {
  const r = frameRateOf(t.fps)
  const rate = r.ok ? `${r.value.num}/${r.value.den}` : '?'
  return `${t.frame}@${rate}`
}

// ─────────────────────────────────────────────────────────────────────────────
// 播放头（显示刷新率与采样率解耦）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 播放头。
 *
 * **不**持有定时器、请求帧句柄或"上一帧时间"：`advancePlayhead` 接收**经过的逻辑秒数**
 * 并返回新播放头。于是"跳帧""倒退定位""暂停"都是对 `time` 的直接赋值，
 * 与正向播放共用同一条求值路径（#249 §7）。
 *
 * `rate` 是**常量**速度。§19.3 明文：后续若动画化"速度"并希望产生连续累计相位，
 * 必须先定义从固定起点的确定性积分/时间重映射 —— **本批不做**，故这里不接受轨道驱动的速度。
 */
export interface Playhead {
  readonly time: TimeValue
  readonly playing: boolean
  /** 常量播放倍率（1 = 原速）。0 合法（等于暂停但保留 playing 语义）。 */
  readonly rate: number
}

export function createPlayhead(time: TimeValue = TIME_ZERO, playing = false, rate = 1): Playhead {
  return Object.freeze({ time, playing, rate })
}

/**
 * 按经过的**逻辑**秒数推进会。
 *
 * 关键：`deltaSeconds` 由宿主提供（它可以来自任何时钟，**但本层不读**）。
 * 暂停、速率为 0 时时间不变 —— 这正是 A27 要求的"默认暂停随场景"：
 * 没有"独立 tick 累积"，只有调用方显式推进。
 */
export function advancePlayhead(ph: Playhead, deltaSeconds: number): Playhead {
  if (!ph.playing || ph.rate === 0 || !Number.isFinite(deltaSeconds)) return ph
  return createPlayhead(advanceTime(ph.time, deltaSeconds * ph.rate), ph.playing, ph.rate)
}

/** 定位到某时间（跳帧 / 拖动 / 倒退）。**不**改变 playing 与 rate。 */
export function seekPlayhead(ph: Playhead, time: TimeValue): Playhead {
  return createPlayhead(time, ph.playing, ph.rate)
}

export function setPlaying(ph: Playhead, playing: boolean): Playhead {
  return createPlayhead(ph.time, playing, ph.rate)
}

/**
 * 停止播放并**保留当前时间**（#249 §3.3「停止播放保留当前时间」）。
 * 本函数就是那句话的字面实现：只翻 `playing`，不碰 `time`。
 */
export function stopPlayhead(ph: Playhead): Playhead {
  return createPlayhead(ph.time, false, ph.rate)
}

// ─────────────────────────────────────────────────────────────────────────────
// 轨道目标与取值类型
// ─────────────────────────────────────────────────────────────────────────────

/** 轨道能承载的值（与契约 §5.1 `PropertyValueType` 的可动画子集对齐）。 */
export type TrackValue = number | Vec3 | Quat | string | boolean

export type TrackValueType = 'number' | 'vec3' | 'quat' | 'string' | 'boolean' | 'enum' | 'integer'

/**
 * 插值策略。
 *
 * 与 #249 §7 的对应：`step` = 枚举/布尔/离散通道阶跃；`linear` = 连续数值与向量；
 * `slerp` = 旋转（**有明确语义**的旋转插值）；`quantized` = 受限整数（先插值再按
 * `quantization` 显式量化，量化后仍须过合法域校验）。
 */
export type InterpolationKind = 'step' | 'linear' | 'slerp' | 'quantized'

/**
 * 显式量化策略（#249 §7「整数受限通道可显式注册量化策略，不把任意小数写成非法取值」）。
 *
 * `origin` 让"量到 0/5/10…"这类网格可表达；缺省 `origin = 0`。
 */
export type QuantizationPolicy =
  | { readonly kind: 'integer' }
  | { readonly kind: 'step'; readonly step: number; readonly origin?: number }

/** 一条关键帧。`time` 是可序列化时间值（与播放时间同一模型，不另立时间轴）。 */
export interface AnimationKey {
  readonly time: TimeValue
  readonly value: TrackValue
}

/**
 * 一条通用轨道。
 *
 * `target` 是 `PropertyRef` —— 契约 §1.3 的选择理由正是"让向量分量动画与标量动画
 * 共用同一寻址与轨道目标"。故**不**新增 `VectorComponentTrack` 之类旁路：
 * `component` 已经在 `PropertyRef` 里。
 *
 * `enabled === false` ⇒ 该轨道不参与有效值计算，属性回到手动/默认值
 * （#249 §3.3「禁用轨道后回到手动/默认值」）。
 */
export interface AnimationTrack {
  readonly id: string
  readonly target: PropertyRef
  readonly valueType: TrackValueType
  readonly interpolation: InterpolationKind
  readonly enabled: boolean
  /** 按时间**升序**、时间互不相同（`insertKeyframe` 保证）。 */
  readonly keys: readonly AnimationKey[]
  readonly quantization?: QuantizationPolicy
  /** 枚举/布尔的合法取值（由 RNA 描述提供；缺省表示不做成员校验）。 */
  readonly legalValues?: readonly TrackValue[]
}

/** 属性的规范键（`owner.kind:id` + 属性 + 分量）。轨道查找与驱动判定共用它。 */
export function propertyKey(ref: PropertyRef): string {
  const owner = `${ref.owner.kind}:${ref.owner.id}`
  const comp = ref.component === undefined ? '' : `#${ref.component}`
  const el = ref.element === undefined ? '' : `/${ref.element.elementId}@${ref.element.topologyVersion}`
  return `${owner}\u0000${ref.property}${comp}${el}`
}

/** 轨道键（= 目标属性键）。 */
export function trackKey(track: AnimationTrack): string {
  return propertyKey(track.target)
}

// ─────────────────────────────────────────────────────────────────────────────
// 动画文档状态（归**文档状态域**，#249 §3.4）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 文档的动画状态。
 *
 * 归属（§3.4 所有权表第一行）：`文档内容、对象与数据、**动画**` ⇒ 归文档状态域。
 * 因此轨道进文档内容身份（`domain/document` 的 `withContent`）：
 * 插入关键帧是可撤销的内容变化，而**播放**只改 `EditContext.time`，两者在这里分岔。
 */
export interface AnimationState {
  readonly tracks: readonly AnimationTrack[]
  /**
   * 发布默认值（#249 §3.3「可发布默认值…属文档」）。
   *
   * 键是通道/属性的稳定键（`propertyKey` 或通道 key，由消费者约定同一命名空间）。
   * 它是有效值优先级的**第一层**，与"编辑上下文手动预览值"分开存放 ——
   * 合在一起会让"动画输出不反写手动取值"无法断言。
   */
  readonly publishedDefaults: Readonly<Record<string, TrackValue>>
}

export const EMPTY_ANIMATION: AnimationState = Object.freeze({
  tracks: Object.freeze([]) as readonly AnimationTrack[],
  publishedDefaults: Object.freeze({}),
})

/** 被**已启用**轨道驱动的属性键集合（`application/commands` 的写入拒绝据此判定）。 */
export function animationDrivenKeys(state: AnimationState): ReadonlySet<string> {
  const out = new Set<string>()
  for (const t of state.tracks) {
    if (t.enabled) out.add(trackKey(t))
  }
  return out
}

export function findTrack(state: AnimationState, ref: PropertyRef): AnimationTrack | undefined {
  const key = propertyKey(ref)
  for (const t of state.tracks) {
    if (trackKey(t) === key) return t
  }
  return undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// 采样（纯；给定时间直接求值）
// ─────────────────────────────────────────────────────────────────────────────

export interface SampledTrackValue {
  readonly value: TrackValue
  readonly interpolation: InterpolationKind
  /** 该次采样落在跨越的关键帧区间（诊断/呈现用；边界情形与 `value` 一致）。 */
  readonly fromIndex: number
  readonly toIndex: number
}

/** 采样环境的可选输入（合法域来自 RNA；缺省不做成员校验，但**不**假装已校验）。 */
export interface SampleEnvironment {
  readonly legalValues?: readonly TrackValue[]
}

function isVec3(v: unknown): v is Vec3 {
  return typeof v === 'object' && v !== null && 'x' in v && 'y' in v && 'z' in v && !('w' in v)
}

function isQuat(v: unknown): v is Quat {
  return typeof v === 'object' && v !== null && 'x' in v && 'y' in v && 'z' in v && 'w' in v
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f
}

function lerpVec3(a: Vec3, b: Vec3, f: number): Vec3 {
  return Object.freeze({ x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), z: lerp(a.z, b.z, f) })
}

/**
 * 四元数球面插值（**最短路径**、结果归一化）。
 *
 * #249 §7 明文：「旋转使用有明确语义的旋转插值，**不把四元数当普通四个数**」。
 * 语义要点（三点都可被测试钉住）：
 *  1. `q` 与 `-q` 表示同一旋转 ⇒ 先取最短路径（点积为负则翻转），否则会出现
 *     "从 10° 转到 350° 走了 340°" 这类错误中间态；
 *  2. 结果**归一化** —— 逐分量线性插值得到的是非单位四元数，直接当旋转用会让物体缩放；
 *  3. 两端几乎共线（`sinθ → 0`）时退化为线性插值再归一化，避免除零。
 *
 * 为什么自己写而不 `import { Quaternion } from 'three'`：本层是纯核心，
 * 边界闸门禁止 Three 依赖（#249 §4 规则 1），且 `three` 的 slerp 是原地 mutate
 * （`q.slerp(qb, t)` 改自身），与"纯函数不改输入"直接冲突。
 */
export function slerpQuat(a: Quat, b: Quat, f: number): Quat {
  let bx = b.x
  let by = b.y
  let bz = b.z
  let bw = b.w
  let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw
  if (cos < 0) {
    // 最近路径：另一半球上的同一旋转。
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
    cos = -cos
  }
  if (cos > 0.9995) {
    // 近乎共线：线性插值后归一化（数值稳定，且与 slerp 的一阶展开一致）。
    const x = a.x + (bx - a.x) * f
    const y = a.y + (by - a.y) * f
    const z = a.z + (bz - a.z) * f
    const w = a.w + (bw - a.w) * f
    const len = Math.hypot(x, y, z, w) || 1
    return Object.freeze({ x: x / len, y: y / len, z: z / len, w: w / len })
  }
  const theta = Math.acos(Math.min(1, Math.max(-1, cos)))
  const sinTheta = Math.sin(theta)
  const wa = Math.sin((1 - f) * theta) / sinTheta
  const wb = Math.sin(f * theta) / sinTheta
  return Object.freeze({
    x: a.x * wa + bx * wb,
    y: a.y * wa + by * wb,
    z: a.z * wa + bz * wb,
    w: a.w * wa + bw * wb,
  })
}

/** 按量化策略量化数值。 */
export function quantize(value: number, policy: QuantizationPolicy): number {
  if (policy.kind === 'integer') return Math.round(value)
  const step = Math.abs(policy.step)
  if (!Number.isFinite(step) || step === 0) return value
  const origin = policy.origin ?? 0
  return origin + Math.round((value - origin) / step) * step
}

/** 区间的数值进度 `(t - t0) / (t1 - t0)`（有理数精确计算后一次转数值）。 */
function fractionBetween(t: TimeValue, t0: TimeValue, t1: TimeValue): number {
  const span = subtractRational(secondsOf(t1), secondsOf(t0))
  if (span.num === 0) return 0
  const offset = subtractRational(secondsOf(t), secondsOf(t0))
  return rationalToNumber(rational(offset.num * span.den, offset.den * span.num))
}

/**
 * 在给定时间对该轨道求值（**纯**；#249 §7「给定时间直接求值」）。
 *
 * 语义（逐条可测）：
 *  - 无关键帧 ⇒ `MissingTarget`（不给"默认值冒充成功"，契约 §3.1）；
 *  - 时间早于首帧 ⇒ 首帧值；晚于末帧 ⇒ 末帧值（钳制到定义域，不外推）；
 *  - `step`：取最后一个 `time <= t` 的帧（半开区间：恰在边界取该帧，**不**取下一帧）；
 *  - `linear` / `quantized`：在两帧间插值，`quantized` 再量化；
 *  - `slerp`：仅在 `quat` 上合法，否则 `InvalidValue`；
 *  - 值与 `valueType` 不符 ⇒ `InvalidValue`（**不**静默转换）；
 *  - 枚举/布尔的合法成员校验在 `legalValues` 给出时执行，非法即 `InvalidValue`
 *    —— 这是 A09 负对照「枚举线性插值」的判定点：线性插值会产出成员外的值。
 */
export function sampleTrack(
  track: AnimationTrack,
  time: TimeValue,
  env: SampleEnvironment = {},
): Result<SampledTrackValue> {
  const keys = track.keys
  if (keys.length === 0) {
    return err(
      invalidValue({ reason: 'trackHasNoKeys', track: track.id, property: track.target.property }),
    )
  }
  const legal = env.legalValues ?? track.legalValues

  // ── 边界钳制（非外推） ──
  if (compareTime(time, keys[0].time) <= 0) {
    return finish(track, keys[0].value, 0, 0, legal, 'step')
  }
  const lastIndex = keys.length - 1
  if (compareTime(time, keys[lastIndex].time) >= 0) {
    return finish(track, keys[lastIndex].value, lastIndex, lastIndex, legal, 'step')
  }

  // ── 定位区间：[i, i+1] 满足 keys[i].time <= t < keys[i+1].time ──
  let i = 0
  for (let k = 0; k < lastIndex; k++) {
    if (compareTime(keys[k].time, time) <= 0 && compareTime(time, keys[k + 1].time) < 0) {
      i = k
      break
    }
  }
  const k0 = keys[i]
  const k1 = keys[i + 1]

  if (track.interpolation === 'step') {
    return finish(track, k0.value, i, i, legal, 'step')
  }

  const f = fractionBetween(time, k0.time, k1.time)

  if (track.interpolation === 'slerp') {
    if (!isQuat(k0.value) || !isQuat(k1.value)) {
      return err(
        invalidValue({ reason: 'slerpRequiresQuaternion', track: track.id, valueType: track.valueType }),
      )
    }
    return finish(track, slerpQuat(k0.value, k1.value, f), i, i + 1, legal, 'slerp')
  }

  if (track.interpolation === 'linear' || track.interpolation === 'quantized') {
    if (typeof k0.value === 'number' && typeof k1.value === 'number') {
      const raw = lerp(k0.value, k1.value, f)
      if (track.interpolation === 'quantized') {
        if (!track.quantization) {
          // 没有量化策略却声明 quantized：显式失败，不用"默认取整"顶替。
          return err(invalidValue({ reason: 'quantizationPolicyMissing', track: track.id }))
        }
        return finish(track, quantize(raw, track.quantization), i, i + 1, legal, 'quantized')
      }
      return finish(track, raw, i, i + 1, legal, 'linear')
    }
    if (isVec3(k0.value) && isVec3(k1.value)) {
      return finish(track, lerpVec3(k0.value, k1.value, f), i, i + 1, legal, 'linear')
    }
    // 其余形态（枚举/布尔/字符串）**不**做线性插值：那会产出定义域外的值。
    // 这正是 A09 负对照「枚举线性插值」要判红的形态。
    return err(
      invalidValue({
        reason: 'linearInterpolationUnsupportedForValueType',
        track: track.id,
        valueType: track.valueType,
      }),
    )
  }

  return err(invalidValue({ reason: 'unknownInterpolation', track: track.id, interpolation: String(track.interpolation) }))
}

/** 采样收尾：类型与合法域校验（校验失败**不**产出值）。 */
function finish(
  track: AnimationTrack,
  value: TrackValue,
  fromIndex: number,
  toIndex: number,
  legal: readonly TrackValue[] | undefined,
  interpolation: InterpolationKind,
): Result<SampledTrackValue> {
  const typeError = checkValueType(track.valueType, value)
  if (typeError) return err(typeError)
  if (legal && legal.length > 0 && !legal.some((v) => sameTrackValue(v, value))) {
    return err(
      invalidValue({
        reason: 'valueOutsideLegalDomain',
        track: track.id,
        property: track.target.property,
        value: typeof value === 'object' ? 'structured' : String(value),
      }),
    )
  }
  return ok(Object.freeze({ value, interpolation, fromIndex, toIndex }))
}

/** 值与声明类型是否相容。 */
export function checkValueType(type: TrackValueType, value: TrackValue): DomainError | null {
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : invalidValue({ reason: 'valueTypeMismatch', expected: 'number' })
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
        ? null
        : invalidValue({ reason: 'valueTypeMismatch', expected: 'integer' })
    case 'vec3':
      return isVec3(value) ? null : invalidValue({ reason: 'valueTypeMismatch', expected: 'vec3' })
    case 'quat':
      return isQuat(value) ? null : invalidValue({ reason: 'valueTypeMismatch', expected: 'quat' })
    case 'string':
      return typeof value === 'string' ? null : invalidValue({ reason: 'valueTypeMismatch', expected: 'string' })
    case 'boolean':
      return typeof value === 'boolean' ? null : invalidValue({ reason: 'valueTypeMismatch', expected: 'boolean' })
    case 'enum':
      return typeof value === 'string' || typeof value === 'number'
        ? null
        : invalidValue({ reason: 'valueTypeMismatch', expected: 'enum' })
  }
}

/** 值相等（结构化比较；轨道写入去重用）。 */
export function sameTrackValue(a: TrackValue, b: TrackValue): boolean {
  if (typeof a === 'number' || typeof a === 'string' || typeof a === 'boolean') return a === b
  if (isVec3(a) && isVec3(b)) return a.x === b.x && a.y === b.y && a.z === b.z
  if (isQuat(a) && isQuat(b)) return a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// 轨道编辑（纯；全部返回新状态）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 插入或替换一个关键帧。
 *
 * 已有同时间帧 ⇒ **替换**（而不是插入重复帧）：重复时间会让"区间定位"依赖数组顺序，
 * 而顺序又取决于插入历史 ⇒ 同时间可能得不同结果，直接违反 A09「同时间同结果」。
 */
export function insertKeyframe(track: AnimationTrack, key: AnimationKey): AnimationTrack {
  const kept = track.keys.filter((k) => !sameTime(k.time, key.time))
  const next = [...kept, key].sort((a, b) => compareTime(a.time, b.time))
  return Object.freeze({ ...track, keys: Object.freeze(next) })
}

export function removeKeyframe(track: AnimationTrack, time: TimeValue): AnimationTrack {
  const next = track.keys.filter((k) => !sameTime(k.time, time))
  if (next.length === track.keys.length) return track
  return Object.freeze({ ...track, keys: Object.freeze(next) })
}

/** 启用/禁用轨道（禁用 ⇒ 该属性回到手动/默认值，#249 §3.3）。 */
export function setTrackEnabled(track: AnimationTrack, enabled: boolean): AnimationTrack {
  return track.enabled === enabled ? track : Object.freeze({ ...track, enabled })
}

export function withTrack(state: AnimationState, track: AnimationTrack): AnimationState {
  const key = trackKey(track)
  const kept = state.tracks.filter((t) => trackKey(t) !== key)
  return Object.freeze({ ...state, tracks: Object.freeze([...kept, track]) })
}

export function withoutTrack(state: AnimationState, ref: PropertyRef): AnimationState {
  const key = propertyKey(ref)
  const next = state.tracks.filter((t) => trackKey(t) !== key)
  if (next.length === state.tracks.length) return state
  return Object.freeze({ ...state, tracks: Object.freeze(next) })
}

/** 设置发布默认值（有效值优先级的第一层）。 */
export function withPublishedDefault(state: AnimationState, key: string, value: TrackValue): AnimationState {
  return Object.freeze({ ...state, publishedDefaults: Object.freeze({ ...state.publishedDefaults, [key]: value }) })
}

// ─────────────────────────────────────────────────────────────────────────────
// 多通道耦合：对**完整候选参数集**纯校验（#249 §7）
// ─────────────────────────────────────────────────────────────────────────────

/** 一条参数约束（由领域注册；核心只求值，不含任何"若 multiblock 则…"的分支）。 */
export type ParameterConstraint =
  | { readonly kind: 'range'; readonly key: string; readonly min: number; readonly max: number }
  | { readonly kind: 'enum'; readonly key: string; readonly allowed: readonly (string | number)[] }
  | {
      readonly kind: 'coupling'
      readonly a: string
      readonly requires: 'ge' | 'le' | 'eq'
      readonly b: string
      /** 违反时的诊断说明键（供 UI 本地化，§19.7）。 */
      readonly labelKey?: string
    }
  | {
      readonly kind: 'custom'
      readonly id: string
      readonly keys: readonly string[]
      readonly check: (candidate: Readonly<Record<string, number>>) => boolean
      readonly labelKey?: string
    }

export type ParameterCandidate = Readonly<Record<string, number>>

export interface ValidatedParameters {
  readonly values: ParameterCandidate
  /** 全部满足的约束 id（诊断/证据用：证明"确实校验过"而不是"没报错因为没查"）。 */
  readonly satisfied: readonly string[]
}

/** 约束的稳定标识（诊断关联用）。 */
export function constraintId(c: ParameterConstraint): string {
  switch (c.kind) {
    case 'range':
      return `range:${c.key}`
    case 'enum':
      return `enum:${c.key}`
    case 'coupling':
      return `coupling:${c.a}${c.requires}${c.b}`
    case 'custom':
      return `custom:${c.id}`
  }
}

/**
 * 对**完整候选参数集**做纯校验。
 *
 * 三条硬要求：
 *  1. **不夹取**：越界/非法组合返回 `InvalidValue`，绝不"悄悄夹到合法范围再宣称成功"
 *     （#249 §7 明文禁止）。这与旧装配器 `assembleSelection` 的"夹取 + 提示"是**两条**
 *     不同政策：本函数是新求值面的政策；旧路径的消费者由 P6 退役（见汇报中的删除点清单）。
 *  2. **看完整集合**：耦合约束一次拿全部候选值判定，不做"逐通道就地修正"——
 *     后者会让结果依赖校验顺序（#249 §10「注册顺序不应产生隐藏覆盖结果」的同构要求）。
 *  3. **可诊断**：失败带 `constraint`、`key`、`reason`，不用自然语言消息充当判据。
 */
export function validateParameterSet(
  constraints: readonly ParameterConstraint[],
  candidate: ParameterCandidate,
): Result<ValidatedParameters> {
  const satisfied: string[] = []
  for (const c of constraints) {
    const id = constraintId(c)
    if (c.kind === 'range') {
      const v = candidate[c.key]
      if (v === undefined) continue
      if (!Number.isFinite(v) || v < c.min || v > c.max) {
        return err(
          invalidValue({
            reason: 'parameterOutOfRange',
            constraint: id,
            key: c.key,
            value: String(v),
            min: c.min,
            max: c.max,
          }),
        )
      }
    } else if (c.kind === 'enum') {
      const v = candidate[c.key]
      if (v === undefined) continue
      if (!c.allowed.includes(v)) {
        return err(
          invalidValue({
            reason: 'parameterNotInEnum',
            constraint: id,
            key: c.key,
            value: String(v),
          }),
        )
      }
    } else if (c.kind === 'coupling') {
      const a = candidate[c.a]
      const b = candidate[c.b]
      if (a === undefined || b === undefined) continue
      const holds =
        c.requires === 'ge' ? a >= b : c.requires === 'le' ? a <= b : a === b
      if (!holds) {
        return err(
          invalidValue({
            reason: 'parameterCouplingViolated',
            constraint: id,
            a: c.a,
            b: c.b,
            requires: c.requires,
            aValue: a,
            bValue: b,
          }),
        )
      }
    } else {
      if (!c.check(candidate)) {
        return err(
          invalidValue({
            reason: 'parameterCustomConstraintViolated',
            constraint: id,
            keys: c.keys.join(','),
          }),
        )
      }
    }
    satisfied.push(id)
  }
  return ok(Object.freeze({ values: Object.freeze({ ...candidate }), satisfied: Object.freeze(satisfied) }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 有效值优先级（#249 §7 逐字）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 有效值的一层。
 *
 * 为什么用判别联合而不是"四个可选字段"：可选字段无法区分"这一层没有值"与
 * "这一层的值是 `null`"，而 `null` 是合法属性值（契约 §5.2 对混合值的同一顾虑）。
 */
export type EffectiveValueLayer =
  | { readonly kind: 'base'; readonly value: TrackValue }
  | { readonly kind: 'manualPreview'; readonly value: TrackValue }
  | { readonly kind: 'trackSample'; readonly value: TrackValue }
  | { readonly kind: 'stagingOverride'; readonly value: TrackValue }

/** 优先级（数字大者胜）。与 #249 §7 的列举顺序一致。 */
const LAYER_RANK: Readonly<Record<EffectiveValueLayer['kind'], number>> = Object.freeze({
  base: 0,
  manualPreview: 1,
  trackSample: 2,
  stagingOverride: 3,
})

export interface ResolvedEffectiveValue {
  readonly value: TrackValue
  /** 实际胜出的层（诊断/证据用：可断言"是轨道赢的"而不是"恰好值一样"）。 */
  readonly source: EffectiveValueLayer['kind']
}

/**
 * 按优先级解析有效值。
 *
 * 两层同 `kind` ⇒ `InvalidValue`：重复层会让"谁赢"取决于数组顺序，
 * 而顺序是调用现场的偶然事实 —— 那正是 #249 §10 要禁止的"隐藏覆盖结果"。
 *
 * 本函数**不写任何一层**：动画输出因此不可能反写手动取值（#249 §3.3）。
 */
export function resolveEffectiveValue(layers: readonly EffectiveValueLayer[]): Result<ResolvedEffectiveValue> {
  const seen = new Set<EffectiveValueLayer['kind']>()
  let winner: EffectiveValueLayer | null = null
  for (const l of layers) {
    if (seen.has(l.kind)) {
      return err(invalidValue({ reason: 'duplicateEffectiveValueLayer', layer: l.kind }))
    }
    seen.add(l.kind)
    if (winner === null || LAYER_RANK[l.kind] > LAYER_RANK[winner.kind]) winner = l
  }
  if (winner === null) {
    return err(invalidValue({ reason: 'noEffectiveValueLayer' }))
  }
  return ok(Object.freeze({ value: winner.value, source: winner.kind }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 场景侧的目标寻址（把 PropertyRef 解析到"对象上的某个字段"）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 读出某个属性引用的**文档基础值**（`authored` 语义的第一层）。
 *
 * 这是"轨道目标可寻址"的最小落地：轨道用它取基准值，`application/queries` 用它
 * 组装有效值分层。未支持的属性返回 `null`（调用方据此决定 `UnsupportedOperation`，
 * **不**在本函数里猜）。
 */
export function authoredValue(scene: Scene, ref: PropertyRef): TrackValue | null {
  if (ref.owner.kind !== 'object') return null
  const obj = findObject(scene, ref.owner.id)
  if (!obj) return null
  const p = ref.property
  if (p === 'name') return obj.name
  if (p === 'visible') return obj.visible
  if (p.startsWith('transform.')) {
    const field = p.slice('transform.'.length)
    const t = obj.transform
    if (field === 'position') return componentOf(t.position, ref.component)
    if (field === 'scale') return componentOf(t.scale, ref.component)
    if (field === 'rotation') return componentOf(t.rotation, ref.component)
    if (field === 'pivot') return componentOf(t.pivot, ref.component)
  }
  return null
}

/**
 * 分量投影：`component` 缺省时返回整个向量/四元数；给出下标时投影成标量。
 *
 * 契约 §1.3 的选择理由（"让向量分量动画与标量动画共用同一寻址与轨道目标"）
 * 在本函数落地：**没有**第二套"分量轨道"，分量只是同一个 `PropertyRef` 的一个字段。
 */
function componentOf(v: Vec3 | Quat, component: number | undefined): TrackValue {
  if (component === undefined) return v
  const parts: readonly number[] = 'w' in v ? [v.x, v.y, v.z, v.w] : [v.x, v.y, v.z]
  return parts[component] ?? 0
}

/** 对象是否被某个已启用轨道驱动（写权判定的输入；见 `application/commands`）。 */
export function isDriven(state: AnimationState, ref: PropertyRef): boolean {
  const t = findTrack(state, ref)
  return t !== undefined && t.enabled
}

/** 两个轨道目标是否相同（转发 `samePropertyRef`，供测试与下游对账）。 */
export const sameTrackTarget = samePropertyRef

/** 拥有者引用（未使用占位，保持类型可达性供下游 `import type`）。 */
export type { EntityRef }
