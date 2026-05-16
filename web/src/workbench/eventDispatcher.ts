/**
 * 交互事件分发器 — 对标 Blender 的 wm_event_do_handlers 事件链。
 *
 * 两层 dispatch：
 *   modalStack（模态操作栈，LIFO）→ typedHandlers（按 type 排序）
 * 任一 handler 返回 { break: true } 即阻断后续 dispatch。
 *
 * Handler 类型顺序：GIZMO(0) → OPERATOR(1) → KEYMAP(2) → VIEW(3)
 */
import type { TypedEventHandler } from '@/workbench/events/eventTypes'
import { logCenter } from '@/workbench/logging/LogCenter'

export interface ModalKeymapItem {
  key: string
  ctrl?: boolean
  shift?: boolean
  value: string
}

export interface ModalKeymap {
  items: ModalKeymapItem[]
  match(event: KeyboardEvent): { type: 'MODAL_MAP'; value: string } | null
}

export interface ModalOperation {
  id: string
  onEnter(event: PointerEvent): ModalKeymap | null
  handleEvent(event: Event): { break: boolean }
  onExit(cancelled: boolean): void
}

/** 创建标准 ModalKeymap */
export function createModalKeymap(items: ModalKeymapItem[]): ModalKeymap {
  return {
    items,
    match(event: KeyboardEvent): { type: 'MODAL_MAP'; value: string } | null {
      if (event.type !== 'keydown' && event.type !== 'keyup') return null
      for (const item of items) {
        if (event.key.toLowerCase() !== item.key.toLowerCase()) continue
        if ((item.ctrl ?? false) !== (event.ctrlKey || event.metaKey)) continue
        if ((item.shift ?? false) !== event.shiftKey) continue
        return { type: 'MODAL_MAP', value: item.value }
      }
      return null
    },
  }
}

class EventDispatcherImpl {
  private _modalStack: ModalOperation[] = []
  private _typedHandlers: TypedEventHandler[] = []

  /** 进入模态操作。返回 pop 函数。 */
  pushModal(op: ModalOperation, event: PointerEvent): () => void {
    const keymap = op.onEnter(event)
    ;(op as any).__keymap = keymap ?? undefined
    this._modalStack.push(op)
    return () => this._popModal(false)
  }

  /** 在当前栈顶取消模态操作 */
  cancelModal(): void {
    this._popModal(true)
  }

  /** 在当前栈顶提交模态操作 */
  commitModal(): void {
    this._popModal(false)
  }

  private _popModal(cancelled: boolean): void {
    const op = this._modalStack.pop()
    op?.onExit(cancelled)
  }

  /** 注册类型化处理器。按 type 排序（同 type 保持注册顺序）。 */
  registerTypedHandler(handler: TypedEventHandler): () => void {
    this._typedHandlers.push(handler)
    this._typedHandlers.sort((a, b) => a.type - b.type)
    return () => {
      const idx = this._typedHandlers.indexOf(handler)
      if (idx >= 0) this._typedHandlers.splice(idx, 1)
    }
  }

  /** 主 dispatch */
  dispatch(event: Event): { break: boolean; traceId?: string } {
    const traceId = logCenter.beginTrace('EventDispatcher', event)
    // 1. 模态键盘映射（栈顶 modal 优先）
    if (this._modalStack.length > 0) {
      const modal = this._modalStack[this._modalStack.length - 1]
      if (event instanceof KeyboardEvent) {
        const keymap = (modal as any).__keymap as ModalKeymap | undefined
        if (keymap) {
          const mapped = keymap.match(event)
          if (mapped) {
            modal.handleEvent(mapped as unknown as Event)
            return { break: true }
          }
        }
      }
    }

    // 2. 模态操作栈（LIFO）
    for (let i = this._modalStack.length - 1; i >= 0; i--) {
      const modal = this._modalStack[i]
      if (!modal) continue
      const result = modal.handleEvent(event)
      if (result.break) {
        logCenter.endTrace(`consumed by modal ${modal.id}`)
        return { break: true, traceId }
      }
    }

    // 3. 类型化处理器（GIZMO → OPERATOR → KEYMAP → VIEW）
    for (const handler of this._typedHandlers) {
      const result = handler.handle(event)
      if (result.break) {
        logCenter.endTrace(`consumed by typedHandler type=${handler.type}`)
        return { break: true, traceId }
      }
    }

    logCenter.endTrace('unhandled')
    return { break: false, traceId }
  }

  get modalDepth(): number {
    return this._modalStack.length
  }
}

/** 全局单例 */
export const eventDispatcher = new EventDispatcherImpl()
