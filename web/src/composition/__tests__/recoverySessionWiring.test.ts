/**
 * M8-4 · 恢复副本**生产接线**的判据（`composition/recoverySession` + 宿主端口）。
 *
 * 这些用例走的是**生产代码本体**（真 `createRecoverySession`、真 `application/recovery`
 * 的写/读/校验/采纳、真 `adapters/recoveryStore` 的压缩编解码），只注入**存储介质**与
 * **宿主端口**（后者在生产里是 `runtime/host/recoveryHost`）。
 *
 * 钉住的事（对应 SPEC §9:299 与 S5/S6）：
 * 1. 编辑提交 ⇒ 防抖后写副本；**键族** `lk.recovery.v1.*`，**不落** `lk.save.v1.*`；
 * 2. 每文档保留 3 份（Q2 上限），内容未变不重复写；
 * 3. 正式保存 committed ⇒ 该文档的副本作废；
 * 4. 损坏副本 ⇒ 结构化诊断 + **不删除** + 不产生候选（不破坏当前内容）；
 * 5. 刷新后检测到候选 ⇒ 显式采纳 ⇒ 装载序列被调用，且**基线未被推进**（仍脏）；
 * 6. 负对照：校验失败的副本**不得**进入装载序列。
 */
import { describe, expect, it } from 'vitest'

import { storageLikeFromRecord } from '@/adapters/storage/browser'
import { createDiagnosticRecorder } from '@/application/diagnostics'
import { RECOVERY_RETENTION_LIMIT } from '@/application/recoveryPolicy'
import { createDocument, type Document } from '@/domain/document'
import { documentContent, documentMetadata } from '@/domain/content'
import { withDocumentContent } from '@/domain/document'
import {
  createRecoverySession,
  type RecoveryHostPort,
  type RecoveryHostSnapshot,
} from '@/composition/recoverySession'

const BASE_KEY = 'lk.recovery.v1.workbench.workbench.doc-1'

function seedDoc(): Document {
  return createDocument('doc-1', { sceneId: 'doc-1-scene' })
}

/** 改元数据 ⇒ 内容身份推进（文档变脏）；与生产上"编辑一次"同一判据。 */
function edited(doc: Document, name: string): Document {
  return withDocumentContent(doc, documentContent({ metadata: documentMetadata({ name }) })).doc
}

function harness(initial: Document | null) {
  const state: {
    current: Document | null
    installed: Document[]
    live: { message: string; level: string; state: string }[]
  } = { current: initial, installed: [], live: [] }
  const diagnostics = createDiagnosticRecorder({ capacity: 256, now: () => 0 })
  const host: RecoveryHostPort = {
    instanceId: 'workbench',
    diagnostics,
    live(message, level, stateTag) { state.live.push({ message, level, state: stateTag }) },
    captureCurrent(): RecoveryHostSnapshot | null {
      const doc = state.current
      if (doc === null) return null
      return {
        documentId: doc.id,
        dirty: doc.version.contentVersion !== doc.saveBaseline.contentVersion,
        snapshot: { id: doc.id, scene: doc.scene, animation: doc.animation, content: doc.content, version: doc.version },
        assets: doc.content.resources.map((r) => r.ref),
      }
    },
    installRestored(input) {
      state.installed.push(input.restored as Document)
      return true
    },
    currentDocumentId() { return state.current?.id ?? null },
  }
  return { state, host, diagnostics }
}

