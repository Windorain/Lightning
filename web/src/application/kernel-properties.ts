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
import { meshFromPayload } from '@/domain/geometry'
import { commitGeometryEdit } from '@/domain/geometryEditing'
import { withScene, type Document } from '@/domain/document'
import { animationDrivenKeys, propertyKey } from '@/domain/animation'

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
/**
 * 网格对象类型（#254 P3）。
 *
 * 用**同一条**公开注册路径加入（本文件的对象类型清单 + `registerObjectType`），
 * 不改核心分派 —— 这是 #249 §13「扩展验证要求通过现有贡献接口新增类型，
 * 而非改核心 switch」的证明路径：本类型是**第一个**走该路径新增的对象类型。
 */
export const KERNEL_MESH_TYPE = 'mesh' as const

/**
 * 内核对象类型全集。
 *
 * 新增类型只需在此登记 + 在 {@link KERNEL_OBJECT_TYPES} 给出声明
 * （`createKernelWritePorts` 按本清单为每个类型挂同一个写 handler），
 * 不需要改任何 `switch (object.type)`。
 */
export const KERNEL_OBJECT_TYPE_IDS: readonly string[] = Object.freeze([
  KERNEL_BLOCK_TYPE,
  KERNEL_ANNOTATION_TYPE,
  KERNEL_CAMERA_TYPE,
  KERNEL_MESH_TYPE,
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

/**
 * 对象**自身**属性的声明（结构 + 变换）—— 内核**全部**对象类型共用的一份。
 *
 * ## 为什么导出它（P11-F 段①）
 *
 * 贡献方新增一个对象类型时（`ModuleContributions.objectTypes[].rna`），它的
 * `name`/`visible`/`transform.*` 与内置类型**逐字相同** —— 它们不是"某类型的属性"，
 * 而是 `SceneObject` 的字段（核心词汇），写面也是同一个 handler。让每个贡献方各抄一份
 * 就是四份会各自漂移的清单（单位、`animatable`、值类型任何一处改动都要改四处）。
 *
 * ⇒ 贡献方**引用**本函数的产物（`composition/profiles.ts` 的 `objects.text` 即如此），
 * 而类型特有的载荷属性（如 `text`）仍由贡献方自己声明。
 */
export function kernelObjectSelfDecls(): readonly PropertyDecl[] {
  return [...structuralDecls(), ...transformDecls()]
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
  Object.freeze({
    id: KERNEL_MESH_TYPE,
    ownerKind: 'object' as const,
    display: Object.freeze({ labelKey: 'objectType.mesh', fallback: '网格' }),
    properties: Object.freeze([
      ...structuralDecls(),
      ...transformDecls(),
      /**
       * 顶点位置（#254 P3）。
       *
       * ## 子元素寻址
       *
       * 局部 ID 是 `vertexPosition`，故限定式 ID 为 `mesh.vertexPosition`
       * （`localOf` 在**第一个点**处切分 ⇒ objectTypeId=`mesh`、localId=`vertexPosition`）。
       * 具体是**哪个**顶点由 `PropertyRef.element`（`ElementRef{ elementId, topologyVersion }`）
       * 承载 —— 契约 §1.3 的设计意图正是"子元素寻址是既有寻址的一部分"，
       * 而不是为几何另开一条命令或旁路。
       *
       * ## 为什么 `animatable: false`（有意，不是遗漏）
       *
       * 基础网格顶点是**创作内容**。#249 §7 规定固定拓扑形变的动画路径是
       * 「通过通用动画采样驱动**形变权重/属性**」，而 §3.2 明令「**不能**在每帧
       * 改写基础网格」。若把本属性标为可动画，就等于给"每帧 setter 写基础值"
       * 留了一条合法通道 —— 那正是 A09 的负对照要判红的形态。
       *
       * 形变权重才是 P4 的轨道目标（其求值入口是 `domain/geometry#evaluateDeformation`）。
       *
       * ## `animatable` 不参与可写性判定
       *
       * 它只喂 `samplingStrategy`（`properties.ts`），故本属性**照常可写**
       * （可写性由 `probeWrite`/`evaluateEditability` 按目标事实求值，
       * 与动画资格是两个正交维度）。
       */
      decl('vertexPosition', 'vec3', false, { labelKey: 'property.mesh.vertexPosition', fallback: '顶点位置' }, LENGTH_UNIT),
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
 *
 * ## 参数 `contributed`（#262 P11-F 段①：A21 的属性写半边）
 *
 * 装配贡献的**新对象类型**声明（`ModuleContributions.objectTypes[].rna`）。
 * 缺省 = 只有内核内置类型 ⇒ 与 P11-F 之前的构造逐字相同（既有类型行为零改动）。
 *
 * 重复 id（贡献方声明了内核已有的类型）**不静默覆盖**：`registerObjectType` 返回
 * `InvalidValue: duplicate-object-type`，本函数把它收进 `errors` —— 调用方
 * （`reduceSetProperty`）见到非空 `errors` 即整批拒绝（装配缺陷必须显式暴露）。
 */
export function createKernelPropertyRegistry(
  contributed?: readonly ObjectTypeDecl[],
): { registry: PropertyRegistry; errors: readonly DomainError[] } {
  const registry = createPropertyRegistry()
  const errors: DomainError[] = []
  for (const decl of [...KERNEL_OBJECT_TYPES, ...(contributed ?? [])]) {
    const r = registry.registerObjectType(decl)
    if (!r.ok) errors.push(r.error)
  }
  return { registry, errors: Object.freeze(errors) }
}

let cachedRegistry: { registry: PropertyRegistry; errors: readonly DomainError[] } | null = null

/**
 * 按贡献声明缓存的注册表（键是**数组身份**）。
 *
 * ## 为什么键可以用身份而不是内容
 *
 * 贡献声明清单由**装配**一次性产出（`objectTypesOf` 返回冻结数组），
 * 同一次装配的每次命令都会拿到**同一个**数组引用。用 `WeakMap` 按身份缓存
 * 于是既避免每条命令重建注册表，又不会把"内容相同但来源不同"的清单混为一谈
 * —— 而后者正是"注册表内容取决于谁先来"的老毛病（可变全局权威）的另一种形态。
 */
const contributedRegistries = new WeakMap<readonly ObjectTypeDecl[], { registry: PropertyRegistry; errors: readonly DomainError[] }>()

/**
 * 内核注册表。
 *
 * ## 为什么这里可以有单例，而 RNA 文档又说"不是全局可变单例"
 *
 * `createPropertyRegistry` 的注释反对的是**可变的全局权威**（谁都能往里注册，
 * 于是"当前有哪些属性"取决于导入顺序）。本函数返回的实例**只被读**
 * （`descriptor` / `objectType` / `valueTypeHandler`），内核的注册发生在构造期一次性完成。
 * 它不进 `ApplicationState`、不是任何命令的副作用，故不破坏 A02 纯性。
 *
 * ## 贡献类型：**显式输入**，不是往单例里塞（P11-F 段① 的关键设计）
 *
 * `contributed` 非空时返回的是**按该清单构造的另一个实例**（按身份缓存），
 * 而不是"把贡献并进那个全局单例"。两条路都通，选后者的代价是：
 *
 *  1. `reduceCommand` 开始依赖一个**可变全局** —— 与 `ExecutionInputs` 的
 *     「这'什么都不给'本身是 A02 纯性的结构性保证：没有可读的全局来源」直接冲突；
 *  2. `freeze-convergence.test.ts` 的既有判据「注册表的 objectTypes() 必须等于
 *     `domain/scene` 的类型集」会在**任何**触发过装配注册的进程里判红
 *     （注册是全局的 ⇒ 判据的输入被别的测试改变）。
 *
 * 走显式输入则与 `ExecutionInputs.objectFactories`（A21 已批准的贡献落点）**同形**：
 * 装配层装配它、经输入传入、用完即弃。
 */
export function kernelPropertyRegistry(
  contributed?: readonly ObjectTypeDecl[],
): { registry: PropertyRegistry; errors: readonly DomainError[] } {
  if (contributed === undefined || contributed.length === 0) {
    if (cachedRegistry === null) cachedRegistry = createKernelPropertyRegistry()
    return cachedRegistry
  }
  const hit = contributedRegistries.get(contributed)
  if (hit !== undefined) return hit
  const built = createKernelPropertyRegistry(contributed)
  contributedRegistries.set(contributed, built)
  return built
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
  if (localId === 'text' || localId.startsWith('projection.') || localId === 'vertexPosition') {
    const data = findObjectData(doc.scene, obj.dataId)
    if (!data) return err(domainError('MissingTarget', { dataId: obj.dataId, property: ref.property }))
    if (localId === 'text') {
      if (data.payload.kind !== 'annotation') {
        return err(domainError('MissingTarget', { reason: 'payload-kind-mismatch', expected: 'annotation', actual: data.payload.kind }))
      }
      return ok(data.payload.text)
    }
    if (localId === 'vertexPosition') {
      // 网格顶点读面（#254 P3）。**必须有**：`applySetProperty` 的"无业务变化 ⇒ unchanged"
      // 判定依赖 `readRaw` 与前值比较（D5）。缺了它，写相同值会被误报 `applied`
      // —— 那正是 A06「新建相同内容容器即记账」的同族失真（幽灵历史）。
      //
      // 这也是 P2 反复强调的「读写共用同一份 `PropertyAccess`」：读面与写面必须覆盖
      // **同一组**属性 ID，否则"读到的东西"与"写入要过的判据"不同构。
      const mesh = meshFromPayload(data.payload)
      if (!mesh) {
        return err(domainError('MissingTarget', { reason: 'payload-kind-mismatch', expected: 'mesh', actual: data.payload.kind }))
      }
      if (!ref.element) {
        // 无元素身份 ⇒ 无法确定读哪个顶点（**不**"随便挑一个"）
        return err(domainError('InvalidValue', { reason: 'element-required', property: ref.property }))
      }
      const v = mesh.topology.vertices.find((x) => x.id === ref.element?.elementId)
      if (!v) return err(domainError('MissingTarget', { reason: 'no-such-vertex', elementId: ref.element.elementId }))
      return ok(v.position)
    }
    if (data.payload.kind !== 'camera') {
      return err(domainError('MissingTarget', { reason: 'payload-kind-mismatch', expected: 'camera', actual: data.payload.kind }))
    }
    const field = localId.slice('projection.'.length) as 'fov' | 'clipStart' | 'clipEnd'
    // GF-21 乙：字段**可选** ⇒ 无声明值时如实"缺"，**不**编一个常量冒充声明值
    // （那正是装配曾对 `meta.embed_initial_view` 做的事）。
    const v = data.payload[field]
    if (v === undefined) {
      return err(domainError('MissingTarget', { reason: 'projection-not-declared', property: ref.property }))
    }
    return ok(v)
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
    drivenByTrack: kernelDrivenProperties(doc).has(propertyKey(ref)),
    locked: false,
    holdsLease,
    ...(data ? { contentVersion: data.contentVersion, topologyVersion: data.topologyVersion } : {}),
  }
}

/**
 * 已启用轨道驱动的属性集合。
 *
 * ## P4（#255）落地：从 P1 占位换成真实数据模型
 *
 * P1 的实现是一个**类型断言占位**（读 `doc.tracks` —— 该字段从未存在，故恒返回空集）：
 *
 * ```ts
 * const tracks = (doc as unknown as { tracks?: readonly { ownerId, property }[] }).tracks
 * ```
 *
 * 它当时的理由是"P1 不含动画数据模型（#252：动画求值由 P4 收口）"，同时让 A10 的
 * 拒绝路径在 P1 就有落点而**不引入一条真实的旧实现**。P4 现在把轨道数据落到
 * `doc.animation`（`domain/animation`），故此处改为直接读取 —— 断言消失。
 *
 * ## 键算法必须与轨道侧**同一函数**（本文件与命令层的分工交接点）
 *
 * P1 占位用 `${ownerId}\0${property}`，而 `domain/animation` 的轨道键用
 * `propertyKey(ref)`（**含 `owner.kind`、分量与子元素**）。两者不是同一个字符串：
 * `owner.kind` 与分量的缺失会让"按分量驱动的轨道"与"整向量驱动的轨道"在判定上
 * 互相漏配（前者漏拒、后者误拒）—— 那正是 A10 负对照要抓的静默失效。
 *
 * ⇒ 两侧共用 `propertyKey`。**不要在任一侧另写一份拼接**：格式漂移不会报错，
 * 只会让"被动画驱动的属性"在某些目标上悄悄不再被拒绝。
 */
export function kernelDrivenProperties(doc: Document): ReadonlySet<string> {
  return animationDrivenKeys(doc.animation)
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
 * `vec3` 形状判定（**写入口的窄化辅助**，不是合法性政策）。
 *
 * 合法性（值域、单位、硬约束）由值 handler 在 `applySetProperty` 阶段判过；
 * 本函数只把 `PropertyValue` 联合窄化到 `Vec3`，使下面的结构写入有类型依据。
 * 判别式与 `isVec3`（P1 内联词汇的遗留，已在 GF-5 收敛中删除）一致，
 * 但**不含**任何属性语义 —— 故它不是"内联白名单"的回归。
 */
function asVec3(value: PropertyValue): Readonly<{ x: number; y: number; z: number }> | null {
  if (typeof value !== 'object' || value === null) return null
  if (!('x' in value) || !('y' in value) || !('z' in value)) return null
  if ('w' in value) return null
  const v = value as { x: unknown; y: unknown; z: unknown }
  if (typeof v.x !== 'number' || typeof v.y !== 'number' || typeof v.z !== 'number') return null
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return null
  return { x: v.x, y: v.y, z: v.z }
}

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

  if (localId === 'vertexPosition') {
    // ── 网格顶点写（#254 P3）──────────────────────────────────────────────
    //
    // 这里**不**做"载荷字段替换"（那会就地改共享数据，正是 A07 负对照要判红的形态），
    // 而是交给 `commitGeometryEdit` 完成「共享几何按对象独立编辑」：
    // 数据被多个对象共享受时为目标对象分离出新数据，B 逐位不变。
    //
    // 引用有效性（`ref.element.topologyVersion` 与 `ref.owner.contentVersion` 是否过期）
    // **不在这里判** —— 它已在 `probeWrite` → `staleReason`（`properties.ts`）阶段
    // 由 `facts.topologyVersion` / `facts.contentVersion` 判过并整批拒绝。
    // 保持"校验先于应用"这一不变量：本函数只在**已通过预检**的引用上执行写入。
    const mesh = meshFromPayload(data.payload)
    if (!mesh) {
      return err(domainError('MissingTarget', { reason: 'payload-kind-mismatch', expected: 'mesh', actual: data.payload.kind }))
    }
    if (!ref.element) {
      // 无元素身份的顶点写必须显式拒绝（**不**"随便挑一个顶点"）
      return err(domainError('InvalidValue', { reason: 'element-required', property: ref.property }))
    }
    const target = asVec3(value)
    if (target === null) return err(domainError('InvalidValue', { property: ref.property, expected: 'vec3' }))
    const current = mesh.topology.vertices.find((v) => v.id === ref.element?.elementId)
    if (!current) return err(domainError('MissingTarget', { reason: 'no-such-vertex', elementId: ref.element.elementId }))

    // 属性写的语义是**绝对值**，而几何编辑的输入是**自起点的位移** ⇒ 取差值。
    const committed = commitGeometryEdit(scene, [
      {
        objectId: obj.id,
        vertex: ref.element.elementId,
        delta: Object.freeze({
          x: target.x - current.position.x,
          y: target.y - current.position.y,
          z: target.z - current.position.z,
        }),
      },
    ])
    if (!committed.ok) return committed
    // 净零 ⇒ 场景同一引用 ⇒ `withScene` 判 `changed: false` ⇒ `unchanged`（幽灵历史防线）
    return ok(withScene(doc, committed.value.scene).doc)
  }

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
    // 显式三分支（不用计算键）：投影字段已可选（GF-21 乙），计算键会把可选字段
    // 摊成索引签名，掩盖"写的是哪一个字段"。
    const cur = data.payload
    payload = localId === 'projection.fov'
      ? Object.freeze({ ...cur, fov: value })
      : localId === 'projection.clipStart'
        ? Object.freeze({ ...cur, clipStart: value })
        : Object.freeze({ ...cur, clipEnd: value })
  } else {
    return err(domainError('UnsupportedOperation', { reason: 'property-not-registered', property: ref.property }))
  }
  // 内容版本按载荷摘要推进（与 `objectData` 的构造口径一致）。
  const nextData = Object.freeze({ ...data, payload })
  const scene2 = Object.freeze({ ...scene, data: Object.freeze({ ...scene.data, [data.id]: nextData }) })
  return ok(withScene(doc, scene2).doc)
}

/**
 * 内核写端口表（全部对象类型**共用同一个**写入函数）。
 *
 * 共享是刻意的：写入行为由属性 ID 决定（`name` 属对象、`projection.*` 属相机载荷），
 * 不是由对象类型决定。若按类型各写一份，"注解的 text"与"方块的 name"就会各有一套
 * 校验路径 —— 那正是内联白名单的老问题换了个位置。
 *
 * `contributed`（#262 P11-F 段①）：装配贡献的新类型 id —— 它们与内置类型**共用同一个**
 * handler。于是"贡献类型能写属性"不需要第二条写通路：写端口只是多了一条 id → 同一 handler
 * 的登记，语义仍由 `applyKernelPropertyValue` 的属性词汇（那些是**内核数据载荷**的词汇，
 * 属核心的封闭集合）唯一决定。
 */
export function createKernelWritePorts(contributed?: readonly ObjectTypeDecl[]): PropertyWritePorts<Document> {
  const ports = createPropertyWritePorts<Document>()
  const handler: PropertyWriteHandler<Document> = (state, ref, value) => applyKernelPropertyValue(state, ref, value)
  for (const id of KERNEL_OBJECT_TYPE_IDS) ports.write(id, handler)
  for (const decl of contributed ?? []) ports.write(decl.id, handler)
  return ports
}

let cachedPorts: PropertyWritePorts<Document> | null = null

/** 按贡献声明缓存的写端口表（与 `kernelPropertyRegistry` 同一键：数组身份；理由见该函数）。 */
const contributedPorts = new WeakMap<readonly ObjectTypeDecl[], PropertyWritePorts<Document>>()

/**
 * 内核写端口表（惰性缓存；内容构造后不变，与注册表同理）。
 *
 * `contributed` 的语义与缓存口径与 {@link kernelPropertyRegistry} **逐条一致**
 * （同一份清单 ⇒ 同一实例；缺省 ⇒ 那个内置单例）。两者必须同源：注册表说某类型的
 * 属性可描述、写端口却说没有 handler，会得到 `UnsupportedOperation: no-write-handler`
 * 这种"半通"状态 —— 而它是静默的（只在**第一次真写**时暴露）。
 */
export function kernelWritePorts(contributed?: readonly ObjectTypeDecl[]): PropertyWritePorts<Document> {
  if (contributed === undefined || contributed.length === 0) {
    if (cachedPorts === null) cachedPorts = createKernelWritePorts()
    return cachedPorts
  }
  const hit = contributedPorts.get(contributed)
  if (hit !== undefined) return hit
  const built = createKernelWritePorts(contributed)
  contributedPorts.set(contributed, built)
  return built
}

/** 某属性的描述（便捷出口；供 `queries.ts` 的读面复用同一注册表）。 */
export function kernelDescriptor(propertyId: string): PropertyDescriptor | undefined {
  return kernelPropertyRegistry().registry.descriptor(propertyId)
}
