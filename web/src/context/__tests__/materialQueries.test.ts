import { describe, it, expect } from 'vitest'
import { RuntimeDocument, Grid, RuntimeFrame } from '@/context/runtimeDocument'
import { listMaterials, getMaterialUsageCounts, getBlockTypeStats, getBlockPaletteEntry } from '@/context/queries'
import type { BContext } from '@/context/bContext'

function makeMockBctx(doc: RuntimeDocument | null): BContext {
  return {
    doc: { value: doc },
    selection: { items: { value: new Set() } },
    currentWorldFrameIndex: { value: 0 },
  } as unknown as BContext
}

describe('listMaterials', () => {
  it('returns empty array when no document', () => {
    expect(listMaterials(makeMockBctx(null))).toEqual([])
  })

  it('returns empty array when no materialPalette', () => {
    const doc = new RuntimeDocument({ id: 'test' })
    expect(listMaterials(makeMockBctx(doc))).toEqual([])
  })

  it('returns materials with textureDataUrl from textureBlobs', () => {
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg=='
    const doc = new RuntimeDocument({
      id: 'test',
      materialPalette: [
        { textureBlobIndex: 0, kind: 'static16', blend: 'opaque' },
        { textureBlobIndex: 1, kind: 'animated', animation: { defaultFrametimeTicks: 2 } },
      ],
      textureBlobs: { '0': pngBase64, '1': pngBase64 },
    })
    const result = listMaterials(makeMockBctx(doc))

    expect(result).toHaveLength(2)
    expect(result[0].materialId).toBe('0')
    expect(result[0].kind).toBe('static16')
    expect(result[0].blend).toBe('opaque')
    expect(result[0].textureDataUrl).toContain('data:image/png;base64,')

    expect(result[1].materialId).toBe('1')
    expect(result[1].kind).toBe('animated')
    expect(result[1].animation).toEqual({ defaultFrametimeTicks: 2 })
  })

  it('returns null textureDataUrl when textureBlobIndex is missing', () => {
    const doc = new RuntimeDocument({
      id: 'test',
      materialPalette: [
        { kind: 'static16', locator: 'minecraft:textures/blocks/stone' },
      ],
      textureBlobs: {},
    })
    const result = listMaterials(makeMockBctx(doc))

    expect(result).toHaveLength(1)
    expect(result[0].textureDataUrl).toBeNull()
    expect(result[0].locator).toBe('minecraft:textures/blocks/stone')
  })
})

describe('getMaterialUsageCounts', () => {
  it('returns empty object when no document', () => {
    expect(getMaterialUsageCounts(makeMockBctx(null))).toEqual({})
  })

  it('returns empty object when no grid in current frame', () => {
    const doc = new RuntimeDocument({ id: 'test', frames: [new RuntimeFrame(0, undefined, null)] })
    expect(getMaterialUsageCounts(makeMockBctx(doc))).toEqual({})
  })

  it('counts blocks by paletteIndex', () => {
    const cells: (any)[][][] = [[
      [{ name: 'stone', meta: 0, paletteIndex: 0 }],
      [{ name: 'dirt', meta: 0, paletteIndex: 1 }],
      [{ name: 'stone', meta: 0, paletteIndex: 0 }],
    ]]
    const grid = new Grid(1, 3, 1, cells)
    const doc = new RuntimeDocument({
      id: 'test',
      frames: [new RuntimeFrame(0, undefined, grid)],
    })
    const counts = getMaterialUsageCounts(makeMockBctx(doc))
    expect(counts).toEqual({ '0': 2, '1': 1 })
  })
})

describe('getBlockTypeStats', () => {
  it('returns stats from current frame grid', () => {
    const cells: (any)[][][] = [[
      [{ name: 'stone', meta: 0 }],
      [{ name: 'dirt', meta: 0 }],
      [{ name: 'stone', meta: 0 }],
    ]]
    const grid = new Grid(1, 3, 1, cells)
    const doc = new RuntimeDocument({ id: 'test', frames: [new RuntimeFrame(0, undefined, grid)] })
    const stats = getBlockTypeStats(makeMockBctx(doc))
    expect(stats['minecraft:stone:0']).toEqual({ count: 2 })
    expect(stats['minecraft:dirt:0']).toEqual({ count: 1 })
  })

  it('returns empty object for no grid', () => {
    const doc = new RuntimeDocument({ id: 'test' })
    expect(getBlockTypeStats(makeMockBctx(doc))).toEqual({})
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
    const entry = getBlockPaletteEntry(makeMockBctx(doc), { x: 0, y: 0, z: 0 })
    expect(entry).not.toBeNull()
    expect(entry!.nbt).toEqual({ key: 'val' })
    expect(entry!.tooltip).toEqual(['tip1'])
  })

  it('returns null for air position', () => {
    const grid = new Grid(1, 1, 1)
    const doc = new RuntimeDocument({ id: 'test', frames: [new RuntimeFrame(0, undefined, grid)] })
    expect(getBlockPaletteEntry(makeMockBctx(doc), { x: 0, y: 0, z: 0 })).toBeNull()
  })
})
