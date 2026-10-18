/**
 * **P10f/E（#301）导出面端口的浏览器侧探针**（经 vite 转译加载）。
 *
 * ## 为什么必须在浏览器里跑这一段（本批的硬边界）
 *
 * 本仓 `gl@8.1.6`（headless-gl）是 **WebGL 1.0**，而锁定的 `three ^0.174.0`
 * 硬编码请求 **`webgl2`** ⇒ 无头环境下 `new THREE.WebGLRenderer` **必然抛**
 * （实测 `TypeError: gl.texImage3D is not a function`）。
 * `package.json` 属本批硬边界 ⇒ **真实 GPU 填充只能在这里证明**。
 *
 * vitest 侧（`src/adapters/export/__tests__/exportPorts.test.ts`）用**受控设备**
 * 证明了除 GL 驱动外的每一环（取景、逐帧键、编译挂载、PNG 字节、生命周期）。
 * 本探针补的是最后一段：**真 GL 真的把像素填进了渲染目标、且能被读回**。
 *
 * ## 零替身
 *
 * 全程走生产实现：`assembleSnapshotExportJob` + `createThreeOffscreenDevice` +
 * 真实 `ExportJob.run()`。不 mock 任何东西。
 *
 * ## 为什么不 `page.evaluate(() => import('three'))`
 *
 * Playwright 把函数序列化后**裸执行**，裸说明符没有 import map 可解析
 * （实测 `Failed to resolve module specifier 'three'`）。故探针放在 vite root 内。
 */

import * as THREE from 'three'
import { assembleSnapshotExportJob } from '@/adapters/export/snapshotExportJob'
import { createThreeOffscreenDevice } from '@/adapters/export/renderDevice'
import { planExportRequest } from '@/application/exportPlan'
import type { CameraSpec, CaptureSpec } from '@/domain/captureSpec'
import { EMPTY_ANIMATION } from '@/domain/animation'
import type { Scene } from '@/domain/scene'
import type { DocumentContent } from '@/domain/content'

/** 从**真实工作台实例**里取当前内核文档的场景与内容（S0）。 */
function liveKernel(): { scene: Scene; content: DocumentContent } | null {
  const ctx = (window as unknown as { __vm__?: Record<string, any> }).__vm__
  if (ctx === undefined) return null
  // `ctx.kernel` 是可空的构造参数（`runtime/context.ts:115`）；生产宿主都传。
  const session = ctx.kernel ?? null
  if (session === null || session === undefined) return null
  // `KernelSession.document()`：`Document | undefined`（`runtime/kernelSession.ts:404`）。
  const doc = typeof session.document === 'function' ? session.document() : null
  if (doc === null || doc === undefined) return null
  const scene = doc.scene as Scene | undefined
  const content = doc.content as DocumentContent | undefined
  if (scene === undefined || content === undefined) return null
  return { scene, content }
}

/**
 * 取生产工作台里**已装配的呈现根**（`vpSlot.presenterSurface.object3d`）。
 *
 * 与 `e2e/helpers/p10e/probe.ts` 的 `slotWithSurface` 同一手法：经
 * `window.__vm__.viewports` 读，**不**经组件 ref（会话挂在 `ViewportSlot` 上，
 * 其寿命不依赖组件挂载 —— #249 明文）。
 */
function presenterRoot(): THREE.Object3D | null {
  const ctx = (window as unknown as { __vm__?: Record<string, any> }).__vm__
  const slots = ctx?.viewports
  if (slots === undefined) return null
  const candidates: any[] = []
  const active = slots.active?.value
  if (active) candidates.push(active)
  for (const id of ['r-viewport', 'r-wiki-preview', 'r-workbench-viewport', 'r-embed']) {
    const s = slots.get?.(id)
    if (s) candidates.push(s)
  }
  const hit = candidates.find((s) => s?.presenterSurface?.object3d != null)
  return (hit?.presenterSurface?.object3d as THREE.Object3D | undefined) ?? null
}

