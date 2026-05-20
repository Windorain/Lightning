import { describe, it, expect } from 'vitest'
import { RuntimeDocument } from '@/workbench/context/runtimeDocument'
import { createProductionQueries } from '@/workbench/context/sceneQueries'
import type { BContext } from '@/workbench/context/bContext'

function makeMockBctx(doc: RuntimeDocument): BContext {
  return {
    scene: {
      scene: { value: doc },
    },
    selection: { items: { value: new Set() } },
  } as unknown as BContext
}

describe('listMaterials', () => {
  it('returns empty array when no document', () => {
    const q = createProductionQueries({ scene: { scene: { value: null } } } as any)
    expect(q.listMaterials()).toEqual([])
  })

  it('returns empty array when no materialPalette', () => {
    const doc = new RuntimeDocument({ id: 'test' })
    const q = createProductionQueries(makeMockBctx(doc))
    expect(q.listMaterials()).toEqual([])
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
    const q = createProductionQueries(makeMockBctx(doc))
    const result = q.listMaterials()

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
    const q = createProductionQueries(makeMockBctx(doc))
    const result = q.listMaterials()

    expect(result).toHaveLength(1)
    expect(result[0].textureDataUrl).toBeNull()
    expect(result[0].locator).toBe('minecraft:textures/blocks/stone')
  })
})
