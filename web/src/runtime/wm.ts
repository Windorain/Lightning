import type { Ref } from 'vue'
import { EventDispatcherImpl } from '@/events/dispatcher'
import type { createLogCenter } from '@/logging/LogCenter'
import type { ContextMenuItem } from '@/workbench/ux/contextMenu'
import type { ShellSettings } from '@/runtime/shellSettings'
import type { WikiUiState } from '@/runtime/wikiUi'
import { createShellSettings, type CreateShellSettingsOptions } from '@/runtime/shellSettings'
import { createDiagnosticRecorder, type DiagnosticRecorder } from '@/application/diagnostics'
import { createContentBoundaryDiagnostics } from '@/runtime/contentDiagnostics'

export interface WMChrome {
  contextMenuOpen?: Ref<boolean>
  contextMenuPosition?: Ref<{ x: number; y: number }>
  contextMenuItems?: ContextMenuItem[]
  lastMousePosition?: Ref<{ x: number; y: number } | null>
  showContextMenu?(pos: { x: number; y: number }, items: ContextMenuItem[]): void
  hideContextMenu?(): void
  wikiUi?: WikiUiState
}

export class WM {
  readonly events: EventDispatcherImpl
  readonly settings: ShellSettings
  /**
   * 有界结构化诊断（#249 §19.9 / #259 A35）。
   *
   * 容量在这里**显式**给出（默认 512）：容量是运行配置，
   * 而"必须有容量"是契约（`createDiagnosticRecorder` 的必填参数）。
   * 挂在 WM 上 ⇒ **每实例一份**，同页两实例的诊断互不混杂。
   */
  readonly diagnostics: DiagnosticRecorder
  readonly chrome: WMChrome = {}

  constructor(
    log?: ReturnType<typeof createLogCenter>,
    shellOptions?: CreateShellSettingsOptions,
    diagnosticsOptions?: { capacity?: number; now?: () => number },
  ) {
    this.events = new EventDispatcherImpl(log)
    this.settings = createShellSettings(shellOptions)
    this.diagnostics = createDiagnosticRecorder({
      capacity: diagnosticsOptions?.capacity ?? 512,
      now: diagnosticsOptions?.now ?? (() => Date.now()),
    })
    // 内容边界拒绝事实 → 诊断通道（#259：内容拒绝也要可观测，不只是丢弃）
    createContentBoundaryDiagnostics(this.diagnostics)
  }
}
