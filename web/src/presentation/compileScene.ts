/**
 * 求值场景 → **绘制数据**的呈现编译（#249 §11；#256 `presentation/scene`）。
 *
 * ## 三个产出物，各对应一条验收
 *
 * | 产出 | 内容 | 服务的判据 |
 * |---|---|---|
 * | `plans` | 批次划分（兼容性/空间范围/透明顺序/变形方式） | A18 ≤32 draw call；G2 身份稳定 |
 * | `provenance` | 对象 → 几何来源 + 属性版本 + 批次位置 | 拾取映射回对象/元素 + 求值版本（A12） |
 * | `payloads` | 纯数据投影（位置/UV/颜色/变换），**不含 GPU 句柄** | §11「纯数据投影与有副作用的 GPU 上传分开」 |
 *
 * ## 为什么 provenance 里同时记 objectId 与批次位置
 *
 * #249 §11 要求「批次索引仅在**其 generation 内**有效」。所以编译结果承载 `generation`
 * （本次编译的身份），而批次位置只在 `generation` 匹配时才有意义。拾取回来的批次引用必须
 * 带上 generation 才能解回对象 —— 这正是「把 batch index 当对象 ID」这个负对照在实现上的
 * **不可表达性**：拿不到 generation 就无法构造一次合法的解析请求。
 *
 * ## 与 GPU 上传的边界
 *
 * 本文件**不 import three**（编译层必须能在无 GPU/无浏览器下断言，也是 A02 同族的纯性
 * 纪律）。上传由 `presentation/three` 消费 `CompiledScene` 完成。
 */

import type { AssetId } from './assetIdentity'
import type { BatchPlan, BatchBudget, PrimitiveKey } from './batchPlan'
import { planBatches, DEFAULT_BATCH_BUDGET, primitiveKeyOf } from './batchPlan'
import type {
  EvaluatedPrimitive,
  EvaluationKey,
  GeometryAttributes,
  GeometryId,
  MaterialDescriptor,
  PresentationInputs,
} from './evaluationKey'
import type { InvalidationPlan } from './invalidationPlan'
import { cellMapShapeOk } from './cellIdentity'
import { err, missingTarget, ok, type DomainError, type Result } from '@/domain/errors'

/**
 * 一次编译的**世代身份**。
 *
 * 不变量：同一 `generation` 内的批次位置才有意义。世代由编译输入的**稳定内容键**派生
 * （同输入 ⇒ 同世代 ⇒ 可复用），使下游缓存不因"又编译了一次"而全失效。
 */
export type CompileGeneration = string

/** 几何来源记录（#249 §11「保留对象来源、几何来源和属性版本映射」）。 */
export interface GeometryProvenance {
  readonly objectId: string
  readonly elementId?: string
  readonly geometryId: GeometryId
  /** 几何**内容**版本（不是获取位置）。 */
  readonly geometryVersion: string
  readonly materialId: string
  readonly materialVersion: string
  /** 该对象所在的批次位置（**仅在 `generation` 内有效**）。 */
  readonly batchIndex: number
  /** 在批次内的实例槽位（实例化路径下用于 `setMatrixAt`）。 */
  readonly instanceSlot: number
}

/** 纯数据投影：一个批次的 GPU 上传载荷（**无 three 类型**）。 */
export interface BatchPayload {
  readonly batchIndex: number
  readonly compatibilityKey: string
  readonly material: MaterialDescriptor
  readonly geometry: Readonly<{ id: GeometryId; version: string }>
  /**
   * 几何是否**可在批次内共享**（同组内所有成员同几何 ⇒ 一份属性 + N 个变换）。
   * `false` ⇒ 逐成员几何，`instances[].attributes` 为各自属性。
   */
  readonly sharedGeometry: boolean
  /** 共享路径下的几何属性（`sharedGeometry === true` 时存在）。 */
  readonly attributes?: GeometryAttributes
  /** 逐实例成员（变换/属性）。 */
  readonly instances: readonly BatchInstance[]
  readonly instanceable: boolean
  readonly transparent: boolean
  /** 成员是否同质（合并批次为 `false` ⇒ 呈现层走逐成员路径）。 */
  readonly homogeneous: boolean
}

export interface BatchInstance {
  readonly objectId: string
  readonly elementId?: string
  readonly instanceSlot: number
  /** 局部变换（列主序 16 元）。 */
  readonly transform: readonly number[]
  /** 非共享几何路径下该实例自己的属性。 */
  readonly attributes?: GeometryAttributes
}

