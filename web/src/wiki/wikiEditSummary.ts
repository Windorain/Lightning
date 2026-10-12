import type { RuntimeDocument } from '@/context/runtimeDocument'
import { EMBED_INITIAL_VIEW_META_KEY } from '@/context/embedInitialView'

/** 保存到灰机 Data:Structures 时的默认编辑摘要 */
export const WIKI_DEFAULT_EDIT_SUMMARY = '结构工作台'

export interface WikiChangeLine {
  key: string
  label: string
  count: number
  /** 逐项明细（#83 裁决：tooltip 类变更按 2026-05-25 历史形态逐项列出）；聚合类变更无此字段。 */
  details?: string[]
}

export interface WikiEditSummaryDraft {
  lines: WikiChangeLine[]
  defaultSummary: string
}

function metaFieldChanged(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  key: string,
): boolean {
  return JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null)
}

/** 调色板逐项比较（#83：内容级，不再只比长度）。产出形如 `tooltipPalette[8]: <missing> -> "文本"`。 */
function diffTooltipPalette(before: unknown[] | undefined, after: unknown[] | undefined): string[] {
  const details: string[] = []
  const len = Math.max(before?.length ?? 0, after?.length ?? 0)
  for (let i = 0; i < len; i++) {
    const bv = before?.[i]
    const cv = after?.[i]
    if (JSON.stringify(bv ?? null) === JSON.stringify(cv ?? null)) continue
    const bText = bv === undefined ? '<missing>' : JSON.stringify(bv)
    const cText = cv === undefined ? '<missing>' : JSON.stringify(cv)
    details.push(`tooltipPalette[${i}]: ${bText} -> ${cText}`)
  }
  return details
}

/**
 * 逐格说明索引的显示值（#83 历史形态对齐）：-1 ⇒ `""`；可解析 ⇒ 调色板文本；
 * 悬空下标（调色板无该条目）⇒ `#<idx>` 原样标出（不掩盖 #80 类坏数据）。
 */
function formatCellTooltip(palette: unknown[] | undefined, idx: number): string {
  if (idx < 0) return '""'
  const v = palette?.[idx]
  return typeof v === 'string' ? JSON.stringify(v) : `#${idx}`
}

/**
 * cellTooltipGrid 逐格比较（#83 裁决：逐项列出，对齐 2026-05-25 历史形态
 * `cellTooltipGrid[z][row][col]: 旧 -> 新`，下标解析为调色板文本）。
 * 缺失的格按 -1（无说明）处理；网格整体缺失按空网格处理。
 */
function diffCellTooltipGrid(
  bGrid: number[][][] | undefined,
  cGrid: number[][][] | undefined,
  bPalette: unknown[] | undefined,
  cPalette: unknown[] | undefined,
): string[] {
  const details: string[] = []
  const zLen = Math.max(bGrid?.length ?? 0, cGrid?.length ?? 0)
  for (let z = 0; z < zLen; z++) {
    const bSl = bGrid?.[z]
    const cSl = cGrid?.[z]
    const rLen = Math.max(bSl?.length ?? 0, cSl?.length ?? 0)
    for (let r = 0; r < rLen; r++) {
      const bRow = bSl?.[r]
      const cRow = cSl?.[r]
      const cLen = Math.max(bRow?.length ?? 0, cRow?.length ?? 0)
      for (let x = 0; x < cLen; x++) {
        const bv = bRow?.[x] ?? -1
        const cv = cRow?.[x] ?? -1
        if (bv === cv) continue
        details.push(
          `cellTooltipGrid[${z}][${r}][${x}]: ${formatCellTooltip(bPalette, bv)} -> ${formatCellTooltip(cPalette, cv)}`,
        )
      }
    }
  }
  return details
}

/** 摘要正文组装上限：逐项明细最多列 12 条，超出折叠为计数（MediaWiki 摘要长度有限）。 */
const MAX_DETAIL_ITEMS = 12

/** 由变更行组装摘要正文：逐项明细优先；超长/超量时退回「标签×计数」聚合形态。 */
function composeSummary(lines: WikiChangeLine[]): string {
  const detailParts: string[] = []
  let overflow = 0
  for (const l of lines) {
    if (l.details) {
      const room = MAX_DETAIL_ITEMS - detailParts.length
      if (room > 0) detailParts.push(...l.details.slice(0, room))
      overflow += Math.max(0, l.details.length - Math.max(0, room))
    } else {
      detailParts.push(`${l.label}×${l.count}`)
    }
  }
  if (overflow > 0) detailParts.push(`…等 ${overflow} 项变更`)
  const text = detailParts.join('; ')
  if (text.length === 0) return WIKI_DEFAULT_EDIT_SUMMARY
  if (text.length > 480) {
    // 超长兜底：纯聚合形态
    return lines.map((l) => `${l.label}×${l.count}`).join('; ')
  }
  return text
}

/**
 * 对比 baseline 与当前文档，生成保存摘要草稿（不访问 mw）。
 *
 * ## #301 P10f D3 的入参改造（`current` 由旧文档改为**产物 plain**）
 *
 * 本函数做的比较**全部**是 plain 键级比较（`meta.*` / `tooltipPalette` /
 * `cellTooltipGrid` / `annotations` / `labels`）—— 它从来不需要旧文档的**类型**，
 * 只需要那份 plain。故 `current` 直接吃 `ctx.plainForSave().plain`
 *（保存/导出的**唯一**产物入口，与真正写出去的那份**同一来源**）。
 *
 * ⚠️ `baseline` **仍**是旧文档：`DocumentBinding.saveBaseline` 的字段类型就是
 * `RuntimeDocument | null`（**外部格式边界**，按 D 批映射表 §一 保留），
 * 且它是在**写入绑定时**捕获的一份冻结副本（不会随编辑变化）。
 */
export function buildWikiEditSummaryDraft(
  baseline: RuntimeDocument | null,
  current: Readonly<Record<string, unknown>> | null,
): WikiEditSummaryDraft | null {
  if (!baseline || !current) return null
  const b = baseline.serialize() as Record<string, unknown>
  const c = current
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

  if (metaFieldChanged(bMeta, cMeta, EMBED_INITIAL_VIEW_META_KEY)) {
    lines.push({ key: 'embed_initial_view', label: '嵌入初始视角', count: 1 })
  }

  // #83：tooltipPalette 内容级逐项比较（长度不变但内容变了也算变更）
  const bPalette = b.tooltipPalette as unknown[] | undefined
  const cPalette = c.tooltipPalette as unknown[] | undefined
  const paletteDetails = diffTooltipPalette(bPalette, cPalette)
  if (paletteDetails.length > 0) {
    lines.push({ key: 'tooltip', label: 'Tooltip 文案池', count: paletteDetails.length, details: paletteDetails })
  }

  // #83：cellTooltipGrid 逐项比较（此前完全不在判定/摘要里 ⇒ 只改逐格说明时摘要退化为默认值）
  const cellDetails = diffCellTooltipGrid(
    b.cellTooltipGrid as number[][][] | undefined,
    c.cellTooltipGrid as number[][][] | undefined,
    bPalette,
    cPalette,
  )
  if (cellDetails.length > 0) {
    lines.push({ key: 'cellTooltip', label: '逐格说明', count: cellDetails.length, details: cellDetails })
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

  return { lines, defaultSummary: composeSummary(lines) }
}

export function hasWikiAuditableChanges(draft: WikiEditSummaryDraft | null): boolean {
  return draft != null && draft.lines.length > 0
}
