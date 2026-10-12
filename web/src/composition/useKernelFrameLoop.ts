/**
 * `composition/useKernelFrameLoop` —— **外壳级帧循环**：把宿主帧时钟接进内核会话
 * （#261；R-WK-03「按帧注入时间输入」的装配落点）。
 *
 * ## 为什么是一个 composable 而不是在 host 里起循环
 *
 * 帧时钟的寿命必须与**外壳实例**一致（挂载即开始、卸载即停止）：
 *  - 在 `createWorkbenchHost` 里起：host 在 `setup()` 期间构造，此时还没有
 *    组件实例 ⇒ 拿不到 `onMounted`/`onScopeDispose`，时钟要么立刻跑
 *    （在 DOM 就绪前推进业务）要么永远不跑；
 *  - 在组件 `onMounted` 里起：寿命天然对齐，且 Vue 的作用域销毁
 *    （`onScopeDispose`）保证卸载时停掉 —— 不留"幽灵推进"。
 *
 * ## 两条职责（各自对应一个旧机制的替代）
 *
 * ### 1. 绑定帧声明（`FrameSource`）
 *
 * 内核不持有文档、不认识 `RuntimeDocument`。帧**声明**（帧数、每帧时长）
 * 由本 composable 从 `ctx.getDoc()` 读出来交给会话 —— 这是一条**显式**的
 * 适配接缝（见 `KernelSession.bindFrameSource` 的说明）。
 *
 * 提供者是**函数**（每次现读）而不是快照：文档可被替换（打开另一份文件），
 * 传快照会要求每次换文档都重新绑定并保证不漏 —— 漏一次就得到
 * "渲染按旧帧表选帧"的静默错误。
 *
 * ### 2. 启动/停止帧时钟
 *
 * 时钟的 delta 来自 `performance.now()`（`composition/kernelRuntime` 内部），
 * 内核不读时钟（#249 §2.1）。
 *
 * ## 为什么 `start()` 在 `onMounted` 而不是 `setup()`
 *
 * `setup()` 期间 DOM 尚未就绪、视口尚未注册。此时开始推进时间会让
 * "第一帧"落在没有视口可呈现的时刻 —— 那些推进被丢掉，于是
 * "播放到第 N 帧"与"用户看到的第 N 帧"不一致。`onMounted` 保证
 * 至少有一个视口已经在（子组件的 `onMounted` 早于父组件）。
 */

import { onBeforeUnmount, onMounted } from 'vue'
import type { Context } from '@/runtime/context'
import { createFrameClock, type FrameClock } from './kernelRuntime'
import { frameCount as axisFrameCount, frameDurationsMs } from '@/domain/content'

/**
 * 把一个外壳的内核会话接上帧时钟。
 *
 * 无会话（`ctx.kernel === null`）时**什么也不做** —— 视口退化为静态第一帧
 * （见 `useViewportRuntime` 的说明），而不是崩掉。
 *
 * 返回时钟实例（供诊断与测试；产品侧不需要它）。
 */
export function useKernelFrameLoop(ctx: Context): FrameClock | null {
  const kernel = ctx.kernel
  if (!kernel) return null

  /**
   * 帧声明：**优先读内核文档**，旧文档作兜底（#282 P10b）。
   *
   * ## 这条优先级就是"文档内容面迁进内核"的可观测含义
   *
   * 迁移前：帧数/时长只能从 `ctx.getDoc()`（旧 `RuntimeDocument`）读 —— 内核
   * 不认识它，故 `KernelSession.bindFrameSource` 的注释逐字把这里标为
   * 「**显式**的适配接缝」。
   *
   * 迁移后：装配产出的内核 `Document` **自己承载**帧时长轴
   * （`DocumentContent.frameAxis`），故这里先问内核。于是：
   *  - 内核里改了帧时长 ⇒ 帧下标随之变（不再需要"同步回旧文档"这一步）；
   *  - 旧文档只在**装配未覆盖该文档形态**时兜底（能力不回退）。
   *
   * ## 为什么"先问内核"是函数里的一个分支而不是两套提供者
   *
   * 两个提供者会要求"换文档时记得重绑"，漏一次就得到"渲染按旧帧表选帧"的静默错误
   * （`FrameSource` 的注释里记录了同一取舍：故它是函数而不是数组快照）。
   * 一个函数内部按当前事实分支，使"总是读当前值"仍是结构性质。
   */
  kernel.bindFrameSource({
    count: () => {
      // #301 P10f B′：此处原有一个 `ctx.getDoc().value?.frameCount ?? 0` 的**死分支**，
      // 已删除（Lead 裁决 (a)）。它测的是 `kernel.document() !== undefined`，而该值
      // **恒为真**（`openDocument` 无条件建文档条目、`closeDocument` 生产零调用）
      // ⇒ 那一行**永不执行**。
      //
      // ⚠️ 删掉它**不是**在说"这里已经正确"，而是把一处**掩盖缺口的假守卫**移开：
      // 该分支的注释原本声称"旧文档只在**装配未覆盖该文档形态**时兜底（能力不回退）"，
      // 但守卫测的是"文档存在"、**不是"装配成功"** ⇒ 装配失败时仍走内核分支，
      // 返回**空/陈旧**帧轴（0）而不是 legacy 的 N 帧。**那处兜底从未生效。**
      //
      // 缺陷本体（装配失败 ⇒ 帧数 0）与"装配成功"读面的缺口已登记为 **D8 / GF-16**，
      // 修复与 `StatusBar.vue` 的同类替换同批归 C′。本批只做零行为变化的死分支删除。
      const kdoc = kernel.document()
      if (kdoc === undefined) return 0
      return axisFrameCount(kdoc.content.frameAxis)
    },
    durationsMs: () => {
      const kdoc = kernel.document()
      if (kdoc === undefined) return []
      return [...frameDurationsMs(kdoc.content.frameAxis)]
    },
  })

  const clock = createFrameClock({ session: kernel })
  // 让视口能订阅（时间属共享 EditContext ⇒ 时钟归外壳，视口只订阅）。
  ctx.setFrameClock(clock)

  onMounted(() => {
    clock.start()
  })
  onBeforeUnmount(() => {
    clock.stop()
    ctx.setFrameClock(null)
  })

  return clock
}
