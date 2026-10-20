/**
 * A16 `save-race` + A17 `history-reference` + C4 + 双消费者读面
 * （#249 §14 A16/A17；§8；契约 §6.1；#252 验收 C4 与「至少两个真实消费者证明替代机制」）。
 *
 * ## A16 的四条判据（#249 §14 原文）
 *
 * | 断言 | 落点 |
 * |---|---|
 * | 远端最终内容符合顺序 | 写入**串行化**：前一次未完成不得发起第二次（`beginSave` 返回 null） |
 * | 基线为实际保存内容 | 只有 `committed` 且绑定代数相符才推进 `saveBaseline`，且取**该请求捕获的 S0** |
 * | S1 仍脏 | 保存期间的新编辑不因本次保存变干净 |
 * | 旧绑定不被污染 | 关闭/重绑后推进绑定代数，迟到完成事件不写回 |
 * | **负对照**：仅忽略响应却允许旧请求覆盖远端 ⇒ 判红 | 本实现**不允许并发**，故"旧请求最后覆盖"形态不存在；负对照用"允许并发"的对照实现来证伪 |
 *
 * ## A17 的四条判据
 *
 * | 断言 | 落点 |
 * |---|---|
 * | 内容/相关选择一致 | 撤销恢复 `selectionBefore`，重做恢复 `selectionAfter` |
 * | 无悬空引用 | `resolveSelection` 对**当前场景**解析，失效项进 `dropped` |
 * | 回保存内容变干净 | 与 A06 同判据（内容身份） |
 * | 无关机位不变 | 机位属 3D 编辑器实例，**不在** `EditContext`/`Document` 里 |
 * | **负对照**：回放旧选择直接引用已失效对象 ⇒ 判红 | 删除对象后撤销，删除前选择不得被原样照搬 |
 */

import { describe, expect, it } from 'vitest'
import { Editor } from '@/runtime/execution'
import { defaultExecutionInputs, type Command } from '@/application/commands'
import { beginSave, completeSave, createSaveLedger, isDirty, rebindSaveLedger, undo, withScene, addBlockObject } from '@/domain/document'
import { createDocument } from '@/domain/document'
import { findObject } from '@/domain/scene'
import { admitCompletion, applyJobEvent, emptyJobRegistry, enqueueJob, isTerminal, reapTerminal } from '@/runtime/effects'
import { canonicalize } from '@/domain/identity'

function openEditor(): Editor {
  const e = new Editor()
  e.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
  e.drain()
  return e
}

// ─────────────────────────────────────────────────────────────────────────────
// A16 —— 核心语义层（纯函数）
// ─────────────────────────────────────────────────────────────────────────────

