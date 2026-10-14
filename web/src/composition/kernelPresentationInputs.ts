/**
 * `composition/kernelPresentationInputs` —— **内核场景 → 呈现编译输入**（#289 P10d D3c）。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | `PresentationInputs` **没有任何生产者** | — | 本模块是那个生产者：内核承载的内容 → 呈现编译能吃的纯数据 |
 *
 * ## 为什么必须有它（实测的接线缺口）
 *
 * `e2e/presentation-gpu.spec.ts` 在真实 WebGL 下已绿（A18 绘制数/负对照、A19 资源释放、
 * A30 上下文恢复），但它的输入来自 `e2e/helpers/presentation/probe.ts:50 pickFixture(count)`
 * —— **自造图元**，直接喂 `compileScene({key, geometry, primitives})`。
 *
 * 即那些判据证明的是**编译 → 呈现**那一段，**绕过**了"内核场景 → `PresentationInputs`"这一环。
 * 于是 `presentation/` 的呈现实现（编译 → 合批 → 上传）在生产上**从未被接上**
 * —— 与 D3a 的纹理链同构（判定面存在、输入侧无生产者）。
 *
 * ## 本模块**只做协调**，不重写任何判据
 *
 * 第一版曾试图直接从载荷的四边形手算三角形属性 —— 那是**重复判据**，且实测**算错了**
 * （既有纯核心会按**格位置**把几何平移到以原点为中心，手算版漏了这一步 ⇒ 几何整体偏移）。
 *
 * ⇒ 正确形态是**复用既有三件**：
 *
 * | 步骤 | 复用什么 | 为什么是它 |
 * |---|---|---|
 * | 内核载荷 → 旧格式网格 | `kernelProjection#projectGridCells` | 已实现"逐格 + 调色板 + 部件"的重建，且是 D1 验证过的路径 |
 * | 网格 → 三角形属性 | `runtime/presentationAdapter#structureMaterialGroups` | 它**委托**渲染路径同一收集器（D3a 修正后），逐 `materialIndex` 分组，故几何与渲染路径**逐位一致** |
 * | 网格 → 图元 | `runtime/presentationAdapter#structureMaterialPrimitives` | 已定义 objectId/几何身份/bounds/材质描述符的口径；**逐材质**产图元 |
 *
 * ## 分层（`gate/no-private-cross-layer`：公共出口深度 ≤ 2）
 *
 * 复用处都在**深度 2**（`composition/kernelProjection.ts`、`runtime/presentationAdapter.ts`）
 * ⇒ 合法。**不**直接 import `render/mesh/structureGeometryCore`（深度 3）
 * —— 第一版草案那样写过，被本批的深度核对拦下。
 *
 * ⚠️ `render/schema/types` 仍有**类型**引用（`StructureDefinition` 是 `projectGridCells`
 * 产物的形状）。实测扫描器**不区分** type-only 导入，故当前合法；若闸门将来收紧，
 * 这里需一并处理 —— 如实记在闸门覆盖面的边界内。
 *
 * ## 几何版本的**同源**要求（一处易错的耦合）
 *
 * `GeometrySource.versionOf(id)` 与 `EvaluatedPrimitive.geometry.version` **必须**同源 ——
 * 否则 `compileScene` 判 `geometry-version-mismatch` 并**静默跳过全部对象**
 * （表现为"画面空白但无报错"）。故两者都由**同一个** `structureMaterialPrimitives` 产出的
 * `geometry.id` 索引（逐材质组各一个 id）。
 */

import type { Scene, ObjectDataPayload } from '@/domain/scene'
import type { DocumentContent } from '@/domain/content'
import type {
  PresentationInputs,
  EvaluationKey,
  GeometrySource,
  EvaluatedPrimitive,
  GeometryAttributes,
} from '@/presentation/evaluationKey'
import { projectGridCells } from '@/composition/kernelProjection'
import { tooltipPoolOf } from '@/adapters/tooltipPool'
import { structureMaterialPrimitives } from '@/runtime/presentationAdapter'

