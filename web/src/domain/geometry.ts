/**
 * `domain/geometry` —— **网格数据、稳定元素身份、固定拓扑形变与来源映射**
 * （#249 §3.2、§14 A07、§15 第 9 条；契约 §1.2 `ElementRef`、§1.1 `EntityRef`）。
 *
 * ## 本模块替代的旧机制（#249 §15 第 9 条 · 退役 slug `grid-coord-as-identity`）
 *
 * 旧实现让**空间坐标与批次序号兼任对象/元素身份**：
 *
 * | 旧位置 | 旧形态 | 后果 |
 * |---|---|---|
 * | `render/mesh/blockMesh.ts` 的 `batchIdx` | 局部递增整数，写进 `renderOrder` 并作为网格身份 | 重新分批/移出一个对象后"身份"漂移（A18 负对照） |
 * | `pure/materialTypes.ts` 的 `materialId` 注释与 `pure/materialPaletteBridge.ts` 的 `String(i)` | 由**帧号 + 数组下标**派生的字符串 | 插入一个调色板条目即让所有后续材质换身份 |
 * | `render/data/bundleResolve.ts` 的 `` `${frameIndex}:${slotIndex}` `` | **合成键**当材质身份 | 同一份内容在不同帧序下得到不同身份 |
 *
 * 本模块交付的是**语义替代**：身份是分配的稳定 ID（`VertexId`/`EdgeId`/`FaceId`），
 * 一切跨界引用都过 `ElementRef`（含 `topologyVersion`），而渲染侧的批次/槽位序号
 * 只能作为**局部序号**存在，取身份**必须**经 {@link GeometrySourceMap}（见
 * `buildGeometrySourceMap` / `resolveByOrdinal`）。
 *
 * ## 三条冻结语义的落点
 *
 * ### 1. 不得把 GPU 索引作为持久身份（#249 §3.2 明文）
 *
 * `MeshTopology` 里**没有**任何索引数组（无 `Uint32Array`、无 `indices`）：
 * 面由**顶点 ID 列表**表达，边由**顶点 ID 对**表达。GPU 顶点展开（纹理接缝/法线
 * 导致的分裂）由渲染编译处理，不进领域身份。测试
 * `geometryIdentity.test.ts > 拓扑里不存在索引数组` 逐字段证明这一点。
 *
 * ### 2. 拓扑版本变化使旧引用**显式失效**，不静默猜配（#249 §3.2）
 *
 * {@link resolveVertex} / {@link resolveEdge} / {@link resolveFace} **先比较
 * `topologyVersion`**，不符即返回 `StaleReference`（契约 §3.2 明文：严禁
 * "静默猜配到同名对象或相同坐标的新对象"）。实现上不是"找不到再报错"，
 * 而是"版本不符立刻拒绝" —— 于是"按编号复用旧引用"这条捷径在类型与逻辑上都不存在。
 * 迁移/重绑定政策为远期非目标（本单不提供，也不假装提供）。
 *
 * ### 3. 固定拓扑形变不改写基础网格（#249 §3.2）
 *
 * {@link evaluateDeformation} 是**纯求值**：输入基础 `MeshData` + 显式权重，
 * 输出 `vertexId → 有效位置` 的新只读映射；基础网格的 `vertices[*].position`
 * 一字不改。`Deformation` 自带 `topologyVersion`，与网格不符即拒绝求值
 * （拓扑一变，形变数据就不是"同一张网"的了 —— 这一条同样是显式失效）。
 *
 * ## 具名领域数据（#249 §3.1）
 *
 * 「方块的 Minecraft 身份、部件信息、原始资源来源属于**具名**的领域数据；
 * 不能用当前空间坐标替代对象身份」。{@link BlockCellDomainData} 是其落地，
 * {@link blockCellIdentityKey} 生成的稳定键**只**由 MC 身份构成 ——
 * 移动对象不改变它（负对照见测试）。
 *
 * ## 与 P1 体系的关系
 *
 * 本模块**不另起**对象/数据/版本结构：网格以 `ObjectDataPayload` 的 `'mesh'` 分支
 * 进入 `domain/scene` 的 `ObjectData`（见 `domain/scene.ts#ObjectDataPayload`），
 * `ObjectData.topologyVersion` 由 {@link topologyVersionOf} 从网格拓扑版本导出，
 * 于是 `application/commands.ts#validatePropertyWrite` 那条既有的
 * `StaleReference` 判定**自动**覆盖网格元素引用 —— 不需要第二条校验通路。
 */

import { digestOf, type ElementRef } from './identity'
import { err, invalidValue, missingTarget, ok, staleReference, type Result } from './errors'

// ─────────────────────────────────────────────────────────────────────────────
// 基础值（与 `domain/scene` 的 Vec3 同一形状；此处 type-only 引用以避免运行期环）
// ─────────────────────────────────────────────────────────────────────────────

import type { Scene, Vec3 } from './scene'

