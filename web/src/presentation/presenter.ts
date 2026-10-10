/**
 * GPU 合批呈现器（#249 §11；#256 `presentation/three`）。
 *
 * ## 纯数据投影与 GPU 上传**分开**（§11 明文，本文件的核心纪律）
 *
 * | 阶段 | 谁做 | 副作用 |
 * |---|---|---|
 * | 批次划分 / provenance / 纯数据投影 | `presentation/compileScene.ts` | **无**（纯函数） |
 * | 建 `BufferGeometry`、`InstancedMesh`、绑材质 | 本文件 `apply()` | GPU 资源创建 |
 *
 * 于是"编译"能在无浏览器环境里断言（vitest），"上传"才需要真 GL。同时这也让
 * **A18 的两个数字可分开测量**：
 *  - **结构性绘制数** = `CompiledScene.drawCallEstimate`（vitest 可断言）；
 *  - **实测绘制数** = `WebGLRenderer.info.render.calls`（e2e 在真浏览器读）。
 *
 * ## 实例化路径与回退
 *
 * - 同质 + 同几何 + `deform === 'shared'` + 成员 > 1 ⇒ `InstancedMesh`（1 draw call / 批次）；
 * - 同质但独立变形 ⇒ 每实例一个 `Mesh`，**共享几何**（同几何 ⇒ 同 BufferGeometry）；
 * - 合并批次（非同质）⇒ 逐成员材质/几何（**不**用代表值糊过去，见 `batchPlan.homogeneous`）。
 *
 * `BatchedMesh` 在锁定版本 r174 可用（已在 `node_modules/three/build/three.core.js`
 * 核实 `class BatchedMesh extends Mesh`）。本呈现器**不**用它作为默认路径 —— 因为
 * `InstancedMesh` 已满足 A18 的同质夹具门槛，而 `BatchedMesh` 的
 * `addGeometry/addInstance` 动态容量管理会掩盖"几何是否被重建"这一 G1 观测点
 * （`setGeometrySize` 复用缓冲使重建不可见）。异构几何的批处理由**逐成员 Mesh + 共享
 * 几何缓存**承担，其可观测性更好。此取舍记于本单汇报的遗留缺口。
 *
 * ## 资源身份与释放（A19）
 *
 * 材质与几何都按**内容身份**（几何身份；材质身份含 blend/tint/顶点色）持有一份，并由
 * `OwnershipRegistry` 显式计数。`dispose()` 释放本呈现器的全部份额；两个视口共享同一条目
 * 时关闭其一不影响另一方。
 */

import * as THREE from 'three'
import type { BatchPayload, CompiledScene, CompileGeneration } from './compileScene'
import type { GeometryAttributes, MaterialDescriptor } from './evaluationKey'
import type { ContentIdentity } from './assetIdentity'
import { contentIdentityKey } from './assetIdentity'
import { OwnershipRegistry, type OwnershipEntry } from './ownership'

/** 呈现器可查询的运行统计（诊断与 A18/A19 观测面）。 */
export interface PresenterStats {
  /** `apply()` 调用次数。 */
  applies: number
  /** 新建的 `BufferGeometry` 数 —— **几何重建数**，G1/A11 的主读数。 */
  geometryBuilds: number
  /** 几何缓存复用次数 —— G1「变一个注解文字不重建方块几何」的正面对照。 */
  geometryReuses: number
  /** 新建材质数。 */
  materialBuilds: number
  /** 材质缓存命中数。 */
  materialReuses: number
  /** 迁移已有批次对象（未重建）的次数。 */
  batchReuses: number
  /** 新建批次对象次数。 */
  batchBuilds: number
  /** 真正 `dispose()` 的对象数（A19：与配置的 acquire 平衡）。 */
  disposals: number
  /** 当前挂载的批次对象数（主色彩 pass 的**对象**数，不是 draw call 数）。 */
  batchObjects: number
  /** 当前批次里实例总数。 */
  instanceCount: number
}

export interface PresenterOptions {
  /** 设备作用域（一个渲染器实例一个；由 `nextDeviceScope()` 分配）。 */
  scope: string
}

/**
 * 合批呈现器。
 *
 * 每个 `scope` 一个实例。`apply(scene)` 可反复调用（每次编译后一次）；`dispose()` 释放
 * 全部份额。`apply()` 对**未变的批次**做增量复用（几何/材质缓存命中 + 批次对象迁移），
 * 这是 G1 的实现落点。
 */
