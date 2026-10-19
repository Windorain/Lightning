/**
 * `domain/selection` —— **选择模式的类型化目标引用与模式切换纯规则**
 * （#249 §19.2 末段；契约 §1.2）。
 *
 * ## 要证的语义
 *
 * > 「对象/顶点等选择模式具有**类型化目标引用**；切模式按**显式纯规则**转换**或保留
 * > 各模式选择**，**不把顶点集合伪装为对象列表**」。
 *
 * 本实现选**保留**（{@link SelectionSet.byMode}），并额外提供**显式**转换。故这里
 * 同时验证两件互不冲突的事：
 *  1. 往返幂等（保留路径）；
 *  2. 转换是查询、不覆盖保留状态（转换路径）。
 *
 * ## 负对照
 *
 * 「把顶点集合伪装为对象列表」的形态是：**丢掉 `topologyVersion`**，只留
 * `{ kind, id }`。本文件用 `stripVersion` 变异实现证明：去掉版本后，
 * "同一顶点引用"的相等判定会**错误地**把"拓扑变更前后的同名元素"判为同一个 ——
 * 这正是要判红的形态。
 */

import { describe, expect, it } from 'vitest'
import {
  AVAILABLE_SELECTION_MODES,
  clearCurrentMode,
  composeSelectionMode,
  currentTargets,
  elementTargetOwner,
  emptySelectionSet,
  isModeAvailable,
  objectTarget,
  pruneStaleElements,
  sameTarget,
  selectTarget,
  selectedObjectIds,
  selectedObjectsOf,
  splitSelectionMode,
  switchMode,
  vertexTarget,
  vertexTargetIn,
  type SelectionSet,
  type SelectionTarget,
} from '@/domain/selection'
import { addMeshObject, createDocument } from '@/domain/document'
import type { Scene } from '@/domain/scene'
import { elementRef, objectRef, type ElementRef } from '@/domain/identity'

function sceneWithTwoMeshes(): Scene {
  const base = createDocument('doc-1').scene
  const a = addMeshObject(base, { objectId: 'A', dataId: 'gA', size: 1 })
  if (!a.ok) throw new Error('fixture')
  const b = addMeshObject(a.value, { objectId: 'B', dataId: 'gB', size: 1 })
  if (!b.ok) throw new Error('fixture')
  return b.value
}

// ─────────────────────────────────────────────────────────────────────────────

describe('选择模式：类型化目标引用（元素引用**必须**带拓扑版本）', () => {
  it('对象与顶点选择是**不同**的判别分支，各有自己的目标类型', () => {
    const obj = objectRef('A')
    const vert = vertexTarget('A', 'gA', elementRef('x0y0z0', 0))
    expect(obj.kind).toBe('object')
    expect(vert.kind).toBe('vertex')
    // 顶点目标**必须**带 element（含 topologyVersion）—— 类型上强制。
    // 判别联合需要先窄化才能读到 `element`，这本身就是"不把顶点当对象"的类型级证明。
    expect(vert.kind === 'vertex' && vert.element.topologyVersion).toBe(0)
    expect(elementTargetOwner(vert)).toEqual({ objectId: 'A', dataId: 'gA' })
    expect(elementTargetOwner(objectTarget(obj))).toBeNull()
  })

  it('**不把顶点集合伪装为对象列表**：往顶点模式塞对象目标 ⇒ 拒绝', () => {
    const s = emptySelectionSet('vertex')
    const r = selectTarget(s, objectTarget(objectRef('A')))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.params.reason).toBe('targetKindMismatch')
    expect(r.error.params.mode).toBe('vertex')
    expect(r.error.params.targetKind).toBe('object')
  })

  it('反向同样拒绝：往对象模式塞顶点目标', () => {
    const s = emptySelectionSet('object')
    const r = selectTarget(s, vertexTarget('A', 'gA', elementRef('x', 0)))
    expect(r.ok).toBe(false)
  })

  it('`vertexTargetIn` 从网格拓扑取**正确**的拓扑版本（调用方拿不到"无版本"引用）', () => {
    const scene = sceneWithTwoMeshes()
    const r = vertexTargetIn(scene, 'A', 'gA', 'x0y0z0')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.kind).toBe('vertex')
    if (r.value.kind !== 'vertex') return
    expect(r.value.element.topologyVersion).toBe(0)
    // 不存在的顶点 ⇒ 显式拒绝
    expect(vertexTargetIn(scene, 'A', 'gA', 'nope').ok).toBe(false)
    // 不存在的网格 ⇒ 显式拒绝
    expect(vertexTargetIn(scene, 'A', 'nope', 'x0y0z0').ok).toBe(false)
  })

  it('相等判定是**值语义**且含版本：同一元素不同拓扑版本 ⇒ 不相等', () => {
    const a = vertexTarget('A', 'gA', elementRef('x0y0z0', 0))
    const aSame = vertexTarget('A', 'gA', elementRef('x0y0z0', 0))
    const aStale = vertexTarget('A', 'gA', elementRef('x0y0z0', 1))
    const b = vertexTarget('B', 'gA', elementRef('x0y0z0', 0))
    expect(sameTarget(a, aSame)).toBe(true)
    expect(sameTarget(a, aStale), '版本不同 ⇒ 不是同一引用（E1 的核心）').toBe(false)
    expect(sameTarget(a, b)).toBe(false)
    expect(sameTarget(objectTarget(objectRef('A')), objectTarget(objectRef('A')))).toBe(true)
    expect(sameTarget(objectTarget(objectRef('A')), vertexTarget('A', 'gA', elementRef('x', 0)))).toBe(false)
  })
})

