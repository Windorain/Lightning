/**
 * `application/kernel-properties` —— **内核文档模型**（`domain/scene` 的 `Scene`）的 RNA 声明与写入端口。
 *
 * ## 为什么需要这个文件（它解决的是 #250 GF-5 的核心验收项）
 *
 * #250 裁决：「P1 的 `reduceCommand` 是**唯一**更新入口；属性语义由 **P2 的 RNA 注册表**承载」。
 * 但在本批之前，P1 的属性语义藏在 `application/commands.ts` 的**内联白名单**里
 * （`applyPropertyValue` 的 `switch (ref.property)` + `isStructuralProperty` +
 * `doc.types[obj.type].animatableProperties`），P2 的 RNA 只描述**另一套**文档模型
 * （实时工作台的 `RuntimeDocument`）。两套模型不相交 ⇒ `reduceCommand` 不可能成为
 * 属性写的唯一入口。
 *
 * 本文件把**内核侧**（`Scene` 模型）的属性描述按 RNA 契约注册进注册表，于是：
 *
 *  - `reduceSetProperty` 不再有内联属性词汇：它向注册表解析描述、算可编辑性、
 *    调纯值 handler 与写 handler（见 `commands.ts`）；
 *  - 「新增一种内置属性类型」与「新增一个普通对象类型」走**同一条**公开注册路径
 *    （`registerValueType` / `registerObjectType`）—— 这就是 D4 的证明路径；
 *  - 属性 ID 是**限定式**（`<objectTypeId>.<localId>`，冻结 #1）：
 *    `block.transform.position`、`camera.projection.fov`。
 *
 * ## 双轨登记（旧轨的负责人与退出阶段）
 *
 * 实时工作台面板仍经 `editors/workbench-rna.ts` 的 `submitPropertyWrite` 写
 * **旧 `RuntimeDocument`**（经 `applySetProperty`）。那是**暂存双轨**，
 * 负责人 **P10（#261）**，退出于工作台迁移到本内核文档模型 ——
 * 见 `docs/contracts/web-kernel-contracts.md` §8 与 #250 的归属裁决。
 * 本文件**不**触碰面板旧轨（#253 退出边界明令）。
 *
 * ## 纯度
 *
 * 无 Vue / Three / DOM / IO；不读全局时钟。全部为纯函数与不可变数据结构
 * （#249 §2.1）。注册表是显式数据结构，不是可变全局单例 —— 见 `kernelPropertyRegistry`
 * 的惰性构造注释。
 */

import {
  createPropertyWritePorts,
  type PropertyWriteHandler,
  type PropertyWritePorts,
} from './property-commands'
import {
  CAP_PROPERTY_WRITE,
  createPropertyRegistry,
  type CapabilityId,
  type ObjectTypeDecl,
  type PropertyAccess,
  type PropertyDecl,
  type PropertyDescriptor,
  type PropertyRegistry,
  type PropertyValue,
  type TargetFacts,
} from './properties'
import { ok, domainError, err, type DomainError, type PropertyRef, type Result } from './contracts'
import { findObject, findObjectData } from '@/domain/scene'
import { withScene, type Document } from '@/domain/document'

// ─────────────────────────────────────────────────────────────────────────────
// 1. 内核对象类型（`Scene` 模型）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 对象类型 ID **就是** `domain/scene` 的 `ObjectTypeId`（`'block' | 'annotation' | 'camera'`）。
 *
 * 为什么不加 `lightning.` 前缀：限定式属性 ID 是 `<objectTypeId>.<localId>`（冻结 #1），
 * 内核的 `objectTypeId` 本身不含点，故 `block.transform.position` 已无歧义
 * （冻结 #1 的陷阱针对的是**自身含点**的 objectTypeId，如工作台的 `lightning.annotation.text`）。
 * 同时保留 `SceneObject.type` 的原始字面量，使注册表与文档模型逐字对齐 ——
 * 免去一层「注册表 ID ↔ 文档 type」的映射，而映射正是漂移的来源。
 */
export const KERNEL_BLOCK_TYPE = 'block' as const
export const KERNEL_ANNOTATION_TYPE = 'annotation' as const
export const KERNEL_CAMERA_TYPE = 'camera' as const

/** 内核对象类型全集（供 P3 的 `mesh` 预留扩展：新类型走 `registerObjectType`，不改核心）。 */
export const KERNEL_OBJECT_TYPE_IDS: readonly string[] = Object.freeze([
  KERNEL_BLOCK_TYPE,
  KERNEL_ANNOTATION_TYPE,
  KERNEL_CAMERA_TYPE,
])