/**
 * 网格定义的类型：从 `structureMaterialPrimitives` 的**入参**派生。
 *
 * ## 为什么不直接 import `StructureDefinition`（本批被闸门判红后的正解）
 *
 * 它只在 `render/schema/types.ts`（**深度 3**）导出 ⇒ `gate/no-private-cross-layer`
 * 判红（公共出口深度 ≤ 2）。
 *
 * ⚠️ 我第一版据此**以为**"扫描器不区分 type-only 导入"，于是留着那条 `import type`
 * 并把它写进注释当"诚实边界"。**实测那是错的** —— 闸门照样判红。
 * 同族教训：判定规则要**实跑**确认，不能按印象推断（我因为这处误判白跑了一轮）。
 *
 * ⇒ 从函数签名派生。收益不止绕过闸门：它让本模块与"网格定义长什么样"**解耦**
 * （那个形状属 `render/` 的内部约定），本模块只承诺"能喂给呈现适配层"。
 */
type GridDefinition = Parameters<typeof structureMaterialPrimitives>[0]['definition']

/**
 * `DocumentContent.resources` → `materialPalette`（**与 `kernelProjection` 的 ③ 同一映射**）。
 *
 * ⚠️ 几何收集器逐四边形读 `materialPalette[q.materialIndex]`
 * （`render/mesh/structureGeometryCore.ts:331`）—— 缺了它当场抛
 * `Cannot read properties of undefined`（本批实测）。故它**必须**随网格一起给。
 *
 * 只取几何收集真正要读的字段；`textureBlobs` 不在这里（那是 GPU 上传路径的事，
 * 属 D3a 的纹理端口）。
 */
function materialPaletteOf(content: DocumentContent): readonly Record<string, unknown>[] {
  return Object.freeze(
    content.resources.map((r, i) => {
      const entry: Record<string, unknown> = { kind: r.kind }
      if (r.blend !== null) entry.blend = r.blend
      if (r.emissive !== null) entry.emissive = r.emissive
      if (r.animation !== null) entry.animation = r.animation
      if (r.atlas !== null) entry.atlas = r.atlas
      if (r.linear !== null) entry.linear = r.linear
      if (r.useMipmaps !== null) entry.useMipmaps = r.useMipmaps
      if (r.ref.url !== '') entry.locator = r.ref.url
      if (r.payload !== null) entry.textureBlobIndex = i
      return Object.freeze(entry)
    }),
  )
}

/**
 * 内核 `blockGrid` 载荷 → `StructureDefinition` 形状（复用 `projectGridCells` 的重建）。
 *
 * ## ⚠️ 声明尺寸三字段必须一并传下去（#262 P11-A 的第二处接线点）
 *
 * `projectGridCells` 的口径是「载荷**带**声明 ⇒ 按声明输出维度」（见其说明）：
 * 载荷就在手里却不传，等于让 presenter 的网格退回**包围盒**维度 ——
 * 于是渲染网格的居中所用的 `sizeColumn/sizeRow/sizeZSlice` 与**读面**
 * （`runtime/gridRead#kernelGrid` 用声明尺寸、`context/queries#pickPartForScenePick`
 * 与 `pure/vec#structureRowToWorldY` 都吃它）**不一致**：
 * 稀疏网格上"看着在 A 格、点到却是 B 格"。
 *
 * 判据：`__tests__/p11aProjectionSize.test.ts` ⑦ 组 —— presenter 顶点与
 * "**带声明**重算"逐位相同、与"不带声明重算"**不同**（输入来自生产装配，
 * 不是手工载荷；这正是 #301 P10f D3 打回的那条纪律）。
 */
function definitionOfPayload(
  payload: Extract<ObjectDataPayload, { kind: 'blockGrid' }>,
  materialPalette: readonly Record<string, unknown>[],
): GridDefinition {
  const projected = projectGridCells({
    cells: payload.cells,
    sizeColumn: payload.sizeColumn,
    sizeRow: payload.sizeRow,
    sizeZSlice: payload.sizeZSlice,
    geometry: payload.geometry,
    cellGeometry: payload.cellGeometry,
    cellPalette: payload.cellPalette,
    palette: payload.palette,
    cellContent: payload.cellContent,
  })
  return {
    geometryPhase: 'baked',
    cellGrid: projected.cellGrid,
    blockPalette: projected.blockPalette,
    materialPalette,
    ...(projected.cellPartsGrid === undefined
      ? {}
      : { cellPartsGrid: projected.cellPartsGrid, partLists: projected.partLists }),
  } as unknown as GridDefinition
}

