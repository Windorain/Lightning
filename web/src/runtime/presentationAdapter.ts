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
import { triangleCellMapOf } from '@/presentation/cellIdentity'
import { contentDigestOf } from '@/presentation/invalidationPlan'
// 几何收集**只有一个**入口（D3a 更正：原先本文件另有一份手写遍历，它不做遮挡剔除
// ⇒ 与渲染路径数值不一致。C6 起那个重复实现连同它的导出一起删除，收集只发生在
// `structureMaterialGroups` 内）。
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
 * 帧网格的**调色板条目内容**（内容级身份；`#334`）。
 *
 * ## 为什么读**网格的 palette cache**（而不是"已解析的定义"）
 *
 * `readContentIdentity` 的入参里已有一份 `definition`，它的 `blockPalette` 也带条目内容 ——
 * 但**不能用**：定义是**渲染产物**（`resolveRenderBundle(doc.serialize())` 的结果），
 * 判定发生在重解**之前**，故此刻手里那份定义必然是**上一轮**的。用它当内容身份会形成
 * 「要检测新内容 ⇒ 先得有新内容」的自指闭环 ⇒ 判定永远为一轮之前的状态服务
 * （`#334` 实测：切运行态时 `readContentIdentity({doc: 新文档, definition: 旧定义})`
 * 与切换前**逐字节相同**，`planContentRebuild` 全 false）。
 *
 * 文档（`docRef.value`）没有这个滞后：它就是"待渲染的内容"本身，取值一变它立刻变
 * （`composition/kernelRenderView#kernelRenderViewOf` 的投影产物）。
 * ⇒ 内容级身份必须**从文档机械派生**（与本模块文件头"必须由读集派生"同一纪律）。
 *
 * ## 顺序与稳定性
 *
 * 逐条输出 `[缓存键, 条目]`，按键**字典序**排序（不依赖 `Map` 插入序）：同一份内容
 * 必然得到同一个摘要，与装配/解析的遍历顺序无关。
 */
export function paletteContentOf(grid: Grid | null): readonly unknown[] {
  if (grid === null) return []
  return [...grid.getPaletteCache().entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, entry]) => [key, entry])
}

/**
 * 从文档派生**内容身份**（`structEpoch` 的替代读取面）。
 *
 * `frameIndex` 与 `layerPreview` 参与结构摘要：它们改变被采集的几何
 * （换帧 = 换一整份网格；分层预览 = 只采集某一层）。这不是"非内容版本冒充内容变化" ——
 * 它们**确实**改变呈现内容；而机位/选择/布局**不**在本函数的任何入参里，
 * 因此它们**不可能**影响身份。
 *
 * ⚠️ **`definition` 是"已解析的呈现产物"，不是内容源**（`#334` 更正）：它只贡献
 * **名称级**调色板身份（跨实现口径，重解前后不变）；**内容级**调色板身份取自
 * **文档自身**（`paletteContentOf`）—— 否则判定会晚一轮，运行态这类"同名称、异条目内容"
 * 的变化永远不被判为变化。两条各自成立，都是"读了就声明"的直接结果。
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
      paletteContent: paletteContentOf(grid),
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
 * 把结构几何投影成**逐材质**的呈现条目（#249 §3.3「对象身份与 GPU 批次身份分离」）。
 *
 * ## 身份的两个层次（本函数是这条分离的**唯一**产出点）
 *
 * | 层次 | 取值 | 为什么 |
 * |---|---|---|
 * | **对象身份** `objectId` | 结构几何身份（内容派生，**逐组相同**） | "这一座结构"是一个对象；材质分组不改变对象身份 |
 * | **批次身份** | 由 `compileScene` 按**图元**划分 | 一个对象可以展开成多个材质图元 ⇒ 批次 ≠ 对象 |
 *
 * `objectId` 由**结构几何身份**决定，故同一内容两次编译得到同一 `objectId`（G2）。
 * 几何身份逐组不同（`<base>:m<下标>`）—— 同 id 会让后一组覆盖前一组的属性袋
 * （`GeometrySource` 按几何身份存），表现为"某些材质画的是别的材质的几何"且**没有任何报错**。
 *
 * ## 为什么材质 id 是 `material:<下标>`
 *
 * `composition/kernelTextureResources#MATERIAL_ID_PREFIX` 已把该约定定为**唯一**一处
 * （绑定键 → 资源表下标）；legacy 亦按 `materialIndex` 分组
 * （`render/mesh/blockMesh.ts:87` 的 `materialId: String(w.materialIndex)`）。
 *
 * ## 单材质定义退化成什么
 *
 * 恰好一个组、材质 id `material:0` —— **不**保留 `'structure'` 这个旧 id：
 * 那个 id 不符合绑定约定 ⇒ 该材质永远无贴图（C5 实测的贴图断路）。
 * "为了不让某个旧消费者坏而保留旧面"在此不成立：消费者是呈现链自己，同批改写。
 */
