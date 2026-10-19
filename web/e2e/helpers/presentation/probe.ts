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
import { kernelPresentationInputs } from '@/composition/kernelPresentationInputs'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { projectGridCells } from '@/composition/kernelProjection'
import { plainRootOf } from '@/adapters/plainRoot'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { collectStructureGeometryPiecesPure, mergeBakedQuadPiecesAttributes } from '@/render/mesh/structureGeometryCore'
import { BatchedPresenter } from '@/presentation/presenter'
import type { EvaluationKey } from '@/presentation/evaluationKey'
// P11-E #262（A30 补）：会话面（生产视口用的那一层）+ 文档/时间/选择的真实类型
import { PresenterSession } from '@/composition/presenterSession'
import { createDocument } from '@/domain/document'
import { timeValue } from '@/domain/animation'
import { ALL_CAPABILITIES, openDocumentState, reduceCommand } from '@/application/commands'
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
/**
 * D3c（#289 P10d）· **内核场景**作为呈现层的第二输入源。
 *
 * ## 为什么需要这个入口（实测的接线缺口）
 *
 * `runA18`/`runA19`/`runA30` 的输入全部来自 `pickFixture(count)` —— **自造图元**，
 * 直接喂 `compileScene`。它们证明的是"编译 → 呈现"那一段，
 * **绕过**了"内核场景 → `PresentationInputs`"这一环。
 *
 * 即：真 WebGL 判据全绿，也不能说明内核承载的内容能被呈现层吃下。
 *
 * ## 输入是**原始信封**，装配在浏览器里用**生产代码**做
 *
 * 第一版让 spec 在 Node 侧解包并取出 `cells`/`geometry` —— **实测失败**：
 * 磁盘上的夹具是**声明**（`multiblock` 节点），逐格网格是**装配产物**；
 * `.out/expanded-fixtures` 里只有 `variant`/`dims`/`cellGrid` 的**参考签名**，
 * 不含带几何资产的载荷。
 *
 * ⇒ 正确形态：spec 只传**原始信封 JSON**，探针在浏览器里走完整生产链
 * （`createParserRegistry` → `assembleKernelDocument`）再喂呈现层。
 * 这比"Node 侧取字段"证明得更多：整条 **内核装配 → 呈现** 链都在真 GL 环境里跑过。
 *
 * ## 判据的形状：与**渲染路径**逐位一致 + 真 GL 真的画了
 *
 * - `kernelTriangles` 与 `mergeBakedQuadPiecesAttributes(collectStructureGeometryPiecesPure(def))`
 *   逐位相同（同一收集器 ⇒ 任一侧偏离立刻判红）；
 * - `measuredCalls > 0` 且 `measuredTriangles > 0`（几何真的被提交，不是空批次）；
 * - `pickedObjectId` 能解回**内核对象 id**（证明身份链没断）。
 */
