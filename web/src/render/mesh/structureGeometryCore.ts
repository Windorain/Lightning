/**
 * 烘焙结构 → 三角网格片段：**纯函数核心**（无 Three.js、无 DOM、无 I/O）。
 * 相同输入得到相同 `pieces` / `stats`；渲染与导出在适配层再转为 BufferGeometry / OBJ。
 */

import { buildVoxelVolume, structureRowToWorldY } from '../data/grid'
import { voxelLinearIndex, AIR_COMPONENT } from './voxelComponents'
import { effectiveVoxelState, type LayerPreviewMode } from '../data/layerPreview'
import type {
  BakedQuad,
  FaceName,
  MaterialPaletteEntry,
  StructureDefinition,
  VoxelVolume,
} from '../schema/types'
import { isAirState } from '../schema/types'
import { decodeBakedGeometry } from './bakedGeometryDecode'
import { vec3ToFaceNameComponents } from './facingMap'
export interface StructureGeometryGatherOptions {
  layerPreview?: LayerPreviewMode
  /**
   * 是否剔除被 opaque 邻居或同 palette 共面遮挡的四边形。
   * 预览/渲染默认剔除；OBJ 全量导出传 `false`。
   */
  cullOccludedQuads?: boolean
  /**
   * 若设置：仅收集 `componentId` 对应连通域内体素，并与邻居做域感知遮挡剔除（域间共面保留）。
   * 与 {@link labelVoxelComponents} 返回的 `labels` 对齐。
   */
  componentGather?: {
    labels: Int32Array
    componentId: number
  }
  /**
   * 可选的 BlockHandler 列表，替代内建的 renderMode 分支。
   * 传入后不再走 BakedModel/BlockModel 硬编码分发。
   */
  handlers?: import('./providerTypes').BlockHandler[]
}

export interface UndefinedBlockDetail {
  registryKey: string
  reason: 'special_no_geometry' | 'decode_error'
  voxelCount: number
}

export interface BlockMeshBuildStats {
  nonAirVoxelCount: number
  skippedUnmappedCount: number
  unknownVoxelCount: number
  undefinedBlockDetails: UndefinedBlockDetail[]
}

/** 单个烘焙四边形对应的 2 个三角形（非索引、每属性定长） */
export interface BakedQuadGeometryPiece {
  col: number
  row: number
  zSlice: number
  materialIndex: number
  quadOrder: number
  /** 该 quad 在体素解码后 quads[] 数组中的索引 */
  quadIndex: number
  matPalette: MaterialPaletteEntry
  positions: Float32Array
  uvs: Float32Array
  colors: Float32Array
}

export interface StructureGeometryCollection {
  pieces: BakedQuadGeometryPiece[]
  stats: BlockMeshBuildStats
}

function rgbTripletFromMcTessellatorColor(packed: number | undefined): [number, number, number] {
  if (packed === undefined || !Number.isFinite(packed)) return [1, 1, 1]
  const u = packed >>> 0
  const r = (u & 0xff) / 255
  const g = ((u >>> 8) & 0xff) / 255
  const b = ((u >>> 16) & 0xff) / 255
  return [r, g, b]
}

function gridStepForOutwardWorldFace(f: FaceName): { dc: number; dr: number; dz: number } {
  switch (f) {
    case '+x':
      return { dc: 1, dr: 0, dz: 0 }
    case '-x':
      return { dc: -1, dr: 0, dz: 0 }
    case '+y':
      return { dc: 0, dr: -1, dz: 0 }
    case '-y':
      return { dc: 0, dr: 1, dz: 0 }
    case '+z':
      return { dc: 0, dr: 0, dz: 1 }
    case '-z':
      return { dc: 0, dr: 0, dz: -1 }
  }
}

