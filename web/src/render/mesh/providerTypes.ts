/**
 * MeshProvider / BlockHandler 类型定义。
 * 与 schema/types 分离以避免循环依赖（MaterialLibraryApi → types）。
 */

import type * as THREE from 'three'
import type { BakedQuad, BlockPaletteEntry, StructureDefinition } from '../schema/types'
import type { MaterialLibraryApi } from '../materials/simpleMaterialLibrary'

// ── BlockHandler（BlockMeshProvider 内部） ──

export interface VoxelContext {
  column: number
  row: number
  zSlice: number
  sizeColumn: number
  sizeRow: number
  sizeZSlice: number
}

export type BlockOutput =
  | { kind: 'quads'; quads: BakedQuad[] }
  | { kind: 'object3d'; object: THREE.Object3D }
  | { kind: 'none' }

export interface BlockHandler {
  priority: number
  canRender(entry: BlockPaletteEntry): boolean
  render(entry: BlockPaletteEntry, ctx: VoxelContext): BlockOutput
}

// ── MeshProvider（MeshBuilder / ViewerCore 层） ──

export type MeshOutput =
  | { kind: 'quads'; quads: BakedQuad[] }
  | { kind: 'object3d'; object: THREE.Object3D }
  | { kind: 'none' }

export interface MeshProvider {
  /** 排序优先级，越小越先匹配（default 100） */
  priority: number
  /** 产出挂载到哪个 layer group */
  target: 'structure' | 'decal' | 'overlay'
  /** 用结构和材质库构建产出 */
  build(def: StructureDefinition, lib: MaterialLibraryApi): Promise<MeshOutput[]>
}
