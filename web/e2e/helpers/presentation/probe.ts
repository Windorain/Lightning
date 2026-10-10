/**
 * P5 · A18/A19/A30 的**浏览器侧探针**（e2e 专用；不经产品入口）。
 *
 * ## 为什么需要它（技术原因，不是设计偏好）
 *
 * `page.evaluate(async () => { await import('three') })` **必然失败**：Playwright 把该函数
 * 序列化成源码在页面里直接执行，裸说明符 `three` 没有 import map 可解析
 * （实测报错 `Failed to resolve module specifier 'three'`）。
 *
 * 只有经 **vite dev server 转译**的模块才会被重写说明符。因此探针放在 `web/e2e/` 下
 * （在 vite root 之内），spec 用**静态绝对路径** `import('/e2e/helpers/presentation/probe.ts')`
 * 加载它 —— 与产品代码走**同一台** dev server、**同一份** three 实例、**同一套**路径别名。
 *
 * ## 它测的是什么（以及不测什么）
 *
 * 测：`src/presentation/**` 的**生产模块**在真实 Chromium + 真实 WebGL 下的行为。
 * 不测：Workbench 编辑链路 —— 呈现层与 legacy `blockMesh` 路径的集成是 #256 明文留给
 * "Lead 合流时验证"的集成项。本探针因此直接驱动呈现层，不做任何替身替换：
 * 它调用的 `compileScene` / `BatchedPresenter` / `OwnershipRegistry` / `ViewportDeviceRegistry`
 * 全是生产实现，夹具由 `src/presentation/__tests__/fixtures.ts`（与 vitest 侧同一实现）产出。
 */

import * as THREE from 'three'
import { A18_DRAW_CALL_BUDGET, compatibilityKeyOf } from '@/presentation/batchPlan'
import { compileScene } from '@/presentation/compileScene'
import { ViewportDeviceRegistry } from '@/presentation/deviceState'
import { OwnershipRegistry } from '@/presentation/ownership'
import { PickIndex } from '@/presentation/pickingIndex'
import { BatchedPresenter } from '@/presentation/presenter'
import type { EvaluationKey } from '@/presentation/evaluationKey'
import {
  DEFAULT_MATERIAL,
  fixtureHash,
  makeAttributes,
  makeHomogeneousFixture,
  MemoryGeometrySource,
} from '@/presentation/__tests__/fixtures'

function keyOf(scene: string, documentVersion = 1): EvaluationKey {
  return {
    documentVersion,
    scene,
    time: { seconds: 0, numerator: 0, denominator: 1 },
    parameterVersion: 0,
    contentResourceVersions: {},
  }
}

/** 一份 A18 均质夹具（与 vitest 侧同一个 `makeHomogeneousFixture`）。 */
function pickFixture(count: number) {
  const geometry = new MemoryGeometrySource()
  geometry.set('geo:cube', 'v1', makeAttributes(12))
  const primitives = makeHomogeneousFixture(count)
  return { geometry, primitives, hash: fixtureHash([count, DEFAULT_MATERIAL]) }
}

interface Harness {
  THREE: typeof THREE
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  env: { webgl2: boolean; maxTextureSize: number; renderer: string; vendor: string; version: number }
}

let harness: Harness | null = null

/** 建一个真实 `WebGLRenderer` 并挂进页面（每页一次）。 */
export function installP5Harness(): { ok: true } {
  if (harness !== null) return { ok: true }

  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 480
  canvas.id = 'p5-gl-canvas'
  document.body.appendChild(canvas)

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true })
  renderer.setSize(640, 480, false)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 640 / 480, 0.1, 5000)
  camera.position.set(0, 0, 400)
  camera.lookAt(0, 0, 0)

  let rendererName = 'unavailable'
  let vendorName = 'unavailable'
  try {
    const gl = renderer.getContext()
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    if (dbg !== null) {
      rendererName = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      vendorName = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL))
    }
  } catch {
    /* 诊断信息取不到不影响判据 */
  }

  harness = {
    THREE,
    renderer,
    scene,
    camera,
    env: {
      webgl2: renderer.capabilities.isWebGL2,
      maxTextureSize: renderer.capabilities.maxTextureSize,
      renderer: rendererName,
      vendor: vendorName,
      version: Number(THREE.REVISION),
    },
  }
  return { ok: true }
}

