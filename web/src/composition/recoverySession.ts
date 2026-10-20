/**
 * `composition/recoverySession` —— **恢复副本的生产接线**（M8-4；SPEC §9:299）。
 *
 * ## 它接管的三件事（纯机制在 `application/recovery`，A31 已完备但生产零调用）
 *
 * | 时机 | 动作 | 不做什么 |
 * |---|---|---|
 * | 内容编辑提交（内核写 + legacy 投影完成） | 防抖后 `planRecoveryWrite` → `writeRecoveryCopy` | **不**调保存结算；**不**改当前内容 |
 * | 启动 / 刷新后 | `listRecoveryKeys` + 逐份 `validateRecoveryCopy` | 坏副本**不自动删除**（只诊断 + 提示；放弃是用户动作） |
 * | 用户显式采纳 | `decideRecoveryAdoption` → `adoptRecoveryCopy` → `projectToRuntimeDocument` → 宿主装载序列 | **不**推进正式保存基线（采纳后仍脏，S5-b） |
 * | 正式保存 committed | 作废该文档的副本（Q2：保存后不保留历史） | 保存路径本身不改（副本是旁路事实） |
 *
 * ## 为什么采纳不走 `restoreProjectFile`（工程重开）
 *
 * 工程重开把基线钉到内容本身（"刚打开 = 干净"）。恢复副本保的是**未保存**内容
 * ⇒ 采纳后必须仍为**脏**（§9:299「采纳 ≠ 保存」；S5-b 的判据原文）。故本模块复用
 * 同一条投影 + 装载序列，但**不**走那条"钉基线"的分支：基线由 `createDocument` 的
 * 初值（空内容基线）给出，`adoptRecoveryCopy` 只换内容、基线逐位带过。
 *
 * ## 为什么与宿主之间是**端口**而不是直接 import Context
 *
 * `composition/` 是新实现层，按 `tests/architecture/composition-legacy-binding` 的
 * 冻结登记表，**不得**新增指向旧层（`runtime/`、`logging/`）的导入 —— 那条登记表的
 * 口径是"新增绑定必须走基线修订的显式流程，不是往豁免里塞"（#387 评论 7293）。
 * ⇒ 本模块只表达**政策与存储动作**；装载（setDocument/adoptDocument/装配面/绑定重置）
 * 由宿主在自己的层里实现并经 RecoveryHostPort 注入 —— 与 `composition/projectIo#ProjectHost`、
 * `composition/documentLoad#KernelLoadHost` 同一手法。
 *
 * ## 文档身份 vs 实例身份（Q2 与 M7-6 键族协调，结论写进 M8-4 报告）
 *
 * - 键含 `scope.instanceId.documentId`（`application/recovery` 的既有形态，判据已钉）；
 *   `instanceId` 保证同页两实例不互覆（M7-6 的实例隔离键族）；
 * - **保留策略按文档身份计**：同一 `documentId` 的最近 N 份；跨实例不合并
 *   （另一个标签页的副本不进本实例的列表，`listRecoveryKeys` 已按 scope+instance 过滤）。
 * - 工作台实例结构性唯一（Q3），故"每文档 3 份"在本实例里就是"该文档键族 3 个槽"。
 */

import { ref, type Ref } from 'vue'

import { decodeRecoveryValue, encodeRecoveryValue, recoveryStorePort, type StorageLike } from '@/adapters/recoveryStore'
import type { DiagnosticRecorder } from '@/application/diagnostics'
import type { ResourceRef } from '@/domain/materials'
import {
  adoptRecoveryCopy,
  decideRecoveryAdoption,
  instanceIdentity,
  listRecoveryKeys,
  parseRecoveryStoreKey,
  planRecoveryWrite,
  readRecoveryCopy,
  readRecoveryOrigin,
  recoveryStoreKey,
  removeRecoveryCopy,
  validateRecoveryCopy,
  writeRecoveryCopy,
  type InstanceIdentity,
  type RecoveryPayload,
  type RecoveryRejectionReason,
  type RecoverySourceSnapshot,
  type RecoveryStorePort,
} from '@/application/recovery'
import {
  RECOVERY_RETENTION_LIMIT,
  RECOVERY_WRITE_DEBOUNCE_MS,
  planRecoveryRetention,
  recoveryBaseKeyOf,
  recoveryRankOf,
  recoveryRetainedKey,
  recoveryRetainedKeys,
} from '@/application/recoveryPolicy'
import { createDocument } from '@/domain/document'
import type { MultiblockDeclaration } from '@/domain/multiblockDocument'
import { projectToRuntimeDocument, type KernelDeclarationProjection } from '@/composition/kernelProjection'

