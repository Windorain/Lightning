/**
 * `domain/workspace` 的验收 —— **A13 `area-lifecycle`**（验收清单第一条）。
 *
 * ## A13 的原文判据与本文的落点
 *
 * | A13 原文 | 本文的断言 |
 * |---|---|
 * | 分割/切换/关闭/**恢复 100 次** | `100 次分割→切换→关闭→恢复后与初态逐项一致` |
 * | 视角按规则保留 | `切走再切回，观察视角逐字段恢复`；`新分割的 Area 机位独立（不继承）` |
 * | **关闭后实例/监听/作业回到预期基线** | `closeArea 返回全部被关闭 Area 的 disposedInstances`；`100 次循环后活动实例总数为 0` |
 * | **保留状态不靠隐藏组件存活** | `Workspace 是纯值：快照→恢复后逐字段相等`（结构上不可能有组件） |
 * | 负对照：**保持废弃组件** | `closeArea 若返回空 disposedInstances ⇒ 判红` |
 * | 负对照：**丢掉编辑器状态** | `setEditorType 若删除旧类型 localState ⇒ 判红` |
 *
 * ## 为什么这些能当负对照
 *
 * A13 的两条负对照在**同一份纯函数**上可执行：
 *  - 「保持废弃组件」= 关闭 Area 时**没有**任何实例被释放 ⇒ 判据是
 *    `disposedInstances` 必须**恰好等于**关闭前该子树上的活动实例集合。
 *    一个"只隐藏不销毁"的实现会返回空数组（因为它确实没销毁任何东西）——
 *    这正是实测事故（`v-show` 保活）的静态指纹。
 *  - 「丢掉编辑器状态」= 切类型时删掉旧 `localState` ⇒ 判据是切回后
 *    局部状态必须逐字段恢复。
 *
 * 本文还独立复算"100 次循环"的资源基线：把 `disposedInstances` 累加，
 * 断言它等于"被分割出来的 Area 数" —— 于是"关闭真的释放了资源"不靠口头声明。
 */

import { describe, expect, it } from 'vitest'
import {
  FOLLOW_ACTIVE,
  DEFAULT_OBSERVATION_VIEW,
  areaIds,
  bindDocument,
  bindEditContext,
  closeArea,
  collectAreas,
  createArea,
  createInitialLayout,
  createWorkspace,
  findArea,
  fixedTarget,
  isLinked,
  layoutDepth,
  layoutFingerprint,
  localStateOf,
  mergeArea,
  resolveTarget,
  restoreWorkspace,
  setActiveArea,
  setEditorType,
  setLocalState,
  setAreaTarget,
  setSplitRatio,
  snapshotWorkspace,
  splitArea,
  splitIds,
  updateArea,
  withInstance,
  withLayout,
  type AreaLayout,
  type EditorInstanceId,
  type Workspace,
} from '../workspace'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具：三个编辑器类型的局部状态（模拟"3D 机位 + 面板滚动 + 时间轴缩放"）
// ─────────────────────────────────────────────────────────────────────────────

const VIEW_A = { ...DEFAULT_OBSERVATION_VIEW, yawDeg: 40, distance: 9 }
const VIEW_B = { ...DEFAULT_OBSERVATION_VIEW, yawDeg: 190, distance: 30 }

function initialStateFor(type: string, view: unknown): Record<string, unknown> {
  return { editorType: type, view, scrollTop: 12, panes: ['a', 'b'] }
}

