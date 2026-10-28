/**
 * 棘轮 · `probeHover` 只认**目标**：删掉"任何非空悬停都算落定"
 *
 * ## 被判的缺陷（根因：收敛判据是"有东西"而不是"目标"）
 *
 * 旧 `probeHover` 把"落定"定义成 `h !== null`。而生产悬停态是**粘住的**：
 * `hoverHandler` 的拾取按帧合并（`createHoverPickScheduler`），上一次结果一直留在
 * `region.state.hover.viewportBlock` 上，直到下一次拾取写入。于是"注入 pointermove →
 * 立刻轮询"首先读到的往往仍是**上一次**的观测 —— 同格邻接部件、同格宿主命中
 * （`part === null`）、或增广几何边界上真实的其它命中（如 `ae2:UNKNOWN`）。
 * 三者都满足 `h !== null` ⇒ 旧实现当场返回，调用方随后按"目标"比对就间歇变红：
 * `parts-falsification.spec.ts` 的定向性一步（线缆那一次探测紧跟在切换总线之后）
 * 实测会读到邻接部件 `ae2:NORTH`，靠 retry 才绿。
 *
 * ## 这条棘轮怎么把"旧逻辑早返"变成**确定性**事实
 *
 * 拾取由 `createHoverPickScheduler` 按 `requestAnimationFrame` 合并 ⇒ 本 spec 把
 * **帧时钟**换成可控闸门（`__frameGate__`：`requestAnimationFrame` 只入队，
 * `pump()` 才推进一批）。于是"这次拾取到底跑没跑"由测试显式决定，观测序列完全确定：
 *
 * ```
 * 注入切换总线点（未给帧）→ 观测 null
 * 给 1 帧（真实 raycast）  → 观测 part:ae2:NORTH（邻接部件）
 * 注入线缆点（未给帧）    → 观测仍是 part:ae2:NORTH（粘住的陈旧态）
 * 读到这次陈旧邻接（信号）→ 微任务里推进帧（真实 raycast）
 * 下一轮轮询              → 观测 part:ae2:UNKNOWN（目标）
 * ```
 *
 * **第二次推进帧不是定时器**：它由**读面信号**触发 —— 探测的轮询读到"陈旧邻接"这件事，
 * 本身就是"轮询已经开始、且正停在陈旧态"的证据；闸门在这次读取**结束之后**的微任务里
 * 推进帧（`queueMicrotask`，绝不打断/改写触发它的那一次读取）。于是"首读早于目标出现"
 * 是结构保证而不是竞速结果：与机器快慢、并发负载无关，没有墙钟耦合。
 *
 * 生产链的**取值**没有被替换：真实 `pointermove` → 真实 `pickEntityAtClient` +
 * `pickPartForScenePick` → 真实 `hover.setViewportBlock` → 真实读面 `readWikiHover`；
 * 交给测试的只有"第几帧"与"读到了什么"。
 *
 * ⚠️ 但读入口的**实现确实被改写**：本 spec 在真实 `Context` 实例上写 own `region` 属性
 * 遮蔽原型方法（于是本页面内 `ctx.region(...)` / `requireRegion` 都走这层 Proxy），
 * 值透明、方法 `bind` 回真实对象、安装后不恢复、随页面丢弃 —— 它是**页面作用域的
 * 观测叠加层**，不是"只读旁路"（细节见 `installFrameGate`）。
 *
 * **没有**替身拾取、**没有**手写悬停状态、**没有**伪造最终业务断言
 * （目标 localId 来自 fixture 自己的部件数据）。
 *
 * ## 两个用例
 *
 *  1. **旧口径必早返邻接（确定性红）**：同一序列上，pre-fix 的 `h !== null` 轮询
 *     **首次读数**就是邻接部件 ⇒ 拿它去比目标（`ae2:UNKNOWN`）必抛；新口径拒绝邻接、
 *     等到目标才返回，并把"拒绝了几次 / 看到了什么序列"记进 `trace`。
 *     推进帧由**读面信号**触发，判定结果为"序列 = [陈旧邻接, 目标]、拒绝 1 次"这类
 *     确定值（不是"至少一次"），因此可对整条观测序列做等值断言。
 *  2. **负对照：一直停在邻接部件** ⇒ 新口径在**短预算**（本用例内 700ms；生产缺省
 *     10s 不变）内必超时判红，错误信息里带实测观测序列（含邻接部件与期望目标）；
 *     旧口径当场"成功" —— 证明它根本无法区分两者。
 */

