/**
 * BlockMeshProvider — 遍历 cellGrid，用 BlockHandler 产出几何。
 * 复用 structureGeometryCore（遍历/剔除）+ blockMesh（合批/材质）。
 */

import type { StructureDefinition, BlockPaletteEntry, BakedModelPaletteEntry, BlockModelPaletteEntry } from '../schema/types'
import type { MaterialLibraryApi } from '../materials/simpleMaterialLibrary'
import type { MeshProvider, MeshOutput, BlockHandler, BlockOutput, VoxelContext } from './providerTypes'
import { blockModelQuadsFromParts } from './structureGeometryCore'
import { decodeBakedGeometry } from './bakedGeometryDecode'
import { buildBlockMesh } from './blockMesh'

// ── 默认 BlockHandler ──

class BakedModelHandler implements BlockHandler {
  priority = 100
  canRender(entry: BlockPaletteEntry): boolean {
    return entry.renderMode !== 'BlockModel'
  }
  render(entry: BlockPaletteEntry, _ctx: VoxelContext): BlockOutput {
    const e = entry as BakedModelPaletteEntry
    try {
      const quads = decodeBakedGeometry(e.geometry)
      return quads.length > 0 ? { kind: 'quads', quads } : { kind: 'none' }
    } catch {
      return { kind: 'none' }
    }
  }
}

class BlockModelHandler implements BlockHandler {
  priority = 100
  canRender(entry: BlockPaletteEntry): boolean {
    return entry.renderMode === 'BlockModel'
  }
  render(entry: BlockPaletteEntry, _ctx: VoxelContext): BlockOutput {
    const e = entry as BlockModelPaletteEntry
    const quads = blockModelQuadsFromParts(e.parts)
    return quads.length > 0 ? { kind: 'quads', quads } : { kind: 'none' }
  }
}

export class BlockMeshProvider implements MeshProvider {
  priority = 100
  target = 'structure' as const

  private readonly handlers: BlockHandler[]

  constructor(extraHandlers: BlockHandler[] = []) {
    this.handlers = [
      new BakedModelHandler(),
      new BlockModelHandler(),
      ...extraHandlers,
    ].sort((a, b) => a.priority - b.priority)
  }

  async build(def: StructureDefinition, lib: MaterialLibraryApi): Promise<MeshOutput[]> {
    const result = await buildBlockMesh(def, lib, { handlers: this.handlers })
    return [{ kind: 'object3d', object: result.group }]
  }
}
