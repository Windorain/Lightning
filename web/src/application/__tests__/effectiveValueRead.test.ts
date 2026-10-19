/**
 * **有效值读面**（`application/queries.ts#queryEffectiveProperty`）——
 * A10 的**读侧**证据 + R-WK-01「#4 的通道取值侧」归口的可执行验收。
 *
 * ## 为什么读侧需要单独的测试
 *
 * 写侧（拒绝普通基础值写入）已经有测试（`animationPlayback.test.ts`）。
 * 但"有效值优先级"（#249 §7）是一条**读**语义：
 * 「文档基础值 → 手动预览 → 轨道采样 → 暂存覆盖」。
 * 只测写入拒绝会让"读出来的是哪一层"完全没有被钉住 —— 而两个视口一致（A05）
 * 靠的正是这一层。
 *
 * ## 本文件与 `animationPlayback.test.ts` 的分工
 *
 * | 文件 | 面 |
 * |---|---|
 * | `animationPlayback.test.ts` | 写面（命令结果、零残留、历史） |
 * | 本文件 | 读面（四层优先级、两视口一致、无值时不冒充） |
 */

import { describe, expect, it } from 'vitest'
import { Editor } from '@/runtime/execution'
import { objectRef, propertyRef } from '@/domain/identity'
import { propertyKey, timeValue } from '@/domain/animation'
import { channelStepTrack, resolveChannelEffective, type ChannelSet } from '@/domain/multiblock'
import { withChannelValue } from '@/domain/editing'
import type { ApplicationState } from '@/application/state'

/** 供通道对照用例的通道集（声明在**内容**侧，故不经内核对象类型注册）。 */
const CHANNEL_SET: ChannelSet = Object.freeze({
  id: 'mb-1',
  channels: Object.freeze([
    Object.freeze({
      key: 'tier',
      name: 'Tier',
      domain: Object.freeze({ kind: 'integer' as const, min: 0, max: 5 }),
      source: 'content' as const,
    }),
  ]),
})

function openEditor(): Editor {
  const e = new Editor({ prefix: 'p4q' })
  e.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
  e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' })
  e.drain()
  return e
}

function firstObjectId(e: Editor): string {
  return Object.keys(e.snapshot().docs['doc-1'].scene.objects)[0]
}

/** 用一份给定状态重建实例（`Editor` 不暴露"替换状态"的公开接口 —— 这本身是对的）。 */
function withState(e: Editor, next: ApplicationState): Editor {
  void e
  return new Editor({ prefix: 'p4q', initial: next })
}

/** 读有效值（走 `ReadView.interaction.effectiveProperty`）。 */
function effective(e: Editor, ref = propertyRef(objectRef(firstObjectId(e)), 'block.transform.position')) {
  const view = e.read({ documentId: 'doc-1', contextId: 'ctx-1' })
  return view.interaction.effectiveProperty(ref)
}

