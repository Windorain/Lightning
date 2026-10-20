/**
 * G7 / #388 R2-①：纹理**相位**进求值键 —— 判据 + 负对照。
 *
 * ## 断言面全部是**生产函数**（无替身、无 Mock）
 *
 * | 判据 | 读面（生产导出） | 区分力来源 |
 * |---|---|---|
 * | ①求值键 | `structuralKeyOf` / `structurallyEqual` / `diffEvaluationKey` | 相位维（`ph:` 段） |
 * | ②批次 | `compatibilityKeyOf` / `primitiveKeyOf` / `planBatches` | 相位段 + 批次数 |
 * | ③材质缓存（**可观察行为**） | `BatchedPresenter#statsSnapshot().materialBuilds/materialReuses` | 相位不同的材质**不得**共享 GPU 材质条目 |
 * | ④缺省 ≠ 第 0 帧 | `materialIdentityOf` / `textureBindingKey` / ③的计数 | `undefined` 与 `{0,1}` 是两个求值输入 |
 *
 * ## 两条负对照
 *
 *  - **in-test（键集敏感度）**：把相位**从输入里去掉** ⇒ 两个键退回相等（`ph:` 段是全部区分力）；
 *  - **机械注入**：`temp/inject-phase-blind.mjs` 把 `texturePhaseKeyOf` 的显式分支退回恒
 *    `'-'`（即"相位维从键里去掉"）⇒ 本文件必须**判红**，脚本复述该结果。
 *
 * ## 为什么"缺省 ≠ 第 0 帧"要落在键/计数上而不是采样数值上
 *
 * `{ phaseOffset: 0, phaseScale: 1 }` 的采样结果与"无相位"**数值相同**（乘 1、加 0）—— 于是
 * 用像素/帧号无法区分二者。但它是**不同的求值输入**：归一成 `{0,1}` 会让"该材质是否声明了
 * 相位"在键里消失，之后任何按相位分开的求值/失效都不可计算。故本条判据的读面是
 * 缓存条目与批次（可观察），不是帧号。
 */

import { describe, expect, it } from 'vitest'
import {
  EMPTY_EVALUATION_KEY,
  EVALUATION_KEY_DIMENSIONS,
  diffEvaluationKey,
  structurallyEqual,
  structuralKeyOf,
  texturePhaseKeyOf,
  type EvaluationKey,
  type MaterialDescriptor,
} from '../evaluationKey'
import { DEFAULT_BATCH_BUDGET, compatibilityKeyOf, planBatches, primitiveKeyOf } from '../batchPlan'
import { compileScene } from '../compileScene'
import { BatchedPresenter, materialIdentityOf } from '../presenter'
import { bindTexture, sampleBoundTexture, textureBindingKey } from '../textureBinding'
import { parseTextureSequence, sampleTextureInstance, sampleTextureSequence } from '@/domain/materials'
import {
  DEFAULT_MATERIAL,
  MemoryGeometrySource,
  makeAttributes,
  makeKey,
  makePrimitive,
} from './fixtures'

/** 显式**第 0 相位**（原速、零偏移）—— 与"缺席"不是同一个值。 */
const PHASE_ZERO = Object.freeze({ phaseOffset: 0, phaseScale: 1 })
/** 另一相位（半周期偏移 + 2 倍速）—— 与 PHASE_ZERO 采样到不同帧。 */
const PHASE_SHIFT = Object.freeze({ phaseOffset: 0.5, phaseScale: 2 })

/** 相位字段**条件展开**：缺席就是缺席（不写 `texturePhase: undefined`）。 */
function materialWith(phase?: { phaseOffset: number; phaseScale: number }): MaterialDescriptor {
  const base: MaterialDescriptor = { ...DEFAULT_MATERIAL }
  return phase === undefined ? base : { ...base, texturePhase: phase }
}

function sequenceOf() {
  const parsed = parseTextureSequence({
    id: 'tex:anim',
    resource: { assetId: 'tex:anim', contentVersion: 'v1', url: 'mem://tex:anim' },
    frames: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }],
    defaultDurationSeconds: 0.5,
    loop: 'loop',
    frameBlendAllowed: false,
  })
  if (!parsed.ok) throw new Error('序列夹具解析失败')
  return parsed.value
}

