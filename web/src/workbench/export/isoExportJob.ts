/**
 * `workbench/export/isoExportJob` —— **等轴导出的生产执行入口**。
 *
 * ## 它替代了什么
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | 命令自己 `plainForSave()` 取声明态文档，调烘焙函数拿 dataURL/Blob | `workbench/exportIsometricImage` / `workbench/exportAnimatedGif`（整文件删除） | 命令只调本模块：捕获（`composition/exportCapture`）→ 装配冻结作业（`assembleSnapshotExportJob`）→ `ExportJob.run()` → 字节 |
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
import { stillExportSemantics, type ExportSemanticFinding } from '@/application/exportSemantics'
import { createThreeOffscreenDevice } from '@/adapters/export/renderDevice'
import { assembleSnapshotExportJob } from '@/adapters/export/snapshotExportJob'
import type { JobOutcome } from '@/runtime/exportJob'
import type { TextureDecoder } from '@/composition/kernelTextureResources'
import {
  captureExportSnapshot,
  type ExportCapture,
  type ExportCaptureKind,
  type ExportCaptureSource,
  type ShotCaptureOptions,
} from '@/composition/exportCapture'

/**
 * 等轴导出的渲染边长（**唯一来源**；已收成一个值）。
 *
 * ## 为什么是一个常量而不是几个缺省
 *
 * 此前场景 GIF 的预览走 `ExportWorkspace.vue` 的 480（旧烘焙缺省），下载走
 * `ExportSceneGifOperator` 的 320（命令缺省）⇒ 同一张卡片"看到的"和"下到的"
 * 是两个尺寸（实测 480 vs 320）。**两个缺省必然漂移**，故收成一个值：
 * GIF 卡片预览、GIF 卡片下载、GIF 命令缺省、等轴 PNG 命令与卡片 —— 全部引用本常量。
 *
 * 480 的选择：等轴 PNG 的既有边长就是 480（预览与下载同源），GIF 与它同一台相机/
 * 同一取景，统一到 480 后"GIF 首帧 ≈ 同参数 PNG"的判据不再跨尺寸比较。
 */
export const EXPORT_PIXEL_SIZE = 480

/**
 * 场景 GIF 边长的夹取区间（**唯一一处夹取**在 `ExportSceneGifOperator`）。
 *
 * 区间沿用场景 GIF 命令的既有政策值（64..512；旧材质卡那条 64..1024 已随
 * `materialOperators` 退出而消失 —— 合并让"两处区间"降到一处）。
 * 夹取放在**命令侧**：捕获/作业只搬运调用方给的形参，不对它做第二次解释
 * （否则"声明的尺寸"与"产物的尺寸"会静默分叉）。
 */
export const SCENE_GIF_PIXEL_SIZE_RANGE = Object.freeze({ min: 64, max: 512 })

/**
 * 验收器具出图的**不透明天空底**（三对齐；旧器具 `SHOT_DEFAULT_BACKGROUND` 同值同名迁移）。
 *
 * 为什么器具不用透明底：像素级判据（"非空白"/包围盒）必须先能区分"空"与"内容"。
 * 透明底解码后空像素的 RGB 也是 0，会被判成内容 ⇒ 整幅都算非空白（**假绿**）。
 * 取 MC 天空蓝也让器具有图与游戏截图有共同底色，便于目视对照。
 */
export const SHOT_PNG_BACKGROUND = 0x9ec6e8

/** 等轴导出的输入（两个命令与导出卡片的预览/生成共用这一份形状）。 */
export interface IsoExportOptions {
  readonly kind: ExportCaptureKind
  /** 0..3（调用方已归一）。给 `shot` 时**不读**（验收器具不用等轴方向）。 */
  readonly directionIndex?: number
  /**
   * 渲染边长（像素；正方）。**搬运**自调用方（本模块不做夹取，见 `EXPORT_PIXEL_SIZE`
   * 的说明：夹取只有命令侧一处；卡片与命令引用同一个常量）。给 `shot` 时由它取代。
   */
  readonly pixelSize?: number
  /**
   * **验收器具的显式机位**（三对齐）：相对内容包围盒中心的落点 + 正交竖直全高
   * + 任意分辨率。给定时捕获**不用**等轴四向相机；其余（内容快照/冻结帧序列/资源表/
   * 作业装配/编码）**完全同一条链** —— 不新增渲染入口，也不改用户视口。
   */
  readonly shot?: ShotCaptureOptions
  /** 产物文件名（缺省按 kind + 方向派生）。器具用它带出处名（`shot-<name>.png`）。 */
  readonly fileName?: string
  /** 仅 `kind === 'image'`：场景秒（已由 `normalizeIsoSeconds` 归一）。 */
  readonly seconds?: number
  /**
   * 纹理解码器（**注入**）：本模块（`composition/`）不碰 DOM ——
   * 生产由命令层给 `createDomTextureDecoder()`，单测给受控解码器。
   */
  readonly decoder: TextureDecoder
  /** 注入时钟（本模块不读 `Date.now()`；调用方给）。 */
  readonly now: number
  /** 取消入口（生产命令当前不传 —— 不加 UI 按钮，只保留内部语义）。 */
  readonly signal?: AbortSignal
  /**
   * **不可表达语义的回调**。
   *
   * 在**捕获之后、作业之前**调用一次（此时 `request` 已冻结、能力损失已可判），
   * 且与作业成败无关 —— 于是"这次导出把纹理首帧当成了唯一帧"这类事实
   * **不会**因为作业后面失败而消失，也不会因为成功而被吞掉。
   *
   * 纯观察：抛错不影响导出（调用方负责兜）。
   */
  readonly onSemantics?: (findings: readonly ExportSemanticFinding[]) => void
  /** 进度回调（纯观察）。 */
  readonly onProgress?: (completed: number, total: number) => void
  /**
   * 逐帧驻留上限（缺省 = 产品政策 `LOOP_LIMITS`）。
   *
   * 只给判据用（把上限压低到夹具可触发，判"超限必须显式失败"）。生产调用**不传**。
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
  /** 本次导出的**不可表达语义**（与 `onSemantics` 同一份事实；空 = 完全表达）。 */
  readonly semantics: readonly ExportSemanticFinding[]
}

