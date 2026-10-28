/**
 * **浏览器侧标定探针**（真实 Chromium + 真实 WebGL）。
 *
 * ## 为什么在 `web/tests/perf/e2e/` 而不是 `web/e2e/`
 *
 * Playwright 的 `testDir` 是 `./e2e`（`playwright.config.ts`，不随标定改动）。
 * 标定探针与 spec 放在 `web/tests/perf/e2e/` 后：
 *
 *  - `npm run test:e2e` / `:smoke` / `:full` 的**收集面一字不变**（L2/L3 用例数不受影响）；
 *  - 同时仍在 **vite root 之内** ⇒ 它们能被 dev server 转译，`three` / `@/…` 说明符正常解析
 *    （`page.evaluate(() => import('three'))` 必然失败 —— 裸说明符无 import map，见
 *    `e2e/helpers/presentation/probe.ts` 文件头的实测记录）。
 *
 * 跑法见同目录 `playwright.perf.config.ts` 的文件头。
 *
 * ## 它测的是什么
 *
 * `src/**` 的**生产模块**在真实 GPU 上的行为：编译/合批、GPU 上传与绘制、RAF 帧循环、
 * 拾取、以及**浏览器里的完整装载脊柱**（信封 → 解析 → 内核装配 → 呈现输入）。
 * 零替身：没有 mock/fake/stub，夹具来自生产夹具构造器与 `tests/perf/fixtures/generate.mjs`。
 */
import * as THREE from 'three'
import { compileScene } from '@/presentation/compileScene'
import { PickIndex } from '@/presentation/pickingIndex'
import { BatchedPresenter } from '@/presentation/presenter'
import { kernelPresentationInputs } from '@/composition/kernelPresentationInputs'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { plainRootOf } from '@/adapters/plainRoot'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { decodeEnvelope } from '@/adapters/files/envelopeCodec'
import type { EvaluationKey } from '@/presentation/evaluationKey'
import { DEFAULT_MATERIAL, MemoryGeometrySource, makeAttributes, makeHomogeneousFixture } from '@/presentation/__tests__/fixtures'

interface Harness {
  readonly THREE: typeof THREE
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly canvas: HTMLCanvasElement
}

let harness: Harness | null = null

/** 建一个真实 `WebGLRenderer` 并挂进页面（每页一次）。 */
export function installPerfHarness(): { ok: true } {
  if (harness !== null) return { ok: true }
  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 800
  canvas.id = 'p11c-perf-canvas'
  document.body.appendChild(canvas)

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true })
  renderer.setSize(1280, 800, false)
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1280 / 800, 0.1, 50000)
  camera.position.set(0, 0, 2000)
  camera.lookAt(0, 0, 0)
  harness = { THREE, renderer, scene, camera, canvas }
  return { ok: true }
}

function need(): Harness {
  if (harness === null) throw new Error('perf harness 未安装')
  return harness
}

/** GPU 与上下文事实（B2 §2.2 要求记录 GPU 后端；软件渲染下 GPU 类指标作废）。 */
export function gpuInfo(): Record<string, unknown> {
  const h = need()
  const gl = h.renderer.getContext()
  let rendererName = 'unavailable'
  let vendorName = 'unavailable'
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    if (dbg !== null) {
      rendererName = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      vendorName = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL))
    }
  } catch {
    /* 诊断取不到不影响判据 */
  }
  const lower = `${rendererName} ${vendorName}`.toLowerCase()
  const software = /swiftshader|software|llvmpipe|basic render/.test(lower)
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory
  return {
    webgl2: h.renderer.capabilities.isWebGL2,
    maxTextureSize: h.renderer.capabilities.maxTextureSize,
    renderer: rendererName,
    vendor: vendorName,
    threeRevision: Number(THREE.REVISION),
    gpuBackend: software ? 'software' : 'hardware',
    hardwareConcurrency: navigator.hardwareConcurrency,
    devicePixelRatio: window.devicePixelRatio,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    jsHeapUsedBytes: mem?.usedJSHeapSize ?? null,
    jsHeapLimitBytes: mem?.jsHeapSizeLimit ?? null,
  }
}

