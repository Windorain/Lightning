export interface KeyBinding {
  key: string
  ctrl?: boolean
  shift?: boolean
  toolId?: string
  action?: string
  description: string
}

export const DEFAULT_KEYMAP: KeyBinding[] = [
  { key: 'a', toolId: undefined, action: 'select-all', description: '全选/取消全选' },
  { key: 'b', toolId: 'select', action: 'box-select', description: '框选模式' },
  { key: 'g', toolId: 'move', description: '移动工具' },
  { key: 'z', ctrl: true, shift: false, action: 'undo', description: '撤销' },
  { key: 'z', ctrl: true, shift: true, action: 'redo', description: '重做' },
  { key: 'i', ctrl: true, action: 'invert', description: '反选' },
  { key: 'Tab', action: 'toggle-tool', description: 'Select/上次工具切换' },
  { key: 't', action: 'toggle-toolshelf', description: '工具栏显示' },
  { key: 'n', action: 'toggle-properties', description: '属性面板显示' },
]

const STORAGE_KEY = 'lightning-workbench-keymap'

export function loadKeymap(): KeyBinding[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as KeyBinding[]
  } catch { /* ignore */ }
  return DEFAULT_KEYMAP
}

export function saveKeymap(keymap: KeyBinding[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(keymap)) } catch { /* */ }
}

export function matchBinding(
  binding: KeyBinding,
  event: KeyboardEvent,
): boolean {
  const keyMatch = event.key.toLowerCase() === binding.key.toLowerCase()
  if (!keyMatch) return false
  if (binding.ctrl !== undefined && binding.ctrl !== (event.ctrlKey || event.metaKey)) return false
  if (binding.shift !== undefined && binding.shift !== event.shiftKey) return false
  return true
}
