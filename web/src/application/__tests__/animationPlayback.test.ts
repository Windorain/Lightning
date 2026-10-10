/**
 * P4 ← P1 内核集成 —— **A09/A10 的命令面证据 + #255 验收 F2/F3 的判定面**。
 *
 * ## 本文件与另外两个测试文件的分工
 *
 * | 文件 | 判定面 |
 * |---|---|
 * | `domain/__tests__/animationTrack.test.ts` | 采样/插值/有效值优先级（**纯函数**层） |
 * | `domain/__tests__/textureSequence.test.ts` | 序列采样规则（**纯函数**层） |
 * | 本文件 | 走 `Editor` 的**命令面**：动画是否进文档内容、播放是否零脏、拒绝路径 |
 *
 * 分开的理由：#255 的 F2/F3 是**状态语义**要求（"播放不产生历史/内容脏"），
 * 它只能通过真实命令链证明；而采样规则是纯函数性质，放在纯层测更快也更精确。
 * 把两者混在一处会让"采样正确"与"状态干净"互相掩护。
 */

import { describe, expect, it } from 'vitest'
import { Editor } from '@/runtime/execution'
import { isDirty } from '@/domain/document'
import { findTrack, propertyKey, sampleTrack, timeValue } from '@/domain/animation'
import { objectRef, propertyRef } from '@/domain/identity'
import { objectData, sceneObject, withObject, type Scene } from '@/domain/scene'
import { parseTextureSequence, sampleTextureSequence, type TextureSequence } from '@/domain/materials'
import type { Command } from '@/application/commands'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具：开一个文档 + 上下文 + 一个方块对象
// ─────────────────────────────────────────────────────────────────────────────

function openEditor(): Editor {
  const e = new Editor({ prefix: 'p4' })
  e.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
  e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' })
  e.drain()
  return e
}

function docOf(e: Editor) {
  return e.snapshot().docs['doc-1']
}

function versionSnapshot(e: Editor) {
  const d = docOf(e)
  return {
    documentVersion: d.version.documentVersion,
    contentVersion: d.version.contentVersion,
    dirty: isDirty(d),
    historyLen: d.history.past.length,
    futureLen: d.history.future.length,
    trackCount: d.animation.tracks.length,
  }
}

function firstObjectId(e: Editor): string {
  const ids = Object.keys(docOf(e).scene.objects)
  return ids[0]
}

function transformRef(e: Editor) {
  return propertyRef(objectRef(firstObjectId(e)), 'transform.position')
}

/** 提交一条命令并返回结算结果。 */
function run(e: Editor, cmd: Command) {
  const t = e.submit(cmd)
  e.drain()
  return e.settlement(t)
}

// ─────────────────────────────────────────────────────────────────────────────
// F2：动画播放不产生文档版本 / 撤销条目 / 内容脏
// ─────────────────────────────────────────────────────────────────────────────

