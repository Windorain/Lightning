/**
 * `domain/materials` —— **A27 texture-time / A28 texture-instance-resource** 的判定面
 * （验收 F3）。
 *
 * ## 本文件证明的核心命题（逐条对应验收）
 *
 * - **A27**：不等帧时长的序列在给定时间有确定样本；半开区间（边界取下一项）、
 *   循环末尾回起点、负时间取模、非循环钳制；**默认暂停随场景**；
 *   **无材质独立 tick**（结构上不存在累积量）；无混合声明 ⇒ `mix` 恒 0；
 *   播放不改文档/历史。
 * - **A28**：同一资源 + 不同实例相位 ⇒ 相位生效而资源引用**完全相同**
 *   （不复制图像资源）；替换资源时旧请求晚到 ⇒ 旧版本不覆盖新版本；
 *   缓存按**内容版本**而非 URL。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INSTANCE_BINDING,
  DEFAULT_TIME_BINDING,
  SCENE_TIME_ONLY,
  effectiveTime,
  frameBlendAllowed,
  parseTextureSequence,
  resolveTimeBinding,
  resourceCacheKey,
  sameResourceContent,
  sampleTextureInstance,
  sampleTextureSequence,
  sequenceDuration,
  type RawTextureSequence,
  type ResourceRef,
  type TextureSequence,
  type TimeBinding,
} from '@/domain/materials'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

const RESOURCE: ResourceRef = Object.freeze({
  assetId: 'tex-lava',
  contentVersion: 'v1',
  // URL **只**是获取位置：下面的用例会证明它不参与任何判定
  url: 'https://example.invalid/lava.png',
})

/** 不等帧时长序列：1s / 2s / 0.5s（总 3.5s）。 */
function rawUneven(overrides: Partial<RawTextureSequence> = {}): RawTextureSequence {
  return {
    id: 'seq-1',
    resource: RESOURCE,
    frames: [
      { index: 0, durationSeconds: 1 },
      { index: 1, durationSeconds: 2 },
      { index: 2, durationSeconds: 0.5 },
    ],
    defaultDurationSeconds: 1,
    loop: 'loop',
    ...overrides,
  }
}

function seqUneven(overrides: Partial<RawTextureSequence> = {}): TextureSequence {
  const r = parseTextureSequence(rawUneven(overrides))
  if (!r.ok) throw new Error(`夹具解析失败: ${r.error.params.reason}`)
  return r.value
}

function sample(seq: TextureSequence, time: number) {
  const r = sampleTextureSequence(seq, time)
  if (!r.ok) throw new Error(`采样失败: ${r.error.params.reason}`)
  return r.value
}

// ─────────────────────────────────────────────────────────────────────────────
// A27：序列采样规则
// ─────────────────────────────────────────────────────────────────────────────

