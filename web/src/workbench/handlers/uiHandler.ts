/**
 * UI handler — 对标 Blender 的 eWM_EventHandlerType UI。
 *
 * 检查 pointer 事件坐标是否命中 widget 缓存中的 operator 按钮，
 * 若命中则执行对应 operator 并阻断事件传播。
 * 在生产环境中 Vue 的 @click 已处理按钮事件，本 handler 主要服务于测试环境。
 */
import type { TypedEventHandler } from '@/workbench/events/eventTypes'
import { HANDLER_TYPE } from '@/workbench/events/eventTypes'
import type { BContext } from '@/workbench/context/bContext'
import { widgetAt } from '@/workbench/ux/layout/engine'

export function createUIHandler(
  getBctx: () => BContext | null,
): TypedEventHandler {
  return {
    type: HANDLER_TYPE.UI,

    handle(event: Event): { break: boolean } {
      const bctx = getBctx()
      if (!bctx) return { break: false }

      if (event.type !== 'pointerdown') return { break: false }
      const pe = event as PointerEvent
      if (pe.button !== 0) return { break: false }

      const hit = widgetAt(pe.clientX, pe.clientY)
      if (hit?.operatorId) {
        bctx.operators.exec(hit.operatorId)
        return { break: true }
      }

      return { break: false }
    },
  }
}
