/**
 * 数据入口：document（StructureData | World）→ StructureDefinition；材质表仅由结构内 palette 汇总。
 */

import type {
  MaterialRegistryData,
  RenderBundle,
  StructureData,
  StructureDataBaked,
  StructureDefinition,
  World,
} from '../schema/types'
import { indexedRegistryFromMaterialPalette } from './materialPaletteBridge'
import { toStructureDefinition } from './structureDefinition'
import { embeddedStructure, frameAt, getDefaultFrameIndex } from './worldPlayback'

export function isBakedStructureData(x: StructureData | undefined | null): x is StructureDataBaked {
  return x != null && x.geometryPhase === 'baked'
}

/**
 * 由场景 document（StructureData 或 World）构建材质注册表。
 * World：`materialId` = `` `${frameIndex}:${slotIndex}` ``；单结构：`"0"`..`"n-1"`。
 * 须在 {@link hydrateMaterialBlendsInSceneDocument} 之后调用，以便 `blend` 已写入 palette。
 */
export function buildMaterialRegistryFromSceneDocument(document: unknown): MaterialRegistryData {
  if (!document || typeof document !== 'object') return { materials: {} }
  if (isWorldDocument(document)) {
    const pal = document.materialPalette
    if (!pal?.length) return { materials: {} }
    return indexedRegistryFromMaterialPalette(pal)
  }
  const d = document as StructureData
  if (isBakedStructureData(d) && Array.isArray(d.materialPalette) && d.materialPalette.length > 0) {
    return indexedRegistryFromMaterialPalette(d.materialPalette)
  }
  return { materials: {} }
}

export function loadStructureData(raw: unknown): StructureDefinition {
  if (!raw || typeof raw !== 'object') throw new Error('StructureData 无效')
  const s = raw as StructureData
  if (!isBakedStructureData(s)) {
    throw new Error('StructureData 须为 geometryPhase=baked 的终态（含 blockPalette / materialPalette）')
  }
  return toStructureDefinition(s)
}

export function isWorldDocument(raw: unknown): raw is World {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  return Array.isArray(o.frames) && typeof o.id === 'string'
}

export function loadWorldEmbeddedFrame(raw: unknown, frameIndex: number | undefined): StructureDefinition {
  if (!isWorldDocument(raw)) throw new Error('不是 World 文档')
  const w = raw
  const idx = frameIndex !== undefined ? Math.floor(frameIndex) : getDefaultFrameIndex(w)
  const frame = frameAt(w, idx)
  if (!frame) throw new Error(`World 无帧索引 ${idx}`)
  const data = embeddedStructure(frame)
  if (!data) {
    throw new Error(`World.frames[${idx}] 无内嵌 structure（仅 structureRef 的帧尚无法加载）`)
  }
  return loadStructureData(data)
}

export function loadStructureOrWorld(raw: unknown, frameIndex: number | undefined): StructureDefinition {
  if (isWorldDocument(raw)) {
    return loadWorldEmbeddedFrame(raw, frameIndex)
  }
  return loadStructureData(raw)
}

function rootTextureBlobs(document: unknown): string[] | null {
  if (!document || typeof document !== 'object') return null
  const raw = (document as Record<string, unknown>).textureBlobs
  if (!Array.isArray(raw) || raw.length === 0) return null
  if (!raw.every((x) => typeof x === 'string' && (x as string).length > 0)) return null
  return raw as string[]
}

function validateMaterialPaletteEntries(blobs: string[], pal: unknown, ctx: string): void {
  if (!Array.isArray(pal)) return
  for (let i = 0; i < pal.length; i++) {
    const entry = pal[i]
    if (!entry || typeof entry !== 'object') {
      throw new Error(`${ctx}[${i}] 无效`)
    }
    const idx = (entry as { textureBlobIndex?: unknown }).textureBlobIndex
    if (typeof idx !== 'number' || !Number.isFinite(idx)) {
      throw new Error(`${ctx}[${i}] 缺少有效 textureBlobIndex（须为 SDE 打包后的单文件 JSON）`)
    }
    const bi = Math.floor(idx)
    if (bi < 0 || bi >= blobs.length) {
      throw new Error(
        `${ctx}[${i}] textureBlobIndex=${bi} 越界（textureBlobs.length=${blobs.length}）`,
      )
    }
  }
}

/**
 * 校验 Wiki 消费态：非空 `textureBlobs` 且每条材质槽位含合法 `textureBlobIndex`。
 */
export function validatePackedSceneDocument(document: unknown): void {
  const blobs = rootTextureBlobs(document)
  if (!blobs) {
    throw new Error(
      '场景缺少非空 textureBlobs（须为含 Base64 PNG 池的打包 JSON；旧版仅 locator 已不再支持）',
    )
  }
  if (isWorldDocument(document)) {
    const pal = document.materialPalette
    if (pal?.length) {
      validateMaterialPaletteEntries(blobs, pal, 'materialPalette')
    }
    return
  }
  const d = document as StructureData
  if (isBakedStructureData(d) && Array.isArray(d.materialPalette) && d.materialPalette.length > 0) {
    validateMaterialPaletteEntries(blobs, d.materialPalette, 'materialPalette')
  }
}

/** 校验 `document` 已打包；不校验根级 schemaVersion */
export function validateRenderBundle(b: RenderBundle): void {
  if (!b || typeof b !== 'object') throw new Error('RenderBundle 无效')
  validatePackedSceneDocument(b.document)
}

export interface RenderBundleResolveResult {
  definition: StructureDefinition
  /** `World.tooltipPalette` 或单文件 `StructureDataBaked.tooltipPalette`；缺省为 `[]` */
  tooltipPalette: string[]
  /** World 且 `frames` 非空时，为当前用于解析的 `frames` 下标 */
  worldFrameIndex?: number
}

/**
 * 从当前 `document` 与已解析的当帧 `StructureDefinition` 取 ToolTip 文案池（不从 `registryId` 回退）。
 */
export function tooltipPaletteFromSceneDocument(document: unknown, definition: StructureDefinition): string[] {
  if (isWorldDocument(document)) {
    const tp = document.tooltipPalette
    if (Array.isArray(tp) && tp.every((x) => typeof x === 'string')) return tp
    return []
  }
  const tp = definition.tooltipPalette
  if (Array.isArray(tp) && tp.every((x) => typeof x === 'string')) return tp
  return []
}

export function resolveRenderBundle(bundle: RenderBundle, frameIndex?: number): RenderBundleResolveResult {
  const doc = bundle?.document
  let worldFrameIndex: number | undefined
  if (isWorldDocument(doc) && doc.frames.length > 0) {
    worldFrameIndex = frameIndex !== undefined ? Math.floor(frameIndex) : getDefaultFrameIndex(doc)
  }
  const definition = loadStructureOrWorld(doc, frameIndex)
  // World 多帧：将根级 palette 注入 definition（帧内 structure 不再携带）
  if (isWorldDocument(doc)) {
    if (doc.materialPalette) {
      definition.materialPalette = doc.materialPalette
    }
    if (doc.blockPalette) {
      definition.blockPalette = doc.blockPalette
    }
  }
  const tooltipPalette = tooltipPaletteFromSceneDocument(doc, definition)
  return { definition, tooltipPalette, worldFrameIndex }
}

export type { MaterialRegistryData, RenderBundle } from '../schema/types'