import { expect, test, type Page } from '@playwright/test'
import {
  gotoWikiPreviewWithScene,
  injectHoverAtCellLocal,
  readWikiHover,
  readPartsFixture,
  augmentFixtureGeometry,
  normalizeTextureBlobsForRender,
  quadCenter,
  probeHover,
  type QuadCorners,
  type WikiHoverObservation,
} from './helpers/parts'

const CELL = { col: 0, row: 0, z: 0 }

/** 目标部件（= fixture 自己的部件数据，见 `parts-ae2-multibox.v2.json`）。 */
const CABLE_LOCAL_ID = 'ae2:UNKNOWN'
/** 同格邻接部件（线缆点的上一次悬停会停在这里 = 本次修的实测形态）。 */
const TOGGLE_LOCAL_ID = 'ae2:NORTH'

/** 读到陈旧邻接后由信号请求推进的帧批数（另计信号前的 1 批手动推进）。 */
const SIGNAL_GENERATIONS = 3

/**
 * 与 `parts-hover-stats.spec.ts` / `parts-outline-b1.spec.ts` 同一套几何增强副本
 * （fixture 原件几何对悬停物理不可达，见 `helpers/parts/README.md` §3.1）。
 */
const AE2_AUGMENT_QUADS = {
  cable: [[0.375, 0.375, 0.375], [0.375, 0.375, 0.625], [0.375, 0.625, 0.625], [0.375, 0.625, 0.375]] as QuadCorners,
  toggle: [[0.375, 0.375, 0], [0.625, 0.375, 0], [0.625, 0.625, 0], [0.375, 0.625, 0]] as QuadCorners,
  storage: [[0.1875, 1, 0.1875], [0.8125, 1, 0.1875], [0.8125, 1, 0.8125], [0.1875, 1, 0.8125]] as QuadCorners,
} as const

function augmentedAe2Fixture(): Record<string, unknown> {
  const f = augmentFixtureGeometry(readPartsFixture('parts-ae2-multibox.v2.json'), 1, [
    AE2_AUGMENT_QUADS.cable,
    AE2_AUGMENT_QUADS.toggle,
    AE2_AUGMENT_QUADS.storage,
  ])
  return normalizeTextureBlobsForRender(f)
}

/** 悬停观测的缩写（证据日志用；与 helper 的 trace 口径同形）。 */
function brief(h: WikiHoverObservation | null): string {
  if (!h) return 'null'
  const cell = h.voxel ? `${h.voxel.column},${h.voxel.row},${h.voxel.zSlice}` : '?'
  return `${h.part ? `part:${h.part.localId}` : 'host'}@${h.blockId}#${cell}`
}

/** 跑一个异步断言，返回捕获到的错误（未抛则返回 null）。 */
async function captureAsyncFailure(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
    return null
  } catch (e) {
    return e
  }
}

