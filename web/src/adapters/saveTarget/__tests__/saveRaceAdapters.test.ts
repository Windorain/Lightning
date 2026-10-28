/**
 * A16 `save-race`（**适配器层**）—— 写入串行化 + 远端条件版本。
 *
 * ## 与核心层 A16 的分工（「A16 save-race（适配器层，与核心层合并验收）」）
 *
 * | 半边 | 文件 | 管住什么 |
 * |---|---|---|
 * | 核心语义 | `domain/document.ts` + `src/application/__tests__/saveRaceHistory.test.ts` | 基线取 S0、S1 仍脏、失败不改基线、旧绑定不回写 |
 * | **通道执行（本文件）** | `adapters/saveTarget/coordinator.ts` | **远端**不会被旧请求覆盖：串行化 + 条件版本 |
 *
 * 本文件**不重复**断言核心那些判据（那会变成两套定义），只在"通道"这一维上
 * 证明 §8 的后半句成立。
 *
 * ## 负对照（A16 原文）
 *
 * > **负对照必须判红**：仅忽略响应却允许旧请求覆盖远端。
 *
 * 本文件用 `createUnconditionalTarget`（对照实现）证明这一条：
 * 无条件写入的目标上，两次并发写都会到远端，把旧字节"最后到达"注入后，
 * 远端内容确实变成旧的那份 —— 即"忽略响应"救不了远端。
 */

import { describe, expect, it } from 'vitest'
import { SaveCoordinator, createConditionalTarget, createUnconditionalTarget, jsonSerializePort } from '@/adapters/saveTarget/coordinator'
import { addBlockObject, createDocument, isDirty, withScene } from '@/domain/document'

function docWith(id: string, blocks: number) {
  let doc = createDocument(id)
  for (let i = 0; i < blocks; i++) {
    const s = addBlockObject(doc.scene, { objectId: `${id}-o${i}`, dataId: `${id}-d${i}` })
    if (!s) throw new Error('fixture')
    doc = withScene(doc, s).doc
  }
  return doc
}

function coordinatorOver(doc: ReturnType<typeof docWith>) {
  const target = createConditionalTarget('t1')
  const coord = new SaveCoordinator({ doc, target: target.port, serialize: jsonSerializePort() })
  return { target, coord }
}

