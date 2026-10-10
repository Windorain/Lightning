/**
 * 资源**状态机**（#249 §19.3：「状态区分未请求、加载中、可用、缺失、失败；并发请求可去重，
 * 完成事件必须验证版本」；A36 `asset-states`）。
 *
 * ## 为什么不能用 `null` 兼表三态
 *
 * A36 的负对照原文是「**null 同时代表加载中/缺失/失败**」。三者对调用方的**正确反应**不同：
 *
 * | 状态 | 正确反应 |
 * |---|---|
 * | `idle`（未请求） | 发起获取（或按需延迟） |
 * | `loading` | 等完成事件；不得据此判定导出可用性 |
 * | `available` | 用它投影 |
 * | `missing` | 内容**确实不存在** ⇒ 占位可长期保留；重试无意义 |
 * | `failed` | 获取/解码**出错** ⇒ 可重试，诊断须带原因 |
 *
 * 用 `null` 兼表会把"重试无意义"与"应该重试"合并成同一条分支 —— 于是导出侧要么
 * 无限重试一个不存在的资源，要么把一个可恢复的网络错误当永久缺失（G4：不得假装完整导出）。
 *
 * ## 占位与真实资源的区分
 *
 * `available` 携带 `ContentVersion`，占位**不携带**：`resolveAssetReadiness()` 是输出侧
 * 唯一判据 —— 它把"有占位在显示"与"资源真的就绪"分开，供 G4/A36 使用。
 */

import type { AssetId, AssetRequest, ContentVersion } from './assetIdentity'
import { contentIdentityKey } from './assetIdentity'

/**
 * 资源状态（**五态**，与 #249 §19.3 逐字对应）。
 *
 * `loading` / `failed` 可携带 `heldVersion`：这**不是**矛盾，而是"可保留上一可用版本"
 * （#249 §19.3 明文）的显式表达 —— 调用方因此能区分"正在显示旧版本"与"正在显示占位"。
 */
export type AssetState =
  | { phase: 'idle' }
  | { phase: 'loading'; requestId: string; heldVersion?: ContentVersion }
  | { phase: 'available'; version: ContentVersion }
  | { phase: 'missing'; detail: string }
  | { phase: 'failed'; reason: string; retryable: boolean; heldVersion?: ContentVersion }

/** 单条资源的状态记录（`AssetId` 为键）。 */
export interface AssetRecord {
  readonly id: AssetId
  readonly required: boolean
  readonly state: AssetState
  /** 最近一次被请求的内容版本（`idle` 时 undefined）。 */
  readonly requestedVersion?: ContentVersion
}

/** 输出侧就绪判别式（**不是** `boolean | null`；见文件头）。 */
export type AssetReadiness =
  | { status: 'ready'; version: ContentVersion }
  | { status: 'placeholder'; phase: 'loading' | 'missing' | 'failed'; heldVersion?: ContentVersion }
  | { status: 'unavailable' }

/**
 * 资源状态仓库 —— **纯数据 + 显式变更**，不含 three/DOM/网络。
 *
 * 接线层负责真正的获取与 GPU 上传；本类只保证状态转移与去重判据是纯的、可断言、
 * 可按 `AssetId` 查询（#249 §19.3「实际呈现版本与状态应可查询」；G4「本单提供资源状态
 * 查询面」）。
 */
export class AssetStateStore {
  private readonly records = new Map<AssetId, AssetRecord>()
  /** 进行中的请求：`AssetId` → 请求身份键（去重判据）。 */
  private readonly inflight = new Map<AssetId, string>()

  /**
   * 登记一次请求。
   *
   * 返回 `deduped: true` 表示**去重命中**：同一 `AssetId` 且同一内容版本的请求已在途，
   * 调用方应复用在途结果而不是再发一次（#249 §19.3「并发请求可去重」）。
   *
   * 若在途请求的内容版本**不同**（"替换资源时旧请求晚到"场景，A28），不复用而是**替换**：
   * 新请求成为权威，旧请求完成时因 `requestId` 不匹配被丢弃（A12/A28）。
   */
  begin(request: AssetRequest): { requestId: string; deduped: boolean } {
    const key = contentIdentityKey(request.identity)
    const existing = this.inflight.get(request.identity.id)
    if (existing === key) {
      return { requestId: existing, deduped: true }
    }
    this.inflight.set(request.identity.id, key)
    const prev = this.records.get(request.identity.id)
    const held = heldVersionOf(prev)
    this.records.set(request.identity.id, {
      id: request.identity.id,
      required: request.required,
      requestedVersion: request.identity.version,
      state:
        held === undefined
          ? { phase: 'loading', requestId: key }
          : { phase: 'loading', requestId: key, heldVersion: held },
    })
    return { requestId: key, deduped: false }
  }

