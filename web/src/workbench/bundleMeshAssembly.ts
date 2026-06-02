/**
 * 网格装配模块：体素聚类、图集打包、OBJ/MTL/ZIP 组装。
 *
 * 从 structureBundleExport.ts 拆分而来，见该文件 commit 历史。
 */

import JSZip from 'jszip'

import { buildTileIdToUvRect, packTextureGridByTileId } from '@/render/mesh/atlasLayout'
import { clusterCoplanarOverlappingPiecesInVoxel } from '@/render/mesh/coplanarOverlapCluster'
import {
  type ObjExportMesh,
  serializeMtl,
  serializeObjMeshes,
  type MtlSerializedEntry,
} from '@/render/mesh/objExportSerialize'
import {
  collectStructureGeometryPiecesPure,
  mergeBakedQuadPiecesAttributes,
  type BakedQuadGeometryPiece,
} from '@/render/mesh/structureGeometryCore'
import { labelVoxelComponents } from '@/render/mesh/voxelComponents'
import { isWorldDocument } from '@/render/data/bundleResolve'
import { getDefaultFrameIndex } from '@/render/data/worldPlayback'
import type { MaterialPaletteEntry, StructureDefinition } from '@/render/schema/types'

import {
  compositeCoplanarCluster,
  mergedMaterialBlendForCluster,
} from '@/workbench/coplanarTextureComposite'
import {
  measureTextureBlobFirstFrame,
  rasterizeVoxelAtlasToPngBlob,
  type VoxelAtlasTileSource,
} from '@/workbench/textureAtlasRaster'

import {
  OBJ_NAME,
  MTL_NAME,
  DEFAULT_ATLAS_MAX_SIDE,
  type StructureBundleExportOptions,
  sanitizeNewmtlName,
  mtlDissolveAndIllum,
  extractTextureBlobs,
  representativePaletteEntryForBlob,
} from './bundleMaterialBaking'

function remapUvsByTileId(
  uvs: Float32Array,
  tileId: number,
  tileToRect: Map<number, { u0: number; v0: number; u1: number; v1: number }>,
): Float32Array {
  const rect = tileToRect.get(tileId)
  if (!rect) return new Float32Array(uvs)
  const out = new Float32Array(uvs.length)
  for (let i = 0; i < uvs.length; i += 2) {
    const u = uvs[i]!
    const v = uvs[i + 1]!
    out[i] = rect.u0 + u * (rect.u1 - rect.u0)
    out[i + 1] = rect.v0 + v * (rect.v1 - rect.v0)
  }
  return out
}

/**
 * 按体素做共面聚类 → 叠化 → blob+叠化 tile 打 atlas；合并全部片段为一块几何。
 * `pieces` 可为单个体素或整个连通域。
 */
