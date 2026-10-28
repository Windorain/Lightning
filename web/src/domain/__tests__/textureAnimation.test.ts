/**
 * **纹理序列共享派生**（`domain/textureAnimation#textureAnimationOf`）。
 *
 * ## 本文件钉什么
 *
 * 派生规则每条一个用例：竖条格数、mcmeta tick 归一化（缺省 1 tick = **50 ms**）、
 * 帧索引取模、非法尺寸 ⇒ 静态、`interpolate` 忠实保留。
 *
 * ## 负对照（防"两条时间轴被统一"）
 *
 * 同一份"缺时长"的输入在两处得到**故意不同**的数：
 *  - 纹理序列 ⇒ 1 tick = 50 ms（`TEXTURE_TICK_MS`）；
 *  - 世界帧轴 `stripTimeline` ⇒ **1 ms**（`WORLD_FRAME_AXIS_FALLBACK_MS`）。
 *
 * 两者相等就说明有人"顺手统一"了缺省 —— 那会让纹理播放快 50 倍（或世界帧慢 50 倍），
 * 而所有"能采样"的断言仍会通过。故这里同时钉住。
 */
import { describe, expect, it } from 'vitest'
import { stripTimeline, WORLD_FRAME_AXIS_FALLBACK_MS } from '@/domain/materials'
import {
  TEXTURE_TICK_MS,
  TEXTURE_TICKS_PER_SECOND,
  animationSpecKey,
  sequenceKey,
  textureAnimationOf,
  type TextureAnimationInput,
} from '@/domain/textureAnimation'
import * as textureStripModule from '@/render/assets/textureStripAnimation'

const RESOURCE = Object.freeze({ assetId: 'material:0', contentVersion: 'v1', url: 'inline:0' })

/** 16×64 竖条 = 4 格（帧 0 在最上一格）。 */
function input(overrides: Partial<TextureAnimationInput> = {}): TextureAnimationInput {
  return {
    id: 'material:0',
    resource: RESOURCE,
    kind: 'animated',
    animation: null,
    width: 16,
    height: 64,
    ...overrides,
  }
}

function durationsOf(animation: NonNullable<ReturnType<typeof textureAnimationOf>>): number[] {
  return animation.sequence.frames.map((f) => f.duration.num / f.duration.den)
}

describe('纹理序列派生：格数与时长', () => {
  it('16×64 + 逐帧 ticks [2,3,1,2] ⇒ 4 格、时长 [0.1,0.15,0.05,0.1]、loop、无混合', () => {
    const binding = textureAnimationOf(
      input({
        animation: {
          defaultFrametimeTicks: 2,
          frameSequence: [
            { index: 0 },
            { index: 1, timeTicks: 3 },
            { index: 2, timeTicks: 1 },
            { index: 3, timeTicks: 2 },
          ],
        },
      }),
    )
    expect(binding, '合法竖条必须派生出绑定').not.toBeNull()
    expect(binding!.stripFrameCount).toBe(4)
    expect(durationsOf(binding!)).toEqual([0.1, 0.15, 0.05, 0.1])
    expect(binding!.sequence.loop).toBe('loop')
    expect(binding!.sequence.frameBlendAllowed === true, '未声明 interpolate ⇒ 不混合').toBe(false)
    expect(binding!.sequence.frames.map((f) => f.index)).toEqual([0, 1, 2, 3])
  })

  it('缺省 tick ⇒ **50 ms**（不是 1 ms）；timeTicks:0 / defaultFrametimeTicks:0 ⇒ 1 tick', () => {
    const noSpec = textureAnimationOf(input())
    expect(noSpec, 'animated 且无声明 ⇒ MC 默认（仍可播）').not.toBeNull()
    expect(durationsOf(noSpec!)).toEqual([0.05, 0.05, 0.05, 0.05])
    expect(TEXTURE_TICK_MS).toBe(50)
    expect(TEXTURE_TICKS_PER_SECOND).toBe(20)

    const zeroTicks = textureAnimationOf(
      input({ animation: { defaultFrametimeTicks: 0, frameSequence: [{ index: 0, timeTicks: 0 }] } }),
    )
    expect(zeroTicks, '0 tick 不得被当成 0 秒（那会让采样器判零总时长）').not.toBeNull()
    expect(durationsOf(zeroTicks!)).toEqual([0.05])

    const zeroDefault = textureAnimationOf(input({ animation: { defaultFrametimeTicks: 0 } }))
    expect(durationsOf(zeroDefault!)).toEqual([0.05, 0.05, 0.05, 0.05])
  })

  it('帧索引取模归一：index 6 ⇒ 2、index -1 ⇒ 3（适配器可做的归一化）', () => {
    const wrapped = textureAnimationOf(
      input({ animation: { frameSequence: [{ index: 6 }, { index: -1 }] } }),
    )
    expect(wrapped).not.toBeNull()
    expect(wrapped!.sequence.frames.map((f) => f.index)).toEqual([2, 3])
  })

  it('非有限索引项跳过（不猜、不顶替）', () => {
    const skipped = textureAnimationOf(
      input({ animation: { frameSequence: [{ index: Number.NaN }, { index: 1 }] } }),
    )
    expect(skipped).not.toBeNull()
    expect(skipped!.sequence.frames.map((f) => f.index)).toEqual([1])
  })

  it('穷举：归一化后序列**不可能**非法（大/负/小数索引进取模域，parse 不失败）', () => {
    for (const raw of [-1000, -1, 0, 1, 2.9, 3, 7, 1e6]) {
      const binding = textureAnimationOf(
        input({ animation: { frameSequence: [{ index: raw }], defaultFrametimeTicks: 1 } }),
      )
      expect(binding, `index=${raw} 必须得到合法绑定`).not.toBeNull()
      const idx = binding!.sequence.frames[0]!.index
      expect(Number.isInteger(idx) && idx >= 0 && idx < 4, `index=${raw} 归一化到 0..3，实得 ${idx}`).toBe(true)
    }
  })

  it('interpolate:true ⇒ frameBlendAllowed:true（忠实保留声明）', () => {
    const binding = textureAnimationOf(input({ animation: { interpolate: true } }))
    expect(binding!.sequence.frameBlendAllowed).toBe(true)
  })
})

