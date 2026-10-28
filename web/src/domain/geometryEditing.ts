/**
 * `domain/geometryEditing` —— **共享几何的按对象独立编辑**。
 *
 * ## 冻结语义
 *
 * 「**共享几何默认按对象独立编辑**：事务暂存中分离，**取消不得遗留新几何**；
 * 提交、撤销、重做**保持对象与数据引用一致**。**不能每次鼠标移动重复复制整份文档**」。
 *
 * ## 为什么单列一个模块（而不是塞进 `domain/geometry` 或 `domain/scene`）
 *
 * 共享分离要**同时**用到两侧：`domain/scene` 的场景/数据/对象结构，与
 * `domain/geometry` 的网格拓扑/顶点写。放进任一侧都会制造一个新的依赖边
 * （`geometry` → `scene` 的值级 import，或 `scene` → `geometry` 的实现 import）。
 * 单列之后依赖形状是**无环且单向**：
 *
 * ```
 * scene.ts ──import value──> geometry.ts     （拓扑版本导出）
 * geometryEditing.ts ──> scene.ts + geometry.ts   （本模块，谁也不依赖它）
 * ```
 *
 * ## 四条判据在本模块的落点
 *
 * | 判据要求 | 落点 |
 * |---|---|
 * | 「仅编辑 A 顶点 ⇒ **B 不变**」 | {@link writeVertexOnObject} 的分离语义：分离后 A 拿到**新数据**，B 仍指向原数据 |
 * | 「A 数据**按需分离**」 | 只在**确实被多个对象共享**时才分离（独占时零开销，见返回的 `detached`） |
 * | 「取消/撤销恢复正确引用且**无孤儿**」 | {@link beginGeometryEdit} / {@link commitGeometryEdit} / {@link cancelGeometryEdit} |
 * | 「**原地改共享数据**必须判红」 | 分离的**唯一**入口是显式函数；{@link writeVertexOnObject} 对共享数据**拒绝**写入而不是就地改 |
 *
 * ## 「取消不得遗留新几何」怎么做到
 *
 * 关键设计：**分离在提交时才发生**，不在 begin 时。
 *
 *  - `begin` 只记录「哪些对象要用新数据 id」与原始 `Scene` 引用（**零复制**）；
 *  - `update` 只累积**自起点的顶点位移**，写到暂存的 `MeshData` 上（不动文档）；
 *  - `commit` 才把分离后的数据写进场景（此时 `withScene` 判内容身份、`pushHistory` 记账）；
 *  - `cancel` 直接丢弃暂存 —— 因为**从未**往文档里放过新数据，所以"遗留新几何"
 *    在结构上不可能，无需清理代码（清理代码才是孤儿数据的来源）。
 *
 * 于是「取消无孤儿」不是靠"记得删掉"，而是靠"压根没建过"。
 *
 * ## 「不能每次鼠标移动重复复制整份文档」
 *
 * `update` 的输入是**自起点的总位移**（与 `domain/editing#updateInteraction` 同口径），
 * 每次从 `startPositions` 重算 ⇒ 幂等、无漂移。暂存里只放**被改动的顶点**，
 * 且只重建**受影响的** `MeshData`，不触碰场景里其它对象/数据。
 * {@link geometryStagingFootprint} 如实报告开销，使这条成为**可测量**的事实。
 */

import { findObject, findObjectData, objectsSharingData, type Scene, type Vec3 } from './scene'
import {
  evaluateDeformation,
  meshContentVersion,
  meshData,
  meshFromPayload,
  resolveVertex,
  withVertexPosition,
  type DeformationWeights,
  type MeshData,
  type VertexId,
} from './geometry'
import { elementRef, type ElementRef } from './identity'
import { err, invalidValue, missingTarget, ok, staleReference, type Result } from './errors'

// ─────────────────────────────────────────────────────────────────────────────
// 顶点位移与有效位置
// ─────────────────────────────────────────────────────────────────────────────

