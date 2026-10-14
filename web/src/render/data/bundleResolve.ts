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
import { indexedRegistryFromMaterialPalette } from '@/pure/materialPaletteBridge'
import { toStructureDefinition } from './structureDefinition'
import { hasTextureBlobAt, normalizeTextureBlobPool } from '@/domain/textureBlobPool'
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
  const sd = document as StructureData
  if (isBakedStructureData(sd) && Array.isArray(sd.materialPalette) && sd.materialPalette.length > 0) {
    return indexedRegistryFromMaterialPalette(sd.materialPalette)
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
  // V2 文档不是 V1 World
  if (o.format_version === '2.0') return false
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

/**
 * 根级纹理池（**归一化**后：位置保持数组，`blobs[i]` = 槽位 i 的字节或 `''`）。
 *
 * ## 两种形态都接受（#387 同族批修）
 *
 * 此前是「只认**数组**、且必须**全密非空**，否则返 `null`」：
 *
 * ```ts
 * if (!Array.isArray(raw) || raw.length === 0) return null
 * if (!raw.every((x) => typeof x === 'string' && x.length > 0)) return null
 * ```
 *
 * 两处失明：① 帧为主文档的投影产物是**槽位键对象**（`composition/kernelProjection.ts:1406-1408`）
 * ⇒ 返 `null` ⇒ `validatePackedSceneDocument` **整体跳过**；② 内部核材质面产的**稀疏数组**
 * （`composition/kernelPresentationInputs.ts:397-404` 留 `undefined` 空洞）也返 `null`
 * ⇒ 同样跳过。两种情形都**不报错**，只是"校验不存在"。
 *
 * ⇒ 形态解析收敛到 `domain/textureBlobPool.ts#normalizeTextureBlobPool`；本函数只判"池是否存在"。
 * "槽位有没有字节"由 {@link validateMaterialPaletteEntries} 逐条判定（它现在能区分
 * "下标越界"与"该槽位无字节"两种成因）。
 *
 * @returns 池**非空**时为归一化数组；`textureBlobs` 缺席 / 形态非法 / **归一化后为空池**时为
 *          `null`（＝"编辑态空文档无池"，跳过校验的**既有语义**——旧实现的 `raw.length === 0`
 *          分支，本批逐字保留：只改"形态失明"，不放宽"空池跳过"这条既有事实）。
 */
function rootTextureBlobs(document: unknown): string[] | null {
  if (!document || typeof document !== 'object') return null
  const d = document as Record<string, unknown>
  const raw = d.textureBlobs
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object') return null
  const pool = normalizeTextureBlobPool(raw) as string[]
  if (pool.length === 0) return null
  return pool
}

function validateMaterialPaletteEntries(blobs: string[], pal: unknown, ctx: string): void {
  if (!Array.isArray(pal)) return
  for (let i = 0; i < pal.length; i++) {
    const entry = pal[i]
    if (!entry || typeof entry !== 'object') {
      throw new Error(`${ctx}[${i}] 无效`)
    }
    const e = entry as { textureBlobIndex?: unknown; texture_blob_index?: unknown }
    const idx = e.textureBlobIndex ?? e.texture_blob_index
    if (typeof idx !== 'number' || !Number.isFinite(idx)) {
      throw new Error(`${ctx}[${i}] 缺少有效 textureBlobIndex（须为 SDE 打包后的单文件 JSON）`)
    }
    const bi = Math.floor(idx)
    if (bi < 0 || bi >= blobs.length) {
      throw new Error(
        `${ctx}[${i}] textureBlobIndex=${bi} 越界（textureBlobs.length=${blobs.length}）`,
      )
    }
    if (!hasTextureBlobAt(blobs, bi)) {
      throw new Error(
        `${ctx}[${i}] textureBlobIndex=${bi} 指向的槽位**无字节**（空洞/占位）——`
        + '外链资源应带 locator，而不是指向空槽',
      )
    }
  }
}

/**
 * 校验 Wiki 消费态：若存在 textureBlobs 则校验材质槽位合法性。
 * 编辑态空文档无 textureBlobs 时跳过校验。
 */
export function validatePackedSceneDocument(document: unknown): void {
  const blobs = rootTextureBlobs(document)
  if (!blobs) return
  if (isWorldDocument(document)) {
    const pal = document.materialPalette
    if (pal?.length) {
      validateMaterialPaletteEntries(blobs, pal, 'materialPalette')
    }
    return
  }
  const sd = document as StructureData
  if (isBakedStructureData(sd) && Array.isArray(sd.materialPalette) && sd.materialPalette.length > 0) {
    validateMaterialPaletteEntries(blobs, sd.materialPalette, 'materialPalette')
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
