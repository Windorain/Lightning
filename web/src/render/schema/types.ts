import type { AnnotationType } from '@/render/data/annotationTypes'

// ---- Data types shared across layers (pure, no workbench deps) ----

import type {
  MaterialBlendMode,
  MaterialEntry,
  MaterialKind,
  MaterialPaletteEntry,
  MaterialRegistryData,
  ResourceLocator,
} from '@/pure/materialTypes'

export type {
  MaterialBlendMode,
  MaterialEntry,
  MaterialKind,
  MaterialPaletteEntry,
  MaterialRegistryData,
  ResourceLocator,
}

export interface BlockRef {
  pos: { x: number; y: number; z: number }
  block_state_id: string
  /** 被击中的 quad 在该体素内的索引 */
  quadIndex?: number
  /** 命中面的世界空间法线（已归一化），用于面级别检测 */
  normal?: { x: number; y: number; z: number }
  /** 命中点的世界空间坐标，用于区分同法线的多个面 */
  point?: { x: number; y: number; z: number }
  /** @internal 构建 RNA owner 时注入的网格尺寸 */
  _gridSize?: { w: number; h: number; d: number } | null
}

export type SelectedEntity =
  | { kind: 'block'; ref: BlockRef }
  | { kind: 'annotation'; id: string; type: AnnotationType }

/**
 * StructureData：`geometryPhase` 区分扫描中间态与可渲染终态；预览 UI 由 `View3DConfig.features` 控制。
 */

/** 磁盘 / 传输层文档形态；Wiki 据 `documentFormat` 选择解析路径。 */
export type DocumentFormat = 'Plain' | 'Envelope'

/** 与 SDE 写出一致：单 gzip 流再以标准 Base64 嵌入 JSON 字符串。 */
export const COMPACT_PAYLOAD_ENCODING = 'gzip+base64' as const

/**
 * Envelope：`meta` 为唯一元数据真源；`payload` 解压后为不含 id/label 等元数据键的 Plain 根 JSON（与 meta 合并后得到完整 Plain）。
 */
export interface EnvelopeDocument {
  documentFormat: 'Envelope'
  payloadEncoding: typeof COMPACT_PAYLOAD_ENCODING
  meta: Record<string, unknown>
  payload: string
}

/**
 * 渲染包：仅 `document` 为可信源（StructureData 或 World）；纹理须已内嵌于 `document.textureBlobs`。
 */
export interface RenderBundle {
  /** 与 BakedQuads 终态契约对齐时可 bump */
  payloadSchemaVersion?: number
  document: unknown
  bundleId?: string
}

export type FaceName = '+x' | '-x' | '+y' | '-y' | '+z' | '-z'

interface InitialCameraDef {
  focusBlockId: string
  frontFace: FaceName
  distance?: number
}

export type JsonNbt = Record<string, unknown>

/** 数据形态：scan=服务端扫描待客户端烘焙；baked=含 BakedQuads 可渲染 */
export type StructureGeometryPhase = 'scan' | 'baked'

/** 扫描中间态（SDE 写出；Wiki 不直接渲染） */
export interface StructureDataScan {
  geometryPhase: 'scan'
  id: string
  label?: string
  gtnhVersion?: string
  author?: string
  description?: string | null
  /** 模组来源（如多方块 mod），可选 */
  modSource?: string
  globalConfig?: Record<string, unknown>
  source?: { javaClass?: string; structurePiece?: string; note?: string }
  axis?: {
    zSlice?: string
    row?: string
    column?: string
    spaceChar?: string
  }
  scanBounds?: { minX: number; maxY: number; minZ: number }
  initialCamera?: InitialCameraDef
  cellTypes: unknown[]
  cellGrid: number[][][]
  worldGrid: unknown
}

/**
 * 与 `cellGrid` 同下标 `cellGrid[zSlice][row][column]` 时，`cellTooltipGrid` 也按 `[zSlice][row][column]` 对齐。
 * 值为在根级/World 级 `tooltipPalette` 中的下标；`TOOLTIP_GRID_NONE` 表示该格不显示 ToolTip。
 */