  /**
   * 完成事件 —— **必须验证版本**（#249 §19.3 明文；A12 负对照「无版本检查接纳旧结果」）。
   *
   * `requestId` 必须等于当前在途请求，且完成的内容版本必须等于登记时请求的版本；
   * 任一不符 ⇒ **过期结果**，返回 `false` 且状态不变。调用方据此丢弃结果并释放其
   * 已获取的资源（A12「旧资源释放」；A28「旧资源不覆盖新版本」）。
   */
  complete(id: AssetId, requestId: string, version: ContentVersion): boolean {
    if (this.inflight.get(id) !== requestId) return false
    const rec = this.records.get(id)
    if (rec === undefined || rec.requestedVersion !== version) return false
    this.inflight.delete(id)
    this.records.set(id, {
      id,
      required: rec.required,
      requestedVersion: version,
      state: { phase: 'available', version },
    })
    return true
  }

  /** 内容**确实不存在**（404 / 清单声明缺失）。 */
  markMissing(id: AssetId, requestId: string, detail: string): boolean {
    if (this.inflight.get(id) !== requestId) return false
    const rec = this.records.get(id)
    this.inflight.delete(id)
    this.records.set(id, {
      id,
      required: rec?.required ?? false,
      requestedVersion: rec?.requestedVersion,
      state: { phase: 'missing', detail },
    })
    return true
  }

  /** 获取/解码**失败**（可重试性由调用方判断，必须是显式输入而不是猜）。 */
  markFailed(id: AssetId, requestId: string, reason: string, retryable: boolean): boolean {
    if (this.inflight.get(id) !== requestId) return false
    const rec = this.records.get(id)
    const held = heldVersionOf(rec)
    this.inflight.delete(id)
    this.records.set(id, {
      id,
      required: rec?.required ?? false,
      requestedVersion: rec?.requestedVersion,
      state:
        held === undefined
          ? { phase: 'failed', reason, retryable }
          : { phase: 'failed', reason, retryable, heldVersion: held },
    })
    return true
  }

  /**
   * 清空允许丢弃的缓存后回到基线（A19「清空允许缓存后活跃计数回基线」的状态侧对称项）。
   * `idle` = 未请求，正是基线状态。
   */
  reset(): void {
    this.records.clear()
    this.inflight.clear()
  }

  get(id: AssetId): AssetRecord | undefined {
    return this.records.get(id)
  }

  /** 全部记录（诊断/对账用；稳定排序保证可复现）。 */
  all(): readonly AssetRecord[] {
    return [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  /** 在途请求数（A19 判据的可查询面之一）。 */
  inflightCount(): number {
    return this.inflight.size
  }

  /** 按状态聚合的计数（诊断面）。 */
  counts(): Readonly<Record<AssetState['phase'], number>> {
    const out = { idle: 0, loading: 0, available: 0, missing: 0, failed: 0 }
    for (const r of this.records.values()) out[r.state.phase] += 1
    return out
  }
}

function heldVersionOf(rec: AssetRecord | undefined): ContentVersion | undefined {
  if (rec === undefined) return undefined
  const st = rec.state
  if (st.phase === 'available') return st.version
  if (st.phase === 'loading' || st.phase === 'failed') return st.heldVersion
  return undefined
}

/**
 * 输出侧就绪判据（G4 / A36）。
 *
 * **唯一**允许调用方判断"这份资源能不能用于正式输出"的入口：
 *  - `ready` ⇒ 真实资源就绪，携带其版本；
 *  - `placeholder` ⇒ 有东西可显示（旧版本/占位），但**不得**当作完整资源；
 *  - `unavailable` ⇒ 尚未请求。
 */
export function resolveAssetReadiness(store: AssetStateStore, id: AssetId): AssetReadiness {
  const rec = store.get(id)
  if (rec === undefined || rec.state.phase === 'idle') return { status: 'unavailable' }
  const st = rec.state
  if (st.phase === 'available') return { status: 'ready', version: st.version }
  if (st.phase === 'loading') return { status: 'placeholder', phase: 'loading', heldVersion: st.heldVersion }
  if (st.phase === 'missing') return { status: 'placeholder', phase: 'missing' }
  return { status: 'placeholder', phase: 'failed', heldVersion: st.heldVersion }
}

/**
 * 输出预检（G4：「必需资源未就绪不假装完整导出」）。
 *
 * 返回全部**未就绪的必需资源**（含其相位）。空数组 = 预检通过。消费方是 P9（#260）的
 * 导出作业；本单只提供该查询面，不实现导出（#256「退出与边界」）。
 */
export function preflightRequiredAssets(
  store: AssetStateStore,
  requests: readonly AssetRequest[],
): readonly { id: AssetId; phase: AssetState['phase']; detail: string }[] {
  const blocking: { id: AssetId; phase: AssetState['phase']; detail: string }[] = []
  for (const req of requests) {
    if (!req.required) continue
    const readiness = resolveAssetReadiness(store, req.identity.id)
    if (readiness.status === 'ready') continue
    const phase = readiness.status === 'unavailable' ? 'idle' : readiness.phase
    blocking.push({
      id: req.identity.id,
      phase,
      detail: readiness.status === 'unavailable' ? '未请求' : `仅有占位（${readiness.phase}）`,
    })
  }
  return blocking
}
