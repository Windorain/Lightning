/**
 * Keymap handler — 对标 Blender 的 KEYMAP handler。
 *
 * 将 KeyboardEvent 与 keymap bindings 匹配，执行对应操作符。
 * 优先于 UI handler 执行，被 modal stack 完全覆盖。
 */
import type { TypedEventHandler } from '@/workbench/events/eventTypes'
import { HANDLER_TYPE } from '@/workbench/events/eventTypes'
import type { BContext } from '@/workbench/context/bContext'
import { loadKeymap, matchBinding, type KeyBinding } from '@/workbench/keymap'

const OPERATOR_KEY_MAP: Record<string, string> = {
  select: 'OPERATOR_SELECT',
  move: 'OPERATOR_MOVE',
  mirror: 'OPERATOR_MIRROR',
}

export function createKeymapHandler(getBctx: () => BContext | null): TypedEventHandler {
  let keymap: KeyBinding[] = []

  return {
    type: HANDLER_TYPE.KEYMAP,
    handle(event: Event): { break: boolean } {
      if (!(event instanceof KeyboardEvent)) return { break: false }

      // Lazy-load keymap on first use
      if (keymap.length === 0) keymap = loadKeymap()

      const bctx = getBctx()
      if (!bctx) return { break: false }

      for (const binding of keymap) {
        if (!matchBinding(binding, event)) continue
        event.preventDefault()

        if (binding.toolId) {
          const opId = OPERATOR_KEY_MAP[binding.toolId] ?? `OPERATOR_${binding.toolId.toUpperCase()}`
          bctx.operators.exec('OPERATOR_TOOL_SET', { toolId: opId })
        } else if (binding.action) {
          switch (binding.action) {
            case 'undo': bctx.operators.exec('OPERATOR_UNDO'); break
            case 'redo': bctx.operators.exec('OPERATOR_REDO'); break
            case 'toggle-tool': {
              const prev = bctx.toolRegistry.getPreviousEditToolId()
              if (prev) { bctx.toolRegistry.activate(prev, bctx) } else { bctx.toolRegistry.activate('OPERATOR_SELECT', bctx) }
              break
            }
            case 'toggle-toolshelf': break
            case 'toggle-properties': break
          }
        }
        return { break: true }
      }
      return { break: false }
    },
  }
}
