/**
 * 拾取映射：**批次索引 → 对象/元素 + 求值版本**（#249 §11；#256 `presentation/picking`
 * 的纯逻辑部分）。
 *
 * ## 为什么类型上不允许 `resolveBatchHit(batchIndex)`
 *
 * A18 的负对照是「把 batch index 当对象 ID」。要让它被抓住，实现必须在**类型层面**要求
 * 调用方交出 `generation` —— 拿到一个裸的 `batchIndex` 根本无法构造合法请求。于是"把批次
 * 序号当对象身份"不是"写错了会被 review 指出"，而是**写不出来**。
 *
 * ## 为什么解析结果必须带求值版本
 *
 * A12 的判据：「拾取与显示版本一致」。过期画面上的点击如果解回**当前**版本的对象，用户
 * 看到的是旧几何、操作的是新对象 —— 这正是 #249 §7「不得新描边配旧几何」要防的事。
 * 所以 `resolve` 返回的结果携带**编译时的** `key`：调用方必须把它与当前有效求值版本比对
 * （`isResolutionCurrent`），不匹配时按 #256 的要求「暂停该类操作并明确状态」。
 *
 * ## 这不是权威数据
 *
 * `PickIndex` 由 `CompiledScene` 派生、可丢弃、可重建（契约 §6「求值场景、空间索引、统计
 * ⇒ 按求值键复用，**可丢弃**」）。丢弃它不影响任何持久身份。
 */

import type { CompiledScene, CompileGeneration, GeometryProvenance } from './compileScene'
import type { CellRef, TriangleCellMap } from './cellIdentity'
import { cellRefOfTriangle } from './cellIdentity'
import type { EvaluationKey, GeometryAttributes, GeometryId, MaterialDescriptor } from './evaluationKey'
import { structurallyEqual } from './evaluationKey'

/**
 * 一次拾取命中的**批次内**引用。
 *
 * `generation` 是必需字段（不是可选）—— 见文件头说明。
 */
export type BatchHitRef = Readonly<{
  /** 本次编译的世代（批次位置只在此世代内有效）。 */
  generation: CompileGeneration
  batchIndex: number
  /** 实例槽位（实例化路径下由 `raycaster` 的 `instanceId` 给出；非实例化为 0）。 */
  instanceSlot: number
  /** 该实例内的图元下标（三角形序号）；用于解到元素身份。 */
  primitiveIndex?: number
}>

/** 解析结果：**对象身份 + 元素身份 + 格身份 + 求值版本**。 */
export interface PickResolution {
  readonly objectId: string
  readonly elementId?: string
  /**
   * **格身份**（#299 P10e 逐格身份层）。
   *
   * ## 为什么它是**第三个**身份维度，而不是 `elementId` 的一种
   *
   * | 维度 | 语义 | 由谁判过期 |
   * |---|---|---|
   * | `objectId` | 命中了哪个**对象**（一结构一对象） | 求值键（`structurallyEqual`） |
   * | `elementId` | 命中了对象的哪个**拓扑元素**（顶点/边/面） | `topologyVersion` |
   * | `cell` | 命中了对象**内部**的哪一格 + 哪个面 | 求值键（格随内容变） |
   *
   * 三者的失效条件不同：拓扑版本变会使元素引用失效，而格坐标在**同一份内容**下
   * 永远有效（它是内容的坐标，不是索引 —— 见 `cellIdentity` 的三层身份说明）。
   * 把格并进 `elementId` 会让"命中了哪个元素"这一个问题同时问两件不同的事。
   *
   * ## `undefined` 的语义（**显式**，不是"第 0 格"）
   *
   * 该几何**不是**逐格来源（A18 自造夹具、纯网格元素），或调用方未提供
   * `primitiveIndex`。这与"提供了但越界"必须区分：后者返回 `null`
   * （表与 GPU 状态不一致 ⇒ 真实缺陷，必须暴露而不是回落）。
   */
  readonly cell?: CellRef
  readonly geometryId: GeometryId
  readonly geometryVersion: string
  readonly material: MaterialDescriptor
  /** 命中时的求值键（调用方据此判断是否与当前有效版本一致）。 */
  readonly keyAtHit: EvaluationKey
  /** 命中时的世代。 */
  readonly generation: CompileGeneration
  readonly batchIndex: number
  readonly instanceSlot: number
  readonly primitiveIndex?: number
}

