/**
 * **R3-2 ③ 浏览器侧探针**：真实作业产出 → 清单随产物同行 → 机械对账。
 *
 * ## 为什么必须在浏览器里跑
 *
 * `createThreeOffscreenDevice()` 需要真 WebGL2（见 `e2e/export-ports.spec.ts` 文件头：
 * 本仓 headless-gl 是 WebGL 1.0，`three ^0.174.0` 硬请求 webgl2 ⇒ vitest 侧必然抛）。
 * 故"真实产物 + 真实清单"只能在真机浏览器里产出。
 *
 * ## 零替身
 *
 * 全程生产实现：
 *  - **装配**：`kernelPresentationInputs`（真实夹具 → 图元清单）；
 *  - **反推**：`deriveAssetNeeds`（消费 `compileScene`，不重解析旧文件）；
 *  - **组装**：`planExportRequest`（清单进不可变请求）；
 *  - **作业**：`ExportJob` + `assembleSnapshotExportJob` 的**生产端口**
 *    （`createSnapshotOffscreenRenderPort`）+ `createEncoderPort()`（真 PNG 字节）；
 *  - **载体**：`exportAssetCarrier.packageExportArtifact`；
 *  - **对账**：`assetManifestDigest` / `assetManifestCanonicalText`。
 *
 * ## 为什么这里 `new ExportJob(...)` 而不是 `assembleSnapshotExportJob(...)`
 *
 * 生产装配入口 `adapters/export/snapshotExportJob.ts#assembleSnapshotExportJob` **尚未**
 * 转发 `assetNeeds`（该文件属 R3-1a 写面，本批**不改**，已在回报里列为一行移交项）。
 * 故这里复用它的**它自己的生产端口** + 生产编码器，只多传一个 `assetNeeds` 选项 ——
 * 除了这一个选项，链路上没有任何一处是替身。
 *
 * ## 判据里为什么必须有负对照
 *
 * 「摘要能对上」单独看是恒真的（自己算的摘要当然对得上自己）。故必须证：
 * **删掉一条 `required` 后** 摘要改变 **且** 预检返回 `ExportAssetNotReady`
 * —— 那才说明这条对账口径真能拦住"漏了必需资源"。
 */

import * as THREE from 'three'
import { createEncoderPort } from '@/adapters/export/encoderPort'
import { createThreeOffscreenDevice } from '@/adapters/export/renderDevice'
import { assembleSnapshotExportJob } from '@/adapters/export/snapshotExportJob'
import {
  assetManifestCanonicalText,
  assetManifestDigest,
  deriveAssetNeeds,
  exportAssetManifest,
  planExportRequest,
  preflightExport,
  type ExportAssetNeed,
} from '@/application/exportPlan'
import { manifestJsonText } from '@/application/exportAssetCarrier'
import { kernelPresentationInputs } from '@/composition/kernelPresentationInputs'
import { EMPTY_ANIMATION } from '@/domain/animation'
import type { CameraSpec, CaptureSpec } from '@/domain/captureSpec'
import type { DocumentContent } from '@/domain/content'
import type { Scene } from '@/domain/scene'
import { AssetStateStore } from '@/presentation/assetState'
import { ExportJob } from '@/runtime/exportJob'

/** 从真实工作台实例取当前内核文档（S0）。 */
function liveKernel(): { scene: Scene; content: DocumentContent } | null {
  const ctx = (window as unknown as { __vm__?: Record<string, unknown> }).__vm__
  if (ctx === undefined) return null
  const session = ctx.kernel as { document?: () => { scene?: Scene; content?: DocumentContent } | undefined } | null
  const doc = typeof session?.document === 'function' ? session.document() : undefined
  if (doc?.scene === undefined || doc?.content === undefined) return null
  return { scene: doc.scene, content: doc.content }
}

/** 取已装配的呈现根（`vpSlot.presenterSurface.object3d`），用于由内容包围盒取景。 */
function presenterRoot(): THREE.Object3D | null {
  const ctx = (window as unknown as { __vm__?: Record<string, unknown> }).__vm__
  const slots = ctx?.viewports as { active?: { value?: unknown }; get?: (id: string) => unknown } | undefined
  if (slots === undefined) return null
  const candidates: unknown[] = []
  if (slots.active?.value) candidates.push(slots.active.value)
  for (const id of ['r-viewport', 'r-workbench-viewport', 'r-embed']) {
    const s = slots.get?.(id)
    if (s) candidates.push(s)
  }
  const hit = candidates.find((s) => (s as { presenterSurface?: { object3d?: unknown } })?.presenterSurface?.object3d != null)
  return ((hit as { presenterSurface: { object3d: THREE.Object3D } })?.presenterSurface?.object3d ?? null)
}

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
  const dist = radius * 2.6
  return {
    source: 'content-bounds',
    spec: {
      projection: 'perspective',
      position: { x: center.x + dist * 0.6, y: center.y + dist * 0.6, z: center.z + dist * 0.6 },
      target: { x: center.x, y: center.y, z: center.z },
      up: { x: 0, y: 1, z: 0 },
      fovDegrees: 45,
      near: Math.max(dist / 100, 1e-4),
      far: dist + radius * 4,
    },
  }
}