export function structureMaterialPrimitives(input: {
  definition: StructureDefinition
  layerPreview: LayerPreviewMode
  materialTint: number
}): readonly {
  readonly primitive: EvaluatedPrimitive
  readonly attributes: GeometryAttributes
}[] {
  const { definition, layerPreview, materialTint } = input
  const objectId = structureGeometryId(definition, layerPreview)
  const sizeRow = definition.cellGrid[0]?.length ?? 1
  const sizeColumn = definition.cellGrid[0]?.[0]?.length ?? 1
  const sizeZ = definition.cellGrid.length
  const transform: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const bounds = {
    min: [-sizeColumn / 2, -sizeRow / 2, -sizeZ / 2],
    max: [sizeColumn / 2, sizeRow / 2, sizeZ / 2],
  } as const

  return structureMaterialGroups({ definition, layerPreview }).map((g) => ({
    primitive: {
      // ← **对象身份**：同一对象的所有材质组共享它。
      objectId,
      geometry: { id: g.geometryId, version: 'v1' },
      material: {
        id: g.materialId,
        version: 'v1',
        blend: g.blend,
        tint: materialTint,
        useVertexColor: true,
      },
      transform: [...transform],
      bounds: { min: [...bounds.min], max: [...bounds.max] },
      deform: 'shared',
      transparency: null,
    },
    attributes: g.attributes,
  }))
}

/**
 * **按材质下标分组**的结构几何（#301 P10f D3「材质统一」的关键缺口修复；R1-β① C5）。
 *
 * ## 它修的是什么（一个**真实**的贴图断路）
 *
 * `mergeBakedQuadPiecesAttributes` 把**全部**四边形并进**一个**几何，而
 * `structurePrimitive` 只给**一个**材质 `id: 'structure'`。于是：
 *
 *  - `presentation/presenter#createMaterial` 只在 `binding.map` 在场时才设 `params.map`；
 *  - 而 `composition/kernelTextureResources#textureBindingsOf` 的绑定键是
 *    `material:<下标>`（`MATERIAL_ID_PREFIX` 的约定，与几何的 `materialIndex`、
 *    资源表下标三者对齐）；
 *  - `'structure'` **不**符合该约定 ⇒ `materialIndexFromId` 答 `null` ⇒ 该材质永远"无贴图"。
 *
 * ⇒ **即使 `TexturePort` 实现齐备、贴图全部解码成功，网格画面上也不会有任何一张贴图。**
 * 这一条是"材质统一未交付"的**实质**原因（接缝原文只说"呈现层是 `MeshBasicMaterial`"，
 * 未指出几何分组这一层）。
 *
 * ## 分组口径与 legacy **同一**语义
 *
 * legacy `render/mesh/blockMesh.ts:87` 用 `materialId: String(w.materialIndex)` 按材质
 * 分组建 mesh —— 即"一个材质一个绘制批次"。本函数产出同一分组的**纯数据**形态：
 * 逐 `materialIndex` 过滤四边形、各自 merge、各自算 `cellMap`
 * （`triangleCellMapOf` 按片序展开，故过滤后仍然"第 t 个三角形属于哪一格"由构造保证）。
 *
 * ## 为什么材质 id 是 `material:<下标>`（而不是另起一套命名）
 *
 * 那条约定已由 `kernelTextureResources` 定为**唯一**一处（"两个地方各写一遍就会漂移，
 * 而漂移的后果是静默贴错纹理"）。本函数只是**遵守**它。
 *
 * ## 为什么 `blend` 取自调色板条目
 *
 * 逐四边形的 `matPalette` 就是文档的材质调色板条目（含 `blend`/`emissive`）。
 * 分组后每组的 blend 是**组内一致**的（同一 `materialIndex` ⇒ 同一条目），
 * 故按组取它是精确的，不是近似。缺字段 ⇒ `'opaque'`（与 `MeshBasicMaterial` 的缺省一致）。
 *
 * ## 现状：生产**已**接通（R1-β① C6）
 *
 * 生产 `composition/kernelPresentationInputs` 现在走 `structureMaterialPrimitives`（本函数 +
 * 对象身份/包围盒/变换的装配），于是「一个 `blockGrid` 对象 → 逐 `materialIndex` 多个图元、
 * 材质 id `material:<下标>`」真的成立，绑定键能命中 ⇒ `createMaterial` 会设 `params.map`。
 *
 * 接通它的**前提**是 `presentation/compileScene` 的批次/来源划分同时从"按 `objectId`"改为
 * "按**图元**"（#249 §3.3「对象身份与 GPU 批次身份分离」）：分组图元共享同一内核对象 id，
 * 若批次仍以 `objectId` 为键，第二个图元会覆盖第一个的槽位 ⇒ `provenance` 把两组记进同一
 * 批次而 `payloads` 是两个批次 ⇒ 拾取解不出。两处是**同一个**改动的两面，不可只做一半。
 */