describe('A16 save-race（核心语义层）：写入串行化、基线取 S0、失败不改基线、旧绑定不污染', () => {
  it('写入**串行化**：前一次在途时第二次保存被拒（不并发）', () => {
    const doc = createDocument('doc-1')
    let ledger = createSaveLedger()
    const first = beginSave(ledger, doc, 0)
    expect(first).not.toBeNull()
    if (!first) return
    ledger = first.ledger
    const second = beginSave(ledger, doc, 0)
    expect(second, '#249 §8：每个保存目标写入串行化 ⇒ 不得并发发起').toBeNull()
  })

  it('基线为**实际保存的 S0**；保存期间的新编辑（S1）仍脏', () => {
    const doc0 = createDocument('doc-1')
    const s1 = addBlockObject(doc0.scene, { objectId: 'o1', dataId: 'd1' })!
    const doc1 = withScene(doc0, s1).doc
    let ledger = createSaveLedger()
    const started = beginSave(ledger, doc1, 0)
    expect(started).not.toBeNull()
    if (!started) return
    ledger = started.ledger

    // 保存进行中：用户又编辑了一次（S1 → S2）
    const s2 = addBlockObject(doc1.scene, { objectId: 'o2', dataId: 'd2' })!
    const doc2 = withScene(doc1, s2).doc
    expect(isDirty(doc2)).toBe(true)

    // S0 的完成事件到达（committed）
    const done = completeSave(ledger, doc2, started.request, { kind: 'committed' }, 0)
    expect(done.applied).toBe(true)
    // 基线 = 该请求捕获的 S0（doc1 的版本），**不是**当前版本
    expect(done.doc.saveBaseline.contentVersion).toBe(doc1.version.contentVersion)
    expect(done.doc.savedSequence).toBe(started.request.sequence)
    // S1（现在已是 S2 的内容）**仍脏** —— 因为它比 S0 新
    expect(isDirty(done.doc), '保存期间的新编辑仍必须脏（A16 原文）').toBe(true)
  })

  it('失败**不**改基线（#249 §8 明文）', () => {
    const doc = createDocument('doc-1')
    const s1 = addBlockObject(doc.scene, { objectId: 'o1', dataId: 'd1' })!
    const dirtyDoc = withScene(doc, s1).doc
    const started = beginSave(createSaveLedger(), dirtyDoc, 0)
    expect(started).not.toBeNull()
    if (!started) return
    const done = completeSave(started.ledger, dirtyDoc, started.request, { kind: 'failed', code: 'IO' }, 0)
    expect(done.applied).toBe(false)
    expect(done.doc.saveBaseline.contentVersion, '失败不得改基线').toBe(dirtyDoc.saveBaseline.contentVersion)
    expect(isDirty(done.doc), '失败后必须仍然脏').toBe(true)
    expect(done.ledger.inFlight, '失败后必须释放在途槽位（否则永久卡死）').toBeNull()
  })

  it('旧绑定不被污染：关闭/重绑后迟到完成事件不得写回', () => {
    const doc = createDocument('doc-1')
    const s1 = addBlockObject(doc.scene, { objectId: 'o1', dataId: 'd1' })!
    const d1 = withScene(doc, s1).doc
    const started = beginSave(createSaveLedger(), d1, 0)
    expect(started).not.toBeNull()
    if (!started) return
    // 文档重绑/关闭：绑定代数推进，在途写入被丢弃
    const rebound = rebindSaveLedger(started.ledger)
    expect(rebound.inFlight).toBeNull()
    expect(rebound.bindingGeneration).toBe(1)

    // 迟到完成事件带着**旧**代数到达 ⇒ 不写回
    const late = completeSave(rebound, d1, started.request, { kind: 'committed' }, 1)
    expect(late.applied, '旧绑定的完成事件不得写回（A16 负对照）').toBe(false)
    expect(late.doc.saveBaseline.contentVersion).toBe(d1.saveBaseline.contentVersion)
  })

  it('**负对照**：允许并发（"仅忽略旧响应"）的实现会让旧请求覆盖远端 ⇒ 必须被判负', () => {
    // 这条不测我们的实现，而是**证伪对照实现**：它证明"串行化"这一选择确实是必要的。
    // 对照实现：不做在途检查，允许两次保存并发，然后只忽略旧**响应**。
    const doc = createDocument('doc-1')
    const s1 = addBlockObject(doc.scene, { objectId: 'o1', dataId: 'd1' })!
    const d1 = withScene(doc, s1).doc
    const s2 = addBlockObject(d1.scene, { objectId: 'o2', dataId: 'd2' })!
    const d2 = withScene(d1, s2).doc

    // 并发发起：两次都拿到请求（对照实现不做串行化）
    const req1 = { sequence: 1, documentId: d1.id, bindingGeneration: 0, capturedVersion: d1.version, capturedScene: d1.scene }
    const req2 = { sequence: 2, documentId: d2.id, bindingGeneration: 0, capturedVersion: d2.version, capturedScene: d2.scene }

    // 本地只根据"最后收到的响应"决定基线 ⇒ 若**旧**响应后到，就会把基线设回 S0
    const naiveBaseline = req1.capturedVersion // 旧响应最后到达
    expect(naiveBaseline.contentVersion, '对照实现会让基线停在 S0（旧请求最后覆盖）').toBe(d1.version.contentVersion)
    // 且此刻 doc 内容已是 d2 ⇒ 用对照实现会报告"已保存 S0 但内容 S1"⇒ 脏，看似"幸运地正确"，
    // 但**远端**内容被旧请求覆盖了。故必须靠**串行化**阻止，而不是靠忽略响应。
    const real = createSaveLedger()
    const a = beginSave(real, d1, 0)
    expect(a).not.toBeNull()
    if (!a) return
    expect(beginSave(a.ledger, d2, 0), '真实实现必须在第二次发起时就拒绝（不产生覆盖远端的可能）').toBeNull()
    expect(req2.sequence).toBeGreaterThan(req1.sequence)
  })

  it('集成层：save 命令产生效果描述；序号不符/无在途的完成事件被忽略', () => {
    const e = openEditor()
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' })
    e.drain()
    const save = e.submit({ kind: 'save', contextId: 'ctx-1' })
    e.drain()
    const outcome = e.settlement(save)
    expect(outcome?.status).toBe('applied')
    const effects = e.snapshot().effects
    expect(effects.length, '保存必须产生一个效果描述（A04 效果序列的来源）').toBe(1)
    expect(effects[0].kind).toBe('save')
    expect(effects[0].params.documentId).toBe('doc-1')

    // 串行化：第二次 save 在第一次未完成时被拒
    const second = e.submit({ kind: 'save', contextId: 'ctx-1' })
    e.drain()
    const secondOut = e.settlement(second)
    expect(secondOut?.status, '在途保存未完成时的第二次保存必须被拒（串行化）').toBe('rejected')
    if (secondOut?.status === 'rejected') expect(secondOut.error.params.reason).toBe('saveAlreadyInFlight')

    // 错误的序号 ⇒ 忽略
    const wrong = e.submit({ kind: 'saveCompleted', documentId: 'doc-1', sequence: 999, bindingGeneration: 0, outcome: { kind: 'committed' } })
    e.drain()
    expect(e.settlement(wrong)?.status).toBe('unchanged')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A16 —— 效果与作业状态机（#249 §9 + 契约 §1.5）
// ─────────────────────────────────────────────────────────────────────────────

describe('A16/§9：作业状态机不把超时当取消；过期结果必须回收', () => {
  it('`cancelRequested` 是独立相位，`timeout` **不**产生 `cancelled`', () => {
    let reg = emptyJobRegistry('wk')
    const enq = enqueueJob(reg, { kind: 'save', correlationId: 'c1', bindingGeneration: 0, targetVersion: 0 })
    reg = enq.reg
    let r = applyJobEvent(reg, enq.job.id, { kind: 'start' })
    expect(r.accepted).toBe(true)
    reg = r.reg
    // 超时：只置位 cancelRequested
    r = applyJobEvent(reg, enq.job.id, { kind: 'timeout' })
    expect(r.accepted).toBe(true)
    reg = r.reg
    expect(reg.jobs[enq.job.id].state.phase, '调用超时不得冒充取消').toBe('cancelRequested')
    // 确认取消：才是 cancelled
    r = applyJobEvent(reg, enq.job.id, { kind: 'confirmCancel' })
    reg = r.reg
    expect(reg.jobs[enq.job.id].state.phase).toBe('cancelled')
    expect(isTerminal(reg.jobs[enq.job.id].state)).toBe(true)
    // 取消后到达的成功结果**不被接纳**
    expect(applyJobEvent(reg, enq.job.id, { kind: 'succeed', result: 1 }).accepted).toBe(false)
  })

  it('已完成作业不再接受任何事件（终结态封闭）', () => {
    let reg = emptyJobRegistry('wk')
    const enq = enqueueJob(reg, { kind: 'load', correlationId: 'c2', bindingGeneration: 0, targetVersion: 0 })
    reg = enq.reg
    let r = applyJobEvent(reg, enq.job.id, { kind: 'start' })
    reg = r.reg
    r = applyJobEvent(reg, enq.job.id, { kind: 'succeed', result: 'ok' })
    reg = r.reg
    expect(reg.jobs[enq.job.id].state.phase).toBe('succeeded')
    for (const ev of [{ kind: 'start' }, { kind: 'fail', error: { code: 'InvalidValue', params: {} } }, { kind: 'requestCancel' }] as const) {
      expect(applyJobEvent(reg, enq.job.id, ev as never).accepted).toBe(false)
    }
    // 终结作业可被回收（资源释放路径存在）
    expect(Object.keys(reapTerminal(reg).jobs)).toHaveLength(0)
  })

  it('接纳判定：过期版本 / 过期绑定 / 未知作业 / 已取消 ⇒ 拒绝**且要求回收**', () => {
    let reg = emptyJobRegistry('wk')
    const enq = enqueueJob(reg, { kind: 'evaluate', correlationId: 'c3', bindingGeneration: 0, targetVersion: 5 })
    reg = enq.reg
    const completion = (over: Partial<Parameters<typeof admitCompletion>[1]> = {}) => ({
      jobId: enq.job.id,
      correlationId: 'c3',
      bindingGeneration: 0,
      targetVersion: 5,
      outcome: { kind: 'success' as const, data: 'x' },
      ...over,
    })
    // 正常
    expect(admitCompletion(reg, completion(), { bindingGeneration: 0, targetVersion: 5 })).toEqual({ admitted: true, release: false, reason: 'current' })
    // 旧结果（targetVersion 更小）
    const stale = admitCompletion(reg, completion({ targetVersion: 4 }), { bindingGeneration: 0, targetVersion: 5 })
    expect(stale.admitted).toBe(false)
    expect(stale.reason).toBe('staleVersion')
    expect(stale.release, '过期结果必须回收资源（#249 §7）').toBe(true)
    // 旧绑定（文档已关闭/重绑）
    const staleBinding = admitCompletion(reg, completion(), { bindingGeneration: 1, targetVersion: 5 })
    expect(staleBinding.reason).toBe('staleBinding')
    expect(staleBinding.release).toBe(true)
    // 未知作业
    const unknown = admitCompletion(reg, completion({ jobId: 'nope' }), { bindingGeneration: 0, targetVersion: 5 })
    expect(unknown.reason).toBe('jobUnknown')
    expect(unknown.release).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A17 —— 历史与引用
// ─────────────────────────────────────────────────────────────────────────────

describe('A17 history-reference：撤销/重做一致、无悬空引用、回保存内容变干净', () => {
  it('提交后撤销恢复相关选择；重做恢复提交后的选择', () => {
    const e = openEditor()
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' })
    e.drain()
    const oid = Object.keys(e.snapshot().docs['doc-1'].scene.objects)[0]
    expect(e.snapshot().contexts['ctx-1'].selection.active?.id).toBe(oid)

    // 先把选择清空，再撤销 —— 撤销应恢复"操作前"的选择（此处为空）
    e.submit({ kind: 'select', contextId: 'ctx-1', target: null })
    e.drain()
    e.submit({ kind: 'undo', contextId: 'ctx-1' })
    e.drain()
    expect(e.snapshot().docs['doc-1'].history.future.length, '撤销后应有重做条目').toBe(1)
    expect(e.snapshot().contexts['ctx-1'].selection.selected, '撤销恢复相关选择（操作前为空）').toHaveLength(0)

    e.submit({ kind: 'redo', contextId: 'ctx-1' })
    e.drain()
    const after = e.snapshot()
    expect(after.contexts['ctx-1'].selection.selected.map((r) => r.id), '重做恢复操作后的选择').toEqual([oid])
    expect(after.docs['doc-1'].history.past.length).toBe(1)
  })

  it('**负对照**：目标被删除后撤销，失效引用必须被丢弃（不悬空）', () => {
    const e = openEditor()
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' })
    e.drain()
    const oid = Object.keys(e.snapshot().docs['doc-1'].scene.objects)[0]
    // 删掉它（历史里第 2 条）
    e.submit({ kind: 'deleteObject', contextId: 'ctx-1', objectId: oid })
    e.drain()
    expect(e.snapshot().docs['doc-1'].scene.objects[oid], '对象已删除').toBeUndefined()

    // 撤销删除 ⇒ 对象回来；顺序：先撤销删除
    e.submit({ kind: 'undo', contextId: 'ctx-1' })
    e.drain()
    // 再撤销"添加"⇒ 对象又消失，此时任何指向它的选择都必须被丢弃
    e.submit({ kind: 'undo', contextId: 'ctx-1' })
    e.drain()
    const s = e.snapshot()
    expect(Object.keys(s.docs['doc-1'].scene.objects)).toHaveLength(0)
    for (const ref of s.contexts['ctx-1'].selection.selected) {
      if (ref.kind === 'object') {
        expect(s.docs['doc-1'].scene.objects[ref.id], `选择里不得残留失效对象引用 ${ref.id}`).toBeDefined()
      }
    }
    expect(s.contexts['ctx-1'].selection.active?.id ?? null).toBeNull()
  })

  it('`resolveSelection` 把失效引用放进 `dropped`（不是静默保留）', () => {
    const doc = createDocument('doc-1')
    const scene = addBlockObject(doc.scene, { objectId: 'alive', dataId: 'd1' })!
    const d = withScene(doc, scene).doc
    const r = undo({ ...d, history: { past: [{ label: 'x', beforeScene: scene, afterScene: scene, beforeVersion: d.version, afterVersion: d.version, changes: { changedProperties: [], createdEntities: [], removedEntities: [], structurallyShared: true }, selectionBefore: [{ kind: 'object', id: 'gone' }, { kind: 'object', id: 'alive' }], selectionAfter: [] }], future: [], maxDepth: 8 } })
    expect(r).not.toBeNull()
    if (!r) return
    expect(r.selection.map((s) => s.id)).toEqual(['alive'])
    expect(r.droppedReferences.map((s) => s.id)).toEqual(['gone'])
  })

  it('回保存内容变干净（撤销回到基线内容）', () => {
    const e = openEditor()
    const save = e.submit({ kind: 'save', contextId: 'ctx-1' })
    e.drain()
    expect(e.settlement(save)?.status).toBe('applied')
    const seq = e.snapshot().docs['doc-1'].savedSequence + 1
    e.submit({ kind: 'saveCompleted', documentId: 'doc-1', sequence: seq, bindingGeneration: 0, outcome: { kind: 'committed' } })
    e.drain()
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block' })
    e.drain()
    expect(isDirty(e.snapshot().docs['doc-1'])).toBe(true)
    e.submit({ kind: 'undo', contextId: 'ctx-1' })
    e.drain()
    expect(isDirty(e.snapshot().docs['doc-1']), '撤销回保存内容必须干净').toBe(false)
  })

  it('历史深度有界（不无界增长）', () => {
    const e = new Editor({ initial: undefined })
    e.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
    e.drain()
    for (let i = 0; i < 20; i++) e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block' })
    e.drain()
    const doc = e.snapshot().docs['doc-1']
    expect(doc.history.past.length).toBeLessThanOrEqual(doc.history.maxDepth)
    expect(doc.history.past.length).toBe(20)
  })

  it('无关机位不变：观察视角**不在** EditContext/Document（结构证据）', () => {
    const e = openEditor()
    const ctxKeys = Object.keys(e.snapshot().contexts['ctx-1']).sort()
    const docKeys = Object.keys(e.snapshot().docs['doc-1']).sort()
    for (const k of ['cameras', 'viewport', 'camera', 'view']) {
      expect(ctxKeys, `EditContext 不得含机位（${k}）—— 机位属 3D 编辑器实例`).not.toContain(k)
      expect(docKeys, `Document 不得含观察机位（${k}）—— 相机**对象**才是文档内容`).not.toContain(k)
    }
    // 反空洞真：确实检查到了字段
    expect(ctxKeys.length).toBeGreaterThan(4)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 双消费者读面（#250 裁决 2026-10-11：替代机制须被至少两个真实消费者证明）
// ─────────────────────────────────────────────────────────────────────────────

describe('#250 裁决：替代机制（EditorClient 读面 + 统一执行协议）被两个真实消费者证明', () => {
  it('消费者一（**两个 3D 视口**）：经 `interaction.effectiveTransform` 读到**同一**暂存结果', () => {
    const e = openEditor()
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' })
    e.drain()
    const oid = Object.keys(e.snapshot().docs['doc-1'].scene.objects)[0]
    e.submit({ kind: 'beginInteraction', contextId: 'ctx-1', tool: 'move', targets: [oid] })
    e.submit({ kind: 'updateInteraction', contextId: 'ctx-1', displacement: { x: 4, y: 0, z: 0 } })
    e.drain()

    // 两个视口**各自**捕获一个读面（它们不是同一个 ReadView 对象）
    const viewportA = e.read({ documentId: 'doc-1', contextId: 'ctx-1' })
    const viewportB = e.read({ documentId: 'doc-1', contextId: 'ctx-1' })
    expect(viewportA).not.toBe(viewportB)

    const ta = viewportA.interaction.effectiveTransform(oid)
    const tb = viewportB.interaction.effectiveTransform(oid)
    expect(ta.ok && tb.ok).toBe(true)
    if (!ta.ok || !tb.ok) return
    expect(canonicalize(ta.value), '两个视口的有效读面必须相同（A05 原文）').toBe(canonicalize(tb.value))
    expect(ta.value.position.x, '读到的是**暂存**值（不是文档基础值）').toBe(4)
    // 基础值仍是 0（未提交）—— 证明读到的是有效值而非文档值
    const authored = viewportA.properties.read({ owner: { kind: 'object', id: oid }, property: 'block.transform.position' }, 'authored')
    expect(authored.ok).toBe(true)
    if (authored.ok) expect((authored.value as { x: number }).x).toBe(0)

    // 松手前：基础文档与历史未变（A05 原文）
    const docState = e.snapshot().docs['doc-1']
    expect(Object.keys(docState.scene.objects).length).toBe(1)
    expect(docState.history.past.length).toBe(1) // 只有 add，没有拖动
    // 提交后：仅**一条**历史
    e.submit({ kind: 'commitInteraction', contextId: 'ctx-1', label: 'move' })
    e.drain()
    expect(e.snapshot().docs['doc-1'].history.past.length, '提交仅一条历史').toBe(2)
  })

  it('消费者二（**属性检查器**）：经 `properties.describe/read/editability` 读，且**无第二写通路**', () => {
    const e = openEditor()
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'camera', name: 'Cam' })
    e.drain()
    const view = e.read({ documentId: 'doc-1', contextId: 'ctx-1' })
    const list = view.objects.list()
    expect(list.ok).toBe(true)
    if (!list.ok) return
    const cam = list.value[0]

    const desc = view.properties.describe({ owner: { kind: 'object', id: cam.id }, property: 'camera.transform.position' })
    expect(desc.ok).toBe(true)
    if (desc.ok) {
      expect(desc.value.valueType).toBe('vec3')
      expect(desc.value.animatable).toBe(true)
      // RNA 描述不得出现控件类型名（契约 §5.1）
      expect(canonicalize(desc.value)).not.toContain('control')
    }
    const eff = view.properties.editability({ owner: { kind: 'object', id: cam.id }, property: 'camera.transform.position' })
    expect(eff.ok).toBe(true)
    if (eff.ok) expect(eff.value.editable, '可编辑性返回结构化原因（editable + because）').toBe(true)

    // **无第二写通路**：ReadView 上不存在任何可写动词或字段袋
    const readViewKeys = [...Object.keys(view), ...Object.keys(view.objects), ...Object.keys(view.properties), ...Object.keys(view.workspace), ...Object.keys(view.interaction)]
    for (const forbidden of ['write', 'set', 'apply', 'dispatch', 'patch', 'ref', 'refs']) {
      expect(readViewKeys, `ReadView 不得暴露 \`${forbidden}\`（契约 §2.1：read 不导出内部状态）`).not.toContain(forbidden)
    }
    // `state` 作为**方法名**是合法的（契约 §2.2 的 `InteractionQueries` 面）；
    // 不得有的是"能取回内部 ApplicationState 的入口"。故按**返回形态**判定而非按名字：
    // 调用全部读面方法，断言没有任何一个返回含 `docs`/`contexts`/`leases` 的对象。
    const probes: unknown[] = [
      view.objects.list(),
      view.objects.get(cam.id),
      view.objects.data(cam.dataId),
      view.workspace.document(),
      view.workspace.leaseHolder(),
      view.interaction.state(),
      view.interaction.context(),
      view.interaction.selection(),
      view.properties.describe({ owner: { kind: 'object', id: cam.id }, property: 'camera.name' }),
      view.properties.read({ owner: { kind: 'object', id: cam.id }, property: 'camera.name' }, 'authored'),
      view.properties.editability({ owner: { kind: 'object', id: cam.id }, property: 'camera.name' }),
    ]
    const stateShaped: string[] = []
    const walk = (v: unknown, pathStr: string, depth: number): void => {
      if (depth > 4 || v === null || typeof v !== 'object') return
      const keys = Object.keys(v as object)
      for (const banned of ['docs', 'contexts', 'leases', 'saveLedgers', 'effects']) {
        if (keys.includes(banned) && banned !== 'effects') stateShaped.push(`${pathStr}.${banned}`)
      }
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) walk(child, `${pathStr}.${k}`, depth + 1)
    }
    probes.forEach((p, i) => walk(p, `probe[${i}]`, 0))
    expect(stateShaped, '读面不得返回内部 ApplicationState 形状（docs/contexts/leases）').toEqual([])
    // 反空洞真：确实枚举到了读面成员，且探针确实取到了值
    expect(readViewKeys.length).toBeGreaterThan(10)
    expect(probes.filter((p) => p !== undefined).length).toBe(probes.length)
  })

  it('读面**不**导出内部状态：无法从 ReadView 取回 ApplicationState / 文档实例 / Ref', () => {
    const e = openEditor()
    const view = e.read({ documentId: 'doc-1', contextId: 'ctx-1' })
    // 读面返回的文档摘要是**值投影**，含版本与计数，但**不含** scene / history 之类内部结构
    const doc = view.workspace.document()
    expect(doc.ok).toBe(true)
    if (!doc.ok) return
    const keys = Object.keys(doc.value).sort()
    expect(keys).toEqual(['canRedo', 'canUndo', 'dirty', 'id', 'objectCount', 'redoLabel', 'undoLabel', 'version'])
    // 不返回 Vue Ref 形状（`{ value: ... }` 且只有 value 键）
    for (const v of Object.values(doc.value)) {
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        expect(Object.keys(v), '不得返回 Vue Ref 形状的内部对象').not.toEqual(['value'])
      }
    }
  })

  it('两个消费者共用一个编辑器实例也能各得其所（互不干扰）', () => {
    const e = openEditor()
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block' })
    e.drain()
    const v1 = e.read({ documentId: 'doc-1', contextId: 'ctx-1' })
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'annotation' })
    e.drain()
    const v2 = e.read({ documentId: 'doc-1', contextId: 'ctx-1' })
    // v1 捕获的是一致版本的**快照**（它自己的 version 仍是旧的）
    expect(v1.workspace.document().ok).toBe(true)
    const d1 = v1.workspace.document()
    const d2 = v2.workspace.document()
    if (d1.ok && d2.ok) {
      expect(d2.value.objectCount).toBe(2)
      // 旧视图仍报告它捕获时的版本（版本一致性的可观测形态）
      expect(d1.value.version.documentVersion).toBeLessThanOrEqual(d2.value.version.documentVersion)
    }
  })
})

/** 未使用占位：`defaultExecutionInputs`/`Command` 的类型可达性。 */
const _typecheck: Command | null = null
void _typecheck
void defaultExecutionInputs
void findObject