// 恢复副本的应用范围（工作台编辑上下文；键族形态由判据钉死）。
const RECOVERY_SCOPE = 'workbench' as const

// ─────────────────────────────────────────────────────────────────────────────
// 端口（Context / 状态栏 / 算子共用同一份词汇）
// ─────────────────────────────────────────────────────────────────────────────

/** 一份**校验通过**的恢复副本候选（展示与采纳都只需要这些字段）。 */
export interface RecoveryCandidateView {
  readonly key: string
  readonly documentId: string
  /** 载荷里的写入时刻（注入时钟；毫秒）。 */
  readonly writtenAt: number
  readonly documentVersion: number
  readonly contentVersion: number
  /** 人读标签（文档元数据名；空串 = 文档未声明名字）。 */
  readonly label: string
}

/** 采纳结局（`none` = 没有候选；`rejected` = 候选在这一刻校验失败，当前内容未动）。 */
export type RecoveryAdoptOutcome =
  | { readonly status: 'adopted'; readonly documentId: string; readonly changed: boolean }
  | { readonly status: 'rejected'; readonly reasons: readonly RecoveryRejectionReason[] }
  | { readonly status: 'none' }
  | { readonly status: 'failed'; readonly code: string }

/** 放弃结局（用户显式丢弃；`none` = 没有可丢弃的副本）。 */
export type RecoveryDiscardOutcome =
  | { readonly status: 'discarded'; readonly removed: number }
  | { readonly status: 'none' }

/**
 * 恢复副本会话端口。
 *
 * 生命周期 = 外壳实例：装配层创建、`WorkbenchHost#destroy` 释放。
 * 所有写/采纳都由**用户编辑或显式动作**驱动；没有"读到就自动采纳"的入口
 * （SPEC §9：采纳是**明确**的内容恢复操作）。
 */
export interface RecoverySessionPort {
  readonly candidate: Ref<RecoveryCandidateView | null>
  readonly corruptCount: Ref<number>
  /** 一次内容编辑已提交（经内核写 + legacy 投影）—— 防抖后写副本。 */
  contentSettled(): void
  /** 一次正式保存**真的**推进了基线 —— 对应副本作废（Q2 策略：保存后不保留历史）。 */
  formalSaveCommitted(): void
  /** 用户显式采纳候选（不调保存结算、不推基线）。 */
  adopt(): RecoveryAdoptOutcome
  /** 用户显式放弃候选（或损坏副本）。 */
  discard(): RecoveryDiscardOutcome
  /** 外壳卸载：清计时器/监听，不删除任何存储内容。 */
  dispose(): void
}

/** 宿主交给会话的"当前内容快照"（宿主从内核会话读出；`dirty` 决定要不要写）。 */
export interface RecoveryHostSnapshot {
  readonly documentId: string
  readonly dirty: boolean
  readonly snapshot: RecoverySourceSnapshot
  readonly assets: readonly ResourceRef[]
}

/** 装载一次采纳结果所需的外部动作（实现方 = 装配宿主；composition 不 import 旧层）。 */
export interface RecoveryInstallInput {
  readonly payload: RecoveryPayload
  /** 恢复出来的内核文档（`adoptRecoveryCopy` 的产物，**类型上**由宿主收窄）。 */
  readonly restored: unknown
  /** 它的内容三块（`adoptDocument` 的第二参数）。 */
  readonly content: unknown
  /** 旧格式载体（本模块用 `projectToRuntimeDocument` 产出，交给宿主 setDocument）。 */
  readonly projected: unknown
  /** 装配面的多方块投影（`null` = 不是多方块文档）。 */
  readonly declaration: unknown
}

/**
 * 宿主端口（由 `runtime/host/workbenchHost` 实现）。
 *
 * 五个动作就是采纳/写入真正需要的外部事实 —— 本模块**不**认识 `Context`、
 * 不认识 `KernelSession`，也不 import 它们（理由见文件头）。
 */
