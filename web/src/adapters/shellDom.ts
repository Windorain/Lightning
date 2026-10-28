/**
 * `adapters/shellDom` —— **外壳 DOM 事实与平台边界**（适配器实现端口）。
 *
 * ## 本模块的来源（输入面退役的搬出部分）
 *
 * 原 `wiki/wikiInputShield.ts` 把**两类完全不同的东西**放在一个文件里：
 *
 * | 类别 | 原函数 | 归宿 |
 * |---|---|---|
 * | **输入路由政策** | `shouldSkipWorkbenchDocumentKeydown`、`setWikiModalOpen`、`isWikiModalOpenFlag`、`bindWikiModalEscape`、`isNodeInsideWikiModal` | **删除** ⇒ 迁入 `domain/input` 的纯路由（既有退役条目） |
 * | **外壳 DOM 事实** | `getWorkbenchAppElement`、`getFloatingUiTeleportTarget`、`isNodeInsideWorkbenchApp`、`bindWikiWorkbenchKeyBubble` | **本模块**（改名以反映真实职责） |
 *
 * ## 三处"跳过"为何**结构性**消失（而不是换个地方写同样三个 if）
 *
 * 被删的 `shouldSkipWorkbenchDocumentKeydown` 做三件事，它们各自有了结构性的归宿：
 *
 * | 原判定 | 新归宿 |
 * |---|---|
 * | `isEditingTarget(event.target)` ⇒ 跳过 | 事实进 `KeyFact.targetEditable`，纯路由判为 `text` 层 —— **编辑框内按 `g` 不会启动工具**（e2e） |
 * | `isWikiModalOpenFlag()` ⇒ 整段跳过 | 显式 `ModalScopeState` 栈 —— 优先级的第一级（e2e） |
 * | `!isNodeInsideWorkbenchApp(target)` ⇒ 不交给工作台 | `hitTest` 对未标注 region 的目标返回 `null` ⇒ `level: 'none'`、无意图 —— 归属由 **Area 标注事实**决定（非"猜宿主"） |
 *
 * 这正是「语义层不读 `document.activeElement`」「由**显式状态**决定接收者」的落点。
 *
 * ## 宿主差异是**端口**，不是"宿主名"（保留既有退役成果）
 *
 * 已把"询问宿主名"（`isWikiHostProfile()`）退役为
 * `composition/shell.ts` 的 `PageKeyboardClaim` **端口实例**：
 * 端口存在 ⇔ 宿主在页面级接管 `document` 键盘。
 *
 * **必须保留**这个形状 —— 若改回 `isWikiHost: boolean` 入参，
 * 就把刚退役的"按宿主名分叉"重新引回来了（同一份输入在不同装配下的行为
 * 不可从调用点看出）。故本模块一律吃 `PageKeyboardClaim | null` 端口，
 * **不**吃宿主名。
 *
 * 这也让 `claimsDocumentKeyboard()` 有了真实消费者：它决定是否安装**冒泡截断**
 * （宿主页也会解释按键，故工作台子树必须 `stopPropagation`，否则同一按键被两家各处理一次）。
 */

import type { PageKeyboardClaim } from '@/composition/shell'

/** 工作台根元素的 id（Wiki 宿主模板里的挂载点）。 */
export const WORKBENCH_APP_ID = 'wsr-workbench-app'

/** 取工作台根元素（**事实查询**）。 */
export function getWorkbenchAppElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return document.getElementById(WORKBENCH_APP_ID)
}

/** 元素是否**可见**（`display:none` / `visibility:hidden` / 已脱离文档都算不可见）。 */
function isElementVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false
  const st = getComputedStyle(el)
  return st.display !== 'none' && st.visibility !== 'hidden'
}

/**
 * 浮层 UI（上下文菜单等）的 Teleport 目标。
 *
 * 原生全屏时须挂到 `fullscreenElement`，否则菜单会落在浏览器顶层下面，
 * 看起来像在词条模板上 —— 这条是**平台事实**，与宿主无关，故优先级最高。
 *
 * 之后的判定经 `claim` 端口（旧实现是 `isWikiHostProfile()`）：
 * 只有**声明接管页面键盘**的宿主才提供 app 元素作用域。
 */
export function getFloatingUiTeleportTarget(claim: PageKeyboardClaim | null): HTMLElement | 'body' {
  if (typeof document === 'undefined') return 'body'
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

/** 该事件目标是否在工作台外壳内（**事实**；供诊断与宿主隔离判定）。 */
export function isNodeInsideWorkbenchApp(target: EventTarget | null): boolean {
  if (typeof Node === 'undefined' || !(target instanceof Node)) return false
  const app = getWorkbenchAppElement()
  return !!app?.contains(target)
}

/**
 * 在"宿主接管页面键盘"时阻止工作台子树内的按键继续冒泡（**平台同步动作**）。
 *
 * ## 为什么这是 `claimsDocumentKeyboard()` 的正确消费者
 *
 * 宿主（Wiki 词条页）自己也会处理 `document` 上的按键。若工作台子树内的按键继续冒泡，
 * 同一按键会被两家各解释一次 —— 这正是要退役的"抢键"形态。
 * 冒泡截断把边界划清：**工作台子树内的按键归工作台**，宿主只处理子树外的。
 *
 * 它**不判定接收者**（不读 `key`、不选命令、不 `preventDefault`），
 * 故与"唯一挂载点"不冲突：归属仍只由 `adapters/inputBinding` 那一条决定
 * （架构闸门的"冒泡边界型监听"判据可执行地保证这一点）。
 */
export function bindWorkbenchKeyBubbleOnWikiHost(
  root: HTMLElement,
  claim: PageKeyboardClaim | null,
): () => void {
  if (!(claim?.claimsDocumentKeyboard() ?? false)) return () => {}
  const onKeydown = (event: KeyboardEvent): void => {
    event.stopPropagation()
  }
  root.addEventListener('keydown', onKeydown, false)
  return () => root.removeEventListener('keydown', onKeydown, false)
}