/** 单顶点的位移（自起点）。 */
export interface VertexDisplacement {
  readonly vertex: VertexId
  readonly delta: Vec3
}

/**
 * 某对象当前的**顶点基础位置**（不含形变）。
 *
 * 这是"编辑的起点锚"：形变是**派生**的（{@link effectiveVertexPositions}），
 * 编辑只改基础位置。这条区分很重要 —— 若编辑直接写入形变后的位置，那么
 * 一旦形变权重改变，用户"改过的位置"就会再次被形变叠加，产生无法解释的漂移。
 */
export function stagedStartPositions(mesh: MeshData): Result<Readonly<Record<VertexId, Vec3>>> {
  const out: Record<VertexId, Vec3> = {}
  for (const v of mesh.topology.vertices) out[v.id] = v.position
  return ok(Object.freeze(out))
}

/**
 * 有效顶点位置 = 基础位置 经形变求值（「形变数据与权重求值」）。
 *
 * 无形变时**显式**返回基础位置副本（不是"空表当成功"）：
 * `mesh.deformation === undefined` 与"形变权重全 0"在语义上不同，
 * 但两者对**位置**的影响相同，故此处合并；调用方若需区分应直接读 `mesh.deformation`。
 */
export function effectiveVertexPositions(mesh: MeshData, weights: DeformationWeights = {}): Result<Readonly<Record<VertexId, Vec3>>> {
  if (mesh.deformation === undefined) return stagedStartPositions(mesh)
  return evaluateDeformation(mesh, weights)
}

/**
 * 把"自起点的总位移"应用到基础网格上，返回**新的** `MeshData`。
 *
 * 纯函数：输入 `mesh` 的顶点位置一字不改。多个位移作用于同一顶点时**累加**
 * （保持 `update` 的"从起点重算"语义 —— 起点位置来自 `startPositions`，
 * 位移按顶点聚合后一次应用）。
 */
export function applyVertexDisplacements(mesh: MeshData, displacements: readonly VertexDisplacement[]): Result<MeshData> {
  let current = mesh
  const byVertex = new Map<VertexId, Vec3>()
  for (const d of displacements) {
    if (!Number.isFinite(d.delta.x) || !Number.isFinite(d.delta.y) || !Number.isFinite(d.delta.z)) {
      return err(invalidValue({ reason: 'nonFiniteDisplacement', vertex: d.vertex }))
    }
    const prev = byVertex.get(d.vertex)
    byVertex.set(d.vertex, Object.freeze({ x: (prev?.x ?? 0) + d.delta.x, y: (prev?.y ?? 0) + d.delta.y, z: (prev?.z ?? 0) + d.delta.z }))
  }
  for (const [vertex, delta] of byVertex) {
    // 顶点不存在 ⇒ MissingTarget（`resolveVertex` 保证；**不**静默跳过）
    const r = resolveVertex(current.topology, elementRef(vertex, current.topology.version))
    if (!r.ok) return r
    // 拓扑版本在固定拓扑编辑中不变，故这里用**当前**版本构造引用
    const w = withVertexPosition(current, elementRef(vertex, current.topology.version), Object.freeze({
      x: r.value.position.x + delta.x,
      y: r.value.position.y + delta.y,
      z: r.value.position.z + delta.z,
    }))
    if (!w.ok) return w
    current = w.value
  }
  return ok(current)
}

// ─────────────────────────────────────────────────────────────────────────────
// 按对象独立编辑（核心）
// ─────────────────────────────────────────────────────────────────────────────

/** 编辑前的每对象快照（**零复制**：只记引用与起点位置）。 */
export interface GeometryEditTarget {
  readonly objectId: string
  readonly dataId: string
  readonly topologyVersion: number
  /** 该对象编辑开始时的**基础**顶点位置。 */
  readonly startPositions: Readonly<Record<VertexId, Vec3>>
}