export interface RecoveryHostPort {
  readonly instanceId: string
  readonly diagnostics: DiagnosticRecorder
  /** 底栏实时状态（渠道由宿主写死为 `'recovery'`；本模块只给语义级别）。 */
  live(message: string, level: 'info' | 'warn' | 'error', state: string): void
  /** 当前内核内容快照；`null` = 未装配/无文档（不写副本）。 */
  captureCurrent(): RecoveryHostSnapshot | null
  /** 把采纳结果装进生产装载序列；返回是否成功（失败必须**不改**当前有效内容）。 */
  installRestored(input: RecoveryInstallInput): boolean
  /** 当前内核文档身份（正式保存后作废副本用）；`null` = 无文档。 */
  currentDocumentId(): string | null
}

export interface CreateRecoverySessionOptions {
  readonly host: RecoveryHostPort
  /** 注入存储（测试用）；缺省 = 浏览器 localStorage 适配器。 */
  readonly storage?: StorageLike | null
  /** 注入时钟（测试用）。 */
  readonly now?: () => number
  /** 注入防抖窗口（测试用）；缺省 = Q2 策略常量。 */
  readonly debounceMs?: number
}

interface ScannedEntry {
  readonly key: string
  readonly baseKey: string
  readonly rank: number
  readonly payload: RecoveryPayload
}

interface CorruptEntry {
  readonly key: string
  readonly documentId: string
  readonly reasons: readonly RecoveryRejectionReason[]
}

function reasonsTextOf(reasons: readonly RecoveryRejectionReason[]): string {
  return reasons.map((r) => (r.kind === 'shapeInvalid' ? r.kind + '@' + r.path : r.kind)).join('|')
}

function labelOf(payload: RecoveryPayload): string {
  const name = payload.content.metadata.name
  return typeof name === 'string' ? name : ''
}

function isoOf(ms: number): string {
  try {
    return new Date(ms).toISOString()
  } catch {
    return String(ms)
  }
}

/**
 * 内核内容里的多方块声明 → 投影入参。
 *
 * 恢复副本只带内容权威（`content.multiblock`），没有装配期资产目录；
 * `BlockPaletteEntry.geometry` 自带几何，故 `assets: {}` 不丢几何。
 */
function declarationProjectionOf(decl: MultiblockDeclaration): KernelDeclarationProjection | null {
  if (decl.multiblockCount !== 1) return null
  return {
    id: decl.id,
    displayName: decl.displayName,
    declaration: decl as unknown as KernelDeclarationProjection['declaration'],
    declRaw: Object.freeze({}),
    blockPalette: decl.blockPalette,
    assets: Object.freeze({}) as KernelDeclarationProjection['assets'],
    scenes: decl.scenes.map((s) => ({
      index: s.index,
      variant: s.variant,
      runstate: s.runstate,
      stepIndex: s.stepIndex,
      rules: s.rules,
      ...(s.label === undefined ? {} : { label: s.label }),
      ...(s.durationMs === undefined ? {} : { durationMs: s.durationMs }),
    })),
    schemaVersion: decl.schemaVersion,
    multiblockCount: decl.multiblockCount,
  }
}

