/**
 * r-chrome 壳层快捷键（Shift+A 添加菜单等），不经视口 keymap。
 */
import type { RegionEventHandler } from '@/events/handlerTypes'
import { HANDLER_TYPE } from '@/events/handlerTypes'
import type { Context } from '@/runtime/context'
import { isEditingTarget } from '@/util/browser'

export function createChromeKeymapHandler(
  _regionId: string,
  getCtx: () => Context | null,
): RegionEventHandler {
  return {
    type: HANDLER_TYPE.KEYMAP,
    handle(event: Event): { break: boolean } {
      const ctx = getCtx()
      if (!ctx || event.type !== 'keydown') return { break: false }
      const e = event as KeyboardEvent
      if (isEditingTarget(e.target)) return { break: false }

      const chrome = ctx.wm.chrome
      if (chrome.contextMenuOpen?.value) {
        chrome.hideContextMenu?.()
        return { break: true }
      }

      if (e.key === 'a' && e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        const pos = chrome.lastMousePosition?.value ?? { x: 400, y: 300 }
        const items = chrome.contextMenuItems
        if (chrome.showContextMenu && items?.length) {
          chrome.showContextMenu(pos, items)
        }
        return { break: true }
      }

      return { break: false }
    },
  }
}
