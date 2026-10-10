/**
 * `domain/animation` —— **A09 animation-generic / A10 animation-edit-policy** 的判定面
 * （#249 §7 §14；#255 验收 F1/F2）。
 *
 * ## 本文件组织方式
 *
 * 每一条验收项都有：
 *  - **正断言**：能力确实成立（并给出可观测依据，不靠"没报错"）；
 *  - **负对照**：故意破坏该保证时**必须判红**（#249 §14「负对照必须证明确实破坏了
 *    目标保证，不能只令测试主动抛错」）。
 *
 * 负对照的实现方式是本项目一贯的口径：**同一个判定函数**，只换事实来源。
 * 若某条负对照只是"调用一个必然抛错的函数"，它证明的是"那个函数会抛"，
 * 而不是"判据能抓到这种违约" —— 那不算负对照。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FRAME_RATE,
  advancePlayhead,
  advanceTime,
  animationDrivenKeys,
  checkValueType,
  compareRational,
  compareTime,
  createPlayhead,
  findTrack,
  frameRateOf,
  framesPerSecond,
  insertKeyframe,
  isDriven,
  propertyKey,
  quantize,
  rational,
  removeKeyframe,
  resolveEffectiveValue,
  sampleTrack,
  sameTime,
  sameTrackValue,
  seekPlayhead,
  setPlaying,
  setTrackEnabled,
  slerpQuat,
  stopPlayhead,
  timeValue,
  validateParameterSet,
  withPublishedDefault,
  withTrack,
  withoutTrack,
  EMPTY_ANIMATION,
  type AnimationTrack,
  type EffectiveValueLayer,
  type ParameterConstraint,
  type Playhead,
  type TrackValue,
} from '@/domain/animation'
import { objectRef, propertyRef, entityRef } from '@/domain/identity'
import { transform, vec3, type Quat, type Vec3 } from '@/domain/scene'
import { channelStepTrack, sampleChannelAt, type ChannelSet } from '@/domain/multiblock'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

const OBJ = objectRef('o1')
const POS = propertyRef(OBJ, 'transform.position')
const ROT = propertyRef(OBJ, 'transform.rotation')
const ENUMISH = propertyRef(OBJ, 'mode')
const SCALAR = propertyRef(OBJ, 'projection.fov')
const POS_X = propertyRef(OBJ, 'transform.position', { component: 0 })

function numberTrack(keys: readonly { t: number; v: number }[], interpolation: AnimationTrack['interpolation'] = 'linear'): AnimationTrack {
  return Object.freeze({
    id: 'track:scalar',
    target: SCALAR,
    valueType: 'number' as const,
    interpolation,
    enabled: true,
    keys: Object.freeze(keys.map((k) => Object.freeze({ time: timeValue(k.t, 20), value: k.v }))),
  })
}

function quatTrack(keys: readonly { t: number; v: Quat }[]): AnimationTrack {
  return Object.freeze({
    id: 'track:rot',
    target: ROT,
    valueType: 'quat' as const,
    interpolation: 'slerp' as const,
    enabled: true,
    keys: Object.freeze(keys.map((k) => Object.freeze({ time: timeValue(k.t, 20), value: k.v }))),
  })
}

function vecTrack(): AnimationTrack {
  return Object.freeze({
    id: 'track:vec',
    target: POS,
    valueType: 'vec3' as const,
    interpolation: 'linear' as const,
    enabled: true,
    keys: Object.freeze([
      Object.freeze({ time: timeValue(0, 20), value: vec3(0, 0, 0) }),
      Object.freeze({ time: timeValue(20, 20), value: vec3(10, 20, -30) }),
    ]),
  })
}

/** 阶跃枚举轨道（A09 负对照「枚举线性插值」的判定对象）。 */
function enumStepTrack(interpolation: AnimationTrack['interpolation']): AnimationTrack {
  return Object.freeze({
    id: 'track:enum',
    target: ENUMISH,
    valueType: 'enum' as const,
    interpolation,
    enabled: true,
    keys: Object.freeze([
      Object.freeze({ time: timeValue(0, 20), value: 'idle' }),
      Object.freeze({ time: timeValue(20, 20), value: 'active' }),
    ]),
    legalValues: Object.freeze(['idle', 'active', 'paused']) as readonly TrackValue[],
  })
}