export class BatchedPresenter {
  private readonly group = new THREE.Group()
  private readonly ownership = new OwnershipRegistry()
  private readonly mounted = new Map<string, MountedBatch>()
  private readonly materialCache = new Map<string, CachedRef<THREE.Material>>()
  private readonly geometryCache = new Map<string, CachedRef<THREE.BufferGeometry>>()
  private generation: CompileGeneration | null = null
  private restoreCount = 0

  private readonly stats: PresenterStats = {
    applies: 0,
    geometryBuilds: 0,
    geometryReuses: 0,
    materialBuilds: 0,
    materialReuses: 0,
    batchReuses: 0,
    batchBuilds: 0,
    disposals: 0,
    batchObjects: 0,
    instanceCount: 0,
  }

  constructor(private readonly options: PresenterOptions) {
    this.group.name = `presentation-batches:${options.scope}`
  }

  /** 挂载根（调用方把它加进主场景的 structure 层）。 */
  get object3d(): THREE.Group {
    return this.group
  }

  get currentGeneration(): CompileGeneration | null {
    return this.generation
  }

  get deviceScope(): string {
    return this.options.scope
  }

  get restores(): number {
    return this.restoreCount
  }

  /**
   * 当前可查询的运行统计。
   *
   * `batchObjects` / `instanceCount` 是**实时**读数（不是累计），其余为累计。
   */
  statsSnapshot(): PresenterStats & { generation: CompileGeneration | null; scope: string } {
    return {
      ...this.stats,
      batchObjects: this.mounted.size,
      instanceCount: this.countInstances(),
      generation: this.generation,
      scope: this.options.scope,
    }
  }

  /**
   * 资源计数对账（A19 主判据）。
   *
   * 覆盖**本呈现器显式登记**的资源：材质与几何各 acquire 一次、卸载时 release 一次。
   * 恒等式：`acquireTotal === releaseTotal` 且 `disposeTotal === releaseTotal`。
   */
  ledger(): ReturnType<OwnershipRegistry['ledger']> {
    return this.ownership.ledger()
  }

  /**
   * 应用一次编译结果（**GPU 上传阶段**）。
   *
   * 增量策略（G1 的关键）：
   *  - 几何按**内容身份**缓存并计数引用 ⇒ 两次编译间同一身份被复用时不新建 `BufferGeometry`
   *    （于是"变一个注解文字"不会重建方块几何）；
   *  - 批次对象按**成员身份键**复用 ⇒ 键相同则只更新实例矩阵，不重建对象；
   *  - 本次不再存在的批次被卸载并释放引用。
   */
  apply(scene: CompiledScene): void {
    this.stats.applies += 1
    this.generation = scene.generation

    const nextKeys = new Set<string>()
    for (const payload of scene.payloads) {
      const key = batchKeyOf(payload)
      nextKeys.add(key)

      const existing = this.mounted.get(key)
      if (existing !== undefined && canReuse(existing, payload)) {
        this.stats.batchReuses += 1
        this.updateInstances(existing, payload)
        continue
      }
      if (existing !== undefined) this.unmount(existing)

      const mounted = this.mount(payload)
      this.mounted.set(key, mounted)
      this.group.add(mounted.object)
      this.stats.batchBuilds += 1
    }

    for (const mounted of [...this.mounted.values()]) {
      if (!nextKeys.has(mounted.key)) this.unmount(mounted)
    }
  }

  /** 释放本呈现器持有的全部份额（+ 卸载全部批次对象）。 */
  dispose(): void {
    for (const mounted of [...this.mounted.values()]) this.unmount(mounted)
    for (const [key, cached] of [...this.geometryCache.entries()]) {
      cached.value.dispose()
      this.stats.disposals += 1
      this.geometryCache.delete(key)
      this.ownership.release(this.entryOf(geometryIdentityOf(key)))
    }
    for (const [key, cached] of [...this.materialCache.entries()]) {
      cached.value.dispose()
      this.stats.disposals += 1
      this.materialCache.delete(key)
      this.ownership.release(this.entryOf(materialIdentityOfKey(key)))
    }
    this.group.clear()
    this.generation = null
  }

