/**
 * P2.3 查看者本地统计配置（三级配置的"查看者本地"层，留白 #6 拍板）。
 *
 * 存储：localStorage 键 `lightning:stats:v1:<docId>`，值 = `{ schema: 1, config: StatsConfigLayer }`。
 * 只影响本机查看者，不写回文件、不影响他人；schema 字段供未来迁移。
 * 本文件是引擎（pure/partStats）之外的薄 IO 壳；localStorage 不可用时静默返回 null。
 */

import type { StatsConfigLayer } from '@/pure/partStats'
import { parseStatsConfigLayer, serializeStatsConfigLayer } from './partStatsAdapter'

export const VIEWER_LOCAL_STATS_SCHEMA = 1
const KEY_PREFIX = 'lightning:stats:v1:'

export function viewerLocalStatsStorageKey(docId: string): string {
  return KEY_PREFIX + docId
}

function storageOrNull(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

/** 读取查看者本地层；无记录 / 存储不可用 / 数据损坏 ⇒ null（= 该层不发言） */
export function loadViewerLocalStatsConfig(docId: string): StatsConfigLayer | null {
  const storage = storageOrNull()
  if (!storage) return null
  let text: string | null = null
  try {
    text = storage.getItem(viewerLocalStatsStorageKey(docId))
  } catch {
    return null
  }
  if (!text) return null
  try {
    const raw = JSON.parse(text) as { schema?: unknown; config?: unknown }
    if (!raw || typeof raw !== 'object' || raw.schema !== VIEWER_LOCAL_STATS_SCHEMA) return null
    return parseStatsConfigLayer(raw.config)
  } catch {
    return null
  }
}

/** 写入查看者本地层；`null` 清除该层（回到文档级配置） */
export function saveViewerLocalStatsConfig(docId: string, config: StatsConfigLayer | null): void {
  const storage = storageOrNull()
  if (!storage) return
  const key = viewerLocalStatsStorageKey(docId)
  try {
    if (config === null) {
      storage.removeItem(key)
    } else {
      storage.setItem(key, JSON.stringify({
        schema: VIEWER_LOCAL_STATS_SCHEMA,
        config: serializeStatsConfigLayer(config),
      }))
    }
  } catch {
    // 存储满 / 隐私模式等：静默失败，查看者本地层是增强而非硬依赖
  }
}