/**
 * 编辑前的准备结果。
 *
 * `detachNeeded` 列出**需要分离**的对象（其数据被多个对象共享）。
 * 它是**计划**，不是已经发生的分离 —— 分离在提交时执行（见文件头的"取消不留孤儿"）。
 */
export interface GeometryEditPlan {
  readonly targets: readonly GeometryEditTarget[]
  /** 需要分离的对象 id（数据当前被 >1 个对象引用）。 */
  readonly detachNeeded: readonly string[]
  /** 无需分离的对象 id（已独占数据）。 */
  readonly alreadyExclusive: readonly string[]
  /** 起点场景引用（提交时校验起点版本用；**不**是深拷贝）。 */
  readonly baseScene: Scene
}

/**
 * 为一批对象准备几何编辑。
 *
 * 拒绝条件（全部显式）：
 *  - 目标不存在 ⇒ `MissingTarget`；
 *  - 载荷不是网格 ⇒ `UnsupportedOperation`（不把"没有几何"当作"零顶点网格"）；
 *  - 承载只读内容（`source === 'content'`）⇒ `ReadOnly`（按**拥有者**判定）。
 */
export function beginGeometryEdit(scene: Scene, objectIds: readonly string[]): Result<GeometryEditPlan> {
  if (objectIds.length === 0) return err(invalidValue({ reason: 'noTargets' }))
  const targets: GeometryEditTarget[] = []
  const detachNeeded: string[] = []
  const alreadyExclusive: string[] = []
  for (const objectId of objectIds) {
    const obj = findObject(scene, objectId)
    if (!obj) return err(missingTarget({ objectId }))
    const data = findObjectData(scene, obj.dataId)
    if (!data) return err(missingTarget({ dataId: obj.dataId, objectId }))
    if (data.source === 'content') return err({ code: 'ReadOnly', params: Object.freeze({ owner: data.source, objectId }) })
    const mesh = meshFromPayload(data.payload)
    if (!mesh) return err(invalidValue({ reason: 'notAMesh', objectId, dataId: data.id }))
    const start = stagedStartPositions(mesh)
    if (!start.ok) return start
    targets.push(
      Object.freeze({
        objectId,
        dataId: data.id,
        topologyVersion: mesh.topology.version,
        startPositions: start.value,
      }),
    )
    if (objectsSharingData(scene, data.id).length > 1) detachNeeded.push(objectId)
    else alreadyExclusive.push(objectId)
  }
  return ok(
    Object.freeze({
      targets: Object.freeze(targets),
      detachNeeded: Object.freeze(detachNeeded),
      alreadyExclusive: Object.freeze(alreadyExclusive),
      baseScene: scene,
    }),
  )
}

/** 分离谓词：数据是否被多个对象引用（**共享**的定义）。 */
export function isShared(scene: Scene, dataId: string): boolean {
  return objectsSharingData(scene, dataId).length > 1
}

/**
 * 为一个对象选一个**空闲的**分离数据 id。
 *
 * 为什么确定性推导而不是消费身份分配状态：分离数据是**该对象的私有副本**，
 * 其身份由"属于谁"完全决定，不需要全局唯一序号 —— 这也是"不把批次序号当身份"
 * 的同一思路（身份应由语义决定，而不是由分配顺序决定）。
 * 若首选 id 已被占用（历史遗留），追加数字后缀直到空闲。
 */
export function detachedDataIdFor(scene: Scene, objectId: string): string {
  const base = `${objectId}::geo`
  if (!Object.prototype.hasOwnProperty.call(scene.data, base)) return base
  let n = 2
  for (;;) {
    const candidate = `${base}${n}`
    if (!Object.prototype.hasOwnProperty.call(scene.data, candidate)) return candidate
    n++
  }
}