/**
 * 由**内容包围盒**导出一份冻结的取景值（`CameraSpec`）。
 *
 * ## 为什么不复用实时视口的相机（P10e 实测的坑，这里必须避开）
 *
 * P10e 探针实测原文：实时相机是正交的，且其 `near/far` 被 legacy 链**收紧到刚好
 * 裹住它自己那一次渲染的内容** —— 换个渲染目标后几何落到裁剪面之外 ⇒ `readPixels`
 * 全背景（**读出 0 像素**）。
 *
 * 更根本的是：A29 要求导出**不借用实时相机**。探针在这里做的是"把观察视角
 * **复制成值**"（`CameraSpec` 是纯数据）—— 而那正是设计规定的捕获动作
 * （`domain/captureSpec#copyCameraSpec` 是这件事的唯一入口）。导出端口随后
 * 只吃这个**值**，没有任何"取当前相机"的方法可调。
 *
 * 包围盒取不到（空场景）时回落到一个保守的固定视角 —— 那时端口本来就会
 * 因"无可绘制内容"诚实失败，探针只是不去掩盖它。
 */
function captureCameraSpec(): { spec: CameraSpec; source: 'content-bounds' | 'fallback' } {
  const root = presenterRoot()
  const fallback: CameraSpec = {
    projection: 'perspective',
    position: { x: 40, y: 40, z: 40 },
    target: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    fovDegrees: 45,
    near: 0.1,
    far: 5000,
  }
  if (root === null) return { spec: fallback, source: 'fallback' }
  root.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(root)
  if (box.isEmpty()) return { spec: fallback, source: 'fallback' }

  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const radius = Math.max(size.length() / 2, 1e-3)
  // 距离取 2.6×半径：留足余量使**整份包围盒**落在锥体内（p10e 的同一系数）。
  const dist = radius * 2.6
  const near = Math.max(dist / 100, 1e-4)
  const far = dist + radius * 4
  return {
    source: 'content-bounds',
    spec: {
      projection: 'perspective',
      position: { x: center.x + dist * 0.6, y: center.y + dist * 0.6, z: center.z + dist * 0.6 },
      target: { x: center.x, y: center.y, z: center.z },
      up: { x: 0, y: 1, z: 0 },
      fovDegrees: 45,
      near,
      far,
    },
  }
}

/** 一次真实导出尝试的读数。 */
export interface ExportPortProbeResult {
  readonly note: string
  readonly status: string
  readonly bytesLength: number
  /** PNG 魔数是否成立（前 8 字节）。 */
  readonly pngMagic: boolean
  /** IHDR 里声明的宽高。 */
  readonly ihdrWidth: number
  readonly ihdrHeight: number
  /** 解码后**非透明**像素数（真 GL 是否真的画了东西）。 */
  readonly nonTransparent: number
  /** 解码后 Pixel 总数为 0 时说明读回是空的（负对照）。 */
  readonly totalPixels: number
  readonly framesRendered: number
  readonly releasedFor: number
  readonly errorReason: string | null
  /**
   * 取景来源（诊断用）：`content-bounds` = 由**内容包围盒**导出；
   * `fallback` = 包围盒取不到（呈现根尚未装配/为空）而用的保守固定视角。
   *
   * 为什么把它报出来：`fallback` 下取景可能与内容不匹配 ⇒ 读出 0 像素。
   * 那**不是**实现缺陷而是探针取景问题，故必须能与"真 GL 没画"区分开
   * （否则会拿着一个取景问题的读数去报"链路坏了"）。
   */
  readonly cameraSource: 'content-bounds' | 'fallback'
}

/**
 * **负对照的输入**：保留场景里的对象（于是**过得了预检**的"非空场景"检查），
 * 但把每个 `blockGrid` 载荷的**类型化几何**剥掉。
 *
 * ## 为什么不直接把场景清空
 *
 * 清空对象表会让 `preflightExport` 判 `ExportEmptyScene` 在**作业启动前**失败 ——
 * 那时根本走不到端口的"无可绘制内容"分支，判据就测不到它要测的东西
 * （实测：第一版这么写，负对照的 `errorReason` 会是 `ExportEmptyScene`）。
 *
 * 剥掉几何则保留"场景里有对象"这一事实，使失败**发生在渲染阶段**
 * （`offscreenNoDrawableContent`）—— 那正是本负对照要钉的分支：
 * **有对象却产不出批次时，端口必须诚实失败，而不是给一张全透明的 PNG。**
 */
