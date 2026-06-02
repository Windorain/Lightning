/**
 * 工作台工具函数。
 * 不依赖任何 Ref、Vue 响应式 API。部分函数读取浏览器全局状态（window.location）。
 */


/** 从 URL query 解析初始 apiBase 与 token */
export function parseWorkbenchQuery(): { apiBase: string; token: string } {
  if (typeof window === 'undefined') return { apiBase: '', token: '' }
  const q = new URLSearchParams(window.location.search)
  const apiBase = (q.get('apiBase') ?? q.get('api') ?? '').trim().replace(/\/+$/, '')
  const token = (q.get('token') ?? '').trim()
  return { apiBase, token }
}

export { normalizeApiBase, suggestedJsonBaseName } from '@/pure/string'