export async function runKernelInputs(envelope: Record<string, unknown>) {
  const h = need()

  // ① 完整生产链：信封 → 解析 → 内核装配
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  const parsed = await parsers.detectAndParse(envelope)
  if (parsed.document === null) throw new Error('解析失败：生产解析器拒收该信封')
  const assembled = assembleKernelDocument({ doc: parsed.document, plainRoot: plainRootOf(envelope) })
  if (!assembled.ok) throw new Error(`内核装配失败：${JSON.stringify(assembled.error)}`)
  const kernel = assembled.value

  // ② 内核场景 → 呈现输入 → 编译
  //
  // ⚠️ `layerWorldY` 必填（C8 起它是**唯一**的层过滤输入，见
  // `composition/kernelPresentationInputs` 的字段说明）。此前本探针**漏传** ⇒
  // 生产代码读到 `undefined`，而它的分支是 `layerWorldY === null ? 'all' : {worldY}`
  // ⇒ 变成 `{worldY: undefined}` ⇒ `effectiveVoxelState` 把所有体素判成不可见
  // ⇒ `empty-geometry` ⇒ `primitives: 0`。这正是 D3c 自 P10d 起长期判红的原因
  // （**探针缺陷，不是生产缺陷** —— 视口侧一直传值）。
  const produced = kernelPresentationInputs({
    scene: kernel.scene,
    content: kernel.content,
    key: keyOf('e2e:kernel'),
    layerWorldY: null,
  })
  const compiled = compileScene(produced.inputs)
  if (!compiled.ok) throw new Error(`compileScene failed: ${JSON.stringify(compiled.error)}`)
  const compiledScene = compiled.value

  // ③ 真实 GL：apply + 实测绘制数
  const presenter = new BatchedPresenter({ scope: 'e2e-kernel' })
  presenter.apply(compiledScene)
  h.scene.add(presenter.object3d)
  const measured = measureDrawCalls(h)

  // ④ 身份链：批次槽位 → 对象身份
  const pickIndex = new PickIndex(compiledScene)
  const hit = pickIndex.resolve({ generation: pickIndex.currentGeneration, batchIndex: 0, instanceSlot: 0 })

  // ⑤ 渲染路径的**独立复算**（同一收集器）
  const payload = Object.values(kernel.scene.data)
    .map((d) => d.payload)
    .find((x) => x.kind === 'blockGrid')
  //
  // ## 逐**材质组**复算（C6 起一个 `blockGrid` 对象 → 逐 `materialIndex` 多个图元）
  //
  // 本探针原先把 `primitives[0]`（**一个**材质组）与"全部片段的合并"比 ⇒ C6 之后
  // 必然不相等（12 vs 24 三角形）—— 那同样是**探针缺陷**（与 `layerWorldY` 漏传同批）。
  // 正确口径：渲染侧按 `materialIndex` 分组、各自合并，与内核侧逐 `material:<下标>` 图元对位。
  const pieces =
    payload === undefined || payload.kind !== 'blockGrid'
      ? []
      : collectStructureGeometryPiecesPure(definitionOfKernelPayload(payload, kernel.content)).pieces
  const byMaterial = new Map<number, typeof pieces>()
  for (const piece of pieces) {
    const list = byMaterial.get(piece.materialIndex)
    if (list === undefined) byMaterial.set(piece.materialIndex, [piece])
    else list.push(piece)
  }
  const referenceGroups = new Map<number, { positions: Float32Array; uvs: Float32Array }>()
  for (const [mi, list] of byMaterial) referenceGroups.set(mi, mergeBakedQuadPiecesAttributes(list))
  const reference = mergeBakedQuadPiecesAttributes(pieces)

  /** 逐图元与参考组对位（`material:<下标>` 是绑定键约定，见 `kernelTextureResources`）。 */
  const groupOf = (primitive: (typeof produced.inputs.primitives)[number]) => {
    const mi = Number.parseInt(String(primitive.material.id).replace('material:', ''), 10)
    return Number.isInteger(mi) ? referenceGroups.get(mi) : undefined
  }
  const groupsMatch = produced.inputs.primitives.every((prim) => {
    const attrs = produced.inputs.geometry.attributesOf(prim.geometry.id)
    const ref = groupOf(prim)
    if (attrs === undefined || ref === undefined) return false
    return (
      attrs.positions.length === ref.positions.length &&
      attrs.positions.every((v, i) => v === ref.positions[i]) &&
      attrs.uvs.length === ref.uvs.length &&
      attrs.uvs.every((v, i) => v === ref.uvs[i])
    )
  })
  const kernelTriangles = produced.inputs.primitives.reduce((n, prim) => {
    const attrs = produced.inputs.geometry.attributesOf(prim.geometry.id)
    return n + (attrs?.triangleCount ?? 0)
  }, 0)

  presenter.dispose()
  h.scene.remove(presenter.object3d)

  return {
    primitives: produced.inputs.primitives.length,
    skipped: produced.skipped,
    compileSkipped: compiledScene.skipped,
    payloads: compiledScene.payloads.length,
    drawCallEstimate: compiledScene.drawCallEstimate,
    measuredCalls: measured.calls,
    measuredTriangles: measured.triangles,
    kernelTriangles,
    referenceTriangles: reference.positions.length / 9,
    bitsEqual: groupsMatch,
    pickedObjectId: hit?.objectId ?? null,
  }
}