/**
 * 帧时钟闸门 + **读面信号**：`requestAnimationFrame` 换成队列，`pump(n)` 才推进 n 批；
 * 另外把"探测已经读到陈旧邻接"这件事变成闸门可以消费的信号（见 {@link armPumpOnStaleRead}）。
 *
 * ## 信号是怎么接上的（如实说明，不要读成"只读旁路"）
 *
 * 做法是在**真实 `Context` 实例**上写入一个 **own `region` 属性**，遮蔽原型方法
 * `Context.prototype.region`。于是本页面内**所有**走 `ctx.region(...)` 的调用都会拿到这层
 * Proxy —— 包括 `requireRegion`（它的实现就是 `this.region(...)`）。Proxy 只做三件事：
 * 逐层透传到 `state.hover.viewportBlock`、在 `.value` 被读时通知信号、方法一律 `bind` 回真实
 * 对象。**值完全透明**（读到的仍是同样的 `RegionNode` / `ViewportHoverState` /
 * `ViewportBlockHover`），但它确实**改写了公开读入口的实现**，所以不是"只读旁路"：
 * 这是**页面作用域的观测叠加层**。
 *
 * 生命周期同样只有本页面：安装后**不恢复**（测试结束随页面一起丢弃）；帧闸门侧
 * （`requestAnimationFrame` 换队列）是同一页面作用域的另一半。
 *
 * 为什么仍然算"控制观测而不是替身"：拾取、悬停状态写入、读面返回的值三者都没被替换 ——
 * 交给测试的只有"帧何时到来"（生产上由浏览器决定）与"读到了什么"这一事实。
 * 生产行为不经过这段代码（本 spec 之外无人安装它）。
 */
async function installFrameGate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any
    if (w.__frameGate__) return
    const pending: Array<{ id: number; cb: FrameRequestCallback }> = []
    let nextId = 1
    const gate: any = {
      armed: null as null | { staleLocalId: string; generations: number },
      fired: 0,
      /** 累计推进的帧批数（含信号触发前的手动推进） */
      pumpedGenerations: 0,
    }
    gate.pump = (generations: number): number => {
      let ran = 0
      for (let g = 0; g < generations; g++) {
        const batch = pending.splice(0, pending.length)
        const ts = performance.now()
        for (const e of batch) {
          ran += 1
          try {
            e.cb(ts)
          } catch (err) {
            console.error('[frameGate]', err)
          }
        }
      }
      gate.pumpedGenerations += generations
      return ran
    }
    /**
     * 读面信号：读到**指定的陈旧观测**（`part.localId === staleLocalId`）时，
     * 在这次读取**结束之后**的微任务里推进帧。
     *
     * 单次触发（`armed` 随即置空）：`queueMicrotask` 保证不打断触发它的那次读取 ——
     * 那次调用仍完整拿到陈旧值（因此"拒绝陈旧观测"这件事可被观察到），
     * 下一轮轮询才会看到拾取后的新值。
     */
    gate.onObservationRead = (value: any): void => {
      const armed = gate.armed
      if (!armed || gate.fired > 0) return
      if (!value || !value.part || value.part.localId !== armed.staleLocalId) return
      gate.fired += 1
      gate.armed = null
      const generations = armed.generations
      queueMicrotask(() => {
        gate.pump(generations)
      })
    }
    gate.arm = (staleLocalId: string, generations: number): void => {
      gate.fired = 0
      gate.armed = { staleLocalId, generations }
    }
    // 观测叠加层：在真实 Context 实例上写 own `region`（遮蔽原型方法）⇒ 本页面内所有
    // `ctx.region(...)`（含内部走 `this.region(...)` 的 `requireRegion`）都拿到这层 Proxy；
    // 目的只有一个：`.state.hover.viewportBlock.value` 被读时通知 `onObservationRead`。
    // 值透明（方法 bind 回真实对象、其余属性原样透传），但读入口的实现确实被改写，
    // 安装后不恢复，随页面生命周期丢弃。
    const vm = w.__vm__
    if (!vm || typeof vm.region !== 'function') {
      throw new Error('__vm__.region 不可用（帧闸门无法挂读面信号）')
    }
    const origRegion = vm.region.bind(vm)
    const wrapRef = (ref: any): any =>
      ref && new Proxy(ref, {
        get(t, prop) {
          const v = Reflect.get(t, prop, t)
          if (prop === 'value') {
            gate.onObservationRead(v)
            return v
          }
          return typeof v === 'function' ? v.bind(t) : v
        },
      })
    const wrapHover = (h: any): any =>
      h && new Proxy(h, {
        get(t, prop) {
          const v = Reflect.get(t, prop, t)
          if (prop === 'viewportBlock') return wrapRef(v)
          return typeof v === 'function' ? v.bind(t) : v
        },
      })
    const wrapState = (s: any): any =>
      s && new Proxy(s, {
        get(t, prop) {
          const v = Reflect.get(t, prop, t)
          if (prop === 'hover') return wrapHover(v)
          return typeof v === 'function' ? v.bind(t) : v
        },
      })
    const wrapNode = (n: any): any =>
      n && new Proxy(n, {
        get(t, prop) {
          const v = Reflect.get(t, prop, t)
          if (prop === 'state') return wrapState(v)
          return typeof v === 'function' ? v.bind(t) : v
        },
      })
    vm.region = (rid: string) => wrapNode(origRegion(rid))
    w.__frameGate__ = gate
    // 只在本页面上下文里替换（Playwright 自身的可交互性检查跑在隔离世界，不受影响）。
    w.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      const id = nextId++
      pending.push({ id, cb })
      return id
    }
    w.cancelAnimationFrame = (id: number): void => {
      const i = pending.findIndex((e) => e.id === id)
      if (i >= 0) pending.splice(i, 1)
    }
  })
}

