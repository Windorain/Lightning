# Panel Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development

**Goal:** Enhance three properties panels: complete scene metadata, rewrite block stats with live grid data, add multi-select + NBT + material preview to block inspector.

**Architecture:** All data access through `bctx.queries` API. Two new queries: `getBlockTypeStats()` and `getBlockPaletteEntry(pos)`. No direct RuntimeDocument internal access from panels.

**Tech Stack:** Vue 3 + TypeScript + UILayout + RNA + Vitest

---

### Task 1: Add getBlockTypeStats() and getBlockPaletteEntry() queries

**Files:**
- Modify: `web/src/workbench/context/bContext.ts`
- Modify: `web/src/workbench/context/sceneQueries.ts`
- Modify: `web/src/workbench/context/__tests__/materialQueries.test.ts`

#### Step 1: Add types and method signatures to BContextQueries

In `bContext.ts`, add after `PaletteEntryMeta` import (if not already imported) and add to `BContextQueries`:

```typescript
export interface BlockTypeStat {
  count: number
  localizedName?: string
}

// In BContextQueries, add:
  /** 当前帧方块类型统计 (block_state_id → 计数) */
  getBlockTypeStats(): Record<string, BlockTypeStat>
  /** 获取方块位置的调色板元数据 */
  getBlockPaletteEntry(pos: { x: number; y: number; z: number }): PaletteEntryMeta | null
```

#### Step 2: Implement in sceneQueries.ts

```typescript
    getBlockTypeStats(): Record<string, BlockTypeStat> {
      const stats: Record<string, BlockTypeStat> = {}
      const doc = bctx.doc.value
      if (!doc) return stats
      const rf = doc.frame(bctx.selection.frameIndex.value ?? 0)
      if (!rf?.grid) return stats
      rf.grid.forEach((_pos, block) => {
        const id = `minecraft:${block.name}:${block.meta}`
        const entry = stats[id]
        if (entry) {
          entry.count += 1
        } else {
          stats[id] = { count: 1 }
        }
      })
      return stats
    },

    getBlockPaletteEntry(pos: { x: number; y: number; z: number }) {
      const doc = bctx.doc.value
      if (!doc) return null
      const rf = doc.frame(bctx.selection.frameIndex.value ?? 0)
      if (!rf?.grid) return null
      const block = rf.grid.at(pos)
      if (!block || block.paletteIndex === undefined) return null
      const cache = rf.grid.getPaletteCache()
      return cache.get('#' + String(block.paletteIndex)) ?? null
    },
```

#### Step 3: Add tests

```typescript
describe('getBlockTypeStats', () => {
  it('returns stats from current frame grid', () => {
    const cells: (any)[][][] = [[
      [{ name: 'stone', meta: 0 }],
      [{ name: 'dirt', meta: 0 }],
      [{ name: 'stone', meta: 0 }],
    ]]
    const grid = new Grid(1, 3, 1, cells)
    const doc = new RuntimeDocument({ id: 'test', frames: [new RuntimeFrame(0, undefined, grid)] })
    const q = createProductionQueries(makeMockBctx(doc))
    const stats = q.getBlockTypeStats()
    expect(stats).toEqual({
      'minecraft:stone:0': { count: 2 },
      'minecraft:dirt:0': { count: 1 },
    })
  })
})

describe('getBlockPaletteEntry', () => {
  it('returns palette entry for block at position', () => {
    const cells: (any)[][][] = [[
      [{ name: 'stone', meta: 0, paletteIndex: 5 }],
    ]]
    const cache = new Map()
    cache.set('#5', { registryId: 'minecraft:stone', nbt: { key: 'val' }, tooltip: ['tip1'] })
    const grid = new Grid(1, 1, 1, cells, cache)
    const doc = new RuntimeDocument({ id: 'test', frames: [new RuntimeFrame(0, undefined, grid)] })
    const q = createProductionQueries(makeMockBctx(doc))
    const entry = q.getBlockPaletteEntry({ x: 0, y: 0, z: 0 })
    expect(entry).not.toBeNull()
    expect(entry!.nbt).toEqual({ key: 'val' })
    expect(entry!.tooltip).toEqual(['tip1'])
  })

  it('returns null for air position', () => {
    const grid = new Grid(1, 1, 1)
    const doc = new RuntimeDocument({ id: 'test', frames: [new RuntimeFrame(0, undefined, grid)] })
    const q = createProductionQueries(makeMockBctx(doc))
    expect(q.getBlockPaletteEntry({ x: 0, y: 0, z: 0 })).toBeNull()
  })
})
```

---

### Task 2: Extend sceneMeta RNA and update sceneInfo panel

**Files:**
- Modify: `web/src/workbench/ux/rna/structs/sceneMeta.ts`
- Modify: `web/src/workbench/ux/panels/sceneInfo.ts`

