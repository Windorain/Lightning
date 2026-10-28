/**
 * SDE Web REST 客户端（/api/v1）。
 */

import { formatUnknownError } from '@/util/formatUnknownError'

export interface ExportFileInfo {
  name: string
  size: number
}

function joinBase(base: string, path: string): string {
  const b = base.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return `${b}${p}`
}

function authHeaders(token: string): HeadersInit {
  const h: Record<string, string> = { Accept: 'application/json' }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  if (!res.ok) {
    let msg = text || res.statusText
    try {
      const j = JSON.parse(text) as { error?: string }
      if (j?.error) msg = j.error
    } catch {
      /* use raw */
    }
    throw new Error(msg || `HTTP ${res.status}`)
  }
  if (!text) return {} as T
  return JSON.parse(text) as T
}

export async function sdePing(apiBase: string, token: string): Promise<{ ok?: boolean }> {
  const url = joinBase(apiBase, '/api/v1/ping')
  const res = await fetch(url, { headers: authHeaders(token) })
  return readJson(res)
}

export async function sdeListExports(apiBase: string, token: string): Promise<ExportFileInfo[]> {
  const url = joinBase(apiBase, '/api/v1/exports')
  const res = await fetch(url, { headers: authHeaders(token) })
  const data = await readJson<{ files?: ExportFileInfo[] }>(res)
  return Array.isArray(data.files) ? data.files : []
}

export async function sdeGetExportFile(apiBase: string, token: string, name: string): Promise<unknown> {
  const enc = encodeURIComponent(name)
  const url = joinBase(apiBase, `/api/v1/exports/${enc}`)
  const res = await fetch(url, { headers: authHeaders(token) })
  return readJson(res)
}

export async function sdeGetWorkspaceDocument(apiBase: string, token: string): Promise<unknown> {
  const url = joinBase(apiBase, '/api/v1/workspace/document')
  const res = await fetch(url, { headers: authHeaders(token) })
  return readJson(res)
}

export async function sdePutWorkspaceDocument(
  apiBase: string,
  token: string,
  document: unknown,
): Promise<void> {
  const url = joinBase(apiBase, '/api/v1/workspace/document')
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(document),
  })
  await readJson(res)
}

export async function sdePatchWorkspaceDocument(
  apiBase: string,
  token: string,
  patch: Record<string, unknown>,
): Promise<unknown> {
  const url = joinBase(apiBase, '/api/v1/workspace/document')
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ patch }),
  })
  return readJson(res)
}

export function formatSdeError(e: unknown): string {
  return formatUnknownError(e)
}
