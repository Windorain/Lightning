/**
 * P2.2 — useEmbedTooltip 部件粒度 tooltip 解析（composable 级，真实 RuntimeDocument，无替身）。
 *
 * 验证 tooltip 链路改动点（契约 §8 末段 + P2.2 拍板）：
 *  - 部件命中 ⇒ 说明 = 部件 tooltip（导出时最终行），标题 = displayName，附「位于 <宿主名>」
 *  - 同格不同部件 ⇒ 不同说明（硬约束）
 *  - 逐格人工说明为叠加层：有则优先（标题换部件 displayName），两条链不互相替代
 *  - 宿主格命中 / 无部件 ⇒ 既有行为不劣化（回归锁定）
 *  - showHoverTooltip 关闭 ⇒ 不显示（既有门禁不变）
 */
import { describe, it, expect } from 'vitest'
import { ref, shallowRef } from 'vue'
import { useEmbedTooltip } from '@/shared/viewport/useEmbedTooltip'
import { RuntimeDocument } from '@/context/runtimeDocument'
import type { EmbedHover } from '@/runtime/hover'
import type { PartTooltipInfo } from '@/pure/tooltipResolution'
import type { StructureDefinition } from '@/render/schema/types'

import ae2Fixture from '../../../e2e/fixtures/parts-ae2-multibox.v2.json'

type Json = Record<string, unknown>

const doc = RuntimeDocument.fromV2Plain(ae2Fixture as unknown as Json)!
const structure = (doc.serialize() as Json).frames as Json[]
const ae2Def = structure[0]!.structure as unknown as StructureDefinition

const CABLE_BUS = 'appliedenergistics2:tile.BlockCableBus'
const STONE = 'minecraft:stone'

const partUp: PartTooltipInfo = {
  localId: 'ae2:UP',
  displayName: 'ME Storage Bus',
  tooltip: ['ME Storage Bus'],
}
const partNorth: PartTooltipInfo = {
  localId: 'ae2:NORTH',
  displayName: 'ME Toggle Bus',
  tooltip: ['ME Toggle Bus'],
}

/**
 * R1-β① C5：`useEmbedTooltip` 的入参由"旧文档本体（`docRef`）"改为**内核读面投影**
 * （`metaRef` + `annotationsRef`）。本替身从同一份真实夹具读值 —— 生产里这两项分别来自
 * `ctx.documentMetadata()` 与 `ctx.kernelAnnotations()`（见 `EmbedViewport.vue`）。
 */
const fixturePlain = doc.serialize() as Json
const fixtureMeta = {
  author: String((doc.meta as Json).author ?? ''),
  gtnhVersion: String(fixturePlain.gtnhVersion ?? ''),
}
const fixtureAnnotations = (doc.annotations ?? []).map((a) => {
  const r = a as unknown as { id?: unknown; description?: unknown }
  return { id: String(r.id ?? ''), description: String(r.description ?? '') }
})

function makeTooltip(deps: {
  def?: StructureDefinition | null
  palette?: readonly string[]
  showHover?: boolean
}) {
  const hoverRef = ref<EmbedHover | null>(null)
  const api = useEmbedTooltip({
    hoverRef,
    definitionRef: shallowRef(deps.def === undefined ? ae2Def : deps.def),
    tooltipPaletteRef: ref(deps.palette ?? []),
    showHoverTooltipRef: ref(deps.showHover ?? true),
    metaRef: ref(fixtureMeta),
    annotationsRef: ref(fixtureAnnotations),
  })
  return { hoverRef, api }
}

function blockHover(blockId: string, column: number, part: PartTooltipInfo | null): EmbedHover {
  return {
    kind: 'block',
    source: 'viewport',
    blockId,
    clientX: 10,
    clientY: 10,
    voxel: { column, row: 0, zSlice: 0 },
    part,
  }
}

describe('useEmbedTooltip — 部件命中（fixture: parts-ae2-multibox）', () => {
  it('部件命中 ⇒ 部件说明 + displayName 标题 + 「位于 <宿主名>」归属标注', () => {
    const { hoverRef, api } = makeTooltip({})
    hoverRef.value = blockHover(CABLE_BUS, 0, partUp)
    expect(api.tooltipText.value).toBe('ME Storage Bus\n位于 ME Glass Cable - Fluix')
  })

  it('同格不同部件 ⇒ 不同说明（硬约束）', () => {
    const { hoverRef, api } = makeTooltip({})
    hoverRef.value = blockHover(CABLE_BUS, 0, partUp)
    const up = api.tooltipText.value
    hoverRef.value = blockHover(CABLE_BUS, 0, partNorth)
    const north = api.tooltipText.value
    expect(north).toBe('ME Toggle Bus\n位于 ME Glass Cable - Fluix')
    expect(up).not.toBe(north)
  })

  it('同格无部件命中（part=null）⇒ 宿主 NEI 回退（既有行为不劣化）', () => {
    const { hoverRef, api } = makeTooltip({})
    hoverRef.value = blockHover(CABLE_BUS, 0, null)
    expect(api.tooltipText.value).toBe('ME Glass Cable - Fluix')
  })

  it('满方块格（石头）⇒ 宿主 NEI 回退，与基线一致', () => {
    const { hoverRef, api } = makeTooltip({})
    hoverRef.value = blockHover(STONE, 1, null)
    expect(api.tooltipText.value).toBe('Stone')
  })
})