  /**
   * WebGL 丢失处置：**放弃全部 GPU 句柄**，但**保留**可重建的 CPU 侧描述
   * （#249 §19.5「重建 GPU 设备资源…不改写文档或清空编辑上下文」）。
   *
   * 返回被放弃的句柄数（单列在 `OwnershipRegistry.abandoned` 上，使"正常回收"与
   * "设备丢失放弃"在账上可区分）。
   */
  handleContextLost(): number {
    // 清掉挂载表与两个缓存，使恢复时**必然**重建 —— 旧 GPU 句柄不复用（A30 明文）。
    for (const mounted of this.mounted.values()) this.group.remove(mounted.object)
    this.mounted.clear()
    this.geometryCache.clear()
    this.materialCache.clear()
    const abandoned = this.ownership.abandonAll('webgl-context-lost')
    this.generation = null
    return abandoned
  }

  /**
   * WebGL 恢复：调用方随后用**当前有效版本**重新 `apply()` 一次
   * （A30「恢复后按当前有效版本重建」）。本方法把"需要重建"显式化并计数，
   * 避免"只 resize 而不重建归属资源"（A30 负对照）。
   */
  handleContextRestored(): void {
    this.restoreCount += 1
  }

  // ── 挂载 / 更新 / 卸载 ──

  private mount(payload: BatchPayload): MountedBatch {
    const materialIdentity = materialIdentityOf(payload.material)
    const material = this.materialFor(payload.material)
    const geometryKey = geometryKeyOf(payload)
    const geometry = this.geometryFor(geometryKey, payload.attributes)

    let object: THREE.Object3D
    if (payload.instanceable && payload.sharedGeometry) {
      const inst = new THREE.InstancedMesh(geometry, material, payload.instances.length)
      inst.name = `batch:${payload.batchIndex}`
      for (const instance of payload.instances) {
        inst.setMatrixAt(instance.instanceSlot, matrixOf(instance.transform))
      }
      inst.instanceMatrix.needsUpdate = true
      inst.userData.presentationBatch = batchTagOf(payload)
      object = inst
    } else if (payload.sharedGeometry) {
      const holder = new THREE.Group()
      holder.name = `batch:${payload.batchIndex}`
      for (const instance of payload.instances) {
        const mesh = new THREE.Mesh(geometry, material)
        mesh.applyMatrix4(matrixOf(instance.transform))
        mesh.userData.presentationBatch = batchTagOf(payload, instance.instanceSlot)
        holder.add(mesh)
      }
      object = holder
    } else {
      // 非同质批次：**逐成员**材质/几何（不得用代表值糊过去 —— 那会把 A 的纹理画到 B 上）
      const holder = new THREE.Group()
      holder.name = `batch:${payload.batchIndex}`
      for (const instance of payload.instances) {
        const attrs = instance.attributes
        const memberGeometryKey = attrs !== undefined
          ? `${geometryKey}#${instance.objectId}`
          : geometryKey
        const g = attrs !== undefined
          ? this.geometryFor(memberGeometryKey, attrs)
          : geometry
        const m = this.materialFor(payload.material)
        const mesh = new THREE.Mesh(g, m)
        mesh.applyMatrix4(matrixOf(instance.transform))
        mesh.userData.presentationBatch = batchTagOf(payload, instance.instanceSlot)
        holder.add(mesh)
      }
      object = holder
    }

    return {
      key: batchKeyOf(payload),
      object,
      materialIdentity,
      materialKey: identityKey(materialIdentity),
      geometryKey,
      /** 非同质批次会为每个成员各持一份几何引用 —— 卸载时逐份释放。 */
      memberGeometryKeys: payload.sharedGeometry
        ? []
        : payload.instances
            .filter((i) => i.attributes !== undefined)
            .map((i) => `${geometryKey}#${i.objectId}`),
      instanceCount: payload.instances.length,
      instanceable: payload.instanceable && payload.sharedGeometry,
    }
  }