describe('模式切换：**保留各模式选择**（往返幂等）', () => {
  it('对象 → 顶点 → 对象 往返后，对象选择**原样回来**', () => {
    let s = emptySelectionSet('object')
    const sel = selectTarget(s, objectTarget(objectRef('A')))
    expect(sel.ok).toBe(true)
    if (!sel.ok) return
    s = sel.value
    const sel2 = selectTarget(s, objectTarget(objectRef('B')), { additive: true })
    if (!sel2.ok) return
    s = sel2.value
    expect(selectedObjectIds(s)).toEqual(['A', 'B'])

    const toVertex = switchMode(s, 'vertex')
    expect(toVertex.ok).toBe(true)
    if (!toVertex.ok) return
    expect(currentTargets(toVertex.value), '顶点模式初始为空（不丢也不伪造）').toEqual([])
    expect(selectedObjectIds(toVertex.value), '对象选择**保留**在另一维度').toEqual(['A', 'B'])

    const back = switchMode(toVertex.value, 'object')
    if (!back.ok) return
    expect(selectedObjectIds(back.value), '往返幂等').toEqual(['A', 'B'])
  })

  it('顶点选择也可跨模式往返保留', () => {
    let s = emptySelectionSet('vertex')
    const v = selectTarget(s, vertexTarget('A', 'gA', elementRef('x0y0z0', 0)))
    if (!v.ok) return
    s = v.value
    const toObj = switchMode(s, 'object')
    if (!toObj.ok) return
    const back = switchMode(toObj.value, 'vertex')
    if (!back.ok) return
    expect(currentTargets(back.value).length).toBe(1)
    expect(sameTarget(currentTargets(back.value)[0], vertexTarget('A', 'gA', elementRef('x0y0z0', 0)))).toBe(true)
  })

  it('切到**不可用**模式（边/面）⇒ 显式拒绝（不"切过去但空着"）', () => {
    const s = emptySelectionSet('object')
    for (const mode of ['edge', 'face'] as const) {
      expect(isModeAvailable(mode), `${mode} 本批不可用`).toBe(false)
      const r = switchMode(s, mode)
      expect(r.ok, `${mode} 必须显式拒绝（#249 §13 禁止假成功）`).toBe(false)
      if (r.ok) continue
      expect(r.error.params.reason).toBe('modeNotAvailable')
    }
    expect(AVAILABLE_SELECTION_MODES).toEqual(['object', 'vertex'])
  })

  it('切到当前模式是幂等 no-op（同一引用）', () => {
    const s = emptySelectionSet('object')
    const r = switchMode(s, 'object')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toBe(s)
  })

  it('`clearCurrentMode` 只清当前模式，**不**动其它模式的选择', () => {
    let s = emptySelectionSet('object')
    const o = selectTarget(s, objectTarget(objectRef('A')))
    if (!o.ok) return
    s = o.value
    const toV = switchMode(s, 'vertex')
    if (!toV.ok) return
    s = toV.value
    const v = selectTarget(s, vertexTarget('A', 'gA', elementRef('x0y0z0', 0)))
    if (!v.ok) return
    s = v.value
    const cleared = clearCurrentMode(s)
    expect(currentTargets(cleared)).toEqual([])
    expect(selectedObjectIds(cleared), '对象选择保留').toEqual(['A'])
  })

  it('加性选择里重复点击同一项 = 取消该项（可预期的切换语义）', () => {
    let s = emptySelectionSet('object')
    const a = selectTarget(s, objectTarget(objectRef('A')), { additive: true })
    if (!a.ok) return
    s = a.value
    const b = selectTarget(s, objectTarget(objectRef('B')), { additive: true })
    if (!b.ok) return
    s = b.value
    expect(selectedObjectIds(s)).toEqual(['A', 'B'])
    const again = selectTarget(s, objectTarget(objectRef('A')), { additive: true })
    if (!again.ok) return
    expect(selectedObjectIds(again.value)).toEqual(['B'])
  })

  it('非加性选择替换当前选择；`active` 跟随最后选中项', () => {
    let s = emptySelectionSet('object')
    const a = selectTarget(s, objectTarget(objectRef('A')))
    if (!a.ok) return
    s = a.value
    expect(s.active).toEqual(objectTarget(objectRef('A')))
    const b = selectTarget(s, objectTarget(objectRef('B')))
    if (!b.ok) return
    expect(selectedObjectIds(b.value)).toEqual(['B'])
    expect(b.value.active).toEqual(objectTarget(objectRef('B')))
  })
})

