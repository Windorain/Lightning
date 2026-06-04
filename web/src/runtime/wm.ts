import type { Ref } from 'vue'
import { EventDispatcherImpl } from '@/events/dispatcher'
import type { createLogCenter } from '@/logging/LogCenter'
import type { ContextMenuItem } from '@/workbench/ux/contextMenu'
import type { ShellSettings } from '@/runtime/contextAccess'
import type { WikiUiState } from '@/runtime/wikiUi'
import { createShellSettings, type CreateShellSettingsOptions } from '@/runtime/shellSettings'

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
  readonly chrome: WMChrome = {}

  constructor(
    log?: ReturnType<typeof createLogCenter>,
    shellOptions?: CreateShellSettingsOptions,
  ) {
    this.events = new EventDispatcherImpl(log)
    this.settings = createShellSettings(shellOptions)
  }
}