function stripTypedGeometry(scene: Scene): Scene {
  const objects: Record<string, unknown> = {}
  for (const [id, obj] of Object.entries(scene.objects)) objects[id] = obj
  const data: Record<string, unknown> = {}
  for (const [id, d] of Object.entries(scene.data)) {
    const payload = (d as { payload?: { kind?: string } }).payload
    if (payload?.kind === 'blockGrid') {
      const { geometry: _g, cellGeometry: _cg, ...rest } = payload as unknown as Record<string, unknown>
      data[id] = { ...(d as unknown as Record<string, unknown>), payload: rest }
      continue
    }
    data[id] = d
  }
  return { ...scene, objects, data } as unknown as Scene
}

/**
 * **在真浏览器里跑完整导出链**：内核内容 → 离屏端口（真 GL）→ 编码端口 → PNG 字节。
 *
 * 读回像素的"是否真画了东西"用 `createImageBitmap` + canvas 解码 PNG 判定 ——
 * 那是**独立于编码器**的解码路径（不自己解自己写的字节），故"非透明像素数 > 0"
 * 是"真 GL 画进去了"的证据，而不是"我的编码器自说自话"。
 */
export async function runExportPortProbe(options: {
  width?: number
  height?: number
  /** 负对照：保留对象但剥掉类型化几何（应当**诚实失败**，见 `stripTypedGeometry`）。 */
  negativeEmpty?: boolean
} = {}): Promise<ExportPortProbeResult> {
  const width = options.width ?? 64
  const height = options.height ?? 64
  const live = liveKernel()
  if (live === null) {
    return emptyResult('no-live-kernel-document')
  }

  const render = { width, height, background: 'transparent' as const }
  // 取景：把观察视角**复制成值**（见 `captureCameraSpec` 的说明 —— 不借用实时相机）。
  const captured = captureCameraSpec()
  const view = captured.spec
  const cameraSource = captured.source
  const spec: CaptureSpec = {
    frameRate: 20,
    frameCount: 1,
    mapping: { source: 'scene', startFrame: 0, stepFrames: 1 },
    channels: {},
    camera: { kind: 'view', label: 'p10f-e', view },
    render,
    animation: EMPTY_ANIMATION,
  }

  // 负对照见 `stripTypedGeometry`；正对照用**原样**的内核场景。
  const scene = options.negativeEmpty === true ? stripTypedGeometry(live.scene) : live.scene

  const planned = planExportRequest({
    requestId: options.negativeEmpty === true ? 'p10f-e-neg' : 'p10f-e-live',
    now: 1_700_000_000_000,
    documentId: 'live',
    version: { documentVersion: 1, contentVersion: 1 },
    scene,
    animation: EMPTY_ANIMATION,
    camera: spec.camera,
    spec,
    assets: [],
  })
  if (!planned.ok) return emptyResult(`plan-failed:${planned.error.code}`)
  const request = planned

  const { job } = assembleSnapshotExportJob({
    request: request.value,
    kind: 'image',
    devices: createThreeOffscreenDevice(),
    content: live.content,
    scope: 'p10f-e-e2e',
  })

  const outcome = await job.run()
  if (outcome.status !== 'completed') {
    // `failed` 分支**没有** `framesRendered`（见 `JobOutcome` 的判别式联合），
    // 故按分支取，不硬读一个不存在的字段。
    return {
      ...emptyResult(`job-${outcome.status}`),
      framesRendered: outcome.status === 'cancelled' ? outcome.framesRendered : 0,
      releasedFor: outcome.releasedFor,
      errorReason: outcome.status === 'failed' ? String(outcome.error.params.reason ?? outcome.error.code) : null,
      cameraSource,
    }
  }

  const bytes = outcome.bytes
  const pngMagic =
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  const ihdrWidth = bytes.length >= 24 ? readU32(bytes, 16) : -1
  const ihdrHeight = bytes.length >= 24 ? readU32(bytes, 20) : -1

  // **独立解码**（不自己解自己写的字节）：交浏览器解码器，数非透明像素。
  const stats = await decodeNonTransparent(bytes)

  return {
    note: 'ok',
    status: outcome.status,
    bytesLength: bytes.length,
    pngMagic,
    ihdrWidth,
    ihdrHeight,
    nonTransparent: stats.nonTransparent,
    totalPixels: stats.totalPixels,
    framesRendered: outcome.framesRendered,
    releasedFor: outcome.releasedFor,
    errorReason: null,
    cameraSource,
  }
}

