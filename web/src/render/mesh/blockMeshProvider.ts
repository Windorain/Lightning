/**
 * BlockMeshProvider — 遍历 cellGrid，用 BlockHandler 产出几何。
 * 复用 structureGeometryCore（遍历/剔除）+ blockMesh（合批/材质）。
 */

import type { StructureDefinition, BlockPaletteEntry, BakedModelPaletteEntry } from '../schema/types'
import type { MaterialLibraryApi } from '../materials/simpleMaterialLibrary'
import type { MeshProvider, MeshOutput, BlockHandler, BlockOutput, VoxelContext } from './providerTypes'
import { decodeBakedGeometry } from './bakedGeometryDecode'
import { buildBlockMesh } from './blockMesh'

// ── 默认 BlockHandler ──

class BakedModelHandler implements BlockHandler {
  priority = 100
  canRender(_entry: BlockPaletteEntry): boolean {
    return true
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

export class BlockMeshProvider implements MeshProvider {
  priority = 100
  target = 'structure' as const

  private readonly handlers: BlockHandler[]

  constructor(extraHandlers: BlockHandler[] = []) {
    this.handlers = [
      new BakedModelHandler(),
      ...extraHandlers,
    ].sort((a, b) => a.priority - b.priority)
  }

  async build(def: StructureDefinition, lib: MaterialLibraryApi, opts?: { layerPreview?: import('../data/layerPreview').LayerPreviewMode }): Promise<MeshOutput[]> {
    const result = await buildBlockMesh(def, lib, { handlers: this.handlers, layerPreview: opts?.layerPreview })
    return [{ kind: 'object3d', object: result.group, dispose: result.dispose, stats: result.stats }]
  }
}
