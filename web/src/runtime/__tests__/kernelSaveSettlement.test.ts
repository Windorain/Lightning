/**
 * **生产保存结算**（内核侧判据）
 *
 * ## 本文件钉的四条（保存结算的四个失败形态）
 *
 * | 判据 | 防什么 |
 * |---|---|
 * | `beginSaveRequest` 捕获 S0 → `completeSaveRequest(committed)` ⇒ 干净 | 保存成功后 `kernelDirty()` 仍为 true（D1 本体） |
 * | 保存**期间**再编辑 ⇒ 完成后仍脏 | 把"当前版本"当基线（SPEC §9:293 `commands.ts:2336`） |
 * | `failed` ⇒ 基线**不动** | 失败也当成功（"写盘失败但显示已保存"） |
 * | 在途 ⇒ 第二次 `begin` 返回 `null`；迟到/重复的完成不改基线 | 并发写与旧完成事件污染（A16 负对照） |
 *
 * 输入全部来自**生产 API**：`KernelSession` + `domain/document` 的生产构造器 +
 * `setProperty` 命令（与装配判据 `assembly.test.ts` 同一手法），不手搓状态。
 */

import { describe, expect, it } from 'vitest'
import { KernelSession } from '@/runtime/kernelSession'
import { ALL_CAPABILITIES } from '@/application/commands'
import { createDocument } from '@/domain/document'

/** 一个已采纳内容的会话（`createDocument` 的生产初值 ⇒ 与基线相同）。 */
function freshSession(): KernelSession {
  const session = new KernelSession({
    documentId: 'doc-1',
    contextId: 'ctx-1',
    capabilities: ALL_CAPABILITIES,
    prefix: 'm82',
  })
  const doc = createDocument('doc-1')
  session.adoptDocument(Object.freeze({ ...doc, saveBaseline: doc.version }))
  return session
}

/**
 * 一次**真实内容编辑**（`setDocumentMeta` 是内核命令面的具名命令；
 * 不用 `setProperty`：那条路要求目标类型的 RNA 已由装配贡献，本文件不建装配）。
 */
function editMeta(session: KernelSession, description: string): void {
  session.submit({ kind: 'setDocumentMeta', contextId: 'ctx-1', patch: { description } })
  session.drain()
}

describe('生产保存结算', () => {
  it('捕获 S0 → committed ⇒ 基线推进（dirty=false），再编辑 ⇒ 又脏', () => {
    const session = freshSession()
    expect(session.documentSummary()?.dirty, '前提：刚采纳的内容必须干净').toBe(false)

    editMeta(session, 'saved')
    expect(session.documentSummary()?.dirty, '前提：真实编辑必须变脏').toBe(true)

    const request = session.beginSaveRequest()
    expect(request, '无在途 ⇒ 必须能发起保存').not.toBeNull()
    expect(request!.sequence, '首个请求序号为 1').toBe(1)

    const applied = session.completeSaveRequest(request!, { kind: 'committed' })
    expect(applied, 'committed ⇒ 必须真的推进基线').toBe(true)
    expect(session.documentSummary()?.dirty, '保存成功后必须干净').toBe(false)
    expect(session.document()?.savedSequence, '已保存序号 = 该请求序号').toBe(1)

    editMeta(session, 'after-save')
    expect(session.documentSummary()?.dirty, '反假绿：保存后再编辑必须重新变脏').toBe(true)
  })

  it('保存**期间**的新编辑仍脏（基线取捕获的 S0，不取当前版本）', () => {
    const session = freshSession()
    editMeta(session, 'S0')
    const request = session.beginSaveRequest()!

    // 在途期间继续编辑到 S1（SPEC §9:293 明确允许）
    editMeta(session, 'S1')

    expect(session.completeSaveRequest(request, { kind: 'committed' }), '这次保存确实落地').toBe(true)
    expect(session.documentSummary()?.dirty, '成功只证明 S0 已保存 ⇒ S1 仍必须脏').toBe(true)

    // 再保存一次（这次没有并发编辑）⇒ 干净
    const second = session.beginSaveRequest()!
    expect(second.sequence).toBe(2)
    expect(session.completeSaveRequest(second, { kind: 'committed' })).toBe(true)
    expect(session.documentSummary()?.dirty, '第二次保存后干净').toBe(false)
  })

  it('失败**不**推进基线；在途槽位释放（可以再发起）', () => {
    const session = freshSession()
    editMeta(session, 'x')
    const request = session.beginSaveRequest()!
    expect(session.completeSaveRequest(request, { kind: 'failed', code: 'io' }), '失败不是"推进了基线"').toBe(false)
    expect(session.documentSummary()?.dirty, '失败不得改基线').toBe(true)
    // 在途已释放 ⇒ 再次发起必须成功（否则一次失败永久卡死保存）
    const again = session.beginSaveRequest()
    expect(again, '失败后必须能再次发起保存').not.toBeNull()
    expect(again!.sequence).toBe(request.sequence + 1)
  })

  it('串行化：在途时的第二次 begin 返回 null；重复/迟到的完成不改基线', () => {
    const session = freshSession()
    editMeta(session, 'x')
    const first = session.beginSaveRequest()!
    expect(session.beginSaveRequest(), '在途 ⇒ 第二请求必须被拒绝（串行化，不是并发）').toBeNull()

    expect(session.completeSaveRequest(first, { kind: 'committed' })).toBe(true)
    expect(session.completeSaveRequest(first, { kind: 'committed' }), '同一个请求不得生效两次').toBe(false)

    const versionAfterFirst = session.document()!.saveBaseline
    expect(session.completeSaveRequest({ ...first, sequence: 99 }, { kind: 'committed' }), '序号不符的完成事件必须被忽略').toBe(false)
    expect(session.document()!.saveBaseline, '迟到事件不得污染基线').toBe(versionAfterFirst)
  })

  it('未采纳内容 ⇒ 不发起保存（返回 null，不臆造一次"成功"）', () => {
    const session = new KernelSession({
      documentId: 'doc-1',
      contextId: 'ctx-1',
      capabilities: ALL_CAPABILITIES,
      prefix: 'm82',
    })
    expect(session.beginSaveRequest(), '没有装配产物 ⇒ 无保存权威').toBeNull()
    session.dispose()
  })
})