/** 编译结果。 */
export interface CompiledScene {
  readonly generation: CompileGeneration
  /** 本次编译使用的求值键 —— **呈现与拾取版本一致性的凭据**。 */
  readonly key: EvaluationKey
  readonly plans: readonly BatchPlan[]
  readonly payloads: readonly BatchPayload[]
  readonly provenance: readonly GeometryProvenance[]
  /** 诊断面：本次编译命中的失效计划（由调用方传入；纯数据）。 */
  readonly invalidation?: InvalidationPlan
  /**
   * 被跳过的对象（几何不可用或版本不符）—— **显式报告**，不允许静默丢
   * （A36/G4：必需资源未就绪不得假装完整）。
   */
  readonly skipped: readonly { objectId: string; reason: SkipReason }[]
  /**
   * 主色彩 pass 的绘制数**估计** = 批次数。
   *
   * 语义是"结构性计数"，不是实测 GPU 统计。A18 的**实测**由 e2e 从浏览器里的
   * `WebGLRenderer.info.render.calls` 读取（见 `presentation/three` 暴露的观测点）——
   * 本字段服务 vitest 侧的结构断言与快速回归。
   */
  readonly drawCallEstimate: number
}

export type SkipReason =
  | 'geometry-identity-unknown'
  | 'geometry-version-mismatch'
  | 'geometry-unavailable'
  | 'transform-shape-invalid'
  /**
   * 几何携带了逐格表，但其长度与三角形数不符（#299 P10e）。
   *
   * 单独一个 reason 而不是并进 `geometry-unavailable`：后者是"几何还没到"
   * （可重试、属资源状态），本项是"格表算错了"（**实现缺陷**，重试不会好）。
   * 把两者并起来会让一次真实的适配层回归表现为"资源还没加载完"。
   */
  | 'cell-map-shape-invalid'

/**
 * 编译求值场景 → 绘制数据。
 *
 * 失败是 `Result`（契约 §0）：`scene` 缺失时返回 `MissingTarget`，而不是产出一个
 * "看起来完整"的空场景（#249 §13「不得以空接口、假成功控件充当完成」）。
 */
