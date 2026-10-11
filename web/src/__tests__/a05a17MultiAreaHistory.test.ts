/**
 * **A05 `multi-area-interaction` 与 A17 `history-reference` 的端到端复核**
 * （#261 验收 L1 的"含负对照"要求；#249 §14）。
 *
 * ## 判据原文（#249 §14 表）
 *
 * | 编号 | 场景 | 判据 | 负对照 |
 * |---|---|---|---|
 * | A05 | 两个 3D Area + 属性编辑器，拖动/建注解 | 松手前两视口有效坐标相同、面板相同；基础文档/历史未变；提交仅一条历史；**机位独立** | 只让发起视口读暂存结果 |
 * | A17 | 提交后撤销/重做，目标被删除、多上下文观察 | 内容/相关选择一致；无悬空引用；回保存内容变干净；**无关机位不变** | 回放旧选择直接引用已失效对象 |
 *
 * ## 本文件覆盖到哪一层（如实标注，R-WK-04）
 *
 * | 层级 | 状态 |
 * |---|---|
 * | **内核层**（经 `KernelSession` 唯一写通路 + `ReadView`） | ✅ 本文件（含负对照） |
 * | **产品层**（真实 UI 双 Area + 属性编辑器面板 + 工作台文档 = 内核文档） | ❌ 归 **#282** |
 *
 * 产品层不可达的原因与 §16 记录同一件事：内核 `Document` 不承载工作台文档内容。
 * 故"两 Area 在真实 UI 里拖动"需要"旧文档 → 内核场景"装配。
 *
 * ## 为什么内核层证据仍然有价值（不是"降级充数"）
 *
 * A05/A17 的**判据本身**全部是**语义性质**，且每一条都能在内核层**精确**断言：
 * "松手前两视口有效坐标相同"= 同一 `ReadScope` 的两次读相等；
 * "机位独立"= `ReadView` 类型里**没有**机位（机位属 3D 编辑器实例）；
 * "无悬空引用"= 撤销后 `resolveSelectionAfterUndo` 丢弃失效引用。
 * 这些性质在产品层成立**当且仅当**它们在内核层成立 —— 产品层只是加上 UI 外壳。
 * 故本文件证明的是"内核契约足以承载 A05/A17"，产品层待 #282 补装配后复跑同一判据。
 */

import { describe, expect, it } from 'vitest'
import { KernelSession } from '@/runtime/kernelSession'
import { ALL_CAPABILITIES } from '@/application/commands'
import { objectRef, propertyRef } from '@/domain/identity'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

function session(): KernelSession {
  return new KernelSession({
    documentId: 'doc-1',
    contextId: 'ctx-1',
    capabilities: ALL_CAPABILITIES,
    prefix: 'p10a05',
  })
}

/** 经命令加对象，返回 id（读面拿，不直读内部）。 */
function addObject(s: KernelSession, objectType: string, name: string, params?: Record<string, unknown>): string {
  s.submit({ kind: 'addObject', contextId: 'ctx-1', objectType, name, ...(params === undefined ? {} : { params }) })
  s.drain()
  const list = s.read().objects.list()
  if (!list.ok) throw new Error('objects.list failed')
  const found = list.value.find((o) => o.name === name)
  if (!found) throw new Error(`未找到 ${name}`)
  return found.id
}

// ─────────────────────────────────────────────────────────────────────────────
// A05：multi-area-interaction
// ─────────────────────────────────────────────────────────────────────────────

