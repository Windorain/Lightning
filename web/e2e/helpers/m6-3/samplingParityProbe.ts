/**
 * **M6-3 判据 ② 与 N22 的浏览器侧探针**：离屏采样与屏上**同一秒同样本**、循环超限**显式失败**。
 *
 * ## 为什么必须在浏览器里跑
 *
 * ① 离屏渲染要真 WebGL2（本仓 headless-gl 是 WebGL 1.0，见 `e2e/export-ports.spec.ts` 文件头）；
 * ② "与屏上同一秒"要**真的**有一个挂载中的视口（`presenterSurface.textureSamples()` 是唯一
 *    可比较的读面）—— 那是浏览器里的事实，vitest 里只能手搓一份读数（那就成了自证）。
 *
 * ## 零替身
 *
 * 全程生产实现：`ctx.kernelPresentationSnapshot()`（与屏上同一个求值点）→
 * `captureExportSnapshot` → `assembleSnapshotExportJob`（真设备 + 组合编码端口）→
 * `ExportJob.run()`。屏上读数取自 `vpSlot.presenterSurface.textureSamples()`。
 *
 * ## 三条读数（判据 ② 的门禁面）
 *
 * 1. **同秒逐字段相等**：作业 `outcome.sampling[k].samples` vs 屏上同秒的 `textureSamples()`；
 * 2. **负对照 A（不是读同一份缓存）**：把视口 seek 到 `t + 0.05s`，作业仍跑 `t` ⇒
 *    `frame` 必须**不同**；
 * 3. **负对照 B（判据覆盖真实缺口）**：不给 `textureResources` ⇒ 作业样本为空（这正是
 *    M6-3 之前的生产形态：一张贴图都上不去）。
 *
 * N22（`runExportGifOverflowProbe`）：走**生产入口** `runIsoExport`，把逐帧驻留上限压低到
 * 夹具可触发（2 帧 > 1 帧上限）⇒ 必须**显式失败**且**零产物**（不是"卡住"）。
 */

import type { TextureSampleReport } from '@/presentation/presenter'
import type { DocumentContent } from '@/domain/content'
import type { Scene } from '@/domain/scene'
import type { CaptureTime, ExportRequest } from '@/domain/captureSpec'
import { createDomTextureDecoder } from '@/adapters/textureDecode'
import { createThreeOffscreenDevice } from '@/adapters/export/renderDevice'
import { assembleSnapshotExportJob } from '@/adapters/export/snapshotExportJob'
import { captureExportSnapshot, type ExportCaptureSource } from '@/composition/exportCapture'
import { runIsoExport } from '@/workbench/export/isoExportJob'
import type { JobOutcome } from '@/runtime/exportJob'

type Vm = Record<string, any>

function vm(): Vm {
  return (window as unknown as { __vm__?: Vm }).__vm__ ?? {}
}

/** 挂载中的视口（`presenterSurface` 是唯一可比较的读面）。 */
function liveSurface(): { textureSamples(): readonly TextureSampleReport[]; activeKey?: unknown } | null {
  const ctx = vm()
  const slots = ctx.viewports
  if (slots === undefined) return null
  const candidates: any[] = []
  if (slots.active?.value) candidates.push(slots.active.value)
  for (const id of ['r-workbench-viewport', 'r-viewport', 'r-embed']) {
    const s = slots.get?.(id)
    if (s) candidates.push(s)
  }
  const hit = candidates.find((s) => s?.presenterSurface != null)
  return (hit?.presenterSurface as any) ?? null
}

/** 把视口定位到某个场景秒（`seekTime` 是内核公开写面）。 */
function seek(seconds: number): void {
  const kernel = vm().requireKernelSession?.()
  kernel?.seekTime?.({ frame: seconds * 20, fps: 20 })
}

