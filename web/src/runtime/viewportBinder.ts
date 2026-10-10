import type { Context } from '@/runtime/context'
import type { RegionEventHandler } from '@/events/handlerTypes'
import { HANDLER_TYPE } from '@/events/handlerTypes'
import { isEditingTarget } from '@/util/browser'
import { shouldSkipWorkbenchDocumentKeydown } from '@/wiki/wikiInputShield'
import { isEmbedTouchScreenPointer } from '@/embed/touchPointer'

export interface ViewportBinderHandlers {
  hover: RegionEventHandler
  gizmo?: RegionEventHandler
  keymap: RegionEventHandler
}

/**
 * 注册 region + DOM → wm.events.dispatch；handler 顺序 HOVER → GIZMO → KEYMAP。
 */
export function bindViewportDom(
  ctx: Context,
  regionId: string,
  domElement: HTMLElement,
  handlers: ViewportBinderHandlers,
  options?: { documentKeydown?: boolean; /** Embed：手指 + 触控笔走屏上手势 */ touchScreenGestures?: boolean },
): () => void {
  const screenPointer = (e: PointerEvent): boolean =>
    options?.touchScreenGestures
      ? isEmbedTouchScreenPointer(e)
      : e.pointerType === 'touch'
  const unsubs: Array<() => void> = []
  const ed = ctx.wm.events

  ed.registerRegion(regionId)

  const ordered = [
    handlers.hover,
    handlers.gizmo,
    handlers.keymap,
  ].filter((h): h is RegionEventHandler => !!h)

  for (const h of ordered) {
    unsubs.push(ed.registerRegionHandler(regionId, h))
  }

  const activate = (): void => {
    ctx.viewports.activeId.value = regionId
    ed.setActiveRegion(regionId)
  }

  domElement.style.touchAction = 'none'

  const onPointerDown = (e: PointerEvent): void => {
    activate()
    if (e.button === 1 || screenPointer(e)) e.preventDefault()
    ed.dispatch(e, { regionId })
  }
  const onPointerMove = (e: PointerEvent): void => {
    if (screenPointer(e) && e.buttons !== 0) e.preventDefault()
    ed.setActiveRegion(regionId)
    ed.dispatch(e, { regionId })
  }
  const onPointerUp = (e: PointerEvent): void => { void ed.dispatch(e, { regionId }) }
  const onWheel = (e: WheelEvent): void => {
    void ed.dispatch(e, { regionId })
    e.preventDefault()
  }
  const onContextMenu = (e: Event): void => e.preventDefault()

  domElement.addEventListener('pointerdown', onPointerDown, { capture: true })
  domElement.addEventListener('pointermove', onPointerMove, { capture: true })
  domElement.addEventListener('pointerup', onPointerUp, { capture: true })
  const onPointerLeave = (e: PointerEvent): void => {
    ed.setActiveRegion(regionId)
    ed.dispatch(e, { regionId })
  }
  domElement.addEventListener('pointerleave', onPointerLeave, { capture: true })
  domElement.addEventListener('wheel', onWheel, { capture: true, passive: false })
  domElement.addEventListener('contextmenu', onContextMenu, { capture: true })

  unsubs.push(() => {
    domElement.removeEventListener('pointerdown', onPointerDown, { capture: true })
    domElement.removeEventListener('pointermove', onPointerMove, { capture: true })
    domElement.removeEventListener('pointerup', onPointerUp, { capture: true })
    domElement.removeEventListener('pointerleave', onPointerLeave, { capture: true })
    domElement.removeEventListener('wheel', onWheel, { capture: true })
    domElement.removeEventListener('contextmenu', onContextMenu, { capture: true })
  })

  if (options?.documentKeydown !== false) {
    const onKeydown = (e: KeyboardEvent): void => {
      if (shouldSkipWorkbenchDocumentKeydown(e, ctx.pageKeyboard)) return
      if (isEditingTarget(e.target)) return
      ed.dispatch(e, { regionId })
    }
    document.addEventListener('keydown', onKeydown, { capture: true })
    unsubs.push(() => document.removeEventListener('keydown', onKeydown, { capture: true }))
  }

  return () => {
    for (const u of unsubs) u()
    // P6 实测：**不**在此 `ed.unregisterRegion(regionId)`。
    //
    // 本 unbind 会被"重挂前的 detach"调用一次
    // （`HostBase.attachViewport` → `detachViewport` → `attachViewport`），
    // 而 `unregisterRegion` 会**清掉整条 region 系统**（含 `modalStack` 的
    // `onExit` 与 handler 链），于是同一视口重挂时会丢掉前一次建立的
    // region 状态 —— 与槽位归零同一个坑（`multiblock-channel-traversal`
    // "尺寸变化方向" 20s 收敛超时即由此暴露）。
    //
    // `registerRegion` 是幂等的（`if (!this._regionSystems.has(...))`），
    // 故保留 region 系统不会泄漏条目：同一 region 反复重挂只注册一次。
    // 真正的注销点在组件卸载（`WorkbenchViewport.onBeforeUnmount` →
    // `ctx.viewports.unregister` 之外，由该文件按需显式调 `unregisterRegion`）。
  }
}

/** 保证 handler 链按类型排序（HOVER 最先）。 */
export function sortHandlerChain(chain: RegionEventHandler[]): RegionEventHandler[] {
  const order = [HANDLER_TYPE.HOVER, HANDLER_TYPE.GIZMO, HANDLER_TYPE.KEYMAP]
  return [...chain].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))
}
