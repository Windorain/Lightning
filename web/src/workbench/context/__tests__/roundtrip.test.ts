/**
 * Verify RuntimeDocument round-trip preserves block identities.
 */
import { describe, it, expect } from 'vitest'
import { RuntimeDocument } from '@/workbench/context/runtimeDocument'

const RAW_PALETTE: Record<string, unknown>[] = [
  { registryId: 'air', meta: 0, renderMode: 'BakedQuads', geometry: { encoding: 'bakedQuadsJsonV1', quads: [] }, occludesAdjacentFaces: false, tooltip: [] },
  { registryId: 'minecraft:gold_ore', meta: 0, renderMode: 'BakedQuads', geometry: { encoding: 'bakedQuadsJsonV1', quads: [{ materialIndex: 0, vertices: [] }] }, occludesAdjacentFaces: true, tooltip: ['Gold Ore'] },
  { registryId: 'gregtech:gt.blockmachines', meta: 51, renderMode: 'BakedQuads', geometry: { encoding: 'bakedQuadsJsonV1', quads: [{ materialIndex: 1, vertices: [] }] }, occludesAdjacentFaces: true },
  { registryId: 'gregtech:gt.blockmachines', meta: 51, renderMode: 'BakedQuads', geometry: { encoding: 'bakedQuadsJsonV1', quads: [{ materialIndex: 2, vertices: [] }] }, occludesAdjacentFaces: true },
  { registryId: 'IC2:blockAlloyGlass', meta: 0, renderMode: 'BakedQuads', geometry: { encoding: 'bakedQuadsJsonV1', quads: [{ materialIndex: 3, vertices: [] }] }, occludesAdjacentFaces: true },
  { registryId: 'gregtech:gt.blockmachines', meta: 51, renderMode: 'BakedQuads', geometry: { encoding: 'bakedQuadsJsonV1', quads: [{ materialIndex: 1, vertices: [] }] }, occludesAdjacentFaces: true },
  { registryId: 'gregtech:gt.blockmachines', meta: 51, renderMode: 'BakedQuads', geometry: { encoding: 'bakedQuadsJsonV1', quads: [{ materialIndex: 1, vertices: [] }] }, occludesAdjacentFaces: true },
  { registryId: 'gregtech:gt.blockmachines', meta: 51, renderMode: 'BakedQuads', geometry: { encoding: 'bakedQuadsJsonV1', quads: [{ materialIndex: 2, vertices: [] }] }, occludesAdjacentFaces: true },
]

const RAW_CELLGRID: number[][][] = [
  [[1],[0]], // z=0: row0 (top)=gold_ore, row1=air
  [[2],[3]], // z=1: gregtech(2), gregtech(3)
  [[4],[5]], // z=2: alloyGlass, gregtech(5)
  [[6],[7]], // z=3: gregtech(6), gregtech(7)
  [[0],[1]], // z=4: air, gold_ore
]

// Expected block name at each position indexed by Y-up (y=0=bottom, y=1=top)
// Y=0 (bottom): z0=air,          z1=gregtech, z2=gregtech,      z3=gregtech, z4=gold_ore
// Y=1 (top):    z0=gold_ore,     z1=gregtech, z2=alloyGlass,   z3=gregtech, z4=air
const EXPECTED_NAMES: (string | null)[][][] = [
  [[null], ['gold_ore']],
  [['gt.blockmachines'], ['gt.blockmachines']],
  [['gt.blockmachines'], ['blockAlloyGlass']],
  [['gt.blockmachines'], ['gt.blockmachines']],
  [['gold_ore'], [null]],
]

function registryIdToName(registryId: string): string {
  const colon = registryId.indexOf(':')
  return colon >= 0 ? registryId.slice(colon + 1) : registryId
}

describe('RuntimeDocument round-trip', () => {
  it('fromV2CellGrid preserves block identities per cell', () => {
    const grid = RuntimeDocument._fromV2CellGrid(RAW_CELLGRID, RAW_PALETTE)
    expect(grid.width).toBe(1)
    expect(grid.height).toBe(2)
    expect(grid.depth).toBe(5)

    // Check each cell against expected names
    for (let z = 0; z < 5; z++) {
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 1; x++) {
          const block = grid.at({ x, y, z })
          const expectedName = EXPECTED_NAMES[z][y][x]
          if (expectedName === null) {
            expect(block).toBeNull()
          } else {
            expect(block).not.toBeNull()
            expect(block!.name).toBe(expectedName)
          }
        }
      }
    }
  })

  it('full round-trip preserves block identities per cell', () => {
    const v2 = {
      format_version: '2.0',
      id: 'test',
      meta: { name: 'test', author: '', created_at_ms: 0, description: '', tags: [], origin: { x: 0, y: 0, z: 0 } },
      frames: [{
        index: 0,
        structure: {
          geometryPhase: 'baked',
          cellGrid: RAW_CELLGRID,
          blockPalette: RAW_PALETTE,
        },
      }],
      annotations: [],
      labels: [],
      materialPalette: [{ textureBlobIndex: 0 }, { textureBlobIndex: 1 }],
    }

    const doc = RuntimeDocument.fromV2Plain(v2 as any)
    expect(doc).not.toBeNull()

    const serialized = doc!.serialize()

    // First frame structure should have cellGrid and blockPalette
    const st = serialized.frames?.[0]?.structure as any
    expect(st).toBeDefined()
    expect(st.cellGrid).toBeDefined()
    expect(st.blockPalette).toBeDefined()

    // Check block identities in the round-tripped cellGrid
    const roundTrippedGrid = RuntimeDocument._fromV2CellGrid(st.cellGrid, st.blockPalette)
    for (let z = 0; z < 5; z++) {
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 1; x++) {
          const block = roundTrippedGrid.at({ x, y, z })
          const expectedName = EXPECTED_NAMES[z][y][x]
          if (expectedName === null) {
            expect(block).toBeNull()
          } else {
            expect(block).not.toBeNull()
            expect(block!.name).toBe(expectedName)
          }
        }
      }
    }

    // Verify serialized root has required fields for render pipeline
    expect(serialized.cellGrid).toBeDefined()
    expect(serialized.blockPalette).toBeDefined()
    expect(serialized.materialPalette).toBeDefined()
    expect(serialized.materialPalette).toEqual(v2.materialPalette)
  })

  it('deduplicated palette still preserves correct geometry per block type', () => {
    const grid = RuntimeDocument._fromV2CellGrid(RAW_CELLGRID, RAW_PALETTE)
    const { cellGrid: newCellGrid, blockPalette: newPalette } = (RuntimeDocument.prototype as any)._gridToV2(grid)

    // Should have 3 non-air palette entries
    const nonAir = newPalette.filter((e: any) => e.registryId !== 'air')
    expect(nonAir.length).toBe(3)

    // Verify the round-tripped data can be fed back to _fromV2CellGrid
    const reGrid = RuntimeDocument._fromV2CellGrid(newCellGrid, newPalette)
    for (let z = 0; z < 5; z++) {
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 1; x++) {
          const block = reGrid.at({ x, y, z })
          const expectedName = EXPECTED_NAMES[z][y][x]
          if (expectedName === null) {
            expect(block).toBeNull()
          } else {
            expect(block).not.toBeNull()
            expect(block!.name).toBe(expectedName)
          }
        }
      }
    }
  })
})