export function createRecoverySession(options: CreateRecoverySessionOptions): RecoverySessionPort {
  const host = options.host
  const port: RecoveryStorePort = recoveryStorePort({
    storage: options.storage === undefined ? undefined : options.storage,
    id: 'recovery-local',
  })
  const now = options.now ?? (() => Date.now())
  const debounceMs = options.debounceMs ?? RECOVERY_WRITE_DEBOUNCE_MS
  const identity: InstanceIdentity = instanceIdentity(RECOVERY_SCOPE, host.instanceId)
  const diagnostics = host.diagnostics

  const candidate = ref<RecoveryCandidateView | null>(null)
  const corruptCount = ref(0)
  const corruptKeys: string[] = []
  const reportedDetected = new Set<string>()
  const reportedCorrupt = new Set<string>()

  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  // ── 写入失败：三分 + 序列化失败，各自可见（S0-B 承接 A31-3 的产品化）────────

  function failureOfStorage(
    status: 'quotaExceeded' | 'unavailable' | 'failed',
    detail: string,
    code?: string,
    reason?: string,
  ): void {
    const params: Record<string, string | number | boolean> = { cause: status }
    if (detail !== '') params.detail = detail
    if (code !== undefined) params.code = code
    if (reason !== undefined) params.reason = reason
    diagnostics.record({ code: 'recovery.writeFailed', channel: 'recovery', params, correlation: {} })
    const reasonText =
      reason === 'noStorage'
        ? '宿主没有键值存储'
        : reason === 'blocked'
          ? '宿主拒绝存储访问'
          : reason === 'security'
            ? '存储访问受安全策略限制'
            : '宿主未提供存储'
    if (status === 'quotaExceeded') {
      host.live(
        '恢复副本写入失败：存储配额不足' + (detail === '' ? '' : '（' + detail + '）') + '。手动保存不受影响；可清理站点存储后继续编辑。',
        'error',
        'recovery-write-failed',
      )
    } else if (status === 'unavailable') {
      host.live('恢复副本不可用：' + reasonText + '。本环境不提供持久恢复副本，手动保存不受影响。', 'warn', 'recovery-write-failed')
    } else {
      host.live('恢复副本写入失败' + (code === undefined ? '' : '（' + code + '）') + '：手动保存不受影响。', 'error', 'recovery-write-failed')
    }
  }

  function failureOfSerialization(detail: string, documentId: string): void {
    diagnostics.record({
      code: 'recovery.writeFailed',
      channel: 'recovery',
      params: { cause: 'serialization', detail, documentId },
      correlation: {},
    })
    host.live('恢复副本未能生成（来源快照自相矛盾或无法序列化）：当前内容与手动保存都不受影响。', 'error', 'recovery-write-failed')
  }

  function readPreviousSlots(baseKey: string): (string | null)[] {
    const out: (string | null)[] = []
    for (let rank = 0; rank < RECOVERY_RETENTION_LIMIT; rank += 1) {
      const got = port.get(recoveryRetainedKey(baseKey, rank))
      out.push(got.status === 'ok' ? got.value : null)
    }
    return out
  }

  /** 立即写一份副本（防抖到期 / pagehide 冲刷）。失败可见，但绝不抛给编辑路径。 */
  function writeNow(): void {
    if (disposed) return
    const current = host.captureCurrent()
    if (current === null || !current.dirty) return

    let plan
    try {
      plan = planRecoveryWrite({
        snapshot: current.snapshot,
        identity,
        writtenAt: now(),
        assets: current.assets,
      })
    } catch (e) {
      failureOfSerialization(e instanceof Error ? e.message : String(e), current.documentId)
      return
    }
    if (!plan.ok) {
      const err = plan.error
      failureOfSerialization(
        typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : String(err),
        current.documentId,
      )
      return
    }
    const baseKey = plan.value.key
    // 存储表示 = 压缩 + base64（见 adapters/recoveryStore 的 12:1 实测）。
    // 保留策略比较的也是**存储表示**：同一内容压缩后逐字相同 ⇒ 不重复写。
    let encoded: string
    try {
      encoded = encodeRecoveryValue(plan.value.json)
    } catch (e) {
      failureOfSerialization(e instanceof Error ? e.message : String(e), current.documentId)
      return
    }
    const retention = planRecoveryRetention(baseKey, readPreviousSlots(baseKey), encoded)
    if (retention.unchanged) return

    // 顺序：最新先落地（配额不足时最坏结果是历史变短，而不是最新副本丢失）。
    let outcome = writeRecoveryCopy(port, Object.freeze({ ...plan.value, json: encoded }))
    if (outcome.status === 'quotaExceeded') {
      // 让出历史槽再试一次："3 份"是上限不是义务，用户最需要的是**最新**副本。
      removeKeys(recoveryRetainedKeys(baseKey).slice(1))
      outcome = writeRecoveryCopy(port, Object.freeze({ ...plan.value, json: encoded }))
    }
    if (outcome.status === 'quotaExceeded') return failureOfStorage('quotaExceeded', outcome.detail)
    if (outcome.status === 'unavailable') return failureOfStorage('unavailable', '', undefined, outcome.reason)
    if (outcome.status === 'failed') return failureOfStorage('failed', outcome.detail, outcome.code)
    // 历史槽是 best-effort：最新副本已安全落地；历史写失败只让份数变短，
    // 不再连发用户可见失败（否则一次配额不足会连发 3 条同样的话）。
    for (const write of retention.writes.slice(1)) {
      const ack = port.set(write.key, write.raw)
      if (ack.status !== 'ok') break
    }
  }

  function contentSettled(): void {
    if (disposed) return
    cancelTimer()
    timer = setTimeout(() => {
      timer = null
      writeNow()
    }, debounceMs)
  }

  function onPageHide(): void {
    // 关闭/刷新：**同步**冲刷（localStorage 的写入在卸载中是同步完成的）。
    // 防抖窗口因此不是"最后一道保险"：正常关闭不会丢掉窗口内的编辑。
    cancelTimer()
    writeNow()
  }

  // ── 检测（启动/刷新后的 list + validate）──────────────────────────────────

  function emitCorruptOnce(entry: CorruptEntry): void {
    const signature = entry.key + '|' + reasonsTextOf(entry.reasons)
    if (reportedCorrupt.has(signature)) return
    reportedCorrupt.add(signature)
    diagnostics.record({
      code: 'recovery.corrupt',
      channel: 'recovery',
      params: {
        key: entry.key,
        documentId: entry.documentId,
        reasons: reasonsTextOf(entry.reasons),
        reasonCount: entry.reasons.length,
      },
      correlation: {},
    })
  }

  function emitDetectedOnce(entry: ScannedEntry): void {
    const signature = entry.key + '|' + entry.payload.writtenAt
    if (reportedDetected.has(signature)) return
    reportedDetected.add(signature)
    diagnostics.record({
      code: 'recovery.detected',
      channel: 'recovery',
      params: {
        key: entry.key,
        documentId: entry.payload.documentId,
        documentVersion: entry.payload.documentVersion,
        contentVersion: entry.payload.contentVersion,
        writtenAt: entry.payload.writtenAt,
      },
      correlation: { documentVersion: entry.payload.documentVersion },
    })
  }

  function announce(): void {
    const view = candidate.value
    if (view !== null) {
      const name = view.label === '' ? '' : view.label + ' · '
      host.live(
        '检测到未采纳的恢复副本（' + name + '写入于 ' + isoOf(view.writtenAt) + '）。采纳会恢复内容但仍为未保存；放弃会删除该副本。',
        'warn',
        'recovery-available',
      )
      return
    }
    if (corruptCount.value > 0) {
      host.live(
        '检测到 ' + corruptCount.value + ' 份损坏的恢复副本：当前内容未受影响，副本未被自动删除，可显式放弃。',
        'warn',
        'recovery-corrupt',
      )
    }
  }

  function reportListFailure(outcome: ReturnType<typeof listRecoveryKeys>): void {
    if (outcome.status === 'quotaExceeded') failureOfStorage('quotaExceeded', outcome.detail)
    else if (outcome.status === 'unavailable') failureOfStorage('unavailable', '', undefined, outcome.reason)
    else if (outcome.status === 'failed') failureOfStorage('failed', outcome.detail, outcome.code)
  }

  function scan(): void {
    if (disposed) return
    const listed = listRecoveryKeys(port, identity)
    if (listed.status !== 'ok') {
      reportListFailure(listed)
      return
    }
    const validByBase = new Map<string, ScannedEntry[]>()
    const corrupt: CorruptEntry[] = []
    for (const key of listed.keys) {
      const parsed = parseRecoveryStoreKey(key)
      if (parsed === null) continue
      const baseKey = recoveryBaseKeyOf(key)
      const parsedBase = parseRecoveryStoreKey(baseKey)
      const keyDocumentId = parsedBase?.documentId ?? parsed.documentId
      const read = readRecoveryCopy(port, key)
      if (read.status === 'missing') continue
      if (read.status !== 'ok') {
        if (read.status === 'unavailable') failureOfStorage('unavailable', '', undefined, read.reason)
        else if (read.status === 'failed') failureOfStorage('failed', read.detail, read.code)
        continue
      }
      // 存储表示 → JSON 文本（非本编码原样交给校验；见 adapters/recoveryStore）。
      const raw = decodeRecoveryValue(read.raw)
      const origin = readRecoveryOrigin(raw)
      const expectedDocumentId =
        origin !== null && typeof origin.documentId === 'string' && origin.documentId !== ''
          ? origin.documentId
          : keyDocumentId
      const validation = validateRecoveryCopy({ raw, expectedDocumentId })
      if (!validation.ok) {
        corrupt.push(Object.freeze({ key, documentId: keyDocumentId, reasons: validation.reasons }))
        continue
      }
      const entry: ScannedEntry = Object.freeze({ key, baseKey, rank: recoveryRankOf(key), payload: validation.payload })
      const bucket = validByBase.get(baseKey)
      if (bucket === undefined) validByBase.set(baseKey, [entry])
      else bucket.push(entry)
    }

    corruptKeys.length = 0
    for (const c of corrupt) corruptKeys.push(c.key)
    corruptCount.value = corrupt.length
    for (const c of corrupt) emitCorruptOnce(c)

    let best: ScannedEntry | null = null
    for (const entries of validByBase.values()) {
      entries.sort((a, b) => (a.rank === b.rank ? b.payload.writtenAt - a.payload.writtenAt : a.rank - b.rank))
      const pick = entries[0] ?? null
      if (pick === null) continue
      if (best === null || pick.payload.writtenAt > best.payload.writtenAt) best = pick
    }
    candidate.value =
      best === null
        ? null
        : Object.freeze({
            key: best.key,
            documentId: best.payload.documentId,
            writtenAt: best.payload.writtenAt,
            documentVersion: best.payload.documentVersion,
            contentVersion: best.payload.contentVersion,
            label: labelOf(best.payload),
          })
    if (best !== null) emitDetectedOnce(best)
    announce()
  }

  // ── 采纳（显式动作；不调保存结算、不推基线）────────────────────────────────

  function applyPayload(
    payload: RecoveryPayload,
  ): { readonly ok: true; readonly changed: boolean } | { readonly ok: false; readonly code: string } {
    // 种子文档：空内容基线（"正式保存基线不存在"）。adoptRecoveryCopy 只换内容，
    // 基线/序号逐位带过 —— 这正是 §9:299「采纳不推进正式保存基线」的结构落点。
    const seed = createDocument(payload.documentId, { sceneId: payload.scene.id })
    const applied = adoptRecoveryCopy(
      seed,
      Object.freeze({
        decision: 'adopt' as const,
        payload,
        origin: Object.freeze({
          scope: payload.scope,
          instanceId: payload.instanceId,
          documentId: payload.documentId,
          documentVersion: payload.documentVersion,
          contentVersion: payload.contentVersion,
          writtenAt: payload.writtenAt,
          schemaVersion: payload.schemaVersion,
        }),
      }),
    )
    if (applied.status !== 'adopted') return { ok: false, code: 'adopt-rejected' }
    const restored = applied.doc
    const declaration = declarationProjectionOf(payload.content.multiblock)
    // 旧格式载体：**不带**注解行（宿主装载后会经 `syncLegacyFromKernel` 把
    // 全保真注解/逐格说明/网格投影过去 —— 那条路是生产上每次编辑都走的同一条）。
    const projected = projectToRuntimeDocument({
      scene: restored.scene,
      content: restored.content,
      documentId: restored.id,
      ...(declaration === null ? {} : { multiblockDeclaration: declaration }),
    })
    if (projected.diagnostics.some((d) => d.code === 'unsupportedObjectType' && d.path === '$')) {
      // 投影读不回 = 实现缺陷（不是业务失败）：**不改**当前有效内容。
      return { ok: false, code: 'projection-unreadable' }
    }
    const installed = host.installRestored({
      payload,
      restored,
      content: restored.content,
      projected: projected.doc,
      declaration,
    })
    if (!installed) return { ok: false, code: 'install-failed' }
    return { ok: true, changed: applied.changed }
  }

  function adopt(): RecoveryAdoptOutcome {
    if (disposed) return { status: 'failed', code: 'disposed' }
    if (candidate.value === null) scan()
    const view = candidate.value
    if (view === null) return { status: 'none' }
    const read = readRecoveryCopy(port, view.key)
    if (read.status !== 'ok') {
      diagnostics.record({
        code: 'recovery.adoptFailed',
        channel: 'recovery',
        params: { key: view.key, documentId: view.documentId, reason: read.status },
        correlation: {},
      })
      host.live('采纳恢复副本失败：读取存储时出错；当前内容未受影响。', 'error', 'recovery-adopt-failed')
      return { status: 'failed', code: 'read-' + read.status }
    }
    const decision = decideRecoveryAdoption({
      raw: decodeRecoveryValue(read.raw),
      expectedDocumentId: view.documentId,
      expectedInstanceId: identity.instanceId,
    })
    if (decision.decision === 'reject') {
      emitCorruptOnce(Object.freeze({ key: view.key, documentId: view.documentId, reasons: decision.reasons }))
      // 检测之后才变坏的副本（外部输入变化 / 别的实例写了这个键）：重新扫描把状态
      // 收敛成「这就是一份坏副本」（候选清空、损坏数 +1），而不是留一个点了必失败的候选。
      candidate.value = null
      scan()
      return { status: 'rejected', reasons: decision.reasons }
    }
    const applied = applyPayload(decision.payload)
    if (!applied.ok) {
      diagnostics.record({
        code: 'recovery.adoptFailed',
        channel: 'recovery',
        params: { key: view.key, documentId: view.documentId, reason: applied.code },
        correlation: { documentVersion: decision.payload.documentVersion },
      })
      host.live('采纳恢复副本失败（' + applied.code + '）：当前内容未被改动。', 'error', 'recovery-adopt-failed')
      return { status: 'failed', code: applied.code }
    }
    candidate.value = null
    diagnostics.record({
      code: 'recovery.adopted',
      channel: 'recovery',
      params: {
        key: view.key,
        documentId: decision.payload.documentId,
        documentVersion: decision.payload.documentVersion,
        contentVersion: decision.payload.contentVersion,
        changed: applied.changed,
        // adoptRecoveryCopy 只换内容；种子文档的基线逐位带过（结构上不可能推进）。
        baselinePreserved: true,
      },
      correlation: { documentVersion: decision.payload.documentVersion },
    })
    host.live('已采纳恢复副本：内容已恢复，但仍为未保存状态（未推进正式保存基线）；请显式保存。', 'info', 'recovery-adopted')
    return { status: 'adopted', documentId: decision.payload.documentId, changed: applied.changed }
  }

  // ── 放弃（用户显式；或正式保存后作废）──────────────────────────────────────

  function removeKeys(keys: readonly string[]): number {
    let removed = 0
    for (const key of keys) {
      const ack = removeRecoveryCopy(port, key)
      if (ack.status === 'ok') removed += 1
      else if (ack.status === 'quotaExceeded') failureOfStorage('quotaExceeded', ack.detail)
      else if (ack.status === 'unavailable') failureOfStorage('unavailable', '', undefined, ack.reason)
      else failureOfStorage('failed', ack.detail, ack.code)
    }
    return removed
  }

  function discard(): RecoveryDiscardOutcome {
    if (disposed) return { status: 'none' }
    const view = candidate.value
    if (view !== null) {
      const base = recoveryBaseKeyOf(view.key)
      const removed = removeKeys(recoveryRetainedKeys(base))
      candidate.value = null
      corruptCount.value = 0
      corruptKeys.length = 0
      diagnostics.record({
        code: 'recovery.discarded',
        channel: 'recovery',
        params: { key: view.key, documentId: view.documentId, removed, reason: 'user' },
        correlation: {},
      })
      host.live('已放弃该恢复副本（删除 ' + removed + ' 份）；当前内容未受影响。', 'info', 'recovery-discarded')
      return { status: 'discarded', removed }
    }
    if (corruptKeys.length > 0) {
      const count = corruptKeys.length
      const removed = removeKeys([...corruptKeys])
      corruptKeys.length = 0
      corruptCount.value = 0
      diagnostics.record({
        code: 'recovery.discarded',
        channel: 'recovery',
        params: { removed, reason: 'corrupt', count },
        correlation: {},
      })
      host.live('已放弃 ' + count + ' 份损坏的恢复副本；当前内容未受影响。', 'info', 'recovery-discarded')
      return { status: 'discarded', removed }
    }
    return { status: 'none' }
  }

  function formalSaveCommitted(): void {
    if (disposed) return
    cancelTimer()
    const documentId = host.currentDocumentId()
    if (documentId === null) return
    const key = recoveryStoreKey(identity, documentId)
    if (!key.ok) return
    const removed = removeKeys(recoveryRetainedKeys(key.value))
    if (removed === 0) return
    if (candidate.value !== null && candidate.value.documentId === documentId) candidate.value = null
    diagnostics.record({
      code: 'recovery.discarded',
      channel: 'recovery',
      params: { documentId, removed, reason: 'formal-save' },
      correlation: {},
    })
    host.live('正式保存已完成：该文档的恢复副本已作废（恢复副本不再提示）。', 'info', 'recovery-discarded')
  }

  // ── 装配：启动扫描 + 监听 ─────────────────────────────────────────────────

  scan()
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide)

  return {
    candidate,
    corruptCount,
    contentSettled,
    formalSaveCommitted,
    adopt,
    discard,
    dispose(): void {
      disposed = true
      cancelTimer()
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide)
    },
  }
}
