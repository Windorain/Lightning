/**
 * 呈现侧**适配器**：把 legacy `RuntimeDocument` 的只读视图转成 `presentation/` 需要的
 * 纯数据（#249 §4 规则 4：适配器实现端口，不在映射时夹带编辑业务规则）。
 *
 * ## 为什么需要它，以及它的边界
 *
 * `presentation/` 是**新分层**，不得依赖 legacy 类型（`RuntimeDocument` / `Grid` /
 * `StructureDefinition`）—— 否则新层会被旧模型绑死，正是 §15「新门面包旧核心保活」要防的。
 * 于是映射集中在本文件：它读 legacy 数据、产出新层的纯数据。
 *
 * 本文件**只做映射**，不含任何判定：
 *  - 不决定"要不要重建"（那是 `contentIdentity` + 呈现层的职责）；
 *  - 不决定"哪些对象可见"（那是求值场景的输入，由调用方给出）。
 *
 * ## 内容身份的读取面
 *
 * `readContentIdentity()` 是 `structEpoch` 的替代读取面：它从文档**机械派生**四维摘要，
 * 因此"什么变了"由数据回答。调用方没有"设成什么值"的入口（见 `contentSignal`）。
 */

import type { RuntimeDocument } from '@/context/runtimeDocument'
import type { Grid } from '@/context/grid'
import type { StructureDefinition } from '@/render/schema/types'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import {
  annotationDigestOf,
  contentIdentityOf,
  resourceDigestOf,
  structureDigestOf,
  type ContentIdentity,
} from '@/presentation/contentIdentity'
import type { EvaluatedPrimitive, GeometryAttributes, GeometryId } from '@/presentation/evaluationKey'
import { contentDigestOf } from '@/presentation/invalidationPlan'
// 几何收集**只有一个**入口（本批 D3a 更正：原先本文件另有一份手写遍历，
// 它不做遮挡剔除 ⇒ 与渲染路径数值不一致）。见 `structureGeometryAttributes` 的说明。
import {
  collectStructureGeometryPiecesPure,
  mergeBakedQuadPiecesAttributes,
} from '@/render/mesh/structureGeometryCore'

/**
 * 网格指纹：逐格下标（z→y→x 稳定序）。
 *
 * 只取**下标**而不取调色板（调色板单独进摘要）：下标序列配不同调色板是两种不同的变化，
 * 分开记录使诊断能说出"是布局变了还是方块种类变了"。
 */
export function gridFingerprint(grid: Grid | null): readonly number[] | null {
  if (grid === null) return null
  const out: number[] = []
  for (let z = 0; z < grid.depth; z++) {
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const b = grid.at({ x, y, z })
        // 方块身份 + 部件身份都进指纹（部件是格内容的一部分）
        out.push(b === null ? 0 : hashString(`${b.name}:${b.meta ?? ''}`))
      }
    }
  }
  return out
}

function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * 从文档派生**内容身份**（`structEpoch` 的替代读取面）。
 *
 * `frameIndex` 与 `layerPreview` 参与结构摘要：它们改变被采集的几何
 * （换帧 = 换一整份网格；分层预览 = 只采集某一层）。这不是"非内容版本冒充内容变化" ——
 * 它们**确实**改变呈现内容；而机位/选择/布局**不**在本函数的任何入参里，
 * 因此它们**不可能**影响身份。
 */
export function readContentIdentity(input: {
  doc: RuntimeDocument | null
  frameIndex: number
  layerPreview: LayerPreviewMode
  /** 已解析的结构定义（多方块文档由装配器产出；帧为主文档由 resolveRenderBundle 产出）。 */
  definition: StructureDefinition | null
}): ContentIdentity {
  const { doc, frameIndex, layerPreview, definition } = input

  if (doc === null) {
    return contentIdentityOf({
      documentId: '',
      structureDigest: 's:none',
      annotationDigest: annotationDigestOf([]),
      resourceDigest: resourceDigestOf(undefined),
    })
  }

  const grid = doc.frame(frameIndex)?.grid ?? null
  return contentIdentityOf({
    // 文档身份含 id 与格式版本（换文档必然整体重建）
    documentId: `${doc.id}@${doc.formatVersion}`,
    structureDigest: structureDigestOf({
      frames: [gridFingerprint(grid)],
      palette: definition?.blockPalette.map((p) => `${p.registryId}@${p.meta ?? ''}`) ?? [],
      frameDecls: doc.frames.map((f) => [f.index, f.durationMs ?? null]),
      multiblock: doc.multiblock?.decl.raw ?? null,
      layerFilter: layerPreview,
    }),
    annotationDigest: annotationDigestOf(doc.annotations),
    resourceDigest: resourceDigestOf(doc.textureBlobs ?? doc.materialPalette ?? undefined),
  })
}

/**
 * 几何**内容身份**：由结构定义派生（同定义 ⇒ 同身份 ⇒ 可共享同一份几何缓存）。
 *
 * 身份必须是**内容**的：换一格方块 ⇒ 整个结构几何的内容变了 ⇒ 身份变。因此这里对
 * 结构定义取内容摘要，而不是用"定义对象引用"当身份（引用相等会在结构共享的实现下
 * 误判"没变"）。
 */