async function buildAtlasFromPieces(
  pieces: BakedQuadGeometryPiece[],
  def: StructureDefinition,
  blobs: string[],
  maxSide: number,
  serialRef: { next: number },
): Promise<{
  merged: { positions: Float32Array; uvs: Float32Array; colors: Float32Array }
  pngBlob: Blob | null
  repBlend: MaterialPaletteEntry | undefined
  hasAtlas: boolean
}> {
  if (pieces.length === 0) {
    return {
      merged: {
        positions: new Float32Array(0),
        uvs: new Float32Array(0),
        colors: new Float32Array(0),
      },
      pngBlob: null,
      repBlend: undefined,
      hasAtlas: false,
    }
  }

  const matOrder = [...new Set(pieces.map((q) => q.materialIndex))].sort((a, b) => a - b)

  const byVoxel = new Map<string, BakedQuadGeometryPiece[]>()
  for (const p of pieces) {
    const k = `${p.col},${p.row},${p.zSlice}`
    let arr = byVoxel.get(k)
    if (!arr) {
      arr = []
      byVoxel.set(k, arr)
    }
    arr.push(p)
  }

  const sortedVoxelKeys = [...byVoxel.keys()].sort((a, b) => {
    const [ca, ra, za] = a.split(',').map(Number)
    const [cb, rb, zb] = b.split(',').map(Number)
    if (za !== zb) return za - zb
    if (ra !== rb) return ra - rb
    return ca - cb
  })

  const mergedEntries: Array<{
    mergedPieces: BakedQuadGeometryPiece[]
    width: number
    height: number
    pngBlob: Blob
  }> = []

  for (const voxelKey of sortedVoxelKeys) {
    const voxelPieces = byVoxel.get(voxelKey)!
    const clusters = clusterCoplanarOverlappingPiecesInVoxel(voxelPieces)
    for (const cluster of clusters) {
      if (cluster.length > 1) {
        const comp = await compositeCoplanarCluster(cluster, def, blobs, serialRef.next++)
        mergedEntries.push({
          mergedPieces: comp.mergedPieces,
          width: comp.width,
          height: comp.height,
          pngBlob: comp.pngBlob,
        })
      }
    }
  }

  const usedBlob = new Set<number>()
  for (const voxelKey of sortedVoxelKeys) {
    const voxelPieces = byVoxel.get(voxelKey)!
    const clusters = clusterCoplanarOverlappingPiecesInVoxel(voxelPieces)
    for (const cluster of clusters) {
      if (cluster.length === 1) {
        const p = cluster[0]!
        const e = def.materialPalette[p.materialIndex]
        const bi = e?.textureBlobIndex
        if (typeof bi === 'number' && Number.isFinite(bi) && blobs[Math.floor(bi)]) {
          usedBlob.add(Math.floor(bi))
        }
      }
    }
  }

  const sortedBlobs = [...usedBlob].sort((a, b) => a - b)

  const dims: Array<{ tileId: number; width: number; height: number }> = []
  let nextTileId = 0
  const blobIndexToTileId = new Map<number, number>()
  for (const bi of sortedBlobs) {
    const raw = blobs[bi]
    const rep = representativePaletteEntryForBlob(def, matOrder, bi)
    if (!rep || typeof raw !== 'string') continue
    const { width, height } = await measureTextureBlobFirstFrame(raw, rep)
    blobIndexToTileId.set(bi, nextTileId)
    dims.push({ tileId: nextTileId++, width, height })
  }

  const blobTileCount = dims.length
  for (const m of mergedEntries) {
    dims.push({ tileId: nextTileId++, width: m.width, height: m.height })
  }

  const repBlend = mergedMaterialBlendForCluster(pieces, def)

  if (dims.length === 0) {
    const merged = mergeBakedQuadPiecesAttributes(pieces)
    return { merged, pngBlob: null, repBlend, hasAtlas: false }
  }

  const { atlasWidth, atlasHeight, placements } = packTextureGridByTileId(dims, 2, maxSide)
  const tileToRect = buildTileIdToUvRect(placements, atlasWidth, atlasHeight)

  const remapped: BakedQuadGeometryPiece[] = []
  let mergedIter = 0
  for (const voxelKey of sortedVoxelKeys) {
    const voxelPieces = byVoxel.get(voxelKey)!
    const clusters = clusterCoplanarOverlappingPiecesInVoxel(voxelPieces)
    for (const cluster of clusters) {
      if (cluster.length === 1) {
        const p = cluster[0]!
        const e = def.materialPalette[p.materialIndex]
        const bi = typeof e?.textureBlobIndex === 'number' ? Math.floor(e.textureBlobIndex) : -1
        const tid = blobIndexToTileId.get(bi)
        if (tid === undefined) {
          remapped.push(p)
          continue
        }
        remapped.push({ ...p, uvs: remapUvsByTileId(p.uvs, tid, tileToRect) })
      } else {
        const m = mergedEntries[mergedIter]!
        const tileId = blobTileCount + mergedIter
        mergedIter++
        for (const p of m.mergedPieces) {
          remapped.push({ ...p, uvs: remapUvsByTileId(p.uvs, tileId, tileToRect) })
        }
      }
    }
  }

  const merged = mergeBakedQuadPiecesAttributes(remapped)

  const tileSources: VoxelAtlasTileSource[] = []
  for (const bi of sortedBlobs) {
    const raw = blobs[bi]
    const rep = representativePaletteEntryForBlob(def, matOrder, bi)
    if (!rep || typeof raw !== 'string') continue
    tileSources.push({ kind: 'blob', blobIndex: bi })
  }
  for (const m of mergedEntries) {
    tileSources.push({ kind: 'png', pngBlob: m.pngBlob })
  }

  const pngBlob = await rasterizeVoxelAtlasToPngBlob({
    atlasWidth,
    atlasHeight,
    placements,
    tileSources,
    blobs,
    representativeEntry: (bidx) => representativePaletteEntryForBlob(def, matOrder, bidx),
  })

  return { merged, pngBlob, repBlend, hasAtlas: true }
}

