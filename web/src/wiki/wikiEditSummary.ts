import type { RuntimeDocument } from '@/context/runtimeDocument'

/** 保存到灰机 Data:Structures 时的默认编辑摘要 */
export const WIKI_DEFAULT_EDIT_SUMMARY = '结构工作台'

export interface WikiChangeLine {
  key: string
  label: string
  count: number
}

export interface WikiEditSummaryDraft {
  lines: WikiChangeLine[]
  defaultSummary: string
}

function countArrayDelta(before: unknown[] | undefined, after: unknown[] | undefined): number {
  const b = before?.length ?? 0
  const a = after?.length ?? 0
  return Math.abs(a - b)
}

function metaFieldChanged(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  key: string,
): boolean {
  return JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null)
}

/** 对比 baseline 与当前文档，生成保存摘要草稿（不访问 mw） */
export function buildWikiEditSummaryDraft(
  baseline: RuntimeDocument | null,
  current: RuntimeDocument | null,
): WikiEditSummaryDraft | null {
  if (!baseline || !current) return null
  const b = baseline.serialize() as Record<string, unknown>
  const c = current.serialize() as Record<string, unknown>
  const lines: WikiChangeLine[] = []

  const metaKeys = ['title', 'description', 'author', 'version'] as const
  let metaChanges = 0
  const bMeta = (b.meta ?? {}) as Record<string, unknown>
  const cMeta = (c.meta ?? {}) as Record<string, unknown>
  for (const k of metaKeys) {
    if (metaFieldChanged(bMeta, cMeta, k)) metaChanges++
  }
  if (metaChanges > 0) {
    lines.push({ key: 'meta', label: '场景元数据', count: metaChanges })
  }

  const tooltipDelta = countArrayDelta(
    b.tooltipPalette as unknown[] | undefined,
    c.tooltipPalette as unknown[] | undefined,
  )
  if (tooltipDelta > 0) {
    lines.push({ key: 'tooltip', label: 'Tooltip 文案池', count: tooltipDelta })
  }

  const annB = (b.annotations as unknown[] | undefined)?.length ?? 0
  const annC = (c.annotations as unknown[] | undefined)?.length ?? 0
  if (annB !== annC) {
    lines.push({ key: 'annotations', label: '注解', count: Math.abs(annC - annB) })
  }

  const labelB = (b.labels as unknown[] | undefined)?.length ?? 0
  const labelC = (c.labels as unknown[] | undefined)?.length ?? 0
  if (labelB !== labelC) {
    lines.push({ key: 'labels', label: '标签', count: Math.abs(labelC - labelB) })
  }

  if (lines.length === 0) return null

  return { lines, defaultSummary: WIKI_DEFAULT_EDIT_SUMMARY }
}

export function hasWikiAuditableChanges(draft: WikiEditSummaryDraft | null): boolean {
  return draft != null && draft.lines.length > 0
}