export function structureGeometryId(definition: StructureDefinition, layerPreview: LayerPreviewMode): GeometryId {
  return `structure:${contentDigestOf([
    definition.id,
    definition.cellGrid,
    definition.blockPalette.map((p) => `${p.registryId}@${p.meta ?? ''}`),
    layerPreview,
  ])}`
}

/**
 * 从结构定义产出**纯数据几何属性**（供 `presentation/evaluationKey.GeometrySource` 消费）。
 *
 * 与既有 `blockMesh.buildBlockMesh` 的关系：那条路径产出 `THREE.Group`（含 GPU 对象与
 * `triangleMap`），而本函数产出**纯数据**（位置/UV/颜色），使呈现编译可以在无 GPU 环境
 * 断言。两者都调用同一个纯几何核心（`decodeBakedGeometry` + `bakedQuadTriangleAttributesPure`），
 * 因此**几何数值一致**（这是 e2e 能对照两侧的前提）。
 *
 * ## ⚠️ 本批更正（#289 P10d D3a）：上面那句"因此几何数值一致"**曾是假的**
 *
 * 第一版**手写**了一遍遍历（逐格逐四边形全收），而渲染路径经
 * `collectStructureGeometryPiecesPure` 收集并**默认剔除**被遮挡的四边形。
 * 两者共用四边形解码器 ≠ 共用**剔除判据** ⇒ 数值并不一致。实测（同一取值口径）：
 *
 * | 夹具 | 渲染路径（剔除） | 第一版本函数 |
 * |---|---|---|
 * | multiblock-tier-only | 12 | 12 |
 * | multiblock-ebf-2ch | **12**（tier1）/ **24**（默认） | **36** / **72** |
 * | multiblock-lsc-overlap | **40** | **104** |
 *
 * 即本函数**恰好等于"不剔除"**（`cullOccludedQuads: false`）—— 内部面会被画出来，
 * 呈现编译若用它，"切换实现不改变画面"直接失效。
 *
 * 为何旧判据没抓到：`structureGeometryAttributes` 在本批之前**零调用者**
 * （生产与测试都没有；`renderCutoverParity` 的指纹一律走
 * `collectStructureGeometryPiecesPure`），故"注释声称一致、无判据把守"。
 *
 * ## 更正方式：不修数字，**删掉重复实现**
 *
 * 手写遍历是分歧的**唯一**来源。现在本函数**委托**给渲染路径同一个收集器
 * （`collectStructureGeometryPiecesPure` + `mergeBakedQuadPiecesAttributes`），
 * 于是"数值一致"由**构造**保证，而不是由注释声称。
 */
export function structureGeometryAttributes(
  definition: StructureDefinition,
  options?: { layerPreview?: LayerPreviewMode; visibleObjectId?: string },
): GeometryAttributes {
  const layerPreview = options?.layerPreview ?? 'all'
  // 走渲染路径**同一个**收集器：剔除判据因此不可能再漂移。
  const collected = collectStructureGeometryPiecesPure(definition, { layerPreview })
  const merged = mergeBakedQuadPiecesAttributes(collected.pieces)
  return {
    positions: merged.positions,
    uvs: merged.uvs,
    colors: merged.colors,
    triangleCount: merged.positions.length / 9,
  }
}

/**
 * 把结构几何投影成**一个对象**的呈现条目。
 *
 * 为什么当前是"一个对象"：legacy 场景里整座结构是**一个**内容 Group（`ViewportSlot.contentGroup`），
 * 没有逐方块对象身份（这正是 #249 §15 第 9 条「格坐标/批次序号兼任对象身份」要在 P3 退役的
 * 遗留事实）。本批的 `presentation/` 已按**逐对象**建模（`EvaluatedPrimitive.objectId`），
 * 但适配层暂时只能喂一个对象 —— 这条差距记于本单汇报的遗留缺口，由 P3（#254）收口。
 *
 * 身份的构造方式仍然是"内容派生"而不是"批次位置派生"：`objectId` 由**结构几何身份**
 * 决定，故同一内容两次编译得到同一 `objectId`（G2 在"单对象"规模上仍可断言）。
 */
export function structurePrimitive(input: {
  definition: StructureDefinition
  layerPreview: LayerPreviewMode
  materialTint: number
}): EvaluatedPrimitive {
  const { definition, layerPreview, materialTint } = input
  const geometryId = structureGeometryId(definition, layerPreview)
  const sizeRow = definition.cellGrid[0]?.length ?? 1
  const sizeColumn = definition.cellGrid[0]?.[0]?.length ?? 1
  const sizeZ = definition.cellGrid.length

  return {
    objectId: geometryId,
    geometry: { id: geometryId, version: 'v1' },
    material: {
      id: 'structure',
      version: 'v1',
      blend: 'opaque',
      tint: materialTint,
      useVertexColor: true,
    },
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    bounds: {
      min: [-sizeColumn / 2, -sizeRow / 2, -sizeZ / 2],
      max: [sizeColumn / 2, sizeRow / 2, sizeZ / 2],
    },
    deform: 'shared',
    transparency: null,
  }
}