#### Step 1: Add new RNA properties

In `sceneMeta.ts`, add properties after the existing three (name, author, description):

```typescript
    {
      name: 'tags',
      type: 'string',
      label: '标签',
      description: '逗号分隔的标签列表',
      default: '',
      get(owner: any) {
        const tags = owner.meta?.tags
        return Array.isArray(tags) ? tags.join(', ') : ''
      },
      set(owner: any, val: unknown) {
        if (owner.meta) owner.meta.tags = (val as string).split(',').map((s: string) => s.trim()).filter(Boolean)
      },
    },
    {
      name: 'origin',
      type: 'string',
      label: '原点',
      description: '场景原点坐标 (x, y, z)',
      default: '0, 0, 0',
      get(owner: any) {
        const o = owner.meta?.origin
        return o ? `${o.x}, ${o.y}, ${o.z}` : '0, 0, 0'
      },
      set(owner: any, val: unknown) {
        const parts = (val as string).split(',').map(Number)
        if (owner.meta) owner.meta.origin = { x: parts[0] ?? 0, y: parts[1] ?? 0, z: parts[2] ?? 0 }
      },
    },
    {
      name: 'created_at',
      type: 'string',
      label: '创建时间',
      description: '场景创建时间戳',
      default: '',
      get(owner: any) {
        const ms = owner.meta?.created_at_ms
        return ms ? new Date(ms as number).toLocaleString() : ''
      },
      set(_owner: any, _val: unknown) {}, // read-only
    },
    {
      name: 'docId',
      type: 'string',
      label: '文档 ID',
      description: '场景唯一标识符',
      default: '',
      get(owner: any) { return owner.id ?? '' },
      set(_owner: any, _val: unknown) {}, // read-only
    },
```

#### Step 2: Update sceneInfo panel layout

Replace the layout to include all fields and remove the save button:

```typescript
layout(_ctx: BContext): UILayout {
  return {
    kind: 'column', align: false, items: [
      { kind: 'box', label: '元数据', items: [
        { kind: 'property', rnaPath: 'scenemetadata.name', label: '名称' },
        { kind: 'property', rnaPath: 'scenemetadata.author', label: '作者' },
        { kind: 'property', rnaPath: 'scenemetadata.description', label: '描述', widget: 'text' },
        { kind: 'property', rnaPath: 'scenemetadata.tags', label: '标签' },
        { kind: 'property', rnaPath: 'scenemetadata.origin', label: '原点' },
      ]},
      { kind: 'separator' },
      { kind: 'box', label: '系统', items: [
        { kind: 'property', rnaPath: 'scenemetadata.created_at', label: '创建时间' },
        { kind: 'property', rnaPath: 'scenemetadata.docId', label: '文档 ID' },
      ]},
    ],
  }
},
```

---

### Task 3: Rewrite blockStats panel

**Files:**
- Modify: `web/src/workbench/ux/panels/blockStats.ts`

#### Step 1: Rewrite using getBlockTypeStats() query

```typescript
import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout, UILayoutItem } from '../types/layout'

export const blockStatsPanel: PanelDeclaration = {
  id: 'block-stats-panel',
  label: '方块统计',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,

  poll(): boolean { return true },

  layout(ctx: BContext): UILayout {
    const stats = ctx.queries.getBlockTypeStats()
    const entries = Object.entries(stats)
    const items: UILayoutItem[] = []

    if (entries.length > 0) {
      entries.sort((a, b) => b[1].count - a[1].count)
      items.push({ kind: 'label' as const, text: `共 ${entries.length} 种方块` })
      for (const [id, stat] of entries) {
        items.push({
          kind: 'operator' as const,
          id: 'OPERATOR_SELECT_BY_TYPE',
          label: `${id}  ×${stat.count}`,
          props: { blockStateId: id },
        })
      }
    } else {
      items.push({ kind: 'label' as const, text: '(无数据)' })
    }
    return { kind: 'column', align: false, items }
  },
}
```

---

### Task 4: Enhance blockInspector for multi-select and single-block detail

**Files:**
- Modify: `web/src/workbench/ux/panels/blockInspector.ts`

#### Step 1: Rewrite with multi-select support