/**
 * 内核场景 + 内容 → `PresentationInputs`（呈现编译的**唯一**输入）。
 *
 * ## 哪些对象被跳过（**显式**报告，不静默）
 *
 * | 情况 | `reason` |
 * |---|---|
 * | 引用的对象数据不存在 | `data-missing` |
 * | 载荷不是 `blockGrid`（注解/相机/网格由各自的呈现路径负责） | `not-blockGrid:<kind>` |
 * | 无类型化几何资产（旧编辑期文档：几何由生产按方块身份现算） | `no-typed-geometry` |
 * | 逐格为空 | `empty-cells` |
 * | 全部四边形被遮挡剔除（无可见面） | `empty-geometry` |
 *
 * ## 粒度：**一个 `blockGrid` 对象 → 逐 `materialIndex` 多个图元**（C6 起）
 *
 * 每个材质组是一个独立图元（各自几何身份 + 材质 id `material:<下标>`），但它们**共享**
 * 同一个 `objectId` —— 这正是 #249 §3.3「对象身份与 GPU 批次身份分离」：对象身份不由
 * 材质分组决定，批次身份也不等于对象身份（见 `presentation/compileScene` 的图元键）。
 *
 * ## 为什么材质 id 必须是 `material:<下标>`
 *
 * `kernelTextureResources#MATERIAL_ID_PREFIX` 已把该约定定为唯一一处；不符则该材质
 * **永远无贴图**（`materialIndexFromId` 答 `null` ⇒ `createMaterial` 不设 `params.map`）。
 * 旧形态（整座结构一个图元、材质 id 恒 `'structure'`）已退役。
 */
