/**
 * Viewport navigation handler — 对标 Blender 的 VIEW 层 handler。
 *
 * 兜底处理未在 GIZMO/UI/OPERATOR/KEYMAP 层被消费的输入事件：
 * - 滚轮 → 缩放
 * - MMB → 旋转 / 平移 / 缩放
 * - LMB 空白拖拽 → 旋转（手势判别，越过阈值后启动）
 *
 * 不修改工具状态，不干涉 active tool dispatch。
 */
import type { TypedEventHandler } from '@/workbench/events/eventTypes'
import { HANDLER_TYPE } from '@/workbench/events/eventTypes'
import type { BContext } from '@/workbench/context/bContext'

interface PendingDrag {
  startX: number
  startY: number
  pointerId: number
  active: boolean
}

export function createViewNavigationHandler(
  getBctx: () => BContext | null,
): TypedEventHandler {
  const drag: PendingDrag = { startX: 0, startY: 0, pointerId: -1, active: false }

  return {
    type: HANDLER_TYPE.VIEW,
    handle(event: Event): { break: boolean } {
      const bctx = getBctx()
      if (!bctx) return { break: false }

      // 滚轮 → 缩放（立即执行，不进入模态）
      if (event.type === 'wheel') {
        if (bctx.viewport.camera.value) {
          bctx.operators.invoke('OPERATOR_VIEW_ZOOM', undefined, event as any)
        }
        return { break: false }
      }

      const pe = event as PointerEvent

      // MMB → 视口导航（旋转/平移/缩放）
      if (pe.button === 1) {
        if (event.type === 'pointerdown') {
          if (pe.ctrlKey || pe.metaKey) {
            bctx.operators.invoke('OPERATOR_VIEW_ZOOM', undefined, pe)
          } else if (pe.shiftKey) {
            bctx.operators.invoke('OPERATOR_VIEW_PAN', undefined, pe)
          } else {
            bctx.operators.invoke('OPERATOR_VIEW_ROTATE', undefined, pe)
          }
        }
        return { break: false }
      }

      // LMB — 手势判别：记录按下位置，拖拽越过阈值后启动视口旋转
      // pointermove 事件中 pe.button === -1，不用 button 判断，只依赖 drag state
      if (pe.button === 0 && event.type === 'pointerdown') {
        drag.startX = pe.clientX
        drag.startY = pe.clientY
        drag.pointerId = pe.pointerId
        drag.active = true
        return { break: false }
      }

      if (event.type === 'pointermove' && drag.active) {
        const dx = pe.clientX - drag.startX
        const dy = pe.clientY - drag.startY
        if (dx * dx + dy * dy > 25) {
          drag.active = false
          bctx.operators.invoke('OPERATOR_VIEW_ROTATE', undefined, pe)
        }
        return { break: false }
      }

      if ((event.type === 'pointerup' || event.type === 'pointercancel') && drag.active) {
        drag.active = false
        return { break: false }
      }

      return { break: false }
    },
  }
}