describe('① 相位进求值键：维数、序列化与差分', () => {
  it('机械读数：`EVALUATION_KEY_DIMENSIONS` 由六维变七维，末维是 `texturePhase`', () => {
    expect(EVALUATION_KEY_DIMENSIONS).toHaveLength(7)
    expect(EVALUATION_KEY_DIMENSIONS[6]).toBe('texturePhase')
    // 前六维逐字不变（纯增，不重排）
    expect(EVALUATION_KEY_DIMENSIONS.slice(0, 6)).toEqual([
      'documentVersion',
      'scene',
      'time',
      'parameterVersion',
      'stagedTransactionVersion',
      'contentResourceVersions',
    ])
  })

  it('相位序列化：缺席 = `-`，显式 `{0,1}` = `0/1`，非平凡 = `<offset>/<scale>`', () => {
    expect(texturePhaseKeyOf(undefined)).toBe('-')
    expect(texturePhaseKeyOf(PHASE_ZERO)).toBe('0/1')
    expect(texturePhaseKeyOf(PHASE_SHIFT)).toBe('0.5/2')
  })

  it('**正判据 ①**：两键仅相位不同 ⇒ 结构键不同、不等价、差分恰为 `texturePhase`', () => {
    const noPhase: EvaluationKey = { ...EMPTY_EVALUATION_KEY }
    const zeroPhase: EvaluationKey = { ...EMPTY_EVALUATION_KEY, texturePhase: PHASE_ZERO }
    const shiftPhase: EvaluationKey = { ...EMPTY_EVALUATION_KEY, texturePhase: PHASE_SHIFT }

    expect(structuralKeyOf(noPhase), '缺省相位与第 0 相位不得同键').not.toBe(structuralKeyOf(zeroPhase))
    expect(structuralKeyOf(zeroPhase)).not.toBe(structuralKeyOf(shiftPhase))
    expect(structurallyEqual(noPhase, zeroPhase)).toBe(false)
    expect(diffEvaluationKey(noPhase, zeroPhase)).toEqual(['texturePhase'])
    expect(diffEvaluationKey(zeroPhase, shiftPhase)).toEqual(['texturePhase'])
    // 相位相同 ⇒ 六维相同 ⇒ 仍等价（不得因增维把一切都判成不同）
    expect(structurallyEqual(zeroPhase, { ...EMPTY_EVALUATION_KEY, texturePhase: PHASE_ZERO })).toBe(true)
    // 主键末尾真的是相位段（"进了键"，不是只存在于字段里）
    expect(structuralKeyOf(noPhase).endsWith('|ph:-')).toBe(true)
    expect(structuralKeyOf(zeroPhase).endsWith('|ph:0/1')).toBe(true)
  })

  it('**正判据 ②**：两图元仅相位不同 ⇒ 兼容性键/成员键不同，且分成 2 个批次（不合批）', () => {
    const plain = makePrimitive('obj:a', { material: materialWith(undefined) })
    const phased = makePrimitive('obj:b', { material: materialWith(PHASE_ZERO) })

    expect(compatibilityKeyOf(plain)).not.toBe(compatibilityKeyOf(phased))
    expect(primitiveKeyOf(plain)).not.toBe(primitiveKeyOf(phased))
    // 兼容性键的差别必须**只**来自相位段（其余七段逐字相同）
    const stripPhase = (k: string): string => k.slice(0, k.lastIndexOf('|ph:'))
    expect(stripPhase(compatibilityKeyOf(plain))).toBe(stripPhase(compatibilityKeyOf(phased)))

    const plan = planBatches([plain, phased], DEFAULT_BATCH_BUDGET)
    expect(plan, '相位不同的图元不得合进同一批次').toHaveLength(2)
    // 相位相同 ⇒ 合批（不得把增维做成"永不合并"）
    expect(planBatches([plain, makePrimitive('obj:c', { material: materialWith(undefined) })]).length).toBe(1)
  })
})

describe('③ 相位进**材质缓存条目**（可观察行为面：presenter 统计）', () => {
  function sceneOf(material: MaterialDescriptor) {
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(1))
    const compiled = compileScene({
      key: makeKey(),
      geometry,
      primitives: [makePrimitive('obj:only', { material })],
    })
    if (!compiled.ok) throw new Error('夹具编译失败')
    return compiled.value
  }

  it('**正判据 ③**：仅相位不同（缺席 vs 第 0 相位）⇒ materialBuilds 1→2、reuses 0', () => {
    const presenter = new BatchedPresenter({ scope: 'phase-cache-scope' })
    presenter.apply(sceneOf(materialWith(undefined)))
    const afterAbsent = presenter.statsSnapshot()
    expect(afterAbsent.materialBuilds).toBe(1)

    presenter.apply(sceneOf(materialWith(PHASE_ZERO)))
    const afterZero = presenter.statsSnapshot()
    expect(
      afterZero.materialBuilds,
      '缺省相位（无相位动画）不得复用"第 0 相位"的 GPU 材质条目',
    ).toBe(2)
    expect(afterZero.materialReuses, '缺省相位不得命中第 0 相位的缓存').toBe(0)

    // 反向：同相位再次 apply ⇒ 不得新增材质构建（本判据不是"永远判不同"）。
    // 注：重复 apply 同一世代时复用可能在**批次层**短路（`batchReuses`），故这里只钉
    // "材质构建数不增"这一条，不断言 `materialReuses` 的具体来源。
    presenter.apply(sceneOf(materialWith(PHASE_ZERO)))
    expect(presenter.statsSnapshot().materialBuilds).toBe(2)
    presenter.dispose()
  })

  it('相位身份与绑定键：`materialIdentityOf` / `textureBindingKey` 都把相位算进去', () => {
    const absent = materialWith(undefined)
    const zero = materialWith(PHASE_ZERO)
    const shift = materialWith(PHASE_SHIFT)

    expect(materialIdentityOf(absent).id).not.toBe(materialIdentityOf(zero).id)
    expect(materialIdentityOf(zero).id).not.toBe(materialIdentityOf(shift).id)
    expect(textureBindingKey(bindTexture(absent, null))).not.toBe(textureBindingKey(bindTexture(zero, null)))
    // 相位相同的两个材质（不同实例、逐字同值）⇒ 身份**相同**（缓存仍可合并）
    expect(materialIdentityOf(zero).id).toBe(materialIdentityOf({ ...DEFAULT_MATERIAL, texturePhase: PHASE_ZERO }).id)
    // 绑定是描述符相位的派生：缺席 ⇒ 绑定无该字段；显式 ⇒ 逐字复制
    expect(bindTexture(absent, null).texturePhase).toBeUndefined()
    expect(bindTexture(zero, null).texturePhase).toEqual(PHASE_ZERO)
  })
})

