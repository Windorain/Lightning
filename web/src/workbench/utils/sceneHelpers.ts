/**
 * 工作台工具函数。
 * 不依赖任何 Ref、Vue 响应式 API。部分函数读取浏览器全局状态（window.location）。
 */

export type { RuntimeDocument as WorkbenchScene } from '@/workbench/context/runtimeDocument'

/** 深拷贝场景文档（JSON 往返）。返回纯 JSON 对象（非 RuntimeDocument）。 */
export function cloneDocument(doc: unknown): Record<string, unknown> | null {
  if (doc === null || typeof doc !== 'object') return null
  return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>
}

/** 从 URL query 解析初始 apiBase 与 token */
export function parseWorkbenchQuery(): { apiBase: string; token: string } {
  if (typeof window === 'undefined') return { apiBase: '', token: '' }
  const q = new URLSearchParams(window.location.search)
  const apiBase = (q.get('apiBase') ?? q.get('api') ?? '').trim().replace(/\/+$/, '')
  const token = (q.get('token') ?? '').trim()
  return { apiBase, token }
}

/** 去除尾部斜杠并 trim */
export function normalizeApiBase(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/** 建议的本地 JSON 文件名（无扩展名） */
export function suggestedJsonBaseName(currentFileName: string | null, fallback: string): string {
  let base = currentFileName?.replace(/^示例 · /, '') ?? fallback
  if (!base.toLowerCase().endsWith('.json')) base = `${base}.json`
  return base.replace(/\.json$/i, '')
}
