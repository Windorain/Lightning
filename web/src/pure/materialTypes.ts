/**
 * pure/materialTypes.ts — Pure material type definitions.
 * No framework dependencies: no Three.js, no Vue, no DOM, no I/O.
 */

/** 资源包定位符：namespace:path（不含 textures/ 与 .png），与 MC 习惯一致 */
export type ResourceLocator = string

export type MaterialKind = 'static16' | 'animated'

export type MaterialBlendMode = 'opaque' | 'cutout' | 'translucent'

/** 字段形状对齐 Java 版纹理 `.mcmeta` 的 `animation`；数据来自 JSON 非独立 mcmeta 文件。`kind === 'animated'` 且 PNG 为竖条多帧时按顺序 1 tick/帧播放（见 simpleMaterialLibrary） */
interface MaterialAnimationSpec {
  defaultFrametimeTicks?: number
  frameSequence?: Array<{ index: number; timeTicks?: number }>
  interpolate?: boolean
}

export interface MaterialEntry {
  /** 溯源；打包态下 Wiki 仅使用 textureBlobIndex，不请求 locator */
  locator?: ResourceLocator
  kind: MaterialKind
  blend?: MaterialBlendMode
  emissive?: number
  animation?: MaterialAnimationSpec
}

/** 结构内材质调色盘条目（并入原独立 sampler 的 atlas / 线性 / mipmap 提示） */
export type MaterialPaletteEntry = MaterialEntry & {
  /** 指向根级 `textureBlobs` 池中的 PNG（Base64）；打包交付必填 */
  textureBlobIndex?: number
  /** MC 1.7：`blocks` / `items` 对应 `TextureMap.location*Texture`；`null`/缺省且为独立贴图时由导出写 `null` */
  atlas?: string | null
  linear?: boolean
  useMipmaps?: boolean
}

/** materialId → 条目；键由 StructureData.materialPalette 或 World 多帧 `frameIndex:localIndex` 派生 */
export interface MaterialRegistryData {
  schemaVersion?: number
  materials: Record<string, MaterialEntry>
}
