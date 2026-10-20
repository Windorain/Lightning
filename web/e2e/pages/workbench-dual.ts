/**
 * M7-6 · **同页两个工作台实例**的测试页（测试专用，不属于产品构建）。
 *
 * ## 为什么需要它
 *
 * Q3 裁决要求"多工作台保持**结构禁止**、报错改人话"。这条行为的观测面必须来自
 * **真实装配**：两个 `DevApp` 各建一个 `WorkbenchRoot` → 各自的
 * `createWorkbenchHost` → 各自 `assembleInput`。第二个在
 * `inputBinding#claimExclusive` 处被结构性拒绝，页面**不得**因此崩掉。
 *
 * 本页只做宿主页的事：两个挂载点 + 按顺序挂两个 `DevApp`。
 * 它不 import 任何内部装配模块、不建替身宿主。
 *
 * ## 判据面（由 `e2e/kernel-workbench-single-instance.spec.ts` 读）
 *
 * 1. 第二个实例的事件根内出现 `[data-lk-workbench-conflict]` 提示（人话文案）；
 * 2. 第一个实例**不受影响**：仍有唯一 keydown 持有者、键盘命令仍生效、没有提示；
 * 3. 页面零未捕获异常（`pageerror` 为空）—— 旧形态正是抛到挂载回调里。
 */

import { createApp } from 'vue'

import DevApp from '@/dev/DevApp.vue'

import '@/styles/precision-tokens.css'
import '@/styles/embed-nei-tokens.css'

function mountInto(id: string): void {
  const el = document.getElementById(id)
  if (!el) throw new Error('缺少挂载点 ' + id)
  createApp(DevApp).mount(el)
}

// 顺序即"谁是第一个"：A 先挂 ⇒ A 持有 document keydown。
mountInto('wb-a')
mountInto('wb-b')

;(window as any).__workbenchDual__ = { ready: true }