describe('④ 缺省相位（无相位动画）与"第 0 帧"不得等价 —— 与采样器的接线', () => {
  it('`sampleTextureInstance` 有了生产消费者：`sampleBoundTexture` 按三态分派', () => {
    const seq = sequenceOf()
    const absent = bindTexture(materialWith(undefined), null)
    const zero = bindTexture(materialWith(PHASE_ZERO), null)
    const shift = bindTexture(materialWith(PHASE_SHIFT), null)

    // 缺席 ⇒ 与序列直采**逐字一致**（零相位变换，而不是"乘 1 的相位路径"）
    expect(sampleBoundTexture(absent, seq, 0.7)).toEqual(sampleTextureSequence(seq, 0.7))
    // 显式 ⇒ 逐字等于 domain 的相位采样（相位语义只有一份实现）
    expect(sampleBoundTexture(zero, seq, 0.7)).toEqual(sampleTextureInstance(seq, PHASE_ZERO, 0.7))
    expect(sampleBoundTexture(shift, seq, 0.7)).toEqual(sampleTextureInstance(seq, PHASE_SHIFT, 0.7))
    // 相位真的改变采样结果（0.7s → 1.9s 落在不同帧）
    const a = sampleBoundTexture(zero, seq, 0.7)
    const b = sampleBoundTexture(shift, seq, 0.7)
    expect(a.ok && b.ok && a.value.frame !== b.value.frame).toBe(true)
  })
})

describe('负对照', () => {
  it('**负对照（键集敏感度）**：把相位从输入里去掉 ⇒ 两键退回相等（区分力全在相位段）', () => {
    const phased: EvaluationKey = { ...EMPTY_EVALUATION_KEY, texturePhase: PHASE_SHIFT }
    // "去掉相位维"的输入级等价物：同一对象把 texturePhase 缺席
    const stripped: EvaluationKey = { ...EMPTY_EVALUATION_KEY }
    expect(structuralKeyOf(phased)).not.toBe(structuralKeyOf(stripped))
    // 去掉之后退回相等 ⇒ 上面那条断言的全部区分力就是相位维
    expect(structuralKeyOf(stripped)).toBe(structuralKeyOf(EMPTY_EVALUATION_KEY))
    // 注：机械注入（`temp/inject-phase-blind.mjs` 把纹理相位的显式分支退回恒 '-'）会让
    // 本文件的正判据 ①②③ 全部判红 —— 该脚本的读数见交付报告，不在本文件里伪造。
  })

  it('**负对照（缺省 vs 第 0 帧）**：两者不得因为**采样数值相同**而被判等价', () => {
    const seq = sequenceOf()
    // 调度者修正（2026-10-14）：`materialIdentityOf(descriptor, binding?)` 的第一参是**材质描述符**，
    // 不是绑定对象（见 `presentation/presenter.ts:659` 的签名与 :661-665 的"descriptor 是权威"）。
    // 本条判据的区分力正来自 descriptor 的相位字段，故两个描述符必须留名并作为第一参传入。
    const absentDescriptor = materialWith(undefined)
    const zeroDescriptor = materialWith(PHASE_ZERO)
    const absent = bindTexture(absentDescriptor, null)
    const zero = bindTexture(zeroDescriptor, null)
    // 采样数值确实相同（乘 1 加 0）—— 这正是"只能靠键区分"的事实基础
    expect(sampleBoundTexture(absent, seq, 0.7)).toEqual(sampleBoundTexture(zero, seq, 0.7))
    // 但键/身份/绑定键三者都必须不同
    expect(texturePhaseKeyOf(undefined)).not.toBe(texturePhaseKeyOf(PHASE_ZERO))
    expect(textureBindingKey(absent)).not.toBe(textureBindingKey(zero))
    expect(materialIdentityOf(absentDescriptor, absent).id).not.toBe(materialIdentityOf(zeroDescriptor, zero).id)
  })
})