/** 位置/缩放等长度量的单位；`m` 为场景默认长度单位（Blender 约定）。 */
const LENGTH_UNIT = Object.freeze({ kind: 'length' as const, symbolKey: 'unit.length.m', symbolFallback: 'm' })
const RATIO_UNIT = Object.freeze({ kind: 'ratio' as const, symbolKey: 'unit.ratio', symbolFallback: '×' })
const ANGLE_UNIT = Object.freeze({ kind: 'angle' as const, symbolKey: 'unit.angle.deg', symbolFallback: '°' })

/** 变换属性对三类对象**完全一致**（#249 §3.1：变换属对象自身，不属类型）。 */
function transformDecls(): readonly PropertyDecl[] {
  return [
    decl('transform.position', 'vec3', true, { labelKey: 'property.transform.position', fallback: 'Location' }, LENGTH_UNIT),
    decl('transform.rotation', 'quat', true, { labelKey: 'property.transform.rotation', fallback: 'Rotation' }),
    decl('transform.scale', 'vec3', true, { labelKey: 'property.transform.scale', fallback: 'Scale' }, RATIO_UNIT),
    decl('transform.pivot', 'vec3', true, { labelKey: 'property.transform.pivot', fallback: 'Pivot' }, LENGTH_UNIT),
  ]
}

/** 结构属性：由**对象本身**拥有（`SceneObject`），不由数据载荷决定。 */
function structuralDecls(): readonly PropertyDecl[] {
  return [
    decl('name', 'string', false, { labelKey: 'property.name', fallback: 'Name' }, undefined, { kind: 'text', multiline: false }),
    decl('visible', 'boolean', false, { labelKey: 'property.visible', fallback: 'Visible' }),
  ]
}

function decl(
  id: string,
  valueType: string,
  animatable: boolean,
  display: PropertyDecl['display'],
  unit?: PropertyDecl['unit'],
  domain?: PropertyDecl['domain'],
): PropertyDecl {
  return Object.freeze({
    id,
    valueType,
    animatable,
    display: Object.freeze(display),
    ...(unit ? { unit } : {}),
    ...(domain ? { domain } : {}),
  })
}

/**
 * 内核三类对象的 RNA 声明。
 *
 * `animatable` 与 `domain/scene` 的 `DEFAULT_TYPES[*].animatableProperties` **逐字对应** ——
 * 本批之后那份清单不再是第二个权威：`commands.ts` 只查注册表，
 * 而 `DEFAULT_TYPES` 保留 `dataKind`/`editable` 供能力与呈现查询使用。
 *
 * 相机投影域用**推荐域**（`hard: false`）：越界只是提示，不成为合法性判据 ——
 * 硬约束会改变既有写入的接受面，那属于语义变更而非本批收敛范围。
 */
export const KERNEL_OBJECT_TYPES: readonly ObjectTypeDecl[] = Object.freeze([
  Object.freeze({
    id: KERNEL_BLOCK_TYPE,
    ownerKind: 'object' as const,
    display: Object.freeze({ labelKey: 'objectType.block', fallback: '方块' }),
    properties: Object.freeze([...structuralDecls(), ...transformDecls()]),
  }),
  Object.freeze({
    id: KERNEL_ANNOTATION_TYPE,
    ownerKind: 'object' as const,
    display: Object.freeze({ labelKey: 'objectType.annotation', fallback: '注解' }),
    properties: Object.freeze([
      ...structuralDecls(),
      ...transformDecls(),
      // 注解文本属**对象数据**载荷（`ObjectDataPayload.annotation.text`）。
      // 局部 ID 用 `text`（不是 `annotation.text`）—— 否则限定式 ID 会变成
      // `annotation.annotation.text`，把 objectTypeId 重复两遍。
      decl('text', 'string', false, { labelKey: 'annotation.text', fallback: '内容' }, undefined, {
        kind: 'text',
        multiline: true,
      }),
    ]),
  }),
  Object.freeze({
    id: KERNEL_CAMERA_TYPE,
    ownerKind: 'object' as const,
    display: Object.freeze({ labelKey: 'objectType.camera', fallback: '相机' }),
    properties: Object.freeze([
      ...structuralDecls(),
      ...transformDecls(),
      decl('projection.fov', 'number', true, { labelKey: 'property.projection.fov', fallback: '视野' }, ANGLE_UNIT, {
        kind: 'number',
        min: 1,
        max: 179,
        hard: false,
      }),
      decl('projection.clipStart', 'number', true, { labelKey: 'property.projection.clipStart', fallback: '近裁剪' }, LENGTH_UNIT, {
        kind: 'number',
        min: 0,
        hard: false,
      }),
      decl('projection.clipEnd', 'number', true, { labelKey: 'property.projection.clipEnd', fallback: '远裁剪' }, LENGTH_UNIT, {
        kind: 'number',
        min: 0,
        hard: false,
      }),
    ]),
  }),
])