export function kernelPresentationInputs(input: {
  readonly scene: Scene
  readonly content: DocumentContent
  readonly key: EvaluationKey
  /**
   * **分层预览**（R1-β① C8 补的形状，不是新政策）。
   *
   * 旧画面路径（`drwMeshPipeline` 的 `blockMeshProvider.build(def, lib, {layerPreview})`）
   * 与旧拾取都吃这个模式；C8 把画面切到本模块后，它是**唯一**的层过滤输入。
   * C8 之前这里硬编码 `'all'` —— 那时画面不由本链产出，所以无人察觉；一旦画面切过来，
   * 硬编码会让「分层预览」这个既有能力**静默失效**（选了 Y=3 仍画全部层）。
   *
   * 过滤语义不在此处重写：`structureMaterialPrimitives` 内部委托**渲染路径同一个**
   * 收集器（`runtime/presentationAdapter`），故"哪一层可见"只有一处定义。
   */
  readonly layerWorldY: number | null
}): {
  readonly inputs: PresentationInputs
  readonly skipped: readonly { readonly objectId: string; readonly reason: string }[]
} {
  const primitives: EvaluatedPrimitive[] = []
  const skipped: { objectId: string; reason: string }[] = []
  const materialPalette = materialPaletteOf(input.content)

  // 几何端口的数据袋：按几何身份存"版本 + 属性"。**同一个** `structureMaterialPrimitives`
  // 产出两者的来源，故 `versionOf` 与 `primitive.geometry.version` 天然同源。
  const byId = new Map<string, { readonly version: string; readonly attributes: GeometryAttributes }>()

  for (const objectId of input.scene.order) {
    const obj = input.scene.objects[objectId]
    if (obj === undefined) continue
    const data = input.scene.data[obj.dataId]
    if (data === undefined) {
      skipped.push({ objectId, reason: 'data-missing' })
      continue
    }
    if (data.payload.kind !== 'blockGrid') {
      skipped.push({ objectId, reason: `not-blockGrid:${data.payload.kind}` })
      continue
    }
    const payload = data.payload
    // 无类型化几何资产 ⇒ 本路径产不出几何（旧编辑期文档走按身份现算的旧路径）
    if (payload.geometry === undefined || payload.cellGeometry === undefined) {
      skipped.push({ objectId, reason: 'no-typed-geometry' })
      continue
    }
    if (Object.keys(payload.cells).length === 0) {
      skipped.push({ objectId, reason: 'empty-cells' })
      continue
    }

    const definition = definitionOfPayload(payload, materialPalette)
    // ⚠️ 用 D3a 修正后的收集器（`structureMaterialGroups` 内部委托渲染路径**同一个**
    // 收集器，含遮挡剔除），故本路径的几何与渲染路径**逐位一致**。
    // 修复前它不剔除 ⇒ 实测 `ebf-2ch` 会画 72 个三角形而渲染路径只画 24 个。
    //
    // 逐 `materialIndex` 一个图元（legacy `render/mesh/blockMesh.ts:87` 是同一分组）：
    // 材质 id 因此是 `material:<下标>`，与 `kernelTextureResources` 的绑定键约定对齐
    // ⇒ `createMaterial` 能设 `params.map`（贴图整链唯一缺的一环）。
    // `objectId` 逐组相同 —— 分组不改变**对象身份**（#249 §3.3）。
    const layerPreview = input.layerWorldY === null ? ('all' as const) : { worldY: input.layerWorldY }
    const groups = structureMaterialPrimitives({
      definition,
      layerPreview,
      materialTint: 0xffffff,
    })
    if (groups.length === 0) {
      // 全部四边形都被剔除（无可见面）⇒ 如实报告，不产出一个 0 三角形的"空对象"。
      skipped.push({ objectId, reason: 'empty-geometry' })
      continue
    }
    for (const g of groups) {
      byId.set(g.primitive.geometry.id, {
        version: g.primitive.geometry.version,
        attributes: g.attributes,
      })
      primitives.push(g.primitive)
    }
  }

  const geometry: GeometrySource = {
    versionOf: (id) => byId.get(id)?.version,
    attributesOf: (id) => byId.get(id)?.attributes,
  }

  return {
    inputs: Object.freeze({ key: input.key, geometry, primitives: Object.freeze(primitives) }),
    skipped: Object.freeze(skipped),
  }
}

/**
 * **DRW 定义面（直出承载体，G4 · S2 第一半）**：某一帧的网格定义 + 它的来源对象 id。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本承载体的替代 |
 * |---|---|---|
 * | 当帧定义只能由**旧格式文档**解析出来 | `runtime/drwMeshPipeline.ts:304-320`：`doc.serialize()` → `isWorldDocument && frames.length>0` → `resolveRenderBundle` | 定义来自**内核载荷**（`blockGrid`）本身，同一份重建口径 |
 * | 单结构文档在该处**永不解析出定义** | 同上（`frames.length>0` 是硬前提） | 帧下标 → 对象 id 由**装配面**显式给出，单结构/多方块/多帧同一路径 |
 *
 * ## 为什么它必须是**内核侧**的读取函数（而不是再包一层旧格式）
 *
 * `resolveRenderBundle` 的输入是 `RuntimeDocument.serialize()` —— 那是**有损**中间层
 * （见 `composition/kernelRenderView` 与 `adapters/plainRoot` 的实测）。渲染链终切的
 * 要点正是：定义面不得再经旧格式往返，否则"切源"只是换了调用形态。
 * 这里复用 `definitionOfPayload`（与 `kernelPresentationInputs` 同一重建：`projectGridCells`），
 * 故它与呈现编译吃的是**同一份**定义。
 *
 * ## 不静默：取不到时给出**可判别的** `reason`
 *
 * | 情况 | `reason` |
 * |---|---|
 * | 帧下标越界（含"没有供源"：`frameObjects` 为空） | `frame-out-of-range` |
 * | 帧对象 id 在场景里不存在 | `object-missing` |
 * | 对象数据不存在 | `data-missing` |
 * | 载荷不是 `blockGrid` | `not-blockGrid:<kind>` |
 * | 无类型化几何资产 | `no-typed-geometry` |
 * | 逐格为空 | `empty-cells` |
 *
 * ⚠️ **仍未覆盖（S2 第二半的显式欠账，不得静默当已做）**：
 *  - `tooltipPalette`（旧链路 `resolveRenderBundle.tooltipPalette` 一并返回）本函数**不产出**
 *    —— 它由 {@link kernelRenderSourceFaceOf} 在同一份载荷上补出（逐格 `cellContent[].tooltip`
 *    经 `adapters/tooltipPool` 重聚成池，与投影侧同一条编码）；
 *  - 材质混合模式推断（旧落点 `render/data/sceneDocumentMaterialHydrate.ts:88`）；
 *  - 图标缓存**身份键**（旧落点 `runtime/drwMeshPipeline.ts:263-270` 绑旧 `StructureDefinition`）。
 */