export const TOOLTIP_GRID_NONE = -1

/** 可渲染终态（palette + cellGrid） */
export interface StructureDataBaked {
  geometryPhase: 'baked'
  id: string
  label?: string
  gtnhVersion?: string
  author?: string
  description?: string | null
  modSource?: string
  schemaVersion?: number
  globalConfig?: Record<string, unknown>
  textureBlobs?: string[]
  source?: { javaClass?: string; structurePiece?: string; note?: string }
  axis?: {
    zSlice?: string
    row?: string
    column?: string
    spaceChar?: string
  }
  blockPalette: BlockPaletteEntry[]
  materialPalette: MaterialPaletteEntry[]
  cellGrid: number[][][]
  /**
   * 与 `cellGrid` 同形、同下标。单文件文档时，配合同对象上的 `tooltipPalette` 或外裹 World 根上的 `tooltipPalette`。
   */
  cellTooltipGrid?: number[][][]
  /**
   * 单文件 baked 根上的 ToolTip 文案池；`World` 文档时见根级 `World.tooltipPalette`（帧内 `structure` 不重复此字段亦可）。
   */
  tooltipPalette?: string[]
  scanBounds?: { minX: number; maxY: number; minZ: number }
  initialCamera?: InitialCameraDef
}

export type StructureData = StructureDataScan | StructureDataBaked

/** 体素逻辑态（运行时由 blockPalette 条目映射） */
export interface VoxelState {
  registryId: string
  meta: number
  facing?: FaceName
  nbt?: JsonNbt
}

export const AIR_VOXEL: VoxelState = { registryId: 'air', meta: 0 }

export function isAirState(v: VoxelState): boolean {
  return v.registryId === 'air'
}

export type BakedGeometryEncoding = 'bakedQuadsJsonV1' | 'packedQuadsV1'

export interface BakedQuadVertex {
  x: number
  y: number
  z: number
  u: number
  v: number
  brightness?: number
  color?: number
}

/** geometry.quads 有序：绘制顺序与数组顺序一致 */
export interface BakedQuad {
  materialIndex: number
  vertices: BakedQuadVertex[]
}

export interface BakedQuadsGeometry {
  encoding: BakedGeometryEncoding
  quads: BakedQuad[]
}

/** BakedModel 调色盘条目：扁平 BakedQuad[] 几何 */
export interface BakedModelPaletteEntry {
  registryId: string
  meta: number
  facing?: FaceName
  nbt?: JsonNbt
  thumbnailPNG?: string
  tooltip?: string[]
  occludesAdjacentFaces?: boolean
  renderMode: 'BakedModel'
  geometry: BakedQuadsGeometry
}

export type BlockPaletteEntry = BakedModelPaletteEntry

/** Wiki 网格管线使用的终态结构（保证已烘焙） */
export type StructureDefinition = StructureDataBaked

export interface VoxelVolume {
  sizeColumn: number
  sizeRow: number
  sizeZSlice: number
  get(column: number, row: number, zSlice: number): VoxelState
}

export interface Frame {
  index?: number
  structure?: StructureData
  structureRef?: string
  durationMs?: number
  label?: string
  annotations?: import('../data/annotationTypes').Annotation[]
}

export interface World {
  schemaVersion?: number
  id: string
  label?: string
  gtnhVersion?: string
  author?: string
  description?: string | null
  modSource?: string
  globalConfig?: Record<string, unknown>
  /** 根级纹理池（Base64 PNG），所有帧共享 */
  textureBlobs?: string[]
  /** 根级 ToolTip 文案池，所有帧共享 */
  tooltipPalette?: string[]
  /** 根级材质调色盘，所有帧共享；BakedQuad.materialIndex 直接指向此数组 */
  materialPalette?: MaterialPaletteEntry[]
  /** 根级方块调色盘，所有帧共享；cellGrid 的值直接指向此数组 */
  blockPalette?: BlockPaletteEntry[]
  frames: Frame[]
  playback?: { loop?: boolean; defaultFrameIndex?: number }
}