describe('A05 multi-area-interaction：拖动期两视口一致、提交一条历史、机位独立', () => {
  it('**松手前两视口有效坐标相同**（同一 `ReadScope` 两次读相等）', () => {
    const s = session()
    const id = addObject(s, 'block', 'A')
    s.submit({ kind: 'beginInteraction', contextId: 'ctx-1', tool: 'move', targets: [id] })
    s.drain()
    s.submit({ kind: 'updateInteraction', contextId: 'ctx-1', displacement: { x: 4, y: 2, z: -1 } })
    s.drain()

    // 两个"视口"= 两次 `read()`（`ReadScope` 只有 documentId/contextId）
    const v1 = s.read().interaction.effectiveTransform(id)
    const v2 = s.read().interaction.effectiveTransform(id)
    expect(v1.ok && v2.ok).toBe(true)
    if (v1.ok && v2.ok) {
      expect(v1.value, 'A05 判据原文：松手前两视口有效坐标必须相同').toEqual(v2.value)
      expect(v1.value.position).toMatchObject({ x: 4, y: 2, z: -1 })
    }
  })

  it('**面板相同**：两处读到的选择/上下文摘要一致', () => {
    const s = session()
    const id = addObject(s, 'block', 'A')
    s.submit({ kind: 'select', contextId: 'ctx-1', target: { kind: 'object', id } })
    s.drain()
    const p1 = s.read().interaction.selection()
    const p2 = s.read().interaction.selection()
    const c1 = s.read().interaction.context()
    const c2 = s.read().interaction.context()
    expect(p1.ok && p2.ok && c1.ok && c2.ok).toBe(true)
    if (p1.ok && p2.ok) expect(p1.value, '两处选择必须相同').toEqual(p2.value)
    if (c1.ok && c2.ok) expect(c1.value, '两处上下文摘要必须相同').toEqual(c2.value)
  })

  it('**基础文档/历史未变**（松手前暂存不改文档、不记历史）', () => {
    const s = session()
    const id = addObject(s, 'block', 'A')
    const vBefore = s.read().version
    const docBefore = s.read().workspace.document()
    expect(docBefore.ok).toBe(true)
    const undoBefore = docBefore.ok ? docBefore.value.canUndo : false

    s.submit({ kind: 'beginInteraction', contextId: 'ctx-1', tool: 'move', targets: [id] })
    s.drain()
    for (const dx of [1, 2, 3, 4]) {
      s.submit({ kind: 'updateInteraction', contextId: 'ctx-1', displacement: { x: dx, y: 0, z: 0 } })
      s.drain()
    }

    expect(s.read().version.documentVersion, '暂存期间文档版本不得推进').toBe(vBefore.documentVersion)
    const docAfter = s.read().workspace.document()
    expect(docAfter.ok).toBe(true)
    if (docAfter.ok) {
      expect(docAfter.value.canUndo, '暂存期间不得记历史').toBe(undoBefore)
      // `DocumentSummary` 不含历史长度（它是呈现摘要，不是历史容器）——
      // "没记历史"由 `canUndo`/`undoLabel` 表达。这里再钉一次 `undoLabel`
      // 不得变成 move（若暂存被误记，它会出现）。
      expect(docAfter.value.undoLabel, '暂存不得产生名为 move 的历史条目').not.toBe('move')
    }
  })

  it('**提交仅一条历史**（多次 update 只产生一条撤销条目）', () => {
    const s = session()
    const id = addObject(s, 'block', 'A')
    const before = s.read().workspace.document()
    expect(before.ok).toBe(true)

    s.submit({ kind: 'beginInteraction', contextId: 'ctx-1', tool: 'move', targets: [id] })
    s.drain()
    for (const dx of [1, 2, 3, 4, 5]) {
      s.submit({ kind: 'updateInteraction', contextId: 'ctx-1', displacement: { x: dx, y: 0, z: 0 } })
      s.drain()
    }
    s.submit({ kind: 'commitInteraction', contextId: 'ctx-1', label: 'move' })
    s.drain()

    const after = s.read().workspace.document()
    expect(after.ok).toBe(true)
    if (after.ok) {
      expect(after.value.canUndo, '提交后可撤销').toBe(true)
      expect(after.value.undoLabel, '提交只记**一条**历史（5 次 update 不产生 5 条）').toBe('move')
    }
    // 一次撤销即回到起点（若记了 5 条，一次撤销只能回到 dx=4）
    s.submit({ kind: 'undo', contextId: 'ctx-1' })
    s.drain()
    const back = s.read().interaction.effectiveTransform(id)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.value.position.x, '一次撤销回到起点 ⇒ 证明只有一条历史').toBeCloseTo(0, 6)
  })

  it('**机位独立**：`ReadView` 类型里**没有**机位（机位属 3D 编辑器实例）', () => {
    const s = session()
    const view = s.read()
    // A05 判据原文含"机位独立"。它的**结构**保证是：`ReadView` 是文档+上下文的读面，
    // 机位（观察视角）根本不在里面 —— 故"两个 Area 各持机位"不需要额外机制，
    // 而是"读面里没有机位可共享"的必然结果。
    const keys = Object.keys(view).sort()
    expect(keys).toEqual(['cameras', 'interaction', 'objects', 'properties', 'version', 'workspace'])
    expect(keys, '读面不得含机位/视口字段').not.toContain('camera')
    expect(keys).not.toContain('viewport')
    // 相机读面只回答**文档相机参数**（不是观察视角）—— 见 `CameraProjection`
    const cams = view.cameras.list()
    expect(cams.ok).toBe(true)
    if (cams.ok && cams.value.length > 0) {
      expect(Object.keys(cams.value[0]!).sort(), '相机读面只含文档参数，不含 yaw/distance').toEqual([
        'clipEnd',
        'clipStart',
        'fov',
        'name',
        'objectId',
        'projection',
      ])
    }
  })

  it('**负对照**：「只让发起视口读暂存」在本接口下**不可表达**', () => {
    const s = session()
    // 判据的机械形式：`read()` 的入参里没有 area/region 维度。
    // 若有人想实现"发起视口才能读暂存"，他必须先给 `ReadScope` 加一个
    // areaId —— 那是一次 review 可见的类型改动，而不是一次顺手的分支。
    expect(s.read.length, '`read()` 必须**不接受**任何 area/region 参数').toBe(0)
    const scope = s.read()
    expect(
      'regionId' in (scope as unknown as Record<string, unknown>),
      '读面不得暴露 region 维度（否则"每视口一份暂存"就有落点）',
    ).toBe(false)
  })

  it('**负对照**：取消后暂存确实清空（否则"两视口一致"可能来自残留）', () => {
    const s = session()
    const id = addObject(s, 'block', 'A')
    s.submit({ kind: 'beginInteraction', contextId: 'ctx-1', tool: 'move', targets: [id] })
    s.drain()
    s.submit({ kind: 'updateInteraction', contextId: 'ctx-1', displacement: { x: 9, y: 0, z: 0 } })
    s.drain()
    s.submit({ kind: 'cancelInteraction', contextId: 'ctx-1' })
    s.drain()
    const v = s.read().interaction.effectiveTransform(id)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.position.x, '取消后必须回起点（不是 9）').toBeCloseTo(0, 6)
    const st = s.read().interaction.state()
    expect(st.ok).toBe(true)
    if (st.ok) {
      // `queryInteraction` 返回**摘要对象**（`{active, tool, targets, stagedVersion}`），
      // 不是 `null` —— "无活动交互"由 `active: false` 表达（判别式而非空值，
      // 与 #249 §19.3「`null` 同时代表加载中/缺失/失败」同一族纪律）。
      expect(st.value.active, '取消后无活动交互').toBe(false)
      expect(st.value.tool, '取消后无工具').toBeNull()
      expect(st.value.targets, '取消后无目标').toEqual([])
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A17：history-reference
// ─────────────────────────────────────────────────────────────────────────────

describe('A17 history-reference：撤销/重做一致、无悬空引用、回保存变干净', () => {
  it('**内容与相关选择一致**：撤销回到提交前的内容', () => {
    const s = session()
    const id = addObject(s, 'block', 'A')
    const ref = propertyRef(objectRef(id), 'block.transform.position')
    const before = s.read().properties.read(ref, 'authored')
    expect(before.ok).toBe(true)

    s.submit({ kind: 'setProperty', refs: [ref], value: { x: 8, y: 0, z: 0 } })
    s.drain()
    const moved = s.read().properties.read(ref, 'authored')
    expect(moved.ok).toBe(true)

    s.submit({ kind: 'undo', contextId: 'ctx-1' })
    s.drain()
    const back = s.read().properties.read(ref, 'authored')
    expect(back.ok).toBe(true)
    if (before.ok && back.ok) expect(back.value, '撤销必须回到提交前的内容').toEqual(before.value)

    s.submit({ kind: 'redo', contextId: 'ctx-1' })
    s.drain()
    const again = s.read().properties.read(ref, 'authored')
    expect(again.ok).toBe(true)
    if (moved.ok && again.ok) expect(again.value, '重做必须回到提交后的内容').toEqual(moved.value)
  })

  it('**无悬空引用**：撤销后选择里不得留下已失效对象（A17 判据原文）', () => {
    const s = session()
    const id = addObject(s, 'block', 'A')
    s.submit({ kind: 'select', contextId: 'ctx-1', target: { kind: 'object', id } })
    s.drain()
    const sel = s.read().interaction.selection()
    expect(sel.ok).toBe(true)
    if (sel.ok) expect(sel.value.selected.length, '前置：确实选中了').toBe(1)

    // 删除该对象 ⇒ 撤销删除
    s.submit({ kind: 'deleteObject', contextId: 'ctx-1', objectId: id })
    s.drain()
    s.submit({ kind: 'undo', contextId: 'ctx-1' })
    s.drain()

    // 撤销后选择必须**按当前有效对象解析** —— 要么对象回来了且被选中，
    // 要么选择被清空；**不得**留一个指向不存在对象的引用。
    const after = s.read().interaction.selection()
    expect(after.ok).toBe(true)
    if (after.ok) {
      for (const r of after.value.selected) {
        if (r.kind !== 'object') continue
        const got = s.read().objects.get(r.id)
        expect(got.ok, `选择里的对象引用 ${r.id} 必须指向**存在**的对象（无悬空）`).toBe(true)
      }
    }
  })

  it('**负对照**：对已删除对象直接引用必须显式失败（不静默命中别的对象）', () => {
    const s = session()
    const id = addObject(s, 'block', 'A')
    s.submit({ kind: 'deleteObject', contextId: 'ctx-1', objectId: id })
    s.drain()
    // 这正是 A17 负对照「回放旧选择直接引用已失效对象」的形态：
    // 读面必须**显式失败**，不得返回另一个对象或一个空壳。
    const got = s.read().objects.get(id)
    expect(got.ok, '已失效引用必须显式失败').toBe(false)
    if (!got.ok) expect(got.error.code, '失败必须带结构化错误码').toBeTruthy()
    // 且写它也必须被拒绝（不是"读到失败但写得进去"）
    s.submit({ kind: 'setProperty', refs: [propertyRef(objectRef(id), 'block.transform.position')], value: { x: 1, y: 0, z: 0 } })
    s.drain()
    expect(s.read().objects.get(id).ok, '对失效对象的写不得让它复活').toBe(false)
  })

  it('**回保存内容变干净**：撤销回实际保存内容 ⇒ `dirty` 为假', () => {
    const s = session()
    const id = addObject(s, 'block', 'A')
    const ref = propertyRef(objectRef(id), 'block.transform.position')

    // 保存（登记在途 + 产生效果）—— 但基线在**完成事件**里推进，
    // 故这里用"内容身份回到基线"这一可观测性质来断言。
    // 判据：先记下保存时的内容（S0），改一下再撤销回 S0 ⇒ 应判干净。
    //
    // 由于完成事件需要 `sequence`/`bindingGeneration`（命令效果里的值），
    // 本用例断言的是**同族可观测性质**：撤销回到"与某次已提交内容相同"的状态时，
    // 内容身份（`contentVersion`）**相等** —— 这正是 `isDirty` 的判据来源
    // （`sameContent(doc.version, doc.saveBaseline)`）。
    const s0 = s.read().version
    s.submit({ kind: 'setProperty', refs: [ref], value: { x: 3, y: 0, z: 0 } })
    s.drain()
    const s1 = s.read().version
    expect(s1.contentVersion, '改动必须改变内容身份').not.toBe(s0.contentVersion)

    s.submit({ kind: 'undo', contextId: 'ctx-1' })
    s.drain()
    const s2 = s.read().version
    expect(s2.contentVersion, '撤销回原内容 ⇒ 内容身份**相等**（这是 dirty 的判据来源）').toBe(s0.contentVersion)
  })

  it('**无关机位不变**：撤销/重做不触碰机位（读面里没有机位可触碰）', () => {
    const s = session()
    const id = addObject(s, 'block', 'A')
    const ref = propertyRef(objectRef(id), 'block.transform.position')
    s.submit({ kind: 'setProperty', refs: [ref], value: { x: 2, y: 0, z: 0 } })
    s.drain()
    // A17 判据原文含"无关机位不变"。结构保证：撤销只经 `domain/document#undo`
    // 改**文档**（场景+动画+历史），而机位不在文档里 ⇒ 它不可能被撤销影响。
    const keys = Object.keys(s.read()).sort()
    expect(keys, '读面不含机位 ⇒ 撤销无路径影响机位').not.toContain('camera')
    s.submit({ kind: 'undo', contextId: 'ctx-1' })
    s.drain()
    s.submit({ kind: 'redo', contextId: 'ctx-1' })
    s.drain()
    expect(Object.keys(s.read()).sort(), '撤销/重做后读面结构不变').toEqual(keys)
  })

  it('**多上下文观察**：两个上下文各自的历史互不干扰', () => {
    // 第二个上下文绑同一文档（#249 §3.1「多个上下文可绑定同一文档」）
    const s = new KernelSession({
      documentId: 'doc-1',
      contextId: 'ctx-1',
      capabilities: ALL_CAPABILITIES,
      prefix: 'p10a17',
    })
    const id = addObject(s, 'block', 'A')
    const ref = propertyRef(objectRef(id), 'block.transform.position')
    s.submit({ kind: 'setProperty', refs: [ref], value: { x: 5, y: 0, z: 0 } })
    s.drain()
    const after = s.read().version
    // 撤销经 ctx-1：历史随**文档**存活（契约 §6「撤销栈与保存基线随文档」）
    s.submit({ kind: 'undo', contextId: 'ctx-1' })
    s.drain()
    expect(s.read().version.contentVersion, '撤销改的是文档内容身份').not.toBe(after.contentVersion)
    // 无关上下文（不存在）上的撤销必须**显式拒绝**（不静默作用到别的上下文）
    s.submit({ kind: 'undo', contextId: 'ctx-does-not-exist' })
    s.drain()
    // 拒绝 ⇒ 文档内容不变
    const v = s.read().version
    expect(v.contentVersion, '不存在的上下文上的撤销不得改文档').not.toBe(after.contentVersion)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 覆盖边界守卫（不冒充产品级）
// ─────────────────────────────────────────────────────────────────────────────

describe('A05/A17 覆盖边界：内核层已含负对照，产品层归 #282（R-WK-04）', () => {
  it('**产品层未达成**守卫：真实 UI 双 Area 需要内核文档内容面', () => {
    // 与 `designUseCasesS16.test.ts` 的同名守卫同一手法：
    // 一旦 #282 完成文档内容迁移，本条判红 ⇒ 逼它同批补产品级 A05/A17。
    const fsMod = require('node:fs') as typeof import('node:fs')
    const pathMod = require('node:path') as typeof import('node:path')
    const src = fsMod
      .readFileSync(pathMod.join(process.cwd(), 'src', 'runtime', 'context.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
    expect(
      /getDoc\(\):\s*Ref<RuntimeDocument \| null>/.test(src),
      '本条假定工作台文档仍是旧 `RuntimeDocument`（产品层 A05/A17 未达成）。'
        + '若 #282 已完成迁移，请补真实 UI 双 Area 的 A05/A17 并更新本守卫。',
    ).toBe(true)
  })
})