/**
 * 在**指定对象**上写一个顶点的位置（自起点的总位移）。
 *
 * 这是「仅编辑 A 顶点 ⇒ B 不变」的直接实现，也是"原地改共享数据必须判红"的
 * 结构保证：
 *
 *  - 若 A 的数据**被共享** ⇒ 本函数产出**新数据 id**（`newDataId` 由调用方按
 *    `allocateId` 给出，保持身份分配"作为输入传入"的纪律），
 *    于是 A 指向新数据、B 仍指向原数据 ⇒ **B 不变**；
 *  - 若 A **已独占** ⇒ 就地更新 A 自己的数据（无谓的分离是浪费，且会破坏
 *    "编辑两次同一对象得到同一身份"）。
 *
 * 返回 `null` 的语义是"**净零**"（位移为零 ⇒ 内容不变），**不是**失败。
 * 调用方据此不记账、不推进版本（与 `commitInteraction` 同口径）。
 */
export function writeVertexOnObject(
  scene: Scene,
  input: {
    readonly objectId: string
    readonly vertex: VertexId
    /** 自起点的**总位移**（不是增量）。 */
    readonly delta: Vec3
    /** 若需分离，用这个数据 id（由身份分配状态给出）。 */
    readonly detachedDataId: string
  },
): Result<{ readonly scene: Scene; readonly dataId: string; readonly detached: boolean; readonly netZero: boolean }> {
  const obj = findObject(scene, input.objectId)
  if (!obj) return err(missingTarget({ objectId: input.objectId }))
  const data = findObjectData(scene, obj.dataId)
  if (!data) return err(missingTarget({ dataId: obj.dataId, objectId: input.objectId }))
  if (data.source === 'content') {
    return err({ code: 'ReadOnly', params: Object.freeze({ owner: data.source, objectId: input.objectId }) })
  }
  const mesh = meshFromPayload(data.payload)
  if (!mesh) return err(invalidValue({ reason: 'notAMesh', objectId: input.objectId, dataId: data.id }))

  const shared = isShared(scene, data.id)
  // 目标数据 id：共享则使用调用方给的分离 id；独占则沿用原 id
  const targetDataId = shared ? input.detachedDataId : data.id
  if (shared && (targetDataId === data.id || Object.prototype.hasOwnProperty.call(scene.data, targetDataId))) {
    return err(invalidValue({ reason: 'detachedDataIdConflict', dataId: targetDataId }))
  }

  const at0 = resolveVertex(mesh.topology, elementRef(input.vertex, mesh.topology.version))
  if (!at0.ok) return at0
  if (!Number.isFinite(input.delta.x) || !Number.isFinite(input.delta.y) || !Number.isFinite(input.delta.z)) {
    return err(invalidValue({ reason: 'nonFiniteDisplacement', vertex: input.vertex }))
  }
  // 净零：位移为零 ⇒ 内容不变（**不**建新数据、**不**记历史）—— 幽灵历史防线
  if (input.delta.x === 0 && input.delta.y === 0 && input.delta.z === 0) {
    return ok({ scene, dataId: data.id, detached: false, netZero: true })
  }

  const nextPos = Object.freeze({
    x: at0.value.position.x + input.delta.x,
    y: at0.value.position.y + input.delta.y,
    z: at0.value.position.z + input.delta.z,
  })
  const written = withVertexPosition(mesh, elementRef(input.vertex, mesh.topology.version), nextPos)
  if (!written.ok) return written

  // 分离时**保留形变**：形变钉在拓扑版本上，拓扑没变故它仍然有效。
  // 丢弃它会让"分离一下形体就没了"成为不可解释的静默失真。
  const newMesh = meshData(targetDataId, written.value.topology, written.value.deformation)
  const newData = Object.freeze({ ...data, id: targetDataId, payload: Object.freeze({ kind: 'mesh' as const, mesh: newMesh }), contentVersion: contentVersionOfMesh(newMesh) })

  const dataMap = Object.freeze({ ...scene.data, [targetDataId]: newData })
  const objects = shared ? Object.freeze({ ...scene.objects, [input.objectId]: Object.freeze({ ...obj, dataId: targetDataId }) }) : scene.objects
  return ok({
    scene: Object.freeze({ ...scene, objects, data: dataMap }),
    dataId: targetDataId,
    detached: shared,
    netZero: false,
  })
}