function keyOf(scene: string): EvaluationKey {
  return {
    documentVersion: 1,
    scene,
    time: { seconds: 0, numerator: 0, denominator: 1 },
    parameterVersion: 0,
    contentResourceVersions: {},
  }
}

/** 造 `count` 个共享几何/材质对象（A18 均质夹具；与 vitest 侧同一实现）。 */
function fixtureOf(count: number) {
  const geometry = new MemoryGeometrySource()
  geometry.set('geo:cube', 'v1', makeAttributes(12))
  const primitives = makeHomogeneousFixture(count)
  return { key: keyOf(`p11c:web:${count}`), geometry, primitives }
}

/** 单次 `renderer.render` 的耗时（先空转 2 帧让 program 编译落地，再逐帧计时）。 */
function renderSamples(h: Harness, n: number): { samplesMs: number[]; calls: number; triangles: number } {
  for (let i = 0; i < 2; i++) h.renderer.render(h.scene, h.camera)
  h.renderer.info.autoReset = false
  h.renderer.info.reset()
  const samplesMs: number[] = []
  // ⚠️ **计时分辨率**：浏览器对 `performance.now()` 做粗化（本环境观测到 0.1 ms 量化）。
  // 单帧提交远低于该粒度时读数会贴在量化台阶上（实测 median 0.1 ms、两轮比值失真）——
  // 这是**测量设施的下限**，不是"渲染免费"。故这里**批量提交**：每轮连续渲染 `batch` 帧，
  // 读到的时长除以 `batch`，把量化误差摊薄到可分辨的量级。
  const batch = 20
  const rounds = Math.max(5, Math.ceil(n / batch))
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now()
    for (let k = 0; k < batch; k++) h.renderer.render(h.scene, h.camera)
    samplesMs.push((performance.now() - t0) / batch)
  }
  const calls = h.renderer.info.render.calls / (rounds * batch)
  const triangles = h.renderer.info.render.triangles / (rounds * batch)
  h.renderer.info.autoReset = true
  return { samplesMs, calls, triangles }
}

/**
 * **渲染重编**：编译 → 合批 → GPU 上传（`apply`）→ 逐帧绘制。
 *
 * 三个子口径分开报（「纯数据投影与有副作用的 GPU 上传分开」）：
 * `compileMs` 是纯函数、`applyMs` 含 GPU 上传、`renderMs` 是每帧提交。
 */
export function runRecompile(count: number, samples: number) {
  const h = need()
  const input = fixtureOf(count)

  // 预热一次，避免把 program 首次编译算进 compileMs
  const warm = compileScene(input)
  if (!warm.ok) throw new Error(`compileScene 失败：${JSON.stringify(warm.error)}`)

  const compileMs: number[] = []
  let compiled = warm.value
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now()
    const r = compileScene(input)
    compileMs.push(performance.now() - t0)
    if (!r.ok) throw new Error('compileScene 失败')
    compiled = r.value
  }

  const presenter = new BatchedPresenter({ scope: 'p11c-perf' })
  const applyMs: number[] = []
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now()
    presenter.apply(compiled)
    applyMs.push(performance.now() - t0)
  }
  h.scene.add(presenter.object3d)

  const rendered = renderSamples(h, Math.max(5, Math.min(samples, 11)))
  const stats = presenter.statsSnapshot()
  // ⚠️ 取账时机（`e2e/helpers/presentation/probe.ts` 的 A19 段实测过同一个坑）：
  // 仍**合法持有**资源时读 `balanced` 必然为假（acquireTotal 2 / releaseTotal 0）——
  // 那是"还没释放"，不是"泄漏"。故两笔账分别取：持有中读 activeCount，dispose 后读 balanced。
  const ledgerWhileHeld = presenter.ledger()

  // 拾取：索引构建 + 单次解算 + 全量解算上界
  const buildMs: number[] = []
  let idx = new PickIndex(compiled)
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now()
    idx = new PickIndex(compiled)
    buildMs.push(performance.now() - t0)
  }
  const gen = idx.currentGeneration
  const prov = compiled.provenance
  // 全量解算：**多轮采样**（≥5），单轮只给一个数会低估离散度。
  const resolveAllMs: number[] = []
  let hits = 0
  for (let i = 0; i < Math.max(5, samples); i++) {
    const t0 = performance.now()
    hits = 0
    for (const p of prov) if (idx.resolve({ generation: gen, batchIndex: p.batchIndex, instanceSlot: p.instanceSlot }) !== null) hits++
    resolveAllMs.push(performance.now() - t0)
  }

  const objectProof = {
    objects: count,
    plans: compiled.plans.length,
    payloads: compiled.payloads.length,
    provenance: prov.length,
    drawCallEstimate: compiled.drawCallEstimate,
    measuredDrawCalls: rendered.calls,
    measuredTriangles: rendered.triangles,
    instanceCount: stats.instanceCount,
    batchObjects: stats.batchObjects,
    ledgerActiveWhileHeld: ledgerWhileHeld.activeCount,
    ledgerAcquireTotal: ledgerWhileHeld.acquireTotal,
    pickHits: hits,
  }

  presenter.dispose()
  h.scene.remove(presenter.object3d)
  // dispose **之后**才谈"台账平衡"
  const ledgerAfterDispose = presenter.ledger()

  return {
    compileMs,
    applyMs,
    renderMs: rendered.samplesMs,
    pickBuildMs: buildMs,
    pickResolveAllMs: resolveAllMs,
    objectProof: {
      ...objectProof,
      ledgerActiveAfterDispose: ledgerAfterDispose.activeCount,
      ledgerBalancedAfterDispose: ledgerAfterDispose.balanced,
    },
  }
}