/** 外向世界空间面（用于遮挡与域剔除）；与烘焙四边形法线一致 */
export function outwardWorldFaceFromBakedQuadPure(
  quad: BakedQuad,
  col: number,
  row: number,
  zSlice: number,
  sizeColumn: number,
  sizeRow: number,
  sizeZSlice: number,
): FaceName | null {
  const v = quad.vertices
  if (!v || v.length !== 4) return null
  const voxelY = structureRowToWorldY(row, sizeRow)
  const ox = col - sizeColumn / 2
  const oy = voxelY - sizeRow / 2
  const oz = zSlice - sizeZSlice / 2
  const bcx = ox + 0.5
  const bcy = oy + 0.5
  const bcz = oz + 0.5

  const cx: number[] = []
  const cy: number[] = []
  const cz: number[] = []
  for (let i = 0; i < 4; i++) {
    cx.push(v[i].x + ox)
    cy.push(v[i].y + oy)
    cz.push(v[i].z + oz)
  }

  const e1x = cx[1]! - cx[0]!
  const e1y = cy[1]! - cy[0]!
  const e1z = cz[1]! - cz[0]!
  const e2x = cx[2]! - cx[0]!
  const e2y = cy[2]! - cy[0]!
  const e2z = cz[2]! - cz[0]!
  let nx = e1y * e2z - e1z * e2y
  let ny = e1z * e2x - e1x * e2z
  let nz = e1x * e2y - e1y * e2x
  const nlen = Math.hypot(nx, ny, nz)
  if (nlen < 1e-12) return null
  nx /= nlen
  ny /= nlen
  nz /= nlen

  const qcx = (cx[0]! + cx[1]! + cx[2]! + cx[3]!) * 0.25
  const qcy = (cy[0]! + cy[1]! + cy[2]! + cy[3]!) * 0.25
  const qcz = (cz[0]! + cz[1]! + cz[2]! + cz[3]!) * 0.25
  const vx = qcx - bcx
  const vy = qcy - bcy
  const vz = qcz - bcz
  if (nx * vx + ny * vy + nz * vz < 0) {
    nx = -nx
    ny = -ny
    nz = -nz
  }
  return vec3ToFaceNameComponents(nx, ny, nz)
}

function componentAt(
  labels: Int32Array,
  col: number,
  row: number,
  zSlice: number,
  sizeColumn: number,
  sizeRow: number,
  sizeZSlice: number,
): number {
  if (col < 0 || row < 0 || zSlice < 0 || col >= sizeColumn || row >= sizeRow || zSlice >= sizeZSlice) {
    return AIR_COMPONENT
  }
  return labels[voxelLinearIndex(col, row, zSlice, sizeColumn, sizeRow)] ?? AIR_COMPONENT
}

function shouldCullQuadFacingOpaqueNeighbor(
  def: StructureDefinition,
  volume: VoxelVolume,
  layerPreview: LayerPreviewMode,
  col: number,
  row: number,
  zSlice: number,
  sizeRow: number,
  worldFace: FaceName,
): boolean {
  const { dc, dr, dz } = gridStepForOutwardWorldFace(worldFace)
  const ncol = col + dc
  const nrow = row + dr
  const nz = zSlice + dz
  const nState = effectiveVoxelState(volume, ncol, nrow, nz, sizeRow, layerPreview)
  if (isAirState(nState)) return false
  const idx = def.cellGrid[nz]?.[nrow]?.[ncol]
  if (idx === undefined || idx < 0 || idx >= def.blockPalette.length) return false
  return def.blockPalette[idx].occludesAdjacentFaces === true
}

function shouldCullQuadFacingSamePaletteNeighbor(
  def: StructureDefinition,
  volume: VoxelVolume,
  layerPreview: LayerPreviewMode,
  col: number,
  row: number,
  zSlice: number,
  sizeRow: number,
  worldFace: FaceName,
  paletteIndex: number,
): boolean {
  const selfEntry = def.blockPalette[paletteIndex]
  if (selfEntry.occludesAdjacentFaces === true) return false
  const { dc, dr, dz } = gridStepForOutwardWorldFace(worldFace)
  const ncol = col + dc
  const nrow = row + dr
  const nz = zSlice + dz
  const nState = effectiveVoxelState(volume, ncol, nrow, nz, sizeRow, layerPreview)
  if (isAirState(nState)) return false
  const nidx = def.cellGrid[nz]?.[nrow]?.[ncol]
  if (nidx === undefined || nidx < 0 || nidx !== paletteIndex) return false
  if (def.blockPalette[nidx].occludesAdjacentFaces === true) return false
  return true
}