/**
 * 只读几何编辑的总位移形式（供 `update` 使用）。
 *
 * 与 {@link writeVertexOnObject} 的差别：本函数处理**多顶点、多对象**的一次
 * `update`，语义是"从起点重算"——故它**先**回到起点位置、**再**应用总位移。
 */
export function applyEditUpdate(
  scene: Scene,
  plan: GeometryEditPlan,
  displacements: readonly { readonly objectId: string; readonly vertex: VertexId; readonly delta: Vec3 }[],
  allocateDataId: (objectId: string, ordinal: number) => string,
): Result<{ readonly scene: Scene; readonly detachedDataIds: readonly string[] }> {
  let current = scene
  const detachedDataIds: string[] = []
  let ordinal = 0
  for (const d of displacements) {
    const target = plan.targets.find((t) => t.objectId === d.objectId)
    if (!target) return err(missingTarget({ objectId: d.objectId }))
    // 起点位置：位移是**自起点**的，故以计划里的快照为基准（不是当前值 —— 否则会漂移）
    const start = target.startPositions[d.vertex]
    if (!start) return err(missingTarget({ vertex: d.vertex, objectId: d.objectId }))
    const r = writeVertexOnObject(current, {
      objectId: d.objectId,
      vertex: d.vertex,
      delta: d.delta,
      detachedDataId: allocateDataId(d.objectId, ordinal++),
    })
    if (!r.ok) return r
    current = r.value.scene
    if (r.value.detached) detachedDataIds.push(r.value.dataId)
  }
  return ok({ scene: current, detachedDataIds: Object.freeze(detachedDataIds) })
}

/**
 * 提交一次几何编辑。
 *
 * 与 `update` 的区别：`commit` 的输出是"可以被 `withScene` 接受的候选场景"，
 * 决策（是否记账、是否推进版本）**不在本模块** —— 它由 `application` 层按
 * 与其它命令**同一条**路径判定（唯一提交协议）。
 * 本模块只保证"候选场景是正确的"。
 *
 * `netZero` 为 true 时返回的 `scene` 与输入**同一引用** ⇒ `withScene` 会判
 * `changed: false` ⇒ 不产生历史（幽灵历史防线的第二道）。
 */
export function commitGeometryEdit(
  scene: Scene,
  displacements: readonly { readonly objectId: string; readonly vertex: VertexId; readonly delta: Vec3 }[],
): Result<{ readonly scene: Scene; readonly changedVertices: readonly { readonly objectId: string; readonly vertex: VertexId; readonly element: ElementRef }[] }> {
  if (displacements.length === 0) return ok({ scene, changedVertices: Object.freeze([]) })
  let current = scene
  const changed: { objectId: string; vertex: VertexId; element: ElementRef }[] = []
  // 按对象分组，使同一对象在一次提交里只分离**一次**（多次分离会产生多余数据；
  // 那既是孤儿风险的来源，也让"分离"这件事变得不可预测）
  const byObject = new Map<string, { vertex: VertexId; delta: Vec3 }[]>()
  for (const d of displacements) {
    const arr = byObject.get(d.objectId) ?? []
    arr.push({ vertex: d.vertex, delta: d.delta })
    byObject.set(d.objectId, arr)
  }
  for (const [objectId, items] of byObject) {
    for (const item of items) {
      const obj = findObject(current, objectId)
      if (!obj) return err(missingTarget({ objectId }))
      const data = findObjectData(current, obj.dataId)
      if (!data) return err(missingTarget({ dataId: obj.dataId }))
      const mesh = meshFromPayload(data.payload)
      if (!mesh) return err(invalidValue({ reason: 'notAMesh', objectId }))
      // 分离 id 按"属于谁"确定性推导（见 `detachedDataIdFor`）。
      // 若该对象已独占数据，`writeVertexOnObject` **不会**分离，此 id 被忽略。
      const detachedDataId = detachedDataIdFor(current, objectId)
      const r = writeVertexOnObject(current, { objectId, vertex: item.vertex, delta: item.delta, detachedDataId })
      if (!r.ok) return r
      if (!r.value.netZero) {
        changed.push({ objectId, vertex: item.vertex, element: elementRef(item.vertex, mesh.topology.version) })
      }
      current = r.value.scene
    }
  }
  return ok({ scene: current, changedVertices: Object.freeze(changed) })
}

