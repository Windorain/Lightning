/**
 * 体素路径：cellGrid → blockPalette[i].geometry（有序 BakedQuads）+ materialPalette。
 * 几何收集的算法核心见 {@link structureGeometryCore}；本文件负责 Three.js 适配与批次渲染。
 */

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

import type { MaterialBlendMode, MaterialPaletteEntry, StructureDefinition } from '../schema/types'
import type { MaterialLibraryApi } from '../materials/simpleMaterialLibrary'
import { batchMaterialCacheKey, type BatchDescriptor } from './batchDescriptor'
import {
  collectStructureGeometryPiecesPure,
  type BakedQuadGeometryPiece,
  type BlockMeshBuildStats,
  type StructureGeometryGatherOptions,
  type UndefinedBlockDetail,
} from './structureGeometryCore'

export type { BlockMeshBuildStats, UndefinedBlockDetail } from './structureGeometryCore'

/** 顶点色批次：`MeshStandardMaterial.color` 保持白，染色仅来自 `geometry.attributes.color` */
const BATCH_VERTEX_COLOR_TINT = new THREE.Color(0xffffff)

export interface BuildBlockMeshOptions extends StructureGeometryGatherOptions {}

/** prepare 后应有 blend；`??` 仅防御未走 hydrate 的调用路径 */
function materialBlendModeFromPaletteEntry(entry: MaterialPaletteEntry): MaterialBlendMode {
  return entry.blend ?? 'opaque'
}

function pieceToBufferGeometry(piece: BakedQuadGeometryPiece): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(piece.positions), 3))
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(piece.uvs), 2))
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(piece.colors), 3))
  g.computeVertexNormals()
  g.userData.globalQuadIndex = piece.quadOrder
  return g
}

export interface BlockMeshResult {
  group: THREE.Group
  dispose: () => void
  stats: BlockMeshBuildStats
}

export interface QuadWorkUnit {
  materialIndex: number
  geom: THREE.BufferGeometry
  quadOrder: number
  matPalette: MaterialPaletteEntry
  col: number
  row: number
  zSlice: number
}

export function gatherQuadWorkUnits(
  def: StructureDefinition,
  options?: BuildBlockMeshOptions,
): { workUnits: QuadWorkUnit[]; stats: BlockMeshBuildStats } {
  const { pieces, stats } = collectStructureGeometryPiecesPure(def, options)
  const workUnits: QuadWorkUnit[] = pieces.map((p) => ({
    materialIndex: p.materialIndex,
    geom: pieceToBufferGeometry(p),
    quadOrder: p.quadOrder,
    matPalette: p.matPalette,
    col: p.col,
    row: p.row,
    zSlice: p.zSlice,
  }))
  return { workUnits, stats }
}

export async function buildBlockMesh(
  def: StructureDefinition,
  library: MaterialLibraryApi,
  options?: BuildBlockMeshOptions,
): Promise<BlockMeshResult> {
  const { workUnits, stats } = gatherQuadWorkUnits(def, options)

  const batches = new Map<string, { descriptor: BatchDescriptor; units: QuadWorkUnit[] }>()
  for (const w of workUnits) {
    const descriptor: BatchDescriptor = {
      materialId: String(w.materialIndex),
      blend: materialBlendModeFromPaletteEntry(w.matPalette),
      tint: BATCH_VERTEX_COLOR_TINT,
      useVertexColor: true,
    }
    const key = batchMaterialCacheKey(descriptor)
    let b = batches.get(key)
    if (!b) {
      b = { descriptor, units: [] }
      batches.set(key, b)
    }
    b.units.push(w)
  }

  for (const b of batches.values()) {
    b.units.sort((a, c) => a.quadOrder - c.quadOrder)
  }

  const sortedBatchEntries = [...batches.entries()].sort(([, a], [, c]) => {
    const oa = a.units[0]?.quadOrder ?? 0
    const oc = c.units[0]?.quadOrder ?? 0
    return oa - oc
  })

  const group = new THREE.Group()
  const meshes: THREE.Mesh[] = []

  let batchIdx = 0
  for (const [, bucket] of sortedBatchEntries) {
    const geoms = bucket.units.map((x) => x.geom)
    const merged = mergeGeometries(geoms, false)
    if (!merged) continue
    const mat = await library.getMaterialForBatch(bucket.descriptor)
    const mesh = new THREE.Mesh(merged, mat)
    const minOrder = bucket.units.reduce((m, u) => Math.min(m, u.quadOrder), Number.POSITIVE_INFINITY)
    mesh.renderOrder = Number.isFinite(minOrder) ? Math.floor(minOrder) : batchIdx
    group.add(mesh)
    meshes.push(mesh)
    batchIdx++
  }

  const dispose = () => {
    for (const m of meshes) {
      m.geometry.dispose()
    }
  }

  return {
    group,
    dispose,
    stats,
  }
}

const STATUS_DETAIL_MAX = 520

export function formatUndefinedBlockDetailsForStatus(details: UndefinedBlockDetail[]): string {
  if (!details.length) return ''
  const segments: string[] = []
  for (const d of details) {
    const tag = d.reason === 'decode_error' ? 'DECODE' : 'SPECIAL'
    segments.push(`${tag} ${d.registryKey}×${d.voxelCount}`)
  }
  let out = ` · ${segments.join('；')}`
  if (out.length > STATUS_DETAIL_MAX) {
    out = `${out.slice(0, STATUS_DETAIL_MAX - 1)}…`
  }
  return out
}
