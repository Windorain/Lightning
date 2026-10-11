/**
 * `runtime/lifecycle` 的验收 —— **A13 的资源半边**（#249 §14 A13；
 * #257「关闭 Area 释放运行资源（不靠隐藏组件保状态）」）。
 *
 * ## 为什么这份测试是 A13 的关键一半
 *
 * `domain/__tests__/workspace.test.ts` 证明了"关 Area 会报出被释放的实例 id"，
 * 但那是**声明**。本文件证明**账本真的回到基线**：
 *
 * ```
 * 100 轮：open → acquire(每种资源) → release(每种资源) → close
 *        ⇒ activeInstances === 0 && totalActive === 0
 * ```
 *
 * ## 负对照（A19 的两个方向，都在本文件里可执行）
 *
 * A19 原文：「少一次 dispose 或提前释放共享资源」。
 * 本账本把两者分成**不同的否定结果**：
 *  - **少一次 release** ⇒ `closeInstance` 的 `released` 非空 ⇒ `leaks()` 抓到；
 *  - **多一次 release**（提前释放）⇒ `releaseResource` 返回 `null`（不静默钳到 0）。
 *
 * 若把 `releaseResource` 写成"钳到 0 并返回成功"，两个方向会得到同一个账本 ——
 * 本文件的第一条负对照就是证明"判据确实分得开"。
 */

import { describe, expect, it } from 'vitest'
import {
  acquireResource,
  activeByKind,
  activeInstanceIds,
  closeInstance,
  createLifecycleLedger,
  hasResources,
  leaks,
  ledgerSummary,
  openInstance,
  releaseResource,
  totalActive,
  type LifecycleLedger,
} from '../lifecycle'

/** 一个 3D Area 实例归一持有的资源种类（与 `editors/areaRegistry` 的 `VIEWPORT3D_RESOURCES` 同源）。 */
const VIEWPORT_RESOURCES = ['renderer', 'webglContext', 'resizeObserver', 'hoverListener', 'frameHook', 'multiblockChannelState'] as const

function acquireAll(ledger: LifecycleLedger, instanceId: string): LifecycleLedger {
  let l = ledger
  for (const kind of VIEWPORT_RESOURCES) {
    const next = acquireResource(l, instanceId, kind)
    if (!next) throw new Error(`acquire ${kind} on ${instanceId} failed`)
    l = next
  }
  return l
}

