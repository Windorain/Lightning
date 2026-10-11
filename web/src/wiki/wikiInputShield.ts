/**
 * `wikiInputShield` —— **Wiki 宿主的输入事实边界**。
 *
 * ## 本模块退役了"组件/模块询问宿主名"（B5 退役矩阵 #7）
 *
 * 旧实现有**两处宿主判别**直接读模块级全局：
 *
 * ```ts
 * // 旧：wikiInputShield.ts
 * if (isWikiHostProfile()) { ... }                 // getFloatingUiTeleportTarget
 * export function shouldSkipWorkbenchDocumentKeydown(e) {
 *   if (!isWikiHostProfile()) return false          // 文档级 keydown 是否交给 wm.events
 * ```
 *
 * 这两件事的本质**不是"宿主叫什么"**，而是两个**宿主端口事实**：
 *  1. 宿主（Wiki 词条）是否在页面级接管了 `document` 的 keydown；
 *  2. 浮层 UI 应挂到哪个容器（Wiki 词条模板里是全屏时的 `fullscreenElement`，
 *     否则是工作台 app 元素，再否则是 `body`）。
 *
 * 于是现在它们由 `composition/shell.ts` 的 `PageKeyboardClaim` **端口实例**承载：
 * 端口存在 ⇔ 宿主接管。调用方拿的是端口对象，**不是**"当前宿主名"。
 *
 * ## 「外壳翻译事实」的落点（#249 §19.1）
 *
 * 本模块仍然做纯事实提取（`isEditingTarget`、DOM 包含关系、模态标志），
 * 但**不做领域决定**：`shouldSkipWorkbenchDocumentKeydown` 的返回值
 * 只描述"这一次事件该不该跳过"，快捷键**策略**仍在 `wm.events` 与
 * `handlers/keymapHandler` 里（#249 §19.1「不能在 Wiki 再叠一套领域快捷键策略」）。
 */

import { isEditingTarget } from '@/util/browser'
import type { PageKeyboardClaim } from '@/composition/shell'

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
 *
 * 原生全屏时须挂到 `fullscreenElement`，否则菜单会落在浏览器顶层下面，
 * 看起来像在词条模板上 —— 这条是**平台事实**，与宿主名无关，故优先级最高。
 *
 * 之后的判定经 `claim` 端口（旧实现是 `isWikiHostProfile()`）：
 * 只有**声明接管页面键盘**的宿主才提供 app 元素作用域。
 */
export function getFloatingUiTeleportTarget(claim: PageKeyboardClaim | null): HTMLElement | 'body' {
  const fs = document.fullscreenElement
  if (fs instanceof HTMLElement) return fs
  const scoped = claim?.floatingUiScope() ?? null
  if (scoped) {
    const shell = scoped.closest('.wsw-shell') as HTMLElement | null
    if (shell && isElementVisible(shell)) return shell
    return scoped
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
 * `document` 级 keydown 是否不应交给 `wm.events`。
 *
 * ## 参数是**端口**而不是"当前宿主名"
 *
 * `claim === null` ⇒ 没有任何宿主接管页面键盘 ⇒ 全部交给 `wm.events`（独立页面/嵌入）。
 * `claim.claimsDocumentKeyboard()` 为 true ⇒ 宿主（Wiki 词条）接管：
 * 输入框内编辑放行给浏览器默认行为；弹层打开时整段跳过；
 * 工作台 app 之外的事件不交给工作台（避免与宿主全局快捷键抢键）。
 *
 * ## 为什么不再读模块级全局
 *
 * 旧签名 `shouldSkipWorkbenchDocumentKeydown(event)` 内部 `isWikiHostProfile()`，
 * 于是"这个函数的行为"取决于**某个模块级 `let` 最后被谁写过** ——
 * 同一份输入在不同装配下的行为不可从调用点看出。
 * 现在它取决于**显式传入的端口**，调用方（`chromeBinder`/`viewportBinder`）
 * 从 `Context` 拿到它 —— 一个实例的输入行为只由该实例的装配决定。
 */
export function shouldSkipWorkbenchDocumentKeydown(event: KeyboardEvent, claim: PageKeyboardClaim | null): boolean {
  if (claim === null || !claim.claimsDocumentKeyboard()) return false
  if (isEditingTarget(event.target)) return true

  const modalOpen = isWikiModalOpenFlag()
  if (modalOpen) return true

  return !isNodeInsideWorkbenchApp(event.target)
}

/** 冒泡阶段截断，减少宿主对词条内工作台按键的二次处理。 */
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