export interface KernelDefinitionFace {
  /** 定义来源的**内核对象 id**（帧下标 → 对象 id 由装配面 `frameObjects` 给出）。 */
  readonly objectId: string
  /** 内核载荷重建出的网格定义（**不是**旧格式 `StructureDefinition` 的副本或投影）。 */
  readonly definition: GridDefinition
}

/**
 * 帧下标 → 内核定义面（纯读取：显式输入、不改输入、不依赖 Vue/Three/DOM/IO）。
 *
 * @param input.frameObjects 帧下标 → 内核对象 id（装配面 `KernelAssemblyFace#frameObjects`）。
 *   空数组即"**没有供源**"——那不是"没有定义"，故如实给出 `frame-out-of-range`。
 */
export function kernelDefinitionFaceOf(input: {
  readonly scene: Scene
  readonly content: DocumentContent
  readonly frameObjects: readonly string[]
  readonly frameIndex: number
}): { readonly face: KernelDefinitionFace | null; readonly reason: string | null } {
  const objectId = input.frameObjects[input.frameIndex]
  if (objectId === undefined) return { face: null, reason: 'frame-out-of-range' }
  const obj = input.scene.objects[objectId]
  if (obj === undefined) return { face: null, reason: 'object-missing' }
  const data = input.scene.data[obj.dataId]
  if (data === undefined) return { face: null, reason: 'data-missing' }
  if (data.payload.kind !== 'blockGrid') {
    return { face: null, reason: `not-blockGrid:${data.payload.kind}` }
  }
  const payload = data.payload
  if (payload.geometry === undefined || payload.cellGeometry === undefined) {
    return { face: null, reason: 'no-typed-geometry' }
  }
  if (Object.keys(payload.cells).length === 0) return { face: null, reason: 'empty-cells' }
  return {
    face: Object.freeze({ objectId, definition: definitionOfPayload(payload, materialPaletteOf(input.content)) }),
    reason: null,
  }
}

