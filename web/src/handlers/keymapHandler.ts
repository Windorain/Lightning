/**
 * Keymap handler — 对标 Blender 的 WM_HANDLER_TYPE_KEYMAP。
 *
 * 职责：
 * 1. 将输入事件与 keymap 绑定匹配 → invoke 对应操作符
 * 2. operator FINISHED 后的拖拽手势检测 → 越过阈值 → invoke ViewRotate
 */
import type { RegionEventHandler } from '@/events/handlerTypes'
import { HANDLER_TYPE } from '@/events/handlerTypes'
import type { Context } from '@/runtime/context'
import { matchBinding, resolveRegionBaseKeymap, type InputBinding } from '@/keymap'
import { OP_RESULT } from '@/operators/operatorType'

interface DragState {
  active: boolean
  startX: number
  startY: number
}

export function createKeymapHandler(
  regionId: string,
  getCtx: () => Context | null,
): RegionEventHandler {
  const drag: DragState = { active: false, startX: 0, startY: 0 }

  return {
    type: HANDLER_TYPE.KEYMAP,
    handle(event: Event): { break: boolean } {
      const ctx = getCtx()
      if (!ctx) return { break: false }

      // --- Build effective keymap ---
      const tool = ctx.isEmbed() ? null : ctx.getToolRegistry().activeTool.value
      const defaultKeymap = resolveRegionBaseKeymap(ctx.region(regionId)?.keymapId)
      const toolBindings = tool?.keymap ?? []
      const fallbackBindings = tool?.keymapFallback ?? []

      // Default bindings that aren't overridden by tool bindings
      const filteredDefault = defaultKeymap.filter(
        b => !isOverridden(b, toolBindings, fallbackBindings)
      )
      const effectiveKeymap = [...toolBindings, ...fallbackBindings, ...filteredDefault]

      // ---- Dragging state consumes pointermove/pointerup ----
      if (drag.active) {
        if (event.type === 'pointerdown') {
          // New press → clear drag state and let keymap matching handle it
          drag.active = false
        } else if (event.type === 'pointermove') {
          const pe = event as PointerEvent
          const dx = pe.clientX - drag.startX
          const dy = pe.clientY - drag.startY
          if (dx * dx + dy * dy > 25) {
            drag.active = false
            ctx.getOperators().invoke('OPERATOR_VIEW_ROTATE', undefined, event, regionId)
          }
          return { break: false }
        } else if (event.type === 'pointerup' || event.type === 'pointercancel') {
          drag.active = false
          return { break: false }
        } else {
          return { break: false }
        }
      }

      // --- Match effective keymap bindings ---
      for (const binding of effectiveKeymap) {
        if (!matchBinding(binding, event)) continue

        // KEY binding
        if (binding.type === 'KEY') {
          // toolId activates a tool
          if (binding.toolId) {
            ctx.getToolRegistry().activate(binding.toolId)
            return { break: true }
          }
          // opId invokes an operator (with tool properties merged)
          if (binding.opId) {
            const toolProps = tool?.properties ?? {}
            const itemProps = binding.props ?? {}
            const mergedProps = { ...toolProps, ...itemProps }
            ctx.getOperators().invoke(binding.opId, mergedProps, event, regionId)
            return { break: true }
          }
          if (binding.action) {
            switch (binding.action) {
              case 'undo': ctx.getOperators().exec('OPERATOR_UNDO'); break
              case 'redo': ctx.getOperators().exec('OPERATOR_REDO'); break
              case 'toggle-tool': {
                const prev = ctx.getToolRegistry().lastToolId.value
                if (prev) ctx.getToolRegistry().activate(prev)
                else ctx.getToolRegistry().activate('select')
                break
              }
              case 'select-all': ctx.getOperators().exec('OPERATOR_SELECT_ALL'); break
              case 'toggle-toolshelf': {
                // existing toggle-toolshelf logic if any
                break
              }
              case 'toggle-properties': {
                // existing toggle-properties logic if any
                break
              }
            }
          }
          return { break: true }
        }

        // MOUSE binding
        if (binding.type === 'MOUSE') {
          if (binding.action === 'context-menu') {
            const chrome = ctx.wm.chrome
            const pe = event as PointerEvent
            if (chrome.showContextMenu) {
              const items = chrome.contextMenuItems ?? []
              chrome.showContextMenu({ x: pe.clientX, y: pe.clientY }, items)
            }
            return { break: true }
          }

          if (binding.opId) {
            const toolProps = tool?.properties ?? {}
            const itemProps = binding.props ?? {}
            const mergedProps = { ...toolProps, ...itemProps }

            const result = ctx.getOperators().invoke(binding.opId, mergedProps, event, regionId)
            if (ctx.isEmbed()) return { break: true }
            if (result === OP_RESULT.FINISHED) {
              const hasGizmo = !ctx.isEmbed() && ctx.getToolRegistry().activeGizmo.value !== null
              if (!hasGizmo) {
                const pe = event as PointerEvent
                drag.active = true
                drag.startX = pe.clientX
                drag.startY = pe.clientY
              }
            }
          }
          return { break: false }
        }

        // WHEEL binding
        if (binding.type === 'WHEEL') {
          ctx.getOperators().invoke(binding.opId!, undefined, event, regionId)
          return { break: false }
        }

        return { break: false }
      }

      return { break: false }
    },
  }
}

/** Check if a default binding is overridden by tool or fallback bindings */
function isOverridden(
  binding: InputBinding,
  toolKeymap: InputBinding[],
  fallbackKeymap: InputBinding[],
): boolean {
  const allOverrides = [...toolKeymap, ...fallbackKeymap]
  return allOverrides.some(b => sameTrigger(b, binding))
}

/** Two bindings match on the same trigger (would conflict) */
function sameTrigger(a: InputBinding, b: InputBinding): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'KEY' && b.type === 'KEY') {
    return a.key.toLowerCase() === b.key.toLowerCase()
      && (a.ctrl ?? false) === (b.ctrl ?? false)
      && (a.shift ?? false) === (b.shift ?? false)
  }
  if (a.type === 'MOUSE' && b.type === 'MOUSE') {
    return a.button === b.button
      && (a.ctrl ?? false) === (b.ctrl ?? false)
      && (a.shift ?? false) === (b.shift ?? false)
  }
  if (a.type === 'WHEEL' && b.type === 'WHEEL') {
    return a.direction === b.direction
      && (a.ctrl ?? false) === (b.ctrl ?? false)
      && (a.shift ?? false) === (b.shift ?? false)
  }
  return false
}
