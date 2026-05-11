/**
 * 将 catch / Promise 拒绝中的值转为可读文案。
 * Three.TextureLoader、部分 DOM API 会传入 Event / ErrorEvent，直接 String 会得到 [object Event]。
 */
export function formatUnknownError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err != null && typeof err === 'object') {
    const msg = (err as { message?: unknown }).message
    if (typeof msg === 'string' && msg.length > 0) return msg
    if (typeof Event !== 'undefined' && err instanceof Event) {
      const ev = err as ErrorEvent
      const parts: string[] = []
      if (ev.type) parts.push(ev.type)
      if (typeof ev.message === 'string' && ev.message.length > 0) parts.push(ev.message)
      if (typeof ev.filename === 'string' && ev.filename.length > 0) parts.push(ev.filename)
      if (parts.length > 0) return parts.join(' · ')
    }
  }
  try {
    const s = JSON.stringify(err)
    if (s && s !== '{}') return s
  } catch {
    /* ignore */
  }
  return String(err)
}