/**
 * **DRW 渲染源面（G4 · S2 第二半 · 帧为主半）**：旧链路里由**旧格式文档**一次给全的三样
 * （当帧定义 / 逐格说明池 / 材质库输入）在内核侧的**具名承载体**。
 *
 * ## 本模块替代的旧机制（逐条对位 `runtime/drwMeshPipeline.ts` 的旧读取点）
 *
 * | 旧读取点 | 旧输入 | 本承载体的字段 |
 * |---|---|---|
 * | `:225 docRef.value?.frameCount` | 旧文档帧数 | {@link KernelRenderSourceFace.frameCount} |
 * | `:304-320`/`:344-361` `doc.serialize()` → `isWorldDocument && frames.length>0` → `resolveRenderBundle` | 旧文档帧结构 | {@link KernelRenderSourceFace.definitionAt}（复用 `kernelDefinitionFaceOf`，**同一份**重建口径） |
 * | `:314`/`:361 tooltipPalette.value = resolved.tooltipPalette` | 旧文档根 `tooltipPalette` | 同上的 `tooltipPalette`（逐格 `cellContent[].tooltip` 经 `adapters/tooltipPool` 重聚，与投影侧**同一条**编码） |
 * | `:178 buildMaterialLibrary(plain ?? doc.serialize())` | 旧文档 `materialPalette`+`textureBlobs` | {@link KernelRenderSourceFace.materialInput}（由 `content.resources` 机械派生） |
 *
 * ## 为什么"帧为主"这一半可以真切（而多方块半暂存）
 *
 * 帧为主文档的定义/说明/材质三样，在内核内容里**已经全在**（`blockGrid` 载荷 +
 * `content.resources`），故不需要任何旧格式往返。多方块的**再装配**（`doc.multiblockSource`）
 * 仍绑旧文档 —— 那是 G3（body 的内核落点）落地前**已登记**的暂存路径，与本面无关。
 *
 * ## 不静默
 *
 * `definitionAt` 取不到时回 `null`（**不**造一份"看起来能渲染"的空定义）；调用方据此
 * 保留上一次结果或显式报错。`tooltipPalette` 在"内核里没有任何逐格说明"时回**空数组**
 * （`adapters/tooltipPool` 的 `null` = 没有这一对字段；此时池为空是**如实**的，
 * 见 `runtime/tooltipRead` 对"缺席 ≠ 空"的说明）。
 */
export interface KernelRenderSourceFace {
  /** 帧数（装配面 `frameObjects` 的长度）。 */
  readonly frameCount: number
  /** 帧下标 → （定义 + 说明池）；取不到回 `null`（**不**回落到旧文档）。 */
  readonly definitionAt: (frameIndex: number) => {
    readonly definition: GridDefinition
    readonly tooltipPalette: readonly string[]
  } | null
  /**
   * 材质库（`render/data/buildMaterialLibrary`）的输入，由**内核内容**派生。
   *
   * `textureBlobs` 的键是**槽位**（= `materialPalette` 的数组下标 = 几何 `materialIndex`
   * 的索引空间；`domain/content#normalizeResources` 的排序键保证位置即槽位）。
   */
  readonly materialInput: {
    readonly geometryPhase: 'baked'
    readonly materialPalette: readonly Record<string, unknown>[]
    readonly textureBlobs: Readonly<Record<string, string>>
  }
}

/** 内核 `content.resources` → `textureBlobs`（**槽位**为键，只收有内嵌字节的条）。 */
function textureBlobsOfContent(content: DocumentContent): Readonly<Record<string, string>> {
  const blobs: Record<string, string> = {}
  for (let i = 0; i < content.resources.length; i++) {
    const payload = content.resources[i]!.payload
    if (payload !== null) blobs[String(i)] = payload
  }
  return Object.freeze(blobs)
}

/**
 * 内核场景 + 内容 + 装配面 → **DRW 渲染源面**（纯读取：显式输入、不改输入、不依赖 Vue/Three/DOM/IO）。
 *
 * @param input.frameObjects 帧下标 → 内核对象 id（装配面 `KernelAssemblyFace#frameObjects`）。
 */
export function kernelRenderSourceFaceOf(input: {
  readonly scene: Scene
  readonly content: DocumentContent
  readonly frameObjects: readonly string[]
}): KernelRenderSourceFace {
  const materialPalette = materialPaletteOf(input.content)
  return Object.freeze({
    frameCount: input.frameObjects.length,
    definitionAt: (frameIndex: number) => {
      const r = kernelDefinitionFaceOf({ ...input, frameIndex })
      if (r.face === null) return null
      const obj = input.scene.objects[r.face.objectId]
      const data = obj === undefined ? undefined : input.scene.data[obj.dataId]
      if (data === undefined || data.payload.kind !== 'blockGrid') return null
      const pool = tooltipPoolOf(data.payload.cellContent)
      return Object.freeze({
        definition: r.face.definition,
        tooltipPalette: pool === null ? Object.freeze([]) : pool.palette,
      })
    },
    materialInput: Object.freeze({
      geometryPhase: 'baked' as const,
      materialPalette,
      textureBlobs: textureBlobsOfContent(input.content),
    }),
  })
}
