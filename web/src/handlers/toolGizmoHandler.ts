// web/src/handlers/toolGizmoHandler.ts
import type { RegionEventHandler } from '@/events/handlerTypes'
import { HANDLER_TYPE } from '@/events/handlerTypes'
import type { Context } from '@/runtime/context'

/**
 * Gizmo handler — reads **本 region** 的 gizmo 与其工具上下文（M4-1 双区归属）。
 * Routes pointermove/pointerdown/pointerup to that gizmo.
 * Does NOT consume events — keymap handler processes them next.
 *
 * ## 为什么按 region（而不是"全局最后 ready 的视口"）
 *
 * 旧实现读工具注册表上的两个**单例**（`activeGizmo` / `_toolCtx`）：分割出第二区后
 * 两个视口共用同一个 gizmo 实例与同一份上下文 ⇒ 在 B 区拖 gizmo 用的是 A 区的
 * 相机/选中集（S0 域 1 缺口 ④）。本 handler 天生知道自己是哪个 region
 * （`metadata`/监听都按 region 装），故直接问该 region 的那一份。
 */
export function createToolGizmoHandler(
  regionId: string,
  getCtx: () => Context | null,
): RegionEventHandler {
  return {
    type: HANDLER_TYPE.GIZMO,
    handle(event: Event): { break: boolean } {
      const appCtx = getCtx()
      if (!appCtx) return { break: false }

      const registry = appCtx.getToolRegistry()
      const gizmo = registry.gizmoFor(regionId)
      if (!gizmo) return { break: false }

      const toolCtx = registry.toolContextFor(regionId)
      if (!toolCtx) return { break: false }

      const pe = event as PointerEvent

      // Only left-click (button 0) triggers gizmo interaction.
      // Middle/right button reserved for view manipulation, context menu.
      if (pe.type === 'pointerdown' && pe.button !== 0) return { break: false }

      switch (event.type) {
        case 'pointermove':
          gizmo.onPointerMove?.(toolCtx, pe)
          break
        case 'pointerdown':
          gizmo.onPointerDown?.(toolCtx, pe)
          break
        case 'pointerup':
          gizmo.onPointerUp?.(toolCtx, pe)
          break
      }

      return { break: false }
    },
  }
}
