/**
 * `domain/scene` —— **对象、对象数据、集合、引用**（#249 §3.1 §3.2；契约 §1 §6.2）。
 *
 * ## 三条冻结语义在本模块的落点
 *
 * 1. **对象与对象数据分离**（#249 §1.1 方向 3、§3.1）：`SceneObject` 持有稳定 ID、类型、
 *    名称、变换、可见性；**内容**在同 ID 的 `ObjectData` 里，二者各有内容版本。
 *    多个对象可引用同一 `ObjectData`（共享几何）。
 * 2. **共享几何默认按对象独立编辑**（#249 §3.2）：本模块提供 `detachObjectData` ——
 *    显式的"为对象分离出独立数据"操作；**不**在每次属性写时隐式复制整份数据。
 *    修改共享源必须是显式操作（§1.1 方向 5）。
 * 3. **写权按拥有者/内容来源判断**（#249 §3.3、契约 §6.2）：`ObjectData.owner` 携带来源
 *    （`'document'` = 用户内容，可写；`'content'` = 只读参数化内容，如多方块生成物）。
 *    **不使用整份文档一个布尔值粗略代替** —— 这是契约 §3.2 的 ReadOnly 负对照。
 *
 * ## 本次交付的三类真实对象（#252 执行范围）
 *
 * `block`（方块/网格）、`annotation`（注解框）、`camera`（相机）。#249 §13 要求它们
 * "具有同等对象地位，具体属性与编辑能力不同" —— 本模块用**同一** `SceneObject` 承载三者，
 * 差异只落在 `data` 载荷与 `capabilities` 上，不为任一类型开旁路。
 *
 * 类型扩展机制由 #253/#257 收口；本模块只保证"新增一类不需要改对象/集合/引用代码"
 * 这一骨架前提：`ObjectDataPayload` 是开放映射，`SceneObject.type` 是 `string`。
 * 但 §13 同时要求"扩展验证通过现有贡献接口新增类型，而非改核心 switch" ——
 * 故本模块**没有任何** `switch (type)`：所有类型特定行为都在 `objectTypeRegistry` 里注册，
 * 核心只做结构操作。见 `domain/scene.ts#capabilitiesOf`。
 *
 * ## 与旧模型的区别（不得复用旧通路）
 *
 * 旧 `RuntimeDocument` 用 `frame.grid` 的**空间坐标**兼任对象身份、用 `record` 承载
 * 无界字段袋（#249 §15 第 2/9 条）。本模块的对象身份是**分配出来的稳定 ID**，
 * 变换可以离开整数网格；坐标约束由显式纯策略处理，不由身份系统承担。
 */

import { contentDigest, type EntityRef, type Version } from './identity'

// ─────────────────────────────────────────────────────────────────────────────
// 数学值（#249 §19.2：右手、Y-up；保留仿射表达能力）
// ─────────────────────────────────────────────────────────────────────────────

export type Vec3 = Readonly<{ x: number; y: number; z: number }>
export type Quat = Readonly<{ x: number; y: number; z: number; w: number }>

/** 对象局部变换。§19.2：枢轴显式，不由包围盒自动推导。 */
export interface Transform {
  readonly position: Vec3
  readonly rotation: Quat
  readonly scale: Vec3
  /** 显式原点/枢轴（对象空间）。 */
  readonly pivot: Vec3
}

export const IDENTITY_QUAT: Quat = Object.freeze({ x: 0, y: 0, z: 0, w: 1 })
export const ZERO_VEC3: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 })
export const ONE_VEC3: Vec3 = Object.freeze({ x: 1, y: 1, z: 1 })

export function vec3(x: number, y: number, z: number): Vec3 {
  return Object.freeze({ x, y, z })
}

export const IDENTITY_TRANSFORM: Transform = Object.freeze({
  position: ZERO_VEC3,
  rotation: IDENTITY_QUAT,
  scale: ONE_VEC3,
  pivot: ZERO_VEC3,
})

