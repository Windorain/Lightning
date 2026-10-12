import { describe, expect, it } from 'vitest'
import { RuntimeDocument } from '@/context/runtimeDocument'
import {
  EMBED_INITIAL_VIEW_META_KEY,
  setDocumentEmbedInitialView,
} from '@/context/embedInitialView'
import {
  buildWikiEditSummaryDraft,
  hasWikiAuditableChanges,
} from '@/wiki/wikiEditSummary'

const MIN_V2 = {
  format_version: '2.0',
  id: 't',
  meta: { name: 't', author: '', created_at_ms: 0, description: '', tags: [], origin: { x: 0, y: 0, z: 0 } },
  frames: [{
    index: 0,
    structure: {
      geometryPhase: 'baked' as const,
      cellGrid: [[[0]]],
      blockPalette: [{
        registryId: 'minecraft:stone',
        meta: 0,
        renderMode: 'BakedQuads',
        geometry: { encoding: 'bakedQuadsJsonV1', quads: [] },
        occludesAdjacentFaces: true,
      }],
    },
  }],
  annotations: [],
  labels: [],
}

describe('wikiEditSummary', () => {
  it('detects embed_initial_view as auditable change', () => {
    const baseline = RuntimeDocument.fromV2Plain(MIN_V2 as Record<string, unknown>)!
    const current = baseline.clone()
    setDocumentEmbedInitialView(current, {
      target: { x: 0, y: 1, z: 0 },
      yawDeg: 45,
      elevationDeg: 35,
      distance: 10,
      zoom: 1,
    })

    // #301 P10f D3：`current` 是**产物 plain**（保存路径的同一来源）。
    const draft = buildWikiEditSummaryDraft(baseline, current.serialize() as Record<string, unknown>)
    expect(hasWikiAuditableChanges(draft)).toBe(true)
    expect(draft?.lines.some((l) => l.key === 'embed_initial_view')).toBe(true)
  })

  it('ignores unchanged embed_initial_view', () => {
    const view = {
      target: { x: 0, y: 1, z: 0 },
      yawDeg: 45,
      elevationDeg: 35,
      distance: 10,
      zoom: 1,
    }
    const v2 = {
      ...MIN_V2,
      meta: { ...MIN_V2.meta, [EMBED_INITIAL_VIEW_META_KEY]: view },
    }
    const baseline = RuntimeDocument.fromV2Plain(v2 as Record<string, unknown>)!
    const current = baseline.clone()

    // #301 P10f D3：`current` 是**产物 plain**（保存路径的同一来源）。
    const draft = buildWikiEditSummaryDraft(baseline, current.serialize() as Record<string, unknown>)
    expect(hasWikiAuditableChanges(draft)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// #83：tooltipPalette 内容级 + cellTooltipGrid 逐项（对齐 2026-05-25 历史摘要形态）
// ---------------------------------------------------------------------------

/** 带成对 idioms 的 1×1×1 文档（root 级 tooltipPalette/cellTooltipGrid）。 */
function docWithTooltips(palette?: string[], grid?: number[][][]): RuntimeDocument {
  return RuntimeDocument.fromV2Plain({
    ...MIN_V2,
    ...(palette ? { tooltipPalette: palette } : {}),
    ...(grid ? { cellTooltipGrid: grid } : {}),
  } as Record<string, unknown>)!
}

describe('#83 逐格说明进入可审计判定与编辑摘要', () => {
  it('只改 cellTooltipGrid（调色板不变）⇒ 产生逐项摘要行（修复前：摘要退化为默认值/null）', () => {
    const baseline = docWithTooltips(['存储总线', '流体存储总线'], [[[0]]])
    const current = docWithTooltips(['存储总线', '流体存储总线'], [[[1]]])

    // #301 P10f D3：`current` 是**产物 plain**（保存路径的同一来源）。
    const draft = buildWikiEditSummaryDraft(baseline, current.serialize() as Record<string, unknown>)
    expect(hasWikiAuditableChanges(draft)).toBe(true)
    const line = draft!.lines.find((l) => l.key === 'cellTooltip')
    expect(line, 'cellTooltipGrid 变更必须成行').toBeTruthy()
    // 下标解析为调色板文本（历史形态 `cellTooltipGrid[z][row][col]: 旧 -> 新`）
    expect(line!.details).toEqual(['cellTooltipGrid[0][0][0]: "存储总线" -> "流体存储总线"'])
    expect(draft!.defaultSummary).toContain('cellTooltipGrid[0][0][0]: "存储总线" -> "流体存储总线"')
    expect(draft!.defaultSummary).not.toBe('结构工作台')
  })

  it('调色板等长改写（长度不变、内容变）⇒ 判定为变更（修复前：只比长度 ⇒ 漏判）', () => {
    const baseline = docWithTooltips(['旧文案'], [[[0]]])
    const current = docWithTooltips(['新文案'], [[[0]]])

    // #301 P10f D3：`current` 是**产物 plain**（保存路径的同一来源）。
    const draft = buildWikiEditSummaryDraft(baseline, current.serialize() as Record<string, unknown>)
    expect(hasWikiAuditableChanges(draft)).toBe(true)
    const line = draft!.lines.find((l) => l.key === 'tooltip')
    expect(line!.details).toEqual(['tooltipPalette[0]: "旧文案" -> "新文案"'])
    // 下标未变 ⇒ 不产生逐格行
    expect(draft!.lines.find((l) => l.key === 'cellTooltip')).toBeUndefined()
  })

  it('历史形态对照（2026-05-25 revid 204254）：追加条目 + 新指格 ⇒ <missing> -> 文本 / "" -> 文本', () => {
    const baseline = docWithTooltips(['存储总线'], [[[-1]]])
    const current = docWithTooltips(['存储总线', '流体存储总线'], [[[1]]])

    // #301 P10f D3：`current` 是**产物 plain**（保存路径的同一来源）。
    const draft = buildWikiEditSummaryDraft(baseline, current.serialize() as Record<string, unknown>)
    expect(draft!.defaultSummary).toContain('tooltipPalette[1]: <missing> -> "流体存储总线"')
    expect(draft!.defaultSummary).toContain('cellTooltipGrid[0][0][0]: "" -> "流体存储总线"')
  })

  it('清除一格说明（指回 -1）⇒ 逐项行显示 文本 -> ""', () => {
    const baseline = docWithTooltips(['存储总线'], [[[0]]])
    const current = docWithTooltips(['存储总线'], [[[-1]]])

    // #301 P10f D3：`current` 是**产物 plain**（保存路径的同一来源）。
    const draft = buildWikiEditSummaryDraft(baseline, current.serialize() as Record<string, unknown>)
    const line = draft!.lines.find((l) => l.key === 'cellTooltip')
    expect(line!.details).toEqual(['cellTooltipGrid[0][0][0]: "存储总线" -> ""'])
  })

  it('悬空下标不掩盖：下标超出调色板 ⇒ 显示 #<idx> 原样（坏数据可见）', () => {
    const baseline = docWithTooltips(['存储总线'], [[[0]]])
    const current = docWithTooltips(['存储总线'], [[[7]]])

    // #301 P10f D3：`current` 是**产物 plain**（保存路径的同一来源）。
    const draft = buildWikiEditSummaryDraft(baseline, current.serialize() as Record<string, unknown>)
    const line = draft!.lines.find((l) => l.key === 'cellTooltip')
    expect(line!.details).toEqual(['cellTooltipGrid[0][0][0]: "存储总线" -> #7'])
  })

  it('负对照：tooltipPalette/cellTooltipGrid 都不变 ⇒ 不产生 tooltip 行', () => {
    const baseline = docWithTooltips(['存储总线'], [[[0]]])
    const current = docWithTooltips(['存储总线'], [[[0]]])
    // #301 P10f D3：`current` 是**产物 plain**（保存路径的同一来源）。
    const draft = buildWikiEditSummaryDraft(baseline, current.serialize() as Record<string, unknown>)
    expect(draft).toBeNull()
  })

  it('负对照：无成对 idioms 的旧文档 ⇒ 不产出 tooltip 行（行为零差异）', () => {
    const baseline = RuntimeDocument.fromV2Plain(MIN_V2 as Record<string, unknown>)!
    const current = baseline.clone()
    // #301 P10f D3：`current` 是**产物 plain**（保存路径的同一来源）。
    const draft = buildWikiEditSummaryDraft(baseline, current.serialize() as Record<string, unknown>)
    expect(draft).toBeNull()
  })
})
