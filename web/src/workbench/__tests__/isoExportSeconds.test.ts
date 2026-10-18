/**
 * **C4（M5-4）**：等轴导出时间的**唯一**归一入口 `normalizeIsoSeconds`。
 *
 * 本判据只钉参数契约（真 GL 只在 e2e 里）：
 * - 缺省 ⇒ 0（与改造前"帧偏移停在构造初值 0"逐位一致）；
 * - 非有限数 / 非 number ⇒ **抛**（若实现写成 `|| 0`，NaN 会被洗成 0 ⇒ 本判据红）；
 * - 负数**允许**（采样器对负时间取模；钳制它会制造第二种语义）。
 */
import { describe, expect, it } from 'vitest'
import { normalizeIsoSeconds } from '@/application/captureInput'

describe('normalizeIsoSeconds · 缺省与合法输入', () => {
  it('undefined ⇒ 0（缺省 = 0 秒）', () => {
    expect(normalizeIsoSeconds(undefined)).toBe(0)
  })

  it('0 ⇒ 0', () => {
    expect(normalizeIsoSeconds(0)).toBe(0)
  })

  it('正数原样返回（不做取整、不夹取）', () => {
    expect(normalizeIsoSeconds(0.05)).toBe(0.05)
    expect(normalizeIsoSeconds(12.5)).toBe(12.5)
  })

  it('负数**允许**（-1 ⇒ -1；采样器自己取模回正）', () => {
    expect(normalizeIsoSeconds(-1)).toBe(-1)
    expect(normalizeIsoSeconds(-0.25)).toBe(-0.25)
  })
})

describe('normalizeIsoSeconds · 非法输入必须显式拒绝（不得静默当 0）', () => {
  it('NaN / Infinity / -Infinity ⇒ throw', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() => normalizeIsoSeconds(bad), `${String(bad)} 必须抛`).toThrow()
    }
  })

  it('字符串 / null / 对象 ⇒ throw（字符串 "1" 不得被隐式转成 1）', () => {
    for (const bad of ['1', '', null, {}, [], true]) {
      expect(() => normalizeIsoSeconds(bad), `${JSON.stringify(bad)} 必须抛`).toThrow()
    }
  })

  it('**负对照**：`|| 0` 形态会把 NaN 洗成 0 —— 本判据必须抓住它', () => {
    // 逐字复刻"写成 || 0"的实现，证明上面那条不是恒真。
    const lazy = (raw: unknown): number => (raw as number) || 0
    expect(lazy(NaN)).toBe(0)
    expect(() => normalizeIsoSeconds(NaN)).toThrow()
  })
})