export function transform(partial: Partial<Transform>): Transform {
  return Object.freeze({
    position: partial.position ?? ZERO_VEC3,
    rotation: partial.rotation ?? IDENTITY_QUAT,
    scale: partial.scale ?? ONE_VEC3,
    pivot: partial.pivot ?? ZERO_VEC3,
  })
}

export function sameVec3(a: Vec3, b: Vec3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z
}

export function sameQuat(a: Quat, b: Quat): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w
}

export function sameTransform(a: Transform, b: Transform): boolean {
  return sameVec3(a.position, b.position) && sameQuat(a.rotation, b.rotation) && sameVec3(a.scale, b.scale) && sameVec3(a.pivot, b.pivot)
}

// ─────────────────────────────────────────────────────────────────────────────
// 对象数据
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 数据来源拥有者。
 *
 * - `'document'`：用户内容，可写。
 * - `'content'`：参数化只读内容（多方块生成物），可查询/拾取但**不可编辑**（#249 §3.3）。
 */
export type DataSource = 'document' | 'content'

export type ObjectDataPayload =
  | { readonly kind: 'blockGrid'; readonly cells: Readonly<Record<string, string>> }
  | { readonly kind: 'annotation'; readonly shape: 'box' | 'point' | 'line' | 'text' | 'face'; readonly text?: string }
  | { readonly kind: 'camera'; readonly projection: 'perspective' | 'orthographic'; readonly fov: number; readonly clipStart: number; readonly clipEnd: number }

/** 对象数据的载荷种类（供能力/呈现查询，不参与身份）。 */
export type ObjectDataKind = ObjectDataPayload['kind']

/**
 * 对象数据：与对象分离的**内容**单元（#249 §3.1「对象数据可共享，具有独立 ID 和内容版本」）。
 */
export interface ObjectData {
  readonly id: string
  /** 来源拥有者：写权按此判定（§3.3），不使用文档级布尔。 */
  readonly source: DataSource
  readonly payload: ObjectDataPayload
  /** 内容版本：内容改变时推进；供 `StaleReference` 与求值键使用。 */
  readonly contentVersion: number
  /** 拓扑版本：结构与子元素寻址相关；`ElementRef` 据此判过期（#249 §3.2）。 */
  readonly topologyVersion: number
}

export function objectData(id: string, payload: ObjectDataPayload, source: DataSource = 'document'): ObjectData {
  return Object.freeze({ id, source, payload, contentVersion: contentDigest(JSON.stringify(payload)), topologyVersion: 0 })
}

// ─────────────────────────────────────────────────────────────────────────────
// 对象
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 对象类型标识。
 *
 * 本次三类：`block` / `annotation` / `camera`。它是 `string` 而非封闭联合 ——
 * 目的是让"新增一类不需要改核心"（#249 §13 A21）。类型特定行为一律经
 * `ObjectTypeDescriptor` 贡献注册，核心代码里**没有** `switch (object.type)`。
 */
export type ObjectTypeId = string

/** 对象：稳定 ID、类型、名称、变换、可见性、数据引用（#249 §3.1）。 */
export interface SceneObject {
  readonly id: string
  readonly type: ObjectTypeId
  readonly name: string
  readonly transform: Transform
  readonly visible: boolean
  /** 引用的对象数据 ID。同一 ID 可被多个对象引用（共享几何）。 */
  readonly dataId: string
  /**
   * 显式父对象 ID（变换父子链）。§19.2：**集合成员不隐式成为变换父子**；
   * 父链无环由 `sceneParentChain` 判定并显式拒绝。
   */
  readonly parentId?: string
}