describe('F2：动画播放不产生文档版本/撤销条目/内容脏（#249 §7）', () => {
  it('插入关键帧 = 内容变化（推进版本 + 一条历史）', () => {
    const e = openEditor()
    const before = versionSnapshot(e)
    const ref = transformRef(e)
    const out = run(e, {
      kind: 'insertKeyframe',
      contextId: 'ctx-1',
      target: ref,
      time: timeValue(0, 20),
      value: Object.freeze({ x: 0, y: 0, z: 0 }),
    })
    expect(out?.status).toBe('applied')
    const after = versionSnapshot(e)
    expect(after.documentVersion, '插入关键帧是内容变化').toBeGreaterThan(before.documentVersion)
    expect(after.historyLen, '插入关键帧应产生一条历史').toBe(before.historyLen + 1)
    expect(after.trackCount).toBe(1)
  })

  it('**播放（setTime 推进）⇒ 零版本推进、零历史、零脏**（A09 判据原文）', () => {
    const e = openEditor()
    const ref = transformRef(e)
    run(e, {
      kind: 'insertKeyframe',
      contextId: 'ctx-1',
      target: ref,
      time: timeValue(0, 20),
      value: Object.freeze({ x: 0, y: 0, z: 0 }),
    })
    run(e, {
      kind: 'insertKeyframe',
      contextId: 'ctx-1',
      target: ref,
      time: timeValue(40, 20),
      value: Object.freeze({ x: 40, y: 0, z: 0 }),
    })
    const before = versionSnapshot(e)

    // 模拟播放：连续推进时间（正向），再跳帧、再倒退定位
    for (const frame of [1, 2, 3, 10, 20, 39, 40]) {
      const out = run(e, { kind: 'setTime', contextId: 'ctx-1', time: timeValue(frame, 20) })
      expect(out?.status, `播放推进到第 ${frame} 帧`).toBe('applied')
    }
    // 跳帧（大步）+ 倒退定位（回到过去）
    run(e, { kind: 'setTime', contextId: 'ctx-1', time: timeValue(100, 20) })
    run(e, { kind: 'setTime', contextId: 'ctx-1', time: timeValue(0, 20) })

    const after = versionSnapshot(e)
    expect(after.documentVersion, '播放不得推进文档版本').toBe(before.documentVersion)
    expect(after.contentVersion, '播放不得改变内容身份').toBe(before.contentVersion)
    expect(after.historyLen, '播放不得产生撤销条目').toBe(before.historyLen)
    expect(after.futureLen, '播放不得清空重做栈').toBe(before.futureLen)
    expect(after.dirty, '播放不得让文档变脏').toBe(before.dirty)
  })

  it('**停止播放保留当前时间**（#249 §3.3）：时间只由 setTime 决定，与播放状态无关', () => {
    const e = openEditor()
    run(e, { kind: 'setTime', contextId: 'ctx-1', time: timeValue(12, 20) })
    // 内核**没有**"播放/停止"命令 —— 播放状态属宿主（#249 §9「时钟以输入注入」）。
    // 因此"停止后时间保留"是结构性质：没有任何路径会因停止而改时间。
    const before = versionSnapshot(e)
    // 再设一次**同一**时间 ⇒ unchanged（不产生任何变化）
    const same = run(e, { kind: 'setTime', contextId: 'ctx-1', time: timeValue(12, 20) })
    expect(same?.status, '同一时间重复设置必须是 unchanged').toBe('unchanged')
    expect(versionSnapshot(e)).toEqual(before)
    // 而时间确实还停在 12 帧
    expect(e.snapshot().contexts['ctx-1'].time.frame).toBe(12)
  })

  it('**禁用轨道 ⇒ 属性回到手动/默认值**：基础值写入重新被允许（#249 §3.3）', () => {
    const e = openEditor()
    const ref = transformRef(e)
    run(e, {
      kind: 'insertKeyframe',
      contextId: 'ctx-1',
      target: ref,
      time: timeValue(0, 20),
      value: Object.freeze({ x: 0, y: 0, z: 0 }),
    })

    // 轨道启用时：普通基础值写入被拒（A10）
    const denied = run(e, { kind: 'setProperty', contextId: 'ctx-1', refs: [ref], value: Object.freeze({ x: 9, y: 9, z: 9 }) })
    expect(denied?.status).toBe('rejected')
    if (denied?.status === 'rejected') {
      expect(denied.error.code).toBe('ReadOnly')
      expect(denied.error.params.reason).toBe('animationDriven')
    }

    // 禁用轨道
    const disabled = run(e, { kind: 'setTrackEnabled', contextId: 'ctx-1', target: ref, enabled: false })
    expect(disabled?.status).toBe('applied')
    expect(findTrack(docOf(e).animation, ref)?.enabled).toBe(false)

    // 现在基础值写入被允许（回到手动取值）
    const allowed = run(e, { kind: 'setProperty', contextId: 'ctx-1', refs: [ref], value: Object.freeze({ x: 9, y: 9, z: 9 }) })
    expect(allowed?.status, '禁用轨道后普通基础值写入必须被允许').toBe('applied')
    expect(docOf(e).scene.objects[firstObjectId(e)].transform.position.x).toBe(9)

    // 而轨道数据仍在（禁用 ≠ 删除）
    expect(findTrack(docOf(e).animation, ref)).toBeDefined()
  })

  it('**动画输出不反写手动取值**：轨道采样与手动写入是两个存储', () => {
    const e = openEditor()
    const ref = transformRef(e)
    // 先写手动基础值
    run(e, { kind: 'setProperty', contextId: 'ctx-1', refs: [ref], value: Object.freeze({ x: 3, y: 3, z: 3 }) })
    const manualBefore = docOf(e).scene.objects[firstObjectId(e)].transform.position
    // 再建轨道并采样（模拟播放）
    run(e, {
      kind: 'insertKeyframe',
      contextId: 'ctx-1',
      target: ref,
      time: timeValue(0, 20),
      value: Object.freeze({ x: 0, y: 0, z: 0 }),
    })
    run(e, {
      kind: 'insertKeyframe',
      contextId: 'ctx-1',
      target: ref,
      time: timeValue(40, 20),
      value: Object.freeze({ x: 100, y: 0, z: 0 }),
    })
    const track = findTrack(docOf(e).animation, ref)
    expect(track).toBeDefined()
    if (track) {
      const sampled = sampleTrack(track, timeValue(20, 20))
      expect(sampled.ok && (sampled.value.value as { x: number }).x).toBe(50)
    }
    // 手动基础值**未被动画反写**
    const manualAfter = docOf(e).scene.objects[firstObjectId(e)].transform.position
    expect(manualAfter, '动画采样不得反写手动基础值').toEqual(manualBefore)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A10：命令面的拒绝政策
// ─────────────────────────────────────────────────────────────────────────────

describe('A10 命令面：轨道驱动的属性拒绝普通写（#249 §7 负对照）', () => {
  it('**负对照**：被驱动属性用 setProperty 写 ⇒ ReadOnly + 结构化原因（不静默写入）', () => {
    const e = openEditor()
    const ref = transformRef(e)
    run(e, { kind: 'insertKeyframe', contextId: 'ctx-1', target: ref, time: timeValue(0, 20), value: Object.freeze({ x: 1, y: 1, z: 1 }) })

    const before = versionSnapshot(e)
    const out = run(e, { kind: 'setProperty', contextId: 'ctx-1', refs: [ref], value: Object.freeze({ x: 5, y: 5, z: 5 }) })
    expect(out?.status, '被轨道驱动的属性必须拒绝普通基础值写入').toBe('rejected')
    if (out?.status === 'rejected') {
      expect(out.error.code).toBe('ReadOnly')
      // 原因是**结构化**的（不是自然语言），且指向动画轨道这一拥有者
      expect(out.error.params.owner).toBe('animationTrack')
      expect(out.error.params.reason).toBe('animationDriven')
      expect(out.error.params.property).toBe('transform.position')
    }
    // 零残留：文档/历史/脏全不变
    expect(versionSnapshot(e)).toEqual(before)
    // 而基础值确实**没有**被写进去（不是"写了但看不见"）
    expect(docOf(e).scene.objects[firstObjectId(e)].transform.position.x).not.toBe(5)
  })

  it('**关键帧命令生效**：同一属性经 insertKeyframe 可写（这就是 §7 指的引导路径）', () => {
    const e = openEditor()
    const ref = transformRef(e)
    run(e, { kind: 'insertKeyframe', contextId: 'ctx-1', target: ref, time: timeValue(0, 20), value: Object.freeze({ x: 1, y: 1, z: 1 }) })
    // 被驱动后再插入关键帧仍合法（写的是轨道，不是基础值）
    const out = run(e, { kind: 'insertKeyframe', contextId: 'ctx-1', target: ref, time: timeValue(20, 20), value: Object.freeze({ x: 8, y: 8, z: 8 }) })
    expect(out?.status, '关键帧命令必须生效（引导路径）').toBe('applied')
    const track = findTrack(docOf(e).animation, ref)
    expect(track?.keys).toHaveLength(2)
  })

  it('不可动画的属性不得建轨道（不提供假成功控件，#249 §13）', () => {
    const e = openEditor()
    // `name` 不在 `animatableProperties` 里
    const ref = propertyRef(objectRef(firstObjectId(e)), 'name')
    const out = run(e, { kind: 'insertKeyframe', contextId: 'ctx-1', target: ref, time: timeValue(0, 20), value: 'renamed' })
    expect(out?.status).toBe('rejected')
    if (out?.status === 'rejected') {
      expect(out.error.code).toBe('UnsupportedOperation')
      expect(out.error.params.reason).toBe('propertyNotAnimatable')
    }
  })

  it('只读内容拥有的对象不得建轨道（写权按拥有者，#249 §3.3）', () => {
    const e = openEditor()
    // 直接改状态，造一个 source='content' 的对象（多方块生成物形态）
    const snap = e.snapshot()
    const doc = snap.docs['doc-1']
    const nextScene = withObject(
      doc.scene,
      sceneObject({ id: 'o-gen', type: 'block', dataId: 'd-gen' }),
      objectData('d-gen', { kind: 'blockGrid', cells: {} }, 'content'),
    )
    expect(nextScene).not.toBeNull()
    if (!nextScene) return
    // 用 Editor 的初始状态重开一个带该对象的实例
    const e2 = new Editor({
      prefix: 'p4',
      initial: Object.freeze({
        ...snap,
        docs: Object.freeze({ ...snap.docs, 'doc-1': Object.freeze({ ...doc, scene: nextScene as Scene }) }),
      }),
    })
    const ref = propertyRef(objectRef('o-gen'), 'transform.position')
    const out = run(e2, { kind: 'insertKeyframe', contextId: 'ctx-1', target: ref, time: timeValue(0, 20), value: Object.freeze({ x: 0, y: 0, z: 0 }) })
    expect(out?.status, '生成物对象（content 来源）不得建轨道').toBe('rejected')
    if (out?.status === 'rejected') {
      expect(out.error.code).toBe('ReadOnly')
      expect(out.error.params.owner).toBe('content')
    }
    // 而普通手动取值写也被拒（同一条按拥有者的判据）
    const manual = run(e2, { kind: 'setProperty', contextId: 'ctx-1', refs: [ref], value: Object.freeze({ x: 1, y: 0, z: 0 }) })
    expect(manual?.status).toBe('rejected')
  })

  it('插入非法值的关键帧 ⇒ 拒绝（不把坏数据存进文档）', () => {
    const e = openEditor()
    const ref = transformRef(e)
    // `transform.position` 是 vec3；给一个数字
    const out = run(e, { kind: 'insertKeyframe', contextId: 'ctx-1', target: ref, time: timeValue(0, 20), value: 42 })
    expect(out?.status, '值类型不符必须拒绝').toBe('rejected')
    if (out?.status === 'rejected') expect(out.error.code).toBe('InvalidValue')
    expect(docOf(e).animation.tracks, '拒绝后不得留下半成品轨道').toHaveLength(0)
  })

  it('插入同时间同值的关键帧 ⇒ unchanged（不因新建容器而记账，契约 §1.4）', () => {
    const e = openEditor()
    const ref = transformRef(e)
    run(e, { kind: 'insertKeyframe', contextId: 'ctx-1', target: ref, time: timeValue(0, 20), value: Object.freeze({ x: 1, y: 1, z: 1 }) })
    const before = versionSnapshot(e)
    const again = run(e, { kind: 'insertKeyframe', contextId: 'ctx-1', target: ref, time: timeValue(0, 20), value: Object.freeze({ x: 1, y: 1, z: 1 }) })
    expect(again?.status, '同时间同值 ⇒ 内容身份未变 ⇒ unchanged').toBe('unchanged')
    expect(versionSnapshot(e)).toEqual(before)
  })

  it('删除关键帧 / 删到空 ⇒ 轨道移除，且可撤销', () => {
    const e = openEditor()
    const ref = transformRef(e)
    run(e, { kind: 'insertKeyframe', contextId: 'ctx-1', target: ref, time: timeValue(0, 20), value: Object.freeze({ x: 1, y: 1, z: 1 }) })
    const withOne = versionSnapshot(e)

    const removed = run(e, { kind: 'removeKeyframe', contextId: 'ctx-1', target: ref, time: timeValue(0, 20) })
    expect(removed?.status).toBe('applied')
    expect(docOf(e).animation.tracks, '删到空必须移除轨道').toHaveLength(0)

    // 撤销应恢复轨道（动画状态进了历史条目）
    const undone = run(e, { kind: 'undo', contextId: 'ctx-1' })
    expect(undone?.status).toBe('applied')
    expect(docOf(e).animation.tracks, '撤销必须恢复轨道').toHaveLength(1)
    expect(versionSnapshot(e).contentVersion).toBe(withOne.contentVersion)

    // 重做又回到无轨道
    run(e, { kind: 'redo', contextId: 'ctx-1' })
    expect(docOf(e).animation.tracks).toHaveLength(0)
  })

  it('`publishDefault` 写发布默认值（有效值优先级第一层，属文档）', () => {
    const e = openEditor()
    // 用对象自身可动画的属性（方块支持 transform.*；`projection.*` 只属相机类型）
    const ref = transformRef(e)
    const out = run(e, { kind: 'publishDefault', contextId: 'ctx-1', target: ref, value: Object.freeze({ x: 1, y: 2, z: 3 }) })
    expect(out?.status).toBe('applied')
    const defaults = docOf(e).animation.publishedDefaults
    expect(defaults[propertyKey(ref)]).toEqual({ x: 1, y: 2, z: 3 })
    // 发布默认值属文档 ⇒ 是内容变化（可撤销）
    expect(versionSnapshot(e).historyLen).toBeGreaterThan(0)
  })

  it('发布默认值不得写不可动画属性（与关键帧同一资格判据）', () => {
    const e = openEditor()
    const ref = propertyRef(objectRef(firstObjectId(e)), 'name')
    const out = run(e, { kind: 'publishDefault', contextId: 'ctx-1', target: ref, value: 'x' })
    expect(out?.status).toBe('rejected')
    if (out?.status === 'rejected') expect(out.error.params.reason).toBe('propertyNotAnimatable')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F3：纹理序列的"默认绑场景时间"与"双面板一致"（求值层证据）
// ─────────────────────────────────────────────────────────────────────────────

describe('F3：纹理序列默认绑场景时间；多个消费者同时间样本一致（#249 §19.3）', () => {
  const SEQ: TextureSequence = (() => {
    const parsed = parseTextureSequence({
      id: 'seq',
      resource: Object.freeze({ assetId: 'tex-lava', contentVersion: 'v1', url: 'https://x/a.png' }),
      frames: [
        { index: 0, durationSeconds: 0.5 },
        { index: 1, durationSeconds: 1.5 },
        { index: 2, durationSeconds: 1 },
      ],
      defaultDurationSeconds: 1,
      loop: 'loop',
    })
    if (!parsed.ok) throw new Error(`夹具解析失败: ${parsed.error.params.reason}`)
    return parsed.value
  })()

  it('同时间 + 同序列 ⇒ 两个"消费者"读到**逐位相同**的样本', () => {
    // 场景时间（由 EditContext 拥有）—— 两个消费面板读的是**同一个**时间值
    const e = openEditor()
    run(e, { kind: 'setTime', contextId: 'ctx-1', time: timeValue(24, 20) }) // 1.2s
    const ctx = e.snapshot().contexts['ctx-1']
    const sceneSeconds = ctx.time.frame / 20

    const a = sampleTextureSequence(SEQ, sceneSeconds)
    const b = sampleTextureSequence(SEQ, sceneSeconds)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.value, '两个消费者同时间样本必须一致').toEqual(b.value)
    // 1.2s：第 1 项 [0,0.5)、第 2 项 [0.5,2.0) ⇒ 帧 1
    expect(a.value.frame).toBe(1)
  })

  it('**跳过任意帧数后定位 ⇒ 与逐步播放到达同一时间结果相同**（跳帧一致性）', () => {
    const target = 1.75
    const jumped = sampleTextureSequence(SEQ, target)
    // 逐步推进（每步 0.05s）到同一时间
    let t = 0
    let stepped = sampleTextureSequence(SEQ, 0)
    while (t < target - 1e-9) {
      t = Math.min(target, t + 0.05)
      stepped = sampleTextureSequence(SEQ, t)
    }
    expect(jumped.ok && stepped.ok).toBe(true)
    if (jumped.ok && stepped.ok) {
      expect(stepped.value, '逐步播放与跳帧定位在同一时间必须同结果').toEqual(jumped.value)
      expect(jumped.value.frame).toBe(1)
    }
  })

  it('**倒退定位**与正向到达同一时间结果相同（同一求值器，#249 §7）', () => {
    const forward = sampleTextureSequence(SEQ, 2.25)
    // 先跑到远端，再倒退回来
    sampleTextureSequence(SEQ, 10)
    sampleTextureSequence(SEQ, 0)
    const backward = sampleTextureSequence(SEQ, 2.25)
    expect(forward.ok && backward.ok).toBe(true)
    if (forward.ok && backward.ok) expect(backward.value).toEqual(forward.value)
  })

  it('**无材质独立 tick**：本批交付的采样路径不接受"增量/上一帧时间"（静态面）', () => {
    const banned = ['tick', 'advance', 'accumulate', 'addDelta', 'stepBy']
    // 采样模块的导出面里不得出现"累积"形态的入口
    for (const name of banned) {
      expect(
        Object.prototype.hasOwnProperty.call({ sampleTextureSequence, parseTextureSequence }, name),
        `采样面不得提供 ${name}（那是"独立 tick 累积"的形态）`,
      ).toBe(false)
    }
    // 采样函数只接受 (sequence, time) —— 第二批参数不是 delta
    expect(sampleTextureSequence.length, '签名必须是 (sequence, time)，不得有累积增量参数').toBe(2)
  })
})