describe('显式转换（**不覆盖**保留状态）', () => {
  it('`selectedObjectsOf` 由顶点选择推导对象集合，且**不**改对象维度', () => {
    const set: SelectionSet = Object.freeze({
      mode: 'vertex',
      byMode: Object.freeze({
        object: Object.freeze([objectTarget(objectRef('Z'))]),
        vertex: Object.freeze([
          vertexTarget('A', 'gA', elementRef('v1', 0)),
          vertexTarget('A', 'gA', elementRef('v2', 0)),
          vertexTarget('B', 'gB', elementRef('v3', 0)),
        ]),
        edge: Object.freeze([]),
        face: Object.freeze([]),
      }),
      active: null,
    })
    expect(selectedObjectsOf(set), '去重且排序稳定').toEqual(['A', 'B'])
    // 对象维度**未**被改写（转换是查询）
    expect(selectedObjectIds(set)).toEqual(['Z'])
  })
})

describe('E1：拓扑失效的顶点选择被剔除并**报告**（不静默丢弃）', () => {
  it('拓扑版本过期 ⇒ 从选择里剔除，且出现在 `dropped` 里', () => {
    const scene = sceneWithTwoMeshes()
    const good = vertexTarget('A', 'gA', elementRef('x0y0z0', 0))
    const stale = vertexTarget('A', 'gA', elementRef('x0y0z0', 7))
    const set: SelectionSet = Object.freeze({
      mode: 'vertex',
      byMode: Object.freeze({ object: Object.freeze([]), vertex: Object.freeze([good, stale]), edge: Object.freeze([]), face: Object.freeze([]) }),
      active: stale,
    })
    const { selection, dropped } = pruneStaleElements(scene, set)
    expect(currentTargets(selection).length, '只留有效项').toBe(1)
    expect(sameTarget(currentTargets(selection)[0], good)).toBe(true)
    expect(dropped.length, '被剔除的项必须**报告**').toBe(1)
    expect(sameTarget(dropped[0], stale)).toBe(true)
    expect(selection.active, '失效项作为 active 时被清空').toBeNull()
  })

  it('元素不存在（版本对）也被剔除（不只是版本判定）', () => {
    const scene = sceneWithTwoMeshes()
    const ghost = vertexTarget('A', 'gA', elementRef('no-such-vertex', 0))
    const set = Object.freeze({
      mode: 'vertex' as const,
      byMode: Object.freeze({ object: Object.freeze([]), vertex: Object.freeze([ghost]), edge: Object.freeze([]), face: Object.freeze([]) }),
      active: null,
    })
    const { dropped } = pruneStaleElements(scene, set)
    expect(dropped.length).toBe(1)
  })

  it('数据不存在 ⇒ 剔除；对象选择**不**被本函数剔除（它属场景存在性）', () => {
    const scene = sceneWithTwoMeshes()
    const orphan = vertexTarget('A', 'no-such-data', elementRef('x', 0))
    const set = Object.freeze({
      mode: 'object' as const,
      byMode: Object.freeze({
        object: Object.freeze([objectTarget(objectRef('A')), objectTarget(objectRef('GONE'))]),
        vertex: Object.freeze([orphan]),
        edge: Object.freeze([]),
        face: Object.freeze([]),
      }),
      active: null,
    })
    const { selection, dropped } = pruneStaleElements(scene, set)
    expect(dropped.length).toBe(1)
    expect(selectedObjectIds(selection), '对象选择原样保留（含已不存在的 id）').toEqual(['A', 'GONE'])
  })

  it('**负对照**：丢掉 `topologyVersion` 的变异实现 ⇒ 会把过期引用判为有效', () => {
    const scene = sceneWithTwoMeshes()
    const staleVersion = 7
    const stale = vertexTarget('A', 'gA', elementRef('x0y0z0', staleVersion))
    // 变异实现：比较时**忽略**版本（"把顶点集合当对象列表"的同款信息丢失）
    const isValidIgnoringVersion = (t: SelectionTarget): boolean => {
      if (t.kind === 'object') return false
      const data = scene.data[t.dataId]
      if (!data) return false
      const mesh = (data.payload as { mesh?: { topology: { vertices: readonly { id: string }[] } } }).mesh
      if (!mesh) return false
      return mesh.topology.vertices.some((v) => v.id === t.element.elementId)
    }
    // 正确实现：剔除
    const correct = pruneStaleElements(scene, Object.freeze({
      mode: 'vertex' as const,
      byMode: Object.freeze({ object: Object.freeze([]), vertex: Object.freeze([stale]), edge: Object.freeze([]), face: Object.freeze([]) }),
      active: null,
    }))
    expect(correct.dropped.length, '正确实现剔除').toBe(1)
    // 变异实现：判为有效 ⇒ 它**确实**破坏了保证
    expect(isValidIgnoringVersion(stale), '忽略版本的实现会接纳过期引用').toBe(true)
  })
})