export function sceneObject(init: {
  id: string
  type: ObjectTypeId
  name?: string
  transform?: Transform
  visible?: boolean
  dataId: string
  parentId?: string
}): SceneObject {
  const out: {
    id: string
    type: ObjectTypeId
    name: string
    transform: Transform
    visible: boolean
    dataId: string
    parentId?: string
  } = {
    id: init.id,
    type: init.type,
    name: init.name ?? init.id,
    transform: init.transform ?? IDENTITY_TRANSFORM,
    visible: init.visible ?? true,
    dataId: init.dataId,
  }
  if (init.parentId !== undefined) out.parentId = init.parentId
  return Object.freeze(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// 集合（组织与可见性，**不是**变换父子）
// ─────────────────────────────────────────────────────────────────────────────

export interface ObjectCollection {
  readonly id: string
  readonly name: string
  /** 显式成员列表；集合是组织手段，不形成变换父子（#249 §19.2）。 */
  readonly members: readonly string[]
  readonly visible: boolean
}

export function objectCollection(id: string, name: string, members: readonly string[] = [], visible = true): ObjectCollection {
  return Object.freeze({ id, name, members: Object.freeze([...members]), visible })
}

// ─────────────────────────────────────────────────────────────────────────────
// 场景
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 场景：对象 + 数据 + 集合 + 组织关系。
 *
 * 全部字段只读；所有变更返回**新场景**并**结构共享**未变更部分
 * （契约 §3.1「保持未改分支的身份属于实现契约」）。
 */
export interface Scene {
  readonly id: string
  /** 对象按 ID 索引。 */
  readonly objects: Readonly<Record<string, SceneObject>>
  /** 数据按 ID 索引（可被多个对象共享）。 */
  readonly data: Readonly<Record<string, ObjectData>>
  readonly collections: Readonly<Record<string, ObjectCollection>>
  /** 稳定绘制/枚举顺序（不是身份）。 */
  readonly order: readonly string[]
}

export function emptyScene(id: string): Scene {
  return Object.freeze({ id, objects: Object.freeze({}), data: Object.freeze({}), collections: Object.freeze({}), order: Object.freeze([]) })
}

// ─────────────────────────────────────────────────────────────────────────────
// 类型能力（贡献式，无核心 switch）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 对象类型的能力描述。由类型贡献方注册，核心只查表。
 *
 * ## 本批（#250 GF-5 收敛）删除了 `animatableProperties` 白名单
 *
 * 该字段原本是一份"哪些属性可动画"的字符串清单，作为写面的**内联白名单**被
 * `application/commands.ts` 的 `validatePropertyWrite` 消费。收敛后属性语义的
 * 唯一权威是 RNA 注册表（`application/properties.ts` 的 `PropertyDescriptor.animatable`），
 * 该函数连同白名单一起删除，于是这个字段**零生产消费者**。
 *
 * 为什么是删除而不是"改成查 RNA 注册表"：`domain/` **不得** import `application/`
 * （依赖方向单向向下，见 `tests/architecture/kernel-legacy-isolation.test.ts` 的
 * 「内核不得依赖旧层」与分层公共出口约束）。`domain` 这里能做的只有"声明资格"，
 * 而"资格"本身已经由 RNA 描述承载得更完整（含单位、值域、采样钩子）——
 * 留一份查不到的清单只会成为第二个漂移源。
 */
export interface ObjectTypeDescriptor {
  readonly type: ObjectTypeId
  /** 该类型数据载荷种类。 */
  readonly dataKind: ObjectDataKind
  /** 该类型是否参与"内容编辑"（相机参数属于文档，但观察视角不属于 —— §3.1）。 */
  readonly editable: boolean
}

/**
 * 内核三类对象的能力表。
 *
 * `editable` 只表达"该类型的载荷是否属内容编辑面"这一**类型级**事实；
 * **逐属性的**可写性由 RNA 的 `evaluateEditability` 按当前状态求值
 * （契约 §5.1：动态可编辑性，不是静态 readonly 开关）。
 */
const DEFAULT_TYPES: readonly ObjectTypeDescriptor[] = Object.freeze([
  Object.freeze({ type: 'block', dataKind: 'blockGrid', editable: true }),
  Object.freeze({ type: 'annotation', dataKind: 'annotation', editable: true }),
  Object.freeze({ type: 'camera', dataKind: 'camera', editable: true }),
])

export type ObjectTypeRegistry = Readonly<Record<ObjectTypeId, ObjectTypeDescriptor>>

export function defaultObjectTypes(): ObjectTypeRegistry {
  const out: Record<string, ObjectTypeDescriptor> = {}
  for (const d of DEFAULT_TYPES) out[d.type] = d
  return Object.freeze(out)
}

/**
 * 查类型描述。
 *
 * 返回 `undefined` 而不是抛 —— 由调用方（纯命令）决定这算 `UnsupportedOperation`
 * 还是 `MissingTarget`，**政策不在本函数**。
 */
export function typeDescriptor(registry: ObjectTypeRegistry, type: ObjectTypeId): ObjectTypeDescriptor | undefined {
  return Object.prototype.hasOwnProperty.call(registry, type) ? registry[type] : undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// 查询（纯读；供 application/queries 与 domain 自身复用）
// ─────────────────────────────────────────────────────────────────────────────

export function findObject(scene: Scene, id: string): SceneObject | undefined {
  return Object.prototype.hasOwnProperty.call(scene.objects, id) ? scene.objects[id] : undefined
}

export function findObjectData(scene: Scene, id: string): ObjectData | undefined {
  return Object.prototype.hasOwnProperty.call(scene.data, id) ? scene.data[id] : undefined
}

export function objectsInOrder(scene: Scene): readonly SceneObject[] {
  const out: SceneObject[] = []
  for (const id of scene.order) {
    const o = findObject(scene, id)
    if (o) out.push(o)
  }
  return out
}

/** 引用同一份数据的对象（共享几何的消费者）。 */
export function objectsSharingData(scene: Scene, dataId: string): readonly SceneObject[] {
  return objectsInOrder(scene).filter((o) => o.dataId === dataId)
}

/** 数据是否被多个对象共享。 */
export function isDataShared(scene: Scene, dataId: string): boolean {
  return objectsSharingData(scene, dataId).length > 1
}

/** 对象的有效写权（§3.3：按**数据来源拥有者**判定）。 */
export function writeAuthority(scene: Scene, objectId: string): 'writable' | 'readOnly' | 'missing' {
  const obj = findObject(scene, objectId)
  if (!obj) return 'missing'
  const data = findObjectData(scene, obj.dataId)
  if (!data) return 'missing'
  return data.source === 'content' ? 'readOnly' : 'writable'
}

/**
 * 父链（含自身）—— 用于环路判定与父子求值顺序。
 * 返回 `null` 表示存在环（§19.2：「父链必须无环」）。
 */
export function sceneParentChain(scene: Scene, objectId: string): readonly string[] | null {
  const chain: string[] = []
  const seen = new Set<string>()
  let cur: string | undefined = objectId
  while (cur !== undefined) {
    if (seen.has(cur)) return null
    seen.add(cur)
    chain.push(cur)
    cur = findObject(scene, cur)?.parentId
  }
  return chain
}

// ─────────────────────────────────────────────────────────────────────────────
// 结构变更（全部返回新场景；未变更的子树按引用共享）
// ─────────────────────────────────────────────────────────────────────────────

/** 插入对象 + 其数据。已存在同 ID 时返回 `null`（政策由调用方定，不静默覆盖）。 */
export function withObject(scene: Scene, obj: SceneObject, data: ObjectData): Scene | null {
  if (findObject(scene, obj.id) || findObjectData(scene, data.id)) return null
  return Object.freeze({
    ...scene,
    objects: Object.freeze({ ...scene.objects, [obj.id]: obj }),
    data: Object.freeze({ ...scene.data, [data.id]: data }),
    order: Object.freeze([...scene.order, obj.id]),
  })
}

/** 替换对象（保持 order 与未变部分身份）。 */
export function withUpdatedObject(scene: Scene, obj: SceneObject): Scene {
  return Object.freeze({ ...scene, objects: Object.freeze({ ...scene.objects, [obj.id]: obj }) })
}

/** 替换数据。 */
export function withUpdatedData(scene: Scene, data: ObjectData): Scene {
  return Object.freeze({ ...scene, data: Object.freeze({ ...scene.data, [data.id]: data }) })
}

/** 删除对象；**不**级联删除其数据（数据可能仍被别的对象共享）。 */
export function withoutObject(scene: Scene, objectId: string): Scene {
  if (!findObject(scene, objectId)) return scene
  const objects = { ...scene.objects }
  delete objects[objectId]
  return Object.freeze({
    ...scene,
    objects: Object.freeze(objects),
    order: Object.freeze(scene.order.filter((id) => id !== objectId)),
  })
}

/** 删除数据；仍被引用时返回 `null`（不产生悬挂引用，§19.2）。 */
export function withoutData(scene: Scene, dataId: string): Scene | null {
  if (objectsSharingData(scene, dataId).length > 0) return null
  if (!findObjectData(scene, dataId)) return scene
  const data = { ...scene.data }
  delete data[dataId]
  return Object.freeze({ ...scene, data: Object.freeze(data) })
}

/** 插入集合。 */
export function withCollection(scene: Scene, collection: ObjectCollection): Scene | null {
  if (Object.prototype.hasOwnProperty.call(scene.collections, collection.id)) return null
  return Object.freeze({ ...scene, collections: Object.freeze({ ...scene.collections, [collection.id]: collection }) })
}

// ─────────────────────────────────────────────────────────────────────────────
// 数据分离（#249 §3.2 / §1.1 方向 5）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 为对象**显式**分离出独立数据副本。
 *
 * `#249` §1.1 方向 5：「共享几何的普通编辑默认仅影响目标对象；需要时在事务内产生独立数据。
 * **修改共享源必须为显式操作**」。
 *
 * 本函数是那条"显式操作"的纯实现；它**只**做分离，不做任何属性写。
 * 调用方（命令）决定何时调用它。返回 `null` 表示该对象已独占数据（无需分离）——
 * 这同样是一个**显式**结果，不是静默 no-op。
 */
export function detachObjectData(
  scene: Scene,
  objectId: string,
  newDataId: string,
): { scene: Scene; object: SceneObject; data: ObjectData } | null {
  const obj = findObject(scene, objectId)
  if (!obj) return null
  const src = findObjectData(scene, obj.dataId)
  if (!src) return null
  if (objectsSharingData(scene, src.id).length <= 1) return null
  const copy: ObjectData = Object.freeze({ ...src, id: newDataId, contentVersion: src.contentVersion })
  const nextObj: SceneObject = Object.freeze({ ...obj, dataId: newDataId })
  const next: Scene = Object.freeze({
    ...scene,
    objects: Object.freeze({ ...scene.objects, [obj.id]: nextObj }),
    data: Object.freeze({ ...scene.data, [newDataId]: copy }),
  })
  return { scene: next, object: nextObj, data: copy }
}

/** 场景的 `EntityRef`（供 `PropertyRef` 的 owner 使用）。 */
export function sceneRef(scene: Scene, contentVersion?: number): EntityRef {
  return contentVersion === undefined ? Object.freeze({ kind: 'scene', id: scene.id }) : Object.freeze({ kind: 'scene', id: scene.id, contentVersion })
}

/** 场景的 `Version`（`documentVersion` 由**文档**拥有，不由场景自造）。 */
export function sceneEntityRefFor(scene: Scene, docVersion: Version): EntityRef {
  return Object.freeze({ kind: 'scene', id: scene.id, contentVersion: docVersion.contentVersion })
}
