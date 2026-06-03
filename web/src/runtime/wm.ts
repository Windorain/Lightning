import type { Ref } from 'vue'
import { EventDispatcherImpl } from '@/events/dispatcher'
import type { ContextMenuItem } from '@/workbench/ux/contextMenu'

export class WM {
  readonly events = new EventDispatcherImpl()
  chrome: {
    contextMenuOpen?: Ref<boolean>
    contextMenuPosition?: Ref<{ x: number; y: number }>
    contextMenuItems?: ContextMenuItem[]
    lastMousePosition?: Ref<{ x: number; y: number } | null>
    showContextMenu?(pos: { x: number; y: number }, items: ContextMenuItem[]): void
    hideContextMenu?(): void
  } = {}
}
