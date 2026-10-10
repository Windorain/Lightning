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
import type { EvaluationKey, GeometryId, MaterialDescriptor } from './evaluationKey'
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

/** 解析结果：**对象身份 + 元素身份 + 求值版本**。 */
export interface PickResolution {
  readonly objectId: string
  readonly elementId?: string
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
  private readonly generation: CompileGeneration

  constructor(private readonly scene: CompiledScene) {
    this.generation = scene.generation
    for (const p of scene.provenance) {
      const list = this.byBatch.get(p.batchIndex)
      if (list === undefined) this.byBatch.set(p.batchIndex, [p])
      else list.push(p)
      this.byObject.set(p.objectId, p)
    }
    for (const payload of scene.payloads) this.byBatchMaterial.set(payload.batchIndex, payload.material)
  }

  /** 当前世代。 */
  get currentGeneration(): CompileGeneration {
    return this.generation
  }

  /**
   * 解析一次批次命中。
   *
   * 返回 `null` 的两种情况都**不得**静默糊过去：
   *  - `generation` 与本次编译不符 ⇒ 这是**过期画面**上的拾取（A12）；
   *  - 批次内无该槽位 ⇒ 批次表与 GPU 状态不一致（真实缺陷，必须暴露）。
   */
  resolve(hit: BatchHitRef): PickResolution | null {
    if (hit.generation !== this.generation) return null
    const list = this.byBatch.get(hit.batchIndex)
    if (list === undefined) return null
    const entry = list.find((p) => p.instanceSlot === hit.instanceSlot)
    if (entry === undefined) return null
    const material = this.byBatchMaterial.get(hit.batchIndex)
    if (material === undefined) return null
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