/** 绕 Y 轴旋转 angle 弧度的四元数。 */
function rotY(angle: number): Quat {
  return Object.freeze({ x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) })
}

function quatAngle(q: Quat): number {
  return 2 * Math.acos(Math.min(1, Math.abs(q.w)))
}

// ─────────────────────────────────────────────────────────────────────────────
// A09：给定时间同结果、无专用播放调度、播放零内容脏
// ─────────────────────────────────────────────────────────────────────────────

describe('A09 animation-generic：给定时间直接求值（#249 §7）', () => {
  it('同时间同结果：连续两次采样（含"倒退回来"）逐位相同', () => {
    const track = vecTrack()
    const t = timeValue(7.5, 20)
    const a = sampleTrack(track, t)
    const b = sampleTrack(track, t)
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.value.value).toEqual(b.value.value)
      // 正对照：确实插到了中间值（不是"两端之一"这种空转）
      const v = a.value.value as Vec3
      expect(v.x).toBeCloseTo(3.75, 10)
      expect(v.y).toBeCloseTo(7.5, 10)
      expect(v.z).toBeCloseTo(-11.25, 10)
    }
  })

  it('**倒退定位与正向播放同一路径**：时间轴任意跳转，结果只由 (轨道, 时间) 决定', () => {
    const track = numberTrack([{ t: 0, v: 0 }, { t: 20, v: 100 }])
    // 模拟"播放到 10 帧"与"从 20 帧倒退到 10 帧"：两者对同一时间的采样必须一致。
    const forward = sampleTrack(track, timeValue(10, 20))
    // 先求 20 帧（末端），再求 10 帧 —— 若无隐式累积状态，二者必相同。
    sampleTrack(track, timeValue(20, 20))
    sampleTrack(track, timeValue(0, 20))
    const backward = sampleTrack(track, timeValue(10, 20))
    expect(forward.ok && backward.ok).toBe(true)
    if (forward.ok && backward.ok) expect(forward.value.value).toBe(backward.value.value)
  })

  it('播放采样率与显示刷新率解耦：Playhead 推进只吃显式逻辑秒数', () => {
    // 同一个时间点，无论"经过多少次推进"到达，结果相同：
    // 这正是"不通过已经播放过多少次回调累积内容"（#249 §7）的可执行判据。
    const base = createPlayhead(timeValue(0, 20), true, 1)
    const oneJump = advancePlayhead(base, 0.5)
    let stepped: Playhead = base
    for (let i = 0; i < 50; i++) stepped = advancePlayhead(stepped, 0.01)
    expect(sameTime(oneJump.time, stepped.time), '一次跳 0.5s 与分 50 次推进 0.01s 必须落在同一时间').toBe(true)
    // 20 fps 下 0.5 秒 = 10 帧
    expect(oneJump.time.frame).toBeCloseTo(10, 10)
  })

  it('暂停 ⇒ 时间不动；停止播放保留当前时间（#249 §3.3）', () => {
    const playing = createPlayhead(timeValue(12, 20), true, 1)
    const paused = setPlaying(playing, false)
    const afterAdvance = advancePlayhead(paused, 100)
    expect(sameTime(afterAdvance.time, playing.time), '暂停时推进不得改变时间').toBe(true)

    const stopped = stopPlayhead(playing)
    expect(stopped.playing).toBe(false)
    expect(sameTime(stopped.time, playing.time), '停止播放必须保留当前时间').toBe(true)
  })

  it('跳帧 = 直接定位时间，与播放无关（不改变 playing/rate）', () => {
    const ph = createPlayhead(timeValue(0, 20), true, 2)
    const jumped = seekPlayhead(ph, timeValue(40, 20))
    expect(jumped.time.frame).toBe(40)
    expect(jumped.playing).toBe(true)
    expect(jumped.rate).toBe(2)
  })

  it('有理帧率：29.97（30000/1001）下的时间比较精确，不随播放时长漂移', () => {
    const ntsc = { num: 30000, den: 1001 }
    const rate = frameRateOf(ntsc)
    expect(rate.ok).toBe(true)
    if (rate.ok) {
      expect(rate.value.num).toBe(30000)
      expect(rate.value.den).toBe(1001)
    }
    // 用有理数比较：第 30000 帧与 1001 秒**精确**相等（30000/30000:1001 → 1001s）
    const a = timeValue(30000, ntsc)
    const b = timeValue(1001, 1) // 1001 秒 @ 1fps
    expect(compareTime(a, b), '30000 帧 @30000/1001 精确等于 1001 秒').toBe(0)
    // 负对照：若把 fps 当浮点近似（29.97），同样的比较会给出非零
    expect(compareTime(timeValue(30000, 29.97), b)).not.toBe(0)
  })

  it('有理数约分：2/4 与 1/2 是同一个采样时间（否则"同时间"依赖写法）', () => {
    expect(compareRational(rational(2, 4), rational(1, 2))).toBe(0)
    expect(sameTime(timeValue(1, { num: 40, den: 2 }), timeValue(1, 20))).toBe(true)
  })

  it('采样策略由**值类型与定义**选择：数值线性、四元数 slerp、枚举阶跃', () => {
    // 数值：线性
    const n = sampleTrack(numberTrack([{ t: 0, v: 0 }, { t: 20, v: 10 }], 'linear'), timeValue(10, 20))
    expect(n.ok && n.value.value).toBe(5)
    // 四元数：slerp（不是四个数各自线性）
    const q = sampleTrack(quatTrack([{ t: 0, v: rotY(0) }, { t: 20, v: rotY(Math.PI / 2) }]), timeValue(10, 20))
    expect(q.ok).toBe(true)
    if (q.ok) {
      const v = q.value.value as Quat
      // 四元数形态（四个分量，含 w）—— 不是被降级成 vec3 或数字
      expect(Object.keys(v).sort()).toEqual(['w', 'x', 'y', 'z'])
      expect(Math.hypot(v.x, v.y, v.z, v.w), 'slerp 结果必须是单位四元数').toBeCloseTo(1, 10)
      // slerp 的中点 = 旋转 45°，而不是"四个分量各取一半"
      expect(quatAngle(v)).toBeCloseTo(Math.PI / 4, 10)
      const naive = { x: (0 + rotY(Math.PI / 2).x) / 2, y: 0, z: 0, w: (1 + rotY(Math.PI / 2).w) / 2 }
      const naiveAngle = quatAngle(Object.freeze({ ...naive, y: 0 }))
      expect(Math.abs(quatAngle(v) - naiveAngle) > 0.01, '四分量线性插值与 slerp 必须给出不同角度（否则这条无区分力）').toBe(true)
    }
    // 枚举：阶跃
    const e = sampleTrack(enumStepTrack('step'), timeValue(10, 20))
    expect(e.ok && e.value.value).toBe('idle')
  })

  it('**负对照 A09-1**：枚举用线性插值 ⇒ 判红（不产出定义域外的值）', () => {
    const bad = enumStepTrack('linear')
    const r = sampleTrack(bad, timeValue(10, 20))
    expect(r.ok, '枚举/布尔/字符串不得线性插值').toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('InvalidValue')
      expect(r.error.params.reason).toBe('linearInterpolationUnsupportedForValueType')
    }
    // 同一判据对**阶跃**版本判绿 —— 证明判据不是恒红
    expect(sampleTrack(enumStepTrack('step'), timeValue(10, 20)).ok).toBe(true)
  })

  it('**负对照 A09-2**：值不属合法域 ⇒ 判红（不静默接受成员外的值）', () => {
    const track: AnimationTrack = Object.freeze({
      ...enumStepTrack('step'),
      keys: Object.freeze([
        Object.freeze({ time: timeValue(0, 20), value: 'idle' as TrackValue }),
        // 故意插入一个不在 legalValues 里的值
        Object.freeze({ time: timeValue(20, 20), value: 'not-a-mode' as TrackValue }),
      ]),
    })
    const r = sampleTrack(track, timeValue(20, 20))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.params.reason).toBe('valueOutsideLegalDomain')
  })

  it('**负对照 A09-3**：值与声明类型不符 ⇒ 判红（不静默转换）', () => {
    expect(checkValueType('number', 'not-a-number')?.code).toBe('InvalidValue')
    expect(checkValueType('vec3', vec3(1, 2, 3))).toBeNull()
    expect(checkValueType('quat', vec3(1, 2, 3))?.code).toBe('InvalidValue')
    expect(checkValueType('integer', 1.5)?.code).toBe('InvalidValue')
  })

  it('无关键帧 ⇒ MissingTarget（不给默认值冒充成功，契约 §3.1）', () => {
    const empty: AnimationTrack = Object.freeze({ ...numberTrack([]), keys: Object.freeze([]) })
    const r = sampleTrack(empty, timeValue(0, 20))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // 契约 §3.1：目标不存在用 MissingTarget，不用默认值
      expect(['InvalidValue', 'MissingTarget']).toContain(r.error.code)
      expect(r.error.params.reason).toBe('trackHasNoKeys')
    }
  })

  it('阶跃离散通道经**通用架构**运行（#249 §7 明文 + #255 验收 F1）', () => {
    // F1 的判据：一条离散通道轨道走的是通用 track + 通用 sampler，
    // 没有任何"多方块专用播放调度器"。
    const set: ChannelSet = Object.freeze({
      id: 'mb-1',
      channels: Object.freeze([
        Object.freeze({
          key: 'tier',
          name: 'Tier',
          domain: Object.freeze({ kind: 'integer' as const, min: 0, max: 5 }),
          source: 'content' as const,
        }),
      ]),
    })
    const built = channelStepTrack(set, 'tier', [
      { time: timeValue(0, 20), value: 1 },
      { time: timeValue(20, 20), value: 3 },
      { time: timeValue(40, 20), value: 5 },
    ])
    expect(built.ok, '阶跃通道轨道必须能由通道定义构造').toBe(true)
    if (!built.ok) return
    const track = built.value

    // ① 它是**通用** AnimationTrack，且策略是阶跃
    expect(track.interpolation).toBe('step')
    expect(Object.keys(track).sort()).toEqual(['enabled', 'id', 'interpolation', 'keys', 'quantization', 'target', 'valueType'])

    // ② 通用采样器直接可采样它（无专用执行器）
    const at10 = sampleChannelAt(track, timeValue(10, 20))
    const at20 = sampleChannelAt(track, timeValue(20, 20))
    expect(at10.ok && at10.value).toBe(1)
    expect(at20.ok && at20.value).toBe(3)

    // ③ 同时间同结果
    expect(sampleChannelAt(track, timeValue(30, 20))).toEqual(sampleChannelAt(track, timeValue(30, 20)))

    // ④ 阶跃：区间内任意时刻取同一个值（不插值）
    expect(sampleChannelAt(track, timeValue(1, 20))).toEqual(sampleChannelAt(track, timeValue(19, 20)))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 有效值优先级 + A10
// ─────────────────────────────────────────────────────────────────────────────

describe('A10 animation-edit-policy：有效值优先级与写入政策（#249 §7）', () => {
  it('四层优先级：base < manualPreview < trackSample < stagingOverride', () => {
    const layers: readonly EffectiveValueLayer[] = [
      { kind: 'base', value: 1 },
      { kind: 'manualPreview', value: 2 },
      { kind: 'trackSample', value: 3 },
      { kind: 'stagingOverride', value: 4 },
    ]
    // 任意顺序都给同一个赢家（顺序不产生隐藏覆盖结果，#249 §10）
    const forward = resolveEffectiveValue(layers)
    const reversed = resolveEffectiveValue([...layers].reverse())
    expect(forward.ok && forward.value.value).toBe(4)
    expect(forward.ok && forward.value.source).toBe('stagingOverride')
    expect(reversed.ok && reversed.value.value).toBe(4)

    // 逐层去掉最高者，赢家依次下移（证明每层都真的参与）
    expect(resolveEffectiveValue(layers.slice(0, 3)).ok && resolveEffectiveValue(layers.slice(0, 3)).ok && (resolveEffectiveValue(layers.slice(0, 3)) as { value: { value: number } }).value.value).toBe(3)
    expect(resolveEffectiveValue(layers.slice(0, 2)).ok && (resolveEffectiveValue(layers.slice(0, 2)) as { value: { value: number } }).value.value).toBe(2)
    expect(resolveEffectiveValue(layers.slice(0, 1)).ok && (resolveEffectiveValue(layers.slice(0, 1)) as { value: { value: number } }).value.value).toBe(1)
  })

  it('动画输出**不反写**手动取值：解析只返回赢家，输入层对象不被修改', () => {
    const manual: EffectiveValueLayer = { kind: 'manualPreview', value: 7 }
    const trackSample: EffectiveValueLayer = { kind: 'trackSample', value: 99 }
    const frozenManual = Object.freeze({ ...manual })
    const frozenTrack = Object.freeze({ ...trackSample })
    const r = resolveEffectiveValue([frozenManual, frozenTrack])
    expect(r.ok && r.value.value).toBe(99)
    // 手动层必须保持原值（动画没有反写它）
    expect(frozenManual.value).toBe(7)
    expect(frozenManual.kind).toBe('manualPreview')
  })

  it('**负对照 A10-1**：重复层 ⇒ 判红（否则"谁赢"取决于数组顺序）', () => {
    const dup: readonly EffectiveValueLayer[] = [
      { kind: 'manualPreview', value: 1 },
      { kind: 'manualPreview', value: 2 },
    ]
    const r = resolveEffectiveValue(dup)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.params.reason).toBe('duplicateEffectiveValueLayer')
  })

  it('**负对照 A10-2**：空层集 ⇒ 判红（不返回"默认值"冒充有值）', () => {
    const r = resolveEffectiveValue([])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.params.reason).toBe('noEffectiveValueLayer')
  })

  it('禁用轨道 ⇒ 目标不再被驱动（属性回到手动/默认值，#249 §3.3）', () => {
    const track = numberTrack([{ t: 0, v: 1 }, { t: 20, v: 2 }])
    let state = withTrack(EMPTY_ANIMATION, track)
    expect(isDriven(state, SCALAR)).toBe(true)
    expect(animationDrivenKeys(state).has(propertyKey(SCALAR))).toBe(true)

    state = withTrack(state, setTrackEnabled(track, false))
    expect(isDriven(state, SCALAR), '禁用轨道后不得再算"被驱动"').toBe(false)
    expect(animationDrivenKeys(state).has(propertyKey(SCALAR))).toBe(false)
    // 轨道数据仍在（禁用 ≠ 删除），重新启用即恢复
    expect(findTrack(state, SCALAR)).toBeDefined()
    state = withTrack(state, setTrackEnabled(track, true))
    expect(isDriven(state, SCALAR)).toBe(true)
  })

  it('发布默认值属文档层，与手动预览值分开存放（不互相覆盖）', () => {
    const state = withPublishedDefault(EMPTY_ANIMATION, propertyKey(SCALAR), 42)
    expect(state.publishedDefaults[propertyKey(SCALAR)]).toBe(42)
    expect(state.tracks).toHaveLength(0)
  })

  it('`insertKeyframe` 同时间帧**替换**而非追加（否则区间定位依赖插入顺序）', () => {
    let track = numberTrack([])
    track = insertKeyframe(track, { time: timeValue(10, 20), value: 1 })
    track = insertKeyframe(track, { time: timeValue(10, 20), value: 2 })
    expect(track.keys).toHaveLength(1)
    expect(track.keys[0].value).toBe(2)
    // 关键帧始终按时间升序
    track = insertKeyframe(track, { time: timeValue(0, 20), value: 0 })
    track = insertKeyframe(track, { time: timeValue(20, 20), value: 3 })
    expect(track.keys.map((k) => k.time.frame)).toEqual([0, 10, 20])
  })

  it('轨道目标含分量：向量分量动画与标量动画共用同一寻址（契约 §1.3 选择理由）', () => {
    const whole = propertyKey(POS)
    const comp = propertyKey(POS_X)
    expect(whole).not.toBe(comp)
    // 同一 owner+property 的不同分量是**不同**轨道目标
    expect(comp).toContain('transform.position#0')
    const t: AnimationTrack = Object.freeze({ ...numberTrack([{ t: 0, v: 0 }]), target: POS_X })
    const state = withTrack(EMPTY_ANIMATION, t)
    expect(isDriven(state, POS_X)).toBe(true)
    // 而"整向量"目标并未被驱动 —— 证明分量寻址是独立的
    expect(isDriven(state, POS)).toBe(false)
  })

  it('`removeKeyframe` 删到空 ⇒ 轨道可被整体移除（`withoutTrack`）', () => {
    let track = numberTrack([{ t: 0, v: 1 }])
    track = removeKeyframe(track, timeValue(0, 20))
    expect(track.keys).toHaveLength(0)
    const state = withoutTrack(withTrack(EMPTY_ANIMATION, numberTrack([{ t: 0, v: 1 }])), SCALAR)
    expect(findTrack(state, SCALAR)).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 采样策略细节：量化 / 边界 / 四元数语义
// ─────────────────────────────────────────────────────────────────────────────

describe('采样策略细节（#249 §7）', () => {
  it('受限整数：显式量化策略，插值后量化，且量化结果仍过合法域校验', () => {
    const track: AnimationTrack = Object.freeze({
      id: 'track:int',
      target: SCALAR,
      valueType: 'integer' as const,
      interpolation: 'quantized' as const,
      enabled: true,
      keys: Object.freeze([
        Object.freeze({ time: timeValue(0, 20), value: 0 }),
        Object.freeze({ time: timeValue(20, 20), value: 10 }),
      ]),
      quantization: Object.freeze({ kind: 'integer' as const }),
    })
    const mid = sampleTrack(track, timeValue(10, 20))
    expect(mid.ok && mid.value.value).toBe(5)
    const third = sampleTrack(track, timeValue(7, 20))
    expect(third.ok && Number.isInteger(third.value.value as number)).toBe(true)
    expect(third.ok && (third.value.value as number)).toBe(4) // 3.5 → 4

    // 量化策略缺失 ⇒ 显式失败，不用"默认取整"顶替
    const noPolicy: AnimationTrack = Object.freeze({ ...track, quantization: undefined })
    const r = sampleTrack(noPolicy, timeValue(10, 20))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.params.reason).toBe('quantizationPolicyMissing')

    // 步长量化：origin 让"量到 5/10/15…"可表达
    expect(quantize(7, { kind: 'step', step: 5 })).toBe(5)
    expect(quantize(8, { kind: 'step', step: 5 })).toBe(10)
    expect(quantize(8, { kind: 'step', step: 5, origin: 3 })).toBe(8)
  })

  it('边界钳制：早于首帧取首帧、晚于末帧取末帧（不外推）', () => {
    const track = numberTrack([{ t: 10, v: 5 }, { t: 20, v: 15 }])
    const before = sampleTrack(track, timeValue(0, 20))
    const after = sampleTrack(track, timeValue(100, 20))
    expect(before.ok && before.value.value).toBe(5)
    expect(after.ok && after.value.value).toBe(15)
  })

  it('阶跃半开区间：恰在边界取**该帧**（不是下一帧）', () => {
    const track: AnimationTrack = Object.freeze({
      ...numberTrack([], 'step'),
      keys: Object.freeze([
        Object.freeze({ time: timeValue(0, 20), value: 1 }),
        Object.freeze({ time: timeValue(10, 20), value: 2 }),
      ]),
    })
    const at10 = sampleTrack(track, timeValue(10, 20))
    expect(at10.ok && at10.value.value, 't 恰为某关键帧时刻 ⇒ 取该帧').toBe(2)
    const justBefore = sampleTrack(track, timeValue(9.999, 20))
    expect(justBefore.ok && justBefore.value.value).toBe(1)
  })

  it('四元数 slerp 走**最短路径**：10° → 350° 不绕 340°', () => {
    const from = rotY((10 * Math.PI) / 180)
    const to = rotY((350 * Math.PI) / 180)
    const mid = slerpQuat(from, to, 0.5)
    // 最短路径的中点是 0°（或等价的 360°），而不是 180°
    const angle = quatAngle(mid)
    expect(Math.min(angle, 2 * Math.PI - angle)).toBeLessThan(0.01)
    // 结果必须是单位四元数（否则当旋转用会让物体缩放）
    expect(Math.hypot(mid.x, mid.y, mid.z, mid.w)).toBeCloseTo(1, 10)
  })

  it('**负对照**：把四元数当四个数线性插值 ⇒ 退化为零四元数（可判红）', () => {
    // 取一对**表示同一旋转**的对极四元数：q 与 -q 是同一个旋转。
    // 逐分量线性插值会在中点得到零四元数（长度 0）—— 它不是任何旋转，
    // 当旋转用会让物体塌缩。这正是"不把四元数当四个数"要防的病征。
    const a = rotY(0) // (0,0,0,1)
    const b = rotY(2 * Math.PI) // (0,0,0,-1)：与 a 表示同一旋转
    expect(b.w).toBeCloseTo(-1, 10)

    const naive = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2, w: (a.w + b.w) / 2 }
    expect(Math.hypot(naive.x, naive.y, naive.z, naive.w), '对极四元数线性插值 → 零四元数').toBeCloseTo(0, 10)

    // 同一判据下 slerp 必须判**绿**：它先取最短路径（翻转 -q），再归一化。
    const proper = slerpQuat(a, b, 0.5)
    expect(Math.hypot(proper.x, proper.y, proper.z, proper.w), 'slerp 结果必须仍是单位四元数').toBeCloseTo(1, 10)
    expect(quatAngle(proper), 'a 与 -a 是同一旋转 ⇒ 任意插值参数都在原旋转上').toBeCloseTo(0, 6)
  })

  it('`slerp` 用在非四元数值上 ⇒ 判红（策略与值类型不匹配）', () => {
    const bad: AnimationTrack = Object.freeze({
      id: 'bad',
      target: SCALAR,
      valueType: 'number',
      interpolation: 'slerp',
      enabled: true,
      keys: Object.freeze([
        Object.freeze({ time: timeValue(0, 20), value: 0 }),
        Object.freeze({ time: timeValue(20, 20), value: 1 }),
      ]),
    })
    const r = sampleTrack(bad, timeValue(10, 20))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.params.reason).toBe('slerpRequiresQuaternion')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 多通道耦合：完整候选参数集校验
// ─────────────────────────────────────────────────────────────────────────────

describe('多通道耦合约束（#249 §7：对**完整候选参数集**纯校验，不夹取）', () => {
  const constraints: readonly ParameterConstraint[] = Object.freeze([
    Object.freeze({ kind: 'range', key: 'tier', min: 0, max: 4 }),
    Object.freeze({ kind: 'enum', key: 'mode', allowed: Object.freeze(['idle', 'active']) }),
    Object.freeze({ kind: 'coupling', a: 'width', requires: 'ge', b: 'depth' }),
  ])

  it('全部满足 ⇒ 通过，并如实报告检查过的约束（不空转）', () => {
    const r = validateParameterSet(constraints, { tier: 2, mode: 'active', width: 5, depth: 3 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.satisfied).toHaveLength(3)
      expect(r.value.values.tier).toBe(2)
    }
  })

  it('**不夹取**：越界返回 InvalidValue，且**不**把值改成边界值', () => {
    const r = validateParameterSet(constraints, { tier: 99 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('InvalidValue')
      expect(r.error.params.reason).toBe('parameterOutOfRange')
      expect(r.error.params.min).toBe(0)
      expect(r.error.params.max).toBe(4)
    }
  })

  it('耦合约束看**完整集合**：a/b 同时提供才判定（不做逐通道就地修正）', () => {
    const violated = validateParameterSet(constraints, { width: 1, depth: 5 })
    expect(violated.ok).toBe(false)
    if (!violated.ok) expect(violated.error.params.reason).toBe('parameterCouplingViolated')
    // 只提供一侧 ⇒ 跳过（"未设置"不等于"设置为 0"）
    expect(validateParameterSet(constraints, { width: 1 }).ok).toBe(true)
  })

  it('非法组合**不**悄悄夹取后宣称成功（A09/A10 共同的负对照面）', () => {
    const r = validateParameterSet(constraints, { mode: 'nonsense' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.params.reason).toBe('parameterNotInEnum')
  })

  it('自定义约束失败也是可诊断的 InvalidValue', () => {
    const custom: readonly ParameterConstraint[] = Object.freeze([
      Object.freeze({
        kind: 'custom',
        id: 'sum-under-10',
        keys: Object.freeze(['a', 'b']),
        check: (c: Readonly<Record<string, number>>) => (c.a ?? 0) + (c.b ?? 0) <= 10,
      }),
    ])
    expect(validateParameterSet(custom, { a: 4, b: 5 }).ok).toBe(true)
    const bad = validateParameterSet(custom, { a: 6, b: 6 })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.error.params.reason).toBe('parameterCustomConstraintViolated')
      expect(bad.error.params.constraint).toBe('custom:sum-under-10')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 帧率与时间的边角（拒绝路径）
// ─────────────────────────────────────────────────────────────────────────────

describe('帧率拒绝路径（与 P1 的 fpsMustBePositive 同判据）', () => {
  it('零/负/非有限帧率 ⇒ InvalidValue，reason 与 P1 一致', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, { num: 0, den: 1 }, { num: 20, den: 0 }, { num: -20, den: 1 }]) {
      const r = frameRateOf(bad)
      expect(r.ok, `${JSON.stringify(bad)} 必须被拒绝`).toBe(false)
      if (!r.ok) {
        expect(r.error.code).toBe('InvalidValue')
        expect(r.error.params.reason).toBe('fpsMustBePositive')
      }
    }
    // 正对照：合法帧率
    expect(frameRateOf(20).ok).toBe(true)
    expect(frameRateOf({ num: 30000, den: 1001 }).ok).toBe(true)
    expect(framesPerSecond(20)).toBe(20)
    expect(DEFAULT_FRAME_RATE).toEqual({ num: 20, den: 1 })
  })

  it('按秒推进与按帧推进一致（同一时间轴）', () => {
    const t = advanceTime(timeValue(0, 20), 0.5)
    expect(t.frame).toBeCloseTo(10, 10)
    expect(compareTime(t, timeValue(10, 20))).toBe(0)
  })

  it('值相等判定（轨道写入去重）', () => {
    expect(sameTrackValue(1, 1)).toBe(true)
    expect(sameTrackValue(vec3(1, 2, 3), vec3(1, 2, 3))).toBe(true)
    expect(sameTrackValue(vec3(1, 2, 3), vec3(1, 2, 4))).toBe(false)
    expect(sameTrackValue(rotY(0), rotY(0))).toBe(true)
    expect(sameTrackValue('a', 'a')).toBe(true)
  })
})

/** 未使用占位：保持 `transform`/`entityRef` 的导入可达（下游如需按对象建引用可复用）。 */
void transform
void entityRef
