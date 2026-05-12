/**
 * 交互事件分发器 — 对标 Blender 的 wm_event_do_handlers 事件链。
 *
 * 两层 dispatch：
 *   modalStack（模态操作栈，LIFO）→ regionHandlers（常规处理器，priority 升序）
 * 任一 handler 返回 { break: true } 即阻断后续 dispatch。
 * DOM capture phase 提供天然的"高于 OrbitControls"优先级。
 */
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

export interface EventHandler {
  priority: number
  handle(event: Event): { break: boolean }
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
  private _regionHandlers: EventHandler[] = []

  /** 进入模态操作。返回 pop 函数。 */
  pushModal(op: ModalOperation, event: PointerEvent): () => void {
    const keymap = op.onEnter(event)
    ;(op as any).__keymap = keymap ?? undefined
    this._modalStack.push(op)
    return () => this._popModal(false)
  }

  /** 在当前栈顶取消模态操作（cancelled=true → onExit 复位视觉状态） */
  cancelModal(): void {
    this._popModal(true)
  }

  /** 在当前栈顶提交模态操作（cancelled=false → onExit 仅释放资源） */
  commitModal(): void {
    this._popModal(false)
  }

  private _popModal(cancelled: boolean): void {
    const op = this._modalStack.pop()
    op?.onExit(cancelled)
  }

  /** 注册常规处理器。返回 unregister 函数。 */
  registerHandler(handler: EventHandler): () => void {
    this._regionHandlers.push(handler)
    this._regionHandlers.sort((a, b) => a.priority - b.priority)
    return () => {
      const idx = this._regionHandlers.indexOf(handler)
      if (idx >= 0) this._regionHandlers.splice(idx, 1)
    }
  }

  /** 主 dispatch */
  dispatch(event: Event): { break: boolean } {
    // 1. 模态键盘映射（栈顶 modal 优先）
    if (this._modalStack.length > 0) {
      const modal = this._modalStack[this._modalStack.length - 1]
      if (event instanceof KeyboardEvent) {
        // 每个 modal 的 onEnter 返回 keymap，存为 modal 属性
        const keymap = (modal as any).__keymap as ModalKeymap | undefined
        if (keymap) {
          const mapped = keymap.match(event)
          if (mapped) {
            // mapped is { type: 'MODAL_MAP', value: string } — not a real Event,
            // but ModalOperation.handleEvent accepts the synthetic shape via cast.
            modal.handleEvent(mapped as unknown as Event)
            return { break: true }
          }
        }
      }
    }

    // 2. 模态操作栈（LIFO: 栈顶最先处理）
    for (let i = this._modalStack.length - 1; i >= 0; i--) {
      const result = this._modalStack[i].handleEvent(event)
      if (result.break) return result
    }

    // 3. 常规处理器（priority 升序 = 数字小的先执行）
    for (const handler of this._regionHandlers) {
      const result = handler.handle(event)
      if (result.break) return result
    }

    return { break: false }
  }

  /** 获取 modal stack 深度（调试用） */
  get modalDepth(): number {
    return this._modalStack.length
  }
}

/** 全局单例 */
export const eventDispatcher = new EventDispatcherImpl()
