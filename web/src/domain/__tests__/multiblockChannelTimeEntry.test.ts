/**
 * **纯函数面判据**：离散通道的**通用轨道构造与采样**（`domain/multiblock`）。
 *
 * 与 `runtime/__tests__/channelTimeEntry.test.ts`（生产装配路径）的分工：
 * 本文件判**算术与值域政策**，那份判**接线与生产可达**。
 *
 * | 判据 | 防什么 |
 * |---|---|
 * | `channelSetOfDeclaration` 逐字段搬运 | 防"适配器悄悄改值域"（声明 → 求值半的唯一翻译点） |
 * | `channelStepTrack` 接受**调用方显式给的关键帧** | 防"轨道构造器偷偷从场景清单反演" |
 * | 经 `channelStepTrack` + `sampleChannelAt` 的采样恒为**域内整数** | 防线性插值冒充离散阶跃（插值会产出域外/非整数） |
 * | 本模块**不再导出** `sizeChannelStepKeys` | 防"帧清单 → 时轴关键帧"的桥回流（场景不是时间轴） |
 *
 * ## 为什么期望值在测试里独立算
 *
 * 关键帧的时刻与取值都是**本文件显式写下的输入**（不是从帧/场景清单反演），
 * 故采样期望是"输入 → 半开区间规则"的直接结果，不借助被测实现。
 */

import { describe, expect, it } from 'vitest'
import { timeValue, type TimeValue } from '@/domain/animation'
import * as multiblockDomain from '@/domain/multiblock'
import {
  channelSetOfDeclaration,
  channelStepTrack,
  findChannel,
  sampleChannelAt,
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

function setOf(): ChannelSet {
  return channelSetOfDeclaration('mb-test', CHANNELS)
}

/** 帧中（毫秒）→ 时间值：与生产 `frameIndex()` 同一「秒 → frame」换算。 */
function atMs(ms: number): TimeValue {
  return timeValue((ms / 1000) * FPS, FPS)
}

/**
 * **调用方显式给的关键帧**（每 100ms 一个，取值 = 通道 min + 一个显式台阶）。
 *
 * 它**不是**从任何帧/场景清单反演出来的：此后不存在那条桥。
 * 这里保留"台阶序列"，只为判"通用轨道构造器 + 通用采样器"的阶跃语义。
 */
const KEYS = Object.freeze([
  Object.freeze({ time: atMs(0), value: 1 }),
  Object.freeze({ time: atMs(100), value: 2 }),
  Object.freeze({ time: atMs(200), value: 1 }),
  Object.freeze({ time: atMs(300), value: 3 }),
])

describe('声明 → 通道集合（唯一翻译点）', () => {
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

describe('通用阶跃轨道（显式关键帧；不从场景清单反演）', () => {
  it('经通用采样器：帧中同值、边界取下一帧、恒为域内整数', () => {
    const set = setOf()
    const track = channelStepTrack(set, 'height', KEYS)
    expect(track.ok, '轨道构造必须走通用构造点').toBe(true)
    if (!track.ok) return
    const sampleAt = (ms: number): number => {
      const s = sampleChannelAt(track.value, atMs(ms))
      expect(s.ok, `采样 ${ms}ms 必须成功`).toBe(true)
      if (!s.ok) throw new Error('unreachable')
      return s.value as number
    }
    // 帧中 = 本键的值（阶跃，不是插值）
    expect(sampleAt(50), '0..100ms ⇒ 键 0 的值').toBe(1)
    expect(sampleAt(150), '100..200ms ⇒ 键 1 的值').toBe(2)
    expect(sampleAt(250), '200..300ms ⇒ 键 2 的值（与键 0 同值 ⇒ 阶跃而非帧号漂移）').toBe(1)
    expect(sampleAt(350), '300ms 之后 ⇒ 末键的值').toBe(3)
    // 边界 = 下一键（半开区间 `[start, start+dur)`）
    expect(sampleAt(100), '100ms 是键 1 的起点 ⇒ 取键 1 的值').toBe(2)
    expect(sampleAt(200), '200ms 是键 2 的起点 ⇒ 取键 2 的值').toBe(1)
    // 关键性质：**恒为域内整数** —— 线性插值会在 0..100ms 之间产出 1.5 这类域外值。
    for (let ms = 0; ms <= 400; ms += 1) {
      const v = sampleAt(ms)
      expect(Number.isInteger(v), `${ms}ms 采样出非整数 ${v}（插值冒充了阶跃）`).toBe(true)
      expect(v, `${ms}ms 采样出域外值 ${v}`).toBeGreaterThanOrEqual(1)
      expect(v).toBeLessThanOrEqual(5)
    }
  })

  it('轨道构造只认**通道身份**：未声明通道显式失败（不凭空造轨道）', () => {
    const set = setOf()
    const unknown = channelStepTrack(set, 'nope', KEYS)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.params.reason).toBe('channelNotDeclared')
  })

  it('**退役判据**：`domain/multiblock` 不再导出「帧清单 → 时轴关键帧」的桥', () => {
    expect(
      'sizeChannelStepKeys' in multiblockDomain,
      'M5-1：场景清单不是时间轴来源 —— 该桥不得回流（回流 = 断点①复活）',
    ).toBe(false)
  })
})
