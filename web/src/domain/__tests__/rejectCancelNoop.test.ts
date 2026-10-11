/**
 * A06 `reject-cancel-noop` + C2 + C3 —— **拒绝/取消零残留、暂存不整文档复制、文档级租约**
 * （#249 §14 A06；§8；§3.4；契约 §6.1；#252 验收 C2/C3）。
 *
 * ## A06 的判据逐条
 *
 * | 断言（#249 A06 原文） | 本文件落点 |
 * |---|---|
 * | 无无效历史 | 被拒/取消/净零后 `history.past.length` 不变 |
 * | 无内容版本推进 | `version.contentVersion` 逐位不变 |
 * | 脏状态不变 | `isDirty` 不变 |
 * | 拒绝原因明确 | 错误码 + `params` 结构化 |
 * | **负对照**：新建相同内容容器即记账 ⇒ 判红 | 造一个"内容相同但是新容器"的场景，断言**不**产生历史/版本推进 |
 *
 * ## C2 的判据
 *
 * `stagingFootprint` 必须显示 `staged` 只等于被拖动目标数，而**不是**文档对象总数；
 * 叠加上"总位移重算"的幂等性证明无漂移。
 */

import { describe, expect, it } from 'vitest'
import { Editor } from '@/runtime/execution'
import type { Command } from '@/application/commands'
import {
  addBlockObject,
  createDocument,
  isDirty,
  pushHistory,
  withScene,
} from '@/domain/document'
import {
  beginInteraction,
  createEditContext,
  createLease,
  acquireLease,
  releaseLease,
  closeLease,
  rejectInteractionUpdate,
  stagingFootprint,
  isNetZero,
  updateInteraction,
} from '@/domain/editing'
import { canonicalize, digestOf, sameContent } from '@/domain/identity'
import { findObject, isDataShared, objectData, objectsSharingData, sceneObject, withObject } from '@/domain/scene'


function openEditor(): Editor {
  const e = new Editor()
  e.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
  e.drain()
  return e
}