/** 推进 n 批帧，并让出一轮宏任务（Vue 的渲染 flush 在微任务里，随后 DOM 才可读）。 */
async function pumpFrames(page: Page, generations = 1): Promise<number> {
  return await page.evaluate(async (n) => {
    const gate = (window as any).__frameGate__
    const ran = gate.pump(n)
    await new Promise<void>((r) => setTimeout(r, 0))
    return ran as number
  }, generations)
}

/**
 * 布防：闸门读到**指定的陈旧部件观测**后，在该次读取之后的微任务里推进 n 批帧。
 *
 * 这是本 spec 与探测之间**唯一**的协调方式 —— 没有 `setTimeout(...)` 之类的墙钟假设：
 * 信号 = "探测的轮询确实已经读到陈旧邻接"，所以"轮询首读早于目标出现"是结构保证。
 */
async function armPumpOnStaleRead(page: Page, staleLocalId: string, generations: number): Promise<void> {
  await page.evaluate(({ staleLocalId, generations }) => {
    ;(window as any).__frameGate__.arm(staleLocalId, generations)
  }, { staleLocalId, generations })
}

/**
 * 读闸门的信号证据：是否真的由"读到陈旧观测"触发（`fired`），以及**累计**推进了几批帧
 * （`pumpedGenerations` = 信号触发前的手动推进 + 信号请求的批数，例如 1 + 3 = 4）。
 */
async function readGateEvidence(
  page: Page,
): Promise<{ fired: number; pumpedGenerations: number; armed: boolean }> {
  return await page.evaluate(() => {
    const gate = (window as any).__frameGate__
    return {
      fired: gate.fired as number,
      pumpedGenerations: gate.pumpedGenerations as number,
      armed: gate.armed !== null,
    }
  })
}
/**
 * **pre-fix 口径的复刻**（负对照专用，**不是**生产代码，也不被任何 helper 调用）。
 *
 * 旧 `probeHover` 的收敛判据逐字就是"有任何悬停"：
 * `pollUntil(async () => (await readWikiHover(page)) ?? null, …)`。
 * 这里保留"首次读数即返回"的形状，并记下读了几次，用来证明它是**早返**。
 */
async function legacyAnyHoverEarlyReturn(
  page: Page,
): Promise<{ hover: WikiHoverObservation | null; reads: string[] }> {
  const reads: string[] = []
  for (let i = 0; i < 4; i++) {
    const h = await readWikiHover(page)
    reads.push(brief(h))
    if (h !== null) return { hover: h, reads }
    await new Promise((r) => setTimeout(r, 40))
  }
  return { hover: null, reads }
}

