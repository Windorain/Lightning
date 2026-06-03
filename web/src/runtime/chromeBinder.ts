import type { Context } from '@/runtime/context'
import type { RegionEventHandler } from '@/events/handlerTypes'
import { isEditingTarget } from '@/util/browser'

const CHROME_REGION = 'r-chrome'

/**
 * 工作台壳层 DOM → wm.events（document keydown + 鼠标位置跟踪）。
 */
export function bindChromeDom(
  ctx: Context,
  keymap: RegionEventHandler,
): () => void {
  const ed = ctx.wm.events
  ed.registerRegion(CHROME_REGION)
  const unreg = ed.registerRegionHandler(CHROME_REGION, keymap)

  const onMouseMove = (e: MouseEvent): void => {
    if (ctx.wm.chrome.lastMousePosition) {
      ctx.wm.chrome.lastMousePosition.value = { x: e.clientX, y: e.clientY }
    }
    ed.setActiveRegion(CHROME_REGION)
  }

  const onKeydown = (e: KeyboardEvent): void => {
    if (isEditingTarget(e.target)) return
    ed.setActiveRegion(CHROME_REGION)
    ed.dispatch(e, { regionId: CHROME_REGION })
  }

  window.addEventListener('mousemove', onMouseMove)
  document.addEventListener('keydown', onKeydown, { capture: true })

  return () => {
    unreg()
    window.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('keydown', onKeydown, { capture: true })
    ed.unregisterRegion(CHROME_REGION)
  }
}

export { CHROME_REGION }