function emptyResult(note: string): ExportPortProbeResult {
  return {
    note,
    status: 'failed',
    bytesLength: 0,
    pngMagic: false,
    ihdrWidth: -1,
    ihdrHeight: -1,
    nonTransparent: 0,
    totalPixels: 0,
    framesRendered: 0,
    releasedFor: 0,
    errorReason: null,
    cameraSource: 'fallback',
  }
}

function readU32(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0
}

/** 用浏览器解码器解 PNG 并数非透明像素（独立于编码器的验证路径）。 */
async function decodeNonTransparent(bytes: Uint8Array): Promise<{ nonTransparent: number; totalPixels: number }> {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/png' })
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx2d = canvas.getContext('2d')
  if (ctx2d === null) return { nonTransparent: 0, totalPixels: 0 }
  ctx2d.clearRect(0, 0, canvas.width, canvas.height)
  ctx2d.drawImage(bitmap, 0, 0)
  const data = ctx2d.getImageData(0, 0, canvas.width, canvas.height).data
  let nonTransparent = 0
  for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) nonTransparent += 1
  return { nonTransparent, totalPixels: canvas.width * canvas.height }
}

// ─────────────────────────────────────────────────────────────────────────────
// M6-2：真 GL 下的**动画（GIF）**导出探针
// ─────────────────────────────────────────────────────────────────────────────

/** 一次真实 GIF 导出尝试的读数（每一条都对应一条判据）。 */
export interface ExportGifProbeResult {
  readonly note: string
  readonly status: string
  readonly errorReason: string | null
  /** 产物是否以 `GIF89a` 开头。 */
  readonly gifMagic: boolean
  /** GIF 逻辑屏幕宽高（逻辑屏幕描述符，小端 u16）。 */
  readonly screenWidth: number
  readonly screenHeight: number
  /** 产物里**图像描述符**（0x2C）的个数 —— 应当等于请求的帧数。 */
  readonly imageCount: number
  /** 逐帧 Graphic Control Extension 的 delay（厘秒）—— 必须等于计划，不是自算 tick。 */
  readonly delaysCs: readonly number[]
  readonly bytesLength: number
  readonly framesRendered: number
  readonly releasedFor: number
  /** 浏览器解码器能否解开（独立于编码器）；能解开时的尺寸。 */
  readonly decodedWidth: number
  readonly decodedHeight: number
  readonly decoderOk: boolean
}

/** 解析 GIF 的块结构（只取判据要用的三个量：逻辑屏幕、图像个数、逐帧 delay）。 */
function parseGif(bytes: Uint8Array): { screenWidth: number; screenHeight: number; imageCount: number; delaysCs: number[] } {
  const screenWidth = bytes.length >= 8 ? (bytes[6]! | (bytes[7]! << 8)) : -1
  const screenHeight = bytes.length >= 10 ? (bytes[8]! | (bytes[9]! << 8)) : -1
  let imageCount = 0
  const delaysCs: number[] = []
  for (let i = 0; i + 8 < bytes.length; i++) {
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) {
      delaysCs.push(bytes[i + 4]! | (bytes[i + 5]! << 8))
    }
    if (bytes[i] === 0x2c) imageCount += 1
  }
  return { screenWidth, screenHeight, imageCount, delaysCs }
}