/** 从内核载荷重建网格定义（与 `kernelPresentationInputs` 内部同一路径；判据侧独立复算）。 */
function definitionOfKernelPayload(
  payload: { kind: 'blockGrid' } & Record<string, unknown>,
  content: { resources: readonly { kind: string }[] },
) {
  const projected = projectGridCells({
    cells: payload.cells as never,
    geometry: payload.geometry as never,
    cellGeometry: payload.cellGeometry as never,
    cellPalette: payload.cellPalette as never,
    palette: payload.palette as never,
    cellContent: payload.cellContent as never,
  })
  return {
    geometryPhase: 'baked',
    cellGrid: projected.cellGrid,
    blockPalette: projected.blockPalette,
    materialPalette: content.resources.map((r) => ({ kind: r.kind })),
  }
}

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
    // M8 裁决② 起两条读面分工：`balanced` = 记账守恒（含设备丢失的单列放弃），
    // `atBaseline` = 活跃计数回基线。"每轮全部关闭后"两者都必须成立。
    if (!aLedger.balanced || !bLedger.balanced) balancedEveryRound = false
    if (!aLedger.atBaseline || !bLedger.atBaseline) balancedEveryRound = false

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
    sharedAtBaseline: sharedLedger.atBaseline,
    // 负对照 1 的**判红读数**（M8 裁决②口径）：漏一次 release ⇒ 仍有一份份额在服役，
    // 且活跃计数**没有**回基线。记账本身不说谎（`balanced` 仍为 true —— 份额确实在账上），
    // 因此判红不能只靠 `balanced`；这两个读数才是"少一次 dispose"的可判定形态。
    negativeLeakBalanced: leakLedger.balanced,
    negativeLeakAtBaseline: leakLedger.atBaseline,
    negativeLeakLiveRefs: leakLedger.liveRefs,
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

/**
 * A30 `graphics-recovery`（**真实 `WEBGL_lose_context`**）。
 *
 * ## P11-E #262 补：恢复后「文档 / 选择 / 时间 / 机位」四项不丢
 *
 * B1 的审计原文：`presenterSession.ts:307/316` 的 `handleContextLost/Restored`
 * 承载面具备，但**探针返回字段表完整列出也没有这四项** ⇒ 判据缺失。
 * 故本函数增加一段**会话面**（`PresenterSession`，即生产视口实际用的那一层）：
 * 用真实信封装配出的内核文档 + 领域时间 + 真实选择 + 视口机位，
 * 在与上面同一次真实上下文丢失/恢复**之后**逐项核对它们是否还在。
 *
 * 为此需要真实信封（`envelope` 可选）：缺省时该段不跑，相应字段为 `null`
 * —— spec 侧显式传入夹具，使字段**总是**有值（判据不落在"没跑也算过"上）。
 */
export async function runA30(count: number, envelope?: Record<string, unknown>) {
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

  // ── P11-E #262 补：会话面（文档 / 选择 / 时间 / 机位）在恢复后不丢 ──
  const sessionProbe = await runA30SessionFace(envelope, hadLoseExt, loseExt)

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
    ...sessionProbe,
  }
}

/**
 * A30 的**会话面**（`PresenterSession`）探针：一次真实上下文丢失/恢复周期前后，
 * 逐项核对「文档 / 选择 / 时间 / 机位」。
 *
 * 返回四个布尔字段（缺信封时为 `null`）+ 一份可诊断明细（供证据附件阅读）。
 */