// ─────────────────────────────────────────────────────────────────────────────
// 2. 注册表构造（惰性、只读消费）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 造一个**独立**的内核注册表（每个调用方拿到自己的实例 —— 便于测试注入与避免共享可变状态）。
 *
 * 生产路径用 `kernelPropertyRegistry()`（惰性缓存）。这里导出工厂是为了
 * 「注册表不是全局可变单例」这一条在测试里可证：两个实例互不影响。
 */
export function createKernelPropertyRegistry(): { registry: PropertyRegistry; errors: readonly DomainError[] } {
  const registry = createPropertyRegistry()
  const errors: DomainError[] = []
  for (const decl of KERNEL_OBJECT_TYPES) {
    const r = registry.registerObjectType(decl)
    if (!r.ok) errors.push(r.error)
  }
  return { registry, errors: Object.freeze(errors) }
}

let cachedRegistry: { registry: PropertyRegistry; errors: readonly DomainError[] } | null = null

/**
 * 内核注册表（惰性单例）。
 *
 * ## 为什么这里可以有单例，而 RNA 文档又说"不是全局可变单例"
 *
 * `createPropertyRegistry` 的注释反对的是**可变的全局权威**（谁都能往里注册，
 * 于是"当前有哪些属性"取决于导入顺序）。本函数返回的实例在本文件之外**只被读**
 * （`descriptor` / `objectType` / `valueTypeHandler`），内核的注册发生在构造期一次性完成。
 * 它不进 `ApplicationState`、不进 `reduceCommand` 的输入，故不破坏 A02 纯性。
 */
