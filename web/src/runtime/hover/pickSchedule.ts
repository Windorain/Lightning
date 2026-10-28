/** 将高频 pointermove 合并为每帧至多一次拾取 */
export function createHoverPickScheduler(run: () => void): {
  schedule(): void
  flush(): void
  cancel(): void
} {
  let rafId = 0
  let scheduled = false

  function flush(): void {
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    scheduled = false
    run()
  }

  function schedule(): void {
    if (scheduled) return
    scheduled = true
    rafId = requestAnimationFrame(() => {
      rafId = 0
      scheduled = false
      run()
    })
  }

  function cancel(): void {
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
    scheduled = false
  }

  return { schedule, flush, cancel }
}
