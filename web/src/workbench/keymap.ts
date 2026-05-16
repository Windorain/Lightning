export interface KeyBinding {
  type: 'KEY'
  key: string
  ctrl?: boolean
  shift?: boolean
  toolId?: string
  action?: string
  opId?: string
  description: string
}

export interface MouseBinding {
  type: 'MOUSE'
  button: number
  ctrl?: boolean
  shift?: boolean
  toolId?: string
  action?: string
  opId?: string
  description: string
}

export interface WheelBinding {
  type: 'WHEEL'
  direction: 'up' | 'down'
  ctrl?: boolean
  shift?: boolean
  opId?: string
  description: string
}

export type InputBinding = KeyBinding | MouseBinding | WheelBinding

export const DEFAULT_KEYMAP: InputBinding[] = [
  // ---- KEY bindings ----
  { type: 'KEY', key: 'a', action: 'select-all', description: '全选/取消全选' },
  { type: 'KEY', key: 'g', toolId: 'move', description: '移动工具' },
  { type: 'KEY', key: 'z', ctrl: true, action: 'undo', description: '撤销' },
  { type: 'KEY', key: 'z', ctrl: true, shift: true, action: 'redo', description: '重做' },
  { type: 'KEY', key: 'Tab', action: 'toggle-tool', description: 'Select/上次工具切换' },
  { type: 'KEY', key: 't', action: 'toggle-toolshelf', description: '工具栏显示' },
  { type: 'KEY', key: 'n', action: 'toggle-properties', description: '属性面板显示' },

  // ---- MOUSE bindings ----
  { type: 'MOUSE', button: 0, opId: 'OPERATOR_SELECT', description: '选择方块' },
  { type: 'MOUSE', button: 2, action: 'context-menu', description: '上下文菜单' },
  { type: 'MOUSE', button: 1, opId: 'OPERATOR_VIEW_PAN', description: '平移视图' },
  { type: 'MOUSE', button: 1, shift: true, opId: 'OPERATOR_VIEW_ROTATE', description: '旋转视图' },
  { type: 'MOUSE', button: 1, ctrl: true, opId: 'OPERATOR_VIEW_ZOOM', description: '缩放视图' },

  // ---- WHEEL bindings ----
  { type: 'WHEEL', direction: 'down', opId: 'OPERATOR_VIEW_ZOOM', description: '缩小' },
  { type: 'WHEEL', direction: 'up', opId: 'OPERATOR_VIEW_ZOOM', description: '放大' },
]

const STORAGE_KEY = 'lightning-workbench-keymap'

export function loadKeymap(): InputBinding[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as InputBinding[]
  } catch { /* ignore */ }
  return DEFAULT_KEYMAP
}

export function saveKeymap(keymap: InputBinding[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(keymap)) } catch { /* */ }
}

export function matchBinding(
  binding: InputBinding,
  event: Event,
): boolean {
  if (binding.type === 'KEY' && event instanceof KeyboardEvent) {
    if (event.key.toLowerCase() !== binding.key.toLowerCase()) return false
    if (binding.ctrl !== undefined && binding.ctrl !== (event.ctrlKey || event.metaKey)) return false
    if (binding.shift !== undefined && binding.shift !== event.shiftKey) return false
    return true
  }

  if (binding.type === 'MOUSE' && event instanceof PointerEvent) {
    if (event.type !== 'pointerdown') return false
    if (binding.button !== event.button) return false
    if (binding.ctrl !== undefined && binding.ctrl !== (event.ctrlKey || event.metaKey)) return false
    if (binding.shift !== undefined && binding.shift !== event.shiftKey) return false
    return true
  }

  if (binding.type === 'WHEEL' && event instanceof WheelEvent) {
    if (binding.direction === 'up' && event.deltaY >= 0) return false
    if (binding.direction === 'down' && event.deltaY <= 0) return false
    if (binding.ctrl !== undefined && binding.ctrl !== (event.ctrlKey || event.metaKey)) return false
    if (binding.shift !== undefined && binding.shift !== event.shiftKey) return false
    return true
  }

  return false
}