/**
 * 单四边形 → 6 顶点 × (position3 + uv2 + color3)，与 {@link blockMesh} 原 `bufferGeometryFromBakedQuad` 数值一致。
 */
export function bakedQuadTriangleAttributesPure(
  quad: BakedQuad,
  col: number,
  row: number,
  zSlice: number,
  sizeColumn: number,
  sizeRow: number,
  sizeZSlice: number,
): { positions: Float32Array; uvs: Float32Array; colors: Float32Array } | null {
  const v = quad.vertices
  if (!v || v.length !== 4) return null
  const voxelY = structureRowToWorldY(row, sizeRow)
  const ox = col - sizeColumn / 2
  const oy = voxelY - sizeRow / 2
  const oz = zSlice - sizeZSlice / 2
  const positions = new Float32Array(18)
  const uvs = new Float32Array(12)
  const colors = new Float32Array(18)
  const triCorners = [
    [0, 1, 2],
    [0, 2, 3],
  ] as const
  let pi = 0
  let ui = 0
  let ci = 0
  for (const [i0, i1, i2] of triCorners) {
    for (const i of [i0, i1, i2]) {
      const p = v[i]
      positions[pi++] = p.x + ox
      positions[pi++] = p.y + oy
      positions[pi++] = p.z + oz
      uvs[ui++] = p.u
      uvs[ui++] = p.v
      const rgb = rgbTripletFromMcTessellatorColor(p.color)
      colors[ci++] = rgb[0]
      colors[ci++] = rgb[1]
      colors[ci++] = rgb[2]
    }
  }
  return { positions, uvs, colors }
}

/** 将若干四边形片段的非索引属性拼接为一块（供体素×材质合并或外部再算法线） */
export function mergeBakedQuadPiecesAttributes(pieces: BakedQuadGeometryPiece[]): {
  positions: Float32Array
  uvs: Float32Array
  colors: Float32Array
} {
  let pt = 0
  let ut = 0
  let ct = 0
  for (const p of pieces) {
    pt += p.positions.length
    ut += p.uvs.length
    ct += p.colors.length
  }
  const positions = new Float32Array(pt)
  const uvs = new Float32Array(ut)
  const colors = new Float32Array(ct)
  let po = 0
  let uo = 0
  let co = 0
  for (const p of pieces) {
    positions.set(p.positions, po)
    po += p.positions.length
    uvs.set(p.uvs, uo)
    uo += p.uvs.length
    colors.set(p.colors, co)
    co += p.colors.length
  }
  return { positions, uvs, colors }
}

/**
 * 遍历体素网格，产出三角网格片段与统计。**无副作用**（仅分配新 TypedArray / 数组）。
 */
