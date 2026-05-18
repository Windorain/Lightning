/**
 * Embed keymap — 仅视口导航绑定。
 *
 * 复用 workbench 的 InputBinding/matchBinding 类型与匹配逻辑，
 * handler 通过 BContext 调用操作符（无拖拽手势检测、无上下文菜单、无 undo/redo 键绑定）。
 */
import type { InputBinding } from '@/workbench/keymap'
import { matchBinding } from '@/workbench/keymap'
import type { RegionEventHandler } from '@/workbench/events/handlerTypes'
import { HANDLER_TYPE } from '@/workbench/events/handlerTypes'
import type { BContext } from '@/workbench/context/bContext'

export const EMBED_KEYMAP: InputBinding[] = [
  // Left mouse (primary)
  {
    type: 'MOUSE', button: 0, opId: 'OPERATOR_VIEW_ROTATE', description: '旋转视图 (LMB)',
  },
  {
    type: 'MOUSE', button: 0, shift: true, opId: 'OPERATOR_VIEW_PAN', description: '平移视图 (Shift+LMB)',
  },
  {
    type: 'MOUSE', button: 0, ctrl: true, opId: 'OPERATOR_VIEW_ZOOM', description: '缩放视图 (Ctrl+LMB)',
  },
  // Middle mouse (Blender convention)
  {
    type: 'MOUSE', button: 1, opId: 'OPERATOR_VIEW_PAN', description: '平移视图 (MMB)',
  },
  {
    type: 'MOUSE', button: 1, shift: true, opId: 'OPERATOR_VIEW_ROTATE', description: '旋转视图 (Shift+MMB)',
  },
  {
    type: 'MOUSE', button: 1, ctrl: true, opId: 'OPERATOR_VIEW_ZOOM', description: '缩放视图 (Ctrl+MMB)',
  },
  // Right mouse (alternative for users without MMB)
  {
    type: 'MOUSE', button: 2, opId: 'OPERATOR_VIEW_PAN', description: '平移视图 (RMB)',
  },
  {
    type: 'MOUSE', button: 2, shift: true, opId: 'OPERATOR_VIEW_ROTATE', description: '旋转视图 (Shift+RMB)',
  },
  {
    type: 'MOUSE', button: 2, ctrl: true, opId: 'OPERATOR_VIEW_ZOOM', description: '缩放视图 (Ctrl+RMB)',
  },
  // Wheel
  {
    type: 'WHEEL', direction: 'down', opId: 'OPERATOR_VIEW_ZOOM', description: '缩小',
  },
  {
    type: 'WHEEL', direction: 'up', opId: 'OPERATOR_VIEW_ZOOM', description: '放大',
  },
]

export function createEmbedKeymapHandler(
  regionId: string,
  getCtx: () => BContext | null,
): RegionEventHandler {
  return {
    type: HANDLER_TYPE.KEYMAP,
    handle(event: Event): { break: boolean } {
      const ctx = getCtx()
      if (!ctx) return { break: false }

      for (const binding of EMBED_KEYMAP) {
        if (!matchBinding(binding, event)) continue

        if (binding.type === 'MOUSE' && binding.opId) {
          ctx.operators.invoke(binding.opId, undefined, event, regionId)
          return { break: true }
        }

        if (binding.type === 'WHEEL' && binding.opId) {
          ctx.operators.invoke(binding.opId, undefined, event, regionId)
          return { break: true }
        }
      }

      return { break: false }
    },
  }
}