/** 一次导出作业的作用域（一个作业一个；进呈现层归属键）。 */
function scopeOf(options: IsoExportOptions): string {
  if (options.shot !== undefined) {
    return 'shot-export-' + String(options.shot.width) + 'x' + String(options.shot.height)
  }
  return 'iso-export-' + String(options.directionIndex) + '-' + String(options.pixelSize)
}

/** 产物文件名（**唯一**派生点：调用方给了 `fileName` 就原样用，否则按 kind + 方向派生）。 */
function fileNameOf(options: IsoExportOptions, kind: ExportKind, encoding: ArtifactEncoding): string {
  if (options.fileName !== undefined) return options.fileName
  const dir = String(options.directionIndex ?? 0)
  return (options.kind === 'image' ? 'iso-' : 'anim-') + dir + '.' + fileExtensionOf(kind, encoding)
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
    ...(options.directionIndex === undefined ? {} : { directionIndex: options.directionIndex }),
    ...(options.pixelSize === undefined ? {} : { pixelSize: options.pixelSize }),
    ...(options.shot === undefined ? {} : { shot: options.shot }),
    ...(options.seconds === undefined ? {} : { seconds: options.seconds }),
    decoder: options.decoder,
    now: options.now,
    requestId: options.shot === undefined
      ? 'iso-export-' + String(options.directionIndex)
      : 'shot-export-' + String(options.now),
    ...(options.loopLimits === undefined ? {} : { loopLimits: options.loopLimits }),
  })
  if (!captured.ok) return err(captured.error)
  const capture = captured.value
  const kind: ExportKind = options.kind === 'image' ? 'image' : 'animation'
  const encoding: ArtifactEncoding = options.kind === 'image' ? 'png' : 'gif'

  /**
   * **不可表达语义**：捕获值已冻结 ⇒ 能力损失此刻可判。
   *
   * 在作业之前算并回调：作业失败/取消时这些事实**同样**必须可见（"没导成"不等于
   * "没有不可表达语义"）。纯观察 —— 回调抛错不影响导出。
   */
  const semantics = stillExportSemantics(capture.request, options.kind === 'image' ? 'png' : 'gif')
  try {
    options.onSemantics?.(semantics)
  } catch {
    // 诊断是旁路：上报失败不改变导出结论。
  }

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
      // 面板明细块：捕获期那一份明细（与绑定同源；不进 digest）。
    captureFacts: capture.captureFacts,
      // 循环次数缺省 = 0（无限；不暴露 UI）。
    ...(options.kind === 'animation' ? { loopCount: 0 } : {}),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onProgress === undefined
      ? {}
      : { onProgress: (p) => options.onProgress!(p.completed, p.total) }),
  })

  try {
    const outcome = await handlers.job.run()
    if (outcome.status === 'cancelled') {
      return err(
        unsupportedOperation({
          reason: 'exportCancelled',
          target: options.shot === undefined ? String(options.directionIndex) : 'shot',
        }),
      )
    }
    if (outcome.status === 'failed') {
      // 失败原因**原样**带出（作业的诊断是结构化值；这里只做包装，不改写 reason）。
      return err(outcome.error as DomainError)
    }
    const fileName = fileNameOf(options, kind, encoding)
    return ok(
      Object.freeze({
        bytes: outcome.bytes,
        mediaType: mediaTypeOf(kind, encoding),
        fileName,
        capture,
        outcome,
        semantics,
      }),
    )
  } finally {
    // 中止订阅必须撤销（否则长寿命 `AbortController` 会累积回调）。
    handlers.detachAbort()
  }
}

/** 验收器具一次出图的输入（三对齐）。 */
export interface ShotExportOptions {
  /** 显式正交机位（相对内容包围盒中心）+ 任意分辨率。 */
  readonly shot: ShotCaptureOptions
  /** 产物文件名（必填：器具按机位名落盘，缺名就无法对账）。 */
  readonly fileName: string
  /** 纹理解码器（注入；生产由命令层给 `DomTextureDecoder`）。 */
  readonly decoder: TextureDecoder
  /** 注入时钟（本模块不读 `Date.now()`）。 */
  readonly now: number
  readonly signal?: AbortSignal
  readonly onSemantics?: (findings: readonly ExportSemanticFinding[]) => void
}

/**
 * 验收器具：**指定正交机位**出一张 PNG（走与产品命令**同一条**捕获/作业链）。
 *
 * 与 `runIsoExport` 的差别只有取景来源（显式值 vs 等轴四向表）与产物名；
 * 内容快照、冻结帧、资源清单、离屏端口、编码器全部同一份 —— 器具因此不会
 * 变成"第二条渲染链"（`tests/architecture/export-chain.test.ts` 把守）。
 */
export async function runShotExport(
  source: ExportCaptureSource,
  options: ShotExportOptions,
): Promise<Result<IsoExportResult>> {
  return runIsoExport(source, {
    kind: 'image',
    shot: options.shot,
    fileName: options.fileName,
    decoder: options.decoder,
    now: options.now,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onSemantics === undefined ? {} : { onSemantics: options.onSemantics }),
  })
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
 * "卡片上看到的图就是下载得到的图"这条判据（`e2e/export-iso-time.spec.ts`）读的是
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
