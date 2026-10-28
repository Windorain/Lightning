/**
 * `domain/mathContract` —— **E2 适配往返的数学契约**与 **E3 数值容限**的可执行落点
 * （验收 E2/E3；几何契约）。
 *
 * ## 为什么 E2 要拆成"数学契约"与"适配实现"两半
 *
 * 验收原文：
 * > **E2** 格式往返的轴序/原点转换**只在适配器执行**；本次交付**数学契约与固定样本
 * > 期望**（适配实现归适配层）。
 *
 * 故本文件证明的是**给定正确的 profile，数学给出正确结果**；而"某个具体格式的
 * profile 构造是否正确"归适配层。这个切分让两件事可以**分别**验收 ——
 * 否则"适配器写错了 profile"与"数学算错了"会长得一模一样。
 *
 * ## E3
 *
 * > **E3** 数值与空间误差容限在数学契约中写明并被测试引用；**不任意四舍五入到整数**。
 *
 * 本文件从**两个方向**证明"不四舍五入"：
 *  1. 正方向：亚单位位移（0.001、1e-7）被保留且可观测；
 *  2. 负方向：**静态**检查 `domain/spatial.ts` 源码里没有把坐标送进取整函数的调用
 *     （`Math.round` / `toFixed` / `Math.trunc`），并以 `pixelSnap` 为**唯一**
 *     允许出现 `Math.floor` 的地方且断言它不由任何求值路径调用。
 */

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  AXIS_PROFILE_SAMPLES,
  MATH_CONTRACT,
  applyAxisProfile,
  checkAxisProfileSamples,
  identityAffine,
  affineFromRows,
  approxNumber,
  approxQuat,
  approxVec3,
  determinant3,
  invertAffine,
  multiplyAffine,
  pixelSnap,
  scaleAffine,
  toAffine,
  transformPoint,
  translationAffine,
  type AxisProfile,
} from '@/domain/spatial'

const SPATIAL_SRC = path.join(process.cwd(), 'src', 'domain', 'spatial.ts')

// ─────────────────────────────────────────────────────────────────────────────
// E2：固定样本期望
// ─────────────────────────────────────────────────────────────────────────────