export function structureMaterialGroups(input: {
  definition: StructureDefinition
  layerPreview: LayerPreviewMode
}): readonly {
  readonly materialIndex: number
  readonly materialId: string
  readonly blend: 'opaque' | 'cutout' | 'translucent'
  readonly geometryId: GeometryId
  readonly attributes: GeometryAttributes
}[] {
  const { definition, layerPreview } = input
  const collected = collectStructureGeometryPiecesPure(definition, { layerPreview })
  const baseId = structureGeometryId(definition, layerPreview)

  const order: number[] = []
  const byMaterial = new Map<number, typeof collected.pieces>()
  for (const p of collected.pieces) {
    const list = byMaterial.get(p.materialIndex)
    if (list === undefined) {
      byMaterial.set(p.materialIndex, [p])
      order.push(p.materialIndex)
    } else {
      list.push(p)
    }
  }

  const out: {
    materialIndex: number
    materialId: string
    blend: 'opaque' | 'cutout' | 'translucent'
    geometryId: GeometryId
    attributes: GeometryAttributes
  }[] = []
  for (const mi of order) {
    const pieces = byMaterial.get(mi)!
    const merged = mergeBakedQuadPiecesAttributes(pieces)
    const palette = pieces[0]?.matPalette as { blend?: unknown } | undefined
    out.push({
      materialIndex: mi,
      materialId: `material:${mi}`,
      blend: asBlend(palette?.blend),
      // 几何身份**必须**逐组不同：`byId` 是按 `primitive.geometry.id` 存的
      // （`presentationAdapter` 的 `GeometrySource` 口径），同 id 会让后一组覆盖前一组
      // ⇒ 表现为"某些材质画的是别的材质的几何"（且没有任何报错）。
      geometryId: `${baseId}:m${mi}`,
      attributes: {
        positions: merged.positions,
        uvs: merged.uvs,
        colors: merged.colors,
        triangleCount: merged.positions.length / 9,
        cellMap: triangleCellMapOf(pieces),
      },
    })
  }
  return Object.freeze(out)
}

/** 调色板条目的 `blend` → 呈现的混合模式（缺省 `'opaque'`，与 legacy 缺省一致）。 */
function asBlend(v: unknown): 'opaque' | 'cutout' | 'translucent' {
  return v === 'cutout' || v === 'translucent' ? v : 'opaque'
}