describe('手势维度 × 目标维度的**登记编码**（可往返，不靠字符串前缀猜语义）', () => {
  it('对象模式编码为手势本身；顶点模式带显式后缀', () => {
    expect(composeSelectionMode('box', 'object')).toBe('box')
    expect(composeSelectionMode('box', 'vertex')).toBe('box:vertex')
    expect(composeSelectionMode('single', 'vertex')).toBe('single:vertex')
  })

  it('`splitSelectionMode` 是 `composeSelectionMode` 的逆（往返一致）', () => {
    const gestures = ['single', 'box', 'type', 'annotation'] as const
    const targets = ['object', 'vertex'] as const
    for (const g of gestures) {
      for (const t of targets) {
        const composed = composeSelectionMode(g, t)
        expect(splitSelectionMode(composed)).toEqual({ gesture: g, target: t })
      }
    }
  })

  it('没有后缀时默认为对象模式（向后兼容 P1 的手势字符串）', () => {
    expect(splitSelectionMode('single')).toEqual({ gesture: 'single', target: 'object' })
    expect(splitSelectionMode('annotation')).toEqual({ gesture: 'annotation', target: 'object' })
  })

  it('两种维度**正交**：同一手势可配不同目标维度', () => {
    expect(composeSelectionMode('box', 'object')).not.toBe(composeSelectionMode('box', 'vertex'))
    expect(splitSelectionMode(composeSelectionMode('box', 'object')).gesture).toBe(splitSelectionMode(composeSelectionMode('box', 'vertex')).gesture)
  })
})

/** 未使用占位：保持 `ElementRef` 类型可达（下游如需直接消费元素引用可复用）。 */
export type { ElementRef }
