/**
 * A31 `recovery-storage` —— 恢复副本政策与存储适配（#249 §14 A31；§19.5；#260）。
 *
 * ## 六条判据与各自的负对照
 *
 * | # | 判据（#249 §14 A31 原文） | 本文件的用例 | 负对照（**证伪对照实现**，不是让测试自己抛错） |
 * |---|---|---|---|
 * | 1 | 恢复明确可选 | `模拟重启…恢复是显式可选的` | 对照实现 C「读到就自动采纳」——它确实会改掉当前内容 |
 * | 2 | 正式保存基线不被恢复写覆盖 | `写恢复副本前后…基线指纹不变` | 对照实现 D「把恢复写当成保存完成」，基线确实被推进 |
 * | 3 | 故障可见且手动保存可用 | `配额不足/不可用可见`、`存储故障下手动保存仍可用` | 对照实现 E「catch 后返回 ok」，把失败报成成功 |
 * | 4 | 其他实例的恢复副本不被覆盖 | `多标签：两个实例身份…互不覆盖` | 对照实现 F「单键无实例段」，第二写确实覆盖第一写 |
 * | 5 | 坏副本不替换有效内容 | `坏副本四类原因…内容原样保留` | 对照实现 G「不校验就采纳」，四类坏副本里有两类**静默破坏内容** |
 * | 6 | 半次拖动不恢复 | `带暂存交互…载荷里没有暂存内容` | 对照实现 H「把暂存并进场景」，恢复出 `x = 5` 的半次拖动 |
 *
 * ## 负对照的写法（#249 §14「不能只令测试主动抛错」）
 *
 * 每条负对照都是**一段可运行的对照实现**（文件底部 `naive*` 系列），测试断言它的
 * **实际坏结果**（内容被改、基线被推进、失败被报成成功），而不是断言"它会抛异常"。
 * 只有 `notJson` 那条是例外的**补充**证据，它证明"坏 JSON"这一类在对照实现下
 * 连结构化原因都给不出。
 *
 * ## 时钟
 *
 * 全部时间戳由 `CLOCK` 常量**注入**（`writtenAt` 是 `captureRecoveryCopy` 的显式输入）。
 * 本文件不含 `Date.now`/`performance.now`/`setTimeout`/`requestAnimationFrame`
 * —— 与 #249 §2.1 及 `tests/architecture/presentation-purity.test.ts` 的闸门口径一致。
 */

import { describe, expect, it } from 'vitest'
import { Editor } from '@/runtime/execution'
import {
  RECOVERY_ARTIFACT,
  adoptRecoveryCopy,
  artifactKindOfKey,
  baselineFingerprint,
  captureRecoveryCopy,
  contentFingerprint,
  decideRecoveryAdoption,
  describeRecoveryCandidate,
  instanceIdentity,
  listRecoveryKeys,
  parseRecoveryStoreKey,
  parseSaveStoreKey,
  planRecoveryWrite,
  readRecoveryCopy,
  readRecoveryOrigin,
  recoverySourceSnapshot,
  recoveryStoreKey,
  removeRecoveryCopy,
  sameRestoredVersion,
  saveStoreKey,
  serializeRecoveryCopy,
  stagedContentMarkers,
  writeRecoveryCopy,
  type InstanceIdentity,
  type RecoveryPayload,
  type RecoveryStorePort,
  type RecoveryValidationInput,
} from '@/application/recovery'
import { unwrap } from '@/domain/errors'
import {
  addBlockObject,
  createDocument,
  isDirty,
  withContent,
  withScene,
  type Document,
} from '@/domain/document'
import type { EditContext } from '@/domain/editing'
import { findObject, type Scene } from '@/domain/scene'
import type { AnimationState } from '@/domain/animation'
import { createMemoryStoragePort, quotaFailureOn, unavailableFailureOn } from '@/adapters/storage/memory'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具（时间**注入**；随机与墙钟一概不用）
// ─────────────────────────────────────────────────────────────────────────────

/** 注入时钟的取值（测试用固定时刻；生产由宿主注入）。 */
const CLOCK = 1_700_000_000_000

const SCOPE = 'workbench' as const

const INSTANCE_A: InstanceIdentity = instanceIdentity(SCOPE, 'tab-a')
const INSTANCE_B: InstanceIdentity = instanceIdentity(SCOPE, 'tab-b')

/** 一份"已提交内容"：文档 + 一个方块对象（变换在原点）。 */
function committedDoc(): Document {
  const doc = createDocument('doc-1')
  const scene = addBlockObject(doc.scene, { objectId: 'o1', dataId: 'd1' })
  if (scene === null) throw new Error('fixture: addBlockObject failed')
  return withScene(doc, scene).doc
}

/** 一次完整的"落副本"（政策 + 内存端口）。 */
function writeOnce(port: RecoveryStorePort, doc: Document, identity: InstanceIdentity, writtenAt = CLOCK) {
  const plan = unwrap(planRecoveryWrite({ snapshot: recoverySourceSnapshot(doc), identity, writtenAt }))
  return { plan, outcome: writeRecoveryCopy(port, plan) }
}

/** 校验输入（从存储读回 + 当前文档身份）。 */
function validationOf(raw: string, expectedDocumentId = 'doc-1', extra: Partial<RecoveryValidationInput> = {}): RecoveryValidationInput {
  return { raw, expectedDocumentId, ...extra }
}

/** 取一份真实副本的载荷（夹具用；失败的夹具会抛，属测试基础设施而非判据）。 */
function payloadOf(port: RecoveryStorePort, key: string): RecoveryPayload {
  const read = readRecoveryCopy(port, key)
  if (read.status !== 'ok') throw new Error(`fixture: read recovery copy failed: ${read.status}`)
  const decision = decideRecoveryAdoption(validationOf(read.raw))
  if (decision.decision !== 'adopt') throw new Error('fixture: recovery copy did not validate')
  return decision.payload
}