export function kernelPropertyRegistry(): { registry: PropertyRegistry; errors: readonly DomainError[] } {
  if (cachedRegistry === null) cachedRegistry = createKernelPropertyRegistry()
  return cachedRegistry
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 读面：从 `Document`/`Scene` 取原始值（不校验）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `<objectTypeId>.<localId>` → 局部 ID。
 *
 * 与 `contracts.ts` 的 `localPropertyOf` 同口径（用**已知的 objectTypeId** 剥离前缀，
 * 不按"第一个点"或"最后一个点"切）—— 内核的 objectTypeId 不含点，故局部 ID 就是
 * 第一个点之后的部分；但**仍然显式接收** objectTypeId 以避免"以后某类对象 ID 含点"时
 * 静默出错（冻结 #1 的陷阱）。
 */
function localOf(ref: PropertyRef): { objectTypeId: string; localId: string } {
  const dot = ref.property.indexOf('.')
  if (dot === -1) return { objectTypeId: '', localId: ref.property }
  return { objectTypeId: ref.property.slice(0, dot), localId: ref.property.slice(dot + 1) }
}

/**
 * 读一个内核属性的**原始**值（`unknown`，未校验）。
 *
 * 校验责任在纯值 handler（见 `properties.ts` 的 `readProperty`）：
 * 读面不替写面做决定，写面也不信任读面 —— 同一条校验路径。
 */
export function readRawKernelValue(doc: Document, ref: PropertyRef): Result<unknown> {
  if (ref.owner.kind !== 'object') {
    return err(domainError('MissingTarget', { reason: 'not-an-object-property', ownerKind: ref.owner.kind }))
  }
  const obj = findObject(doc.scene, ref.owner.id)
  if (!obj) return err(domainError('MissingTarget', { objectId: ref.owner.id, property: ref.property }))
  const { localId } = localOf(ref)

  if (localId === 'name') return ok(obj.name)
  if (localId === 'visible') return ok(obj.visible)
  if (localId.startsWith('transform.')) {
    const field = localId.slice('transform.'.length) as 'position' | 'rotation' | 'scale' | 'pivot'
    return ok(obj.transform[field])
  }
  if (localId === 'text' || localId.startsWith('projection.')) {
    const data = findObjectData(doc.scene, obj.dataId)
    if (!data) return err(domainError('MissingTarget', { dataId: obj.dataId, property: ref.property }))
    if (localId === 'text') {
      if (data.payload.kind !== 'annotation') {
        return err(domainError('MissingTarget', { reason: 'payload-kind-mismatch', expected: 'annotation', actual: data.payload.kind }))
      }
      return ok(data.payload.text)
    }
    if (data.payload.kind !== 'camera') {
      return err(domainError('MissingTarget', { reason: 'payload-kind-mismatch', expected: 'camera', actual: data.payload.kind }))
    }
    const field = localId.slice('projection.'.length) as 'fov' | 'clipStart' | 'clipEnd'
    return ok(data.payload[field])
  }
  return err(domainError('MissingTarget', { reason: 'property-not-registered', property: ref.property }))
}

/**
 * 目标事实 —— 动态可编辑性的**状态输入**（契约 §2.2「`editability` 返回结构化原因」）。
 *
 * 逐条对应 `TargetFacts`：
 *  - `exists`：对象在场景里；
 *  - `generated`：对象数据来源为 `'content'`（多方块生成物 ⇒ 只读，#249 §3.3）——
 *    **按拥有者判定**，不是文档级布尔；
 *  - `drivenByTrack`：该属性落在已启用的动画轨道上（#249 §7：普通基础值写入默认显式拒绝）；
 *  - `locked`：本批恒 `false`（锁定语义由后续批次贡献，届时经同一事实入口进入）；
 *  - `holdsLease`：本上下文持有该文档的修改租约（契约 §6.1）。
 */
export function kernelFactsOf(doc: Document, ref: PropertyRef, holdsLease: boolean): TargetFacts {
  const obj = ref.owner.kind === 'object' ? findObject(doc.scene, ref.owner.id) : undefined
  if (!obj) {
    return { exists: false, generated: false, drivenByTrack: false, locked: false, holdsLease }
  }
  const data = findObjectData(doc.scene, obj.dataId)
  return {
    exists: true,
    generated: data?.source === 'content',
    drivenByTrack: kernelDrivenProperties(doc).has(`${ref.owner.id}\u0000${ref.property}`),
    locked: false,
    holdsLease,
    ...(data ? { contentVersion: data.contentVersion, topologyVersion: data.topologyVersion } : {}),
  }
}

/**
 * 已启用轨道驱动的属性集合（键 = `ownerId\0property`）。
 *
 * P1 只提供**判定入口**；轨道数据由 P4（#255）填充到 `Document`。
 * 对空轨道返回空集，故"未实现"不会伪装成"该拒绝"。
 *
 * 键里的 `property` 是**限定式** ID —— 与 `PropertyRef.property` 同一口径，
 * 避免"轨道记 `transform.position`、引用用 `block.transform.position`"这类静默不匹配。
 */
export function kernelDrivenProperties(doc: Document): ReadonlySet<string> {
  const tracks = (doc as unknown as { tracks?: readonly { ownerId: string; property: string }[] }).tracks
  const out = new Set<string>()
  if (!tracks) return out
  for (const t of tracks) out.add(`${t.ownerId}\u0000${t.property}`)
  return out
}

/**
 * 构造一次内核属性访问的**全部**显式环境。
 *
 * 能力映射：`content.edit` ⇒ `properties.write`。保留两层名字是刻意的 ——
 * 前者是**命令级**能力（P1 `ExecutionInputs`），后者是**属性写**能力（RNA），
 * 由这一处映射衔接，而不是把两个字符串混用成同一个概念。
 */
export function kernelAccessOf(
  doc: Document,
  contextId: string,
  capabilities: readonly string[],
  holdsLease: boolean,
): PropertyAccess {
  const caps = new Set<CapabilityId>()
  if (capabilities.includes('content.edit')) caps.add(CAP_PROPERTY_WRITE)
  return {
    version: doc.version,
    readRaw: (ref) => readRawKernelValue(doc, ref),
    facts: (ref) => kernelFactsOf(doc, ref, holdsLease || contextId === ''),
    capabilities: caps,
    language: 'zh',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 写端口：把校验过的值写进 `Document`（纯）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 应用一个内核属性值 —— 返回**新文档**或结构化错误。
 *
 * 这是「唯一写路由」的**落点**：`reduceSetProperty` 只路由，具体写由本函数按
 * `ref.property` 的限定式形态分派。D4 的形态在这里也成立：新增**对象类型**只需
 * 注册声明与端口，本函数的属性词汇来自注册表（`valueType` 已由 `applySetProperty`
 * 校验过，故此处只做结构写入，不再重复判类型）。
 */
export function applyKernelPropertyValue(doc: Document, ref: PropertyRef, value: PropertyValue): Result<Document> {
  if (ref.owner.kind !== 'object') {
    return err(domainError('UnsupportedOperation', { reason: 'not-an-object-property', ownerKind: ref.owner.kind }))
  }
  const obj = findObject(doc.scene, ref.owner.id)
  if (!obj) return err(domainError('MissingTarget', { objectId: ref.owner.id, property: ref.property }))
  const { localId } = localOf(ref)
  const scene = doc.scene

  if (localId === 'name') {
    if (typeof value !== 'string') return err(domainError('InvalidValue', { property: ref.property, expected: 'string' }))
    const next = Object.freeze({ ...scene.objects, [obj.id]: Object.freeze({ ...obj, name: value }) })
    return ok(withScene(doc, Object.freeze({ ...scene, objects: next })).doc)
  }
  if (localId === 'visible') {
    if (typeof value !== 'boolean') return err(domainError('InvalidValue', { property: ref.property, expected: 'boolean' }))
    const next = Object.freeze({ ...scene.objects, [obj.id]: Object.freeze({ ...obj, visible: value }) })
    return ok(withScene(doc, Object.freeze({ ...scene, objects: next })).doc)
  }
  if (localId.startsWith('transform.')) {
    const field = localId.slice('transform.'.length) as 'position' | 'rotation' | 'scale' | 'pivot'
    const nextTransform = Object.freeze({ ...obj.transform, [field]: value })
    const next = Object.freeze({ ...scene.objects, [obj.id]: Object.freeze({ ...obj, transform: nextTransform }) })
    return ok(withScene(doc, Object.freeze({ ...scene, objects: next })).doc)
  }

  const data = findObjectData(scene, obj.dataId)
  if (!data) return err(domainError('MissingTarget', { dataId: obj.dataId, property: ref.property }))
  let payload: typeof data.payload
  if (localId === 'text') {
    if (data.payload.kind !== 'annotation') {
      return err(domainError('MissingTarget', { reason: 'payload-kind-mismatch', expected: 'annotation', actual: data.payload.kind }))
    }
    if (typeof value !== 'string') return err(domainError('InvalidValue', { property: ref.property, expected: 'string' }))
    payload = Object.freeze({ ...data.payload, text: value })
  } else if (localId.startsWith('projection.')) {
    if (data.payload.kind !== 'camera') {
      return err(domainError('MissingTarget', { reason: 'payload-kind-mismatch', expected: 'camera', actual: data.payload.kind }))
    }
    if (typeof value !== 'number') return err(domainError('InvalidValue', { property: ref.property, expected: 'number' }))
    const field = localId.slice('projection.'.length) as 'fov' | 'clipStart' | 'clipEnd'
    payload = Object.freeze({ ...data.payload, [field]: value })
  } else {
    return err(domainError('UnsupportedOperation', { reason: 'property-not-registered', property: ref.property }))
  }
  // 内容版本按载荷摘要推进（与 `objectData` 的构造口径一致）。
  const nextData = Object.freeze({ ...data, payload })
  const scene2 = Object.freeze({ ...scene, data: Object.freeze({ ...scene.data, [data.id]: nextData }) })
  return ok(withScene(doc, scene2).doc)
}

/**
 * 内核写端口表（三类对象**共用同一个**写入函数）。
 *
 * 共享是刻意的：写入行为由属性 ID 决定（`name` 属对象、`projection.*` 属相机载荷），
 * 不是由对象类型决定。若按类型各写一份，"注解的 text"与"方块的 name"就会各有一套
 * 校验路径 —— 那正是内联白名单的老问题换了个位置。
 */
export function createKernelWritePorts(): PropertyWritePorts<Document> {
  const ports = createPropertyWritePorts<Document>()
  const handler: PropertyWriteHandler<Document> = (state, ref, value) => applyKernelPropertyValue(state, ref, value)
  for (const id of KERNEL_OBJECT_TYPE_IDS) ports.write(id, handler)
  return ports
}

let cachedPorts: PropertyWritePorts<Document> | null = null

/** 内核写端口表（惰性单例；内容构造后不变，与注册表同理）。 */
export function kernelWritePorts(): PropertyWritePorts<Document> {
  if (cachedPorts === null) cachedPorts = createKernelWritePorts()
  return cachedPorts
}

/** 某属性的描述（便捷出口；供 `queries.ts` 的读面复用同一注册表）。 */
export function kernelDescriptor(propertyId: string): PropertyDescriptor | undefined {
  return kernelPropertyRegistry().registry.descriptor(propertyId)
}