// ─────────────────────────────────────────────────────────────────────────────
// 元素身份
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 顶点的**局部稳定身份**。
 *
 * 为什么是字符串而不是数组下标：#249 §3.2 允许"局部稳定身份**或**由拓扑版本限定的
 * 等价稳定寻址"两条路径，本实现走**两条都占**：既给顶点真身份，又用
 * `topologyVersion` 限定引用。理由是可测性 —— 只有"真身份"才能让
 * 「拓扑重排后旧引用必须失效」与「重排后身份仍然正确」成为两条独立断言；
 * 纯下标方案下这两件事不可区分。
 *
 * 它不是"分配序号"：`object-3` 这类由 P1 `allocateId` 产生的序数**不得**用作
 * 顶点身份（那正是 §15 第 9 条要退役的形态）。合法来源是由几何构造方按
 * **语义来源**给出的稳定名字（例如部件 `localId` 与顶点角色拼接），见
 * {@link vertexIdFromPart}。
 */
export type VertexId = string
export type EdgeId = string
export type FaceId = string

/** 元素种类。选择模式与锚点都按它分流（#249 §19.2 末段）。 */
export type GeometryElementKind = 'vertex' | 'edge' | 'face'

/**
 * 网格顶点位置的 **RNA 属性 ID**。
 *
 * 用**属性引用**（`PropertyRef{ owner: objectRef, property: 'mesh.vertexPosition',
 * element: ElementRef }`）承载顶点写，而不是新增一条命令。
 *
 * 为什么必须是这条路（而不是加一条 `setVertexPosition` 命令）：
 *  1. 契约 §5.2：「存在**唯一**写路由…不存在第二条属性写通路」。顶点位置是一条
 *     **合法属性写**，故它必须走 `setProperty`；
 *  2. 契约 §1.3 的 `PropertyRef` **本来就带** `element?: ElementRef` —— 子元素寻址
 *     是既有设计的一部分，不是为几何新开的旁路；
 *  3. `application/commands.ts#validatePropertyWrite` 里那条
 *     「`ref.element.topologyVersion !== data.topologyVersion` ⇒ `StaleReference`」
 *     因此**自动**覆盖顶点写，不需要第二条校验通路（这正是 #254 E1 的落点）。
 */
export const MESH_VERTEX_POSITION_PROPERTY = 'mesh.vertexPosition'

/**
 * 按**语义来源**构造顶点 ID。
 *
 * 关键区别：`batchIdx` 式的身份在"重排/分批"后会变，而这里的输入
 * （部件局部身份 + 顶点角色）由内容定义给出，与顺序无关。
 */
export function vertexIdFromPart(partLocalId: string, role: string): VertexId {
  return `${partLocalId}#${role}`
}

/** 按语义来源构造边 ID（无序对，保证 `a`/`b` 交换得到同一身份）。 */
export function edgeIdOf(a: VertexId, b: VertexId): EdgeId {
  return a <= b ? `${a}|${b}` : `${b}|${a}`
}

/** 按语义来源构造面 ID（顶点集合排序后拼接，与绕序无关，与枚举顺序无关）。 */
export function faceIdOf(vertices: readonly VertexId[]): FaceId {
  return `f:${[...vertices].sort().join('|')}`
}

// ─────────────────────────────────────────────────────────────────────────────
// 拓扑与属性
// ─────────────────────────────────────────────────────────────────────────────

/** 顶点：**身份 + 局部位置**（位置属基础网格，形变不改它）。 */
export interface MeshVertex {
  readonly id: VertexId
  readonly position: Vec3
}

/** 边：由**两个顶点身份**表达（不是索引对）。 */
export interface MeshEdge {
  readonly id: EdgeId
  readonly a: VertexId
  readonly b: VertexId
}

/**
 * 面：由**顶点身份列表**表达。
 *
 * `triangles` 是**派生**的可选三角化（供呈现消费），它同样用顶点身份而不是索引。
 * 领域身份不依赖它；渲染侧的 GPU 展开由呈现编译负责（#249 §3.2）。
 */
export interface MeshFace {
  readonly id: FaceId
  readonly vertices: readonly VertexId[]
}

/**
 * 逐顶点属性层（法线、UV、顶点色、形变掩码…）。
 *
 * `values` 的长度必须等于顶点数（校验在 {@link meshTopology} 里做，非法即拒绝构造，
 * 不静默补零）。它是**普通只读数组**而不是 `TypedArray`：契约 §2.2 明文
 * 「`PropertyValue` 不得是可变底层 TypedArray 的引用」，大批量几何查询另给
 * 批量投影（见 `application/queries.ts` 的对象/数据投影面）。
 */
export interface MeshAttributeLayer {
  readonly name: string
  /** 分量数（1 = 标量，2/3/4 = 向量）。 */
  readonly components: number
  readonly values: readonly number[]
}

/**
 * 逻辑拓扑。
 *
 * `version` 是**元素引用有效性的唯一依据**（契约 §1.2）。任何增删改结构
 * （哪怕是重排顶点顺序）都必须经 {@link bumpTopology} 推进它 ——
 * 于是"结构变了但版本没变"这种静默漂移不可表达。
 */
export interface MeshTopology {
  readonly version: number
  readonly vertices: readonly MeshVertex[]
  readonly edges: readonly MeshEdge[]
  readonly faces: readonly MeshFace[]
  readonly attributes: readonly MeshAttributeLayer[]
}

