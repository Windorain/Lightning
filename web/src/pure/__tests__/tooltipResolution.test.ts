/**
 * P2.2 — tooltip 说明优先级链纯函数测试（pure/tooltipResolution.ts）。
 *
 * 覆盖：
 *  - 回归锁定：`part == null` 时 resolveViewportTooltipChain 与 P2.2 前行为逐字节一致
 *    （逐格说明原名 prepend 规则、宿主 NEI 首行回退、空 ⇒ ''）
 *  - 部件命中：标题 = displayName；说明 = 部件 tooltip（导出时最终行）；
 *    归属标注「位于 <宿主名>」（宿主名 ≠ 部件名时）
 *  - 逐格人工说明为叠加层：有则优先（标题换成部件 displayName），部件说明作回退
 *  - 部件说明为空 ⇒ 落宿主回退（任何情况有话说，契约 §8）
 */
import { describe, it, expect } from 'vitest'
import {
  resolvePreviewTooltipText,
  resolveViewportTooltipChain,
  type PartTooltipInfo,
  type PreviewTooltipHover,
} from '@/pure/tooltipResolution'
import { renderTooltipHtml } from '@/pure/renderTooltipHtml'
import { TOOLTIP_GRID_NONE, type StructureDefinition } from '@/render/schema/types'

// ---- 既有逐格说明解析（P2.2 未触碰，钉住行为） ----

function defWithCellTooltip(cell: number): StructureDefinition {
  return {
    cellTooltipGrid: [[[cell]]],
  } as unknown as StructureDefinition
}

const hoverAt: PreviewTooltipHover = {
  blockId: 'minecraft:stone',
  clientX: 0,
  clientY: 0,
  source: 'viewport',
  voxel: { column: 0, row: 0, zSlice: 0 },
}

describe('resolvePreviewTooltipText（既有行为回归）', () => {
  it('逐格说明命中 / NONE / 越界 / 空池 / sidebar', () => {
    const palette = ['人工说明甲', '人工说明乙']
    expect(resolvePreviewTooltipText(defWithCellTooltip(1), palette, hoverAt)).toBe('人工说明乙')
    expect(resolvePreviewTooltipText(defWithCellTooltip(TOOLTIP_GRID_NONE), palette, hoverAt)).toBe('')
    expect(resolvePreviewTooltipText(defWithCellTooltip(9), palette, hoverAt)).toBe('')
    expect(resolvePreviewTooltipText(defWithCellTooltip(0), [], hoverAt)).toBe('')
    expect(resolvePreviewTooltipText(defWithCellTooltip(0), palette, null)).toBe('')
    expect(
      resolvePreviewTooltipText(defWithCellTooltip(0), palette, { ...hoverAt, source: 'sidebar' }),
    ).toBe('')
  })
})

// ---- 优先级链 ----

const hostNei = ['ME Glass Cable - Fluix', '宿主第二行']
const partUp: PartTooltipInfo = {
  localId: 'ae2:UP',
  displayName: 'ME Storage Bus',
  tooltip: ['ME Storage Bus'],
}
const partNorth: PartTooltipInfo = {
  localId: 'ae2:NORTH',
  displayName: 'ME Toggle Bus',
  tooltip: ['ME Toggle Bus', '额外说明行'],
}