export interface SamplingParityResult {
  readonly note: string
  /** 作业侧的逐帧采样读数（`JobOutcome.sampling`）。 */
  readonly exportSamples: readonly TextureSampleReport[]
  /** 屏上同秒的读数。 */
  readonly viewportSamples: readonly TextureSampleReport[]
  readonly exportFrames: readonly number[]
  readonly viewportFrames: readonly number[]
  /** 逐字段相等的判定（在页面里做，避免浮点序列化差异）。 */
  readonly equal: boolean
  readonly mismatchedFields: readonly string[]
  readonly framesRendered: number
  readonly status: string
  /** 负对照 A：视口 seek 到 t+0.05 后的首帧号（与导出的首帧号比较）。 */
  readonly shiftedViewportFrame: number | null
  /** 负对照 B：不绑纹理时的样本条数。 */
  readonly unboundSampleCount: number
  /** 屏上的 `activeKey`（判据 ① 的补面：双区同源）。 */
  readonly activeKey: unknown
}

/** 逐字段比较（字段集合 = `presenter.ts#TextureSampleReport`）。 */
function compareSamples(
  a: readonly TextureSampleReport[],
  b: readonly TextureSampleReport[],
): { equal: boolean; mismatched: string[] } {
  if (a.length !== b.length) return { equal: false, mismatched: ['length:' + a.length + '!=' + b.length] }
  const fields: (keyof TextureSampleReport)[] = [
    'assetId', 'contentVersion', 'seconds', 'frame', 'nextFrame', 'mix', 'stripFrameCount', 'offsetY', 'repeatY',
  ]
  const mismatched: string[] = []
  for (let i = 0; i < a.length; i += 1) {
    for (const f of fields) {
      if (a[i]![f] !== b[i]![f]) mismatched.push(`[${i}].${String(f)}:${String(a[i]![f])}!${String(b[i]![f])}`)
    }
  }
  return { equal: mismatched.length === 0, mismatched }
}

/** 捕获读面（生产宿主里就是 `ctx`；它在本批新增了 `kernelPresentationSnapshot()`）。 */
function sourceOf(ctx: Vm): ExportCaptureSource | null {
  if (typeof ctx.kernelPresentationSnapshot !== 'function') return null
  return ctx as ExportCaptureSource
}

/**
 * `seekViewport` —— 把视口定位到某个场景秒（内核公开写面）。
 *
 * ⚠️ 定位是**异步生效**的：视口在下一帧 clock tick 才重建样本。故判据必须
 * **轮询到样本秒数 == 目标秒**（`readViewportSamples`）再取读数 —— 直接读完 seek
 * 就读样本会得到上一帧的值（本判据首跑实测：`seconds:0`）。
 */
export function seekViewport(seconds: number): boolean {
  const kernel = vm().requireKernelSession?.()
  if (kernel === undefined || typeof kernel.seekTime !== 'function') return false
  kernel.seekTime({ frame: seconds * 20, fps: 20 })
  return true
}

/** 读屏上当前的纹理样本（纯读数，不触发任何写）。 */
export function readViewportSamples(): readonly TextureSampleReport[] {
  const surface = liveSurface()
  if (surface === null) return []
  return JSON.parse(JSON.stringify(surface.textureSamples() ?? [])) as TextureSampleReport[]
}

/** 读屏上的 `activeKey`（判据 ① 的补面：双区同源）。 */
export function readViewportActiveKey(): unknown {
  const surface = liveSurface()
  return surface === null ? null : (surface.activeKey ?? null)
}

export interface ExportSamplesResult {
  readonly note: string
  readonly status: string
  readonly samples: readonly TextureSampleReport[]
  readonly framesRendered: number
  readonly unboundSampleCount: number
  readonly bytesLength: number
}

/**
 * 在某个场景秒跑一次**真作业**（捕获 → 装配 → 运行），返回它的样本读数。
 *
 * `bindTextures: false` 是**负对照 B**：不把捕获期资源交给设备/会话 ——
 * 那正是 M6-3 之前的生产形态（"一张贴图都上不去"）。
 */