describe('A16 适配器层：写入目标的条件版本（远端不会被旧请求覆盖）', () => {
  it('正常路径：条件版本相符 ⇒ 写入成功、修订推进、基线取**该请求捕获的 S0**', () => {
    const doc = docWith('doc-1', 2)
    const { target, coord } = coordinatorOver(doc)
    const d = coord.dispatch(doc)
    expect(d.kind).toBe('dispatched')
    if (d.kind !== 'dispatched') return
    expect(target.stats().revision).toBe(1)

    const resolved = coord.resolve(d.request, true)
    expect(resolved.applied).toBe(true)
    expect(resolved.doc.saveBaseline.contentVersion).toBe(doc.version.contentVersion)
    expect(resolved.wroteRemote).toBe(true)
  })

  it('**串行化**：在途未结算时第二次 `dispatch` 被拒（不并发写入）', () => {
    const doc = docWith('doc-1', 1)
    const { target, coord } = coordinatorOver(doc)
    const a = coord.dispatch(doc)
    expect(a.kind).toBe('dispatched')
    const b = coord.dispatch(doc)
    expect(b.kind, '写入串行化 ⇒ 第二次发起必须被拒').toBe('rejected')
    if (b.kind === 'rejected') expect(b.error.params.reason).toBe('saveAlreadyInFlight')
    expect(target.stats().writes, '被拒的发起不得产生远端写入').toBe(1)
  })

  it('**条件版本**：两个实例各自读到同一修订，后者写入被 VersionConflict 拒绝（远端不被旧请求覆盖）', () => {
    const doc = docWith('doc-1', 1)
    // 同一远端，两个协调器（模拟两个标签页）
    const shared = createConditionalTarget('shared')
    const c1 = new SaveCoordinator({ doc, target: shared.port, serialize: jsonSerializePort() })
    const c2 = new SaveCoordinator({ doc, target: shared.port, serialize: jsonSerializePort() })

    const r1 = c1.dispatch(doc)
    expect(r1.kind).toBe('dispatched')
    // c2 在 c1 之后发起：它读到的是 c1 写后的修订 ⇒ 它的条件写入成功（修订 1→2）
    const r2 = c2.dispatch(doc)
    expect(r2.kind).toBe('dispatched')

    // 更真实的乱序：先读修订，随后**别的**写入者插队，再拿着过期修订写入 ⇒ 必须被拒
    const revBefore = shared.port.readRevision()
    expect(revBefore.ok).toBe(true)
    const c4 = new SaveCoordinator({ doc, target: shared.port, serialize: jsonSerializePort() })
    void c4.dispatch(doc)
    if (revBefore.ok) {
      const staleWrite = shared.port.write({
        request: { sequence: 99, documentId: 'doc-1', bindingGeneration: 0, capturedVersion: doc.version, capturedScene: doc.scene, capturedContent: doc.content },
        bytes: new Uint8Array([1]),
        expectedRevision: revBefore.value,
      })
      expect(staleWrite.ok, '拿过期修订写入必须被拒（否则旧请求会覆盖远端）').toBe(false)
      if (!staleWrite.ok) {
        expect(staleWrite.error.code).toBe('VersionConflict')
        expect(staleWrite.error.params.expected).toBe(revBefore.value)
      }
    }
    expect(shared.stats().conflicts).toBeGreaterThanOrEqual(1)
  })

  it('**负对照**：无条件写入目标上，旧请求最后到达即覆盖远端 —— "仅忽略响应"救不了远端', () => {
    const naive = createUnconditionalTarget('naive')
    const doc1 = docWith('doc-1', 1)
    const s2 = addBlockObject(doc1.scene, { objectId: 'o2', dataId: 'd2' })!
    const doc2 = withScene(doc1, s2).doc

    // 两次写入都发起（对照实现不做在途检查 ⇒ 允许并发）
    const coord = new SaveCoordinator({ doc: doc1, target: naive.port, serialize: jsonSerializePort() })
    const a = coord.dispatch(doc1)
    expect(a.kind).toBe('dispatched')
    // 对照实现里第二次仍然能写（这正是它的缺陷）
    const second = naive.port.write({
      request: { sequence: 2, documentId: 'doc-1', bindingGeneration: 0, capturedVersion: doc2.version, capturedScene: doc2.scene, capturedContent: doc2.content },
      bytes: new Uint8Array([2]),
      expectedRevision: 0,
    })
    expect(second.ok, '对照实现无条件写入 ⇒ 第二次也会到远端').toBe(true)
    expect(naive.stats().arrivals).toEqual([1, 2])

    // 注入"旧请求的响应最后到达" ⇒ 远端内容变成旧的那份（新内容被覆盖）
    const staleBytes = new Uint8Array([1])
    naive.applyStaleOverwrite(staleBytes)
    expect([...naive.stats().bytes], '仅忽略响应 ⇒ 远端仍被旧请求覆盖（负对照成立）').toEqual([1])

    // 真实实现：第二次发起**根本不会发生** ⇒ 覆盖不可能
    const real = createConditionalTarget('real')
    const realCoord = new SaveCoordinator({ doc: doc1, target: real.port, serialize: jsonSerializePort() })
    realCoord.dispatch(doc1)
    const blocked = realCoord.dispatch(doc2)
    expect(blocked.kind, '真实实现在第二次发起时就拒绝 ⇒ 远端不存在被旧请求覆盖的可能').toBe('rejected')
    expect(real.stats().writes).toBe(1)
  })

  it('远端失败 ⇒ **不改基线**，且在途槽位被释放（否则永久卡死）', () => {
    const doc = docWith('doc-1', 1)
    const { coord } = coordinatorOver(doc)
    const d = coord.dispatch(doc)
    expect(d.kind).toBe('dispatched')
    if (d.kind !== 'dispatched') return
    const before = coord.currentDocument.saveBaseline.contentVersion
    const resolved = coord.resolve(d.request, false, 'NetworkDown')
    expect(resolved.applied).toBe(false)
    expect(resolved.doc.saveBaseline.contentVersion, '失败不改基线').toBe(before)
    expect(resolved.ledger.inFlight).toBeNull()
    // 可再次发起（没有卡死）
    expect(coord.dispatch(doc).kind).toBe('dispatched')
  })

  it('保存期间的新编辑（S1）在 S0 完成后**仍脏**；撤销回基线变干净', () => {
    const doc0 = docWith('doc-1', 1)
    const { coord } = coordinatorOver(doc0)
    const d = coord.dispatch(doc0)
    if (d.kind !== 'dispatched') throw new Error('fixture')
    // 保存进行中又编辑
    const s2 = addBlockObject(doc0.scene, { objectId: 'late', dataId: 'dl' })!
    const doc1 = withScene(doc0, s2).doc
    const resolved = coord.resolve(d.request, true)
    expect(resolved.applied).toBe(true)
    expect(resolved.doc.saveBaseline.contentVersion).toBe(doc0.version.contentVersion)
    // 把文档推进到 S1 后仍是脏（基线是 S0）
    const advanced = withScene(resolved.doc, doc1.scene).doc
    expect(isDirty(advanced)).toBe(true)
    // 撤销回 S0 内容 ⇒ 干净
    const back = withScene(advanced, doc0.scene).doc
    expect(isDirty(back), '撤销回实际保存内容必须干净').toBe(false)
  })

  it('**旧绑定不被污染**：重绑后迟到的完成事件不写回', () => {
    const doc = docWith('doc-1', 1)
    const { coord } = coordinatorOver(doc)
    const d = coord.dispatch(doc)
    if (d.kind !== 'dispatched') throw new Error('fixture')
    coord.rebind()
    expect(coord.binding).toBe(1)
    const before = coord.currentDocument.saveBaseline.contentVersion
    const late = coord.resolve(d.request, true)
    expect(late.applied, '旧绑定的完成事件不得回写（A16 负对照）').toBe(false)
    expect(coord.currentDocument.saveBaseline.contentVersion).toBe(before)
  })

  it('序列化失败 ⇒ 释放在途槽位、不改基线、不产生远端写入', () => {
    const doc = docWith('doc-1', 1)
    const target = createConditionalTarget('t')
    const coord = new SaveCoordinator({
      doc,
      target: target.port,
      serialize: { serialize: () => ({ ok: false, error: { code: 'InvalidValue', params: { reason: 'cannotSerialize' } } }) },
    })
    const d = coord.dispatch(doc)
    expect(d.kind).toBe('rejected')
    expect(target.stats().writes).toBe(0)
    expect(coord.currentLedger.inFlight).toBeNull()
    expect(coord.currentDocument.saveBaseline.contentVersion).toBe(doc.saveBaseline.contentVersion)
  })

  it('读远端修订失败 ⇒ 不写入、释放在途（存储不可用必须可见）', () => {
    const doc = docWith('doc-1', 1)
    const target = createConditionalTarget('t')
    let writeCalls = 0
    const coord = new SaveCoordinator({
      doc,
      target: {
        targetId: 't',
        readRevision: () => ({ ok: false, error: { code: 'UnsupportedOperation', params: { reason: 'storageUnavailable' } } }),
        write: (input) => {
          writeCalls += 1
          return target.port.write(input)
        },
      },
      serialize: jsonSerializePort(),
    })
    const d = coord.dispatch(doc)
    expect(d.kind).toBe('rejected')
    if (d.kind === 'rejected') expect(d.error.params.reason).toBe('storageUnavailable')
    expect(writeCalls, '读不到修订就不得写入（不得猜 expectedRevision=0）').toBe(0)
    expect(coord.currentLedger.inFlight).toBeNull()
  })

  it('条件版本是**签名的一部分**（结构证据：端口只有 readRevision/write/targetId 三项，无无条件写入口）', () => {
    const t = createConditionalTarget()
    const keys = Object.keys(t.port).sort()
    expect(keys).toEqual(['readRevision', 'targetId', 'write'])
    expect('writeUnconditional' in t.port).toBe(false)
    // 判据不是"注释里说必填"，而是**行为**：expectedRevision 与当前修订不符 ⇒ 拒绝。
    const first = t.port.write({ request: { sequence: 1 } as never, bytes: new Uint8Array([9]), expectedRevision: 0 })
    expect(first.ok).toBe(true)
    const replay = t.port.write({ request: { sequence: 1 } as never, bytes: new Uint8Array([9]), expectedRevision: 0 })
    expect(replay.ok, '同一个 expectedRevision 重放必须被拒（否则"条件"只是装饰）').toBe(false)
    if (!replay.ok) expect(replay.error.code).toBe('VersionConflict')
    // 反空洞真：写入确实发生过一次
    expect(t.stats().writes).toBe(1)
  })
})