export async function buildStructureBundleZip(
  def: StructureDefinition,
  normalizedDocument: unknown,
  options?: StructureBundleExportOptions,
): Promise<Blob> {
  const mode = options?.mode ?? 'block'
  if (mode === 'connected') {
    return buildStructureBundleZipConnected(def, normalizedDocument, options)
  }
  return buildStructureBundleZipBlock(def, normalizedDocument, options)
}

async function buildStructureBundleZipBlock(
  def: StructureDefinition,
  normalizedDocument: unknown,
  options?: StructureBundleExportOptions,
): Promise<Blob> {
  const { pieces, stats } = collectStructureGeometryPiecesPure(def, {
    ...options,
    cullOccludedQuads: false,
  })

  const frameIdx = isWorldDocument(normalizedDocument)
    ? (options?.worldFrameIndex ?? getDefaultFrameIndex(normalizedDocument))
    : undefined

  const blobs = extractTextureBlobs(normalizedDocument)
  const maxSide = options?.atlasMaxSide ?? DEFAULT_ATLAS_MAX_SIDE

  const byVoxel = new Map<string, BakedQuadGeometryPiece[]>()
  for (const p of pieces) {
    const k = `${p.col},${p.row},${p.zSlice}`
    let arr = byVoxel.get(k)
    if (!arr) {
      arr = []
      byVoxel.set(k, arr)
    }
    arr.push(p)
  }

  const sortedVoxelKeys = [...byVoxel.keys()].sort((a, b) => {
    const [ca, ra, za] = a.split(',').map(Number)
    const [cb, rb, zb] = b.split(',').map(Number)
    if (za !== zb) return za - zb
    if (ra !== rb) return ra - rb
    return ca - cb
  })

  const objMeshes: ObjExportMesh[] = []
  const mtlEntries: MtlSerializedEntry[] = []
  const atlasZipFiles: Array<{ path: string; blob: Blob }> = []
  const serialRef = { next: 0 }

  for (const voxelKey of sortedVoxelKeys) {
    const voxelPieces = byVoxel.get(voxelKey)!
    const col = voxelPieces[0]!.col
    const row = voxelPieces[0]!.row
    const zSlice = voxelPieces[0]!.zSlice

    const matBase = isWorldDocument(normalizedDocument)
      ? `block_${frameIdx}_${col}_${row}_${zSlice}`
      : `block_${col}_${row}_${zSlice}`
    const matName = sanitizeNewmtlName(matBase)

    const r = await buildAtlasFromPieces(voxelPieces, def, blobs, maxSide, serialRef)

    const texName = `textures/block_${col}_${row}_${zSlice}.png`
    const { d, illum } = mtlDissolveAndIllum(r.repBlend?.blend)

    if (!r.hasAtlas) {
      mtlEntries.push({ name: matName, d, illum, mapKd: undefined })
      objMeshes.push({
        objectName: `block_${col}_${row}_${zSlice}`,
        materialName: matName,
        positions: r.merged.positions,
        uvs: r.merged.uvs,
        colors: r.merged.colors,
      })
      continue
    }

    mtlEntries.push({
      name: matName,
      d,
      illum,
      mapKd: texName,
    })

    objMeshes.push({
      objectName: `block_${col}_${row}_${zSlice}`,
      materialName: matName,
      positions: r.merged.positions,
      uvs: r.merged.uvs,
      colors: r.merged.colors,
    })

    atlasZipFiles.push({ path: texName, blob: r.pngBlob! })
  }

  const objHeader = [
    '# web-structure-renderer',
    '# mode=block; one mesh + one atlas per voxel (blob tiles + merged_coplanar tiles)',
    `# voxels_non_air=${stats.nonAirVoxelCount} skipped_unmapped_voxels=${stats.skippedUnmappedCount}`,
  ]

  const objBody = serializeObjMeshes({
    headerLines: objHeader,
    mtllibName: MTL_NAME,
    meshes: objMeshes,
  })

  const zip = new JSZip()
  zip.file(OBJ_NAME, objBody)
  zip.file(MTL_NAME, serializeMtl(mtlEntries))

  for (const f of atlasZipFiles) {
    zip.file(f.path, f.blob)
  }

  return await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
}

