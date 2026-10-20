/**
 * 烘焙结构 → 三角网格片段：**纯函数核心**（无 Three.js、无 DOM、无 I/O）。
 * 相同输入得到相同 `pieces` / `stats`；渲染与导出在适配层再转为 BufferGeometry / OBJ。
 *
 * 法线计算 → {@link structureGeometryNormals}
 * UV 计算   → {@link structureGeometryUVs}
 */

import { buildVoxelVolume } from '../data/grid'
import { voxelLinearIndex, AIR_COMPONENT } from './voxelComponents'
import { effectiveVoxelState, type LayerPreviewMode } from '../data/layerPreview'
import type {
  BlockPaletteEntry,
  FaceName,
  StructureDefinition,
  VoxelVolume,
} from '../schema/types'
import { isAirState } from '../schema/types'
import { decodeBakedGeometry } from './bakedGeometryDecode'

// Import sub-module functions for local use
import { outwardWorldFaceFromBakedQuadPure } from './structureGeometryNormals'
import { bakedQuadTriangleAttributesPure } from './structureGeometryUVs'

// Re-export sub-module symbols so existing imports keep working
export { outwardWorldFaceFromBakedQuadPure } from './structureGeometryNormals'
export { bakedQuadTriangleAttributesPure } from './structureGeometryUVs'

export interface StructureGeometryGatherOptions {
  layerPreview?: LayerPreviewMode
  /**
   * 是否剔除被**不透明邻居**或**同一方块邻面**遮挡的四边形（身份口径见 `sameBlockStateOf`）。
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

/** @deprecated 类型已移入 pure/meshTypes.ts；保留 re-export 以兼容现有导入 */
import type { BakedQuadGeometryPiece as _BakedQuadGeometryPiece } from '@/pure/meshTypes'
export type BakedQuadGeometryPiece = _BakedQuadGeometryPiece

export interface StructureGeometryCollection {
  pieces: BakedQuadGeometryPiece[]
  stats: BlockMeshBuildStats
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

/**
 * 两格是不是**同一个方块状态**（→ 邻面不渲染）。
 *
 * ## 为什么不能用调色板下标当身份（#87 ACC 成对玻璃实测缺陷的根因）
 *
 * 调色板槽位是**渲染变体**：同一方块状态因渲染期差异（CTM 连通解析、AO 上下文…）
 * 会被导出成**多个条目**，各自一套四边形。实测：GG 反物质外壳成对相邻的两格在导出件里
 * 是 `blockPalette[2]` 与 `blockPalette[3]`，都是 `GoodGenerator:antimatterContainmentCasing`
 * meta 0（无 `facing`/`nbt`），只是 CTM 象限贴图排列互为镜像。
 *
 * 而游戏侧剔除同块邻面判的是**方块**而不是渲染变体：GT 的
 * `goodgenerator.blocks.regularBlock.BlockFrame#shouldSideBeRendered` 判的是
 * `getBlock(...) instanceof BlockFrame`（运行期 5.09.54.194 的 jar 已 javap 双核），
 * 与"这一格导出成了第几个调色板槽"无关。用槽位相等代替方块身份 ⇒ 同一方块的两个
 * 变体之间**不剔除** ⇒ 成对玻璃的共享面被画出来（web 里以白框线可见，而游戏里该面从不渲染）。
 *
 * ## 身份取什么：`VoxelState` 的四个字段（`schema/types.ts` 的方块状态类型）
 *
 * `registryId` + `meta` + `facing` + `nbt` —— 这四项正是 `buildVoxelVolume` 还原出的
 * `VoxelState`（`render/data/grid.ts`），即"这里是哪个方块的什么状态"。
 * **不含** `geometry`/`thumbnail`/`tooltip`：那些是该条目的呈现资源，不是身份；
 * 这也是本判据与 `domain/blockGeometry#blockPaletteEntryKey`（条目**内容**键，
 * 用于去重、含 `assetId` 等）的分工 —— 两者判的不是同一件事，故不共用一份实现。
 *
 * **边界（如实登记）**：MC 侧的 `instanceof` 比这更宽（连 meta/NBT 都不看）。这里取
 * "同状态"是**保守**选择：① 不改变既有夹具的剔除结果（`domain/blockGeometry` 记的
 * `4882 → 4862` 那条历史观测保持成立）；② 判据偏窄只会"多画"，不会画出空洞。
 */
function sameBlockStateOf(a: BlockPaletteEntry, b: BlockPaletteEntry): boolean {
  if (a === b) return true
  if (a.registryId !== b.registryId) return false
  if (a.meta !== b.meta) return false
  if (a.facing !== b.facing) return false
  return nbtKeyOf(a.nbt) === nbtKeyOf(b.nbt)
}

/**
 * `nbt` 的比较口径：`JSON.stringify`（与 `blockPaletteEntryKey` 同一口径 —— 此处只用于
 * **比较**，不做身份摘要）。键序不同会判为不同 ⇒ 不剔除，方向是"多画"。
 */
function nbtKeyOf(nbt: unknown): string {
  return nbt === undefined || nbt === null ? '-' : JSON.stringify(nbt)
}

/**
 * 邻格是**同一方块**（同一状态，见 {@link sameBlockStateOf}）⇒ 该面不渲染。
 *
 * 与 `shouldCullQuadFacingOpaqueNeighbor` 的分工：那条管"邻格不透明"（深度自会挡住），
 * 本条管"邻格是同一种方块"——对应游戏侧 `shouldSideBeRendered` 的另一半：
 * 同块相邻时**根本不发**这个面。两条都只在**自身不是不透明块**时才可能命中
 * （不透明块的面由邻格的 `occludesAdjacentFaces` 决定，见调用点）。
 */
function shouldCullQuadFacingSameBlockNeighbor(
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
  if (selfEntry === undefined) return false
  if (selfEntry.occludesAdjacentFaces === true) return false
  const { dc, dr, dz } = gridStepForOutwardWorldFace(worldFace)
  const ncol = col + dc
  const nrow = row + dr
  const nz = zSlice + dz
  const nState = effectiveVoxelState(volume, ncol, nrow, nz, sizeRow, layerPreview)
  if (isAirState(nState)) return false
  const nidx = def.cellGrid[nz]?.[nrow]?.[ncol]
  if (nidx === undefined || nidx < 0) return false
  const nEntry = def.blockPalette[nidx]
  if (nEntry === undefined) return false
  // 邻格不透明 ⇒ 该面由深度自然挡住，不在此处判身份。
  if (nEntry.occludesAdjacentFaces === true) return false
  return sameBlockStateOf(nEntry, selfEntry)
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
                  shouldCullQuadFacingSameBlockNeighbor(
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
                shouldCullQuadFacingSameBlockNeighbor(
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
