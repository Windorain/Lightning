import type { Context } from '@/runtime/context'
import type { RegionEventHandler } from '@/events/handlerTypes'

import { REGION } from '@/runtime/regionIds'

const CHROME_REGION = REGION.CHROME

/**
 * 工作台壳层 DOM → wm.events（**鼠标位置跟踪**）。
 *
 * ## 输入面的删除记录
 *
 * **已删除**（本文件原样保留下来的只有鼠标位置事实）：
 *
 * ```ts
 * // 删除前：
 * import { shouldSkipWorkbenchDocumentKeydown } from '@/wiki/wikiInputShield'
 * import { isEditingTarget } from '@/util/browser'
 * document.addEventListener('keydown', (e) => {
 *   if (shouldSkipWorkbenchDocumentKeydown(e)) return   // ← 全局 wikiModalOpen 布尔 + 目标猜测
 *   if (isEditingTarget(e.target)) return               // ← 语义层读 DOM 事实
 *   ed.setActiveRegion(CHROME_REGION)
 *   ed.dispatch(e, { regionId: CHROME_REGION })          // ← 第二条 document keydown
 * }, { capture: true })
 * ```
 *
 * 这段代码有三处正是要退役的形态：
 *  1. **两条 document 级 capture keydown**（本文件 + `viewportBinder`）各判一次同一按键；
 *  2. "跳过与否"由模块级 `let wikiModalOpen` 全局布尔决定 —— 没有作用域、没有层级；
 *  3. `isEditingTarget(e.target)` 在**语义层**读 DOM 事实回答"焦点在不在输入框里"。
 *
 * 取代它的是**一条**挂载点：`createInputBinding`（`adapters/inputBinding`）→
 * `createInputSession`（`runtime/inputSession`）→ `domain/input` 的纯路由。
 * 壳层按键的归宿现在由 `RoutingLevel` 的五级优先级决定，弹窗作用域是显式状态。
 *
 * 本函数**不再**注册任何键盘监听 —— 若重新加回一条，事件至多一次的结构防御
 * （`claimExclusiveKeydown`）与 `e2e/input-routing.spec.ts` 的挂载计数都会失败。
 */

/**
 * 绑定壳层 DOM 事实：鼠标位置 → `wm.chrome.lastMousePosition`，并维护
 * "最后鼠标所在 region"（键盘事件在**没有**显式焦点时的兜底归属）。
 *
 * `keymap` 仍注册为 CHROME region 的 handler —— 它由**输入会话**在判定
 * `level === 'area'` 且命中 `r-chrome` 时经 `wm.events.dispatch` 调用，
 * 而不是由本文件自己挂键盘监听。
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

  window.addEventListener('mousemove', onMouseMove)

  return () => {
    unreg()
    window.removeEventListener('mousemove', onMouseMove)
    ed.unregisterRegion(CHROME_REGION)
  }
}

export { CHROME_REGION }