test.describe('probeHover 只认目标部件（帧可控的确定性棘轮）', () => {
  test('序列 null→邻接→目标：旧口径首次读数即邻接（目标断言确定性红），新口径等目标', async ({ page }, testInfo) => {
    test.setTimeout(120_000)
    await gotoWikiPreviewWithScene(page, augmentedAe2Fixture(), 'parts-ae2.ratchet-probe-hover.json')
    await installFrameGate(page)

    // ── ① 注入切换总线点，**不给帧** ⇒ 拾取还没跑，观测 = null ──
    const togglePt = { ...CELL, ...quadCenter(AE2_AUGMENT_QUADS.toggle) }
    await injectHoverAtCellLocal(page, togglePt)
    const atInject = await readWikiHover(page)
    expect(atInject, '未给帧时拾取不得已经发生（序列起点必须是 null）').toBeNull()

    // ── ② 给一帧 ⇒ 真实 raycast 命中同格切换总线（邻接部件） ──
    const ranToggle = await pumpFrames(page, 1)
    expect(ranToggle, '这一帧必须真的跑过回调（否则下面的观测没有意义）').toBeGreaterThan(0)
    const adjacent = await readWikiHover(page)
    expect(brief(adjacent), '真实拾取必须落在切换总线（邻接部件）上').toBe(`part:${TOGGLE_LOCAL_ID}@${adjacent?.blockId}#0,0,0`)
    expect(adjacent?.part?.localId).toBe(TOGGLE_LOCAL_ID)

    // ── ③ 注入线缆点，**仍不给帧** ⇒ 悬停态粘在邻接部件上（本次修的实测形态） ──
    const cablePt = { ...CELL, ...quadCenter(AE2_AUGMENT_QUADS.cable) }
    await injectHoverAtCellLocal(page, cablePt)
    const stale = await readWikiHover(page)
    expect(stale?.part?.localId, '未给帧时悬停态必须仍是邻接部件（生产悬停态是粘住的）').toBe(TOGGLE_LOCAL_ID)

    // ── ④ 旧口径在同一观测上 ⇒ 首次读数即返回邻接 ⇒ 目标断言必抛（确定性红） ──
    const legacy = await legacyAnyHoverEarlyReturn(page)
    expect(legacy.reads.length, '旧口径必须**首次读数**就返回（早返是确定性事实，不是概率）').toBe(1)
    expect(brief(legacy.hover), '旧口径读到的就是邻接部件').toBe(`part:${TOGGLE_LOCAL_ID}@${legacy.hover?.blockId}#0,0,0`)
    const legacyTargetErr = await captureAsyncFailure(async () => {
      expect(legacy.hover?.part?.localId, '目标断言（线缆 ae2:UNKNOWN）').toBe(CABLE_LOCAL_ID)
    })
    expect(legacyTargetErr, '旧口径把邻接部件当成功 ⇒ 目标断言必红（本次修的误判）').not.toBeNull()

    // ── ⑤ 新口径：目标 = 线缆。推进帧由**读面信号**触发（探测读到上面那次陈旧邻接之后才给帧），
    //    没有定时器 ⇒"轮询首读早于目标出现"是结构保证，不随负载漂移 ──
    await armPumpOnStaleRead(page, TOGGLE_LOCAL_ID, SIGNAL_GENERATIONS)
    const probe = await probeHover(page, cablePt, { localId: CABLE_LOCAL_ID })
    expect(probe.hover.part?.localId, '新口径必须等到目标 localId 才返回').toBe(CABLE_LOCAL_ID)
    expect(probe.hover.voxel, '命中的格 = 注入点所在的格').toEqual({ column: 0, row: 0, zSlice: 0 })
    // 观测序列**确定性**为两项：先陈旧邻接（被拒绝），再目标（命中）
    expect(probe.trace.observations, '序列 = 陈旧邻接 → 目标（两项，顺序固定）').toEqual([
      `part:${TOGGLE_LOCAL_ID}@${adjacent?.blockId}#0,0,0`,
      `part:${CABLE_LOCAL_ID}@${probe.hover.blockId}#0,0,0`,
    ])
    expect(probe.trace.rejected, '拒绝计数 = 1（只拒绝了那次陈旧邻接，随后命中目标）').toBe(1)
    // 信号证据：帧确实由"读到陈旧邻接"触发（不是提前给帧，也不是超时后碰巧给帧）
    const gateEvidence = await readGateEvidence(page)
    expect(gateEvidence.fired, '闸门必须由"读到陈旧邻接"触发过一次').toBe(1)
    expect(gateEvidence.armed, '触发后必须自行解除布防').toBe(false)
    expect(gateEvidence.pumpedGenerations, '累计推进的帧批数 ≥ 信号请求的 3 批（真实拾取真的跑了）').toBeGreaterThanOrEqual(SIGNAL_GENERATIONS)
    expect(probe.tooltip, 'tooltip 必须对应目标部件').toContain('ME Glass Cable - Fluix')

    console.log(
      `[probeHover 棘轮·序列] 注入→${brief(atInject)} / 给帧→${brief(adjacent)} / 粘住→${brief(stale)} / ` +
        `旧口径(读${legacy.reads.length}次)→${brief(legacy.hover)} / 新口径(拒绝${probe.trace.rejected}次, ` +
        `信号触发${gateEvidence.fired}次/累计推进${gateEvidence.pumpedGenerations}批` +
        `=信号前1批+本次信号请求${SIGNAL_GENERATIONS}批)→` +
        `${probe.trace.observations.join(' → ')}`,
    )
    testInfo.attach('probe-hover-ratchet-sequence', {
      body: JSON.stringify(
        {
          project: testInfo.project.name,
          sequence: {
            injected: brief(atInject),
            afterFrame: brief(adjacent),
            stuckAtAdjacent: brief(stale),
          },
          legacy: { reads: legacy.reads.length, observed: brief(legacy.hover) },
          current: { rejected: probe.trace.rejected, observations: probe.trace.observations },
          signal: {
            fired: gateEvidence.fired,
            signalRequestedGenerations: SIGNAL_GENERATIONS,
            pumpedGenerationsTotal: gateEvidence.pumpedGenerations,
          },
        },
        null,
        1,
      ),
      contentType: 'application/json',
    })
  })

  test('负对照：一直停在邻接部件 ⇒ 新口径短预算内必超时判红，旧口径当场"成功"', async ({ page }) => {
    test.setTimeout(120_000)
    await gotoWikiPreviewWithScene(page, augmentedAe2Fixture(), 'parts-ae2.ratchet-never-target.json')
    await installFrameGate(page)

    // 前提：真实拾取先把悬停放到同格邻接部件上
    await injectHoverAtCellLocal(page, { ...CELL, ...quadCenter(AE2_AUGMENT_QUADS.toggle) })
    await pumpFrames(page, 1)
    const adjacent = await readWikiHover(page)
    expect(adjacent?.part?.localId, '前提：真实拾取落在邻接部件').toBe(TOGGLE_LOCAL_ID)

    // 注入目标（线缆）点，但**永不给帧** ⇒ 目标在整段预算内不可能出现
    const cablePt = { ...CELL, ...quadCenter(AE2_AUGMENT_QUADS.cable) }
    await injectHoverAtCellLocal(page, cablePt)

    // 旧口径：当场"成功"（把邻接当目标）
    const legacy = await legacyAnyHoverEarlyReturn(page)
    expect(legacy.reads.length, '旧口径首次读数即返回').toBe(1)
    expect(legacy.hover?.part?.localId, '旧口径读到的仍是邻接部件 —— 它无法区分目标与邻接').toBe(TOGGLE_LOCAL_ID)

    // 新口径：**短预算**（本用例内 700ms；生产缺省 10s 不变）必须判红
    const err = await captureAsyncFailure(() => probeHover(page, cablePt, { localId: CABLE_LOCAL_ID }, 700))
    expect(err, '一直邻接 ⇒ 新口径必须超时报红，不得把邻接当目标').not.toBeNull()
    const msg = String((err as Error).message)
    expect(msg, '错误必须带期望目标').toContain(`part:${CABLE_LOCAL_ID}`)
    expect(msg, '错误必须带实测观测序列（邻接部件）').toContain(`part:${TOGGLE_LOCAL_ID}`)
    expect(msg, '错误必须说明拒绝计数').toContain('拒绝')
    console.log(`[probeHover 棘轮·负对照] ${msg.split('\n')[0]}`)
  })
})