function codeCount(diagnostics: ReturnType<typeof createDiagnosticRecorder>, code: string): number {
  return diagnostics.all().filter((r) => r.code === code).length
}describe('M8-4 恢复副本生产接线', () => {
  it('编辑提交 ⇒ 防抖后写副本：键族 lk.recovery.v1.*，不落正式保存键族', async () => {
    const storage = storageLikeFromRecord({})
    const h = harness(edited(seedDoc(), '编辑后'))
    const session = createRecoverySession({ host: h.host, storage, now: () => 1000, debounceMs: 5 })

    session.contentSettled()
    await new Promise((r) => setTimeout(r, 30))

    const keys: string[] = []
    for (let i = 0; i < (storage as unknown as { length: number }).length; i += 1) {
      const k = (storage as unknown as { key(i: number): string | null }).key(i)
      if (k !== null) keys.push(k)
    }
    expect(keys, '副本键必须落在 lk.recovery.v1.* 族').toEqual([BASE_KEY])
    expect(keys.some((k) => k.startsWith('lk.save.v1.')), '恢复副本**不得**写进正式保存键族').toBe(false)
    const raw = (storage as unknown as { getItem(k: string): string | null }).getItem(BASE_KEY)
    expect(raw, '副本必须有内容').toBeTruthy()
    expect(raw!.startsWith('lkrc1:'), '存储表示必须是压缩形态（否则配额必然不足）').toBe(true)
    session.dispose()
  })

  it('每文档保留 3 份（Q2 上限）；内容未变不重复写', async () => {
    const storage = storageLikeFromRecord({})
    const h = harness(edited(seedDoc(), 'v1'))
    const session = createRecoverySession({ host: h.host, storage, now: () => 1, debounceMs: 1 })
    const flush = async (): Promise<void> => {
      session.contentSettled()
      await new Promise((r) => setTimeout(r, 12))
    }
    await flush()
    h.state.current = edited(seedDoc(), 'v2')
    await flush()
    h.state.current = edited(seedDoc(), 'v3')
    await flush()
    h.state.current = edited(seedDoc(), 'v4')
    await flush()
    const keys: string[] = []
    for (let i = 0; i < (storage as unknown as { length: number }).length; i += 1) {
      const k = (storage as unknown as { key(i: number): string | null }).key(i)
      if (k !== null) keys.push(k)
    }
    expect(keys.sort(), '保留上限 = ' + RECOVERY_RETENTION_LIMIT + ' 份（规范键 + 两个历史槽）').toEqual([
      BASE_KEY,
      BASE_KEY + '~r1',
      BASE_KEY + '~r2',
    ])
    // 同内容再提交一次 ⇒ 不重复写（写入次数不变：值逐字相同）。
    const before = (storage as unknown as { getItem(k: string): string | null }).getItem(BASE_KEY + '~r2')
    await flush()
    expect((storage as unknown as { getItem(k: string): string | null }).getItem(BASE_KEY + '~r2')).toBe(before)
    session.dispose()
  })

  it('正式保存 committed ⇒ 该文档的副本作废（Q2：保存后不保留历史）', async () => {
    const storage = storageLikeFromRecord({})
    const h = harness(edited(seedDoc(), 'v1'))
    const session = createRecoverySession({ host: h.host, storage, now: () => 1, debounceMs: 1 })
    session.contentSettled()
    await new Promise((r) => setTimeout(r, 12))
    expect((storage as unknown as { length: number }).length).toBe(1)
    session.formalSaveCommitted()
    expect((storage as unknown as { length: number }).length, '正式保存后副本应作废').toBe(0)
    expect(codeCount(h.diagnostics, 'recovery.discarded'), '作废必须有结构化诊断').toBeGreaterThan(0)
    session.dispose()
  })

  it('损坏副本 ⇒ 结构化诊断 + 不删除 + 无候选（不破坏当前内容）', () => {
    const storage = storageLikeFromRecord({ [BASE_KEY]: '{"not":"a recovery payload"' })
    const h = harness(seedDoc())
    const session = createRecoverySession({ host: h.host, storage, now: () => 1 })
    expect(session.candidate.value, '坏副本**不得**成为候选（否则采纳入口会把它当成可用内容）').toBeNull()
    expect(session.corruptCount.value).toBe(1)
    const corrupt = h.diagnostics.all().filter((r) => r.code === 'recovery.corrupt')
    expect(corrupt.length, '坏副本必须留下结构化诊断').toBeGreaterThan(0)
    expect(corrupt[0]!.params.documentId, '诊断必须带文档身份').toBe('doc-1')
    expect(String(corrupt[0]!.params.reasons), '诊断必须带原因').toContain('notJson')
    expect((storage as unknown as { getItem(k: string): string | null }).getItem(BASE_KEY), '坏副本**不得**自动删除').toBeTruthy()
    session.dispose()
  })

  it('刷新后检测到候选 ⇒ 显式采纳走装载序列，且**不推进**正式保存基线', async () => {
    const storage = storageLikeFromRecord({})
    const h1 = harness(edited(seedDoc(), '未保存的编辑'))
    const writer = createRecoverySession({ host: h1.host, storage, now: () => 1, debounceMs: 1 })
    writer.contentSettled()
    await new Promise((r) => setTimeout(r, 12))
    writer.dispose()

    // 刷新：新会话、同一份存储、空文档。
    const h2 = harness(null)
    const reader = createRecoverySession({ host: h2.host, storage, now: () => 2 })
    expect(reader.candidate.value, '刷新后必须检测到未采纳副本').not.toBeNull()
    expect(reader.candidate.value!.label).toBe('未保存的编辑')
    expect(codeCount(h2.diagnostics, 'recovery.detected')).toBeGreaterThan(0)

    const outcome = reader.adopt()
    expect(outcome.status).toBe('adopted')
    expect(h2.state.installed.length, '采纳必须经宿主装载序列（不是只改内存）').toBe(1)
    const restored = h2.state.installed[0]!
    // ★ §9:299：采纳**不推进**正式保存基线 —— 恢复出来的文档基线仍是种子文档的空内容基线，
    // 而内容已经换成了副本内容 ⇒ 仍脏（这正是 S5-b 的断言）。
    expect(restored.version.contentVersion, '内容 = 副本内容').toBe(
      (edited(seedDoc(), '未保存的编辑')).version.contentVersion,
    )
    expect(
      restored.saveBaseline.contentVersion,
      '正式保存基线**必须**停在种子文档的空内容基线（未被采纳推进）',
    ).toBe(seedDoc().saveBaseline.contentVersion)
    expect(restored.version.contentVersion).not.toBe(restored.saveBaseline.contentVersion)
    expect(reader.candidate.value, '采纳后候选清空').toBeNull()
    expect(codeCount(h2.diagnostics, 'recovery.adopted')).toBe(1)
    reader.dispose()
  })

  it('负对照：校验失败的副本**不得**进入装载序列（当前内容未动）', async () => {
    const storage = storageLikeFromRecord({})
    const h1 = harness(edited(seedDoc(), '有效内容'))
    const writer = createRecoverySession({ host: h1.host, storage, now: () => 1, debounceMs: 1 })
    writer.contentSettled()
    await new Promise((r) => setTimeout(r, 12))
    writer.dispose()

    // 候选在检测之后被篡改（外部输入变化）：采纳时必须**再校验一次**并拒绝。
    const h2 = harness(null)
    const reader = createRecoverySession({ host: h2.host, storage, now: () => 2 })
    expect(reader.candidate.value).not.toBeNull()
    ;(storage as unknown as { setItem(k: string, v: string): void }).setItem(BASE_KEY, 'garbage@@@')

    const outcome = reader.adopt()
    expect(outcome.status, '校验失败必须拒绝采纳').toBe('rejected')
    expect(h2.state.installed, '拒绝时**不得**调用装载序列（否则就是"坏副本替换有效内容"）').toEqual([])
    expect(reader.corruptCount.value, '被篡改的副本应计入损坏数').toBe(1)
    reader.dispose()
  })
})