/** 构造拓扑并**校验**（长度不符/重复身份/悬空边即拒绝，不静默修正）。 */
export function meshTopology(init: {
  version?: number
  vertices: readonly MeshVertex[]
  edges?: readonly MeshEdge[]
  faces?: readonly MeshFace[]
  attributes?: readonly MeshAttributeLayer[]
}): Result<MeshTopology> {
  const version = init.version ?? 0
  if (!Number.isInteger(version) || version < 0) {
    return err(invalidValue({ reason: 'badTopologyVersion', version: String(version) }))
  }
  const seen = new Set<string>()
  for (const v of init.vertices) {
    if (seen.has(v.id)) return err(invalidValue({ reason: 'duplicateVertexId', elementId: v.id }))
    seen.add(v.id)
    if (!isFiniteVec3(v.position)) return err(invalidValue({ reason: 'nonFiniteVertexPosition', elementId: v.id }))
  }
  if (init.vertices.length === 0) return err(invalidValue({ reason: 'emptyTopology' }))
  const edges = init.edges ?? []
  for (const e of edges) {
    if (!seen.has(e.a) || !seen.has(e.b)) return err(missingTarget({ reason: 'danglingEdge', edgeId: e.id, a: e.a, b: e.b }))
    if (e.a === e.b) return err(invalidValue({ reason: 'degenerateEdge', edgeId: e.id }))
  }
  const faces = init.faces ?? []
  for (const f of faces) {
    if (f.vertices.length < 3) return err(invalidValue({ reason: 'degenerateFace', faceId: f.id }))
    for (const vid of f.vertices) {
      if (!seen.has(vid)) return err(missingTarget({ reason: 'danglingFaceVertex', faceId: f.id, elementId: vid }))
    }
  }
  const attributes = init.attributes ?? []
  for (const layer of attributes) {
    if (layer.components < 1 || !Number.isInteger(layer.components)) {
      return err(invalidValue({ reason: 'badAttributeComponents', name: layer.name, components: layer.components }))
    }
    if (layer.values.length !== init.vertices.length * layer.components) {
      return err(
        invalidValue({
          reason: 'attributeLengthMismatch',
          name: layer.name,
          expected: init.vertices.length * layer.components,
          actual: layer.values.length,
        }),
      )
    }
  }
  return ok(
    Object.freeze({
      version,
      vertices: Object.freeze([...init.vertices]),
      edges: Object.freeze([...edges]),
      faces: Object.freeze([...faces]),
      attributes: Object.freeze([...attributes]),
    }),
  )
}

