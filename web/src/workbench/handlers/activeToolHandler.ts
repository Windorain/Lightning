/**
 * Active tool handler — 只处理 LMB → active tool operator 路由。
 *
 * 不处理视口导航（MMB/滚轮/LMB 空白拖拽），这些由 VIEW handler 兜底。
 * 仅将 LMB pointerdown 事件转给当前活跃工具的操作符，
 * 不检查返回值（工具自行决定进入模态或即时完成）。
 */
import type { TypedEventHandler } from '@/workbench/events/eventTypes'
import { HANDLER_TYPE } from '@/workbench/events/eventTypes'
import type { BContext } from '@/workbench/context/bContext'

export function createActiveToolHandler(
  getBctx: () => BContext | null,
): TypedEventHandler {
  return {
    type: HANDLER_TYPE.OPERATOR,
    handle(event: Event): { break: boolean } {
      const bctx = getBctx()
      if (!bctx) return { break: false }

      const pe = event as PointerEvent

      // 只处理 LMB pointerdown
      if (pe.button !== 0) return { break: false }
      if (event.type !== 'pointerdown') return { break: false }

      const activeId = bctx.toolRegistry.activeTool.value?.id
      if (activeId) {
        bctx.operators.invoke(activeId, undefined, pe)
      }

      return { break: false }
    },
  }
}