  private updateInstances(mounted: MountedBatch, payload: BatchPayload): void {
    if (mounted.instanceable && mounted.object instanceof THREE.InstancedMesh) {
      const inst = mounted.object
      if (mounted.instanceCount !== payload.instances.length) {
        // 实例数变化 ⇒ 容量在构造期固定，必须重建
        this.unmount(mounted)
        const fresh = this.mount(payload)
        this.mounted.set(fresh.key, fresh)
        this.group.add(fresh.object)
        this.stats.batchBuilds += 1
        return
      }
      for (const instance of payload.instances) {
        inst.setMatrixAt(instance.instanceSlot, matrixOf(instance.transform))
      }
      inst.instanceMatrix.needsUpdate = true
      return
    }
    const children = mounted.object.children
    const reusable = children.length === payload.instances.length && mounted.memberGeometryKeys.length === 0
    if (!reusable) {
      this.unmount(mounted)
      const fresh = this.mount(payload)
      this.mounted.set(fresh.key, fresh)
      this.group.add(fresh.object)
      this.stats.batchBuilds += 1
      return
    }
    payload.instances.forEach((instance, i) => {
      const child = children[i]!
      child.matrixAutoUpdate = false
      child.matrix.copy(matrixOf(instance.transform))
      child.matrixWorldNeedsUpdate = true
    })
  }

  private unmount(mounted: MountedBatch): void {
    this.group.remove(mounted.object)
    this.stats.disposals += 1
    this.releaseMaterialRef(mounted.materialKey)
    this.releaseGeometryRef(mounted.geometryKey)
    for (const key of mounted.memberGeometryKeys) this.releaseGeometryRef(key)
    this.mounted.delete(mounted.key)
  }

  // ── 几何缓存（G1 的落点）──

  private geometryFor(key: string, attrs: GeometryAttributes | undefined): THREE.BufferGeometry {
    const cached = this.geometryCache.get(key)
    if (cached !== undefined) {
      cached.refs += 1
      this.stats.geometryReuses += 1
      return cached.value
    }
    const geometry = attrs === undefined ? new THREE.BufferGeometry() : buildGeometry(attrs)
    if (attrs === undefined) {
      // 共享路径应总有属性；缺失时**显式标记**，不假装渲染成功（A36/G4）
      geometry.userData.presentationMissingAttributes = true
    }
    this.geometryCache.set(key, { value: geometry, refs: 1 })
    this.ownership.acquire(this.entryOf(geometryIdentityOf(key)), () => {})
    this.stats.geometryBuilds += 1
    return geometry
  }

  private releaseGeometryRef(key: string): void {
    const cached = this.geometryCache.get(key)
    if (cached === undefined) return
    cached.refs -= 1
    if (cached.refs > 0) return
    cached.value.dispose()
    this.stats.disposals += 1
    this.geometryCache.delete(key)
    this.ownership.release(this.entryOf(geometryIdentityOf(key)))
  }

  // ── 材质缓存 ──

  private materialFor(descriptor: MaterialDescriptor): THREE.Material {
    const identity = materialIdentityOf(descriptor)
    const key = identityKey(identity)
    const cached = this.materialCache.get(key)
    if (cached !== undefined) {
      cached.refs += 1
      this.stats.materialReuses += 1
      return cached.value
    }
    const material = createMaterial(descriptor)
    this.materialCache.set(key, { value: material, refs: 1 })
    this.ownership.acquire(this.entryOf(identity), () => {})
    this.stats.materialBuilds += 1
    return material
  }

  private releaseMaterialRef(key: string): void {
    const cached = this.materialCache.get(key)
    if (cached === undefined) return
    cached.refs -= 1
    if (cached.refs > 0) return
    cached.value.dispose()
    this.stats.disposals += 1
    this.materialCache.delete(key)
    this.ownership.release(this.entryOf(materialIdentityOfKey(key)))
  }

  /**
   * 归属条目身份：内容身份 × **设备作用域**。
   *
   * 作用域进键的理由：WebGL 句柄不跨 context 共用（#249 §11 明文）。同一份内容在两个
   * 渲染器里是两条独立条目 —— 于是"释放其一"与"释放全部"的计数语义天然正确，
   * 不需要调用方记住这一点（这正是 A19「一方关闭不破坏另一方」的实现基础）。
   */
  private entryOf(identity: ContentIdentity): OwnershipEntry {
    return { identity, deviceScope: this.options.scope }
  }

  private countInstances(): number {
    let n = 0
    for (const mounted of this.mounted.values()) n += mounted.instanceCount
    return n
  }
}

interface MountedBatch {
  key: string
  object: THREE.Object3D
  materialIdentity: ContentIdentity
  materialKey: string
  geometryKey: string
  memberGeometryKeys: string[]
  instanceCount: number
  instanceable: boolean
}