function need(): Harness {
  if (harness === null) throw new Error('P5 harness 未安装')
  return harness
}

/**
 * 量**单帧**实测 draw call。
 *
 * 先空转 2 帧（材质编译/program 链接发生在首帧，会额外计入统计），再 `reset()` 后只渲染
 * **1 帧**读数 —— 于是 `calls` 就是"这一帧主色彩 pass 提交了几次绘制"，
 * 与 `drawCallEstimate` 的口径可直接对照（累加多帧会让读数变成 N 倍，无法逐项对账）。
 */
function measureDrawCalls(h: Harness): { calls: number; triangles: number; programs: number } {
  h.renderer.info.autoReset = false
  for (let i = 0; i < 2; i++) h.renderer.render(h.scene, h.camera)
  h.renderer.info.reset()
  h.renderer.render(h.scene, h.camera)
  return {
    calls: h.renderer.info.render.calls,
    triangles: h.renderer.info.render.triangles,
    programs: h.renderer.info.programs?.length ?? 0,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A18 gpu-batching
// ─────────────────────────────────────────────────────────────────────────────

export function runA18(count: number) {
  const h = need()
  const fixture = pickFixture(count)
  const compiled = compileScene({ key: keyOf('e2e:a18'), geometry: fixture.geometry, primitives: fixture.primitives })
  if (!compiled.ok) throw new Error(`compileScene failed: ${JSON.stringify(compiled.error)}`)
  const scene = compiled.value

  const presenter = new BatchedPresenter({ scope: 'e2e-a18' })
  presenter.apply(scene)
  h.scene.add(presenter.object3d)

  const measured = measureDrawCalls(h)
  const stats = presenter.statsSnapshot()

  // 拾取身份：抽样 + 边界（含最后一个实例）
  const pickIndex = new PickIndex(scene)
  const slots = [0, 1, Math.floor(count / 2), count - 2, count - 1]
  const probes = slots.map((slot) => ({
    slot,
    objectId:
      pickIndex.resolve({ generation: pickIndex.currentGeneration, batchIndex: 0, instanceSlot: slot })
        ?.objectId ?? null,
  }))
  const staleRejected = pickIndex.resolve({ generation: 'g:deadbeef', batchIndex: 0, instanceSlot: 0 }) === null

  // G2：移出一个对象后**不重建**基础几何
  const beforeRemove = presenter.statsSnapshot()
  const reduced = compileScene({
    key: keyOf('e2e:a18'),
    geometry: fixture.geometry,
    primitives: fixture.primitives.slice(0, count - 1),
  })
  if (!reduced.ok) throw new Error('reduced compile failed')
  presenter.apply(reduced.value)
  const afterRemove = presenter.statsSnapshot()

  // 释放（同时给出 A19 侧的正面对照读数）
  const ledgerAfterDispose = (() => {
    presenter.dispose()
    return presenter.ledger()
  })()

  return {
    count,
    calls: measured.calls,
    triangles: measured.triangles,
    programs: measured.programs,
    budget: A18_DRAW_CALL_BUDGET,
    structBatches: scene.plans.length,
    drawCallEstimate: scene.drawCallEstimate,
    instanceCount: stats.instanceCount,
    batchObjects: stats.batchObjects,
    geometryBuilds: stats.geometryBuilds,
    instanceable: scene.payloads.every((p) => p.instanceable),
    probes,
    staleRejected,
    geometryBuildsBeforeRemove: beforeRemove.geometryBuilds,
    geometryBuildsAfterRemove: afterRemove.geometryBuilds,
    batchReusesAfterRemove: afterRemove.batchReuses,
    ledgerBalancedAfterDispose: ledgerAfterDispose.balanced,
    ledgerActiveAfterDispose: ledgerAfterDispose.activeCount,
    fixtureHash: fixture.hash,
    env: h.env,
  }
}

/** A18 负对照：每对象不同 tint（非顶点色路径） ⇒ 一对象一绘制。 */
export function runA18Negative(count: number) {
  const h = need()
  const fixture = pickFixture(count)
  const primitives = fixture.primitives.map((p, i) => ({
    ...p,
    material: { ...p.material, useVertexColor: false, tint: 0x100000 + i },
  }))
  const compiled = compileScene({ key: keyOf('e2e:a18-neg'), geometry: fixture.geometry, primitives })
  if (!compiled.ok) throw new Error('compile failed')
  const scene = compiled.value

  // 直接量"兼容性组数"（一对象一绘制的**结构性**检出口）。
  //
  // 必须用 `compatibilityKeyOf` 逐对象算，**不能**用 `planBatches(...).length`：
  // 后者受 `maxBatches` 上界强制（会把 64 组合并成 32 并标记非同质），
  // 于是"组数"读出来恒 ≤ 32，测不出"每对象一组"这件事。
  const distinctCompatKeys = new Set(primitives.map((p) => compatibilityKeyOf(p))).size

  const presenter = new BatchedPresenter({ scope: 'e2e-a18-neg' })
  presenter.apply(scene)
  h.scene.add(presenter.object3d)
  const measured = measureDrawCalls(h)
  const batchObjects = presenter.statsSnapshot().batchObjects
  presenter.dispose()
  h.scene.remove(presenter.object3d)

  return {
    objectCount: count,
    calls: measured.calls,
    triangles: measured.triangles,
    distinctCompatKeys,
    // 上界强制后的实际组数（受 32 上界约束，作为对照读数保留）
    distinctCompatAfterBudget: new Set(scene.plans.map((p) => p.compatibilityKey)).size,
    homogeneous: scene.plans.every((p) => p.homogeneous),
    batchObjects,
    structBatches: scene.plans.length,
    fixtureHash: fixture.hash,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A19 resource-release
// ─────────────────────────────────────────────────────────────────────────────

export function runA19(rounds: number) {
  const h = need()
  const fixture = pickFixture(256)
  const compiled = compileScene({ key: keyOf('e2e:a19'), geometry: fixture.geometry, primitives: fixture.primitives })
  if (!compiled.ok) throw new Error('compile failed')
  const scene = compiled.value

  let allRoundsBackToBaseline = true
  let allRoundsPreservedOtherSide = true
  let balancedEveryRound = true
  let firstCloseActive = 0
  let minOtherSideActive = Number.POSITIVE_INFINITY

  for (let i = 0; i < rounds; i++) {
    const a = new BatchedPresenter({ scope: `vp-a#${i}` })
    const b = new BatchedPresenter({ scope: `vp-b#${i}` })
    a.apply(scene)
    b.apply(scene)
    if (a.ledger().activeCount + b.ledger().activeCount <= 0) {
      throw new Error(`round ${i}: 两个视口都无活跃资源`)
    }
    a.dispose()
    const otherActive = b.ledger().activeCount
    if (i === 0) firstCloseActive = otherActive
    minOtherSideActive = Math.min(minOtherSideActive, otherActive)
    if (otherActive <= 0) allRoundsPreservedOtherSide = false
    if (b.object3d.children.length === 0) allRoundsPreservedOtherSide = false

    // **注意取账时机**：必须在**各自动 dispose 之后**读它的账。
    // 在 B 仍合法持有资源时读 B 的 `balanced` 必然为假（acquireTotal 2 / releaseTotal 0）——
    // 那是"还没释放"，不是"泄漏"。早期探针就在这里读错时机，把正确的共享行为误判成不平衡。
    const aLedger = a.ledger()
    b.dispose()
    const bLedger = b.ledger()
    if (!aLedger.balanced || !bLedger.balanced) balancedEveryRound = false

    const active = a.ledger().activeCount + b.ledger().activeCount
    if (active !== 0) allRoundsBackToBaseline = false
  }

  // 共享条目：多次 acquire/多次 release 只 dispose 一次
  const shared = new OwnershipRegistry()
  let disposeCalls = 0
  const sharedEntry = { identity: { id: 'tex:shared', version: 'v1' }, deviceScope: 's1' }
  shared.acquire(sharedEntry, () => { disposeCalls += 1 })
  shared.acquire(sharedEntry, () => { disposeCalls += 1 })
  shared.release(sharedEntry)
  shared.release(sharedEntry)
  const sharedLedger = shared.ledger()

  // 负对照 1：少一次 dispose（漏掉第二次 release）
  const leak = new OwnershipRegistry()
  const leakEntry = { identity: { id: 'tex:leak', version: 'v1' }, deviceScope: 's1' }
  leak.acquire(leakEntry, () => {})
  leak.acquire(leakEntry, () => {})
  leak.release(leakEntry)
  const leakLedger = leak.ledger()

  // 负对照 2：提前释放（无 acquire 就 release / 重复 release）
  const early = new OwnershipRegistry()
  const earlyEntry = { identity: { id: 'tex:early', version: 'v1' }, deviceScope: 's1' }
  early.acquire(earlyEntry, () => {})
  early.release(earlyEntry)
  const secondRelease = early.release(earlyEntry)
  const neverAcquired = early.release({ identity: { id: 'tex:never', version: 'v1' }, deviceScope: 's1' })

  // 真实 GL 侧：确认我们确实在一个活的上下文里做了这些（不是空跑计数）
  const liveCalls = (() => {
    const p = new BatchedPresenter({ scope: 'e2e-a19-gl' })
    p.apply(scene)
    h.scene.add(p.object3d)
    const m = measureDrawCalls(h)
    p.dispose()
    h.scene.remove(p.object3d)
    return m.calls
  })()

  return {
    rounds,
    firstCloseActive,
    minOtherSideActive,
    allRoundsBackToBaseline,
    allRoundsPreservedOtherSide,
    balancedEveryRound,
    sharedAcquire: sharedLedger.acquireTotal,
    sharedRelease: sharedLedger.releaseTotal,
    sharedZeroCrossings: sharedLedger.zeroCrossings,
    sharedDispose: sharedLedger.disposeTotal,
    sharedDisposeCalls: disposeCalls,
    sharedBalanced: sharedLedger.balanced,
    negativeLeakBalanced: leakLedger.balanced,
    negativeLeakActive: leakLedger.activeCount,
    negativeLeakAcquire: leakLedger.acquireTotal,
    negativeLeakRelease: leakLedger.releaseTotal,
    negativeEarlySecondReleaseOk: secondRelease.ok,
    negativeEarlySecondReleaseReason: secondRelease.ok ? null : secondRelease.reason,
    negativeNeverAcquiredOk: neverAcquired.ok,
    liveGlDrawCalls: liveCalls,
    fixtureHash: fixture.hash,
    env: h.env,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A30 graphics-recovery
// ─────────────────────────────────────────────────────────────────────────────

export async function runA30(count: number) {
  const h = need()
  const fixture = pickFixture(count)
  const compiled = compileScene({ key: keyOf('e2e:a30'), geometry: fixture.geometry, primitives: fixture.primitives })
  if (!compiled.ok) throw new Error('compile failed')
  const scene = compiled.value

  const presenter = new BatchedPresenter({ scope: 'e2e-a30' })
  presenter.apply(scene)
  h.scene.add(presenter.object3d)
  h.renderer.render(h.scene, h.camera)

  const devices = new ViewportDeviceRegistry()
  const a = devices.machineFor('r-viewport')
  const b = devices.machineFor('r-wiki-preview')
  a.markPresented(scene.generation, 0)
  b.markPresented(scene.generation, 0)

  const beforeActive = presenter.ledger().activeCount
  const beforeChildren = presenter.object3d.children.length

  // ── 真实上下文丢失 ──
  const gl = h.renderer.getContext()
  const loseExt = gl.getExtension('WEBGL_lose_context') as { loseContext(): void; restoreContext(): void } | null
  const hadLoseExt = loseExt !== null
  if (loseExt !== null) loseExt.loseContext()
  // 丢失事件是异步派发的；等它落地
  await new Promise((r) => setTimeout(r, 250))
  const contextLostFlag = h.renderer.getContext().isContextLost()

  a.markLost('webglcontextlost', 1)
  presenter.handleContextLost()

  const afterLossActive = presenter.ledger().activeCount
  const afterLossChildren = presenter.object3d.children.length
  const submittableAfterLoss = devices.submittableViewports()
  const pendingAfterLoss = devices.pending().map((p) => ({ viewportId: p.viewportId, phase: p.state.phase }))

  // ── 恢复 ──
  a.markRecovering(2)
  const canSubmitWhileRecovering = a.canSubmit()
  const heldWhileRecovering = a.heldGeneration()
  presenter.handleContextRestored()
  a.markRestored(3)

  // 恢复失败路径（独立视口，不影响上面两个）：可诊断 + 可重试
  const c = devices.machineFor('r-third')
  c.markLost('lost', 1)
  c.markRecovering(2)
  c.markRestoreFailed('context create failed', true, 3)
  const failedState = c.current
  const retryWorks = c.markRecovering(4)

  // 用**当前有效版本**重建
  presenter.apply(scene)
  a.markPresented(scene.generation, 4)
  h.renderer.render(h.scene, h.camera)
  const afterRestoreCalls = (() => {
    try {
      return measureDrawCalls(h).calls
    } catch {
      return -1
    }
  })()

  const afterRestoreActive = presenter.ledger().activeCount
  const afterRestoreChildren = presenter.object3d.children.length

  if (loseExt !== null) {
    loseExt.restoreContext()
    await new Promise((r) => setTimeout(r, 250))
  }

  return {
    hadLoseExt,
    contextLostFlag,
    beforeActive,
    beforeChildren,
    afterLossActive,
    afterLossChildren,
    submittableAfterLoss,
    pendingAfterLoss,
    canSubmitWhileRecovering,
    heldWhileRecovering,
    failedPhase: failedState.phase,
    failedRetryable: failedState.phase === 'failed' ? failedState.retryable : null,
    retryWorks,
    generationBefore: scene.generation,
    generationAfter: presenter.currentGeneration,
    generationUnchangedByRestore: presenter.currentGeneration === scene.generation,
    restores: presenter.restores,
    afterRestoreActive,
    afterRestoreChildren,
    afterRestoreCalls,
    summary: devices.summary(),
    abandoned: presenter.ledger().acquireTotal,
    fixtureHash: fixture.hash,
    env: h.env,
  }
}

/** A30 负对照：只 resize（`handleContextRestored()`）而不重建归属资源。 */
export function runA30Negative(count: number) {
  const fixture = pickFixture(count)
  const compiled = compileScene({ key: keyOf('e2e:a30-neg'), geometry: fixture.geometry, primitives: fixture.primitives })
  if (!compiled.ok) throw new Error('compile failed')

  const presenter = new BatchedPresenter({ scope: 'e2e-a30-neg' })
  presenter.apply(compiled.value)
  presenter.handleContextLost()
  // 破坏方式：只"恢复"而不重新 apply 归属资源
  presenter.handleContextRestored()

  return {
    children: presenter.object3d.children.length,
    active: presenter.ledger().activeCount,
    generation: presenter.currentGeneration,
    restores: presenter.restores,
    fixtureHash: fixture.hash,
  }
}