/** **帧循环步进**：真实 RAF 间隔序列（B2 §4.3「帧时间」）。 */
export function runFrameGaps(frames: number): Promise<{ gapsMs: number[]; rafTimestamps: number[] }> {
  return new Promise((resolve) => {
    const gapsMs: number[] = []
    const rafTimestamps: number[] = []
    let last = performance.now()
    let n = 0
    const tick = (t: number): void => {
      gapsMs.push(t - last)
      rafTimestamps.push(t)
      last = t
      if (++n < frames) requestAnimationFrame(tick)
      else resolve({ gapsMs, rafTimestamps })
    }
    requestAnimationFrame(tick)
  })
}

/**
 * **浏览器里的完整装载脊柱**：信封 → 解析 → 内核装配 → 呈现输入。
 *
 * 与纯函数侧同一条生产链，但跑在真实浏览器里（含真实的 TextDecoder/atob/gzip 路径）。
 * 入参是**原始信封 JSON**（spec 只负责把磁盘字节送进来，不做任何解读）。
 */
export async function runBrowserLoad(envelope: Record<string, unknown>, samples: number) {
  const decodeMs: number[] = []
  const parseMs: number[] = []
  const assembleMs: number[] = []
  const toInputsMs: number[] = []
  let proof: Record<string, unknown> = {}

  for (let i = 0; i < samples; i++) {
    const t0 = performance.now()
    const decoded = decodeEnvelope(envelope)
    decodeMs.push(performance.now() - t0)
    if (!decoded.ok) throw new Error(`decodeEnvelope 失败：${JSON.stringify(decoded.error)}`)

    const parsers = createParserRegistry()
    parsers.register(V2PlainParser)
    parsers.register(createEnvelopeParser(parsers))
    parsers.register(WorldParser)
    parsers.register(StructureDataParser)
    const t1 = performance.now()
    const parsed = await parsers.detectAndParse(envelope)
    parseMs.push(performance.now() - t1)
    if (parsed.document === null) throw new Error('生产解析器拒收夹具')

    const t2 = performance.now()
    const assembled = assembleKernelDocument({ doc: parsed.document, plainRoot: plainRootOf(envelope) })
    assembleMs.push(performance.now() - t2)
    if (!assembled.ok) throw new Error(`内核装配失败：${JSON.stringify(assembled.error)}`)

    const t3 = performance.now()
    const produced = kernelPresentationInputs({
      scene: assembled.value.scene,
      content: assembled.value.content,
      key: keyOf(`p11c:webload:${i}`),
    })
    toInputsMs.push(performance.now() - t3)

    proof = {
      kernelObjects: Object.keys(assembled.value.scene.objects).length,
      primitives: produced.inputs.primitives.length,
      skipped: produced.skipped.length,
    }
  }
  return { decodeMs, parseMs, assembleMs, toInputsMs, objectProof: proof }
}
