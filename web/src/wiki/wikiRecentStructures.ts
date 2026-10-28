/**
 * Wiki「最近打开的结构」的持久化（**按实例**）。
 *
 * 键形态：`lk-ui.v1.<instanceId>.wiki.recent-structures`
 * （见 `runtime/instanceStorage`）。旧键 `lightning-wiki-recent-structures`
 * 无实例身份可归属，**不迁移**（旧列表失效一次，不是数据损坏）。
 */

import { normalizeBase } from '@/util/wikiStructureData'
import { instanceUiKey } from '@/runtime/instanceStorage'

const MAX = 10

function storageKey(instanceId: string): string {
  return instanceUiKey(instanceId, 'wiki.recent-structures')
}

export function pushRecentStructure(base: string, instanceId: string): void {
  const b = normalizeBase(base)
  if (!b) return
  const key = storageKey(instanceId)
  try {
    const raw = localStorage.getItem(key)
    const list: string[] = raw ? (JSON.parse(raw) as string[]) : []
    const next = [b, ...list.filter(x => x !== b)].slice(0, MAX)
    localStorage.setItem(key, JSON.stringify(next))
  } catch { /* ignore */ }
}

export function getRecentStructures(instanceId: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(instanceId))
    if (!raw) return []
    const list = JSON.parse(raw) as unknown
    return Array.isArray(list) ? list.filter(x => typeof x === 'string') : []
  } catch {
    return []
  }
}
