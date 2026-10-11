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

  // 帧声明：从旧文档读（**显式接缝**；内核不认识 `RuntimeDocument`）。
  kernel.bindFrameSource({
    count: () => ctx.getDoc().value?.frameCount ?? 0,
    durationsMs: () => {
      const doc = ctx.getDoc().value
      if (!doc) return []
      const out: number[] = []
      for (let i = 0; i < doc.frameCount; i++) {
        // `durationMs` 缺省由内核按 1ms 处理（`stripTimeline` 的回落），
        // 故这里如实给 0 而不是"猜一个 50"——猜会让"文档没声明时长"
        // 与"文档声明了 50ms"在行为上无法区分。
        out.push(doc.frame(i)?.durationMs ?? 0)
      }
      return out
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