async function buildStructureBundleZipConnected(
  def: StructureDefinition,
  normalizedDocument: unknown,
  options?: StructureBundleExportOptions,
): Promise<Blob> {
  const blobs = extractTextureBlobs(normalizedDocument)
  const maxSide = options?.atlasMaxSide ?? DEFAULT_ATLAS_MAX_SIDE

  const { labels, componentCount } = labelVoxelComponents(def, options?.layerPreview ?? 'all')
  const { stats } = collectStructureGeometryPiecesPure(def, {
    ...options,
    cullOccludedQuads: false,
  })

  const objMeshes: ObjExportMesh[] = []
  const mtlEntries: MtlSerializedEntry[] = []
  const atlasZipFiles: Array<{ path: string; blob: Blob }> = []
  let texSerial = 0
  const serialRef = { next: 0 }

  for (let cid = 0; cid < componentCount; cid++) {
    const { pieces } = collectStructureGeometryPiecesPure(def, {
      ...options,
      componentGather: { labels, componentId: cid },
      cullOccludedQuads: true,
    })
    if (pieces.length === 0) continue

    const r = await buildAtlasFromPieces(pieces, def, blobs, maxSide, serialRef)

    const texName = `textures/component_${texSerial}.png`
    texSerial++

    const matName = sanitizeNewmtlName(`component_${cid}`)
    const { d, illum } = mtlDissolveAndIllum(r.repBlend?.blend)

    if (!r.hasAtlas) {
      mtlEntries.push({ name: matName, d, illum, mapKd: undefined })
      objMeshes.push({
        objectName: `component_${cid}`,
        materialName: matName,
        positions: r.merged.positions,
        uvs: r.merged.uvs,
        colors: r.merged.colors,
      })
      continue
    }

    mtlEntries.push({
      name: matName,
      d,
      illum,
      mapKd: texName,
    })

    objMeshes.push({
      objectName: `component_${cid}`,
      materialName: matName,
      positions: r.merged.positions,
      uvs: r.merged.uvs,
      colors: r.merged.colors,
    })

    atlasZipFiles.push({ path: texName, blob: r.pngBlob! })
  }

  const objHeader = [
    '# web-structure-renderer',
    '# mode=connected; componentGather => neighbor cull + voxel quad cluster + source-over atlas',
    `# voxels_non_air=${stats.nonAirVoxelCount} skipped_unmapped_voxels=${stats.skippedUnmappedCount}`,
  ]

  const objBody = serializeObjMeshes({
    headerLines: objHeader,
    mtllibName: MTL_NAME,
    meshes: objMeshes,
  })

  const zip = new JSZip()
  zip.file(OBJ_NAME, objBody)
  zip.file(MTL_NAME, serializeMtl(mtlEntries))

  for (const f of atlasZipFiles) {
    zip.file(f.path, f.blob)
  }

  return await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
}