export function compileScene(
  inputs: PresentationInputs,
  budget: BatchBudget = DEFAULT_BATCH_BUDGET,
  invalidation?: InvalidationPlan,
): Result<CompiledScene> {
  if (inputs.key.scene === '') {
    return err(missingTarget({ what: 'scene' }))
  }

  const skipped: { objectId: string; reason: SkipReason }[] = []
  const renderable: EvaluatedPrimitive[] = []
  // 按**图元**（不是对象）索引：#249 §3.3「对象身份与 GPU 批次身份分离」。
  // 一个内核对象可以展开成多个图元（逐 `materialIndex` 分组），以 `objectId` 为键会让
  // 第二个图元覆盖第一个的槽位 —— 那正是贴图整链失效 + 拾取解不出的机械原因。
  const byPrimitive = new Map<PrimitiveKey, EvaluatedPrimitive>()

  for (const p of inputs.primitives) {
    if (p.transform.length !== 16) {
      skipped.push({ objectId: p.objectId, reason: 'transform-shape-invalid' })
      continue
    }
    const version = inputs.geometry.versionOf(p.geometry.id)
    if (version === undefined) {
      skipped.push({ objectId: p.objectId, reason: 'geometry-identity-unknown' })
      continue
    }
    if (version !== p.geometry.version) {
      // 内容身份不一致：呈现的身份必须来自**来源**而不是调用方声明 —— 否则
      // "换了内容但声明旧版本"会静默复用旧 GPU 资源（A28「旧资源不覆盖新版本」的反面）。
      skipped.push({ objectId: p.objectId, reason: 'geometry-version-mismatch' })
      continue
    }
    if (inputs.geometry.attributesOf(p.geometry.id) === undefined) {
      skipped.push({ objectId: p.objectId, reason: 'geometry-unavailable' })
      continue
    }
    // **逐格身份的形状自检**（#299 P10e）：携带了格表却与三角形数不符 ⇒ 显式跳过。
    // 为什么在**编译期**判而不是等拾取时才发现：拾取是异步的、可选的用户动作；
    // 一次算错的格表若只表现为"偶尔点错格"，它永远不会被报出来。放在这里，
    // 它变成编译结果里的一条**可断言**的 `skipped` 记录。
    const attrs = inputs.geometry.attributesOf(p.geometry.id)!
    if (!cellMapShapeOk(attrs.cellMap, attrs.triangleCount)) {
      skipped.push({ objectId: p.objectId, reason: 'cell-map-shape-invalid' })
      continue
    }
    renderable.push(p)
    byPrimitive.set(primitiveKeyOf(p), p)
  }

  const plans = planBatches(renderable, budget)

  // ── 批次划分：**图元** → (batchIndex, instanceSlot)（不是 objectId）──
  const slotOf = new Map<PrimitiveKey, { batchIndex: number; instanceSlot: number }>()
  plans.forEach((plan, batchIndex) => {
    plan.members.forEach((member, instanceSlot) => {
      slotOf.set(member.primitiveKey, { batchIndex, instanceSlot })
    })
  })

  // ── provenance：稳定排序（先批次、再槽位）⇒ 编译可复现 ──
  // 每条记录仍携带**对象身份**（`objectId`）—— 批次身份换了，对象身份没换。
  const provenance: GeometryProvenance[] = []
  for (const p of renderable) {
    const slot = slotOf.get(primitiveKeyOf(p))!
    provenance.push({
      objectId: p.objectId,
      elementId: p.elementId,
      geometryId: p.geometry.id,
      geometryVersion: p.geometry.version,
      materialId: p.material.id,
      materialVersion: p.material.version,
      batchIndex: slot.batchIndex,
      instanceSlot: slot.instanceSlot,
    })
  }
  provenance.sort((a, b) => a.batchIndex - b.batchIndex || a.instanceSlot - b.instanceSlot)

  // ── payloads：纯数据投影 ──
  const payloads: BatchPayload[] = []
  plans.forEach((plan, batchIndex) => {
    const members = plan.members
    const attrsEntries: (GeometryAttributes | undefined)[] = members.map((m) =>
      inputs.geometry.attributesOf(byPrimitive.get(m.primitiveKey)!.geometry.id),
    )
    const first = attrsEntries[0]
    // 同质批次才允许"一份几何 + N 个变换"；且必须是**同一个属性对象**
    // （不同对象即使几何身份相同但属性实例不同 ⇒ 不共享，避免多视口下互相覆盖）。
    const allSameGeometry =
      plan.homogeneous && first !== undefined && attrsEntries.every((a) => a === first)

    const instances: BatchInstance[] = members.map((m, instanceSlot) => {
      const p = byPrimitive.get(m.primitiveKey)!
      return {
        objectId: m.objectId,
        elementId: p.elementId,
        instanceSlot,
        transform: p.transform,
        attributes: allSameGeometry ? undefined : attrsEntries[instanceSlot],
      }
    })

    payloads.push({
      batchIndex,
      compatibilityKey: plan.compatibilityKey,
      material: plan.material,
      geometry: plan.geometry,
      sharedGeometry: allSameGeometry,
      attributes: allSameGeometry ? first : undefined,
      instances,
      instanceable: plan.instanceable && allSameGeometry,
      transparent: plan.transparency !== null || plan.material.blend !== 'opaque',
      homogeneous: plan.homogeneous,
    })
  })

  return ok({
    generation: generationOf(inputs.key, plans),
    key: inputs.key,
    plans,
    payloads,
    provenance,
    invalidation,
    skipped,
    drawCallEstimate: payloads.length,
  })
}

/**
 * 世代身份：由**主键 + 批次结构**派生（**不含机位**）。
 *
 * 为什么不含机位：世代是"这批绘制数据"的身份。机位变化不改变绘制数据（只改变投影），
 * 若把机位计入世代，每次转视角都会让下游（拾取映射、实例槽缓存）全部失效 —— 那正是
 * A11 要防的"机位变化引发重算"。
 */
export function generationOf(key: EvaluationKey, plans: readonly BatchPlan[]): CompileGeneration {
  const parts = [
    `d${key.documentVersion}`,
    `s${key.scene}`,
    `t${key.time.numerator}/${key.time.denominator}`,
    `p${key.parameterVersion}`,
    `x${key.stagedTransactionVersion ?? '-'}`,
    Object.keys(key.contentResourceVersions)
      .sort()
      .map((id) => `${id}=${key.contentResourceVersions[id]}`)
      .join(','),
    ...plans.map((p) => `${p.compatibilityKey}:[${p.members.map((m) => m.primitiveKey).join(',')}]`),
  ]
  let hash = 0x811c9dc5
  const s = parts.join('\u0001')
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `g:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * 资源需求清单（G4 的呈现侧输出）。
 *
 * 从编译结果**反推**本次呈现真正需要的资源：材质身份 → 内容资源。消费方是
 * `preflightRequiredAssets()`（导出预检，P9 使用）与资源状态查询面。
 */
export function requiredAssetIds(scene: CompiledScene): readonly AssetId[] {
  const ids = new Set<AssetId>()
  for (const p of scene.payloads) ids.add(p.material.id)
  return [...ids].sort()
}

/** 编译失败的错误（供诊断关联；#249 §19.9）。 */
export function compileErrorOf(result: Result<CompiledScene>): DomainError | null {
  return result.ok ? null : result.error
}