export interface AssetManifestProbeResult {
  readonly note: string
  readonly status: string
  readonly derivationStatus: string
  readonly carrier: string
  readonly manifestLocation: string
  readonly carrierFallbackReason: string | null
  readonly assembled: boolean
  readonly manifestReason: string | null
  readonly entryCount: number
  readonly digest: number
  readonly canonical: string
  /** 产物**内/伴生**的清单 JSON 文本（真实下载的就是它）。 */
  readonly manifestJson: string
  /** 页面内独立重算：`assetManifestDigest(entries)` == `manifest.digest`。 */
  readonly digestMatchesEntries: boolean
  /** 页面内独立重算：规范串 == 排序后的 `id@version:req|opt` 行。 */
  readonly canonicalMatchesEntries: boolean
  readonly bytesLength: number
  readonly pngMagic: boolean
  readonly framesRendered: number
  readonly releasedFor: number
  readonly negative: {
    readonly removedAssetId: string | null
    readonly digestChanged: boolean
    readonly preflightStatus: string
    readonly assetNotReadyIds: readonly string[]
  }
  readonly errorReason: string | null
  readonly cameraSource: 'content-bounds' | 'fallback'
}

export async function runAssetManifestProbe(options: { width?: number; height?: number } = {}): Promise<AssetManifestProbeResult> {
  const width = options.width ?? 48
  const height = options.height ?? 48
  const live = liveKernel()
  if (live === null) return empty('no-live-kernel-document')

  const render = { width, height, background: 'transparent' as const }
  const captured = captureCameraSpec()
  const spec: CaptureSpec = {
    frameRate: 20,
    frameCount: 1,
    mapping: { source: 'scene', startFrame: 0, stepFrames: 1 },
    channels: {},
    camera: { kind: 'view', label: 'r3-2', view: captured.spec },
    render,
    animation: EMPTY_ANIMATION,
  }

  // ① 生产装配：真实夹具（含类型化几何 + 材质调色板）→ 图元清单
  const assembled = kernelPresentationInputs({
    scene: live.scene,
    content: live.content,
    key: {
      documentVersion: 1,
      scene: live.scene.id,
      time: { seconds: 0, numerator: 0, denominator: 1 },
      parameterVersion: 0,
      contentResourceVersions: {},
    },
    layerWorldY: null,
  })

  const derivation = deriveAssetNeeds({
    scene: live.scene,
    animation: EMPTY_ANIMATION,
    frames: [],
    spec,
    presentation: assembled.inputs,
  })
  if (derivation.status !== 'derived') return empty(`derivation-${derivation.status}:${derivation.reason}`)

  // ④ 资源状态面：装配用的材料**按构造就存在**（清单由真实装配产出）⇒ 用生产状态机
  //    如实登记为 available（不是"跳过预检"）。缺一条即不在其中 —— 这正是③负对照的抓手。
  const store = new AssetStateStore()
  for (const need of derivation.assets) {
    const { requestId } = store.begin({
      identity: { id: need.assetId, version: need.contentVersion },
      locator: { kind: 'external', url: need.locator },
      required: need.required,
    })
    store.complete(need.assetId, requestId, need.contentVersion)
  }

  const planned = planExportRequest({
    requestId: 'r3-2-live',
    now: 1_700_000_000_000,
    documentId: 'live',
    version: { documentVersion: 1, contentVersion: 1 },
    scene: live.scene,
    animation: EMPTY_ANIMATION,
    camera: spec.camera,
    spec,
    presentation: assembled.inputs,
  })
  if (!planned.ok) return empty(`plan-failed:${planned.error.code}`)
  const request = planned.value

  const { port } = assembleSnapshotExportJob({
    request,
    kind: 'image',
    devices: createThreeOffscreenDevice(),
    content: live.content,
    scope: 'r3-2-e2e',
  })
  const job = new ExportJob({ request, kind: 'image', port, encoder: createEncoderPort(), assets: store, assetNeeds: derivation })
  const outcome = await job.run()
  if (outcome.status !== 'completed') {
    return {
      ...empty(`job-${outcome.status}`),
      releasedFor: outcome.releasedFor,
      errorReason: outcome.status === 'failed' ? String(outcome.error.params.reason ?? outcome.error.code) : null,
      cameraSource: captured.source,
    }
  }

  const bytes = outcome.bytes
  const manifest = outcome.assetManifest
  const manifestJson = manifestJsonText(manifest)
  const entries = manifest.entries

  // ③ 页面内独立重算（不读 `manifest.digest` 就断言它）
  const digestMatchesEntries = assetManifestDigest(entries) === manifest.digest
  const canonicalMatchesEntries = assetManifestCanonicalText(entries) === manifest.canonical

  // ③ 负对照（两个**独立**事实，缺一不可）：
  //
  //  (a) **产物清单被篡改**：删掉一条 `required` ⇒ 规范串/摘要立刻与权威清单不一致
  //      ⇒ 机械对账当场抓出"产物少报了一条必需资源"。
  //  (b) **少一条必需资源过不了预检**：用**原始请求**（含该必需资源）+ 一份**缺该资源**
  //      的资源状态面跑生产预检 ⇒ 必须 `blocked` 且诊断指名该资源。
  //
  // 为什么 (b) 不能也用"删过的请求"：那两边同时少了同一条 ⇒ 对得上、恒 `ready`，
  // 判据就变成恒真的（本探针第一版正是这个错误，实测 `preflightStatus: 'ready'`）。
  // 真正的风险形态是"**产物声称不需要**、而渲染时真的需要"——故请求侧保持完整。
  const firstRequired = entries.find((e) => e.required) ?? null
  const reduced: readonly ExportAssetNeed[] =
    firstRequired === null ? entries : entries.filter((e) => e.assetId !== firstRequired.assetId)
  const digestChanged = assetManifestDigest(reduced) !== manifest.digest

  // (b) 状态面里**没有**被删的那条（其余照旧 available）—— 于是"缺必需资源"是
  //     状态面的**事实**，判红只能来自生产预检，不是测试手工构造的结论。
  const shortStore = new AssetStateStore()
  for (const need of reduced) {
    const { requestId } = shortStore.begin({
      identity: { id: need.assetId, version: need.contentVersion },
      locator: { kind: 'external', url: need.locator },
      required: need.required,
    })
    shortStore.complete(need.assetId, requestId, need.contentVersion)
  }
  const negativePreflight = preflightExport({
    request,
    kind: 'image',
    encoding: 'png',
    encoder: createEncoderPort(),
    assets: shortStore,
  })
  const assetNotReadyIds = negativePreflight.diagnostics
    .filter((d) => d.code === 'ExportAssetNotReady')
    .map((d) => String(d.detail.assetId))

  return {
    note: 'ok',
    status: outcome.status,
    derivationStatus: derivation.status,
    carrier: outcome.carrier,
    manifestLocation: outcome.manifestLocation,
    carrierFallbackReason: outcome.carrierFallbackReason,
    assembled: manifest.assembled,
    manifestReason: manifest.reason,
    entryCount: entries.length,
    digest: manifest.digest,
    canonical: manifest.canonical,
    manifestJson,
    digestMatchesEntries,
    canonicalMatchesEntries,
    bytesLength: bytes.length,
    pngMagic:
      bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a,
    framesRendered: outcome.framesRendered,
    releasedFor: outcome.releasedFor,
    negative: {
      removedAssetId: firstRequired === null ? null : firstRequired.assetId,
      digestChanged,
      preflightStatus: negativePreflight.status,
      assetNotReadyIds,
    },
    errorReason: null,
    cameraSource: captured.source,
  }
}

function empty(note: string): AssetManifestProbeResult {
  return {
    note,
    status: 'failed',
    derivationStatus: 'n/a',
    carrier: 'n/a',
    manifestLocation: 'n/a',
    carrierFallbackReason: null,
    assembled: false,
    manifestReason: null,
    entryCount: 0,
    digest: 0,
    canonical: '',
    manifestJson: '',
    digestMatchesEntries: false,
    canonicalMatchesEntries: false,
    bytesLength: 0,
    pngMagic: false,
    framesRendered: 0,
    releasedFor: 0,
    negative: { removedAssetId: null, digestChanged: false, preflightStatus: 'n/a', assetNotReadyIds: [] },
    errorReason: note,
    cameraSource: 'fallback',
  }
}

/**
 * 触发一次**真实下载**（Playwright 的 `download` 事件据此成立）。
 *
 * 用 `Blob` + 锚点点击 —— 与生产 `util/browser#downloadBlob` 同一手法，但这里要
 * 让"下载了什么"完全由探针决定（清单文本来自本次作业的产物）。
 */
export function downloadText(name: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 便于探针自证：`exportAssetManifest` 是生产实现（不是探针自造）。 */
export { exportAssetManifest }
