/**
 * `workbench/export/isoExportJob` —— **等轴导出的生产执行入口**（M6-3）。
 *
 * ## 它替代了什么
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | 命令自己 `plainForSave()` 取声明态文档，调烘焙函数拿 dataURL/Blob | `workbench/exportIsometricImage` / `workbench/exportAnimatedGif`（M6-3 整文件删除） | 命令只调本模块：捕获（`composition/exportCapture`）→ 装配冻结作业（`assembleSnapshotExportJob`）→ `ExportJob.run()` → 字节 |
 *
 * ## 为什么这层在 `workbench/` 而不是 `composition/`
 *
 * 它是**唯一允许读实时面的层**（设计 $6 的层次表）：`ctx.kernelPresentationSnapshot()` 的取值
 * 与 `createDomTextureDecoder()` 的 DOM 解码都在这一层发生；`composition/` 只拿值。
 * 于是"导出借用实时视口"在结构上仍然不可表达 —— 本模块拿的是**值**，且立刻冻进请求。
 *
 * ## 同一份请求只捕获一次
 *
 * 预览与下载必须**同一配置同一产物**（既有判据：预览 PNG 与下载 PNG 逐字节相同）。
 * 故两边都调本模块的同一个函数、同一组参数；差别只在"要不要落盘"。
 */

import { err, ok, unsupportedOperation, type DomainError, type Result } from '@/domain/errors'
import type { ArtifactEncoding, ExportKind } from '@/application/exportPlan'
import { fileExtensionOf, mediaTypeOf } from '@/application/exportPlan'
import { createThreeOffscreenDevice } from '@/adapters/export/renderDevice'
import { assembleSnapshotExportJob } from '@/adapters/export/snapshotExportJob'
import type { JobOutcome } from '@/runtime/exportJob'
import type { TextureDecoder } from '@/composition/kernelTextureResources'
import { captureExportSnapshot, type ExportCapture, type ExportCaptureKind, type ExportCaptureSource } from '@/composition/exportCapture'

/** 等轴导出的输入（两个命令与导出卡片的预览/生成共用这一份形状）。 */
export interface IsoExportOptions {
  readonly kind: ExportCaptureKind
  /** 0..3（调用方已归一）。 */
  readonly directionIndex: number
  /** 渲染边长（像素）。**搬运**自命令侧（Q1/M6-5 之前不在此写死缺省）。 */
  readonly pixelSize: number
  /** 仅 `kind === 'image'`：场景秒（已由 `normalizeIsoSeconds` 归一）。 */
  readonly seconds?: number
  /**
   * 纹理解码器（**注入**）：本模块（`composition/`）不碰 DOM ——
   * 生产由命令层给 `createDomTextureDecoder()`，单测给受控解码器。
   */
  readonly decoder: TextureDecoder
  /** 注入时钟（本模块不读 `Date.now()`；调用方给）。 */
  readonly now: number
  /** 取消入口（生产命令当前不传 —— Q3 裁决：不加 UI 按钮，只保留内部语义）。 */
  readonly signal?: AbortSignal
  /** 进度回调（纯观察）。 */
  readonly onProgress?: (completed: number, total: number) => void
  /**
   * 逐帧驻留上限（缺省 = 产品政策 `LOOP_LIMITS`）。
   *
   * 只给判据用（N22：把上限压低到夹具可触发，判"超限必须显式失败"）。生产调用**不传**。
   */
  readonly loopLimits?: { readonly maxFrames: number; readonly maxTotalMs: number }
}

/** 一次导出的产物与它对账用的**捕获事实**。 */
export interface IsoExportResult {
  readonly bytes: Uint8Array
  readonly mediaType: string
  /** 建议文件名（`iso-<方向>.png` / `anim-<方向>.gif`，与旧链逐字一致）。 */
  readonly fileName: string
  readonly capture: ExportCapture
  /** 作业结局（`completed`；失败/取消不会走到这里）。 */
  readonly outcome: Extract<JobOutcome, { status: 'completed' }>
}

/** 一次导出作业的作用域（一个作业一个；进呈现层归属键）。 */
function scopeOf(options: IsoExportOptions): string {
  return 'iso-export-' + String(options.directionIndex) + '-' + String(options.pixelSize)
}

