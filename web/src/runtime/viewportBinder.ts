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
    /**
     * **注销 region 系统**（B5 #10 的资源基线；P6 实测补）。
     *
     * 旧实现只移除 DOM 监听与 handler 链，`_regionSystems` 里那条 region
     * **永久留存** —— 于是"卸载后监听/作业回到基线"不成立：
     *  - `modalStack` 里的模态操作符不会被 `onExit`（`unregisterRegion` 才会调）；
     *  - `getActiveRegion()` 仍可能指向一个已死的 region，键盘路由继续把它当目标。
     *
     * 放在这里（而不是调用方）的理由：`registerRegion` 是本函数**自己**调的
     * （见上方），故注销也应由本函数对称负责 —— 让调用方配对是"少一次调用"的
     * 经典来源（本批实测：`attachViewport` 的 unbind 原先就漏了这一步）。
     */
    ed.unregisterRegion(regionId)
  }
}

/** 保证 handler 链按类型排序（HOVER 最先）。 */
export function sortHandlerChain(chain: RegionEventHandler[]): RegionEventHandler[] {
  const order = [HANDLER_TYPE.HOVER, HANDLER_TYPE.GIZMO, HANDLER_TYPE.KEYMAP]
  return [...chain].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))
}