export async function runExportSamplesAt(
  seconds: number,
  bindTextures: boolean,
  options: { readonly directionIndex?: number; readonly pixelSize?: number } = {},
): Promise<ExportSamplesResult> {
  const ctx = vm()
  const source = sourceOf(ctx)
  const empty: ExportSamplesResult = {
    note: 'no-live-kernel-document',
    status: 'failed',
    samples: [],
    framesRendered: 0,
    unboundSampleCount: -1,
    bytesLength: 0,
  }
  if (source === null) return empty
  const capture = await captureExportSnapshot(source, {
    kind: 'image',
    directionIndex: options.directionIndex ?? 0,
    pixelSize: options.pixelSize ?? 32,
    seconds,
    decoder: createDomTextureDecoder(),
    now: 1_700_000_000_000,
    requestId: bindTextures ? 'm6-3-parity' : 'm6-3-parity-unbound',
  })
  if (!capture.ok) return { ...empty, note: 'capture-failed:' + String(capture.error.params.reason) }
  const c = capture.value
  const handlers = assembleSnapshotExportJob({
    request: c.request,
    kind: 'image',
    encoding: 'png',
    devices: createThreeOffscreenDevice(bindTextures ? { resources: c.textureResources } : {}),
    content: c.content,
    scope: 'm6-3-parity-' + (bindTextures ? 'bound' : 'unbound'),
    ...(bindTextures ? { textureResources: c.textureResources } : {}),
    assets: c.assets,
    assetNeeds: c.assetNeeds,
  })
  try {
    const outcome = await handlers.job.run()
    if (outcome.status !== 'completed') {
      return { ...empty, note: 'job-' + outcome.status, status: outcome.status, framesRendered: outcome.framesRendered }
    }
    return {
      note: 'ok',
      status: outcome.status,
      samples: JSON.parse(JSON.stringify(outcome.sampling?.[0]?.samples ?? [])) as TextureSampleReport[],
      framesRendered: outcome.framesRendered,
      unboundSampleCount: outcome.sampling?.[0]?.samples.length ?? -1,
      bytesLength: outcome.bytes.length,
    }
  } finally {
    handlers.detachAbort()
  }
}

/** 逐字段比较（导出侧 vs 屏上），供 spec 直接断言。 */
export function compareExportWithViewport(
  exportSamples: readonly TextureSampleReport[],
  viewportSamples: readonly TextureSampleReport[],
): { equal: boolean; mismatched: readonly string[] } {
  const r = compareSamples(exportSamples, viewportSamples)
  return { equal: r.equal, mismatched: Object.freeze(r.mismatched) }
}

export interface GifOverflowProbeResult {
  readonly note: string
  readonly ok: boolean
  readonly reason: string
  readonly frames: number
  readonly totalMs: number
  readonly producedBytes: number
}

/**
 * **N22：循环超限 ⇒ 显式失败、零产物**（走**生产入口** `runIsoExport`）。
 *
 * 上限被压倒夹具可触发（`maxFrames: 1`），但判定仍是**同一条路径**：
 * `planSequenceLoop` 的 `textureLoopTooLong` → 捕获失败 → 命令拿到失败 → 不下载。
 */
export async function runGifOverflowProbe(options: { readonly directionIndex?: number } = {}): Promise<GifOverflowProbeResult> {
  const ctx = vm()
  const source = sourceOf(ctx)
  if (source === null) {
    return { note: 'no-live-kernel-document', ok: false, reason: 'no-live-kernel-document', frames: 0, totalMs: 0, producedBytes: 0 }
  }
  const result = await runIsoExport(source, {
    kind: 'animation',
    directionIndex: options.directionIndex ?? 0,
    pixelSize: 16,
    decoder: createDomTextureDecoder(),
    now: 1_700_000_000_000,
    // 夹具是 2 帧 ⇒ 1 帧上限必触发（上限在捕获期判定，粒度与生产完全一致）。
    loopLimits: { maxFrames: 1, maxTotalMs: 30_000 },
  })
  if (result.ok) {
    return {
      note: 'unexpected-success',
      ok: true,
      reason: '',
      frames: result.value.capture.loop?.frameCount ?? 0,
      totalMs: result.value.capture.loop?.totalMs ?? 0,
      producedBytes: result.value.bytes.length,
    }
  }
  return {
    note: 'failed-as-expected',
    ok: false,
    reason: String(result.error.params.reason ?? result.error.code),
    frames: Number(result.error.params.frames ?? 0),
    totalMs: Number(result.error.params.totalMs ?? 0),
    producedBytes: 0,
  }
}

/** 供判据断言"请求确实是冻结值"（`frames` 来自 `planCaptureFrames`）。 */
export type { ExportRequest }