describe('有效值读面：四层优先级（#249 §7）', () => {
  it('只有基础值 ⇒ 返回基础值，source=base', () => {
    const e = openEditor()
    const r = effective(e)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.source).toBe('base')
    expect(r.value.driven).toBe(false)
    expect(r.value.value).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('有轨道 ⇒ 轨道采样赢（source=trackSample），且 driven=true', () => {
    const e = openEditor()
    const ref = propertyRef(objectRef(firstObjectId(e)), 'block.transform.position')
    e.submit({ kind: 'insertKeyframe', contextId: 'ctx-1', target: ref, time: timeValue(0, 20), value: Object.freeze({ x: 0, y: 0, z: 0 }) })
    e.submit({ kind: 'insertKeyframe', contextId: 'ctx-1', target: ref, time: timeValue(40, 20), value: Object.freeze({ x: 40, y: 0, z: 0 }) })
    e.submit({ kind: 'setTime', contextId: 'ctx-1', time: timeValue(20, 20) })
    e.drain()

    const r = effective(e, ref)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.source, '轨道启用时轨道采样必须赢').toBe('trackSample')
    expect(r.value.driven).toBe(true)
    expect((r.value.value as { x: number }).x).toBeCloseTo(20, 10)
  })

  it('**两个上下文读同一份有效值**（A05 的读面结构保证：接口里没有"视口"参数）', () => {
    const e = openEditor()
    const ref = propertyRef(objectRef(firstObjectId(e)), 'block.transform.position')
    e.submit({ kind: 'insertKeyframe', contextId: 'ctx-1', target: ref, time: timeValue(0, 20), value: Object.freeze({ x: 0, y: 0, z: 0 }) })
    e.submit({ kind: 'insertKeyframe', contextId: 'ctx-1', target: ref, time: timeValue(40, 20), value: Object.freeze({ x: 80, y: 0, z: 0 }) })
    e.submit({ kind: 'beginInteraction', contextId: 'ctx-1', tool: 'move', targets: [firstObjectId(e)] })
    e.submit({ kind: 'updateInteraction', contextId: 'ctx-1', displacement: Object.freeze({ x: 5, y: 0, z: 0 }) })
    e.submit({ kind: 'setTime', contextId: 'ctx-1', time: timeValue(20, 20) })
    e.drain()

    // 同一个 EditContext 被两个"A area"调用 —— 两次调用必须逐位相同
    const a = effective(e, ref)
    const b = effective(e, ref)
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.value, '两视口读同一份有效值（接口层无"视口"概念）').toEqual(b.value)
      // 暂存覆盖是最高层 ⇒ 它赢，且值 = 起点 + 总位移（+ 轨道不影响暂存层）
      expect(a.value.source).toBe('stagingOverride')
    }
  })

  it('禁用轨道 ⇒ 退回基础值（source=base），driven=false（#249 §3.3）', () => {
    const e = openEditor()
    const ref = propertyRef(objectRef(firstObjectId(e)), 'block.transform.position')
    e.submit({ kind: 'insertKeyframe', contextId: 'ctx-1', target: ref, time: timeValue(0, 20), value: Object.freeze({ x: 7, y: 0, z: 0 }) })
    e.submit({ kind: 'setTrackEnabled', contextId: 'ctx-1', target: ref, enabled: false })
    e.drain()

    const r = effective(e, ref)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.source, '禁用轨道后必须回到基础值').toBe('base')
    expect(r.value.driven).toBe(false)
    expect((r.value.value as { x: number }).x, '轨道值不得泄漏到基础层').toBe(0)
  })

  it('发布默认值：基础值缺席时作为第一层；基础值在场时**不**覆盖它', () => {
    const e0 = openEditor()
    const ref = propertyRef(objectRef(firstObjectId(e0)), 'block.transform.position')
    // 场景里 `transform.position` 有基础值（零向量）⇒ 发布默认值不覆盖
    const s = e0.snapshot()
    const doc = s.docs['doc-1']
    const withDefault: ApplicationState = Object.freeze({
      ...s,
      docs: Object.freeze({
        ...s.docs,
        'doc-1': Object.freeze({ ...doc, animation: Object.freeze({ ...doc.animation, publishedDefaults: Object.freeze({ [propertyKey(ref)]: Object.freeze({ x: 99, y: 99, z: 99 }) }) }) }),
      }),
    })
    const e = withState(e0, withDefault)
    const r = effective(e, ref)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.source, '基础值在场时它仍是第一层（发布默认值是缺省填充，不是覆盖）').toBe('base')
    expect((r.value.value as { x: number }).x).toBe(0)
  })

  it('**无值时不冒充**：既无基础值、无轨道、无默认值 ⇒ MissingTarget（契约 §3.1）', () => {
    const e = openEditor()
    // `projection.fov` 只属相机类型；方块对象没有它
    const ref = propertyRef(objectRef(firstObjectId(e)), 'projection.fov')
    const r = effective(e, ref)
    expect(r.ok, '读面不得用默认值冒充有值').toBe(false)
    if (!r.ok) expect(r.error.code).toBe('MissingTarget')
  })

  it('**通道不冒充内核属性**：`channel.*` 不经 RNA 读面服务（它属内容拥有者，走 `resolveChannelEffective`）', () => {
    const e0 = openEditor()
    const s = e0.snapshot()
    const patched: ApplicationState = Object.freeze({
      ...s,
      contexts: Object.freeze({ ...s.contexts, 'ctx-1': withChannelValue(s.contexts['ctx-1'], 'tier', 3) }),
    })
    const e = withState(e0, patched)

    // ## 为什么这里断言的是"拒绝"而不是"返回 3"
    //
    // P4 开发期这里曾断言 `source === 'manualPreview'` 且值为 3 —— 那时本读面把
    // `ctx.channelValues` 接进 RNA 的 `preview` 层。GF-5 收敛后该做法**不成立**：
    // RNA 的描述按 `objectTypeId` 解析，而**通道的拥有者是内容**（`objectData`，
    // 多方块生成物），不是内核注册对象类型 —— 给它伪造一条注册就等于
    // "编辑生成结果"，#249 §3.3 明文禁止。
    //
    // ⇒ 通道的有效值由 `domain/multiblock#resolveChannelEffective` 提供：
    // 它接上四层（含通道手动预览），且**共用同一张优先级表**
    // （`domain/animation#resolveEffectiveValue` 的 `LAYER_RANK`）。
    // 本读面**如实拒绝**，不返回一个"看起来对"的值（#249 §13 禁止假成功）。
    const ref = propertyRef(objectRef(firstObjectId(e)), 'channel.tier')
    const r = effective(e, ref)
    expect(r.ok, '通道不是内核属性，本读面必须如实拒绝').toBe(false)
    if (!r.ok) expect(['MissingTarget', 'UnsupportedOperation']).toContain(r.error.code)
  })

  it('通道有效值由 `resolveChannelEffective` 提供，且与 RNA 读面**共用同一张优先级表**', () => {
    // 这条是上一条的正向对照（证明"移交"不是"缺失"）：同一份 `ctx.channelValues`
    // 经通道解析器能取到值，且来源标签来自**同一个** `LAYER_RANK`。
    const tier = resolveChannelEffective({ manualPreview: 3 })
    expect(tier.ok).toBe(true)
    if (tier.ok) {
      expect(tier.value.value).toBe(3)
      expect(tier.value.source, '来源标签由 domain/animation 的优先级表给出').toBe('manualPreview')
    }
    // 轨道采样胜手动预览（rank 2 > 1）—— 与 RNA 读面的层序完全一致
    const track = channelStepTrack(CHANNEL_SET, 'tier', [
      { time: timeValue(0, 20), value: 0 },
      { time: timeValue(20, 20), value: 9 },
    ])
    expect(track.ok).toBe(true)
    if (track.ok) {
      const withTrack = resolveChannelEffective({ manualPreview: 3, track: track.value, time: timeValue(20, 20) })
      expect(withTrack.ok).toBe(true)
      if (withTrack.ok) {
        expect(withTrack.value.value, '轨道采样必须赢过手动预览（与 RNA 层序一致）').toBe(9)
        expect(withTrack.value.source).toBe('trackSample')
      }
    }
  })

  it('`readProperty(mode:\'effective\')` 与 `effectiveProperty` 一致（同一实现点）', () => {
    const e = openEditor()
    const ref = propertyRef(objectRef(firstObjectId(e)), 'block.transform.position')
    e.submit({ kind: 'insertKeyframe', contextId: 'ctx-1', target: ref, time: timeValue(0, 20), value: Object.freeze({ x: 0, y: 0, z: 0 }) })
    e.submit({ kind: 'insertKeyframe', contextId: 'ctx-1', target: ref, time: timeValue(20, 20), value: Object.freeze({ x: 20, y: 0, z: 0 }) })
    e.submit({ kind: 'setTime', contextId: 'ctx-1', time: timeValue(10, 20) })
    e.drain()

    const view = e.read({ documentId: 'doc-1', contextId: 'ctx-1' })
    const viaRead = view.properties.read(ref, 'effective')
    const viaEffective = view.interaction.effectiveProperty(ref)
    expect(viaRead.ok && viaEffective.ok).toBe(true)
    if (viaRead.ok && viaEffective.ok) {
      expect(viaRead.value, '两条读路径必须给出同一结果（不得各有一套优先级）').toEqual(viaEffective.value.value)
      expect((viaRead.value as { x: number }).x).toBeCloseTo(10, 10)
    }
    // `authored` 仍是基础值（写面语义），不受轨道影响
    const authored = view.properties.read(ref, 'authored')
    expect(authored.ok && (authored.value as { x: number }).x, 'authored 必须是基础值').toBe(0)
  })
})