/** 推进拓扑版本。**唯一**改变结构的方式（结构变更与版本推进同批发生）。 */
export function bumpTopology(topology: MeshTopology, next: {
  vertices?: readonly MeshVertex[]
  edges?: readonly MeshEdge[]
  faces?: readonly MeshFace[]
  attributes?: readonly MeshAttributeLayer[]
}): Result<MeshTopology> {
  return meshTopology({
    version: topology.version + 1,
    vertices: next.vertices ?? topology.vertices,
    edges: next.edges ?? topology.edges,
    faces: next.faces ?? topology.faces,
    // 属性层长度随顶点数变化；未显式给出时**丢弃**旧的（静默错位比丢弃危险得多）
    attributes: next.attributes ?? (next.vertices === undefined ? topology.attributes : []),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// MeshData（对象数据的 `'mesh'` 载荷）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 网格数据：拓扑 + 可选形变 + 内容身份。
 *
 * `contentVersion` 取 {@link meshContentVersion}（对拓扑与形变做**规范化**摘要），
 * 供 `StaleReference` 与求值键使用 —— 与 P1 `ObjectData.contentVersion` 同一口径。
 */
export interface MeshData {
  readonly id: string
  readonly topology: MeshTopology
  /** 形变数据；`undefined` = 无形变（"无声明"与"权重为 0"是两件事，见 §19.3 同族要求）。 */
  readonly deformation?: Deformation
}

/** 网格的内容身份（规范摘要；纯函数）。 */
export function meshContentVersion(mesh: MeshData): number {
  return digestOf({
    topology: {
      version: mesh.topology.version,
      vertices: mesh.topology.vertices.map((v) => ({ id: v.id, position: v.position })),
      edges: mesh.topology.edges.map((e) => ({ id: e.id, a: e.a, b: e.b })),
      faces: mesh.topology.faces.map((f) => ({ id: f.id, vertices: f.vertices })),
      attributes: mesh.topology.attributes.map((a) => ({ name: a.name, components: a.components, values: a.values })),
    },
    deformation: mesh.deformation
      ? {
          id: mesh.deformation.id,
          topologyVersion: mesh.deformation.topologyVersion,
          channels: mesh.deformation.channels.map((c) => ({
            id: c.id,
            targets: c.targets.map((t) => ({ vertex: t.vertex, offset: t.offset })),
          })),
        }
      : null,
  })
}

export function meshData(id: string, topology: MeshTopology, deformation?: Deformation): MeshData {
  const base = deformation === undefined ? { id, topology } : { id, topology, deformation }
  return Object.freeze(base)
}

/**
 * 网格载荷的标准形状。
 *
 * 它被 `domain/scene.ts` 的 `ObjectDataPayload` 联合收录 ——
 * 于是网格**就是**一份对象数据，不需要第二个数据注册表。
 */
export interface MeshPayload {
  readonly kind: 'mesh'
  readonly mesh: MeshData
}

export function meshPayload(mesh: MeshData): MeshPayload {
  return Object.freeze({ kind: 'mesh' as const, mesh })
}

/**
 * 由对象数据载荷导出**拓扑版本**（供 `ObjectData.topologyVersion`）。
 *
 * 非网格载荷返回 `0`（它们没有子元素结构，`ElementRef` 对它们无意义 ——
 * 提交时会被 `application` 层按"该种类无子元素"显式拒绝，而不是静默通过）。
 */
export function topologyVersionOf(payload: { readonly kind: string; readonly mesh?: MeshData }): number {
  return payload.kind === 'mesh' && payload.mesh ? payload.mesh.topology.version : 0
}

// ─────────────────────────────────────────────────────────────────────────────
// 标准体（供 `addObject` 与测试使用；**真实几何**，不是占位）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 单位立方体网格：8 顶点、12 边、6 面。
 *
 * 顶点身份按**语义角色**命名（`x0y0z0` … `x1y1z1`）而不是下标 —— 于是
 * "重排顶点数组不改变身份"成为事实，而不是需要靠约定维持的纪律。
 * 这正是对 `batchIdx` 式身份的直接否证：下标会随枚举顺序漂移，角色不会。
 */
export function unitBoxMesh(id: string, size = 1, deformation?: Deformation): Result<MeshData> {
  if (!(size > 0) || !Number.isFinite(size)) return err(invalidValue({ reason: 'badBoxSize', size }))
  const h = size / 2
  const role = (x: number, y: number, z: number): VertexId => `x${x}y${y}z${z}`
  const ids = new Map<string, VertexId>()
  const vertices: MeshVertex[] = []
  for (const x of [0, 1]) {
    for (const y of [0, 1]) {
      for (const z of [0, 1]) {
        const vid = role(x, y, z)
        ids.set(`${x}${y}${z}`, vid)
        vertices.push(Object.freeze({ id: vid, position: Object.freeze({ x: (x ? 1 : -1) * h, y: (y ? 1 : -1) * h, z: (z ? 1 : -1) * h }) }))
      }
    }
  }
  const V = (x: number, y: number, z: number): VertexId => ids.get(`${x}${y}${z}`) as VertexId
  const edges: MeshEdge[] = []
  const seenEdge = new Set<EdgeId>()
  const addEdge = (a: VertexId, b: VertexId): void => {
    const eid = edgeIdOf(a, b)
    if (seenEdge.has(eid)) return
    seenEdge.add(eid)
    edges.push(Object.freeze({ id: eid, a, b }))
  }
  for (const y of [0, 1]) {
    for (const z of [0, 1]) addEdge(V(0, y, z), V(1, y, z))
  }
  for (const x of [0, 1]) {
    for (const z of [0, 1]) addEdge(V(x, 0, z), V(x, 1, z))
  }
  for (const x of [0, 1]) {
    for (const y of [0, 1]) addEdge(V(x, y, 0), V(x, y, 1))
  }
  const quad = (a: VertexId, b: VertexId, c: VertexId, d: VertexId): MeshFace => {
    const vs = Object.freeze([a, b, c, d])
    return Object.freeze({ id: faceIdOf(vs), vertices: vs })
  }
  const faces: MeshFace[] = [
    quad(V(0, 0, 0), V(0, 0, 1), V(0, 1, 1), V(0, 1, 0)),
    quad(V(1, 0, 0), V(1, 1, 0), V(1, 1, 1), V(1, 0, 1)),
    quad(V(0, 0, 0), V(1, 0, 0), V(1, 0, 1), V(0, 0, 1)),
    quad(V(0, 1, 0), V(0, 1, 1), V(1, 1, 1), V(1, 1, 0)),
    quad(V(0, 0, 0), V(0, 1, 0), V(1, 1, 0), V(1, 0, 0)),
    quad(V(0, 0, 1), V(1, 0, 1), V(1, 1, 1), V(0, 1, 1)),
  ]
  const topo = meshTopology({ vertices, edges, faces })
  if (!topo.ok) return topo
  return ok(meshData(id, topo.value, deformation))
}

// ─────────────────────────────────────────────────────────────────────────────
// 元素引用解析（先验版本，再找元素 —— 顺序即"不静默猜配"的实现）
// ─────────────────────────────────────────────────────────────────────────────

/** 元素在拓扑中的解析结果（含其所属种类与已解析的顶点）。 */
export type ResolvedElement =
  | { readonly kind: 'vertex'; readonly vertex: MeshVertex }
  | { readonly kind: 'edge'; readonly edge: MeshEdge; readonly a: MeshVertex; readonly b: MeshVertex }
  | { readonly kind: 'face'; readonly face: MeshFace; readonly vertices: readonly MeshVertex[] }

/** 用当前拓扑版本造一个合法的元素引用。 */
export function elementRefOf(topology: MeshTopology, elementId: string): ElementRef {
  return Object.freeze({ elementId, topologyVersion: topology.version })
}

/** 顶点查找（**不做**任何版本判定 —— 内部用；跨界一律走 {@link resolveVertex}）。 */
function findVertex(topology: MeshTopology, id: VertexId): MeshVertex | undefined {
  for (const v of topology.vertices) if (v.id === id) return v
  return undefined
}

/**
 * 解析顶点引用。
 *
 * **顺序是契约的一部分**：先比 `topologyVersion`，不符立刻 `StaleReference`；
 * 只有版本吻合才按 `elementId` 查找。于是"拓扑变了、但恰好有个同位置/同下标的顶点"
 * 这种情况**不可能**被猜配 —— 这正是契约 §1.2 负对照要判红的形态。
 */
export function resolveVertex(topology: MeshTopology, ref: ElementRef): Result<MeshVertex> {
  if (ref.topologyVersion !== topology.version) {
    return err(staleReference({ elementId: ref.elementId, expected: ref.topologyVersion, actual: topology.version }))
  }
  const v = findVertex(topology, ref.elementId)
  if (!v) return err(missingTarget({ reason: 'noSuchVertex', elementId: ref.elementId }))
  return ok(v)
}

export function resolveEdge(topology: MeshTopology, ref: ElementRef): Result<MeshEdge> {
  if (ref.topologyVersion !== topology.version) {
    return err(staleReference({ elementId: ref.elementId, expected: ref.topologyVersion, actual: topology.version }))
  }
  for (const e of topology.edges) if (e.id === ref.elementId) return ok(e)
  return err(missingTarget({ reason: 'noSuchEdge', elementId: ref.elementId }))
}

export function resolveFace(topology: MeshTopology, ref: ElementRef): Result<MeshFace> {
  if (ref.topologyVersion !== topology.version) {
    return err(staleReference({ elementId: ref.elementId, expected: ref.topologyVersion, actual: topology.version }))
  }
  for (const f of topology.faces) if (f.id === ref.elementId) return ok(f)
  return err(missingTarget({ reason: 'noSuchFace', elementId: ref.elementId }))
}

/** 按种类分流的统一解析入口（选择模式与锚点用同一个）。 */
export function resolveElement(topology: MeshTopology, kind: GeometryElementKind, ref: ElementRef): Result<ResolvedElement> {
  if (kind === 'vertex') {
    const r = resolveVertex(topology, ref)
    return r.ok ? ok({ kind: 'vertex' as const, vertex: r.value }) : r
  }
  if (kind === 'edge') {
    const r = resolveEdge(topology, ref)
    if (!r.ok) return r
    const a = findVertex(topology, r.value.a)
    const b = findVertex(topology, r.value.b)
    if (!a || !b) return err(missingTarget({ reason: 'danglingEdge', edgeId: r.value.id }))
    return ok({ kind: 'edge' as const, edge: r.value, a, b })
  }
  const r = resolveFace(topology, ref)
  if (!r.ok) return r
  const vs: MeshVertex[] = []
  for (const vid of r.value.vertices) {
    const v = findVertex(topology, vid)
    if (!v) return err(missingTarget({ reason: 'danglingFaceVertex', faceId: r.value.id, elementId: vid }))
    vs.push(v)
  }
  return ok({ kind: 'face' as const, face: r.value, vertices: Object.freeze(vs) })
}

/** 元素的**有效位置**（顶点=自身；边=中点；面=顶点质心）。锚点与枢轴用。 */
export function elementPosition(el: ResolvedElement): Vec3 {
  if (el.kind === 'vertex') return el.vertex.position
  if (el.kind === 'edge') {
    return Object.freeze({
      x: (el.a.position.x + el.b.position.x) / 2,
      y: (el.a.position.y + el.b.position.y) / 2,
      z: (el.a.position.z + el.b.position.z) / 2,
    })
  }
  let x = 0
  let y = 0
  let z = 0
  for (const v of el.vertices) {
    x += v.position.x
    y += v.position.y
    z += v.position.z
  }
  const n = el.vertices.length
  return Object.freeze({ x: x / n, y: y / n, z: z / n })
}

// ─────────────────────────────────────────────────────────────────────────────
// 固定拓扑编辑（**只**改位置；结构变更必须经 bumpTopology）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 写入单个顶点位置。
 *
 * **不推进** `topologyVersion` —— 固定拓扑编辑的定义就是"结构不变"。
 * 返回新的 `MeshData`，输入一字不改（A02「不改输入」）。
 * 顶点不存在 → `MissingTarget`（不是"用默认值当成功"，契约 §3.1）。
 */
export function withVertexPosition(mesh: MeshData, ref: ElementRef, position: Vec3): Result<MeshData> {
  const r = resolveVertex(mesh.topology, ref)
  if (!r.ok) return r
  if (!isFiniteVec3(position)) return err(invalidValue({ reason: 'nonFiniteVertexPosition', elementId: ref.elementId }))
  const vertices = mesh.topology.vertices.map((v) => (v.id === ref.elementId ? Object.freeze({ id: v.id, position: Object.freeze({ ...position }) }) : v))
  const topology = Object.freeze({ ...mesh.topology, vertices: Object.freeze(vertices) })
  // 拓扑版本**不变**（固定拓扑编辑），但内容变了 —— 内容身份重算
  return ok(meshData(mesh.id, topology, mesh.deformation))
}

/** 逐顶点的有效位置表（只读快照；供批量查询，不逐点往返）。 */
export function vertexPositions(mesh: MeshData): Readonly<Record<VertexId, Vec3>> {
  const out: Record<VertexId, Vec3> = {}
  for (const v of mesh.topology.vertices) out[v.id] = v.position
  return Object.freeze(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// 轴对齐包围盒（多选枢轴的输入；**不是**对象枢轴）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 轴对齐包围盒。
 *
 * 用途限定：多选枢轴的"选择包围盒中心"策略（#249 §19.2）与呈现剔除。
 * **它绝不是对象原点/枢轴** —— 后者是持久创作事实（`Transform.pivot`）。
 * 类型分开是为了让"用包围盒中心冒充持久枢轴"（A26 负对照）需要一次
 * **显式**的类型转换才能写出，而不是一个字段随手取错。
 */
export interface Aabb {
  readonly min: Vec3
  readonly max: Vec3
}

/** 位置集合 → AABB；空集返回 `null`（不返回退化的零点盒，那会静默冒充"有几何"）。 */
export function boundsOfPositions(positions: readonly Vec3[]): Aabb | null {
  if (positions.length === 0) return null
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const p of positions) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.z < minZ) minZ = p.z
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
    if (p.z > maxZ) maxZ = p.z
  }
  return Object.freeze({
    min: Object.freeze({ x: minX, y: minY, z: minZ }),
    max: Object.freeze({ x: maxX, y: maxY, z: maxZ }),
  })
}

/** 网格的局部 AABB（由顶点位置求得；无顶点即 `null`）。 */
export function meshBounds(mesh: MeshData): Aabb | null {
  return boundsOfPositions(mesh.topology.vertices.map((v) => v.position))
}

/** AABB 中心。**仅**用于多选枢轴与呈现；调用方不得把它写进 `Transform.pivot`。 */
export function boundsCenter(b: Aabb): Vec3 {
  return Object.freeze({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 })
}

// ─────────────────────────────────────────────────────────────────────────────
// 形变（固定拓扑形变：形变数据 + 权重求值）
// ─────────────────────────────────────────────────────────────────────────────

/** 形变目标：某顶点的**位移**（相对基础位置的偏移，不是绝对位置）。 */
export interface DeformationTarget {
  readonly vertex: VertexId
  readonly offset: Vec3
}

/**
 * 形变通道。
 *
 * 通道是**权重源**（例如骨骼/部件通道），权重由调用方经显式输入给出
 * （动画采样在 P4，#255；本模块只做"权重 → 有效位置"的纯求值）。
 */
export interface DeformationChannel {
  readonly id: string
  readonly targets: readonly DeformationTarget[]
}

/**
 * 形变数据。
 *
 * `topologyVersion` 把它**钉在**一张具体的拓扑上：拓扑一变，形变即失效
 * （{@link evaluateDeformation} 显式拒绝）。这与 `ElementRef` 是同一政策 ——
 * "结构变了就别猜"，而不是"尽量对上"。
 */
export interface Deformation {
  readonly id: string
  readonly topologyVersion: number
  readonly channels: readonly DeformationChannel[]
}

export function deformation(id: string, topologyVersion: number, channels: readonly DeformationChannel[]): Deformation {
  return Object.freeze({ id, topologyVersion, channels: Object.freeze([...channels]) })
}

/** 权重表：通道 id → 权重（缺失即 0；**不是** `undefined` 兼表，故用完整 Record）。 */
export type DeformationWeights = Readonly<Record<string, number>>

/**
 * 求值固定拓扑形变：`vertexId → 有效位置`。
 *
 * 输出是**新的只读值**；基础网格 `mesh.topology.vertices[*].position` 不被触碰。
 * 这是「不能在每帧改写基础网格」（#249 §3.2）的结构性保证：函数签名里
 * 根本没有"写回基础网格"的出口。
 *
 * 拒绝条件（全部显式）：
 *  - 网格无 `deformation` ⇒ `UnsupportedOperation`（不返回"看起来像恒等"的假结果）；
 *  - `deformation.topologyVersion` 与网格不符 ⇒ `StaleReference`；
 *  - 权重非有限数 ⇒ `InvalidValue`（不夹取）。
 */
export function evaluateDeformation(mesh: MeshData, weights: DeformationWeights): Result<Readonly<Record<VertexId, Vec3>>> {
  const def = mesh.deformation
  if (!def) {
    return err(invalidValue({ reason: 'noDeformation', meshId: mesh.id }))
  }
  if (def.topologyVersion !== mesh.topology.version) {
    return err(
      staleReference({
        reason: 'deformationTopologyMismatch',
        deformationId: def.id,
        expected: def.topologyVersion,
        actual: mesh.topology.version,
      }),
    )
  }
  const out: Record<VertexId, Vec3> = {}
  for (const v of mesh.topology.vertices) out[v.id] = v.position

  for (const ch of def.channels) {
    const raw = Object.prototype.hasOwnProperty.call(weights, ch.id) ? weights[ch.id] : 0
    if (!Number.isFinite(raw)) return err(invalidValue({ reason: 'nonFiniteWeight', channel: ch.id, value: String(raw) }))
    if (raw === 0) continue
    for (const t of ch.targets) {
      const cur = out[t.vertex]
      if (!cur) return err(missingTarget({ reason: 'deformationTargetMissing', vertex: t.vertex, channel: ch.id }))
      out[t.vertex] = Object.freeze({
        x: cur.x + t.offset.x * raw,
        y: cur.y + t.offset.y * raw,
        z: cur.z + t.offset.z * raw,
      })
    }
  }
  return ok(Object.freeze(out))
}

// ─────────────────────────────────────────────────────────────────────────────
// 来源映射（退役 #9 的**语义替代**：身份必须经来源映射，批次序号只是局部序号）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 渲染侧**局部序号**。
 *
 * 它可以存在（批次划分是呈现的内部事实），但**不是身份**：
 * `resolveByOrdinal` 必须回表到 {@link GeometrySourceMap} 才能得到对象/元素身份。
 * `batchIdx` 作为身份之所以必须退役，正是因为"重新分批后同一个序号指向另一个对象"
 * （A18 负控制：「把 batch index 当对象 ID」）。
 */
export interface LocalOrdinal {
  readonly batch: number
  readonly slot: number
}

/** 一个对象在来源映射里的条目。 */
export interface GeometrySourceEntry {
  readonly objectId: string
  readonly dataId: string
  /** 该对象数据的拓扑版本（元素引用据此判过期）。 */
  readonly topologyVersion: number
  /** 该数据的元素身份清单（顶点；无网格载荷时为空）。 */
  readonly elementIds: readonly VertexId[]
  /**
   * 渲染侧局部序号（**非身份**）。
   *
   * 由 `buildGeometrySourceMap` 按 `Scene.order` 的稳定枚举顺序生成 ——
   * 注意它只有一个来源（`order`），而不是由渲染引擎分批结果倒推。
   */
  readonly ordinal: LocalOrdinal
}

/**
 * 几何来源映射：**对象身份 → 数据身份 → 元素身份 → 局部序号**。
 *
 * 为什么这是退役 #9 的正确替代（而不是又一层编号）：
 *  - 正向（`byObject`）以**稳定 ID** 为键，移动对象、重新分批都不改变键；
 *  - 反向（`ordinalIndex`）把局部序号映射回**稳定 ID**，于是"序号漂移"最多
 *    让一次索引失效，而**不会**让身份漂移；
 *  - 共享几何（两个对象引用同一 `dataId`）在 `byData` 里显式可见，
 *    这正是 A07 需要的事实。
 */
export interface GeometrySourceMap {
  readonly byObject: Readonly<Record<string, GeometrySourceEntry>>
  /** `dataId` → 引用它的对象 id 列表（共享几何的消费者）。 */
  readonly byData: Readonly<Record<string, readonly string[]>>
  /** 局部序号（`batch:slot`）→ 对象 id。**仅供呈现反查，不构成身份。** */
  readonly ordinalIndex: Readonly<Record<string, string>>
}

export function ordinalKey(o: LocalOrdinal): string {
  return `${o.batch}:${o.slot}`
}

/**
 * 由场景构造来源映射（纯函数）。
 *
 * 关键：对象/元素身份**只**来自 `Scene` 的稳定 ID 与网格拓扑；
 * 局部序号是**派生**的，且反向必须回表。测试
 * `geometryOwnership.test.ts > batchIdx 不能充当对象身份` 用"重新分批"证明这一点。
 */
export function buildGeometrySourceMap(scene: Scene): GeometrySourceMap {
  const byObject: Record<string, GeometrySourceEntry> = {}
  const byData: Record<string, string[]> = {}
  const ordinalIndex: Record<string, string> = {}
  scene.order.forEach((objectId, slot) => {
    const obj = scene.objects[objectId]
    if (!obj) return
    const data = Object.prototype.hasOwnProperty.call(scene.data, obj.dataId) ? scene.data[obj.dataId] : undefined
    if (!data) return
    const elementIds = meshElementIds(data.payload)
    const ordinal: LocalOrdinal = Object.freeze({ batch: 0, slot })
    byObject[objectId] = Object.freeze({
      objectId,
      dataId: data.id,
      topologyVersion: data.topologyVersion,
      elementIds,
      ordinal,
    })
    if (!Object.prototype.hasOwnProperty.call(byData, data.id)) byData[data.id] = []
    byData[data.id].push(objectId)
    ordinalIndex[ordinalKey(ordinal)] = objectId
  })
  const frozenByData: Record<string, readonly string[]> = {}
  for (const k of Object.keys(byData)) frozenByData[k] = Object.freeze([...byData[k]])
  return Object.freeze({
    byObject: Object.freeze(byObject),
    byData: Object.freeze(frozenByData),
    ordinalIndex: Object.freeze(ordinalIndex),
  })
}

/** 由局部序号反查对象身份 —— **必须**经来源映射（不是"序号即身份"）。 */
export function resolveByOrdinal(map: GeometrySourceMap, ordinal: LocalOrdinal): GeometrySourceEntry | undefined {
  const objectId = map.ordinalIndex[ordinalKey(ordinal)]
  if (objectId === undefined) return undefined
  return map.byObject[objectId]
}

/** 引用同一份数据的对象（共享几何的消费者；A07 的事实来源）。 */
export function consumersOfData(map: GeometrySourceMap, dataId: string): readonly string[] {
  return map.byData[dataId] ?? Object.freeze([])
}

/** 载荷是否为网格，且取出其元素身份清单。 */
function meshElementIds(payload: { readonly kind: string; readonly mesh?: MeshData }): readonly VertexId[] {
  if (payload.kind !== 'mesh' || !payload.mesh) return Object.freeze([])
  return Object.freeze(payload.mesh.topology.vertices.map((v) => v.id))
}

/** 取载荷的网格（非网格返回 `undefined`，不抛、不猜）。 */
export function meshFromPayload(payload: { readonly kind: string; readonly mesh?: MeshData }): MeshData | undefined {
  return payload.kind === 'mesh' ? payload.mesh : undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// 具名领域数据（#249 §3.1：MC 身份 / 部件信息 / 原始资源来源）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 方块的 Minecraft 身份。
 *
 * #249 §3.1：「方块的 Minecraft 身份…属于**具名**的领域数据；不能用当前空间坐标
 * 替代对象身份」。`registryId` 是注册表身份（`namespace:path` 或注册键），
 * `blockStateId` 是状态变体身份 —— 两者都不含坐标。
 */
export interface BlockMinecraftIdentity {
  readonly registryId: string
  readonly blockStateId: string
}

/** 部件信息（非满方块）。命名空间隔离见 `docs/contracts/format-parts-contract.md` §4。 */
export interface PartInformation {
  readonly localId: string
  readonly family: string
}

/** 原始资源来源（纹理/模型来自哪里）。 */
export interface ResourceProvenance {
  readonly locator: string
  readonly origin: 'embedded' | 'external' | 'generated'
}

/** 单格的具名领域数据。 */
export interface BlockCellDomainData {
  readonly identity: BlockMinecraftIdentity
  readonly part: PartInformation | null
  readonly provenance: ResourceProvenance | null
}

/**
 * 具名领域数据 → **稳定键**。
 *
 * 只由 MC 身份构成：移动对象、重新分批、换帧序都不改变它。
 * 这就是"不用空间坐标兼任身份"的可执行形式 ——
 * 负对照见 `geometryIdentity.test.ts > 坐标派生键在移动后改变（负对照）`。
 */
export function blockCellIdentityKey(data: BlockCellDomainData): string {
  return `${data.identity.registryId}\u0000${data.identity.blockStateId}`
}

// ─────────────────────────────────────────────────────────────────────────────
// 旧 MC 导出的诊断挂点（#249 §3.1 末句；导出侧实现归 #260）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 诊断码（**稳定**，不受语言影响 —— #249 §19.7）。
 *
 * 旧 Minecraft 结构格式只能表达整数格上的整格方块：非恒等变换、显式枢轴、
 * 固定拓扑形变都**不能**忠实写出。本模块只给**挂点**（导出实现在 #260）：
 * 与其静默降采样，不如让导出侧拿到结构化原因并可诊断。
 */
export type LegacyExportDiagnosticCode =
  | 'LegacyExportUnsupportedTransform'
  | 'LegacyExportUnsupportedPivot'
  | 'LegacyExportUnsupportedDeformation'

export interface LegacyExportDiagnostic {
  readonly code: LegacyExportDiagnosticCode
  readonly objectId: string
  readonly dataId: string
  readonly detail: Readonly<Record<string, string | number>>
}

/**
 * 列出会阻碍旧格式忠实导出的对象级事实。
 *
 * 判据是**语义**的，不是"字段存在与否"：位置落在整数格且旋转/缩放/枢轴为恒等
 * 才算可表达；`-0` 与 `0` 视为相同（浮点相等性，不四舍五入到整数 —— 见 E3）。
 */
export function legacyExportDiagnostics(scene: Scene): readonly LegacyExportDiagnostic[] {
  const out: LegacyExportDiagnostic[] = []
  for (const objectId of scene.order) {
    const obj = scene.objects[objectId]
    if (!obj) continue
    const t = obj.transform
    if (!isIntegerGridTranslation(t.position)) {
      out.push(
        Object.freeze({
          code: 'LegacyExportUnsupportedTransform' as const,
          objectId,
          dataId: obj.dataId,
          detail: Object.freeze({ x: t.position.x, y: t.position.y, z: t.position.z }),
        }),
      )
    }
    if (!isNonRotatedNonScaled(t)) {
      out.push(
        Object.freeze({
          code: 'LegacyExportUnsupportedTransform' as const,
          objectId,
          dataId: obj.dataId,
          detail: Object.freeze({ reason: 'nonIdentityRotationOrScale' }),
        }),
      )
    }
    if (t.pivot.x !== 0 || t.pivot.y !== 0 || t.pivot.z !== 0) {
      out.push(
        Object.freeze({
          code: 'LegacyExportUnsupportedPivot' as const,
          objectId,
          dataId: obj.dataId,
          detail: Object.freeze({ x: t.pivot.x, y: t.pivot.y, z: t.pivot.z }),
        }),
      )
    }
    const data = Object.prototype.hasOwnProperty.call(scene.data, obj.dataId) ? scene.data[obj.dataId] : undefined
    const mesh = data ? meshFromPayload(data.payload) : undefined
    if (mesh?.deformation) {
      out.push(
        Object.freeze({
          code: 'LegacyExportUnsupportedDeformation' as const,
          objectId,
          dataId: obj.dataId,
          detail: Object.freeze({ deformationId: mesh.deformation.id }),
        }),
      )
    }
  }
  return Object.freeze(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部
// ─────────────────────────────────────────────────────────────────────────────

function isFiniteVec3(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
}

function isIntegerGridTranslation(p: Vec3): boolean {
  return Number.isInteger(p.x) && Number.isInteger(p.y) && Number.isInteger(p.z)
}

function isNonRotatedNonScaled(t: { rotation: { x: number; y: number; z: number; w: number }; scale: Vec3 }): boolean {
  return t.rotation.x === 0 && t.rotation.y === 0 && t.rotation.z === 0 && t.rotation.w === 1 && t.scale.x === 1 && t.scale.y === 1 && t.scale.z === 1
}