describe('静态判定（null）', () => {
  it('高度不是宽度的整数倍 ⇒ null（不整除即静态，不是"向下取整"）', () => {
    expect(textureAnimationOf(input({ width: 16, height: 70 }))).toBeNull()
  })

  it('只有一格（n=1）⇒ null', () => {
    expect(textureAnimationOf(input({ width: 16, height: 16 }))).toBeNull()
  })

  it('kind 非 animated ⇒ null（像素是竖条也不算动画）', () => {
    expect(textureAnimationOf(input({ kind: 'static16' }))).toBeNull()
  })

  it('尺寸非法 ⇒ null', () => {
    for (const [w, h] of [
      [0, 64],
      [16, 0],
      [-16, 64],
      [16.5, 64],
      [Number.NaN, 64],
    ] as const) {
      expect(textureAnimationOf(input({ width: w, height: h })), `w=${w},h=${h}`).toBeNull()
    }
  })
})

describe('两条时间轴缺省**故意不同**（防"统一回去"）', () => {
  it('纹理缺 tick ⇒ 50 ms；世界帧轴缺 durationMs ⇒ 1 ms', () => {
    const texture = textureAnimationOf(input())
    expect(durationsOf(texture!)[0]).toBe(TEXTURE_TICK_MS / 1000)
    const axis = stripTimeline([0], [0])
    expect(axis.durationMs[0]).toBe(WORLD_FRAME_AXIS_FALLBACK_MS)
    expect(WORLD_FRAME_AXIS_FALLBACK_MS).toBe(1)
    expect(WORLD_FRAME_AXIS_FALLBACK_MS, '1 ms 与 50 ms 必须不同').not.toBe(TEXTURE_TICK_MS)
  })

  it('tick 毫秒值**单点定义**：旧适配器不再自带常量（归位）', () => {
    // 已定型：tick 的唯一写点是 `domain/textureAnimation#TEXTURE_TICK_MS`；
    // `render/assets/textureStripAnimation` 改为 import 它，不再导出自己的 50。
    // 本条是**防回流**判据：若有人把第二份常量加回去（两处静默分叉的起点），这里判红。
    expect(TEXTURE_TICK_MS).toBe(50)
    expect(
      'MINECRAFT_TICK_MS' in textureStripModule,
      'tick 常量必须只有 domain 一处定义（旧适配器不得再导出第二份）',
    ).toBe(false)
    // 行为不变：缺省帧时长仍按 domain 的常量换算。
    expect(textureStripModule.resolveAnimationTimeline({}, 1).durationMsPerFrame[0]).toBe(TEXTURE_TICK_MS)
  })
})

describe('键（绑定键 / 同步去重键）', () => {
  it('sequenceKey 含逐帧 index@duration、loop 与是否混合', () => {
    const a = textureAnimationOf(input({ animation: { defaultFrametimeTicks: 2 } }))!
    const b = textureAnimationOf(input({ animation: { defaultFrametimeTicks: 3 } }))!
    expect(sequenceKey(a.sequence)).not.toBe(sequenceKey(b.sequence))
    expect(sequenceKey(a.sequence)).toBe(sequenceKey(a.sequence))
    expect(sequenceKey(a.sequence)).toContain('loop')
    expect(sequenceKey(a.sequence)).toContain('step')
    const blended = textureAnimationOf(input({ animation: { interpolate: true } }))!
    expect(sequenceKey(blended.sequence)).toContain('blend')
  })

  it('animationSpecKey：声明不同 ⇒ 键不同；null/undefined ⇒ "-"', () => {
    expect(animationSpecKey(null)).toBe('-')
    expect(animationSpecKey(undefined)).toBe('-')
    const a = animationSpecKey({ defaultFrametimeTicks: 2 })
    const b = animationSpecKey({ defaultFrametimeTicks: 3 })
    expect(a).not.toBe(b)
    expect(animationSpecKey({ frameSequence: [{ index: 0 }] })).not.toBe(
      animationSpecKey({ frameSequence: [{ index: 0, timeTicks: 2 }] }),
    )
  })
})
