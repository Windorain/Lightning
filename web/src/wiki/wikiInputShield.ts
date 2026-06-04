import { isWikiHostProfile } from '@/runtime/hostProfile'
import { isEditingTarget } from '@/util/browser'

const WORKBENCH_APP_ID = 'wsr-workbench-app'
const WIKI_MODAL_BACKDROP = '.wiki-modal-backdrop'

export function getWorkbenchAppElement(): HTMLElement | null {
  return document.getElementById(WORKBENCH_APP_ID)
}

function isElementVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false
  const st = getComputedStyle(el)
  return st.display !== 'none' && st.visibility !== 'hidden'
}

/**
 * 浮层 UI（上下文菜单等）的 Teleport 目标。
 * 原生全屏时须挂到 fullscreenElement，否则菜单会落在浏览器顶层下面，看起来像在词条模板上。
 */
export function getFloatingUiTeleportTarget(): HTMLElement | 'body' {
  const fs = document.fullscreenElement
  if (fs instanceof HTMLElement) return fs

  if (isWikiHostProfile()) {
    const app = getWorkbenchAppElement()
    if (app) {
      const shell = app.closest('.wsw-shell') as HTMLElement | null
      if (shell && isElementVisible(shell)) return shell
      return app
    }
  }
  return 'body'
}

export function isNodeInsideWorkbenchApp(target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false
  const app = getWorkbenchAppElement()
  return !!app?.contains(target)
}

export function isNodeInsideWikiModal(target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false
  const backdrop = document.querySelector(WIKI_MODAL_BACKDROP)
  return !!backdrop?.contains(target)
}

/** Wiki 弹层是否打开（由 WikiModalsHost 写入） */
let wikiModalOpen = false

export function setWikiModalOpen(open: boolean): void {
  wikiModalOpen = open
}

export function isWikiModalOpenFlag(): boolean {
  return wikiModalOpen || !!document.querySelector(WIKI_MODAL_BACKDROP)
}

/**
 * document 级 keydown 是否不应交给 wm.events（避免与灰机全局快捷键抢键）。
 * 返回 true = 跳过 dispatch；输入框内编辑仍放行给浏览器默认行为。
 */
export function shouldSkipWorkbenchDocumentKeydown(event: KeyboardEvent): boolean {
  if (!isWikiHostProfile()) return false
  if (isEditingTarget(event.target)) return true

  const modalOpen = isWikiModalOpenFlag()
  if (modalOpen) {
    if (event.key === 'Escape') return true
    if (isNodeInsideWikiModal(event.target)) return true
    return true
  }

  return !isNodeInsideWorkbenchApp(event.target)
}

/** 冒泡阶段截断，减少灰机对词条内工作台按键的二次处理 */
export function bindWikiWorkbenchKeyBubble(root: HTMLElement): () => void {
  const onKeydown = (event: KeyboardEvent): void => {
    event.stopPropagation()
  }
  root.addEventListener('keydown', onKeydown, false)
  return () => root.removeEventListener('keydown', onKeydown, false)
}

export function bindWikiModalEscape(onEscape: () => void): () => void {
  const onKeydown = (event: KeyboardEvent): void => {
    if (!isWikiModalOpenFlag()) return
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopImmediatePropagation()
    onEscape()
  }
  window.addEventListener('keydown', onKeydown, { capture: true })
  return () => window.removeEventListener('keydown', onKeydown, { capture: true })
}