describe('resolveViewportTooltipChain — 回归锁定（part == null ⇒ 与 P2.2 前逐字节一致）', () => {
  it('逐格说明 + 宿主名不同 ⇒ 宿主名 prepend（既有规则）', () => {
    expect(
      resolveViewportTooltipChain({ cellText: '人工说明', part: null, hostNeiLines: hostNei }),
    ).toBe('ME Glass Cable - Fluix\n人工说明')
  })

  it('逐格说明首行已等于宿主名 ⇒ 不重复 prepend（既有规则）', () => {
    expect(
      resolveViewportTooltipChain({ cellText: 'ME Glass Cable - Fluix\n第二行', part: null, hostNeiLines: hostNei }),
    ).toBe('ME Glass Cable - Fluix\n第二行')
  })

  it('逐格说明但无宿主 NEI ⇒ 原文返回（既有规则）', () => {
    expect(
      resolveViewportTooltipChain({ cellText: '人工说明', part: null, hostNeiLines: undefined }),
    ).toBe('人工说明')
  })

  it('无逐格说明 ⇒ 宿主 NEI 首行回退（renderTooltipHtml，既有规则）', () => {
    expect(
      resolveViewportTooltipChain({ cellText: '', part: null, hostNeiLines: hostNei }),
    ).toBe(renderTooltipHtml('ME Glass Cable - Fluix'))
  })

  it('什么都没有 ⇒ 空串（既有规则）', () => {
    expect(resolveViewportTooltipChain({ cellText: '', part: null, hostNeiLines: undefined })).toBe('')
    expect(resolveViewportTooltipChain({ cellText: '', part: null, hostNeiLines: [] })).toBe('')
  })
})

describe('resolveViewportTooltipChain — 部件命中（P2.2）', () => {
  it('部件说明 = 导出最终行；标题 = displayName；附归属标注「位于 <宿主名>」', () => {
    expect(
      resolveViewportTooltipChain({ cellText: '', part: partUp, hostNeiLines: hostNei }),
    ).toBe('ME Storage Bus\n位于 ME Glass Cable - Fluix')
  })

  it('同格不同部件 ⇒ 不同说明（硬约束）', () => {
    const up = resolveViewportTooltipChain({ cellText: '', part: partUp, hostNeiLines: hostNei })
    const north = resolveViewportTooltipChain({ cellText: '', part: partNorth, hostNeiLines: hostNei })
    expect(up).not.toBe(north)
    expect(north).toBe('ME Toggle Bus\n额外说明行\n位于 ME Glass Cable - Fluix')
  })

  it('部件 tooltip 首行 ≠ displayName ⇒ displayName 提到首行（标题保证）', () => {
    const part: PartTooltipInfo = { localId: 'x:0', displayName: '显示名', tooltip: ['说明首行', '说明次行'] }
    expect(
      resolveViewportTooltipChain({ cellText: '', part, hostNeiLines: hostNei }),
    ).toBe('显示名\n说明首行\n说明次行\n位于 ME Glass Cable - Fluix')
  })

  it('宿主名 == 部件名（单盒方块宿主即部件自身）⇒ 不附归属标注', () => {
    const slab: PartTooltipInfo = { localId: 'generic:0', displayName: 'Stone Slab', tooltip: ['Stone Slab'] }
    expect(
      resolveViewportTooltipChain({ cellText: '', part: slab, hostNeiLines: ['Stone Slab'] }),
    ).toBe('Stone Slab')
  })

  it('无宿主 NEI ⇒ 部件说明照显，归属标注省略', () => {
    expect(
      resolveViewportTooltipChain({ cellText: '', part: partUp, hostNeiLines: undefined }),
    ).toBe('ME Storage Bus')
  })

  it('逐格人工说明是叠加层：有则优先，标题换成部件 displayName（两条链不互相替代）', () => {
    expect(
      resolveViewportTooltipChain({ cellText: '人工说明', part: partUp, hostNeiLines: hostNei }),
    ).toBe('ME Storage Bus\n人工说明')
  })

  it('逐格说明首行已等于部件 displayName ⇒ 不重复 prepend', () => {
    expect(
      resolveViewportTooltipChain({ cellText: 'ME Storage Bus\n人工说明', part: partUp, hostNeiLines: hostNei }),
    ).toBe('ME Storage Bus\n人工说明')
  })

  it('部件说明与 displayName 皆空 ⇒ 落宿主回退（任何情况有话说）', () => {
    const empty: PartTooltipInfo = { localId: 'x:0', displayName: '', tooltip: [] }
    expect(
      resolveViewportTooltipChain({ cellText: '', part: empty, hostNeiLines: hostNei }),
    ).toBe(renderTooltipHtml('ME Glass Cable - Fluix'))
    expect(
      resolveViewportTooltipChain({ cellText: '', part: empty, hostNeiLines: undefined }),
    ).toBe('')
  })
})