describe('useEmbedTooltip — 逐格人工说明叠加层（两条链不互相替代）', () => {
  const defWithNote = {
    ...ae2Def,
    cellTooltipGrid: [[[0, -1]]],
  } as unknown as StructureDefinition

  it('部件命中 + 逐格说明 ⇒ 逐格说明优先，标题 = 部件 displayName', () => {
    const { hoverRef, api } = makeTooltip({ def: defWithNote, palette: ['人工说明'] })
    hoverRef.value = blockHover(CABLE_BUS, 0, partUp)
    expect(api.tooltipText.value).toBe('ME Storage Bus\n人工说明')
  })

  it('宿主格命中 + 逐格说明 ⇒ 标题 = 宿主 NEI 首行（既有规则）', () => {
    const { hoverRef, api } = makeTooltip({ def: defWithNote, palette: ['人工说明'] })
    hoverRef.value = blockHover(CABLE_BUS, 0, null)
    expect(api.tooltipText.value).toBe('ME Glass Cable - Fluix\n人工说明')
  })

  it('满方块格无逐格说明（-1）⇒ 宿主 NEI 回退不受部件链影响', () => {
    const { hoverRef, api } = makeTooltip({ def: defWithNote, palette: ['人工说明'] })
    hoverRef.value = blockHover(STONE, 1, null)
    expect(api.tooltipText.value).toBe('Stone')
  })
})

describe('useEmbedTooltip — 既有门禁与旁路不变', () => {
  it('showHoverTooltip 关闭 ⇒ 视口 tooltip 为空（即使部件命中）', () => {
    const { hoverRef, api } = makeTooltip({ showHover: false })
    hoverRef.value = blockHover(CABLE_BUS, 0, partUp)
    expect(api.tooltipText.value).toBe('')
  })

  it('侧栏悬停不携带部件 ⇒ NEI 全行（既有行为）', () => {
    const { hoverRef, api } = makeTooltip({})
    hoverRef.value = { kind: 'block', source: 'sidebar', blockId: CABLE_BUS, clientX: 0, clientY: 0 }
    expect(api.tooltipText.value).toBe('ME Glass Cable - Fluix')
  })

  it('无 hover / 无定义 ⇒ 空串', () => {
    const { api } = makeTooltip({})
    expect(api.tooltipText.value).toBe('')
    const { hoverRef, api: api2 } = makeTooltip({ def: null })
    hoverRef.value = blockHover(CABLE_BUS, 0, partUp)
    expect(api2.tooltipText.value).toBe('')
  })
})

// ---------------------------------------------------------------------------
// B-4（#37）：侧栏物品行 → 物品索引表文案通道
// ---------------------------------------------------------------------------

/** 物品索引条目（契约 §2.2 落盘形态；与 mod 侧 ItemIndexIntegrator 逐字段对齐） */
function itemEntry(display: string, tooltip: string[], withPartHit = true): Record<string, unknown> {
  return {
    display,
    tooltip,
    source: withPartHit ? 'part' : 'none',
    attribution: withPartHit ? [{ source: 'part', frame: 0, grid: [0, 0, 0], localId: 'ae2:UP' }] : [],
  }
}

/** 同一份 ae2 渲染定义 + 手工构造的文档根级 `itemIndex`（单元层允许直接构造根字段） */
function defWithItemIndex(index: Record<string, unknown>): StructureDefinition {
  return { ...(ae2Def as unknown as Record<string, unknown>), itemIndex: index } as unknown as StructureDefinition
}

function sidebarHover(blockId: string): EmbedHover {
  return { kind: 'block', source: 'sidebar', blockId, clientX: 0, clientY: 0 }
}

const STORAGE_ITEM_KEY = 'appliedenergistics2:item.ItemMultiPart:220'
const TOGGLE_ITEM_KEY = 'appliedenergistics2:item.ItemMultiPart:80'