function stateSnapshot(e: Editor) {
  const s = e.snapshot()
  const doc = s.docs['doc-1']
  return {
    version: doc.version,
    contentVersion: doc.version.contentVersion,
    dirty: isDirty(doc),
    historyLen: doc.history.past.length,
    futureLen: doc.history.future.length,
    objects: Object.keys(doc.scene.objects).length,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A06 —— 拒绝
// ─────────────────────────────────────────────────────────────────────────────

describe('A06 reject：被拒绝的操作保持文档/历史/脏状态不变', () => {
  it('目标不存在（MissingTarget）⇒ 零残留，原因结构化', () => {
    const e = openEditor()
    const before = stateSnapshot(e)
    const t = e.submit({ kind: 'deleteObject', contextId: 'ctx-1', objectId: 'nope' })
    e.drain()
    const outcome = e.settlement(t)
    expect(outcome?.status).toBe('rejected')
    if (outcome?.status === 'rejected') {
      expect(outcome.error.code).toBe('MissingTarget')
      expect(outcome.error.params.objectId).toBe('nope')
    }
    expect(stateSnapshot(e)).toEqual(before)
  })

  it('越界/非法值（InvalidValue）⇒ 零残留', () => {
    const e = openEditor()
    const before = stateSnapshot(e)
    const t = e.submit({ kind: 'setTime', contextId: 'ctx-1', time: { frame: 0, fps: 0 } })
    e.drain()
    const outcome = e.settlement(t)
    expect(outcome?.status).toBe('rejected')
    if (outcome?.status === 'rejected') {
      expect(outcome.error.code).toBe('InvalidValue')
      expect(outcome.error.params.reason).toBe('fpsMustBePositive')
    }
    expect(stateSnapshot(e)).toEqual(before)
  })

  it('只读目标（ReadOnly，按**拥有者**判定而非文档级布尔）⇒ 零残留', () => {
    const e = openEditor()
    // 直接构造一份"同文档内既有可编辑对象、又有只读内容对象"的状态
    const doc = e.snapshot().docs['doc-1']
    const scene1 = addBlockObject(doc.scene, { objectId: 'o-writable', dataId: 'd-writable' })!
    const withContent = withObject(scene1, sceneObject({ id: 'o-readonly', type: 'block', dataId: 'd-readonly' }), objectData('d-readonly', { kind: 'blockGrid', cells: {} }, 'content'))!
    const doc2 = Object.freeze({ ...doc, scene: withContent })
    const seeded = Object.freeze({ ...e.snapshot(), docs: Object.freeze({ ...e.snapshot().docs, 'doc-1': doc2 }) })
    const e2 = new Editor({ initial: seeded })
    const before = stateSnapshot(e2)

    // 对只读对象写 ⇒ ReadOnly，且 `params.owner` 指明是**内容来源**而非"整个文档"
    const t1 = e2.submit({ kind: 'setTransform', contextId: 'ctx-1', objectId: 'o-readonly', transform: findObject(withContent, 'o-readonly')!.transform })
    e2.drain()
    const out1 = e2.settlement(t1)
    expect(out1?.status).toBe('rejected')
    if (out1?.status === 'rejected') {
      expect(out1.error.code).toBe('ReadOnly')
      expect(out1.error.params.owner).toBe('content')
    }
    expect(stateSnapshot(e2)).toEqual(before)

    // **同文档内**的可编辑对象仍必须可写 —— 这是契约 §3.2 的负对照要求
    // 属性 ID 是**限定式**（`<objectTypeId>.<localId>`，冻结 #1）：
    // `o-writable` 由 `addBlockObject` 造出，故其 name 属性是 `block.name`。
    const t2 = e2.submit({ kind: 'setProperty', refs: [{ owner: { kind: 'object', id: 'o-writable' }, property: 'block.name' }], value: 'renamed' })
    e2.drain()
    const out2 = e2.settlement(t2)
    expect(out2?.status, `同文档内可编辑对象必须仍可写（不得退化成文档级布尔）；实得 ${JSON.stringify(out2)}`).toBe('applied')
    expect(findObject(e2.snapshot().docs['doc-1'].scene, 'o-writable')?.name).toBe('renamed')
  })

  it('无效变化（值相同）⇒ `unchanged`，不产生历史、不推进版本', () => {
    const e = openEditor()
    const add = e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' })
    e.drain()
    expect(e.settlement(add)?.status).toBe('applied')
    const before = stateSnapshot(e)

    const oid = Object.keys(e.snapshot().docs['doc-1'].scene.objects)[0]
    const current = findObject(e.snapshot().docs['doc-1'].scene, oid)!
    const again = e.submit({ kind: 'setTransform', contextId: 'ctx-1', objectId: oid, transform: current.transform })
    e.drain()
    expect(e.settlement(again)?.status).toBe('unchanged')
    expect(stateSnapshot(e)).toEqual(before)
  })

  it('**负对照**：把"新建了相同内容的容器"当内容变化 ⇒ 必须判红（不记历史、不推版本）', () => {
    // 直接测两个层次的实现：
    // ① 纯函数层：`withScene` 对"内容相同的新容器"必须报 changed=false
    const doc = createDocument('doc-1')
    const sceneA = addBlockObject(doc.scene, { objectId: 'o1', dataId: 'd1' })!
    const w1 = withScene(doc, sceneA)
    // 造一个**内容相同但容器不同**的场景
    const sceneClone = Object.freeze({ ...sceneA, objects: Object.freeze({ ...sceneA.objects }), order: Object.freeze([...sceneA.order]) })
    expect(sceneClone, '前置：必须是不同的容器对象').not.toBe(sceneA)
    const w2 = withScene(w1.doc, sceneClone)
    expect(w2.changed, '新容器但内容相同 ⇒ 不得判为内容变化（契约 §1.4）').toBe(false)
    expect(w2.doc.version, '版本对象必须逐位不变').toBe(w1.doc.version)
    expect(w2.doc.version.documentVersion).toBe(w1.doc.version.documentVersion)

    // ② 历史层：即便有人硬塞一条 before/after 内容相同的记账请求，也必须被拒
    const h = pushHistory(w1.doc.history, {
      label: 'fake',
      beforeScene: w1.doc.scene,
      beforeVersion: w1.doc.version,
      afterScene: sceneClone,
      afterVersion: w2.version,
      changes: { changedProperties: [], createdEntities: [], removedEntities: [], structurallyShared: true },
    })
    expect(h, '净零变化不得产生历史条目（幽灵历史防御）').toBeNull()
  })

  it('移出再移回（净零往返）⇒ 无幽灵历史、版本不变、脏状态不变', () => {
    const e = openEditor()
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' })
    e.drain()
    const oid = Object.keys(e.snapshot().docs['doc-1'].scene.objects)[0]
    const before = stateSnapshot(e)

    e.submit({ kind: 'beginInteraction', contextId: 'ctx-1', tool: 'move', targets: [oid] })
    e.submit({ kind: 'updateInteraction', contextId: 'ctx-1', displacement: { x: 5, y: 0, z: 0 } })
    e.submit({ kind: 'updateInteraction', contextId: 'ctx-1', displacement: { x: 0, y: 0, z: 0 } })
    const commit = e.submit({ kind: 'commitInteraction', contextId: 'ctx-1', label: 'roundtrip' })
    e.drain()

    expect(e.settlement(commit)?.status, '净零提交必须是 unchanged').toBe('unchanged')
    const after = stateSnapshot(e)
    expect(after.historyLen, '净零往返不得产生历史').toBe(before.historyLen)
    expect(after.contentVersion, '净零往返不得推进内容版本').toBe(before.contentVersion)
    expect(after.dirty).toBe(before.dirty)
    expect(after.objects).toBe(before.objects)
    // 且交互已被清空（不是"留着暂存"）
    expect(e.snapshot().contexts['ctx-1'].interaction).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A06 —— 取消
// ─────────────────────────────────────────────────────────────────────────────

describe('A06 cancel：取消零残留', () => {
  it('取消后：暂存清空、文档/历史/脏状态全不变', () => {
    const e = openEditor()
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' })
    e.drain()
    const oid = Object.keys(e.snapshot().docs['doc-1'].scene.objects)[0]
    const before = stateSnapshot(e)

    e.submit({ kind: 'beginInteraction', contextId: 'ctx-1', tool: 'move', targets: [oid] })
    e.submit({ kind: 'updateInteraction', contextId: 'ctx-1', displacement: { x: 9, y: 9, z: 9 } })
    e.drain()
    // 暂存是有效的（有效读面能看到位移）
    expect(e.snapshot().contexts['ctx-1'].interaction?.overrides[oid].position.x).toBe(9)

    const cancel = e.submit({ kind: 'cancelInteraction', contextId: 'ctx-1' })
    e.drain()
    expect(e.settlement(cancel)?.status).toBe('applied')
    expect(e.snapshot().contexts['ctx-1'].interaction, '取消必须清空暂存').toBeNull()
    expect(stateSnapshot(e)).toEqual(before)
  })

  it('取消后租约释放；再次修改需要重新获取（文档级租约可被别的上下文拿到）', () => {
    const e = openEditor()
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block' })
    e.drain()
    const oid = Object.keys(e.snapshot().docs['doc-1'].scene.objects)[0]
    e.submit({ kind: 'beginInteraction', contextId: 'ctx-1', tool: 'move', targets: [oid] })
    e.drain()
    expect(e.snapshot().leases['doc-1'].holder, '交互期间必须持有租约').toBe('ctx-1')
    e.submit({ kind: 'cancelInteraction', contextId: 'ctx-1' })
    e.drain()
    expect(e.snapshot().leases['doc-1'].holder, '取消必须释放租约').toBeNull()
  })

  it('同一事件不启动两次模态操作：重复 begin 被显式拒绝（不静默覆盖）', () => {
    const e = openEditor()
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block' })
    e.drain()
    const oid = Object.keys(e.snapshot().docs['doc-1'].scene.objects)[0]
    e.submit({ kind: 'beginInteraction', contextId: 'ctx-1', tool: 'move', targets: [oid] })
    e.drain()
    const second = e.submit({ kind: 'beginInteraction', contextId: 'ctx-1', tool: 'move', targets: [oid] })
    e.drain()
    const out = e.settlement(second)
    expect(out?.status).toBe('rejected')
    if (out?.status === 'rejected') {
      expect(out.error.code).toBe('InvalidValue')
      expect(out.error.params.reason).toBe('interactionAlreadyActive')
    }
  })

  it('拒绝一次 update（越界视作 InvalidValue）后交互仍在，但暂存回退到起点', () => {
    // 用纯函数层直接构造（命令层暂无"越界"概念；这条测的是 `rejectInteractionUpdate` 的语义）
    const ctx0 = createEditContext('ctx-1', 'doc-1')
    const doc = createDocument('doc-1')
    const scene = addBlockObject(doc.scene, { objectId: 'o1', dataId: 'd1' })!
    const d1 = { ...doc, scene }
    const b = beginInteraction(ctx0, d1, { tool: 'move', targets: ['o1'] })
    expect(b.ok).toBe(true)
    if (!b.ok) return
    const u = updateInteraction(b.value, d1, { displacement: { x: 3, y: 0, z: 0 } })
    expect(u.ok).toBe(true)
    if (!u.ok) return
    expect(u.value.interaction?.overrides['o1'].position.x).toBe(3)
    const rejected = rejectInteractionUpdate(u.value, { code: 'InvalidValue', params: { reason: 'outOfBounds' } })
    expect(rejected.ctx.interaction, '拒绝不得清空交互（#249 §8：诊断可以改变）').not.toBeNull()
    expect(rejected.ctx.interaction?.overrides['o1'], '拒绝后暂存回退到起点').toBeUndefined()
    expect(rejected.error.code).toBe('InvalidValue')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C2 —— 暂存不整文档复制 / 无漂移
// ─────────────────────────────────────────────────────────────────────────────

describe('C2：交互暂存不整文档复制，连续拖动无漂移', () => {
  it('暂存占用只等于**被拖动目标数**，远小于文档对象总数（可测量证据）', () => {
    const e = openEditor()
    for (let i = 0; i < 8; i++) e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: i % 3 === 0 ? 'block' : i % 3 === 1 ? 'annotation' : 'camera' })
    e.drain()
    const s = e.snapshot()
    const ids = Object.keys(s.docs['doc-1'].scene.objects)
    expect(ids.length).toBe(8)

    e.submit({ kind: 'beginInteraction', contextId: 'ctx-1', tool: 'move', targets: [ids[0]] })
    e.submit({ kind: 'updateInteraction', contextId: 'ctx-1', displacement: { x: 1, y: 0, z: 0 } })
    e.drain()

    const footprint = stagingFootprint(e.snapshot().contexts['ctx-1'], e.snapshot().docs['doc-1'])
    expect(footprint.documentObjects).toBe(8)
    expect(footprint.staged, '暂存只覆盖被改动目标（不是整文档）').toBe(1)
    // 结构性证据：未被拖动的对象在文档里**引用不变**（没有被复制/重建）
    const untouchedBefore = s.docs['doc-1'].scene.objects[ids[3]]
    const untouchedAfter = e.snapshot().docs['doc-1'].scene.objects[ids[3]]
    expect(untouchedAfter, '未暂存对象必须保持同一引用（结构共享）').toBe(untouchedBefore)
  })

  it('无漂移：同一总位移重复应用两次，结果相同（起点 + 总位移，不在上一帧上叠加）', () => {
    const e = openEditor()
    const oid = 'o1'
    const scene = addBlockObject(e.snapshot().docs['doc-1'].scene, { objectId: oid, dataId: 'd1' })!
    const seeded = Object.freeze({
      ...e.snapshot(),
      docs: Object.freeze({ ...e.snapshot().docs, 'doc-1': Object.freeze({ ...e.snapshot().docs['doc-1'], scene }) }),
    })
    const e2 = new Editor({ initial: seeded })
    e2.submit({ kind: 'beginInteraction', contextId: 'ctx-1', tool: 'move', targets: [oid] })
    e2.submit({ kind: 'updateInteraction', contextId: 'ctx-1', displacement: { x: 7, y: 0, z: 0 } })
    e2.drain()
    const first = e2.snapshot().contexts['ctx-1'].interaction!.overrides[oid].position.x
    // 同一个总位移再来一次
    e2.submit({ kind: 'updateInteraction', contextId: 'ctx-1', displacement: { x: 7, y: 0, z: 0 } })
    e2.drain()
    const second = e2.snapshot().contexts['ctx-1'].interaction!.overrides[oid].position.x
    expect(first, '第一次 = 起点 0 + 7').toBe(7)
    expect(second, '重复同一总位移不得累加（否则就是漂移）').toBe(7)
  })

  it('无漂移（多次小步累积）：总位移是 5 时结果等于 5，与分几步无关', () => {
    const e = openEditor()
    const oid = 'o1'
    const scene = addBlockObject(e.snapshot().docs['doc-1'].scene, { objectId: oid, dataId: 'd1' })!
    const seeded = Object.freeze({
      ...e.snapshot(),
      docs: Object.freeze({ ...e.snapshot().docs, 'doc-1': Object.freeze({ ...e.snapshot().docs['doc-1'], scene }) }),
    })
    const e2 = new Editor({ initial: seeded })
    e2.submit({ kind: 'beginInteraction', contextId: 'ctx-1', tool: 'move', targets: [oid] })
    for (const x of [1, 2, 3, 4, 5]) e2.submit({ kind: 'updateInteraction', contextId: 'ctx-1', displacement: { x, y: 0, z: 0 } })
    e2.drain()
    expect(e2.snapshot().contexts['ctx-1'].interaction!.overrides[oid].position.x, '位移按"起点+总位移"计算').toBe(5)
    expect(isNetZero(e2.snapshot().contexts['ctx-1']), '总位移非零 ⇒ 不是净零').toBe(false)
  })

  it('提交后内容版本推进、未暂存对象引用保持（结构共享是"提交"而非"重建"）', () => {
    const e = openEditor()
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block' })
      e.drain()
      ids.push(Object.keys(e.snapshot().docs['doc-1'].scene.objects).sort().pop()!)
    }
    const before = e.snapshot()
    const untouchedRef = before.docs['doc-1'].scene.objects[ids[0]]
    e.submit({ kind: 'beginInteraction', contextId: 'ctx-1', tool: 'move', targets: [ids[3]] })
    e.submit({ kind: 'updateInteraction', contextId: 'ctx-1', displacement: { x: 2, y: 0, z: 0 } })
    e.submit({ kind: 'commitInteraction', contextId: 'ctx-1', label: 'move' })
    e.drain()
    const after = e.snapshot()
    expect(after.docs['doc-1'].version.contentVersion).not.toBe(before.docs['doc-1'].version.contentVersion)
    expect(after.docs['doc-1'].scene.objects[ids[0]], '未变对象必须引用同一对象（结构共享）').toBe(untouchedRef)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C3 —— 文档级修改租约
// ─────────────────────────────────────────────────────────────────────────────

describe('C3：跨上下文同文档修改返回 DocumentBusy，观察侧不受影响', () => {
  it('纯函数层：他人持有租约 ⇒ DocumentBusy（不排队）', () => {
    const lease = createLease('doc-1')
    const a = acquireLease(lease, 'ctx-A')
    expect(a.ok).toBe(true)
    if (!a.ok) return
    const b = acquireLease(a.value, 'ctx-B')
    expect(b.ok).toBe(false)
    if (b.ok) return
    expect(b.error.code).toBe('DocumentBusy')
    expect(b.error.params.holder).toBe('ctx-A')
    expect(b.error.params.requester).toBe('ctx-B')
    // 同上下文重入是幂等的（不把自己拒掉）
    const again = acquireLease(a.value, 'ctx-A')
    expect(again.ok).toBe(true)
  })

  it('释放后可被另一上下文获取；非持有者释放是 no-op', () => {
    const lease = createLease('doc-1')
    const a = acquireLease(lease, 'ctx-A')
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(releaseLease(a.value, 'ctx-B'), '非持有者释放不得生效').toBe(a.value)
    const released = releaseLease(a.value, 'ctx-A')
    expect(released.holder).toBeNull()
    const b = acquireLease(released, 'ctx-B')
    expect(b.ok).toBe(true)
  })

  it('文档关闭无条件释放租约（closeLease）', () => {
    const held = acquireLease(createLease('doc-1'), 'ctx-A')
    expect(held.ok).toBe(true)
    if (!held.ok) return
    expect(closeLease(held.value).holder).toBeNull()
  })

  it('集成层：第二个上下文修改返回 DocumentBusy，但**观察不受影响**', () => {
    const e = new Editor()
    e.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-A' })
    e.drain()
    // 显式给第二个上下文绑定同一文档（契约 §6.1：多个工作区默认各有 EditContext，可绑定同一文档）
    const s0 = e.snapshot()
    const ctxB = { ...createEditContext('ctx-B', 'doc-1') }
    const seeded = Object.freeze({ ...s0, contexts: Object.freeze({ ...s0.contexts, 'ctx-B': ctxB }) })
    const e2 = new Editor({ initial: seeded })

    // ctx-A 进入交互持有租约
    e2.submit({ kind: 'addObject', contextId: 'ctx-A', objectType: 'block' })
    e2.drain()
    const oid = Object.keys(e2.snapshot().docs['doc-1'].scene.objects)[0]
    e2.submit({ kind: 'beginInteraction', contextId: 'ctx-A', tool: 'move', targets: [oid] })
    e2.drain()
    expect(e2.snapshot().leases['doc-1'].holder).toBe('ctx-A')

    // ctx-B 尝试修改 ⇒ DocumentBusy
    const blocked = e2.submit({ kind: 'addObject', contextId: 'ctx-B', objectType: 'annotation' })
    e2.drain()
    const out = e2.settlement(blocked)
    expect(out?.status).toBe('rejected')
    if (out?.status === 'rejected') {
      expect(out.error.code).toBe('DocumentBusy')
      expect(out.error.params.holder).toBe('ctx-A')
    }
    // 不静默排队：队列里不得留一条"等以后"的命令
    expect(e2.pending).toBe(0)

    // **观察侧不受影响**：ctx-B 仍能读到文档
    const view = e2.read({ documentId: 'doc-1', contextId: 'ctx-B' })
    const doc = view.workspace.document()
    expect(doc.ok).toBe(true)
    if (doc.ok) expect(doc.value.objectCount).toBe(1)
  })

  it('文档关闭释放租约并取消归属（关闭后该文档的上下文一并移除）', () => {
    const e = openEditor()
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block' })
    e.drain()
    const oid = Object.keys(e.snapshot().docs['doc-1'].scene.objects)[0]
    e.submit({ kind: 'beginInteraction', contextId: 'ctx-1', tool: 'move', targets: [oid] })
    e.drain()
    expect(e.snapshot().leases['doc-1'].holder).toBe('ctx-1')

    const close = e.submit({ kind: 'closeDocument', documentId: 'doc-1' })
    e.drain()
    expect(e.settlement(close)?.status).toBe('applied')
    expect(e.snapshot().docs['doc-1'], '文档已关闭').toBeUndefined()
    expect(e.snapshot().leases['doc-1'], '租约随文档关闭释放').toBeUndefined()
    expect(e.snapshot().contexts['ctx-1'], '归属上下文一并移除（其交互随之消失）').toBeUndefined()

    // 迟到的资源加载回调不得重新激活已关闭的交互（契约 §6.1 负对照）
    const late = e.submit({ kind: 'updateInteraction', contextId: 'ctx-1', displacement: { x: 1, y: 0, z: 0 } })
    e.drain()
    const lateOut = e.settlement(late)
    expect(lateOut?.status, '对已关闭文档的迟到回调必须被拒').toBe('rejected')
    if (lateOut?.status === 'rejected') expect(lateOut.error.code).toBe('MissingTarget')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 内容身份的"非内容版本不得冒充内容变化"
// ─────────────────────────────────────────────────────────────────────────────

describe('C1/C2 前提：非内容版本不得冒充内容变化（契约 §1.4 负对照）', () => {
  it('选择/时间/通道取值变化**不**推进 documentVersion 与 contentVersion', () => {
    const e = openEditor()
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block' })
    e.drain()
    const before = e.snapshot().docs['doc-1'].version
    const oid = Object.keys(e.snapshot().docs['doc-1'].scene.objects)[0]

    for (const cmd of [
      { kind: 'select', contextId: 'ctx-1', target: { kind: 'object', id: oid } } as Command,
      { kind: 'setTime', contextId: 'ctx-1', time: { frame: 12, fps: 24 } } as Command,
      { kind: 'setChannelValue', contextId: 'ctx-1', channel: 'x', value: 2 } as Command,
    ]) {
      const t = e.submit(cmd)
      e.drain()
      expect(e.settlement(t)?.status, `${cmd.kind} 必须 applied（业务确实变了）`).toBe('applied')
      expect(e.snapshot().docs['doc-1'].version.documentVersion, `${cmd.kind} 不得推进内容版本`).toBe(before.documentVersion)
      expect(e.snapshot().docs['doc-1'].version.contentVersion).toBe(before.contentVersion)
    }
  })

  it('撤销回保存内容变干净（dirty 判据是**内容身份**，不是提交计数）', () => {
    const e = openEditor()
    // 保存当前（空）内容作为基线
    const save = e.submit({ kind: 'save', contextId: 'ctx-1' })
    e.drain()
    expect(e.settlement(save)?.status).toBe('applied')
    const seq = e.snapshot().docs['doc-1'].savedSequence + 1
    e.submit({ kind: 'saveCompleted', documentId: 'doc-1', sequence: seq, bindingGeneration: 0, outcome: { kind: 'committed' } })
    e.drain()
    expect(isDirty(e.snapshot().docs['doc-1']), '保存后不脏').toBe(false)

    // 编辑 ⇒ 脏
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' })
    e.drain()
    expect(isDirty(e.snapshot().docs['doc-1']), '编辑后必须脏').toBe(true)

    // 撤销 ⇒ 回到保存内容 ⇒ **干净**（若用单调计数就会在这里判红）
    e.submit({ kind: 'undo', contextId: 'ctx-1' })
    e.drain()
    const doc = e.snapshot().docs['doc-1']
    expect(isDirty(doc), '撤销回实际保存内容必须干净（#249 §8）').toBe(false)
    expect(sameContent(doc.version, doc.saveBaseline)).toBe(true)
    // 且内容身份确实**回到**了保存时的摘要（不是"计数倒退"这种假干净）
    expect(doc.version.contentVersion).toBe(doc.saveBaseline.contentVersion)
  })
})

/** 未使用占位：说明 `digestOf` 是内容身份的唯一算法（避免第二套判据）。 */
describe('内容身份算法单一', () => {
  it('同一场景两种构造路径得到同一摘要（键序无关）', () => {
    const a = { x: 1, y: { p: 2, q: 3 } }
    const b = { y: { q: 3, p: 2 }, x: 1 }
    expect(digestOf(a)).toBe(digestOf(b))
    expect(canonicalize(a)).toBe(canonicalize(b))
  })
})

/** 共享几何前提（写权按数据来源判定，与"是否共享"无关）。 */
describe('共享几何前提（写权按数据来源判定）', () => {
  it('两个对象共享同一数据 ⇒ isDataShared 为真；共享本身**不**影响可写性', () => {
    const base = createDocument('d')
    const s1 = addBlockObject(base.scene, { objectId: 'o1', dataId: 'shared' })!
    expect(isDataShared(s1, 'shared'), '只有一个消费者时不算共享').toBe(false)

    // 构造真正的共享：第二个对象条目指向**同一** dataId
    // （`withObject` 要求同时插入新数据，故共享形态直接由不可变结构拼出）
    const sharedScene = Object.freeze({
      ...s1,
      objects: Object.freeze({ ...s1.objects, o2: sceneObject({ id: 'o2', type: 'block', dataId: 'shared' }) }),
      order: Object.freeze([...s1.order, 'o2']),
    })
    expect(isDataShared(sharedScene, 'shared'), '两个对象引用同一数据 ⇒ 共享').toBe(true)
    // 共享是数据层事实，不影响写权（写权只看 `ObjectData.source`）
    expect(sharedScene.data['shared'].source).toBe('document')
    // 且"共享源"身份可被识别为待分离（#249 §3.2：修改共享源必须为显式操作）
    expect(objectsSharingData(sharedScene, 'shared').map((o) => o.id).sort()).toEqual(['o1', 'o2'])
  })
})

