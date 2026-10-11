/**
 * `runtime/exportJob` —— **导出作业接线**（#249 §19.4；#260 A29 的作业半边）。
 *
 * ## 分工（与 `application/exportPlan` 的边界）
 *
 * | 半边 | 谁 | 内容 |
 * |---|---|---|
 * | 纯政策 | `application/exportPlan` | 固定采样序列、取景、资源需求、预检结论 |
 * | **作业接线（本文件）** | 本文件 | 解析资源、分配离屏资源、逐帧渲染、编码、报告进度、取消释放 |
 *
 * ## A29 的四条判据在本文件的落点
 *
 * | 判据（#249 §14 A29 原文） | 落点 |
 * |---|---|
 * | 产物对应 **S0** 与资源清单 | 作业**只**读 `request`（不可变值）；`render` 的每一帧都从 `request.frames` 取时间，没有"再问一次编辑器"的入口 |
 * | **不改变**工作区时间/选择/机位 | 本文件不持有 `EditorClient`/`EditContext`/Three 场景；它拿到的 `RenderPort` 是**离屏**端口（`dispose` 释放自己的全部资源） |
 * | **取消释放资源** | `cancel()` 置位 → 作业在帧边界停下 → **必然**调用 `port.dispose()`（见 `finally`） |
 * | 缺必需资源 / 不支持运行时间映射 ⇒ **预检失败** | 预检在作业启动前由 `application/exportPlan.preflightExport` 完成；未通过则作业**不启动**且不产生任何产物 |
 *
 * ## 为什么"取消"不是"超时"
 *
 * 契约 §1.5 与 #249 §5：「调用超时不冒充取消」。本文件因此**没有**超时参数 ——
 * 想取消就显式 `cancel()`；超时是调用方的观察，不是作业的结局（作业状态机在
 * `runtime/effects` 已按同一口径实现，这里不另立一套）。
 *
 * ## 资源释放不靠"记得 dispose"
 *
 * `run()` 用 `try/finally` 包住：正常完成、编码失败、被取消、渲染抛错 —— 四条路径
 * 都会走到 `dispose()`。`run()` 返回的 `JobOutcome` 里带 `releasedFor`，
 * 使"释放了几个资源"成为**可断言**的事实而不是注释里的承诺。
 */

import type { DomainError, Result } from '@/domain/errors'
import { err, unsupportedOperation } from '@/domain/errors'
import type { ExportRequest } from '@/domain/captureSpec'
import type { ExportDiagnostic } from '@/application/exportPlan'
import { preflightError, preflightExport, type EncoderPort, type ExportKind, type ExportPreflight, type ImageEncoding, type RenderedFrame } from '@/application/exportPlan'

// ─────────────────────────────────────────────────────────────────────────────
// 端口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 离屏渲染端口（由呈现层/适配器实现）。
 *
 * 「作业有**独立生命周期与资源预算**，结束/取消**释放其引用，不关闭用户视口**」
 * （#249 §19.4 末段）—— 故本接口只有 `acquire/renderFrame/release`，
 * **没有**任何"取用户视口""取实时相机"的方法。想借用实时相机在这里没有方法可调。
 */
export interface OffscreenRenderPort {
  /**
   * 分配离屏资源（渲染目标、几何/材质上传等）。返回本次分配的资源句柄数（供释放对账）。
   *
   * 分配失败必须是**结构化失败**（不是抛异常）：`Result` 的失败侧会被翻译成
   * `ExportDiagnostic`，作业据此判 failed 而**不产出伪完整文件**。
   */
  acquire(request: ExportRequest): Result<{ readonly allocated: number }>
  /** 渲染一帧（纯数据出参；不含 GPU 句柄）。 */
  renderFrame(request: ExportRequest, frameIndex: number): Result<RenderedFrame>
  /** 释放 `acquire` 分配的全部资源。**必须幂等**（重复调用不重复释放）。 */
  release(): void
}

/** 作业进度上报（#249 §19.4「报告进度」）。 */
export interface ExportProgress {
  readonly requestId: string
  readonly completed: number
  readonly total: number
  /** 当前阶段（诊断关联用）。 */
  readonly phase: 'acquiring' | 'rendering' | 'encoding' | 'done'
}

