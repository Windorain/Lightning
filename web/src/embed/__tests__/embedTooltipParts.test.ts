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
import { useEmbedTooltip } from '@/embed/useEmbedTooltip'
import { RuntimeDocument } from '@/context/runtimeDocument'
import type { EmbedHover } from '@/runtime/hover'
import type { PartTooltipInfo } from '@/pure/tooltipResolution'
import type { StructureDefinition } from '@/render/schema/types'
import { renderTooltipHtml } from '@/pure/renderTooltipHtml'

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
    docRef: ref(doc),
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
    expect(api.tooltipText.value).toBe(renderTooltipHtml('ME Glass Cable - Fluix'))
  })

  it('满方块格（石头）⇒ 宿主 NEI 回退，与基线一致', () => {
    const { hoverRef, api } = makeTooltip({})
    hoverRef.value = blockHover(STONE, 1, null)
    expect(api.tooltipText.value).toBe(renderTooltipHtml('Stone'))
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
    expect(api.tooltipText.value).toBe(renderTooltipHtml('Stone'))
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
    expect(api.tooltipText.value).toBe(renderTooltipHtml('ME Glass Cable - Fluix'))
  })

  it('无 hover / 无定义 ⇒ 空串', () => {
    const { api } = makeTooltip({})
    expect(api.tooltipText.value).toBe('')
    const { hoverRef, api: api2 } = makeTooltip({ def: null })
    hoverRef.value = blockHover(CABLE_BUS, 0, partUp)
    expect(api2.tooltipText.value).toBe('')
  })
})