/**
 * 跑一次等轴导出：捕获 → 装配 → 运行 → 字节。
 *
 * 失败一律是 `Result` 的失败侧（命令层抛出；UI 的错误位据此可见）。
 */
export async function runIsoExport(
  source: ExportCaptureSource,
  options: IsoExportOptions,
): Promise<Result<IsoExportResult>> {
  const captured = await captureExportSnapshot(source, {
    kind: options.kind,
    directionIndex: options.directionIndex,
    pixelSize: options.pixelSize,
    ...(options.seconds === undefined ? {} : { seconds: options.seconds }),
    decoder: options.decoder,
    now: options.now,
    requestId: 'iso-export-' + String(options.directionIndex),
    ...(options.loopLimits === undefined ? {} : { loopLimits: options.loopLimits }),
  })
  if (!captured.ok) return err(captured.error)
  const capture = captured.value
  const kind: ExportKind = options.kind === 'image' ? 'image' : 'animation'
  const encoding: ArtifactEncoding = options.kind === 'image' ? 'png' : 'gif'

  const handlers = assembleSnapshotExportJob({
    request: capture.request,
    kind,
    encoding,
    // ⚠️ 设备与绑定**同一个数组值**（见 `offscreenRenderPort#textureResources`）。
    devices: createThreeOffscreenDevice({ resources: capture.textureResources }),
    content: capture.content,
    scope: scopeOf(options),
    textureResources: capture.textureResources,
    assets: capture.assets,
    assetNeeds: capture.assetNeeds,
    // 循环次数缺省 = 0（无限；Q9 裁决：不暴露 UI）。
    ...(options.kind === 'animation' ? { loopCount: 0 } : {}),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onProgress === undefined
      ? {}
      : { onProgress: (p) => options.onProgress!(p.completed, p.total) }),
  })

  try {
    const outcome = await handlers.job.run()
    if (outcome.status === 'cancelled') {
      return err(unsupportedOperation({ reason: 'exportCancelled', direction: options.directionIndex }))
    }
    if (outcome.status === 'failed') {
      // 失败原因**原样**带出（作业的诊断是结构化值；这里只做包装，不改写 reason）。
      return err(outcome.error as DomainError)
    }
    const dir = String(options.directionIndex)
    const fileName = (options.kind === 'image' ? 'iso-' : 'anim-') + dir + '.' + fileExtensionOf(kind, encoding)
    return ok(
      Object.freeze({
        bytes: outcome.bytes,
        mediaType: mediaTypeOf(kind, encoding),
        fileName,
        capture,
        outcome,
      }),
    )
  } finally {
    // 中止订阅必须撤销（否则长寿命 `AbortController` 会累积回调）。
    handlers.detachAbort()
  }
}

/**
 * 失败原因 → **可读文本**（命令层抛 `Error` 用）。
 *
 * 为什么不让 `DomainError` 对象直接冒泡：它是**值**（`code` + `params`），
 * 直接 `String()` 会得到 `[object Object]` —— 卡片的错误位就变成一句废话。
 * 这里把码与参数拼成人可读的一行，**不改写**任何 reason（判据仍可按 reason 断言）。
 */
export function exportErrorText(e: DomainError): string {
  const params = Object.entries(e.params)
    .map(([k, v]) => k + '=' + String(v))
    .join(' ')
  return params === '' ? e.code : e.code + ': ' + params
}

/** 产物 → `Blob`（下载共用；不改字节）。 */
export function blobOf(result: IsoExportResult): Blob {
  return new Blob([result.bytes as unknown as BlobPart], { type: result.mediaType })
}

/**
 * 产物 → **data URL**（卡片预览用）。
 *
 * ## 为什么预览不用 `URL.createObjectURL`
 *
 * "卡片上看到的图就是下载得到的图"这条判据（`e2e/export-iso-time.spec.ts` C2）读的是
 * `<img src>` 的**字节**：`blob:` URL 在测试进程里取不到内容，判据只能退化成"有张图"。
 * data URL 让"预览的字节"与"下载的字节"是**同一个 Uint8Array 的两种编码**，
 * 逐字节比较因此成立（不是两次烘焙碰巧一致）。
 */
export function dataUrlOf(result: IsoExportResult): string {
  return `data:${result.mediaType};base64,${base64Of(result.bytes)}`
}

/** 字节 → base64（分块，避免大图把参数表撑爆）。 */
function base64Of(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