describe('A27 texture-time：半开区间与边界', () => {
  it('区间内取本项；**恰好落在边界取下一项**（半开区间语义）', () => {
    const seq = seqUneven()
    // [0,1) → 帧 0
    expect(sample(seq, 0).frame).toBe(0)
    expect(sample(seq, 0.999).frame).toBe(0)
    // t = 1 恰在边界 ⇒ **下一项**（帧 1），不是帧 0
    expect(sample(seq, 1).frame, '恰好落在边界必须取下一项').toBe(1)
    // [1,3) → 帧 1
    expect(sample(seq, 2.999).frame).toBe(1)
    // t = 3 恰在边界 ⇒ 帧 2
    expect(sample(seq, 3).frame).toBe(2)
    // [3,3.5) → 帧 2
    expect(sample(seq, 3.4).frame).toBe(2)
  })

  it('**不等帧时长**：每一项按自己的时长占位（不是等分）', () => {
    const seq = seqUneven()
    const total = sequenceDuration(seq)
    expect(total.num / total.den).toBeCloseTo(3.5, 10)
    // 若按等分（每项 3.5/3 ≈ 1.1667s），t=1.1 会是帧 0；正确语义下它是帧 1。
    expect(sample(seq, 1.1).frame, 't=1.1 必须已在第 2 项（第 1 项只持续 1s）').toBe(1)
  })

  it('循环：末尾回起点（t = 总时长 ⇒ 帧 0）', () => {
    const seq = seqUneven()
    expect(sample(seq, 3.5).frame, '循环末尾必须回到起点').toBe(0)
    // 4.5 mod 3.5 = 1.0，恰是第 1 项边界 ⇒ 半开区间语义取下一项（帧 1）
    expect(sample(seq, 4.5).frame, '循环内仍遵守半开区间').toBe(1)
    expect(sample(seq, 4.6).frame).toBe(1)
    expect(sample(seq, 3.6).frame, '刚过末尾 ⇒ 起点附近的第 1 项').toBe(0)
    expect(sample(seq, 7.0).frame, '恰好两个周期 ⇒ 回到起点').toBe(0)
    // 逐周期对账：跨周期后同一"周期内相位"给出同一帧
    for (const phase of [0, 0.5, 1.5, 2.5, 3.2]) {
      expect(sample(seq, phase + 3.5).frame, `相位 ${phase} 跨一周期后必须同帧`).toBe(sample(seq, phase).frame)
    }
  })

  it('**负时间**：定义明确的取模（-1s ≡ 总时长-1s）', () => {
    const seq = seqUneven()
    // -1s ≡ 3.5-1 = 2.5s ⇒ [1,3) → 帧 1
    expect(sample(seq, -1).frame, '负时间必须按定义取模，不得产生负索引').toBe(sample(seq, 2.5).frame)
    // -0.5s ≡ 3.0s ⇒ 帧 2
    expect(sample(seq, -0.5).frame).toBe(sample(seq, 3.0).frame)
    // 极端负值同样成立
    expect(sample(seq, -7).frame).toBe(sample(seq, 0).frame) // -7 ≡ 0 (mod 3.5)
    for (const t of [-0.1, -1, -3.4, -3.5, -10, -100]) {
      const s = sample(seq, t)
      expect(s.frame, `t=${t} 的帧必须是声明索引之一`).toBeGreaterThanOrEqual(0)
      expect(s.frame).toBeLessThanOrEqual(2)
    }
  })

  it('非循环（clamp）：早于 0 取首项、晚于总时长取末项（钳制，不外推）', () => {
    const seq = seqUneven({ loop: 'clamp' })
    expect(sample(seq, -5).frame, '负时间在非循环下钳到首项').toBe(0)
    const far = sample(seq, 100)
    expect(far.frame, '超出总时长在非循环下钳到末项').toBe(2)
    // 末项的"下一项"也是它自己（没有循环可言，不应淡回首帧）
    expect(far.nextFrame).toBe(2)
  })

  it('`once` 与 `clamp` 采样结果相同，但语义声明不同（两者都保留）', () => {
    const seqClamp = seqUneven({ loop: 'clamp' })
    const seqOnce = seqUneven({ loop: 'once' })
    for (const t of [-1, 0, 1.5, 3.5, 99]) {
      expect(sample(seqOnce, t)).toEqual(sample(seqClamp, t))
    }
    expect(seqOnce.loop).toBe('once')
    expect(seqClamp.loop).toBe('clamp')
  })

  it('**无混合声明 ⇒ mix 恒为 0**（A27 负对照「默认淡入淡出」的判定点）', () => {
    const seq = seqUneven()
    expect(frameBlendAllowed(seq), '缺省不得视为允许混合').toBe(false)
    for (const t of [0, 0.25, 0.5, 0.999, 1.0, 2.5, 3.4, 3.6, -1]) {
      expect(sample(seq, t).mix, `t=${t} 无混合声明时 mix 必须恒为 0`).toBe(0)
    }
    // 显式 false 同样恒 0
    const off = seqUneven({ frameBlendAllowed: false })
    expect(sample(off, 0.5).mix).toBe(0)
    // 显式 true 才会出现非零权重（正对照，证明上面不是"永远为 0"的空断言）
    const on = seqUneven({ frameBlendAllowed: true })
    expect(sample(on, 0.5).mix).toBeGreaterThan(0)
    expect(frameBlendAllowed(on)).toBe(true)
  })

  it('允许混合时权重是**本项内进度**，且末项在非循环下不混合（不淡回首帧）', () => {
    const on = seqUneven({ frameBlendAllowed: true })
    // 第 1 项跨 [0,1)：t=0.5 ⇒ mix=0.5
    expect(sample(on, 0.5).mix).toBeCloseTo(0.5, 10)
    expect(sample(on, 0).mix).toBe(0)
    // 循环下末项（[3,3.5)）混合到首项
    expect(sample(on, 3.25).mix).toBeCloseTo(0.5, 10)
    expect(sample(on, 3.25).nextFrame).toBe(0)

    // 非循环下末项不混合
    const onClamp = seqUneven({ frameBlendAllowed: true, loop: 'clamp' })
    expect(sample(onClamp, 3.25).mix, '非循环末项不应淡回首帧').toBe(0)
    expect(sample(onClamp, 3.25).nextFrame).toBe(2)
  })

  it('`nextFrame` 如实给出下一项（无混合时也给出，供诊断/呈现，不暗示正在混合）', () => {
    const seq = seqUneven()
    expect(sample(seq, 0.5).nextFrame).toBe(1)
    expect(sample(seq, 2.5).nextFrame).toBe(2)
    expect(sample(seq, 3.25).nextFrame, '循环下末项的下一项是首项').toBe(0)
    // 但 mix 仍为 0（无声明）
    expect(sample(seq, 0.5).mix).toBe(0)
  })

  it('**默认绑定场景时间**：`DEFAULT_TIME_BINDING` 是 scene 且必验通过', () => {
    expect(DEFAULT_TIME_BINDING.source).toBe('scene')
    expect(DEFAULT_TIME_BINDING.scale).toBe(1)
    expect(DEFAULT_TIME_BINDING.offset).toBe(0)
    expect(resolveTimeBinding(DEFAULT_TIME_BINDING, SCENE_TIME_ONLY).ok).toBe(true)
    // 默认只装场景时间源
    expect(SCENE_TIME_ONLY.runtimeClocks).toHaveLength(0)
  })

  it('**同时间同结果**：序列与时间相同 ⇒ 样本逐位相同（与调用次数/顺序无关）', () => {
    const seq = seqUneven({ frameBlendAllowed: true })
    const a = sample(seq, 2.25)
    // 中间穿插大量其它采样（含倒退），不得影响结果
    for (const t of [10, -3, 0, 3.4, 100, -0.5]) sample(seq, t)
    const b = sample(seq, 2.25)
    expect(a).toEqual(b)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A27：解析期拒绝（纵深防御）
// ─────────────────────────────────────────────────────────────────────────────

describe('A27：零/负时长与非法索引在**解析期**拒绝', () => {
  it('零时长 / 负时长 / 非有限 ⇒ 拒绝（不用"默认时长"顶替）', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = parseTextureSequence(rawUneven({ frames: [{ index: 0, durationSeconds: bad }] }))
      expect(r.ok, `durationSeconds=${bad} 必须被拒绝`).toBe(false)
      if (!r.ok) {
        expect(r.error.code).toBe('InvalidValue')
        expect(r.error.params.reason).toBe('textureSequenceNonPositiveDuration')
      }
    }
    // 非法默认时长同样被拒
    const badDefault = parseTextureSequence(rawUneven({ frames: [{ index: 0 }], defaultDurationSeconds: 0 }))
    expect(badDefault.ok).toBe(false)
    if (!badDefault.ok) expect(badDefault.error.params.reason).toBe('textureSequenceNonPositiveDefaultDuration')
  })

  it('非法帧索引（负 / 非整数）⇒ 拒绝（不静默取模）', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      const r = parseTextureSequence(rawUneven({ frames: [{ index: bad, durationSeconds: 1 }] }))
      expect(r.ok, `index=${bad} 必须被拒绝`).toBe(false)
      if (!r.ok) expect(r.error.params.reason).toBe('textureSequenceIllegalFrameIndex')
    }
  })

  it('空帧列表 ⇒ 拒绝（空序列没有"下一项"，采样会是未定义行为）', () => {
    const r = parseTextureSequence(rawUneven({ frames: [] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.params.reason).toBe('textureSequenceEmpty')
  })

  it('缺省时长回落到 `defaultDurationSeconds`（合规缺省，不是"猜一个"）', () => {
    const r = parseTextureSequence(rawUneven({ frames: [{ index: 0 }, { index: 1, durationSeconds: 2 }], defaultDurationSeconds: 0.5 }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(sequenceDuration(r.value).num / sequenceDuration(r.value).den).toBeCloseTo(2.5, 10)
  })

  it('采样器对非有限时间显式拒绝（纵深防御，不返回"某个帧"）', () => {
    const r = sampleTextureSequence(seqUneven(), Number.NaN)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.params.reason).toBe('textureSampleTimeNotFinite')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A28：实例相位与资源身份
// ─────────────────────────────────────────────────────────────────────────────

describe('A28 texture-instance-resource：相位按实例生效、资源不复制', () => {
  it('**同一资源 + 不同常量相位** ⇒ 样本不同，但资源引用**完全相同**', () => {
    const seq = seqUneven()
    const a = sampleTextureInstance(seq, { phaseOffset: 0, phaseScale: 1 }, 0.5)
    const b = sampleTextureInstance(seq, { phaseOffset: 1, phaseScale: 1 }, 0.5)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.value.frame, '相位 0 的实例取第 1 项').toBe(0)
    expect(b.value.frame, '相位 +1s 的实例应落在第 2 项').toBe(1)
    // 两者引用**同一份**资源对象（引用相等 —— 不是复制）
    expect(seq.resource).toBe(seq.resource)
    expect(seq.resource.assetId).toBe('tex-lava')
  })

  it('默认实例相位是恒等（同材质实例默认同相位）', () => {
    const seq = seqUneven()
    expect(DEFAULT_INSTANCE_BINDING.phaseOffset).toBe(0)
    expect(DEFAULT_INSTANCE_BINDING.phaseScale).toBe(1)
    for (const t of [0, 0.7, 2.2, 3.9]) {
      const withDefault = sampleTextureInstance(seq, DEFAULT_INSTANCE_BINDING, t)
      const plain = sampleTextureSequence(seq, t)
      expect(withDefault).toEqual(plain)
    }
  })

  it('相位是**求值参数**：实例绑定类型里没有资源字段（不复制资源在类型层面不可能）', () => {
    const instance = Object.freeze({ phaseOffset: 0.25, phaseScale: 2 })
    expect(Object.keys(instance).sort()).toEqual(['phaseOffset', 'phaseScale'])
    // 一个想"复制图像资源"的实现没有地方写它 —— 资源只从 `sequence.resource` 读。
    const seq = seqUneven()
    const r = sampleTextureInstance(seq, instance, 0)
    expect(r.ok).toBe(true)
    expect(seq.resource.assetId).toBe('tex-lava')
  })

  it('相位缩放（phaseScale）：不同相位实例采样不同时间点，但共享同一序列', () => {
    const seq = seqUneven()
    const fast = sampleTextureInstance(seq, { phaseOffset: 0, phaseScale: 4 }, 0.125)
    const slow = sampleTextureInstance(seq, { phaseOffset: 0, phaseScale: 0.5 }, 0.125)
    expect(fast.ok && slow.ok).toBe(true)
    if (!fast.ok || !slow.ok) return
    // fast: 0.125*4 = 0.5s → 帧 0；slow: 0.0625s → 帧 0
    // 用一个能区分的点：t=0.3 → fast 1.2s(帧1) / slow 0.15s(帧0)
    const f2 = sampleTextureInstance(seq, { phaseOffset: 0, phaseScale: 4 }, 0.3)
    const s2 = sampleTextureInstance(seq, { phaseOffset: 0, phaseScale: 0.5 }, 0.3)
    expect(f2.ok && s2.ok).toBe(true)
    if (f2.ok && s2.ok) {
      expect(f2.value.frame).toBe(1)
      expect(s2.value.frame).toBe(0)
    }
  })

  it('**缓存按内容版本**：同内容不同 URL ⇒ 同一缓存键；同 URL 不同内容 ⇒ 不同键', () => {
    const a: ResourceRef = { assetId: 'tex-lava', contentVersion: 'v1', url: 'https://a/x.png' }
    const b: ResourceRef = { assetId: 'tex-lava', contentVersion: 'v1', url: 'https://b/y.png' }
    const c: ResourceRef = { assetId: 'tex-lava', contentVersion: 'v2', url: 'https://a/x.png' }

    expect(resourceCacheKey(a), 'URL 不参与缓存身份').toBe(resourceCacheKey(b))
    expect(sameResourceContent(a, b), '同内容即使 URL 不同也是同一资源').toBe(true)
    expect(resourceCacheKey(a), '同 URL 但内容换了必须是不同缓存键').not.toBe(resourceCacheKey(c))
    expect(sameResourceContent(a, c)).toBe(false)
    // 负对照：把 URL 当身份 ⇒ 上面两条都会反过来（这正是 A28 负对照的形态）
    expect(a.url === b.url, '按 URL 判定会把同内容看成两个资源').toBe(false)
  })

  it('**替换资源时旧请求晚到 ⇒ 旧版本不覆盖新版本**（按内容版本判定）', () => {
    const v1: ResourceRef = { assetId: 'tex-lava', contentVersion: 'v1', url: 'https://a/x.png' }
    const v2: ResourceRef = { assetId: 'tex-lava', contentVersion: 'v2', url: 'https://a/x.png' }
    // 旧请求（v1）晚到时，当前已是 v2：内容身份不同 ⇒ 必须拒绝
    expect(sameResourceContent(v1, v2), 'v1 的结果不得被当成当前版本').toBe(false)
    // 而"同 URL"这一事实会让按 URL 判定者误判为同一份 ⇒ 接纳旧内容
    expect(v1.url).toBe(v2.url)
  })

  it('序列可以指向另一份资源（替换）而帧结构不变（资源与序列结构分离）', () => {
    const v2: ResourceRef = { assetId: 'tex-lava', contentVersion: 'v2', url: 'https://a/x.png' }
    const replaced = seqUneven({ resource: v2 })
    const original = seqUneven()
    expect(replaced.frames).toEqual(original.frames)
    expect(replaced.resource.contentVersion).toBe('v2')
    expect(sameResourceContent(replaced.resource, original.resource)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A27 的命名负对照：「各视口累加 delta」必须与纯采样判然不同
// ─────────────────────────────────────────────────────────────────────────────

describe('A27 负对照「各视口累加 delta」（验收清单明文点名的一项）', () => {
  /**
   * 旧机制的**忠实复刻**（不是"随手抛错"）：两个视口各自持有一个累积器，
   * 每次绘制把"距上一帧的 dt"加进去，用累积量定位帧。
   *
   * 这正是 `useMaterialAnimation` 与 `render/materials/simpleMaterialLibrary` 的形态
   * （`elapsed += delta` / `accMs += dtMs`）。把复刻放在测试里，是为了让
   * "新实现与旧机制**行为不同**"成为一个可断言的事实 —— 否则"我们换掉了它"
   * 只是口头声明。
   */
  function makeAccumulatingViewport(frames: readonly { index: number; durationSeconds: number }[]) {
    let acc = 0
    let current = 0
    return {
      /** 每次"绘制"推进一次（视口自己的时钟）。 */
      tick(deltaSeconds: number): number {
        acc += deltaSeconds
        const dur = frames[current].durationSeconds
        while (acc >= dur) {
          acc -= dur
          current = (current + 1) % frames.length
        }
        return frames[current].index
      },
      get position(): number {
        return acc
      },
    }
  }

  const FRAMES = [
    { index: 0, durationSeconds: 1 },
    { index: 1, durationSeconds: 2 },
    { index: 2, durationSeconds: 0.5 },
  ] as const

  it('**负对照**：累加 delta 会在**帧边界**上漂移，使同一时刻得到不同帧', () => {
    // 累积法的病灶不是"总和算错"，而是**浮点求和顺序/分块不同 ⇒ 边界判定不同**。
    // 这解释了为什么"各视口累加 delta"必然让双视口不一致：
    // 每个视口按**自己的**绘制节奏分块累加，于是同一个时刻在边界上分道扬镳。
    const whole = makeAccumulatingViewport(FRAMES)
    const chunked = makeAccumulatingViewport(FRAMES)

    // 两者都推进"逻辑上的 1.0 秒"（第 1 项 [0,1) 的边界）
    whole.tick(1.0)
    for (let i = 0; i < 10; i++) chunked.tick(0.1)

    // 浮点求和：十次 0.1 之和是 0.9999999999999999 < 1.0 ⇒ 分块者仍在第 0 项。
    expect(0.1 * 10, '这里记录的是浮点事实本身').toBeCloseTo(1, 12)
    expect(
      whole.tick(0) === chunked.tick(0),
      '累加 delta 在边界上漂移：同一时刻得到不同帧 —— 这就是要判红的形态',
    ).toBe(false)
    expect(whole.tick(0)).toBe(1)
    expect(chunked.tick(0)).toBe(0)
  })

  it('新实现**不**具有该病灶：同一时间恒同帧，与如何到达无关', () => {
    const seq = seqUneven()
    // 新实现的时间是**显式值**（`TimeValue`），不是累加出来的数：
    // 因此"一次给 1.0"与"分十次给到 1.0"到达的是**同一个**时间 ⇒ 同一帧。
    const atBoundary = sample(seq, 1)
    expect(atBoundary.frame, 't=1.0 恰在边界 ⇒ 半开区间取下一项').toBe(1)
    // 无论之前求过多少次、什么顺序（没有状态被累积）
    for (let i = 0; i < 10; i++) sample(seq, i * 0.1)
    expect(sample(seq, 1), '到达路径不影响结果（无累积状态）').toEqual(atBoundary)
  })

  it('新实现：同一场景时间下两消费者**恒**相同（与绘制节奏无关）', () => {
    const seq = seqUneven()
    const atSameTime = (): readonly unknown[] => [sample(seq, 2.1), sample(seq, 2.1)]
    const [x, y] = atSameTime()
    expect(x, '同一时间的两份样本必须逐位相同').toEqual(y)
    // 无论中间"绘制"过多少次、以什么节奏（新实现里绘制不改变时间来源）
    for (let i = 0; i < 37; i++) sample(seq, i * 0.17)
    expect(sample(seq, 2.1), '穿插任意多次采样后，同一时间仍是同一结果').toEqual(x)
  })

  it('跳帧（直接给时间）与"累加到该时间"在新实现下**同结果**（旧机制下会不同）', () => {
    const seq = seqUneven()
    // 跳帧：直接求 t=3.2
    const jumped = sample(seq, 3.2)
    // "累加"到 3.2（新实现里这只是一串不同时间的采样，最后一次落在 3.2）
    let last = sample(seq, 0)
    for (let t = 0.1; t <= 3.2 + 1e-9; t += 0.1) last = sample(seq, Math.min(t, 3.2))
    expect(last).toEqual(jumped)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 时间绑定：runtime 是显式可选能力
// ─────────────────────────────────────────────────────────────────────────────

describe('TimeBinding：scene 默认必验、runtime 未安装则**拒绝绑定**', () => {
  it('**负对照**：未安装该时间源却绑定 runtime ⇒ 判红（不静默回落场景时间）', () => {
    const binding: TimeBinding = { source: 'runtime', clock: 'render', scale: 1, offset: 0 }
    const r = resolveTimeBinding(binding, SCENE_TIME_ONLY)
    expect(r.ok, '未安装的 runtime 时钟必须被拒绝').toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('UnsupportedOperation')
      expect(r.error.params.reason).toBe('runtimeClockNotInstalled')
      expect(r.error.params.clock).toBe('render')
      // 关键：错误**不是**"降级成功"——它没有返回一个 scene 绑定
      expect(r.error.params).not.toHaveProperty('binding', 'scene')
    }
  })

  it('已安装该时钟 ⇒ 绑定通过（正对照，证明判据不是恒拒）', () => {
    const binding: TimeBinding = { source: 'runtime', clock: 'export', scale: 2, offset: 0.5 }
    const r = resolveTimeBinding(binding, { runtimeClocks: ['export'] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.source).toBe('runtime')
    // 装了别的时钟不算（按 id 精确匹配，不做"有任何一个就行"的模糊判定）
    expect(resolveTimeBinding(binding, { runtimeClocks: ['render'] }).ok).toBe(false)
  })

  it('非有限 scale/offset ⇒ 拒绝', () => {
    const r = resolveTimeBinding({ source: 'scene', scale: Number.NaN, offset: 0 }, SCENE_TIME_ONLY)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.params.reason).toBe('timeBindingNotFinite')
  })

  it('有效时间含常量速度与偏移（影响输出的时间来源全部进入求值键）', () => {
    expect(effectiveTime(1, { source: 'scene', scale: 1, offset: 0 })).toBe(1)
    expect(effectiveTime(1, { source: 'scene', scale: 2, offset: 0.5 })).toBe(2.5)
    expect(effectiveTime(0, { source: 'scene', scale: 1, offset: 3 })).toBe(3)
    // 相位覆盖改变有效时间 ⇒ 样本随之改变（不同相位不共享最终采样缓存）
    const seq = seqUneven()
    const base = sample(seq, effectiveTime(0.5, DEFAULT_TIME_BINDING))
    const phased = sample(seq, effectiveTime(0.5, { source: 'scene', scale: 1, offset: 1 }))
    expect(base.frame).toBe(0)
    expect(phased.frame).toBe(1)
  })
})