function releaseAll(ledger: LifecycleLedger, instanceId: string): LifecycleLedger {
  let l = ledger
  for (const kind of VIEWPORT_RESOURCES) {
    const next = releaseResource(l, instanceId, kind)
    if (!next) throw new Error(`release ${kind} on ${instanceId} failed`)
    l = next
  }
  return l
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 基本记账
// ─────────────────────────────────────────────────────────────────────────────

describe('资源账本：获取/释放/关闭的记账是纯的且可对账', () => {
  it('open → acquire 5 种 → 计数正确；release 全部 → 回 0', () => {
    let l = openInstance(createLifecycleLedger(), 'i1', 'viewport3d')
    if (!l) throw new Error('open')
    l = acquireAll(l, 'i1')
    expect(totalActive(l)).toBe(VIEWPORT_RESOURCES.length)
    expect(activeByKind(l)['renderer']).toBe(1)
    expect(hasResources(l, 'i1')).toBe(true)
    l = releaseAll(l, 'i1')
    expect(totalActive(l)).toBe(0)
    expect(activeInstanceIds(l)).toEqual(['i1'])
    expect(hasResources(l, 'i1')).toBe(false)
    expect(leaks(l)).toEqual([])
  })

  it('同一资源获取两次 ⇒ 计数为 2；释放一次仍为 1（引用计数语义）', () => {
    let l = openInstance(createLifecycleLedger(), 'i1', 'viewport3d')
    if (!l) throw new Error('open')
    l = acquireResource(l, 'i1', 'renderer')
    if (!l) throw new Error('a1')
    l = acquireResource(l, 'i1', 'renderer')
    if (!l) throw new Error('a2')
    expect(activeByKind(l)['renderer']).toBe(2)
    l = releaseResource(l, 'i1', 'renderer')
    if (!l) throw new Error('r1')
    expect(activeByKind(l)['renderer']).toBe(1)
  })

  it('**过度释放**（提前释放共享资源）返回 `null`，不静默钳到 0', () => {
    let l = openInstance(createLifecycleLedger(), 'i1', 'viewport3d')
    if (!l) throw new Error('open')
    l = acquireResource(l, 'i1', 'renderer')
    if (!l) throw new Error('acquire')
    const once = releaseResource(l, 'i1', 'renderer')
    expect(once).not.toBeNull()
    // 第二次释放：计数已是 0 ⇒ 必须显式失败
    const twice = releaseResource(once as LifecycleLedger, 'i1', 'renderer')
    expect(twice, 'A19 负对照：多一次 dispose 必须被识别为缺陷，而不是与"正确释放"产生同一账本').toBeNull()
  })

  it('未登记实例上 acquire / release / close 一律返回 `null`（不静默接受）', () => {
    const l = createLifecycleLedger()
    expect(acquireResource(l, 'ghost', 'renderer')).toBeNull()
    expect(releaseResource(l, 'ghost', 'renderer')).toBeNull()
    expect(closeInstance(l, 'ghost')).toBeNull()
  })

  it('重复 open 同 id 返回 `null`（不静默覆盖一个已持有的实例）', () => {
    const l = openInstance(createLifecycleLedger(), 'i1', 'viewport3d')
    if (!l) throw new Error('open')
    expect(openInstance(l, 'i1', 'inspector')).toBeNull()
  })

  it('纯性：账本转移不改输入，且相同输入序列结果相同', () => {
    const base = createLifecycleLedger()
    const snapshot = JSON.stringify(base)
    const a = openInstance(base, 'i1', 'viewport3d')
    const b = openInstance(base, 'i1', 'viewport3d')
    expect(JSON.stringify(base), '输入账本必须逐字节不变').toBe(snapshot)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. 负对照：少一次 dispose
// ─────────────────────────────────────────────────────────────────────────────

describe('**负对照 A19/A13**「少一次 dispose」⇒ 必须判红', () => {
  it('关实例时仍持有资源 ⇒ `closeInstance` 的 `released` 非空（泄漏可被抓到）', () => {
    let l = openInstance(createLifecycleLedger(), 'i1', 'viewport3d')
    if (!l) throw new Error('open')
    l = acquireAll(l, 'i1')
    // 故意只还 4 个，漏掉最后一个（模拟少一次 dispose）
    for (const kind of VIEWPORT_RESOURCES.slice(0, -1)) {
      const next = releaseResource(l, 'i1', kind)
      if (!next) throw new Error('release')
      l = next
    }
    const closed = closeInstance(l, 'i1')
    if (!closed) throw new Error('close')
    expect(closed.released, '漏还的资源必须出现在 released 里').toEqual({ [VIEWPORT_RESOURCES[VIEWPORT_RESOURCES.length - 1]]: 1 })
    // 且**不能**因为实例被关闭就假装账目干净
    expect(totalActive(closed.ledger), '关闭后账目干净 —— 但那只因为实例整个被移除了').toBe(0)
    expect(ledgerSummary(closed.ledger).releasedTotal).toBe(1)
  })

  it('不关实例只漏还资源 ⇒ `leaks()` 抓到它（诊断面）', () => {
    let l = openInstance(createLifecycleLedger(), 'i1', 'viewport3d')
    if (!l) throw new Error('open')
    l = acquireAll(l, 'i1')
    l = releaseResource(l, 'i1', 'renderer')
    if (!l) throw new Error('release')
    const found = leaks(l)
    expect(found.length, '必须报出仍持有资源的实例').toBe(1)
    expect(found[0].instanceId).toBe('i1')
    expect(Object.keys(found[0].resources).sort()).toEqual(['frameHook', 'hoverListener', 'multiblockChannelState', 'resizeObserver', 'webglContext'])
    // 真实现对照：把**剩下**的都还掉之后 leaks 为空
    let rest = l
    for (const kind of VIEWPORT_RESOURCES) {
      if (kind === 'renderer') continue
      const next = releaseResource(rest, 'i1', kind)
      if (!next) throw new Error(`release ${kind}`)
      rest = next
    }
    expect(leaks(rest), '全还之后必须为空').toEqual([])
    expect(hasResources(rest, 'i1')).toBe(false)
  })

  it('**反空洞真**：`leaks()` 不是恒空 —— 它有资源时才报（否则上一条无意义）', () => {
    let l = openInstance(createLifecycleLedger(), 'clean', 'viewport3d')
    if (!l) throw new Error('open')
    expect(leaks(l), '无资源的实例不该被报为泄漏').toEqual([])
    l = acquireResource(l, 'clean', 'renderer')
    if (!l) throw new Error('acquire')
    expect(leaks(l).length).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. 100 轮循环：A13 的资源回基线
// ─────────────────────────────────────────────────────────────────────────────

describe('A13 · **100 轮** open/acquire/release/close 后资源账本回基线', () => {
  it('100 轮后 activeInstances=0、totalActive=0、releasedTotal=100、leaks 为空', () => {
    let l = createLifecycleLedger()
    for (let i = 0; i < 100; i++) {
      const id = `inst-${i}`
      // 模拟"两个 3D Area + 一个通道面板"：每个实例持有自己的资源
      for (const [inst, type] of [
        [`${id}-vp-a`, 'viewport3d'],
        [`${id}-vp-b`, 'viewport3d'],
        [`${id}-ch`, 'channels'],
      ] as const) {
        const opened = openInstance(l, inst, type)
        if (!opened) throw new Error(`open ${inst}`)
        l = opened
        l = acquireAll(l, inst)
        // 中间穿插一次"切类型"：释放旧资源再换一批（不能只隐藏）
        for (const kind of VIEWPORT_RESOURCES) {
          const r = releaseResource(l, inst, kind)
          if (!r) throw new Error(`release ${kind}`)
          l = r
        }
        l = acquireAll(l, inst)
        // 关闭：先还资源，再关实例
        l = releaseAll(l, inst)
        const closed = closeInstance(l, inst)
        if (!closed) throw new Error(`close ${inst}`)
        expect(closed.released, `第 ${i} 轮 ${inst} 关闭时不得还有资源`).toEqual({})
        l = closed.ledger
      }
      // 每轮结束都必须完全回基线（不是"最后回到基线"）
      expect(totalActive(l), `第 ${i} 轮结束后的活跃资源`).toBe(0)
      expect(activeInstanceIds(l), `第 ${i} 轮结束后的活跃实例`).toEqual([])
    }
    expect(ledgerSummary(l)).toEqual({ activeInstances: 0, activeResources: 0, releasedTotal: 300 })
    expect(leaks(l)).toEqual([])
  })

  it('**负对照**：把"关闭"实现成"隐藏"（不 release、不 close）⇒ 100 轮后账本**不**回基线', () => {
    // 这正是旧 `v-show` 保活形态的可测量指纹：布局看起来"只剩一个 Area"，
    // 但资源账本上还挂着 100 轮 × 3 个实例的全部资源。
    let l = createLifecycleLedger()
    for (let i = 0; i < 100; i++) {
      for (const inst of [`${i}-vp-a`, `${i}-vp-b`, `${i}-ch`]) {
        const opened = openInstance(l, inst, 'viewport3d')
        if (!opened) throw new Error('open')
        l = opened
        l = acquireAll(l, inst)
        // 隐藏：什么都不还
      }
    }
    expect(totalActive(l), '"只隐藏不销毁"的实现必然留下全部资源').toBe(100 * 3 * VIEWPORT_RESOURCES.length)
    expect(activeInstanceIds(l).length).toBe(300)
    expect(leaks(l).length).toBe(300)
    // 与真实现对照：同样的 100 轮，正确关闭后是 0
    let clean = createLifecycleLedger()
    for (let i = 0; i < 100; i++) {
      const opened = openInstance(clean, `x-${i}`, 'viewport3d')
      if (!opened) throw new Error('open')
      clean = acquireAll(opened, `x-${i}`)
      clean = releaseAll(clean, `x-${i}`)
      const closed = closeInstance(clean, `x-${i}`)
      if (!closed) throw new Error('close')
      clean = closed.ledger
    }
    expect(totalActive(clean)).toBe(0)
  })

  it('**反空洞真**：`totalActive` 在真的持有资源时不为 0（否则"回基线"毫无意义）', () => {
    const l = openInstance(createLifecycleLedger(), 'i1', 'viewport3d')
    if (!l) throw new Error('open')
    const l2 = acquireAll(l, 'i1')
    expect(totalActive(l2)).toBeGreaterThan(0)
    expect(totalActive(l)).toBe(0)
  })
})
