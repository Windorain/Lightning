/**
 * `adapters/export/abortBridge` —— **`AbortSignal` → `ExportJob.cancel()` 的桥**。
 *
 * ## 为什么不是"给作业加第二套取消状态"
 *
 * `ExportJob` 已经有取消语义且**幂等**（`cancel()` 置位，`run()` 在帧边界与编码前后检查，
 * `finally` 必释放）。再引入一个"被中止"布尔就会有两份取消真相 —— 而它们漂移的表现是
 * "点了取消但作业继续跑"或"作业已停但状态说在跑"，两者都静默。
 * ⇒ 桥只做一件事：把外部信号**翻译成**那唯一一个 `cancel()`。
 *
 * ## 契约（三条都要能判）
 *
 * 1. **当刻已中止** ⇒ 立刻 `cancel()`（不等到第一次帧边界）；
 * 2. 否则 `addEventListener('abort', …)`，且返回的 `detach` **必须**在作业结束后调用
 *    （否则监听留在信号上 ⇒ 长寿命 `AbortController` 会累积回调）；
 * 3. 取消**不改编辑现场**：本桥只碰作业对象；离屏端口不持有任何 `EditorClient`/`EditContext`/
 *    视口（见 `offscreenRenderPort` 文件头），故"取消 = 释放自己的句柄"。
 *
 * ## 为什么 `once: true` 还要 `detach`
 *
 * `once` 只保证"触发一次"，不保证"监听被移除"：**没有触发**的中止信号会一直挂着回调。
 * `detach` 覆盖的正是这条路径。
 */

/** 桥只需要 `cancel()` 这一个方法（结构上不依赖作业的其他面）。 */
export interface Cancellable {
  cancel(): void
}

/**
 * 把中止信号接到作业的 `cancel()` 上，返回**撤销订阅**的函数（幂等）。
 *
 * @param job 任何带 `cancel()` 的对象（生产里是 `ExportJob`）
 * @param signal 缺省 ⇒ 返回 no-op（没有取消入口 ≠ 假装有）
 */
export function cancelOnAbort(job: Cancellable, signal?: AbortSignal): () => void {
  if (signal === undefined) return () => {}
  if (signal.aborted) {
    job.cancel()
    return () => {}
  }
  const onAbort = (): void => {
    job.cancel()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  let detached = false
  return (): void => {
    if (detached) return
    detached = true
    signal.removeEventListener('abort', onAbort)
  }
}