/** 拾取映射（一次编译的派生视图）。 */
export class PickIndex {
  private readonly byBatch = new Map<number, GeometryProvenance[]>()
  private readonly byObject = new Map<string, GeometryProvenance>()
  private readonly byBatchMaterial = new Map<number, MaterialDescriptor>()
  /**
   * 几何身份 → **逐三角形格表**（#299 P10e）。
   *
   * ## 为什么从 `CompiledScene` 自己索引，而不是让调用方注入
   *
   * 格表是**几何**的属性（见 `evaluationKey#GeometryAttributes.cellMap`），而
   * `CompiledScene.payloads` 本就已经携带了每个批次的属性（共享路径在
   * `payload.attributes`、逐成员路径在 `instance.attributes`）—— 它是**编译产物的一部分**，
   * 不是外部资源。让调用方再注入一份会造出"两份格表可能不一致"的形态，
   * 而那种不一致的表现是"点选偶尔点到邻居格"（静默错误，最难查）。
   *
   * ## 为什么按**几何身份**索引（而不是按批次/槽位）
   *
   * 同一份几何可以落在多个批次（不同材质 → 不同兼容性键 ⇒ 不同批次），而它的
   * 三角形序与格映射**逐位相同**（同内容）。按几何身份索引使"共享几何"天然只有一份表。
   */
  private readonly cellMapByGeometry = new Map<GeometryId, TriangleCellMap>()
  /**
   * 合并批次（`homogeneous: false`）里**逐成员**的材质与几何身份。
   *
   * 为什么必须逐成员：批次级材质/几何只是**代表值**。用代表值解拾取会让
   * "点中 B 的方块"报出"B 的方块配 A 的材质" —— 而画面（呈现器逐成员取）与拾取
   * 两份答案不一致，表现为"点中的是高亮，看到的颜色不是"。`compileScene` 因此对
   * 与批次级不同的成员带上自己的身份（见 `BatchInstance.geometryId/material`）。
   */
  private readonly memberIdentity = new Map<string, { geometryId: GeometryId; material?: MaterialDescriptor }>()
  private readonly generation: CompileGeneration

  constructor(private readonly scene: CompiledScene) {
    this.generation = scene.generation
    for (const p of scene.provenance) {
      const list = this.byBatch.get(p.batchIndex)
      if (list === undefined) this.byBatch.set(p.batchIndex, [p])
      else list.push(p)
      this.byObject.set(p.objectId, p)
    }
    for (const payload of scene.payloads) {
      this.byBatchMaterial.set(payload.batchIndex, payload.material)
      this.indexCellMap(payload.geometry.id, payload.attributes)
      for (const instance of payload.instances) {
        const geometryId = instance.geometryId ?? payload.geometry.id
        this.indexCellMap(geometryId, instance.attributes)
        if (instance.geometryId !== undefined || instance.material !== undefined) {
          this.memberIdentity.set(this.slotKey(payload.batchIndex, instance.instanceSlot), {
            geometryId,
            ...(instance.material === undefined ? {} : { material: instance.material }),
          })
        }
      }
    }
  }

  private slotKey(batchIndex: number, instanceSlot: number): string {
    return `${batchIndex}/${instanceSlot}`
  }

  /**
   * 登记一份格表（**先登记者优先**，且只在形状自检通过时登记）。
   *
   * 形状自检在这里**再判一次**（`compileScene` 已判过）：`PickIndex` 也能被直接构造
   * （e2e 探针、诊断脚本），而"格表与三角形数不符"必须在那条路径上同样不可用 ——
   * 否则拾取会按错位的表解格，而错位是**静默**的（解出来的格坐标看起来完全合法）。
   */
  private indexCellMap(geometryId: GeometryId, attrs: GeometryAttributes | undefined): void {
    if (attrs?.cellMap === undefined) return
    if (attrs.cellMap.length !== attrs.triangleCount) return
    if (this.cellMapByGeometry.has(geometryId)) return
    this.cellMapByGeometry.set(geometryId, attrs.cellMap)
  }

  /** 当前世代。 */
  get currentGeneration(): CompileGeneration {
    return this.generation
  }

  /**
   * 几何身份 → 格表（**诊断/测试**用；拾取路径请用 `resolve` 的 `cell` 字段）。
   *
   * 单独暴露的理由：e2e 与 vitest 需要断言"这张表**确实**按几何身份到达了拾取层"，
   * 而不只是"某次 resolve 恰好带出了 cell" —— 前者覆盖共享几何的合并语义，
   * 后者只覆盖一条路径。
   */
  cellMapOf(geometryId: GeometryId): TriangleCellMap | undefined {
    return this.cellMapByGeometry.get(geometryId)
  }

