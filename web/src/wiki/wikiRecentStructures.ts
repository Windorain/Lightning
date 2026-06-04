import { normalizeBase } from '@/util/wikiStructureData'

const LS_KEY = 'lightning-wiki-recent-structures'
const MAX = 10

export function pushRecentStructure(base: string): void {
  const b = normalizeBase(base)
  if (!b) return
  try {
    const raw = localStorage.getItem(LS_KEY)
    const list: string[] = raw ? (JSON.parse(raw) as string[]) : []
    const next = [b, ...list.filter(x => x !== b)].slice(0, MAX)
    localStorage.setItem(LS_KEY, JSON.stringify(next))
  } catch { /* ignore */ }
}

export function getRecentStructures(): string[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as unknown
    return Array.isArray(list) ? list.filter(x => typeof x === 'string') : []
  } catch {
    return []
  }
}