/**
 * 取消一次几何编辑。
 *
 * 实现是**恒等函数**（返回起点场景）—— 这不是偷懒，而是本设计的直接推论：
 * 编辑期间从未把候选场景放进文档（`begin`/`update` 只产出**新的**场景值，
 * 由调用方持有），故"取消"就是"不采用那个值"。
 *
 * 保留本函数是为了让调用点的意图**显式**，并让"取消后无孤儿"有一个可被
 * 审查的落点（测试直接断言"取消后场景里没有新数据 id"）。
 */
export function cancelGeometryEdit(plan: GeometryEditPlan): Scene {
  return plan.baseScene
}

/**
 * 暂存占用（**可测量**证据：`update` 不复制整份文档）。
 *
 * 与 `domain/editing#stagingFootprint` 同一目的：若暂存是"整文档复制"，
 * `stagedVertices` 会等于场景的顶点总数；本实现的暂存只含**被拖动的顶点**。
 */
export function geometryStagingFootprint(
  scene: Scene,
  displacements: readonly { readonly objectId: string; readonly vertex: VertexId }[],
): { readonly stagedVertices: number; readonly documentVertices: number; readonly stagedObjects: number; readonly documentObjects: number } {
  let documentVertices = 0
  for (const id of Object.keys(scene.data)) {
    const mesh = meshFromPayload(scene.data[id].payload)
    if (mesh) documentVertices += mesh.topology.vertices.length
  }
  const stagedObjects = new Set(displacements.map((d) => d.objectId)).size
  return {
    stagedVertices: displacements.length,
    documentVertices,
    stagedObjects,
    documentObjects: Object.keys(scene.objects).length,
  }
}

/**
 * 顶点引用的**过期判定**（「撤销恢复正确引用」的一条）。
 *
 * 与 `application/commands.ts#validatePropertyWrite` 中的同款判定**同源**：
 * 先比拓扑版本、再找元素。这里单列是为了让领域层也能在写之前自查，
 * 而不必依赖命令层（两条判定共用 {@link resolveVertex}，不会漂移）。
 */
export function checkVertexRef(scene: Scene, objectId: string, ref: ElementRef): Result<null> {
  const obj = findObject(scene, objectId)
  if (!obj) return err(missingTarget({ objectId }))
  const data = findObjectData(scene, obj.dataId)
  if (!data) return err(missingTarget({ dataId: obj.dataId, objectId }))
  const mesh = meshFromPayload(data.payload)
  if (!mesh) return err(invalidValue({ reason: 'notAMesh', objectId }))
  if (ref.topologyVersion !== mesh.topology.version) {
    return err(staleReference({ elementId: ref.elementId, expected: ref.topologyVersion, actual: mesh.topology.version }))
  }
  const r = resolveVertex(mesh.topology, ref)
  return r.ok ? ok(null) : r
}

/** 网格的内容身份（转发 `domain/geometry#meshContentVersion`，保持单一实现点）。 */
function contentVersionOfMesh(mesh: MeshData): number {
  return meshContentVersion(mesh)
}
