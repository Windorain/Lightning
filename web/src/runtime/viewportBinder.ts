import type { Context } from '@/runtime/context'
import type { RegionEventHandler } from '@/events/handlerTypes'
import { HANDLER_TYPE } from '@/events/handlerTypes'
import { isEditingTarget } from '@/util/browser'

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
  options?: { documentKeydown?: boolean },
): () => void {
  const unsubs: Array<() => void> = []
  const ed = ctx.eventDispatcher

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

  const onPointerDown = (e: PointerEvent): void => {
    activate()
    if (e.button === 1) e.preventDefault()
    ed.dispatch(e, { regionId })
  }
  const onPointerMove = (e: PointerEvent): void => {
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
      if (isEditingTarget(e.target)) return
      ed.dispatch(e, { regionId })
    }
    document.addEventListener('keydown', onKeydown, { capture: true })
    unsubs.push(() => document.removeEventListener('keydown', onKeydown, { capture: true }))
  }

  return () => {
    for (const u of unsubs) u()
  }
}

/** 保证 handler 链按类型排序（HOVER 最先）。 */
export function sortHandlerChain(chain: RegionEventHandler[]): RegionEventHandler[] {
  const order = [HANDLER_TYPE.HOVER, HANDLER_TYPE.GIZMO, HANDLER_TYPE.KEYMAP]
  return [...chain].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))
}