  /**
   * 解析一次批次命中。
   *
   * 返回 `null` 的四种情况都**不得**静默糊过去：
   *  - `generation` 与本次编译不符 ⇒ 这是**过期画面**上的拾取（A12）；
   *  - 批次内无该槽位 ⇒ 批次表与 GPU 状态不一致（真实缺陷，必须暴露）；
   *  - 批次无材质 ⇒ 同上；
   *  - **几何带格表但 `primitiveIndex` 越界**（#299）⇒ 格表与 GPU 状态不一致 ——
   *    回落成 `cell: undefined` 会把"点到了界外三角形"伪装成"这个对象不可逐格拾取"，
   *    而前者是缺陷、后者是设计状态。两者必须可区分，故此处返回 `null`。
   */
  resolve(hit: BatchHitRef): PickResolution | null {
    if (hit.generation !== this.generation) return null
    const list = this.byBatch.get(hit.batchIndex)
    if (list === undefined) return null
    const entry = list.find((p) => p.instanceSlot === hit.instanceSlot)
    if (entry === undefined) return null
    // 合并批次：材质与几何身份按**成员**取（批次级只是代表值）。逐成员项缺席 ⇒ 批次级。
    const member = this.memberIdentity.get(this.slotKey(hit.batchIndex, hit.instanceSlot))
    const material = member?.material ?? this.byBatchMaterial.get(hit.batchIndex)
    if (material === undefined) return null
    const geometryId = member?.geometryId ?? entry.geometryId

    const map = this.cellMapByGeometry.get(geometryId)
    // 越界 ⇒ 真实缺陷（见上）。注意"没给 primitiveIndex"与"给了越界值"不同：
    // 前者 `cellRefOfTriangle` 返回 null 而 `hit.primitiveIndex === undefined`，
    // 故用显式判定把两者分开 —— 不能让 `undefined` 落进同一条 `null` 分支。
    if (map !== undefined && hit.primitiveIndex !== undefined) {
      const cell = cellRefOfTriangle(map, hit.primitiveIndex)
      if (cell === null) return null
      return {
        objectId: entry.objectId,
        elementId: entry.elementId,
        cell,
        geometryId: entry.geometryId,
        geometryVersion: entry.geometryVersion,
        material,
        keyAtHit: this.scene.key,
        generation: this.generation,
        batchIndex: hit.batchIndex,
        instanceSlot: hit.instanceSlot,
        primitiveIndex: hit.primitiveIndex,
      }
    }

    return {
      objectId: entry.objectId,
      elementId: entry.elementId,
      geometryId: entry.geometryId,
      geometryVersion: entry.geometryVersion,
      material,
      keyAtHit: this.scene.key,
      generation: this.generation,
      batchIndex: hit.batchIndex,
      instanceSlot: hit.instanceSlot,
      primitiveIndex: hit.primitiveIndex,
    }
  }

  /** 按对象身份反查（诊断/测试；**不**用于拾取路径 —— 拾取必须经批次）。 */
  provenanceOf(objectId: string): GeometryProvenance | undefined {
    return this.byObject.get(objectId)
  }

  /** 批次成员的对象身份（槽位序）。 */
  objectIdsOfBatch(batchIndex: number): readonly string[] {
    return (this.byBatch.get(batchIndex) ?? []).map((p) => p.objectId)
  }

  /** 该对象所在批次（**仅供诊断**；业务代码不得以批次位置标识对象）。 */
  batchIndexOf(objectId: string): number | undefined {
    return this.byObject.get(objectId)?.batchIndex
  }
}

/**
 * 解析结果是否**与当前有效求值版本一致**（A12「拾取与显示版本一致」）。
 *
 * 用**结构等价**（六个主键维度）而不是全等：机位变化不算版本过期
 * （它不改结构，见契约 §4 与 `structurallyEqual`）。
 */
export function isResolutionCurrent(res: PickResolution, currentKey: EvaluationKey): boolean {
  return structurallyEqual(res.keyAtHit, currentKey)
}

/**
 * 过期拾取的处置政策（#256 执行范围：「过期画面上的几何依赖输入按匹配求值版本验证，
 * 或**暂停该类操作并明确状态**」）。
 *
 * 返回显式判别式而不是布尔：调用方需要能向用户/诊断**说明**为什么操作没有生效
 * （#249 §19.9 结构化诊断；#256 要求"明确状态"）。
 */
export type StalePickVerdict =
  | { kind: 'apply'; resolution: PickResolution }
  | { kind: 'suspend'; reason: 'stale-evaluation'; detail: string; heldVersion: EvaluationKey }

export function evaluateStalePick(
  res: PickResolution | null,
  currentKey: EvaluationKey,
): StalePickVerdict | null {
  if (res === null) return null
  if (isResolutionCurrent(res, currentKey)) return { kind: 'apply', resolution: res }
  return {
    kind: 'suspend',
    reason: 'stale-evaluation',
    detail:
      `拾取命中世代 ${res.generation}（文档版本 ${res.keyAtHit.documentVersion}），` +
      `当前文档版本 ${currentKey.documentVersion}`,
    heldVersion: res.keyAtHit,
  }
}
