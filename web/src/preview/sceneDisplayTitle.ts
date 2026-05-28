/**
 * 从「与 RenderBundle 同源」的场景 document 解析顶栏展示标题（根 / World 默认帧内嵌）。
 * 供 AppShell 内用，不依赖工作台等外部注入。
 */

import { embeddedStructure, frameAt, getDefaultFrameIndex } from '@/render/data/worldPlayback'
import type { World } from '@/render/schema/types'

function hasWorldFrames(d: object): d is { frames: unknown[] } {
  return Array.isArray((d as { frames?: unknown }).frames) && (d as { frames: unknown[] }).frames.length > 0
}

function scalarDisplay(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

/**
 * 展示标题：根 `label` → 根 `id`（含数字）→ World 默认帧内嵌 `structure` 的 `label` / `id` → 再根 `id`。
 */
export function sceneDisplayTitleFromRootDocument(d: unknown): string | null {
  if (d == null || typeof d !== 'object' || Array.isArray(d)) return null
  const o = d as Record<string, unknown>
  // label → meta.name → meta 内 name → root id
  const rootLabel = scalarDisplay(o.label)
  if (rootLabel) return rootLabel
  const meta = o.meta as Record<string, unknown> | undefined
  const metaName = scalarDisplay(meta?.name)
  if (metaName) return metaName
  const metaLabel = scalarDisplay(meta?.label)
  if (metaLabel) return metaLabel
  const rootId = scalarDisplay(o.id)
  if (rootId && !hasWorldFrames(d)) return rootId
  if (hasWorldFrames(d)) {
    const w = d as World
    const fr = frameAt(w, getDefaultFrameIndex(w))
    const st = embeddedStructure(fr)
    if (st && typeof st === 'object' && !Array.isArray(st)) {
      const s = st as unknown as Record<string, unknown>
      const inLab = scalarDisplay(s.label)
      if (inLab) return inLab
      const inId = scalarDisplay(s.id)
      if (inId) return inId
    }
  }
  if (rootId) return rootId
  return null
}