// ─────────────────────────────────────────────────────────────────────────────
// 作业
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportJobOptions {
  readonly request: ExportRequest
  readonly kind: ExportKind
  readonly encoding?: ImageEncoding
  readonly port: OffscreenRenderPort
  readonly encoder?: EncoderPort
  /** 资源状态仓库（P5 交付；缺省 ⇒ 有必需资源即阻塞）。 */
  readonly assets?: Parameters<typeof preflightExport>[0]['assets']
  /** 是否显式接受有损输出（§19.4「部分输出仅在**显式模式**下允许并标记」）。 */
  readonly allowLossy?: boolean
  /** 进度回调（可选；纯观察，不驱动业务）。 */
  readonly onProgress?: (p: ExportProgress) => void
}

/**
 * 作业结局。
 *
 * `cancelled` 是**独立分支**：取消不产出产物、不报成功（契约 §1.5 的状态机同族要求）。
 */
export type JobOutcome =
  | {
      readonly status: 'completed'
      readonly bytes: Uint8Array
      readonly mediaType: string
      /** 是否走了显式有损模式（由 `allowLossy` 显式开启；产物据 `capabilityLoss` 标记）。 */
      readonly lossy: boolean
      readonly releasedFor: number
      readonly framesRendered: number
    }
  | { readonly status: 'cancelled'; readonly releasedFor: number; readonly framesRendered: number }
  | { readonly status: 'failed'; readonly diagnostics: readonly ExportDiagnostic[]; readonly releasedFor: number; readonly error: DomainError }

/**
 * 导出作业。
 *
 * 生命周期：`preflight()` → `run()`；`cancel()` 可在任意时刻调用（幂等）。
 * 作业**不自驱**（没有 RAF/定时器）—— `run()` 是异步函数，由调用方 await；
 * 帧间让出控制权（`await Promise.resolve()`）使 `cancel()` 有机会插进来，
 * 但**不**读墙钟、不设超时。
 */
export class ExportJob {
  private cancelled = false
  private releasedFor = 0
  private framesRendered = 0
  private readonly opts: ExportJobOptions

  constructor(opts: ExportJobOptions) {
    this.opts = opts
  }

  /** 预检（纯；不做任何 IO；不产生任何产物）。 */
  preflight(): ExportPreflight {
    return preflightExport({
      request: this.opts.request,
      kind: this.opts.kind,
      ...(this.opts.encoding === undefined ? {} : { encoding: this.opts.encoding }),
      ...(this.opts.assets === undefined ? {} : { assets: this.opts.assets }),
      ...(this.opts.allowLossy === undefined ? {} : { allowLossy: this.opts.allowLossy }),
      ...(this.opts.encoder === undefined ? {} : { encoder: this.opts.encoder }),
    })
  }

  /** 请求取消。**幂等**；不等待、不超时（契约 §1.5）。 */
  cancel(): void {
    this.cancelled = true
  }

  get isCancelled(): boolean {
    return this.cancelled
  }

