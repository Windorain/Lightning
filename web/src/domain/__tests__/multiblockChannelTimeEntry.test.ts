/**
 * **G6 ③ 纯函数面判据**：离散通道时间入口的**构造与采样**（`domain/multiblock`）。
 *
 * 与 `runtime/__tests__/g6ChannelTimeEntry.test.ts`（生产装配路径）的分工：
 * 本文件判**算术与值域政策**，那份判**接线与生产可达**。两者都必需 ——
 * 只有前者会得到"纯函数很对但生产从不喂它"，只有后者会得到"接上了但算术靠猜"。
 *
 * | 判据 | 防什么 |
 * |---|---|
 * | `channelSetOfDeclaration` 逐字段搬运 | 防"适配器悄悄改值域"（声明 → 求值半的唯一翻译点） |
 * | `sizeChannelStepKeys` 的取值 = `min + stepIndex` 且时刻 = 帧起点 | 防"另一套时间轴/另一套反演" |
 * | 越界 `stepIndex` ⇒ **显式失败**（不钳制） | 防"把声明自相矛盾钳成一个看起来正常的取值" |
 * | 经 `channelStepTrack` + `sampleChannelAt` 的采样恒为**域内整数** | 防线性插值冒充离散阶跃（插值会产出域外/非整数） |
 */

import { describe, expect, it } from 'vitest'
import { framesPerSecond, timeValue, type TimeValue } from '@/domain/animation'
import {
  channelSetOfDeclaration,
  channelStepTrack,
  findChannel,
  sampleChannelAt,
  sizeChannelStepKeys,
  type ChannelSet,
  type DeclaredChannelLike,
} from '@/domain/multiblock'

const FPS = 20

/** 声明读面（与生产 `MultiblockChannel` 的结构子集逐字同形）。 */
const CHANNELS: readonly DeclaredChannelLike[] = Object.freeze([
  Object.freeze({ key: 'height', name: 'Height', kind: 'size', min: 1, max: 5 }),
  Object.freeze({ key: 'coil', name: 'Coil', kind: 'replace', min: 1, max: 3 }),
  Object.freeze({ key: 'hatch', name: 'Hatch', kind: 'hatch', min: 0, max: 2 }),
])

/** 每帧 100ms；`stepIndex` 刻意让第 0/2 帧同阶（验证"阶跃按声明、不按帧号漂移"）。 */
const STEPS = Object.freeze([0, 1, 0, 2])
const DURATIONS = Object.freeze([100, 100, 100, 100])

function setOf(): ChannelSet {
  return channelSetOfDeclaration('mb-test', CHANNELS)
}

/** 帧中（毫秒）→ 时间值：与生产 `frameIndex()` 同一「秒 → frame」换算。 */
function atMs(ms: number): TimeValue {
  return timeValue((ms / 1000) * FPS, FPS)
}

describe('G6 ③ 声明 → 通道集合（唯一翻译点）', () => {
  it('逐字段搬运键/名/值域，且三类 kind 一律收成数值域 `integer`（不按 kind 猜 boolean）', () => {
    const set = setOf()
    expect(set.id).toBe('mb-test')
    expect(set.channels.map((c) => c.key)).toEqual(CHANNELS.map((c) => c.key))
    expect(set.channels.map((c) => c.name)).toEqual(CHANNELS.map((c) => c.name))
    for (const decl of CHANNELS) {
      const ch = findChannel(set, decl.key)
      expect(ch, `${decl.key} 必须在集合里`).toBeDefined()
      expect(ch!.domain.kind, `${decl.key}：kind=${decl.kind} 也要收成数值域（不猜 boolean）`).toBe('integer')
      expect(ch!.domain.min, `${decl.key} 的下界必须与声明逐字相同`).toBe(decl.min)
      expect(ch!.domain.max, `${decl.key} 的上界必须与声明逐字相同`).toBe(decl.max)
      // 声明来自多方块生成物 ⇒ 写权归一（声明不可改、取值可手动预览）。
      expect(ch!.source, `${decl.key}：声明来自内容面`).toBe('content')
    }
    expect(findChannel(set, 'nope'), '未声明的键不得凭空存在').toBeUndefined()
  })
})

