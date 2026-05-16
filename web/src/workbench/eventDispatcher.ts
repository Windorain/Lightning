/**
 * EventDispatcher — 对标 Blender 的 wm_event_do_handlers 事件链。
 *
 * 架构（per-region）：
 *
 *   dispatch(event)
 *     → 1. 区域模态栈 (LIFO)
 *     → 2. 区域 Handler 链：GIZMO → KEYMAP
 *
 * Canvas 事件通过坐标路由到光标所在 region。
 * 键盘事件路由到最后鼠标所在的 region（activeRegion）。
 */
import type { RegionEventHandler } from '@/workbench/events/handlerTypes'
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

interface RegionEventSystem {
  modalStack: ModalOperation[]
  handlerChain: RegionEventHandler[]
}

class EventDispatcherImpl {
  private _regionSystems = new Map<string, RegionEventSystem>()
  /** 最后鼠标所在的 region（键盘事件路由目标） */
  private _activeRegionId: string | null = null
  /** 当前 dispatch 的目标 region（操作符上下文） */
  private _currentRegionId: string | null = null

  // ---- Region 生命周期 ----

  registerRegion(regionId: string): void {
    if (!this._regionSystems.has(regionId)) {
      this._regionSystems.set(regionId, { modalStack: [], handlerChain: [] })
    }
  }

  unregisterRegion(regionId: string): void {
    this._regionSystems.delete(regionId)
    if (this._activeRegionId === regionId) this._activeRegionId = null
    if (this._currentRegionId === regionId) this._currentRegionId = null
  }

  // ---- 活动区域（键盘事件路由用） ----

  setActiveRegion(regionId: string): void {
    this._activeRegionId = regionId
  }

  getActiveRegion(): string | null {
    return this._activeRegionId
  }

  getCurrentRegionId(): string | null {
    return this._currentRegionId
  }

  // ---- Handler 链 ----

  /** 向指定 region 的 handler 链末尾追加 handler。返回 unregister 函数。 */
  registerRegionHandler(
    regionId: string,
    handler: RegionEventHandler,
  ): () => void {
    const system = this._regionSystems.get(regionId)
    if (!system) {
      console.warn(`[EventDispatcher] region not found: ${regionId}`)
      return () => {}
    }
    system.handlerChain.push(handler)
    return () => {
      const idx = system.handlerChain.indexOf(handler)
      if (idx >= 0) system.handlerChain.splice(idx, 1)
    }
  }

  // ---- 模态栈 ----

  /** 向指定 region 的模态栈推入操作 */
  pushModal(regionId: string, op: ModalOperation, event: PointerEvent): void {
    const system = this._regionSystems.get(regionId)
    if (!system) {
      console.warn(`[EventDispatcher] pushModal: region not found ${regionId}`)
      return
    }
    const keymap = op.onEnter(event)
    ;(op as any).__keymap = keymap ?? undefined
    system.modalStack.push(op)
  }

  cancelModal(regionId: string): void {
    this._popModal(regionId, true)
  }

  commitModal(regionId: string): void {
    this._popModal(regionId, false)
  }

  private _popModal(regionId: string, cancelled: boolean): void {
    const system = this._regionSystems.get(regionId)
    if (!system || system.modalStack.length === 0) return
    const op = system.modalStack.pop()
    op?.onExit(cancelled)
  }

  modalDepth(regionId: string): number {
    return this._regionSystems.get(regionId)?.modalStack.length ?? 0
  }

  // ---- 主 dispatch ----

  /**
   * 分发事件。
   * PointerEvent 需要 options.regionId 显式指定区域。
   * KeyboardEvent 使用 activeRegion（最后鼠标所在区域）。
   */
  dispatch(event: Event, options?: { regionId?: string }): { break: boolean; traceId?: string } {
    // 确定目标区域
    let targetRegionId = options?.regionId ?? null
    if (!targetRegionId && event instanceof KeyboardEvent) {
      targetRegionId = this._activeRegionId
    }
    if (!targetRegionId) return { break: false }

    this._currentRegionId = targetRegionId
    const traceId = logCenter.beginTrace('EventDispatcher', event)
    const system = this._regionSystems.get(targetRegionId)
    if (!system) {
      logCenter.endTrace(`region not found: ${targetRegionId}`)
      return { break: false, traceId }
    }

    // 1. 模态栈（LIFO）
    if (system.modalStack.length > 0) {
      // 栈顶 modal 的键盘映射优先
      if (event instanceof KeyboardEvent) {
        const topModal = system.modalStack[system.modalStack.length - 1]
        const keymap = (topModal as any).__keymap as ModalKeymap | undefined
        if (keymap) {
          const mapped = keymap.match(event)
          if (mapped) {
            topModal.handleEvent(mapped as unknown as Event)
            logCenter.endTrace(`consumed by modal keymap ${topModal.id}`)
            return { break: true, traceId }
          }
        }
      }

      // 从顶到底逐级分发
      for (let i = system.modalStack.length - 1; i >= 0; i--) {
        const modal = system.modalStack[i]
        const result = modal.handleEvent(event)
        if (result.break) {
          logCenter.endTrace(`consumed by modal ${modal.id}`)
          return { break: true, traceId }
        }
      }
    }

    // 2. Region handler 链（GIZMO → KEYMAP）
    for (const handler of system.handlerChain) {
      const result = handler.handle(event)
      if (result.break) {
        logCenter.endTrace(`consumed by handler type=${handler.type}`)
        return { break: true, traceId }
      }
    }

    logCenter.endTrace('unhandled')
    return { break: false, traceId }
  }
}

/** 全局单例 */
export const eventDispatcher = new EventDispatcherImpl()