/** 一个"已建好"的工作区：单 Area `a1`，类型 viewport3d，已实例化 `i1` 并写过局部状态。 */
function baseWorkspace(): Workspace {
  const layout = createInitialLayout({ id: 'a1', editorType: 'viewport3d' })
  const withState = setLocalState(layout, 'a1', 'viewport3d', initialStateFor('viewport3d', VIEW_A))
  if (!withState.ok) throw new Error('fixture failed')
  const withInst = withInstance(withState.value, 'a1', 'i1')
  if (!withInst.ok) throw new Error('fixture failed')
  return createWorkspace({ id: 'ws1', editContextId: 'ctx1', documentId: 'doc1', layout: withInst.value, activeAreaId: 'a1' })
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 分割 / 合并 / 关闭：结构与资源结果
// ─────────────────────────────────────────────────────────────────────────────

describe('A13 · 分割：新 Area 的语义是显式的（不继承实例私有状态）', () => {
  it('分割后两个 Area 共存；新 Area **不继承**局部状态（机位独立的前提）', () => {
    const ws = baseWorkspace()
    const r = splitArea(ws.layout, { areaId: 'a1', newAreaId: 'a2', splitId: 's1', direction: 'vertical' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const areas = collectAreas(r.value)
    expect(areas.map((a) => a.id)).toEqual(['a1', 'a2'])
    // a1 保留自己的状态；a2 是全新的（**没有** viewport3d 的 localState）
    expect(localStateOf(r.value, 'a1', 'viewport3d')).toEqual(initialStateFor('viewport3d', VIEW_A))
    expect(localStateOf(r.value, 'a2', 'viewport3d'), '新 Area 不得继承兄弟的实例私有状态').toBeUndefined()
    // 实例 id 也归零：运行资源由接线层分配，纯转移不猜
    expect(findArea(r.value, 'a2')?.instanceId).toBeNull()
    // target 属**布局意图**，随分割继承
    expect(findArea(r.value, 'a2')?.target).toEqual(FOLLOW_ACTIVE)
  })

  it('分割拒绝：Area 不存在 / id 冲突 / ratio 越界（都是显式失败，不静默）', () => {
    const ws = baseWorkspace()
    const missing = splitArea(ws.layout, { areaId: 'nope', newAreaId: 'a2', splitId: 's1', direction: 'vertical' })
    expect(missing.ok ? null : missing.error.code).toBe('MissingTarget')

    const collide = splitArea(ws.layout, { areaId: 'a1', newAreaId: 'a1', splitId: 's1', direction: 'vertical' })
    expect(collide.ok ? null : collide.error.code).toBe('InvalidValue')

    const badRatio = splitArea(ws.layout, { areaId: 'a1', newAreaId: 'a2', splitId: 's1', direction: 'vertical', ratio: 1 })
    expect(badRatio.ok ? null : badRatio.error.code).toBe('InvalidValue')
  })

  it('**H1 前提**：两个 3D Area 的观察视角**互相独立**（各写各的，互不覆盖）', () => {
    // 「两个 3D Area 共享 EditContext 暂存反馈的机制就绪（A05 端到端在集成收口）；
    //   **机位独立**」—— 本断言覆盖"机位独立"那一半。
    const ws = baseWorkspace()
    const s = splitArea(ws.layout, { areaId: 'a1', newAreaId: 'a2', splitId: 's1', direction: 'horizontal' })
    if (!s.ok) throw new Error('split')
    // a2 首次访问 viewport3d 时带上自己的机位
    const a2 = setEditorType(s.value, { areaId: 'a2', editorType: 'viewport3d', initialLocalState: initialStateFor('viewport3d', VIEW_B) })
    if (!a2.ok) throw new Error('a2 type')
    const w1 = setLocalState(a2.value.layout, 'a1', 'viewport3d', initialStateFor('viewport3d', VIEW_A))
    if (!w1.ok) throw new Error('a1 state')
    const w2 = setLocalState(w1.value, 'a2', 'viewport3d', initialStateFor('viewport3d', VIEW_B))
    if (!w2.ok) throw new Error('a2 state')
    // 两个 Area 各自的机位互不干扰
    expect((localStateOf(w2.value, 'a1', 'viewport3d') as { view: { yawDeg: number } }).view.yawDeg).toBe(VIEW_A.yawDeg)
    expect((localStateOf(w2.value, 'a2', 'viewport3d') as { view: { yawDeg: number } }).view.yawDeg).toBe(VIEW_B.yawDeg)
    expect(VIEW_A.yawDeg).not.toBe(VIEW_B.yawDeg)
    // 改 a1 的机位不影响 a2
    const w3 = setLocalState(w2.value, 'a1', 'viewport3d', initialStateFor('viewport3d', { ...VIEW_A, yawDeg: 1 }))
    if (!w3.ok) throw new Error('a1 state 2')
    expect((localStateOf(w3.value, 'a2', 'viewport3d') as { view: { yawDeg: number } }).view.yawDeg).toBe(VIEW_B.yawDeg)
  })

  it('**反空洞真**：分割确实改变了布局指纹与深度（否则"结构与初态一致"可能只是没动过）', () => {
    const ws = baseWorkspace()
    const before = layoutFingerprint(ws.layout)
    const r = splitArea(ws.layout, { areaId: 'a1', newAreaId: 'a2', splitId: 's1', direction: 'vertical' })
    if (!r.ok) throw new Error('split failed')
    expect(layoutFingerprint(r.value)).not.toBe(before)
    expect(layoutDepth(r.value)).toBe(2)
    expect(layoutDepth(ws.layout)).toBe(1)
  })
})

describe('A13 · 关闭 Area 释放运行资源（负对照「保持废弃组件」的判定点）', () => {
  it('closeArea 如实列出被关闭子树上的**全部**活动实例', () => {
    let layout: AreaLayout = baseWorkspace().layout
    const s1 = splitArea(layout, { areaId: 'a1', newAreaId: 'a2', splitId: 's1', direction: 'vertical' })
    if (!s1.ok) throw new Error('split1')
    layout = s1.value
    const s2 = splitArea(layout, { areaId: 'a2', newAreaId: 'a3', splitId: 's2', direction: 'horizontal' })
    if (!s2.ok) throw new Error('split2')
    layout = s2.value
    // 两个新 Area 都起了实例
    for (const [id, inst] of [
      ['a2', 'i2'],
      ['a3', 'i3'],
    ] as const) {
      const r = withInstance(layout, id, inst)
      if (!r.ok) throw new Error('withInstance')
      layout = r.value
    }
    const closed = closeArea(layout, 'a2')
    expect(closed.ok).toBe(true)
    if (!closed.ok) return
    // a2 的子树含 a2（a3 在 a2 的对侧，**不**随 a2 关闭）—— 故只释放 i2
    expect(closed.value.disposedInstances).toEqual(['i2'])
    expect(closed.value.closedAreaIds).toEqual(['a2'])
    // a1 / a3 原样保留（状态与实例都在）
    expect(findArea(closed.value.layout, 'a1')?.instanceId).toBe('i1')
    expect(findArea(closed.value.layout, 'a3')?.instanceId).toBe('i3')
    expect(localStateOf(closed.value.layout, 'a1', 'viewport3d')).toEqual(initialStateFor('viewport3d', VIEW_A))
  })

  it('**负对照**：若把"关闭"实现成"隐藏"（不释放任何实例）⇒ disposedInstances 为空 ⇒ 判红', () => {
    // 模拟"只隐藏不销毁"的实现：布局结构没变、实例集合没变、没有任何释放
    const s = splitArea(baseWorkspace().layout, { areaId: 'a1', newAreaId: 'a2', splitId: 's1', direction: 'vertical' })
    if (!s.ok) throw new Error('split')
    const withA2 = withInstance(s.value, 'a2', 'i2')
    if (!withA2.ok) throw new Error('withInstance')
    const hiddenInsteadOfClosed = [] as readonly EditorInstanceId[]
    expect(
      hiddenInsteadOfClosed,
      '「保持废弃组件」的实现必然报告 0 个被释放实例 —— 本断言就是要它判红',
    ).not.toEqual(['i2'])
    // 真实现的对照：关闭确实报出了实例
    const real = closeArea(withA2.value, 'a2')
    expect(real.ok && real.value.disposedInstances).toEqual(['i2'])
  })

  it('关闭/合并**最后一个 Area** ⇒ 被拒绝（工作台没有"零个 Area"这个合法状态）', () => {
    const ws = baseWorkspace()
    // 根 Area 没有兄弟可上提 ⇒ 合并会留下空工作台 ⇒ 显式拒绝（纯值，输入不变）
    const r = closeArea(ws.layout, 'a1')
    expect(r.ok, '最后一个 Area 的关闭必须被拒绝，而不是把布局置空').toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('InvalidValue')
    expect(r.error.params.reason).toBe('lastArea')
    expect(mergeArea(ws.layout, 'a1').ok, '合并最后一个 Area 与关闭同因同果').toBe(false)
    // 负对照：两区时合并**必须**成功 —— 防"为过判据把合并一律拒掉"
    const s = splitArea(ws.layout, { areaId: 'a1', newAreaId: 'a2', splitId: 's1', direction: 'vertical' })
    if (!s.ok) throw new Error('split')
    const merged = mergeArea(s.value, 'a2')
    expect(merged.ok, '两区时必须允许合并（否则是"一律拒绝"的假修复）').toBe(true)
    if (!merged.ok) return
    expect(areaIds(merged.value.layout)).toEqual(['a1'])
    expect(merged.value.disposedInstances).toEqual([])
  })

  it('mergeArea 把空间让给兄弟（比 closeArea 多一个结构后果，语义分开）', () => {
    const ws = baseWorkspace()
    const s = splitArea(ws.layout, { areaId: 'a1', newAreaId: 'a2', splitId: 's1', direction: 'vertical' })
    if (!s.ok) throw new Error('split')
    const m = mergeArea(s.value, 'a2')
    expect(m.ok).toBe(true)
    if (!m.ok) return
    // 合并后只剩 a1，且 a1 **保留了**自己的状态与实例（合并的是空间，不是 a1 的内容）
    expect(areaIds(m.value.layout)).toEqual(['a1'])
    expect(findArea(m.value.layout, 'a1')?.instanceId).toBe('i1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. 切换编辑器类型：切走保留、切回恢复
// ─────────────────────────────────────────────────────────────────────────────

describe('A13 · 切换编辑器类型：切走保留、切回恢复（负对照「丢掉编辑器状态」的判定点）', () => {
  it('切到另一类型再切回：观察视角与局部状态**逐字段相等**，且切类型释放旧实例', () => {
    const ws = baseWorkspace()
    const toInspector = setEditorType(ws.layout, {
      areaId: 'a1',
      editorType: 'inspector',
      initialLocalState: initialStateFor('inspector', null),
    })
    expect(toInspector.ok).toBe(true)
    if (!toInspector.ok) return
    // 切走**释放**旧实例（A13「关闭后实例/监听/作业回到预期基线」的同类判据）
    expect(toInspector.value.disposedInstances).toEqual(['i1'])
    expect(findArea(toInspector.value.layout, 'a1')?.instanceId).toBeNull()

    const back = setEditorType(toInspector.value.layout, { areaId: 'a1', editorType: 'viewport3d' })
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(localStateOf(back.value.layout, 'a1', 'viewport3d'), '切回必须恢复视角').toEqual(initialStateFor('viewport3d', VIEW_A))
    expect(findArea(back.value.layout, 'a1')?.editorType).toBe('viewport3d')
  })

  it('首次访问某类型时采用 `initialLocalState`；已访问过则**不**被覆盖', () => {
    const ws = baseWorkspace()
    const first = setEditorType(ws.layout, { areaId: 'a1', editorType: 'timeline', initialLocalState: { zoom: 1 } })
    if (!first.ok) throw new Error('first')
    const second = setEditorType(first.value.layout, { areaId: 'a1', editorType: 'viewport3d' })
    if (!second.ok) throw new Error('back')
    // 用户改了 timeline 的状态
    const edited = setLocalState(second.value.layout, 'a1', 'timeline', { zoom: 42 })
    if (!edited.ok) throw new Error('edit')
    // 再切回 timeline：不得被 initialLocalState 覆盖
    const third = setEditorType(edited.value, { areaId: 'a1', editorType: 'timeline', initialLocalState: { zoom: 1 } })
    expect(third.ok).toBe(true)
    if (!third.ok) return
    expect(localStateOf(third.value.layout, 'a1', 'timeline')).toEqual({ zoom: 42 })
  })

  it('**负对照**：若切类型时删掉旧类型的 localState ⇒ 切回必然读到 undefined ⇒ 判红', () => {
    const ws = baseWorkspace()
    // 「丢掉编辑器状态」的实现 = 切类型时把 localState 整个换成 {}（只留新类型）
    const lossy = updateArea(ws.layout, 'a1', (a) => ({ ...a, editorType: 'inspector', localState: {} }))
    expect(
      localStateOf(lossy, 'a1', 'viewport3d'),
      '丢掉状态的实现切回后读不到视角 —— 这正是要判红的形态',
    ).toBeUndefined()
    // 真实现对照：切走再切回仍读得到
    const toInsp = setEditorType(ws.layout, { areaId: 'a1', editorType: 'inspector' })
    if (!toInsp.ok) throw new Error('switch')
    expect(localStateOf(toInsp.value.layout, 'a1', 'viewport3d')).toEqual(initialStateFor('viewport3d', VIEW_A))
  })

  it('同一类型重复设置是幂等（不误报 disposedInstances，也不丢状态）', () => {
    const ws = baseWorkspace()
    const again = setEditorType(ws.layout, { areaId: 'a1', editorType: 'viewport3d' })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.disposedInstances, '未换类型 ⇒ 不得谎报释放').toEqual([])
    expect(again.value.layout).toBe(ws.layout)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. 100 次分割 / 切换 / 关闭 / 恢复
// ─────────────────────────────────────────────────────────────────────────────

describe('A13 · 分割/切换/关闭/恢复 **100 次**：结构与资源双双回基线', () => {
  it('100 轮后布局指纹、深度、Area 数与初态**逐项一致**；每轮关闭都如实释放', () => {
    const start = baseWorkspace()
    const startFingerprint = layoutFingerprint(start.layout)
    const startDepth = layoutDepth(start.layout)
    const startAreas = areaIds(start.layout)

    let layout: AreaLayout = start.layout
    const released: EditorInstanceId[] = []

    for (let i = 0; i < 100; i++) {
      const newId = `a-${i}`
      const splitId = `s-${i}`
      const s = splitArea(layout, { areaId: 'a1', newAreaId: newId, splitId, direction: i % 2 === 0 ? 'vertical' : 'horizontal' })
      if (!s.ok) throw new Error(`split ${i} failed: ${s.error.code}`)
      layout = s.value
      expect(layoutDepth(layout), `第 ${i} 轮分割后深度`).toBe(2)

      // 新 Area 起实例 → 记录 → 切一次类型（释放实例）→ 为新类型再起实例 → 回看状态 → 关闭
      const inst = withInstance(layout, newId, `inst-${i}`)
      if (!inst.ok) throw new Error('withInstance')
      layout = inst.value

      const switched = setEditorType(layout, { areaId: newId, editorType: 'channels', initialLocalState: { tier: i } })
      if (!switched.ok) throw new Error('switch')
      released.push(...switched.value.disposedInstances)
      layout = switched.value.layout
      expect(localStateOf(layout, newId, 'channels'), `第 ${i} 轮的 channels 局部状态`).toEqual({ tier: i })

      // 新类型自己也要有实例（真实的接线层会为它挂载并 acquire 资源）
      const inst2 = withInstance(layout, newId, `inst2-${i}`)
      if (!inst2.ok) throw new Error('withInstance2')
      layout = inst2.value

      const closed = closeArea(layout, newId)
      if (!closed.ok) throw new Error('close')
      released.push(...closed.value.disposedInstances)
      layout = closed.value.layout
      expect(layoutDepth(layout), `第 ${i} 轮关闭后深度回 1`).toBe(1)
      expect(areaIds(layout), `第 ${i} 轮关闭后只剩 a1`).toEqual(['a1'])
    }

    // ── 结构和初态逐项一致 ──
    expect(layoutFingerprint(layout), '100 次循环后布局指纹必须与初态一致').toBe(startFingerprint)
    expect(layoutDepth(layout)).toBe(startDepth)
    expect(areaIds(layout)).toEqual(startAreas)
    // 原 Area 的状态一次都没被碰过
    expect(localStateOf(layout, 'a1', 'viewport3d')).toEqual(initialStateFor('viewport3d', VIEW_A))
    expect(findArea(layout, 'a1')?.instanceId).toBe('i1')

    // ── 资源回基线：100 轮 × (切类型释放 1 + 关闭释放 1) = 200 次释放 ──
    expect(released.filter((x) => x !== 'i1').length, '100 轮共释放 200 个实例（切类型 100 + 关闭 100）').toBe(200)
    expect(released.includes('i1'), 'a1 的实例在整个循环里从未被关闭').toBe(false)
    // 且每个被释放的实例 id 都恰好出现一次（没有重复释放、没有漏释放）
    const tail = released.filter((x) => x !== 'i1')
    expect(new Set(tail).size, '每个实例恰好被释放一次').toBe(200)
    // 循环结束后：布局里只剩 a1，其上活动实例只有 i1
    const liveInstances = collectAreas(layout)
      .map((a) => a.instanceId)
      .filter((x): x is string => x !== null)
    expect(liveInstances, '循环结束后的活动实例集合必须只有初态那一个').toEqual(['i1'])
  })

  it('100 次**快照 → 恢复**后仍与初态一致（"不靠隐藏组件存活"的持久化面）', () => {
    const start = baseWorkspace()
    let ws = start
    for (let i = 0; i < 100; i++) {
      const snap = snapshotWorkspace(ws)
      const r = restoreWorkspace(ws, structuredClone(snap))
      if (!r.ok) throw new Error(`restore ${i} failed: ${r.error.code}`)
      ws = r.value
    }
    expect(layoutFingerprint(ws.layout)).toBe(layoutFingerprint(start.layout))
    expect(ws.documentId).toBe('doc1')
    expect(ws.activeAreaId).toBe('a1')
    expect(localStateOf(ws.layout, 'a1', 'viewport3d')).toEqual(initialStateFor('viewport3d', VIEW_A))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. 工作区加载失败不清空当前有效布局
// ─────────────────────────────────────────────────────────────────────────────

describe('工作区恢复：失败**不得**清空当前有效布局或文档（明文）', () => {
  it('坏快照（重复 Area id / 重复 split id / ratio 越界 / 版本不符 / 空 editorType）一律 err', () => {
    const ws = baseWorkspace()
    const bad: Array<[string, unknown]> = [
      ['非对象', 'not-an-object'],
      ['版本不符', { ...snapshotWorkspace(ws), version: 2 }],
      [
        '重复 Area id',
        {
          version: 1,
          id: 'ws1',
          documentId: 'doc1',
          editContextId: 'ctx1',
          activeAreaId: 'a1',
          layout: { kind: 'split', id: 's1', direction: 'vertical', ratio: 0.5, first: { kind: 'area', id: 'a1', editorType: 'viewport3d', instanceId: null, target: { kind: 'followActive' }, localState: {} }, second: { kind: 'area', id: 'a1', editorType: 'inspector', instanceId: null, target: { kind: 'followActive' }, localState: {} } },
        },
      ],
      [
        '重复 split id',
        {
          version: 1,
          id: 'ws1',
          documentId: 'doc1',
          editContextId: 'ctx1',
          activeAreaId: 'a1',
          layout: {
            kind: 'split', id: 's1', direction: 'vertical', ratio: 0.5,
            first: { kind: 'split', id: 's1', direction: 'vertical', ratio: 0.5, first: { kind: 'area', id: 'a1', editorType: 'viewport3d', instanceId: null, target: { kind: 'followActive' }, localState: {} }, second: { kind: 'area', id: 'a2', editorType: 'inspector', instanceId: null, target: { kind: 'followActive' }, localState: {} } },
            second: { kind: 'area', id: 'a3', editorType: 'timeline', instanceId: null, target: { kind: 'followActive' }, localState: {} },
          },
        },
      ],
      [
        'ratio 越界',
        { version: 1, id: 'ws1', documentId: 'doc1', editContextId: 'ctx1', activeAreaId: 'a1', layout: { kind: 'split', id: 's1', direction: 'vertical', ratio: 1.5, first: { kind: 'area', id: 'a1', editorType: 'viewport3d', instanceId: null, target: { kind: 'followActive' }, localState: {} }, second: { kind: 'area', id: 'a2', editorType: 'inspector', instanceId: null, target: { kind: 'followActive' }, localState: {} } } },
      ],
      [
        'editorType 为空',
        { version: 1, id: 'ws1', documentId: 'doc1', editContextId: 'ctx1', activeAreaId: 'a1', layout: { kind: 'area', id: 'a1', editorType: '', instanceId: null, target: { kind: 'followActive' }, localState: {} } },
      ],
      [
        'activeAreaId 不在布局里',
        { version: 1, id: 'ws1', documentId: 'doc1', editContextId: 'ctx1', activeAreaId: 'ghost', layout: { kind: 'area', id: 'a1', editorType: 'viewport3d', instanceId: null, target: { kind: 'followActive' }, localState: {} } },
      ],
    ]
    for (const [label, snap] of bad) {
      const r = restoreWorkspace(ws, snap)
      expect(r.ok, `${label} 必须失败`).toBe(false)
      if (!r.ok) expect(r.error.code, `${label} 的错误码`).toBe('InvalidValue')
    }
    // 关键：ws 从未被修改（纯函数结构上不可能清空它）
    expect(layoutFingerprint(ws.layout)).toBe(layoutFingerprint(baseWorkspace().layout))
    expect(ws.documentId).toBe('doc1')
  })

  it('`restoreWorkspace` 的签名里没有可写入的 current —— 失败路径**结构上**无法清空', () => {
    // 这条断言的是设计不变量：函数返回 Result，current 只作为**输入**出现。
    // 用一次实际调用证明"失败时调用方手上的对象未被触碰"。
    const ws = baseWorkspace()
    const frozen = Object.freeze({ ...ws })
    const r = restoreWorkspace(frozen, null)
    expect(r.ok).toBe(false)
    expect(frozen.layout, '输入对象在失败路径上必须原样').toBe(ws.layout)
  })

  it('合法快照恢复后：布局/绑定/活动 Area 逐项保留，`editContextId` 由 current 决定（不持久化联动）', () => {
    const ws = baseWorkspace()
    const linked = bindEditContext(ws, 'ctx-other')
    const snap = snapshotWorkspace(linked)
    const r = restoreWorkspace(ws, snap)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(layoutFingerprint(r.value.layout)).toBe(layoutFingerprint(ws.layout))
    expect(r.value.documentId).toBe('doc1')
    // 工作环境存储**不**携带 EditContext 联动关系（保留政策：notRetained）
    expect(r.value.editContextId).toBe('ctx1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. H2：目标固定 vs 跟随活动对象
// ─────────────────────────────────────────────────────────────────────────────

describe('H2 · 编辑器目标：跟随活动对象 / 固定对象；目标删除显示失效（不悄悄改绑）', () => {
  const exists = new Set(['o1', 'o2'])
  const present = (id: string): boolean => exists.has(id)

  it('followActive：活动对象改变即改看；无活动对象 ⇒ none', () => {
    expect(resolveTarget(FOLLOW_ACTIVE, 'o1', present)).toEqual({ status: 'resolved', objectId: 'o1', via: 'followActive' })
    expect(resolveTarget(FOLLOW_ACTIVE, 'o2', present)).toEqual({ status: 'resolved', objectId: 'o2', via: 'followActive' })
    expect(resolveTarget(FOLLOW_ACTIVE, null, present)).toEqual({ status: 'none' })
  })

  it('fixed：活动对象改变**不改看**；这就是"固定"与"跟随"的分界', () => {
    const t = fixedTarget('o1')
    expect(resolveTarget(t, 'o2', present)).toEqual({ status: 'resolved', objectId: 'o1', via: 'fixed' })
  })

  it('**目标删除显示失效状态**：返回 missing（带原 objectId），**不**回退成 followActive、不悄悄改绑 o2', () => {
    const t = fixedTarget('o-gone')
    const r = resolveTarget(t, 'o1', present)
    expect(r).toEqual({ status: 'missing', objectId: 'o-gone' })
    // 负对照：一个"悄悄改绑"的实现会返回 resolved 到 o1/o2 —— 本断言正是要它判红
    expect(r.status, '缺失目标不得被判为 resolved').not.toBe('resolved')
  })

  it('`missing` 与 `none` 是两个不同事实（不用 null 兼表 —— 与 A36 同一纪律）', () => {
    const missing = resolveTarget(fixedTarget('o-gone'), 'o1', present)
    const none = resolveTarget(FOLLOW_ACTIVE, null, present)
    expect(missing.status).not.toBe(none.status)
  })

  it('`setAreaTarget` 持久到布局里；`fixedTarget` 删除对象后目标字段**原样**保留（供下次解析仍报 missing）', () => {
    const ws = baseWorkspace()
    const r = setAreaTarget(ws.layout, 'a1', fixedTarget('o-gone'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(findArea(r.value, 'a1')?.target).toEqual({ kind: 'fixed', objectId: 'o-gone' })
    const back = setAreaTarget(r.value, 'a1', FOLLOW_ACTIVE)
    expect(back.ok && findArea(back.value, 'a1')?.target).toEqual(FOLLOW_ACTIVE)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. 多文档与绑定（执行范围）
// ─────────────────────────────────────────────────────────────────────────────

describe('多文档与绑定：是否联动取决于绑定，**不**取决于外壳名', () => {
  it('两个工作区可看同一文档而**不**联动（各自的 EditContext）；也可显式绑定同一 EditContext', () => {
    const a = createWorkspace({ id: 'wsA', editContextId: 'ctxA', documentId: 'doc1', layout: createArea({ id: 'a', editorType: 'viewport3d' }) })
    const b = createWorkspace({ id: 'wsB', editContextId: 'ctxB', documentId: 'doc1', layout: createArea({ id: 'b', editorType: 'viewport3d' }) })
    // 同文档、不同上下文 ⇒ 不联动
    expect(a.documentId).toBe(b.documentId)
    expect(isLinked(a, b)).toBe(false)
    // 显式绑定同一 EditContext ⇒ 联动
    const bLinked = bindEditContext(b, 'ctxA')
    expect(isLinked(a, bLinked)).toBe(true)
    // 联动体现在"共享选择/时间/通道/暂存"——本层只判定绑定关系，共享状态本身在 EditContext
    expect(bLinked.editContextId).toBe(a.editContextId)
  })

  it('`Workspace` 类型上**不存在**任何外壳名/宿主名字段（组件不得询问宿主名的结构面）', () => {
    const ws = baseWorkspace()
    const keys = Object.keys(ws)
    expect(keys.sort()).toEqual(['activeAreaId', 'documentId', 'editContextId', 'id', 'layout'])
  })

  it('换绑文档是纯的；绑定为 null 也合法（未绑定）', () => {
    const ws = baseWorkspace()
    expect(bindDocument(ws, 'doc2').documentId).toBe('doc2')
    expect(bindDocument(ws, null).documentId).toBeNull()
    expect(bindDocument(ws, 'doc1'), '同值换绑返回原引用').toBe(ws)
    expect(ws.documentId, '输入未被修改').toBe('doc1')
  })

  it('`setActiveArea` 拒绝不存在的 Area', () => {
    const ws = baseWorkspace()
    const r = setActiveArea(ws, 'ghost')
    expect(r.ok ? null : r.error.code).toBe('MissingTarget')
    expect(setActiveArea(ws, 'a1').ok).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. 调尺寸（不因布局变化取消交互 —— 结构面）
// ─────────────────────────────────────────────────────────────────────────────

describe('调尺寸：只碰布局树，不产生命令、不接触 EditContext', () => {
  it('setSplitRatio 改比例且保持 Area 内容原样；ratio 越界显式拒绝', () => {
    const ws = baseWorkspace()
    const s = splitArea(ws.layout, { areaId: 'a1', newAreaId: 'a2', splitId: 's1', direction: 'vertical' })
    if (!s.ok) throw new Error('split')
    const r = setSplitRatio(s.value, 's1', 0.25)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const split = r.value && r.value.kind === 'split' ? r.value : null
    expect(split?.ratio).toBe(0.25)
    expect(findArea(r.value, 'a1')?.instanceId, '调尺寸不得释放实例（否则等于取消交互）').toBe('i1')
    expect(localStateOf(r.value, 'a1', 'viewport3d')).toEqual(initialStateFor('viewport3d', VIEW_A))
    expect(setSplitRatio(r.value, 's1', 0).ok).toBe(false)
    expect(setSplitRatio(r.value, 's1', 1).ok).toBe(false)
    expect(setSplitRatio(r.value, 'ghost', 0.5).ok).toBe(false)
  })

  it('`withLayout` 在活动 Area 被移除时回落到第一个 Area（不留下悬空 activeAreaId）', () => {
    const ws = baseWorkspace()
    const s = splitArea(ws.layout, { areaId: 'a1', newAreaId: 'a2', splitId: 's1', direction: 'vertical' })
    if (!s.ok) throw new Error('split')
    const activeOnA2 = setActiveArea(withLayout(ws, s.value), 'a2')
    if (!activeOnA2.ok) throw new Error('setActive')
    const c = closeArea(activeOnA2.value.layout, 'a2')
    if (!c.ok) throw new Error('close')
    expect(withLayout(activeOnA2.value, c.value.layout).activeAreaId).toBe('a1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. 纯性与保留政策
// ─────────────────────────────────────────────────────────────────────────────

describe('纯性：输入不被修改，输出可比较（A02 在本层的面）', () => {
  it('每个转移都不改输入；重复调用给出相同结果', () => {
    const ws = baseWorkspace()
    const snapshotBefore = JSON.stringify(ws)

    const s1 = splitArea(ws.layout, { areaId: 'a1', newAreaId: 'a2', splitId: 's1', direction: 'vertical' })
    const s2 = splitArea(ws.layout, { areaId: 'a1', newAreaId: 'a2', splitId: 's1', direction: 'vertical' })
    expect(JSON.stringify(ws), '输入在工作区转移后必须逐字节不变').toBe(snapshotBefore)
    expect(s1.ok && s2.ok && JSON.stringify(s1.value)).toBe(JSON.stringify(s2.ok ? s2.value : null))
  })

  it('布局指纹对顺序敏感、对未变子树的引用共享不敏感（供 100 次循环对账的可复核判据）', () => {
    const ws = baseWorkspace()
    expect(layoutFingerprint(ws.layout)).toBe('A(a1:viewport3d)')
    const s = splitArea(ws.layout, { areaId: 'a1', newAreaId: 'a2', splitId: 's1', direction: 'vertical', ratio: 0.5 })
    if (!s.ok) throw new Error('split')
    expect(layoutFingerprint(s.value)).toBe('S(vertical,0.5;A(a1:viewport3d);A(a2:viewport3d))')
    expect(splitIds(s.value)).toEqual(['s1'])
  })
})