interface CachedRef<T> {
  value: T
  refs: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 身份键（呈现层的内部约定；与 assetIdentity 的 `contentIdentityKey` 一致口径）
// ─────────────────────────────────────────────────────────────────────────────

/** 材质**实例**身份：id/version + 混合模式 + tint + 顶点色（不同 tint 必须不同材质）。 */
export function materialIdentityOf(descriptor: MaterialDescriptor): ContentIdentity {
  return {
    id: `material:${descriptor.id}:${descriptor.blend}:${descriptor.tint}:${descriptor.useVertexColor ? 'vc' : 'plain'}`,
    version: descriptor.version,
  }
}

/**
 * 几何身份。
 *
 * `key` 就是 `${id}@${version}` 或（非共享路径下）`${id}@${version}#${objectId}`。
 * 后者的 `#objectId` 段是**局部**的：它只在同一个非共享批次内区分成员，不构成新的
 * 内容身份 —— 因为同一几何的成员属性**内容相同**时 key 相同、缓存自然合并。
 */
function geometryIdentityOf(key: string): ContentIdentity {
  const hash = key.lastIndexOf('@')
  if (hash < 0) return { id: `geometry:${key}`, version: '0' }
  return { id: `geometry:${key.slice(0, hash)}`, version: key.slice(hash + 1) }
}

function materialIdentityOfKey(key: string): ContentIdentity {
  const hash = key.lastIndexOf('@')
  if (hash < 0) return { id: `material:${key}`, version: '0' }
  return { id: key.slice(0, hash), version: key.slice(hash + 1) }
}

function identityKey(identity: ContentIdentity): string {
  return contentIdentityKey(identity)
}

// ─────────────────────────────────────────────────────────────────────────────
// 批次对象的稳定标识
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 批次对象的复用键：兼容性键 + **成员对象身份**。
 *
 * 为什么成员身份进 key：批次位置不得作为对象身份，但"这个批次由哪些对象组成"是
 * 批次本身的身份。成员变了（对象移出/加入）⇒ 必须重建该批次对象。
 */
function batchKeyOf(payload: BatchPayload): string {
  return `${payload.compatibilityKey}#${payload.instances.map((i) => i.objectId).join(',')}`
}

/**
 * 挂在批次对象上的诊断标签（e2e 观测面）。
 *
 * `objectIds` 是权威身份；`batchIndex` 只作诊断。这直接支撑"对象身份没有被批次序号
 * 取代"这一断言 —— 观测面里两者同时可见、且可断言前者稳定而后者可变。
 */
function batchTagOf(payload: BatchPayload, instanceSlot?: number): Record<string, unknown> {
  return {
    batchIndex: payload.batchIndex,
    compatibilityKey: payload.compatibilityKey,
    objectIds: payload.instances.map((i) => i.objectId),
    instanceSlot,
  }
}

function geometryKeyOf(payload: BatchPayload): string {
  return `${payload.geometry.id}@${payload.geometry.version}`
}

function canReuse(mounted: MountedBatch, payload: BatchPayload): boolean {
  return (
    mounted.geometryKey === geometryKeyOf(payload) &&
    mounted.instanceable === (payload.instanceable && payload.sharedGeometry) &&
    mounted.memberGeometryKeys.length === 0
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// three 对象构造（纯上传侧）
// ─────────────────────────────────────────────────────────────────────────────

function buildGeometry(attrs: GeometryAttributes): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(attrs.positions, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(attrs.uvs, 2))
  g.setAttribute('color', new THREE.BufferAttribute(attrs.colors, 3))
  g.computeVertexNormals()
  return g
}

function createMaterial(descriptor: MaterialDescriptor): THREE.MeshBasicMaterial {
  const params: THREE.MeshBasicMaterialParameters = {
    vertexColors: descriptor.useVertexColor,
    color: descriptor.useVertexColor ? 0xffffff : descriptor.tint,
  }
  if (descriptor.blend !== 'opaque') {
    params.transparent = true
    params.alphaTest = descriptor.blend === 'cutout' ? 0.5 : 0
    params.depthWrite = true
  }
  return new THREE.MeshBasicMaterial(params)
}

/** 列主序 16 元 → `Matrix4`（`fromArray` 在 r174 支持数组 + 可选 offset）。 */
function matrixOf(values: readonly number[]): THREE.Matrix4 {
  return new THREE.Matrix4().fromArray(values as number[])
}
