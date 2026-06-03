import { ref } from 'vue'

export interface ContextMenuItem {
  kind: 'operator' | 'label' | 'separator'
  label: string
  icon?: string
  opId?: string
  props?: Record<string, unknown>
}

export function createContextMenu() {
  return {
    open: ref(false),
    position: ref({ x: 0, y: 0 }),
    items: ref<ContextMenuItem[]>([]),
  }
}

export type ContextMenuState = ReturnType<typeof createContextMenu>

export function showContextMenu(
  cm: ContextMenuState,
  pos: { x: number; y: number },
  menuItems: ContextMenuItem[],
) {
  cm.position.value = pos
  cm.items.value = menuItems
  cm.open.value = true
}

export function hideContextMenu(cm: ContextMenuState) {
  cm.open.value = false
  cm.items.value = []
}
