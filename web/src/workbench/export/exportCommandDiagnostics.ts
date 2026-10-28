/**
 * **导出命令 → 诊断通道**的接线。
 *
 * ## 它替代了什么
 *
 * 在此之前，两个导出命令的失败只做两件事：`ctx.log.warn(...)` 与把错误再抛给
 * UI（卡片红字）。也就是说，契约要求"无法表达的语义必须诊断"这件事，在
 * **今天的生产路径上没有可查询的载体**：日志是自由文本、UI 文案随语言变化，
 * 且"导出成功但只用了纹理首帧"这类事实**根本没有入口**。
 *
 * 本文件把命令侧的四个时点接进 `ctx.wm.diagnostics`（有界环形缓冲、只读读面）：
 *
 * | 时点 | 码 | 用途 |
 * |---|---|---|
 * | 命令开始 | `export.requested` | 命令/方向/模式与作业身份 |
 * | 捕获后、作业前 | `export.capabilityUnsupported` 等 | 目标格式表达不了的语义（**逐项**） |
 * | 完成 | `export.completed` | 产物形态/帧数/清单摘要/交付位置/有损标记 |
 * | 失败 | `export.failed` | 稳定 reason + 领域错误码（不是 UI 文案） |
 *
 * ## 为什么 sink 只收一个 `DiagnosticRecorder`
 *
 * 不 import `runtime/context`：命令把 `ctx.wm.diagnostics` 传进来即可。于是本文件
 * 在单测里能用固定时钟的记录器直接断言，而"哪个记录器"由装配决定（与
 * `runtime/contentDiagnostics` 的注入方向同一纪律）。
 */

import type { DiagnosticRecorder } from '@/application/diagnostics'
import { findingOfExportDiagnostic, type ExportSemanticFinding } from '@/application/exportSemantics'
import type { ExportDiagnostic } from '@/application/exportPlan'
import type { IsoExportResult } from '@/workbench/export/isoExportJob'
import { exportErrorText } from '@/workbench/export/isoExportJob'
import type { DomainError } from '@/domain/errors'

/** 命令身份（关联字段；同一条命令的所有记录共享它）。 */
export interface ExportCommandIdentity {
  readonly commandId: string
  /** 产物格式（`png`/`gif`/`obj`/`plain`/`envelope`；进 `params.format`）。 */
  readonly format: string
}

/** 命令侧诊断接线。 */
export interface ExportDiagnosticSink {
  /** 命令被接收（参数：format + 调用方给的附加事实）。 */
  requested(params?: Readonly<Record<string, string | number | boolean>>): void
  /** 一批不可表达语义（逐条结构化；同码同对象合并）。 */
  findings(findings: readonly ExportSemanticFinding[]): number
  /** 完成（参数含产物形态/帧数/清单摘要/交付位置）。 */
  completed(result: IsoExportResult): void
  /** 失败（稳定 reason + 领域错误码；**不**写 UI 文案）。 */
  failed(error: unknown): void
  /** 预检/作业的结构化诊断（notes 或 blocked 项）。 */
  diagnostics(items: readonly ExportDiagnostic[]): number
}

/**
 * 建一个导出诊断 sink。
 *
 * `record` 抛错**不得**影响导出本身（诊断是旁路：它坏了不能把一次成功导出变成失败）。
 */
export function createExportDiagnosticSink(
  recorder: DiagnosticRecorder,
  identity: ExportCommandIdentity,
): ExportDiagnosticSink {
  const base = { commandId: identity.commandId }
  const safeRecord = (fn: () => void): void => {
    try {
      fn()
    } catch {
      // 诊断是旁路：记录失败不改变业务结论（同 `textureResourcesOf` 的进度上报纪律）。
    }
  }
  return {
    requested(params = {}) {
      safeRecord(() => {
        recorder.record({
          channel: 'export',
          code: 'export.requested',
          params: { format: identity.format, ...params },
          correlation: base,
        })
      })
    },
    findings(list) {
      if (list.length === 0) return 0
      let written = 0
      safeRecord(() => {
        // 逐条写（**不**在这里合并）：合并/上限在 `reportExportSemantics` 内一处判定，
        // 本类只做"命令身份"的关联，不复制第二套政策。
        for (const f of list) {
          recorder.record({
            channel: 'export',
            code: f.code,
            params: f.params,
            correlation: { ...base, ...(f.objectId === undefined ? {} : { objectId: f.objectId }) },
          })
          written++
        }
      })
      return written
    },
    diagnostics(items) {
      if (items.length === 0) return 0
      let written = 0
      safeRecord(() => {
        for (const d of items) {
          const f = findingOfExportDiagnostic(d)
          recorder.record({
            channel: 'export',
            code: f.code,
            params: f.params,
            correlation: base,
          })
          written++
        }
      })
      return written
    },
    completed(result) {
      safeRecord(() => {
        const o = result.outcome
        recorder.record({
          channel: 'export',
          code: 'export.completed',
          params: {
            format: identity.format,
            mediaType: result.mediaType,
            frames: o.framesRendered,
            framesDeclared: result.capture.request.frames.length,
            manifestEntries: o.assetManifest.entries.length,
            manifestDigest: o.assetManifest.digest,
            manifestAssembled: o.assetManifest.assembled,
            // 清单交付在面板；这条事实让"没有第二个下载文件"可断言。
            delivery: o.delivery,
            lossy: o.lossy,
            releasedFor: o.releasedFor,
            // 诊断本身也是事实：本次完成时带出的非阻塞项条数。
            notes: o.diagnostics.length,
          },
          correlation: base,
        })
      })
    },
    failed(error) {
      safeRecord(() => {
        const params: Record<string, string | number | boolean> = { format: identity.format }
        if (isDomainError(error)) {
          params.code = error.code
          for (const [k, v] of Object.entries(error.params)) params[k] = v
        } else {
          params.code = 'Thrown'
          params.detail = error instanceof Error ? error.message : String(error)
        }
        recorder.record({ channel: 'export', code: 'export.failed', params, correlation: base })
      })
    },
  }
}

/**
 * `DomainError` 的结构判定（不 import 运行时判定器：`errors` 只有类型与构造器）。
 *
 * 判 `code` 与 `params` 两个字段同时在场 —— 这是 `DomainError` 的全部形状。
 */
function isDomainError(e: unknown): e is DomainError {
  if (e === null || typeof e !== 'object') return false
  const o = e as { code?: unknown; params?: unknown }
  return typeof o.code === 'string' && o.params !== null && typeof o.params === 'object'
}

/** 失败原因的**可读**行（日志仍用；诊断通道用 `failed` 的结构化形态）。 */
export function failureLine(error: unknown): string {
  return isDomainError(error) ? exportErrorText(error) : error instanceof Error ? error.message : String(error)
}
