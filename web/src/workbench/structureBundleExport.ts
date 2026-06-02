/**
 * Barrel — 保持对旧路径 `@/workbench/structureBundleExport` 的向后兼容导入。
 *
 * 功能已拆分到：
 *   ./bundleMaterialBaking — 材质/纹理相关 (MTL 名称处理、材质混合模式、纹理 blob 提取与查询)
 *   ./bundleMeshAssembly   — 网格/ZIP 组装 (体素聚类、图集打包、OBJ/MTL/ZIP 生成)
 */

export {
  OBJ_NAME,
  MTL_NAME,
  DEFAULT_ATLAS_MAX_SIDE,
  sanitizeNewmtlName,
  mtlDissolveAndIllum,
  extractTextureBlobs,
  representativePaletteEntryForBlob,
} from './bundleMaterialBaking'

export type {
  StructureBundleExportMode,
  StructureBundleExportOptions,
} from './bundleMaterialBaking'

export {
  buildStructureBundleZip,
} from './bundleMeshAssembly'