describe('G6 ③ 帧 → 阶跃关键帧（契约 §5.4 的双射）', () => {
  it('第 i 键：时刻 = 前 i 帧停留时长之和，取值 = 通道 min + stepIndex_i', () => {
    const set = setOf()
    const built = sizeChannelStepKeys(set, 'height', 'height', STEPS, DURATIONS, FPS)
    expect(built.ok, '构造必须成功').toBe(true)
    if (!built.ok) return
    expect(built.value).toHaveLength(STEPS.length)
    let ms = 0
    for (let i = 0; i < STEPS.length; i += 1) {
      // 期望在测试里**独立算**：秒 = 累计毫秒 / 1000，帧 = 秒 × fps（与生产同一换算）。
      expect(built.value[i]!.time, `键 ${i} 的时刻必须是第 ${i} 帧的起点`).toEqual(atMs(ms))
      expect(built.value[i]!.value, `键 ${i} 的取值必须是 min + stepIndex_${i}`).toBe(1 + STEPS[i]!)
      ms += DURATIONS[i]!
    }
    // 相邻键的间距 = 该帧的停留时长（阶跃点落在帧起点上，不落在帧中/帧末）。
    for (let i = 1; i < built.value.length; i += 1) {
      const gapMs = (built.value[i]!.time.frame - built.value[i - 1]!.time.frame) / framesPerSecond(FPS) * 1000
      expect(gapMs, `键 ${i - 1}→${i} 的间距必须是第 ${i - 1} 帧的停留时长`).toBe(DURATIONS[i - 1]!)
    }
  })

  it('越界 `stepIndex`（min + step > max）⇒ 显式失败：不钳制、不外推、不伪造', () => {
    const set = setOf()
    const bad = sizeChannelStepKeys(set, 'height', 'height', Object.freeze([0, 9]), Object.freeze([100, 100]), FPS)
    expect(bad.ok, '声明自相矛盾时必须判错').toBe(false)
    if (!bad.ok) expect(bad.error.params.reason).toBe('channelStepOutOfDomain')
  })

  it('非尺寸型通道 / 未声明通道 ⇒ 各自显式失败（不猜一条轨道出来）', () => {
    const set = setOf()
    const wrongChannel = sizeChannelStepKeys(set, 'coil', 'height', STEPS, DURATIONS, FPS)
    expect(wrongChannel.ok).toBe(false)
    if (!wrongChannel.ok) expect(wrongChannel.error.params.reason).toBe('channelIsNotSizeChannel')
    const unknown = sizeChannelStepKeys(set, 'nope', 'nope', STEPS, DURATIONS, FPS)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.params.reason).toBe('channelNotDeclared')
    const empty = sizeChannelStepKeys(set, 'height', 'height', Object.freeze([]), Object.freeze([]), FPS)
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error.params.reason).toBe('channelTimeAxisEmpty')
  })

  it('经通用采样器（`channelStepTrack` + `sampleChannelAt`）：帧中同值、边界取下一帧、恒为域内整数', () => {
    const set = setOf()
    const keys = sizeChannelStepKeys(set, 'height', 'height', STEPS, DURATIONS, FPS)
    expect(keys.ok).toBe(true)
    if (!keys.ok) return
    const track = channelStepTrack(set, 'height', keys.value)
    expect(track.ok, '轨道构造必须走通用构造点').toBe(true)
    if (!track.ok) return
    const sampleAt = (ms: number): number => {
      const s = sampleChannelAt(track.value, atMs(ms))
      expect(s.ok, `采样 ${ms}ms 必须成功`).toBe(true)
      if (!s.ok) throw new Error('unreachable')
      return s.value as number
    }
    // 帧中 = 本帧的值（阶跃，不是插值）
    expect(sampleAt(50), '帧 0 中点 ⇒ stepIndex 0 的值').toBe(1)
    expect(sampleAt(150), '帧 1 中点 ⇒ stepIndex 1 的值').toBe(2)
    expect(sampleAt(250), '帧 2 中点 ⇒ stepIndex 0 的值（与帧 0 同阶 ⇒ 同值）').toBe(1)
    expect(sampleAt(350), '帧 3 中点 ⇒ stepIndex 2 的值').toBe(3)
    // 边界 = 下一帧（半开区间 `[start, start+dur)`）
    expect(sampleAt(100), '100ms 是帧 1 的起点 ⇒ 取帧 1 的值').toBe(2)
    expect(sampleAt(200), '200ms 是帧 2 的起点 ⇒ 取帧 2 的值').toBe(1)
    // 关键性质：**恒为域内整数** —— 线性插值会在 0..100ms 之间产出 1.5 这类域外值。
    for (let ms = 0; ms <= 400; ms += 1) {
      const v = sampleAt(ms)
      expect(Number.isInteger(v), `${ms}ms 采样出非整数 ${v}（插值冒充了阶跃）`).toBe(true)
      expect(v, `${ms}ms 采样出域外值 ${v}`).toBeGreaterThanOrEqual(1)
      expect(v).toBeLessThanOrEqual(5)
    }
  })
})