export function collectStructureGeometryPiecesPure(
  def: StructureDefinition,
  options?: StructureGeometryGatherOptions,
): StructureGeometryCollection {
  const layerPreview: LayerPreviewMode = options?.layerPreview ?? 'all'
  const volume = buildVoxelVolume(def)
  const { sizeColumn, sizeRow, sizeZSlice } = volume
  const { blockPalette, materialPalette } = def
  const compGather = options?.componentGather
  const cullOccluded = compGather !== undefined ? true : options?.cullOccludedQuads !== false
  const handlers = options?.handlers

  let quadSerial = 0
  const pieces: BakedQuadGeometryPiece[] = []
  let nonAirVoxelCount = 0
  let skippedUnmappedCount = 0
  const undefinedDetails = new Map<string, UndefinedBlockDetail>()

  /** Resolve quads for a block entry via handlers (preferred) or legacy hardcoded branches */
  function resolveQuads(entry: import('../schema/types').BlockPaletteEntry): { quads: import('../schema/types').BakedQuad[] } | { error: string } {
    if (handlers) {
      const h = handlers.find((x) => x.canRender(entry))
      if (!h) return { error: 'unmapped' }
      const out = h.render(entry, {
        column: 0, row: 0, zSlice: 0,
        sizeColumn, sizeRow, sizeZSlice,
      })
      if (out.kind === 'quads') return { quads: out.quads }
      if (out.kind === 'none') return { quads: [] }
      // object3d from handler not supported in this collector — caller handles separately
      return { quads: [] }
    }
    try {
      return { quads: decodeBakedGeometry(entry.geometry) }
    } catch {
      return { error: 'decode_error' }
    }
  }

  for (let zSlice = 0; zSlice < sizeZSlice; zSlice++) {
    for (let row = 0; row < sizeRow; row++) {
      for (let col = 0; col < sizeColumn; col++) {
        const state = effectiveVoxelState(volume, col, row, zSlice, sizeRow, layerPreview)
        if (isAirState(state)) continue

        if (compGather) {
          const li = voxelLinearIndex(col, row, zSlice, sizeColumn, sizeRow)
          if (compGather.labels[li] !== compGather.componentId) continue
        }

        nonAirVoxelCount++
        const idx = def.cellGrid[zSlice][row][col]
        const entry = blockPalette[idx]
        const resolved = resolveQuads(entry)
        if ('error' in resolved) {
          skippedUnmappedCount++
          const k = `${entry.registryId}@${entry.meta}`
          const prev = undefinedDetails.get(k)
          undefinedDetails.set(k, {
            registryKey: k,
            reason: resolved.error === 'decode_error' ? 'decode_error' : 'special_no_geometry',
            voxelCount: (prev?.voxelCount ?? 0) + 1,
          })
          continue
        }
        const quads = resolved.quads

        for (let qi = 0; qi < quads.length; qi++) {
          const q = quads[qi]
          if (cullOccluded) {
            const worldFace = outwardWorldFaceFromBakedQuadPure(
              q,
              col,
              row,
              zSlice,
              sizeColumn,
              sizeRow,
              sizeZSlice,
            )
            if (worldFace !== null) {
              if (compGather) {
                const labels = compGather.labels
                const selfLab = labels[voxelLinearIndex(col, row, zSlice, sizeColumn, sizeRow)]!
                const { dc, dr, dz } = gridStepForOutwardWorldFace(worldFace)
                const nLab = componentAt(
                  labels,
                  col + dc,
                  row + dr,
                  zSlice + dz,
                  sizeColumn,
                  sizeRow,
                  sizeZSlice,
                )
                if (nLab !== selfLab) {
                  /* 域边界或空气邻：不剔除 */
                } else if (
                  entry.occludesAdjacentFaces === true &&
                  shouldCullQuadFacingOpaqueNeighbor(
                    def,
                    volume,
                    layerPreview,
                    col,
                    row,
                    zSlice,
                    sizeRow,
                    worldFace,
                  )
                ) {
                  continue
                } else if (
                  shouldCullQuadFacingSamePaletteNeighbor(
                    def,
                    volume,
                    layerPreview,
                    col,
                    row,
                    zSlice,
                    sizeRow,
                    worldFace,
                    idx,
                  )
                ) {
                  continue
                }
              } else if (
                entry.occludesAdjacentFaces === true &&
                shouldCullQuadFacingOpaqueNeighbor(def, volume, layerPreview, col, row, zSlice, sizeRow, worldFace)
              ) {
                continue
              } else if (
                shouldCullQuadFacingSamePaletteNeighbor(
                  def,
                  volume,
                  layerPreview,
                  col,
                  row,
                  zSlice,
                  sizeRow,
                  worldFace,
                  idx,
                )
              ) {
                continue
              }
            }
          }
          const mi = q.materialIndex
          const matPal = materialPalette[mi]
          const attrs = bakedQuadTriangleAttributesPure(
            q,
            col,
            row,
            zSlice,
            sizeColumn,
            sizeRow,
            sizeZSlice,
          )
          if (!attrs) continue
          const order = quadSerial++
          pieces.push({
            col,
            row,
            zSlice,
            materialIndex: mi,
            quadOrder: order,
            quadIndex: qi,
            matPalette: matPal,
            positions: attrs.positions,
            uvs: attrs.uvs,
            colors: attrs.colors,
          })
        }
      }
    }
  }

  const undefinedBlockDetails = [...undefinedDetails.values()].sort((a, b) =>
    a.registryKey.localeCompare(b.registryKey),
  )

  return {
    pieces,
    stats: {
      nonAirVoxelCount,
      skippedUnmappedCount,
      unknownVoxelCount: 0,
      undefinedBlockDetails,
    },
  }
}
