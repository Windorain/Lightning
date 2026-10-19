import { EMBED_KEYMAP } from './embedKeymap'
import { REGION_KEYMAP } from '@/runtime/regionIds'
import { instanceUiKey } from '@/runtime/instanceStorage'

export interface KeyBinding {
  type: 'KEY'
  key: string
  ctrl?: boolean
  shift?: boolean
  toolId?: string
  action?: string
  opId?: string
  props?: Record<string, unknown>
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
  props?: Record<string, unknown>
  description: string
}

export interface WheelBinding {
  type: 'WHEEL'
  direction: 'up' | 'down'
  ctrl?: boolean
  shift?: boolean
  opId?: string
  props?: Record<string, unknown>
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
  { type: 'KEY', key: 'b', toolId: 'annotation-box', description: '注解框工具' },
  { type: 'KEY', key: 'l', toolId: 'annotation-line', description: '线段工具' },
  { type: 'KEY', key: 'p', toolId: 'annotation-point', description: '标记点工具' },
  { type: 'KEY', key: 't', action: 'toggle-toolshelf', description: '工具栏显示' },
  { type: 'KEY', key: 'n', action: 'toggle-properties', description: '属性面板显示' },
  { type: 'KEY', key: 's', ctrl: true, opId: 'OPERATOR_WIKI_SAVE_CONFIRM', description: '保存到 Wiki' },

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

/**
 * 键位表的**实例作用域**键（M7-6）：`lk-ui.v1.<instanceId>.keymap`。
 *
 * 旧键是固定的 `lightning-workbench-keymap`（全页一份）。同页两个工作台今天被
 * 结构禁止，但键里的实例段是 D7 的机械判据（两个实例互不覆盖），也是将来
 * 放开多工作台的前置条件。旧键**不迁移**（没有实例身份可归属）。
 */
function keymapStorageKey(instanceId: string): string {
  return instanceUiKey(instanceId, 'keymap')
}

export function loadKeymap(instanceId: string = 'workbench'): InputBinding[] {
  try {
    const raw = localStorage.getItem(keymapStorageKey(instanceId))
    if (raw) return JSON.parse(raw) as InputBinding[]
  } catch { /* ignore */ }
  return DEFAULT_KEYMAP
}

const REGION_KEYMAP_PRESETS: Record<string, (instanceId: string) => InputBinding[]> = {
  [REGION_KEYMAP.WORKBENCH_VIEWPORT]: (instanceId) => loadKeymap(instanceId),
  [REGION_KEYMAP.EMBED_VIEWPORT]: () => EMBED_KEYMAP,
}

/** 按 Screen Region.keymapId 解析基础键位（不含工具覆盖层；键位按实例隔离）。 */
export function resolveRegionBaseKeymap(keymapId?: string, instanceId: string = 'workbench'): InputBinding[] {
  if (!keymapId) return loadKeymap(instanceId)
  return REGION_KEYMAP_PRESETS[keymapId]?.(instanceId) ?? loadKeymap(instanceId)
}

export function saveKeymap(keymap: InputBinding[], instanceId: string = 'workbench'): void {
  try { localStorage.setItem(keymapStorageKey(instanceId), JSON.stringify(keymap)) } catch { /* */ }
}

export function matchBinding(
  binding: InputBinding,
  event: Event,
): boolean {
  if (binding.type === 'KEY' && event instanceof KeyboardEvent) {
    if (event.key.toLowerCase() !== binding.key.toLowerCase()) return false
    const wantCtrl = binding.ctrl ?? false
    if (wantCtrl !== (event.ctrlKey || event.metaKey)) return false
    const wantShift = binding.shift ?? false
    if (wantShift !== event.shiftKey) return false
    return true
  }

  if (binding.type === 'MOUSE' && event instanceof PointerEvent) {
    if (event.type !== 'pointerdown') return false
    if (binding.button !== event.button) return false
    const wantCtrl = binding.ctrl ?? false
    if (wantCtrl !== (event.ctrlKey || event.metaKey)) return false
    const wantShift = binding.shift ?? false
    if (wantShift !== event.shiftKey) return false
    return true
  }

  if (binding.type === 'WHEEL' && event instanceof WheelEvent) {
    if (binding.direction === 'up' && event.deltaY >= 0) return false
    if (binding.direction === 'down' && event.deltaY <= 0) return false
    const wantCtrl = binding.ctrl ?? false
    if (wantCtrl !== (event.ctrlKey || event.metaKey)) return false
    const wantShift = binding.shift ?? false
    if (wantShift !== event.shiftKey) return false
    return true
  }

  return false
}