/**
 * **在真浏览器里跑动画导出链**：内核内容 → 离屏端口（真 GL，逐帧）→ 组合编码端口 → GIF 字节。
 *
 * 与 {@link runExportPortProbe} 的差别只在"时间与编码"两处：
 *  - 时间用 `scene-holds`（逐帧驻留 = 声明，**不是**按帧率自算）；
 *  - 编码走 {@link createEncoderPort}（组合端口）的 GIF part —— 于是"真 GL 逐帧渲染 +
 *    hold 随帧搬运 + ms→厘秒唯一换算 + GIF 字节"这四环在**一条链上**被证明。
 *
 * 解码用浏览器（{@link createImageBitmap}）而不是自己解自己写的字节：只要它能解开，
 * "产物是合法图像"就不是编码器的自说自话。
 */
export async function runExportGifProbe(options: {
  width?: number
  height?: number
  /** 逐帧驻留（毫秒）；缺省 [50, 100, 50]（**不等时长**，可区分"自算 tick"）。 */
  holdsMs?: readonly number[]
} = {}): Promise<ExportGifProbeResult> {
  const width = options.width ?? 32
  const height = options.height ?? 32
  const holdsMs = options.holdsMs ?? [50, 100, 50]
  const live = liveKernel()
  if (live === null) return gifEmpty('no-live-kernel-document')

  const render = { width, height, background: 'transparent' as const }
  const captured = captureCameraSpec()
  const spec: CaptureSpec = {
    frameRate: 20,
    frameCount: holdsMs.length,
    mapping: { source: 'scene-holds', startSeconds: 0, holdsMs: [...holdsMs] },
    channels: {},
    camera: { kind: 'view', label: 'm6-2-gif', view: captured.spec },
    render,
    animation: EMPTY_ANIMATION,
  }
  const planned = planExportRequest({
    requestId: 'm6-2-gif',
    now: 1_700_000_000_000,
    documentId: 'live',
    version: { documentVersion: 1, contentVersion: 1 },
    scene: live.scene,
    animation: EMPTY_ANIMATION,
    camera: spec.camera,
    spec,
    assets: [],
  })
  if (!planned.ok) return gifEmpty(`plan-failed:${planned.error.code}`)

  const { job } = assembleSnapshotExportJob({
    request: planned.value,
    kind: 'animation',
    encoding: 'gif',
    devices: createThreeOffscreenDevice(),
    content: live.content,
    scope: 'm6-2-gif-e2e',
  })
  const outcome = await job.run()
  if (outcome.status !== 'completed') {
    return {
      ...gifEmpty(`job-${outcome.status}`),
      framesRendered: outcome.status === 'cancelled' ? outcome.framesRendered : 0,
      releasedFor: outcome.releasedFor,
      errorReason: outcome.status === 'failed' ? String(outcome.error.params.reason ?? outcome.error.code) : null,
    }
  }

  const bytes = outcome.bytes
  const parsed = parseGif(bytes)
  const gifMagic = bytes.length >= 6 && String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!) === 'GIF89a'
  let decodedWidth = -1
  let decodedHeight = -1
  let decoderOk = false
  try {
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/gif' })
    const bitmap = await createImageBitmap(blob)
    decodedWidth = bitmap.width
    decodedHeight = bitmap.height
    decoderOk = bitmap.width > 0 && bitmap.height > 0
  } catch {
    decoderOk = false
  }

  return {
    note: 'ok',
    status: outcome.status,
    errorReason: null,
    gifMagic,
    screenWidth: parsed.screenWidth,
    screenHeight: parsed.screenHeight,
    imageCount: parsed.imageCount,
    delaysCs: parsed.delaysCs,
    bytesLength: bytes.length,
    framesRendered: outcome.framesRendered,
    releasedFor: outcome.releasedFor,
    decodedWidth,
    decodedHeight,
    decoderOk,
  }
}

function gifEmpty(note: string): ExportGifProbeResult {
  return {
    note,
    status: 'failed',
    errorReason: null,
    gifMagic: false,
    screenWidth: -1,
    screenHeight: -1,
    imageCount: 0,
    delaysCs: [],
    bytesLength: 0,
    framesRendered: 0,
    releasedFor: 0,
    decodedWidth: -1,
    decodedHeight: -1,
    decoderOk: false,
  }
}
