/**
 * 单方块 1×1×1 六面外露 + MC 物品栏视角组，仅由 BlockIconCache 调用以 RTT 烘焙。
 * 内含物品栏槽位矩阵（原 mcItemViewMatrix）。
 */

import * as THREE from 'three'

import type { MaterialLibraryApi } from '../materials/simpleMaterialLibrary'
import { buildBlockMesh } from '../mesh/blockMesh'
import type { BlockPaletteEntry, MaterialPaletteEntry, StructureDefinition } from '../schema/types'

/** 矩阵或光照变更时递增，用于缓存失效 */
export const MC_ITEM_SLOT_BAKE_REVISION = '11'

const MC_DEG = Math.PI / 180

function makeMcItemSlotBlockMatrix(): THREE.Matrix4 {
  const m = new THREE.Matrix4()
  m.identity()
  m.multiply(new THREE.Matrix4().makeScale(-1, 1, 1))
  m.multiply(new THREE.Matrix4().makeRotationZ(Math.PI))
  m.multiply(new THREE.Matrix4().makeScale(1, 1, -1))
  m.multiply(new THREE.Matrix4().makeRotationX(150 * MC_DEG))
  m.multiply(new THREE.Matrix4().makeRotationY(-45 * MC_DEG))
  return m
}

function createMcItemSlotViewRoot(): { root: THREE.Group; meshParent: THREE.Group } {
  const root = new THREE.Group()
  const g = new THREE.Group()
  g.matrixAutoUpdate = false
  g.matrix.copy(makeMcItemSlotBlockMatrix())
  g.updateMatrixWorld(true)
  root.add(g)
  return { root, meshParent: g }
}

export interface SingleBlockBakeResult {
  group: THREE.Group
  dispose: () => void
}

/**
 * 使用与结构网格相同的 1×1×1 体素坐标（column=0, row=0, zSlice=0），六面均生成面片。
 */
const AIR_ICON_PALETTE: BlockPaletteEntry = {
  registryId: 'air',
  meta: 0,
  occludesAdjacentFaces: false,
  renderMode: 'BakedQuads',
  geometry: { encoding: 'bakedQuadsJsonV1', quads: [] },
}

/**
 * 自 blockPalette 条目的烘焙几何构建物品栏视角。
 */
export async function buildSingleBlockPreviewFromBakedPalette(
  entry: BlockPaletteEntry,
  materialPalette: MaterialPaletteEntry[],
  library: MaterialLibraryApi,
): Promise<SingleBlockBakeResult> {
  const blockPalette: BlockPaletteEntry[] = [
    AIR_ICON_PALETTE,
    { ...entry, geometry: { ...entry.geometry, quads: [...entry.geometry.quads] } },
  ]
  const miniDef: StructureDefinition = {
    geometryPhase: 'baked',
    id: 'icon-bake',
    blockPalette,
    materialPalette,
    cellGrid: [[[1]]],
  }
  const built = await buildBlockMesh(miniDef, library, {
    layerPreview: 'all',
  })
  const { root, meshParent } = createMcItemSlotViewRoot()
  while (built.group.children.length > 0) {
    const ch = built.group.children[0]
    built.group.remove(ch)
    meshParent.add(ch)
  }
  const dispose = () => {
    built.dispose()
  }
  return { group: root, dispose }
}

/** 用于缓存失效：对 blockPalette 做稳定摘要（无加密，仅变更检测） */
export function summarizeBlocksForCache(def: StructureDefinition): string {
  return def.blockPalette.map((e, i) => `${i}:${e.registryId}@${e.meta}`).join('|')
}