/** 打开一个内核编辑器（真实命令路径，不是手搓状态）。 */
function openEditor(): Editor {
  const e = new Editor()
  e.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
  e.drain()
  return e
}

function docOf(e: Editor): Document {
  return e.snapshot().docs['doc-1']
}

// ─────────────────────────────────────────────────────────────────────────────
// 判据 1：模拟重启 → 恢复**明确可选** → 采纳后内容回到已提交状态
// ─────────────────────────────────────────────────────────────────────────────

describe('A31-1 模拟重启：恢复**明确可选**（用户选择），采纳后内容回到已提交状态', () => {
  it('写副本 →（模拟重启）新实例读回 → `adoptable` 与来源可见 → **未采纳前当前内容不变** → 显式采纳后内容回来', () => {
    // 第一个实例：编辑到"有未保存修改"，落一份恢复副本。
    const before = openEditor()
    before.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' })
    before.drain()
    const dirtyDoc = docOf(before)
    expect(isDirty(dirtyDoc), '夹具前提：重启前确实有未保存修改').toBe(true)

    const port = createMemoryStoragePort()
    const key = unwrap(recoveryStoreKey(INSTANCE_A, 'doc-1'))
    const { outcome } = writeOnce(port, dirtyDoc, INSTANCE_A)
    expect(outcome.status).toBe('ok')
    const committedDigest = contentFingerprint(dirtyDoc.scene, dirtyDoc.animation)

    // 模拟重启：**同一个存储**（localStorage 在刷新后仍在），**新的**编辑器与文档实例。
    const after = openEditor()
    const currentDoc = docOf(after)
    expect(Object.keys(currentDoc.scene.objects), '重启后的新文档是空的（内容恢复正是为此）').toHaveLength(0)

    // 读回 + 展示来源/版本 —— 这一步**只**描述，不采纳。
    const read = readRecoveryCopy(port, key)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    const candidate = describeRecoveryCandidate(validationOf(read.raw))
    expect(candidate.artifact, '显式标记：这是恢复副本，不是正式保存').toBe(RECOVERY_ARTIFACT)
    expect(candidate.adoptable).toBe(true)
    expect(candidate.origin?.documentId).toBe('doc-1')
    expect(candidate.origin?.instanceId).toBe('tab-a')
    expect(candidate.origin?.writtenAt, '写入时刻由注入时钟给出').toBe(CLOCK)

    // **明确可选**：读回与描述都不得改动当前内容。
    expect(Object.keys(docOf(after).scene.objects), '未采纳前当前内容必须不变').toHaveLength(0)

    // 用户选择"采纳"。
    const adoption = decideRecoveryAdoption(validationOf(read.raw))
    const applied = adoptRecoveryCopy(currentDoc, adoption)
    expect(applied.status).toBe('adopted')
    if (applied.status !== 'adopted') return
    expect(applied.changed).toBe(true)
    expect(Object.keys(applied.doc.scene.objects), '采纳后内容回到已提交状态').toHaveLength(1)
    expect(sameRestoredVersion(applied.doc, payloadOf(port, key)), '版本与副本记录一致').toBe(true)
    expect(contentFingerprint(applied.doc.scene, applied.doc.animation)).toBe(committedDigest)
    // 采纳是恢复副本动作，**不是**保存：内容仍未保存过。
    expect(isDirty(applied.doc), '恢复副本不表示已正式保存').toBe(true)
  })

  it('**负对照**：对照实现 C「读到副本就自动采纳」确实会改掉当前内容（故"明确可选"不是空话）', () => {
    const port = createMemoryStoragePort()
    const dirtyDoc = committedDoc()
    writeOnce(port, dirtyDoc, INSTANCE_A)
    const key = unwrap(recoveryStoreKey(INSTANCE_A, 'doc-1'))

    const freshDoc = createDocument('doc-1')
    expect(Object.keys(freshDoc.scene.objects)).toHaveLength(0)

    // 对照实现 C：读 → 直接替换，**没有**用户选择这一步。
    const naive = autoAdoptOnRead(port, key, freshDoc)
    expect(Object.keys(naive.scene.objects), '对照实现在读到副本的当刻就把当前内容改掉了').toHaveLength(1)

    // 真实路径：同样的"读回"，当前内容纹丝不动（对照见上一条用例的显式断言）。
    const read = readRecoveryCopy(port, key)
    expect(read.status).toBe('ok')
    if (read.status === 'ok') {
      const described = describeRecoveryCandidate(validationOf(read.raw))
      expect(described.adoptable).toBe(true)
    }
    expect(Object.keys(freshDoc.scene.objects), '真实路径读回不产生任何内容变化').toHaveLength(0)
  })

  it('写入时刻来自**注入**的时钟（换一个注入值 ⇒ 载荷里的 `writtenAt` 跟着变）', () => {
    const port = createMemoryStoragePort()
    const doc = committedDoc()
    const key = unwrap(recoveryStoreKey(INSTANCE_A, 'doc-1'))
    writeOnce(port, doc, INSTANCE_A, CLOCK)
    expect(payloadOf(port, key).writtenAt).toBe(CLOCK)
    writeOnce(port, doc, INSTANCE_A, CLOCK + 5_000)
    expect(payloadOf(port, key).writtenAt, '不同注入时刻给出不同时间戳（不是内部读墙钟）').toBe(CLOCK + 5_000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 判据 2：写恢复副本**不改**正式保存基线
// ─────────────────────────────────────────────────────────────────────────────

describe('A31-2 正式保存基线不被恢复写覆盖', () => {
  it('`isDirty`/`saveBaseline`/`savedSequence` 在写恢复副本前后**逐位不变**（正断言）', () => {
    const e = openEditor()
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block' })
    e.drain()
    const before = docOf(e)
    const fingerprintBefore = baselineFingerprint(before)
    const baselineContentBefore = before.saveBaseline.contentVersion
    const savedSeqBefore = before.savedSequence
    expect(isDirty(before)).toBe(true)

    const port = createMemoryStoragePort()
    const { outcome } = writeOnce(port, before, INSTANCE_A)
    expect(outcome.status).toBe('ok')

    const after = docOf(e)
    expect(baselineFingerprint(after), '基线指纹必须与写出前相同').toBe(fingerprintBefore)
    expect(after.saveBaseline.contentVersion, '`saveBaseline` 不得被恢复写推进').toBe(baselineContentBefore)
    expect(after.savedSequence, '`savedSequence` 不得被恢复写推进').toBe(savedSeqBefore)
    expect(isDirty(after), '写恢复副本不改变脏状态').toBe(true)

    // 结构证据：写结局里**没有**任何表示"已保存/基线已变"的字段。
    const keys = Object.keys(outcome).sort()
    expect(keys).toEqual(['artifact', 'key', 'serializedLength', 'status'])
    for (const forbidden of ['saved', 'baselineChanged', 'baseline', 'document', 'wiki', 'uploaded', 'committed']) {
      expect(keys, `写恢复副本的结局不得带 \`${forbidden}\`（否则"恢复写成功"可被读成"正式保存成功"）`).not.toContain(forbidden)
    }
  })

  it('已保存（不脏）的文档：写恢复副本**不**把它变脏，也不改基线', () => {
    const e = openEditor()
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block' })
    e.drain()
    // 走**真实**的正式保存路径（save → saveCompleted committed）。
    const save = e.submit({ kind: 'save', contextId: 'ctx-1' })
    e.drain()
    expect(e.settlement(save)?.status).toBe('applied')
    const inFlight = e.snapshot().saveLedgers['doc-1'].inFlight
    expect(inFlight).not.toBeNull()
    if (inFlight === null) return
    e.submit({
      kind: 'saveCompleted',
      documentId: 'doc-1',
      sequence: inFlight.sequence,
      bindingGeneration: 0,
      outcome: { kind: 'committed' },
    })
    e.drain()
    const saved = docOf(e)
    expect(isDirty(saved), '正式保存完成后应当干净').toBe(false)
    const fingerprintBefore = baselineFingerprint(saved)

    const port = createMemoryStoragePort()
    expect(writeOnce(port, saved, INSTANCE_A).outcome.status).toBe('ok')

    const after = docOf(e)
    expect(baselineFingerprint(after)).toBe(fingerprintBefore)
    expect(isDirty(after), '写恢复副本既不变脏也不变干净').toBe(false)
  })

  it('**负对照**：对照实现 D「把恢复写当成保存完成」确实推进了基线（故隔离是必要的）', () => {
    const doc = committedDoc()
    const ledger = { nextSequence: 1, bindingGeneration: 0 }
    const started = naiveBeginSave(doc, ledger)
    // 对照实现 D：恢复写成功 ⇒ 当作 `committed` 完成事件回写基线。
    const naive = naiveCompleteAsCommitted(doc, started)
    expect(
      naive.saveBaseline.contentVersion,
      '对照实现让基线等于"被恢复写的那份内容"，即恢复写冒充了正式保存',
    ).toBe(doc.version.contentVersion)
    expect(naive.savedSequence, '对照实现推进了保存序号').toBe(1)
    expect(isDirty(naive), '对照实现把文档变成"已保存"').toBe(false)

    // 真实路径：同一份内容写恢复副本，基线与脏状态都不动。
    const port = createMemoryStoragePort()
    expect(writeOnce(port, doc, INSTANCE_A).outcome.status).toBe('ok')
    expect(baselineFingerprint(doc)).toBe(baselineFingerprint(committedDoc()))
    expect(isDirty(doc)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 判据 3：存储故障/配额可见，且手动保存仍可用
// ─────────────────────────────────────────────────────────────────────────────

describe('A31-3 存储失败**可见**（配额/不可用/失败三分），且手动保存不受影响', () => {
  it('配额不足：写副本返回 `quotaExceeded` 判别式（带上键与原因，不是 `ok`、也不是异常）', () => {
    const doc = committedDoc()
    const key = unwrap(recoveryStoreKey(INSTANCE_A, 'doc-1'))
    const port = createMemoryStoragePort({ failures: [quotaFailureOn(key, 'QuotaExceededError')] })
    const { outcome } = writeOnce(port, doc, INSTANCE_A)
    expect(outcome.status).toBe('quotaExceeded')
    if (outcome.status !== 'quotaExceeded') return
    expect(outcome.artifact).toBe(RECOVERY_ARTIFACT)
    expect(outcome.key).toBe(key)
    expect(outcome.detail).toBe('QuotaExceededError')
  })

  it('存储不可用：`noStorage`/被屏蔽都给出 `unavailable`（且**不**降级为"键不存在"）', () => {
    const doc = committedDoc()
    const key = unwrap(recoveryStoreKey(INSTANCE_A, 'doc-1'))
    const blocked = createMemoryStoragePort({ blockedKeys: [key] })
    const blockedOutcome = writeOnce(blocked, doc, INSTANCE_A).outcome
    expect(blockedOutcome.status).toBe('unavailable')
    if (blockedOutcome.status === 'unavailable') expect(blockedOutcome.reason).toBe('blocked')

    const unavailable = createMemoryStoragePort({ failures: [unavailableFailureOn(key, 'noStorage')] })
    const outcome = writeOnce(unavailable, doc, INSTANCE_A).outcome
    expect(outcome.status).toBe('unavailable')
    if (outcome.status === 'unavailable') expect(outcome.reason).toBe('noStorage')
  })

  it('`missing`（本来没有副本）与 `failed`（读坏了）**分开**，两者都不冒充"成功"', () => {
    const key = unwrap(recoveryStoreKey(INSTANCE_A, 'doc-1'))
    const empty = createMemoryStoragePort()
    expect(readRecoveryCopy(empty, key).status, '没写过 ⇒ missing').toBe('missing')

    const broken = createMemoryStoragePort({ failures: [{ key, failure: { status: 'failed', code: 'IOError', detail: 'injected' } }] })
    const read = readRecoveryCopy(broken, key)
    expect(read.status).toBe('failed')
    if (read.status === 'failed') expect(read.code).toBe('IOError')
  })

  it('枚举键失败同样可见（不返回空表冒充"没有副本"）', () => {
    const port = createMemoryStoragePort({ failures: [unavailableFailureOn('*', 'security')] })
    const listed = listRecoveryKeys(port, INSTANCE_A)
    expect(listed.status).toBe('unavailable')
    if (listed.status === 'unavailable') expect(listed.reason).toBe('security')
  })

  it('**存储故障下手动保存仍可用**：恢复写失败后，正式保存路径照常推进基线', () => {
    const e = openEditor()
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block' })
    e.drain()
    const doc = docOf(e)
    const key = unwrap(recoveryStoreKey(INSTANCE_A, 'doc-1'))
    const port = createMemoryStoragePort({ failures: [quotaFailureOn(key)] })

    // 恢复副本写失败 —— 且**可见**。
    const failed = writeOnce(port, doc, INSTANCE_A).outcome
    expect(failed.status, '恢复写失败必须可见').toBe('quotaExceeded')
    expect(isDirty(docOf(e)), '恢复写失败不改变脏状态').toBe(true)

    // 手动保存照常工作（#249 §19.5「手动保存仍可工作」）。
    const save = e.submit({ kind: 'save', contextId: 'ctx-1' })
    e.drain()
    expect(e.settlement(save)?.status, '存储故障不得使手动保存不可用').toBe('applied')
    expect(e.snapshot().effects.some((f) => f.kind === 'save'), '保存效果描述照常产生').toBe(true)
    const inFlight = e.snapshot().saveLedgers['doc-1'].inFlight
    expect(inFlight).not.toBeNull()
    if (inFlight === null) return
    e.submit({
      kind: 'saveCompleted',
      documentId: 'doc-1',
      sequence: inFlight.sequence,
      bindingGeneration: 0,
      outcome: { kind: 'committed' },
    })
    e.drain()
    expect(isDirty(docOf(e)), '正式保存成功推进基线 ⇒ 干净').toBe(false)
  })

  it('**负对照**：对照实现 E「catch 后返回 ok」把配额失败报成成功', () => {
    const doc = committedDoc()
    const key = unwrap(recoveryStoreKey(INSTANCE_A, 'doc-1'))
    // 对照实现 E：一个会抛的端口 + 一个吞掉异常、返回"成功"的写入器。
    const throwing: RecoveryStorePort = {
      id: 'throwing',
      get: () => ({ status: 'ok', value: null }),
      set: () => {
        throw new Error('QuotaExceededError: simulated')
      },
      remove: () => ({ status: 'ok' }),
      keys: () => ({ status: 'ok', value: [] }),
    }
    const naive = naiveSwallowingWrite(throwing, key)
    expect(naive.status, '对照实现把失败报成成功 —— 这正是 #249 §19.5 禁止的"catch 后宣称可用"').toBe('ok')
    // 真实路径在同一次故障输入下给出可见失败。
    const real = createMemoryStoragePort({ failures: [quotaFailureOn(key)] })
    expect(writeOnce(real, doc, INSTANCE_A).outcome.status).toBe('quotaExceeded')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 判据 4：多标签 —— 两个实例身份写不同键，互不覆盖
// ─────────────────────────────────────────────────────────────────────────────

describe('A31-4 多标签：恢复副本按键隔离（不同实例身份互不覆盖）', () => {
  it('恢复副本键与正式保存键**不相等**，且各自解析回自己的身份', () => {
    const recoveryKey = unwrap(recoveryStoreKey(INSTANCE_A, 'doc-1'))
    const saveKey = unwrap(saveStoreKey(SCOPE, 'doc-1'))
    expect(recoveryKey).not.toBe(saveKey)

    const parsedRecovery = parseRecoveryStoreKey(recoveryKey)
    expect(parsedRecovery).not.toBeNull()
    expect(parsedRecovery?.artifact).toBe(RECOVERY_ARTIFACT)
    expect(parsedRecovery?.scope).toBe(SCOPE)
    expect(parsedRecovery?.instanceId).toBe('tab-a')
    expect(parsedRecovery?.documentId).toBe('doc-1')

    const parsedSave = parseSaveStoreKey(saveKey)
    expect(parsedSave?.artifact).toBe('formal-save')
    expect(parsedSave?.documentId).toBe('doc-1')

    // 两个方案的解析**互不命中**：恢复副本键在正式保存方案里解析不出东西，反之亦然。
    expect(parseSaveStoreKey(recoveryKey), '恢复副本键不得解析成正式保存键').toBeNull()
    expect(parseRecoveryStoreKey(saveKey), '正式保存键不得解析成恢复副本键').toBeNull()
    expect(artifactKindOfKey(recoveryKey)).toBe(RECOVERY_ARTIFACT)
    expect(artifactKindOfKey(saveKey)).toBe('formal-save')
  })

  it('正式保存键**不含**实例身份（文档级事实跨标签共享），恢复副本键**含**实例身份', () => {
    expect(unwrap(saveStoreKey(SCOPE, 'doc-1'))).toBe(unwrap(saveStoreKey(SCOPE, 'doc-1')))
    const a = unwrap(recoveryStoreKey(INSTANCE_A, 'doc-1'))
    const b = unwrap(recoveryStoreKey(INSTANCE_B, 'doc-1'))
    expect(a, '两个标签页的恢复副本键必须不同（A31 负对照的截断点）').not.toBe(b)
  })

  it('两个实例各写一份：互不覆盖，各自读回自己的内容', () => {
    const port = createMemoryStoragePort()
    // 标签 A 的内容：一个对象 o1；标签 B 的内容：两个对象（o1 + o2）。
    const docA = committedDoc()
    const docB = withScene(docA, addBlockObject(docA.scene, { objectId: 'o2', dataId: 'd2' })!).doc

    const keyA = unwrap(recoveryStoreKey(INSTANCE_A, 'doc-1'))
    const keyB = unwrap(recoveryStoreKey(INSTANCE_B, 'doc-1'))
    expect(writeOnce(port, docA, INSTANCE_A).outcome.status).toBe('ok')
    expect(writeOnce(port, docB, INSTANCE_B).outcome.status).toBe('ok')

    const payloadA = payloadOf(port, keyA)
    const payloadB = payloadOf(port, keyB)
    expect(Object.keys(payloadA.scene.objects), 'A 的副本仍只有 o1（未被 B 覆盖）').toEqual(['o1'])
    expect(Object.keys(payloadB.scene.objects)).toEqual(['o1', 'o2'])
    expect(payloadA.instanceId).toBe('tab-a')
    expect(payloadB.instanceId).toBe('tab-b')

    // 本实例的键列表只含自己的副本（不会因"批量清理"碰到别人）。
    const listed = listRecoveryKeys(port, INSTANCE_A)
    expect(listed.status).toBe('ok')
    if (listed.status === 'ok') expect(listed.keys).toEqual([keyA])
  })

  it('**负对照**：对照实现 F「单键、无实例段」让第二个标签页**无提示**覆盖第一个', () => {
    const port = createMemoryStoragePort()
    const docA = committedDoc()
    const docB = withScene(docA, addBlockObject(docA.scene, { objectId: 'o2', dataId: 'd2' })!).doc

    // 对照实现 F：键里没有实例身份。
    const naiveKey = naiveSharedKey('doc-1')
    expect(port.set(naiveKey, serializeRecoveryCopy(unwrap(planRecoveryWrite({ snapshot: recoverySourceSnapshot(docA), identity: INSTANCE_A, writtenAt: CLOCK })).payload)).status).toBe('ok')
    expect(port.set(naiveKey, serializeRecoveryCopy(unwrap(planRecoveryWrite({ snapshot: recoverySourceSnapshot(docB), identity: INSTANCE_B, writtenAt: CLOCK })).payload)).status).toBe('ok')

    const clobbered = payloadOf(port, naiveKey)
    expect(clobbered.instanceId, '对照实现的唯一键被后写者占据').toBe('tab-b')
    expect(Object.keys(clobbered.scene.objects), 'A 的内容被 B 覆盖且无任何提示').toEqual(['o1', 'o2'])
    // 真实的按实例键方案下，同样的两次写入互不影响（见上一条用例的断言）。
    expect(naiveSharedKey('doc-1')).toBe(naiveSharedKey('doc-1'))
  })

  it('写入前可发现"这个键不是我这一份"：校验接口拒绝实例不符的副本', () => {
    const port = createMemoryStoragePort()
    writeOnce(port, committedDoc(), INSTANCE_B)
    const keyB = unwrap(recoveryStoreKey(INSTANCE_B, 'doc-1'))
    const read = readRecoveryCopy(port, keyB)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    const strict = decideRecoveryAdoption(validationOf(read.raw, 'doc-1', { expectedInstanceId: 'tab-a' }))
    expect(strict.decision).toBe('reject')
    if (strict.decision === 'reject') expect(strict.reasons.map((r) => r.kind)).toContain('instanceIdMismatch')
    // 来源仍然可展示（用户看到"来自 tab-b"后可以选择）。
    expect(readRecoveryOrigin(read.raw)?.instanceId).toBe('tab-b')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 判据 5：坏副本**先校验再采纳**，不替换有效内容
// ─────────────────────────────────────────────────────────────────────────────

describe('A31-5 坏副本先校验再采纳：四类拒绝原因齐全，且当前内容原样保留', () => {
  /** 一份有效载荷 + 一处篡改 ⇒ 原始存储表示。 */
  function tampered(patch: Record<string, unknown>): string {
    const port = createMemoryStoragePort()
    writeOnce(port, committedDoc(), INSTANCE_A)
    const valid = payloadOf(port, unwrap(recoveryStoreKey(INSTANCE_A, 'doc-1')))
    return JSON.stringify({ ...valid, ...patch })
  }

  it('四类坏副本各自给出**结构化**原因（版本 / 形状 / 文档 ID / 摘要）', () => {
    const cases: readonly { readonly name: string; readonly raw: string; readonly kind: string }[] = [
      { name: '版本不符', raw: tampered({ schemaVersion: 999 }), kind: 'schemaVersionMismatch' },
      { name: '形状坏', raw: tampered({ scene: { id: 'broken' } }), kind: 'shapeInvalid' },
      { name: '文档 ID 不符', raw: tampered({ documentId: 'doc-other' }), kind: 'documentIdMismatch' },
      { name: '摘要不符', raw: tampered({ contentVersion: 12345 }), kind: 'digestMismatch' },
      { name: '根本不是 JSON', raw: '{not json', kind: 'notJson' },
      { name: 'artifact 标记不符（把别的制品当恢复副本）', raw: tampered({ artifact: 'formal-save' }), kind: 'artifactMismatch' },
    ]
    for (const c of cases) {
      const decision = decideRecoveryAdoption(validationOf(c.raw))
      expect(decision.decision, `${c.name} 必须被拒绝`).toBe('reject')
      if (decision.decision !== 'reject') continue
      expect(decision.reasons.map((r) => r.kind), `${c.name} 的原因码`).toContain(c.kind)
      expect(decision.keepCurrentContent).toBe(true)
      // 拒绝分支**不携带内容**：类型上就没有 payload/scene/animation 可误用。
      expect(Object.keys(decision).sort()).toEqual(['decision', 'keepCurrentContent', 'reasons'])
    }
  })

  it('拒绝时 `adoptRecoveryCopy` 返回**同一个** Document 对象（引用相等 ⇒ 内容原样保留）', () => {
    const current = committedDoc()
    const beforeDigest = contentFingerprint(current.scene, current.animation)
    for (const raw of [tampered({ schemaVersion: 999 }), tampered({ scene: { id: 'broken' } }), tampered({ documentId: 'doc-other' }), tampered({ contentVersion: 12345 }), '{not json']) {
      const applied = adoptRecoveryCopy(current, decideRecoveryAdoption(validationOf(raw)))
      expect(applied.status).toBe('rejected')
      if (applied.status !== 'rejected') continue
      expect(applied.doc, '必须是同一个 Document 对象（不是"复制了一份等价内容"）').toBe(current)
      expect(applied.contentPreserved).toBe(true)
    }
    expect(contentFingerprint(current.scene, current.animation), '当前内容未被任何坏副本替换').toBe(beforeDigest)
    expect(Object.keys(current.scene.objects)).toEqual(['o1'])
  })

  it('坏副本仍能展示来源（`adoptable: false`，原因齐全；来源字段读不出的部分是 `null`）', () => {
    const described = describeRecoveryCandidate(validationOf(tampered({ contentVersion: 12345 })))
    expect(described.adoptable).toBe(false)
    expect(described.artifact).toBe(RECOVERY_ARTIFACT)
    expect(described.origin?.documentId).toBe('doc-1')
    expect(described.origin?.contentVersion).toBe(12345)
    expect(described.reasons.map((r) => r.kind)).toEqual(['digestMismatch'])

    const unparsable = describeRecoveryCandidate(validationOf('{not json'))
    expect(unparsable.adoptable).toBe(false)
    expect(unparsable.origin, '连 JSON 都不是 ⇒ 来源读不出（`null` 的唯一含义就是"读不出"）').toBeNull()
    expect(unparsable.reasons.map((r) => r.kind)).toEqual(['notJson'])
  })

  it('写入侧也**先校验**：自相矛盾的来源快照（内容与版本不符）被拒绝落盘', () => {
    const doc = committedDoc()
    const merged: Scene = {
      ...doc.scene,
      objects: Object.freeze({
        ...doc.scene.objects,
        o1: Object.freeze({ ...doc.scene.objects['o1'], transform: { ...doc.scene.objects['o1'].transform, position: { x: 5, y: 0, z: 0 } } }),
      }),
    }
    // 把暂存位移并进场景却**沿用旧的版本** ⇒ 摘要不符 ⇒ 显式拒绝。
    const captured = captureRecoveryCopy({
      snapshot: { id: doc.id, scene: merged, animation: doc.animation, version: doc.version },
      identity: INSTANCE_A,
      writtenAt: CLOCK,
    })
    expect(captured.ok).toBe(false)
    if (!captured.ok) {
      expect(captured.error.code).toBe('InvalidValue')
      expect(captured.error.params.reason).toBe('snapshotDigestMismatch')
    }
  })

  it('**负对照**：对照实现 G「不校验就采纳」在四类坏副本里**静默破坏内容**', () => {
    const current = committedDoc()
    const validDigest = contentFingerprint(current.scene, current.animation)

    // G-1：文档 ID 不符 —— 拿**别的文档**的副本覆盖当前内容。
    const otherDoc = withScene(createDocument('doc-other'), addBlockObject(createDocument('doc-other').scene, { objectId: 'x9', dataId: 'd9' })!).doc
    const otherRaw = JSON.stringify({ ...payloadFromDoc(otherDoc), documentId: 'doc-other' })
    const naiveOther = adoptWithoutValidation(current, otherRaw)
    expect(Object.keys(naiveOther.scene.objects), '对照实现用别的文档的内容覆盖了当前文档').toEqual(['x9'])
    expect(contentFingerprint(naiveOther.scene, naiveOther.animation)).not.toBe(validDigest)

    // G-2：摘要不符 —— 载荷**内容**与声明的摘要不符（内容被坏数据替换，摘要字段仍写着原值）。
    // 这正是"坏副本"的真实形态：字段齐全、能 parse、看起来正常，但内容与摘要对不上。
    const port = createMemoryStoragePort()
    const goodDoc = committedDoc()
    writeOnce(port, goodDoc, INSTANCE_A)
    const validPayload = payloadOf(port, unwrap(recoveryStoreKey(INSTANCE_A, 'doc-1')))
    const corrupted: RecoveryPayload = {
      ...validPayload,
      scene: { ...validPayload.scene, objects: Object.freeze({ ...validPayload.scene.objects, o1: Object.freeze({ ...validPayload.scene.objects['o1'], name: 'corrupted' }) }) },
    }
    const staleRaw = JSON.stringify(corrupted)
    // 对照实现 G 在**没有任何提示**的情况下把当前内容换成了坏内容。
    const naiveStale = adoptWithoutValidation(current, staleRaw)
    expect(findObject(naiveStale.scene, 'o1')?.name, '对照实现采纳了内容与摘要不符的坏副本').toBe('corrupted')
    // 真实实现：同一份原始文本被**拒绝**，且当前内容保持原样。
    const realDecision = decideRecoveryAdoption(validationOf(staleRaw))
    expect(realDecision.decision).toBe('reject')
    if (realDecision.decision === 'reject') expect(realDecision.reasons.map((r) => r.kind)).toEqual(['digestMismatch'])
    const realApplied = adoptRecoveryCopy(current, realDecision)
    expect(realApplied.status).toBe('rejected')
    if (realApplied.status === 'rejected') expect(realApplied.doc).toBe(current)
    expect(findObject(current.scene, 'o1')?.name, '真实路径下当前内容未被坏副本替换').not.toBe('corrupted')

    // G-3：形状坏 —— 对照实现造出一个缺少 objects/data 的 `Scene`（后续任何遍历都崩）。
    const naiveShape = adoptWithoutValidation(current, JSON.stringify({ ...validPayload, scene: { id: 'broken' } }))
    expect(Object.keys(naiveShape.scene), '对照实现的"场景"只剩一个 id').toEqual(['id'])
    expect(findObjectThrows(naiveShape.scene), '对照实现把内容换成了不可用的东西').toBe(true)

    // G-4：根本不是 JSON —— 对照实现连结构化原因都给不出（这里如实记录为解析异常）。
    expect(() => adoptWithoutValidation(current, '{not json')).toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 判据 6：**半次拖动不恢复**
// ─────────────────────────────────────────────────────────────────────────────

describe('A31-6 半次拖动不恢复：恢复副本只含已提交内容', () => {
  /** 造一个"拖动中"的编辑器：文档已提交一个对象，上下文里有未提交的暂存位移。 */
  function draggingEditor(): { readonly editor: Editor; readonly ctx: EditContext; readonly doc: Document } {
    const editor = openEditor()
    editor.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' })
    editor.drain()
    const doc = docOf(editor)
    const oid = Object.keys(doc.scene.objects)[0]
    editor.submit({ kind: 'beginInteraction', contextId: 'ctx-1', tool: 'move', targets: [oid] })
    editor.submit({ kind: 'updateInteraction', contextId: 'ctx-1', displacement: { x: 5, y: 0, z: 0 } })
    editor.drain()
    return { editor, ctx: editor.snapshot().contexts['ctx-1'], doc: docOf(editor) }
  }

  it('载荷里**没有** `interaction` 字段；落盘文本里也没有暂存形状；恢复出的是已提交值', () => {
    const { ctx, doc } = draggingEditor()
    const oid = Object.keys(doc.scene.objects)[0]
    // 夹具前提：暂存里确实有"半次拖动"（否则本条判据是空转）。
    expect(ctx.interaction, '夹具前提：上下文里存在未提交的暂存交互').not.toBeNull()
    expect(ctx.interaction?.overrides[oid]?.position.x, '暂存位移 = 5（半次拖动）').toBe(5)
    expect(findObject(doc.scene, oid)?.transform.position.x, '已提交内容仍是 0（未提交）').toBe(0)

    const port = createMemoryStoragePort()
    const { plan, outcome } = writeOnce(port, doc, INSTANCE_A)
    expect(outcome.status).toBe('ok')

    // 类型层：载荷的字段表里没有 `interaction`。
    expect(Object.keys(plan.payload).sort()).not.toContain('interaction')
    // 落盘文本层：机械检查暂存形状（类型可被绕过，落盘文本不会说谎）。
    expect(stagedContentMarkers(plan.json), '落盘文本里不得出现暂存形状').toEqual([])
    expect(plan.json).not.toContain('overrides')
    expect(plan.json).not.toContain('totalDisplacement')

    // 内容层：副本里那个对象的位置是**已提交**值，不是暂存值。
    const payload = payloadOf(port, unwrap(recoveryStoreKey(INSTANCE_A, 'doc-1')))
    expect(findObject(payload.scene, oid)?.transform.position.x, '恢复副本里只有已提交内容').toBe(0)

    // 读回并采纳 ⇒ 恢复出 0（不是 5）。
    const read = readRecoveryCopy(port, unwrap(recoveryStoreKey(INSTANCE_A, 'doc-1')))
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    const applied = adoptRecoveryCopy(createDocument('doc-1'), decideRecoveryAdoption(validationOf(read.raw)))
    expect(applied.status).toBe('adopted')
    if (applied.status !== 'adopted') return
    expect(findObject(applied.doc.scene, oid)?.transform.position.x, '半次拖动**不得**被恢复').toBe(0)
  })

  it('`EditContext` 不是合法的恢复来源（形状校验显式拒绝，而不是崩溃或静默）', () => {
    const { ctx } = draggingEditor()
    // 故意把上下文当来源：真实实现必须给出结构化拒绝。
    const captured = captureRecoveryCopy({
      snapshot: ctx as unknown as Parameters<typeof captureRecoveryCopy>[0]['snapshot'],
      identity: INSTANCE_A,
      writtenAt: CLOCK,
    })
    expect(captured.ok).toBe(false)
    if (!captured.ok) {
      expect(captured.error.code).toBe('InvalidValue')
      expect(captured.error.params.reason).toBe('invalidSnapshot')
    }
    // 且类型上 `EditContext` 缺少 `scene`/`animation`/`version` 三个字段（结构证据）。
    const ctxKeys = Object.keys(ctx)
    for (const required of ['scene', 'animation', 'version']) {
      expect(ctxKeys, `EditContext 不得提供 \`${required}\`（否则它就成了合法的恢复来源）`).not.toContain(required)
    }
  })

  it('**负对照**：对照实现 H 把暂存位移并进场景 ⇒ 恢复出 `x = 5` 的半次拖动', () => {
    const { ctx, doc } = draggingEditor()
    const oid = Object.keys(doc.scene.objects)[0]

    // H-1：把 `interaction` 对象**直接塞进**载荷 ⇒ 落盘文本里出现暂存形状。
    const withInteraction = JSON.stringify({ ...payloadFromDoc(doc), interaction: ctx.interaction })
    expect(
      stagedContentMarkers(withInteraction),
      '对照实现 H-1 的落盘文本含暂存形状 ⇒ 会被机械检查抓住（证明该检查不是空转）',
    ).toContain('interaction')
    expect(stagedContentMarkers(withInteraction)).toContain('overrides')

    // H-2：把暂存位移**并进** `scene`（更隐蔽的形态）⇒ 内容层就能看出"半次拖动被恢复了"。
    const naiveJson = naiveCaptureWithStagedOverrides(doc, ctx)
    const naivePayload = JSON.parse(naiveJson) as RecoveryPayload
    expect(findObject(naivePayload.scene, oid)?.transform.position.x, '对照实现把半次拖动写进了恢复副本').toBe(5)
    // 真实实现下的同一时刻：0（见上一条用例的断言）。
    expect(findObject(doc.scene, oid)?.transform.position.x).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 对照实现（**故意破坏目标保证**，供上面的负对照证伪；不参与生产路径）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 对照实现 C：读到副本就自动采纳（不做用户选择，也不做校验）。
 *
 * 破坏的是判据 1「恢复**明确可选**」：真实路径在读回后当前内容不变（由用户显式选择），
 * 本实现读的当刻就替换。
 */
function autoAdoptOnRead(port: RecoveryStorePort, key: string, doc: Document): Document {
  const raw = port.get(key)
  if (raw.status !== 'ok' || raw.value === null) return doc
  return adoptWithoutValidation(doc, raw.value)
}

/**
 * 对照实现 G：不校验就采纳（把坏副本直接当内容用）。
 *
 * 破坏的是判据 5「坏副本先校验再采纳」。它对 `JSON.parse` 的异常**不**处理 ——
 * 这条正好说明"没有校验"与"有结构化原因"之间的差距。
 */
function adoptWithoutValidation(doc: Document, raw: string): Document {
  const parsed = JSON.parse(raw) as { scene: Scene; animation: AnimationState }
  return withContent(doc, parsed.scene, parsed.animation).doc
}

/** 对照实现 E：吞掉端口异常并宣称写入成功（#249 §19.5 明令禁止的形态）。 */
function naiveSwallowingWrite(port: RecoveryStorePort, key: string) {
  try {
    return port.set(key, '{}')
  } catch {
    // 对照实现的核心缺陷：**吞掉**失败，返回"成功"。
    return { status: 'ok' as const }
  }
}

/** 对照实现 F：恢复副本键里**没有**实例身份（多标签必然互相覆盖）。 */
function naiveSharedKey(documentId: string): string {
  return `lk.recovery.v1.${documentId}`
}

/** 对照实现 D 的第一步：不经过任何串行化判定的"开始保存"。 */
function naiveBeginSave(doc: Document, ledger: { nextSequence: number; bindingGeneration: number }) {
  return { sequence: ledger.nextSequence, documentId: doc.id, bindingGeneration: ledger.bindingGeneration, capturedVersion: doc.version, capturedScene: doc.scene }
}
/** 对照实现 D 的第二步：把恢复写的成功当成 `committed` 完成事件回写基线。 */
function naiveCompleteAsCommitted(doc: Document, request: { sequence: number; capturedVersion: Document['version'] }): Document {
  return { ...doc, saveBaseline: request.capturedVersion, savedSequence: request.sequence }
}

/** 对照实现 H：把活动交互的暂存覆盖并进场景再落盘（"半次拖动被恢复"的成因）。 */
function naiveCaptureWithStagedOverrides(doc: Document, ctx: EditContext): string {
  const overrides = ctx.interaction?.overrides ?? {}
  const objects: Record<string, Scene['objects'][string]> = { ...doc.scene.objects }
  for (const [id, tr] of Object.entries(overrides)) {
    const obj = objects[id]
    if (obj) objects[id] = { ...obj, transform: tr }
  }
  const scene: Scene = { ...doc.scene, objects }
  return JSON.stringify({ ...payloadFromDoc(doc), scene })
}

/** 从文档造一份最小载荷（对照实现用；真实载荷一律经 `captureRecoveryCopy`）。 */
function payloadFromDoc(doc: Document): RecoveryPayload {
  return unwrap(
    captureRecoveryCopy({ snapshot: recoverySourceSnapshot(doc), identity: INSTANCE_A, writtenAt: CLOCK }),
  )
}

/** 该场景是否**不可用**（缺 `objects` 导致任何遍历都崩）。 */
function findObjectThrows(scene: Scene): boolean {
  try {
    findObject(scene, 'o1')
    return false
  } catch {
    return true
  }
}

/** 未使用的占位以免 tree-shake 掉类型导入（`removeRecoveryCopy` 供"丢弃副本"路径的类型可达性）。 */
void removeRecoveryCopy