```typescript
import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout, UILayoutItem } from '../types/layout'
import type { BlockRef } from '@/workbench/selectionContext'

function singleBlockLayout(bctx: BContext, item: BlockRef): UILayoutItem[] {
  const paletteEntry = bctx.queries.getBlockPaletteEntry(item.pos)
  const items: UILayoutItem[] = []

  // Identity & position
  items.push(
    { kind: 'box', label: '标识', items: [
      { kind: 'property', rnaPath: 'block.id', label: '方块' },
      { kind: 'property', rnaPath: 'block.tooltip', label: 'Tooltip', widget: 'text' },
    ]},
    { kind: 'separator' },
    { kind: 'box', label: '位置', items: [
      { kind: 'property', rnaPath: 'block.pos', label: '坐标', widget: 'vector' },
    ]},
  )

  // Palette metadata
  if (paletteEntry) {
    if (paletteEntry.nbt && Object.keys(paletteEntry.nbt).length > 0) {
      const nbtItems: UILayoutItem[] = []
      for (const [key, val] of Object.entries(paletteEntry.nbt)) {
        nbtItems.push({ kind: 'label', text: `${key}: ${JSON.stringify(val)}` })
      }
      items.push(
        { kind: 'separator' },
        { kind: 'box', label: 'NBT', items: nbtItems },
      )
    }
    if (paletteEntry.tooltip && paletteEntry.tooltip.length > 0) {
      items.push({ kind: 'label', text: `Tooltip: ${paletteEntry.tooltip.join(' / ')}` })
    }
    if (paletteEntry.renderMode) {
      items.push({ kind: 'label', text: `渲染模式: ${paletteEntry.renderMode}` })
    }
    if (paletteEntry.thumbnailPNG) {
      // Show thumbnail if available
      items.push({ kind: 'label', text: '缩略图: 有' })
    }
  }

  // Material link — show palette index
  if (item.block_state_id) {
    const doc = bctx.doc.value
    if (doc) {
      const rf = doc.frame(bctx.selection.frameIndex.value ?? 0)
      const block = rf?.grid?.at(item.pos)
      if (block?.paletteIndex !== undefined) {
        items.push(
          { kind: 'separator' },
          { kind: 'label', text: `材质索引: #${block.paletteIndex}` },
        )
      }
    }
  }

  items.push(
    { kind: 'separator' },
    { kind: 'row', align: true, items: [
      { kind: 'operator', id: 'OPERATOR_TOOLTIP_EDIT', label: '编辑' },
      { kind: 'operator', id: 'OPERATOR_DELETE', label: '删除' },
    ]},
  )

  return items
}

function multiBlockLayout(items: BlockRef[]): UILayoutItem[] {
  const typeCounts = new Map<string, number>()
  for (const b of items) {
    typeCounts.set(b.block_state_id, (typeCounts.get(b.block_state_id) ?? 0) + 1)
  }
  const result: UILayoutItem[] = [
    { kind: 'label', text: `已选 ${items.length} 个方块` },
    { kind: 'label', text: `${typeCounts.size} 种类型` },
    { kind: 'separator' },
  ]
  for (const [id, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    result.push({ kind: 'label', text: `${id}  ×${count}` })
  }
  result.push(
    { kind: 'separator' },
    { kind: 'row', align: true, items: [
      { kind: 'operator', id: 'OPERATOR_DELETE', label: '删除所选' },
    ]},
  )
  return result
}

export const blockInspectorPanel: PanelDeclaration = {
  id: 'block-inspector',
  label: '方块检查器',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,

  poll(ctx: BContext): boolean {
    return ctx.selection.items.value.size >= 1
  },

  owner(ctx: BContext): unknown {
    const items = [...ctx.selection.items.value]
    if (items.length !== 1) return null
    const item = items[0]!
    const g = ctx.doc.value?.frame(0)?.grid
    ;(item as BlockRef)._gridSize = g ? { w: g.width, h: g.height, d: g.depth } : null
    return item
  },

  layout(ctx: BContext): UILayout {
    const items = [...ctx.selection.items.value]
    if (items.length === 0) {
      return { kind: 'column', align: false, items: [{ kind: 'label', text: '(无选中)' }] }
    }
    if (items.length === 1) {
      return { kind: 'column', align: false, items: singleBlockLayout(ctx, items[0]!) }
    }
    return { kind: 'column', align: false, items: multiBlockLayout(items) }
  },
}
```

---

### Task 5: Register new SELECT_BY_TYPE operator

**Files:**
- Create: `web/src/workbench/operators/builtin/selectOperator.ts` (add to existing)

Add to existing selectOperator.ts:

```typescript
export const SelectByTypeOperator: OperatorType = {
  id: 'OPERATOR_SELECT_BY_TYPE',
  label: '按类型选择',
  description: '选中所有相同类型的方块',

  poll(bctx) {
    return bctx.doc.value !== null
  },

  exec(bctx, props) {
    const blockStateId = (props?.blockStateId as string) ?? ''
    if (!blockStateId) return
    const blocks = bctx.queries.getFrameBlocks()
    bctx.selection.selectByType(blockStateId, blocks)
  },
}
```

Register in `workbenchContext.ts` ALL_OPERATORS array and import.

---

### Task 6: Register and verify

**Files:**
- Modify: `web/src/workbench/context/workbenchContext.ts` (register SelectByTypeOperator)
- Verify: TypeScript compilation + all tests pass