describe('B-4 侧栏物品行：物品身份键 → itemIndex 说明行', () => {
  it('物品行键命中 ⇒ 文案 = 该物品 tooltip（不是 "0"、不是宿主方块名）', () => {
    const def = defWithItemIndex({
      [STORAGE_ITEM_KEY]: itemEntry('ME Storage Bus', ['ME Storage Bus', '§7物品说明行']),
    })
    const { hoverRef, api } = makeTooltip({ def })
    hoverRef.value = sidebarHover(STORAGE_ITEM_KEY)
    const text = api.tooltipText.value
    expect(text).toContain('ME Storage Bus')
    expect(text).toContain('物品说明行')
    expect(text).not.toBe('0') // 旧实现的键错配回退产物
    expect(text).not.toContain('Fluix') // 不是宿主方块名
    expect(text).not.toContain('0')
  })

  it('同表不同物品键 ⇒ 不同文案（单一数据源 = itemIndex，逐键取用）', () => {
    const def = defWithItemIndex({
      [STORAGE_ITEM_KEY]: itemEntry('ME Storage Bus', ['ME Storage Bus']),
      [TOGGLE_ITEM_KEY]: itemEntry('ME Toggle Bus', ['ME Toggle Bus']),
    })
    const { hoverRef, api } = makeTooltip({ def })
    hoverRef.value = sidebarHover(STORAGE_ITEM_KEY)
    const storage = api.tooltipText.value
    hoverRef.value = sidebarHover(TOGGLE_ITEM_KEY)
    const toggle = api.tooltipText.value
    expect(storage).toContain('ME Storage Bus')
    expect(toggle).toContain('ME Toggle Bus')
    expect(storage).not.toBe(toggle)
  })

  it('空说明兜底：itemIndex 条目 tooltip 空 ⇒ 至少 display 一行（通道不掏空）', () => {
    const def = defWithItemIndex({ [STORAGE_ITEM_KEY]: itemEntry('ME Storage Bus', []) })
    const { hoverRef, api } = makeTooltip({ def })
    hoverRef.value = sidebarHover(STORAGE_ITEM_KEY)
    expect(api.tooltipText.value).toBe('ME Storage Bus')
  })

  it('显式无对应（attribution 空）⇒ 仍有 display 一行（"任何情况有话说"）', () => {
    const def = defWithItemIndex({ [STORAGE_ITEM_KEY]: itemEntry('ME Storage Bus', [], false) })
    const { hoverRef, api } = makeTooltip({ def })
    hoverRef.value = sidebarHover(STORAGE_ITEM_KEY)
    expect(api.tooltipText.value).toBe('ME Storage Bus')
  })

  it('两类键不混用：物品键不查 neiTooltipMap，宿主键仍走 NEI（旧文件宿主行不回归）', () => {
    // 物品键**不在** blockPalette 键集里（block_registry 键 = registryId[@meta]）
    const { hoverRef, api } = makeTooltip({ def: defWithItemIndex({}) })
    hoverRef.value = sidebarHover(STORAGE_ITEM_KEY)
    // 都不中 ⇒ 行键本身（旧实现的 "取最后冒号之后" 会给 "220"）
    expect(api.tooltipText.value).toBe(STORAGE_ITEM_KEY)
    // 宿主键（block_registry 键）⇒ NEI 既有语义不变
    hoverRef.value = sidebarHover(CABLE_BUS)
    expect(api.tooltipText.value).toBe('ME Glass Cable - Fluix')
  })

  it('键巧合同形时物品索引表优先（单一数据源 = itemIndex）', () => {
    const def = defWithItemIndex({ [CABLE_BUS]: itemEntry('物品级说明', ['物品级说明']) })
    const { hoverRef, api } = makeTooltip({ def })
    hoverRef.value = sidebarHover(CABLE_BUS)
    expect(api.tooltipText.value).toBe('物品级说明')
    expect(api.tooltipText.value).not.toContain('Fluix')
  })

  it('旧文件（无 itemIndex）⇒ 空表，宿主行语义逐字节不变', () => {
    const { hoverRef, api } = makeTooltip({}) // ae2Def 无 itemIndex
    expect(api.tooltipText.value).toBe('')
    hoverRef.value = sidebarHover(CABLE_BUS)
    expect(api.tooltipText.value).toBe('ME Glass Cable - Fluix')
  })

  it('showHoverTooltip 门禁：侧栏物品行不受该开关影响（门禁沿用现状，只在视口路径）', () => {
    const def = defWithItemIndex({ [STORAGE_ITEM_KEY]: itemEntry('ME Storage Bus', ['ME Storage Bus']) })
    const { hoverRef, api } = makeTooltip({ def, showHover: false })
    hoverRef.value = sidebarHover(STORAGE_ITEM_KEY)
    expect(api.tooltipText.value).toBe('ME Storage Bus')
  })
})