async function runA30SessionFace(
  envelope: Record<string, unknown> | undefined,
  hadLoseExt: boolean,
  loseExt: { loseContext(): void; restoreContext(): void } | null,
): Promise<Record<string, unknown>> {
  if (envelope === undefined) {
    return {
      sessionDocPreserved: null,
      sessionSelectionPreserved: null,
      sessionTimePreserved: null,
      sessionCameraPreserved: null,
      sessionDetail: null,
    }
  }
  const h = need()
  // ① 真实信封 → 解析 → 内核装配（与 `runKernelInputs` 同一条生产链）
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  const parsed = await parsers.detectAndParse(envelope)
  if (parsed.document === null) throw new Error('A30 会话面：生产解析器拒收该信封')
  const assembled = assembleKernelDocument({ doc: parsed.document, plainRoot: plainRootOf(envelope) })
  if (!assembled.ok) throw new Error('A30 会话面：内核装配失败')

  // ② 文档：内核 `Document`（生产调用点同形）
  const doc = { ...createDocument('e2e-a30-session'), scene: assembled.value.scene, content: assembled.value.content }
  // ③ 时间：领域时间值（帧 7 / 20fps）
  const time = timeValue(7, 20)

  // ④ 选择：真实应用状态里的 `EditContext.selection`
  let app = openDocumentState('e2e-a30-session', 'ctx-a30')
  const added = reduceCommand(app, { kind: 'addObject', contextId: 'ctx-a30', objectType: 'annotation', name: 'sel' }, { capabilities: ALL_CAPABILITIES })
  if (added.status !== 'applied') throw new Error('A30 会话面：夹具选择失败')
  app = added.state
  const objectId = Object.keys(app.docs['e2e-a30-session']!.scene.objects)[0]!
  const selected = reduceCommand(app, { kind: 'select', contextId: 'ctx-a30', target: { kind: 'object', id: objectId } }, { capabilities: ALL_CAPABILITIES })
  if (selected.status !== 'applied') throw new Error('A30 会话面：夹具选择未生效')
  app = selected.state
  const selectionBefore = JSON.stringify(app.contexts['ctx-a30']!.selection.selected)

  // ⑤ 机位：视口观察相机（**不在**内核文档里 —— A05/A11 的结构事实）
  const camera = h.camera
  const cameraBefore = camera.matrixWorld.elements.slice()

  const session = new PresenterSession({ scope: 'e2e-a30-session' })
  const first = session.applyKernelDocument(doc, time)
  const generationBefore = session.generation
  const timeKeyBefore = JSON.stringify(session.activeKey?.time ?? null)

  // ── 真实上下文丢失 / 恢复（同一扩展，另一个会话） ──
  if (hadLoseExt && loseExt !== null) {
    loseExt.loseContext()
    await new Promise((r) => setTimeout(r, 250))
  }
  const abandoned = session.handleContextLost()
  session.handleContextRestored()
  if (hadLoseExt && loseExt !== null) {
    loseExt.restoreContext()
    await new Promise((r) => setTimeout(r, 250))
  }

  // 用**当前有效版本**重新应用：内容身份未变，但 P11-F 段② 起**必须**强制重建 GPU
  //（否则内容未变的上下文丢失 ⇒ 画面永久空白 —— 这正是 P11-E 实测的缺口）。
  const again = session.applyKernelDocument(doc, time)
  const generationAfter = session.generation
  const outcomeGenerationAfter = again.generation
  const mountedBatchesAfterRestore = session.object3d.children.length
  const pendingRebuildAfterRestore = session.pendingRebuild
  const timeKeyAfter = JSON.stringify(session.activeKey?.time ?? null)
  const cameraAfter = camera.matrixWorld.elements.slice()

  // 对照：内容再变一次也必须重建（并换世代）—— 证明"恢复能重建"不是"永远不换世代"
  const bumped = { ...doc, version: { ...doc.version, documentVersion: doc.version.documentVersion + 1 } }
  const afterBump = session.applyKernelDocument(bumped, time)
  const liveGenerationAfterContentChange = session.generation

  const detail = {
    firstApplied: first.applied,
    againApplied: again.applied,
    outcomeGenerationAfter,
    liveGenerationAfterRestore: generationAfter,
    liveGenerationAfterContentChange,
    mountedBatchesAfterRestore,
    afterBumpApplied: afterBump.applied,
    abandoned,
    generationBefore,
    timeKeyBefore,
    timeKeyAfter,
    selectionBefore,
    selectionAfter: JSON.stringify(app.contexts['ctx-a30']!.selection.selected),
    objectId,
  }
  session.dispose()

  return {
    // 「文档不丢」的口径（P11-F 段② 更新）：恢复后**同一份文档 + 时间**必须得到
    // **同一个世代**（内容身份未变 ⇒ 恢复没有重置文档/时间），且重建确实发生。
    sessionDocPreserved: generationAfter !== null && generationAfter === generationBefore && again.applied === true,
    sessionSelectionPreserved: detail.selectionBefore === detail.selectionAfter,
    sessionTimePreserved: detail.timeKeyBefore === detail.timeKeyAfter,
    sessionCameraPreserved: cameraBefore.length === cameraAfter.length && cameraBefore.every((v, i) => v === cameraAfter[i]),
    // P11-F 段② 的**正向**读数（原 P11-E 缺口登记已升级）：
    // ① 内容未变 + 上下文丢失 ⇒ 恢复**真的强制重建**（绕过内容身份短路）；
    // ② 重建后**有挂载**（画面非空白的结构代理）；
    // ③ 会话**返回结果**的世代与实际世代**同源**（不再静默不一致）。
    sessionForcedRebuildAfterRestore: again.applied === true,
    sessionGpuRebuiltAfterRestore: generationAfter !== null,
    sessionMountedBatchesAfterRestore: mountedBatchesAfterRestore,
    // 「一次成功重建即复位」在真机上的读数（`pendingRebuild` 的消费者：视口可用它判断
    // "下一帧是否必然重建"，而这里钉住它的生命周期）
    sessionPendingRebuildAfterRestore: pendingRebuildAfterRestore,
    sessionGenerationConsistent: outcomeGenerationAfter === generationAfter,
    sessionGpuRebuiltAfterContentChange: liveGenerationAfterContentChange !== null
      && liveGenerationAfterContentChange !== generationBefore,
    sessionDetail: detail,
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