  /**
   * 执行作业。
   *
   * 顺序（每一步的失败都**不**产出部分文件）：
   *  1. 预检：不通过 ⇒ `failed`，**不**调用 `port.acquire`（连离屏资源都不分配）；
   *  2. `acquire` 离屏资源（失败 ⇒ `failed`，仍未产出）；
   *  3. 逐帧渲染（读 `request.frames` 的**冻结**序列）；
   *  4. 编码（失败 ⇒ `failed`，释放资源，仍无产物）；
   *  5. **`finally` 释放**（正常/取消/失败三条路径都释放）。
   */
  async run(): Promise<JobOutcome> {
    const request = this.opts.request
    const job = this

    const pre = this.preflight()
    if (pre.status === 'blocked') {
      const error = preflightError(pre) ?? unsupportedOperation({ reason: 'exportPreflightBlocked' })
      return Object.freeze({ status: 'failed' as const, diagnostics: pre.diagnostics, releasedFor: 0, error })
    }
    // 取消发生在预检期间：不分配、不产出。
    if (this.cancelled) return Object.freeze({ status: 'cancelled' as const, releasedFor: 0, framesRendered: 0 })

    this.report('acquiring', 0)
    const acquired = this.opts.port.acquire(request)
    if (!acquired.ok) {
      // 分配失败 ⇒ **没有**任何资源归本次作业所有，故不调用 `release()`。
      // （这与"取消/失败必释放"不矛盾：释放的前提是**先**拿到了东西。
      //   `releasedFor: 0` 是这条判据的可断言形态。）
      return Object.freeze({
        status: 'failed' as const,
        diagnostics: Object.freeze([
          Object.freeze({ code: 'ExportAcquireFailed' as const, detail: Object.freeze({ reason: 'offscreenAcquireFailed', code: acquired.error.code }) }),
        ]),
        releasedFor: 0,
        error: acquired.error,
      })
    }
    this.releasedFor = acquired.value.allocated

    try {
      const rendered: RenderedFrame[] = []
      for (let i = 0; i < request.frames.length; i++) {
        if (this.cancelled) {
          return Object.freeze({ status: 'cancelled' as const, releasedFor: this.releasedFor, framesRendered: this.framesRendered })
        }
        const frame = this.opts.port.renderFrame(request, i)
        if (!frame.ok) {
          return Object.freeze({
            status: 'failed' as const,
            diagnostics: Object.freeze([
              Object.freeze({ code: 'ExportRenderFailed' as const, detail: Object.freeze({ reason: 'renderFrameFailed', frameIndex: i, code: frame.error.code }) }),
            ]),
            releasedFor: this.releasedFor,
            error: frame.error,
          })
        }
        rendered.push(frame.value)
        this.framesRendered += 1
        this.report('rendering', this.framesRendered)
        // 让出控制权：使 `cancel()` 有机会在帧边界插进来（**不**是定时器、不读墙钟）。
        await Promise.resolve()
      }

      if (this.cancelled) {
        return Object.freeze({ status: 'cancelled' as const, releasedFor: this.releasedFor, framesRendered: this.framesRendered })
      }

      const encoder = this.opts.encoder
      if (encoder === undefined) {
        // 预检已挡住这种情形；此处是防御性分支（不得静默产出空产物）。
        return Object.freeze({
          status: 'failed' as const,
          diagnostics: Object.freeze([Object.freeze({ code: 'ExportEncodingNotConfigured' as const, detail: Object.freeze({ kind: this.opts.kind }) })]),
          releasedFor: this.releasedFor,
          error: unsupportedOperation({ reason: 'exportEncoderMissing', kind: this.opts.kind }),
        })
      }

      this.report('encoding', this.framesRendered)
      const encoded = await encoder.encode({
        request,
        kind: this.opts.kind,
        encoding: this.opts.encoding ?? 'png',
        rendered,
        // 取消信号是**活视图**：编码器在长循环里可以读到最新的取消意图。
        // 它不读墙钟、不设超时（契约 §1.5「调用超时不冒充取消」）。
        signal: { get cancelled() { return job.cancelled } },
      })
      if (this.cancelled) {
        return Object.freeze({ status: 'cancelled' as const, releasedFor: this.releasedFor, framesRendered: this.framesRendered })
      }
      if (!encoded.ok) {
        return Object.freeze({
          status: 'failed' as const,
          diagnostics: Object.freeze([
            Object.freeze({ code: 'ExportEncodeFailed' as const, detail: Object.freeze({ reason: 'encodeFailed', code: encoded.error.code, ...encoded.error.params }) }),
          ]),
          releasedFor: this.releasedFor,
          error: encoded.error,
        })
      }

      // 只在这里产出产物。`lossy` **显式**标记：有损模式只能在 `allowLossy === true` 时走到。
      this.report('done', this.framesRendered)
      return Object.freeze({
        status: 'completed' as const,
        bytes: encoded.value,
        mediaType: mediaTypeFor(this.opts.kind, this.opts.encoding ?? 'png'),
        lossy: request.capabilityLoss.length > 0 && this.opts.allowLossy === true,
        releasedFor: this.releasedFor,
        framesRendered: this.framesRendered,
      })
    } finally {
      // 四条路径（完成/取消/失败/抛错）都会到这里；`release()` 必须幂等。
      this.opts.port.release()
    }
  }

  private report(phase: ExportProgress['phase'], completed: number): void {
    this.opts.onProgress?.(
      Object.freeze({ requestId: this.opts.request.requestId, completed, total: this.opts.request.frames.length, phase }),
    )
  }
}

function mediaTypeFor(kind: ExportKind, encoding: ImageEncoding): string {
  switch (kind) {
    case 'image':
      return encoding === 'jpeg' ? 'image/jpeg' : 'image/png'
    case 'animation':
      return 'image/gif'
    case 'geometry':
      return 'application/zip'
    case 'project':
      return 'application/json'
  }
}

/** 便于调用方检查"作业是否可以不启动"：预检不过 ⇒ 返回失败诊断（**不**产生产物）。 */
export function refuseWhenBlocked(pre: ExportPreflight): Result<null> {
  if (pre.status === 'ready') return { ok: true, value: null }
  return err(preflightError(pre) ?? unsupportedOperation({ reason: 'exportPreflightBlocked' }))
}