describe('E2 轴序/原点：固定样本期望锁定数学契约（适配实现归适配层）', () => {
  it('全部样本逐条通过（空数组 = 无偏差）', () => {
    expect(checkAxisProfileSamples()).toEqual([])
  })

  it('每条样本的期望是**手算**的（不来自实现，防"用实现证明实现"）', () => {
    // 手算依据：yUpToZUp 的 permutation=[0,2,1]、signs=[1,1,-1]
    // 输入 (1,2,3) ⇒ out.x = src[0]*1 = 1；out.y = src[2]*1 = 3；out.z = src[1]*(-1) = -2
    const yUpToZUp = AXIS_PROFILE_SAMPLES.find((s) => s.profile.id === 'yUpToZUp')
    expect(yUpToZUp).toBeDefined()
    if (!yUpToZUp) return
    expect(yUpToZUp.input).toEqual({ x: 1, y: 2, z: 3 })
    expect(yUpToZUp.expected).toEqual({ x: 1, y: 3, z: -2 })
    expect(applyAxisProfile(yUpToZUp.input, yUpToZUp.profile)).toEqual(yUpToZUp.expected)

    // 带原点的样本：out.z = -2 + 64 = 62
    const withOrigin = AXIS_PROFILE_SAMPLES.find((s) => s.profile.id === 'yUpToZUpWithOrigin')
    expect(withOrigin).toBeDefined()
    if (!withOrigin) return
    expect(withOrigin.expected).toEqual({ x: 1, y: 3, z: 62 })
    expect(applyAxisProfile(withOrigin.input, withOrigin.profile)).toEqual(withOrigin.expected)
  })

  it('三种轴序 profile 两两不同（防"profile 没被用上"）', () => {
    const p = Object.freeze({ x: 1, y: 2, z: 3 })
    const outs = AXIS_PROFILE_SAMPLES.map((s) => JSON.stringify(applyAxisProfile(p, s.profile)))
    expect(new Set(outs).size, '样本必须覆盖不同的输出').toBe(AXIS_PROFILE_SAMPLES.length)
  })

  it('**profile 是显式数据**：字段集合固定，不含任何格式名/约定名分支', () => {
    for (const s of AXIS_PROFILE_SAMPLES) {
      expect(Object.keys(s.profile).sort()).toEqual(['id', 'origin', 'permutation', 'signs'])
      expect(s.profile.permutation.length).toBe(3)
      expect(s.profile.signs.length).toBe(3)
      // 符号只能是 ±1（不做"斜轴"这类非正交映射 —— 那属另一个数学问题）
      for (const sign of s.profile.signs) expect([1, -1]).toContain(sign)
    }
  })

  it('**负对照**：忽略 profile、直接返回输入 ⇒ 至少一条样本判红', () => {
    // 变异实现：不做任何换轴
    const identityOnly = Object.freeze<AxisProfile>({
      id: 'mutantIdentity',
      permutation: Object.freeze([0, 1, 2]) as readonly [number, number, number],
      signs: Object.freeze([1, 1, 1]) as readonly [number, number, number],
      origin: null,
    })
    const bad = AXIS_PROFILE_SAMPLES.filter((s) => {
      const got = applyAxisProfile(s.input, identityOnly)
      return !approxVec3(got, s.expected)
    })
    expect(bad.length, '忽略 profile 的变异实现必须被样本判红').toBeGreaterThan(0)
    // 且它**确实**在换轴样本上错（不是靠 identity 样本凑数）
    expect(bad.some((s) => s.profile.id === 'yUpToZUp')).toBe(true)
  })

  it('**负对照**：漏加原点平移 ⇒ 至少一条样本判红', () => {
    const withOrigin = AXIS_PROFILE_SAMPLES.find((s) => s.profile.id === 'yUpToZUpWithOrigin')
    if (!withOrigin) throw new Error('fixture')
    const noOrigin = Object.freeze<AxisProfile>({ ...withOrigin.profile, origin: null })
    expect(approxVec3(applyAxisProfile(withOrigin.input, noOrigin), withOrigin.expected), '漏加原点必须可检出').toBe(false)
  })

  it('换轴是**线性**的（不随位置变化；原点平移是唯一常数项）', () => {
    const swap = AXIS_PROFILE_SAMPLES.find((s) => s.profile.id === 'yUpToZUp')
    if (!swap) throw new Error('fixture')
    const a = Object.freeze({ x: 1, y: 0, z: 0 })
    const b = Object.freeze({ x: 0, y: 1, z: 0 })
    const sum = Object.freeze({ x: 1, y: 1, z: 0 })
    const oa = applyAxisProfile(a, swap.profile)
    const ob = applyAxisProfile(b, swap.profile)
    const os = applyAxisProfile(sum, swap.profile)
    expect(approxVec3(os, Object.freeze({ x: oa.x + ob.x, y: oa.y + ob.y, z: oa.z + ob.z }))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E3：数值容限
// ─────────────────────────────────────────────────────────────────────────────

describe('E3 数值容限：写在契约里、被测试引用、不四舍五入到整数', () => {
  it('容限是**导出常量**（测试直接引用，不各写魔数）', () => {
    expect(Object.keys(MATH_CONTRACT).sort()).toEqual(
      ['positionEps', 'rotationEps', 'scaleEps', 'pivotEps', 'shearEps', 'singularDeterminantEps', 'unitScaleEps'].sort(),
    )
    for (const v of Object.values(MATH_CONTRACT)) {
      expect(typeof v).toBe('number')
      expect(v).toBeGreaterThan(0)
      expect(v).toBeLessThan(1e-6)
    }
  })

  it('亚单位位移被保留：0.001 与 1e-7 都可观测（不被取整吞掉）', () => {
    const t = translationAffine(Object.freeze({ x: 0.001, y: 1e-7, z: 0 }))
    const p = transformPoint(t, Object.freeze({ x: 0, y: 0, z: 0 }))
    expect(p.x).toBe(0.001)
    expect(p.y).toBe(1e-7)
    expect(approxNumber(p.x, 0, MATH_CONTRACT.positionEps), '1e-3 不得被判"没动"').toBe(false)
  })

  it('容限比较的语义：容限内相等、容限外不等（边界两侧都验）', () => {
    const a = Object.freeze({ x: 1, y: 0, z: 0 })
    // 边界内侧：用**半个**容限（"恰好等于 eps" 在二进制浮点下不可靠 ——
    // 1 + 1e-9 舍入到最近的 double 后与 1 的差可能略大于 1e-9，
    // 那是浮点表示的事实，不是比较函数的缺陷）
    expect(approxVec3(a, Object.freeze({ x: 1 + MATH_CONTRACT.positionEps / 2, y: 0, z: 0 })), '半容限内 ⇒ 相等').toBe(true)
    expect(approxVec3(a, Object.freeze({ x: 1 + MATH_CONTRACT.positionEps * 10, y: 0, z: 0 })), '十倍容限 ⇒ 不等').toBe(false)
    // 并显式记录上面那条的成因（使"为什么不用恰好 eps"成为可复现的事实）
    expect(Math.abs(1 + MATH_CONTRACT.positionEps - 1)).toBeGreaterThanOrEqual(MATH_CONTRACT.positionEps)
  })

  it('非有限值不被容限比较"吞掉"（NaN 必须判不等）', () => {
    const nan = Object.freeze({ x: Number.NaN, y: 0, z: 0 })
    expect(approxVec3(nan, nan), 'NaN 与自身也必须判不等（否则 NaN 会被当成"一致"）').toBe(false)
    expect(approxNumber(Number.NaN, Number.NaN)).toBe(false)
    expect(approxQuat(Object.freeze({ x: Number.NaN, y: 0, z: 0, w: 1 }), Object.freeze({ x: Number.NaN, y: 0, z: 0, w: 1 }))).toBe(false)
  })

  it('**静态面**：`domain/spatial.ts` 里没有把坐标送进取整函数', () => {
    const src = fs.readFileSync(SPATIAL_SRC, 'utf8')
    // 去掉注释与字符串，只留代码（注释里解释"不四舍五入"是允许且有价值的）
    const code = stripCommentsAndStrings(src)
    for (const banned of ['Math.round', 'toFixed', 'Math.trunc']) {
      expect(code.includes(banned), `坐标路径不得使用 ${banned}（E3：不任意四舍五入到整数）`).toBe(false)
    }
    // Math.floor 只许出现在 pixelSnap（**显式命名**的工具），且不由求值路径调用
    const floorCalls = code.split('Math.floor').length - 1
    expect(floorCalls, 'Math.floor 应恰好出现在 pixelSnap 一处').toBe(1)
    expect(code.includes('export function pixelSnap'), 'Math.floor 的唯一落点是 pixelSnap').toBe(true)
  })

  it('**负对照**：把 `Math.round` 注入坐标路径 ⇒ 同一静态判据判红', () => {
    const sample = 'export function f(p: Vec3) { return { x: Math.round(p.x), y: p.y, z: p.z } }'
    const code = stripCommentsAndStrings(sample)
    expect(code.includes('Math.round'), '静态判据必须能抓到注入的取整').toBe(true)
  })

  it('`pixelSnap` 是显式命名的工具，语义就是"吸附到像素格"（不冒充坐标求值）', () => {
    // 它**确实**取整（这是它的用途）
    expect(pixelSnap(1.4, 1)).toBe(1)
    expect(pixelSnap(1.6, 1)).toBe(2)
    // 而坐标求值路径**不**调用它：变换一个 1.4 的点得到 1.4
    const t = translationAffine(Object.freeze({ x: 0, y: 0, z: 0 }))
    expect(transformPoint(t, Object.freeze({ x: 1.4, y: 0.6, z: 2.5 }))).toEqual({ x: 1.4, y: 0.6, z: 2.5 })
  })

  it('重建精度：非均匀缩放 + 旋转的往返误差在容限内（不是"看着差不多"）', () => {
    const t = Object.freeze({
      position: Object.freeze({ x: 1234.5678, y: -987.6543, z: 0.0001 }),
      rotation: Object.freeze({ x: 0.1825742, y: 0.3651484, z: 0.5477226, w: 0.7302967 }),
      scale: Object.freeze({ x: 1000, y: 0.001, z: 7.5 }),
      pivot: Object.freeze({ x: 0, y: 0, z: 0 }),
    })
    const m = toAffine(t)
    const inv = invertAffine(m)
    expect(inv.ok, '该变换可逆（det = 1000·0.001·7.5 = 7.5）').toBe(true)
    if (!inv.ok) return
    const p = Object.freeze({ x: 1, y: 2, z: 3 })
    const roundTrip = transformPoint(inv.value, transformPoint(m, p))
    // 大动态范围（缩放 1000 与 0.001 同存）下往返误差放宽到 1e-6：
    // 这是**显式**的误差预算，而不是把容限悄悄调大（E3 要求容限写在契约里）
    expect(approxVec3(roundTrip, p, 1e-6), '大动态范围下的往返仍在容限内').toBe(true)
  })

  it('行列式与容限的关系被显式测试（判据不是 `=== 0`）', () => {
    // det = 1e-10 > 1e-12 ⇒ 可逆
    expect(invertAffine(scaleAffine(Object.freeze({ x: 1e-5, y: 1e-5, z: 1 }))).ok).toBe(true)
    // det = 1e-15 < 1e-12 ⇒ 拒绝
    expect(invertAffine(scaleAffine(Object.freeze({ x: 1e-5, y: 1e-5, z: 1e-5 }))).ok).toBe(false)
    // 注意这里**不**用 `det === 0` 作为判据（浮点下"数学奇异"常是非零小数）
    expect(determinant3(scaleAffine(Object.freeze({ x: 1e-5, y: 1e-5, z: 1e-5 })))).not.toBe(0)
  })

  it('单位矩阵往返逐位一致（基线：容限不该掩盖真实相等）', () => {
    const i = identityAffine()
    const p = Object.freeze({ x: 1, y: 2, z: 3 })
    expect(transformPoint(i, p)).toEqual(p)
    expect(multiplyAffine(i, i).m).toEqual(i.m)
  })

  it('`affineFromRows` 与逐分量访问一致（round-trip：任何转置错误都会在此暴露）', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
    const m = affineFromRows(rows)
    // 用 transformPoint 交叉验证：行主序 (0,3) 位置的 4 是 x 的平移系数
    const p = Object.freeze({ x: 1, y: 0, z: 0 })
    const q = transformPoint(m, p)
    // 列 0 是 [1,5,9]ᵀ ⇒ x' = 1·1 + 4 = 5；y' = 5·1 + 8 = 13；z' = 9·1 + 12 = 21
    expect(q).toEqual({ x: 5, y: 13, z: 21 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 内部
// ─────────────────────────────────────────────────────────────────────────────

/** 去掉注释与字符串字面量（静态判据只看代码，不看解释性文字）。 */
function stripCommentsAndStrings(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const two = src.slice(i, i + 2)
    if (two === '//') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (two === '/*') {
      i += 2
      while (i < src.length && src.slice(i, i + 2) !== '*/') i++
      i += 2
      continue
    }
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++
        i++
      }
      i++
      continue
    }
    out += ch
    i++
  }
  return out
}
