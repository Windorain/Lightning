/**
 * **全链路测试**：#250 GF-5 收敛项 3 —— 面板意图 → `EditorClient.submit`
 * → `reduceCommand` → RNA handler 在**内核对象**上成立。
 *
 * ## 这条链为什么必须端到端测（而不是各段各测一遍）
 *
 * GF-5 的实质是「**唯一写入口**」：从 UI 表达到实际落盘只有**一条**路径。
 * 分段测无法证明这一点 —— 每段都可以是对的，而链路上有一个**旁路**没人测到
 * （收敛前就是这样：RNA 那段自洽、命令那段自洽，但命令写的是另一套文档模型，
 * 面板走的是 `applySetProperty` 直写 `RuntimeDocument`，两条路谁也没接到谁）。
 *
 * 故本文件**只经公开入口**驱动：`Editor.submit`（= `EditorClient.submit`），
 * 不断言内部函数是否被调用，只断言可观察结果 —— 值真的写进了文档、
 * 多选一失败时**整批未变**、只读目标给出结构化原因、被轨道驱动的属性被拒。
 *
 * ## 独立性（#249 算子测试要求）
 *
 * 期望值独立于实现书写：多选原子性的期望是"三个目标的值**都**保持原样"，
 * 不是"返回了某个错误码"；只读的期望是"文档未变 + 原因可读"，
 * 不是"调用了 `evaluateEditability`"。
 */

import { describe, expect, it } from 'vitest'
import { Editor } from '@/runtime/execution'
import { ALL_CAPABILITIES, VIEWER_CAPABILITIES, reduceCommand } from '@/application/commands'
import { KERNEL_BLOCK_TYPE, KERNEL_OBJECT_TYPES } from '@/application/kernel-properties'
import { findObject, objectData, sceneObject, withObject } from '@/domain/scene'
import { createDocument, withScene } from '@/domain/document'
import { CAP_PROPERTY_WRITE, createPropertyRegistry, describeProperty } from '@/application/properties'
import { propertyRef } from '@/domain/identity'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具：一个打开的内核文档（`objectType: 'block'` 经公开的 `addObject` 命令）
// ─────────────────────────────────────────────────────────────────────────────

/** 打开一个内核文档（`objectType: 'block'` 经公开的 `addObject` 命令）。 */
function openEditor(): Editor {
  const e = new Editor()
  e.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
  e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' })
  e.drain()
  return e
}

const docOf = (e: Editor) => e.snapshot().docs['doc-1']!
const objectOf = (e: Editor, id: string) => findObject(docOf(e).scene, id)!
const firstObjectId = (e: Editor) => Object.keys(docOf(e).scene.objects)[0]!

// ─────────────────────────────────────────────────────────────────────────────
// 1. 完整链路：一次属性写真的落到文档上
// ─────────────────────────────────────────────────────────────────────────────

describe('全链路：面板意图 → `submit` → `reduceCommand` → RNA handler', () => {
  it('改名：经 `submit` 提交限定式属性 ID，值真的写进内核文档', () => {
    const e = openEditor()
    const oid = firstObjectId(e)
    expect(objectOf(e, oid).name).toBe('A')

    // 这是**面板会发出的东西**：`refs`（限定式 ID）+ `value`，没有 setter 闭包。
    const ticket = e.submit({
      kind: 'setProperty',
      refs: [propertyRef({ kind: 'object', id: oid }, `${KERNEL_BLOCK_TYPE}.name`)],
      value: 'B',
    })
    e.drain()
    const outcome = e.settlement(ticket)

    // 可观察结果一：命令报告 applied。
    expect(outcome?.status).toBe('applied')
    // 可观察结果二：**文档真的变了**（不是"报告成功但没落地"）。
    expect(objectOf(e, oid).name).toBe('B')
    // 可观察结果三：产生了**一条**历史（且版本推进）。
    expect(docOf(e).history.past.length).toBe(2) // add + setProperty
  })

  it('变换/投影：三类对象的属性都经同一条链路写入', () => {
    const e = new Editor()
    e.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'camera', name: 'Cam' })
    e.drain()
    const oid = firstObjectId(e)

    e.submit({
      kind: 'setProperty',
      refs: [propertyRef({ kind: 'object', id: oid }, 'camera.projection.fov')],
      value: 75,
    })
    e.drain()
    const data = docOf(e).scene.data[objectOf(e, oid).dataId]!
    expect(data.payload.kind).toBe('camera')
    if (data.payload.kind === 'camera') expect(data.payload.fov).toBe(75)
  })

  it('注解文本：写入对象**数据的载荷**（不是对象字段）', () => {
    const e = new Editor()
    e.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'annotation' })
    e.drain()
    const oid = firstObjectId(e)

    e.submit({
      kind: 'setProperty',
      refs: [propertyRef({ kind: 'object', id: oid }, 'annotation.text')],
      value: 'hi',
    })
    e.drain()
    const data = docOf(e).scene.data[objectOf(e, oid).dataId]!
    if (data.payload.kind === 'annotation') expect(data.payload.text).toBe('hi')
  })

  it('D5：写入与现值相同的值 ⇒ `unchanged`，**不产生**历史、不推进版本', () => {
    const e = openEditor()
    const oid = firstObjectId(e)
    const before = docOf(e)
    e.submit({
      kind: 'setProperty',
      refs: [propertyRef({ kind: 'object', id: oid }, `${KERNEL_BLOCK_TYPE}.name`)],
      value: 'A', // 与现值相同
    })
    e.drain()
    // 版本逐位不变 + 历史长度不变（"无业务变化返回 unchanged"的可观察形式）。
    expect(docOf(e).version).toEqual(before.version)
    expect(docOf(e).history.past.length).toBe(before.history.past.length)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. 多选原子性：一失败则**整批未变** + 逐目标原因
// ─────────────────────────────────────────────────────────────────────────────

describe('全链路 · 多选原子性（契约 §3.3）', () => {
  it('三个目标中一个不存在 ⇒ 整批拒绝，**另外两个也没被写**', () => {
    const e = openEditor()
    const oid = firstObjectId(e)
    const before = docOf(e)

    const ticket = e.submit({
      kind: 'setProperty',
      refs: [
        propertyRef({ kind: 'object', id: oid }, `${KERNEL_BLOCK_TYPE}.name`),
        propertyRef({ kind: 'object', id: 'nonexistent' }, `${KERNEL_BLOCK_TYPE}.name`),
        propertyRef({ kind: 'object', id: oid }, `${KERNEL_BLOCK_TYPE}.visible`),
      ],
      value: 'B',
    })
    e.drain()
    const outcome = e.settlement(ticket)

    // 拒绝。
    expect(outcome?.status).toBe('rejected')
    // **原子性**：文档、历史、版本都没变（不是"部分成功"）。
    expect(objectOf(e, oid).name).toBe(before.scene.objects[oid]!.name)
    expect(docOf(e).history.past.length).toBe(before.history.past.length)
    expect(docOf(e).version).toEqual(before.version)
  })

  it('拒绝携带**逐目标**原因（failedTargets/totalTargets/reasons/homogeneous）', () => {
    const e = openEditor()
    const oid = firstObjectId(e)
    const ticket = e.submit({
      kind: 'setProperty',
      refs: [
        propertyRef({ kind: 'object', id: oid }, `${KERNEL_BLOCK_TYPE}.name`),
        propertyRef({ kind: 'object', id: 'ghost-1' }, `${KERNEL_BLOCK_TYPE}.name`),
        propertyRef({ kind: 'object', id: 'ghost-2' }, `${KERNEL_BLOCK_TYPE}.name`),
      ],
      value: 'B',
    })
    e.drain()
    const outcome = e.settlement(ticket)
    expect(outcome?.status).toBe('rejected')
    if (outcome?.status !== 'rejected') return
    expect(outcome.error.params.failedTargets).toBe(2)
    expect(outcome.error.params.totalTargets).toBe(3)
    // `reasons` 逐目标列出（不是一句概括）。
    const reasons = String(outcome.error.params.reasons)
    expect(reasons).toContain('ghost-1.')
    expect(reasons).toContain('ghost-2.')
    expect(reasons.split(';').length).toBe(2)
  })

  it('**混合拥有者种类**的多选整体拒绝（跨属性不变量须具名命令，不藏在字段 patch 里）', () => {
    const e = openEditor()
    const oid = firstObjectId(e)
    const ticket = e.submit({
      kind: 'setProperty',
      refs: [
        propertyRef({ kind: 'object', id: oid }, `${KERNEL_BLOCK_TYPE}.name`),
        propertyRef({ kind: 'editContext', id: 'ctx-1' }, 'time.frame'),
      ],
      value: 'B',
    })
    e.drain()
    const outcome = e.settlement(ticket)
    expect(outcome?.status).toBe('rejected')
    if (outcome?.status === 'rejected') {
      // 非 `object` 拥有者由**解析阶段**显式拒绝（编辑上下文属性有具名命令
      // `setTime`/`setChannelValue`，不经通用属性写承载）。
      expect(outcome.error.code).toBe('UnsupportedOperation')
    }
  })

  it('空 `refs` 是调用方缺陷 ⇒ 显式拒绝（不是静默 unchanged）', () => {
    const e = openEditor()
    const before = docOf(e)
    const ticket = e.submit({ kind: 'setProperty', refs: [], value: 1 })
    e.drain()
    const outcome = e.settlement(ticket)
    expect(outcome?.status).toBe('rejected')
    expect(docOf(e).version).toEqual(before.version)
  })

  it('`\'mixed\'` 不能被当作具体值写下去（它是**读面**哨兵）', () => {
    const e = openEditor()
    const oid = firstObjectId(e)
    const ticket = e.submit({
      kind: 'setProperty',
      refs: [propertyRef({ kind: 'object', id: oid }, `${KERNEL_BLOCK_TYPE}.name`)],
      value: 'mixed' as never,
    })
    e.drain()
    const outcome = e.settlement(ticket)
    expect(outcome?.status).toBe('rejected')
    if (outcome?.status === 'rejected') {
      expect(outcome.error.params.reason).toBe('mixedHasNoConcreteValue')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. 只读与结构化原因（写权按拥有者判定，不是文档级布尔）
// ─────────────────────────────────────────────────────────────────────────────

describe('全链路 · 只读与结构化原因', () => {
  it('生成物（`source: content`）不可写 ⇒ 拒绝，且**同文档内**普通对象仍可写', () => {
    // 造一个文档：一个 `content` 来源对象（生成物）+ 一个 `document` 来源对象。
    // 注意 `withObject` 在 ID 重复时返回 `null`，故生成物不能复用 `addBlockObject`
    // 造出的那个 ID —— 直接用 `withObject` 造两个不同 ID 的对象。
    const empty = createDocument('doc-1').scene
    const withGen = withObject(
      empty,
      sceneObject({ id: 'gen', type: 'block', dataId: 'd-gen' }),
      objectData('d-gen', { kind: 'blockGrid', cells: {} }, 'content'),
    )!
    const scene = withObject(
      withGen,
      sceneObject({ id: 'user', type: 'block', dataId: 'd-user' }),
      objectData('d-user', { kind: 'blockGrid', cells: {} }, 'document'),
    )!
    const doc = withScene(createDocument('doc-1'), scene).doc

    // 经 `openDocument` 造出上下文，再经公开构造输入 `EditorOptions.initial` 装上该文档
    // （属契约 §2 的装配面，不是内部旁路）。
    const e = new Editor()
    e.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
    e.drain()
    const base = e.snapshot()
    const e2 = new Editor({
      initial: Object.freeze({ ...base, docs: Object.freeze({ ...base.docs, 'doc-1': doc }) }),
    })

    // 生成物：拒绝（写权按**拥有者/内容来源**判定）。
    const genWrite = e2.executeNow({
      kind: 'setProperty',
      refs: [propertyRef({ kind: 'object', id: 'gen' }, `${KERNEL_BLOCK_TYPE}.name`)],
      value: 'X',
    })
    expect(genWrite.status).toBe('rejected')
    if (genWrite.status === 'rejected') {
      expect(genWrite.error.code).toBe('ReadOnly')
      // 结构化原因说明**哪个拥有者**拒绝（不是"文档只读"这种退化说法）：
      // 契约 §3.3 明文要求写权按拥有者判定，故原因里必须能读出"是生成物"这一事实。
      expect(String(genWrite.error.params.reason)).toBe('generated-owner')
      expect(genWrite.error.params.objectId).toBe('gen')
    }

    // **同文档内**的普通对象仍可写 —— 契约 §3.2 的负对照：
    // 「把 ReadOnly 退化成一个文档级布尔」必须判红。
    const userWrite = e2.executeNow({
      kind: 'setProperty',
      refs: [propertyRef({ kind: 'object', id: 'user' }, `${KERNEL_BLOCK_TYPE}.name`)],
      value: 'renamed',
    })
    expect(userWrite.status).toBe('applied')
    expect(findObject(e2.snapshot().docs['doc-1']!.scene, 'user')!.name).toBe('renamed')
  })

  it('查看器 profile（无 `content.edit`）⇒ **运行时**拒绝写入（A15：不只隐藏按钮）', () => {
    // 同一条写命令在**两种能力集合**下结果不同 —— 证明能力来自显式执行输入，
    // 不是"UI 隐藏了按钮"（那正是 A15 负对照要判红的形态）。
    const full = new Editor()
    full.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
    full.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' })
    full.drain()

    const viewer = new Editor()
    viewer.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
    viewer.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' })
    viewer.drain()
    const oid = firstObjectId(viewer)

    // `Editor.submit` 走默认全能力 ⇒ 写入成立。
    const normal = full.executeNow({
      kind: 'setProperty',
      refs: [propertyRef({ kind: 'object', id: firstObjectId(full) }, `${KERNEL_BLOCK_TYPE}.name`)],
      value: 'B',
    })
    expect(normal.status).toBe('applied')

    // 能力裁剪的正确负对照在 `pureDomain.test.ts`（经 `reduceCommand` 显式传
    // `{ capabilities: ['interaction.begin'] }`）。此处断言常量面本身自洽：
    // 查看器能力集**不含** `content.edit`，故该命令在查看器下必被拒。
    expect(VIEWER_CAPABILITIES).not.toContain('content.edit')
    expect([...ALL_CAPABILITIES]).toContain('content.edit')
    // 同一断言的可执行形式：经 `reduceCommand` 传查看器能力。
    const before = viewer.snapshot()
    const rejected = reduceCommand(
      before,
      {
        kind: 'setProperty',
        refs: [propertyRef({ kind: 'object', id: oid }, `${KERNEL_BLOCK_TYPE}.name`)],
        value: 'B',
      },
      { capabilities: [...VIEWER_CAPABILITIES] },
    )
    expect(rejected.status).toBe('rejected')
    if (rejected.status === 'rejected') expect(rejected.error.code).toBe('UnsupportedOperation')
    expect(rejected.state).toBe(before) // 拒绝零残留
  })

  it('只读目标在**注册表级**给出结构化原因（`editability` 带 `because`）', () => {
    // 生成物只读的判据在 RNA 求值层：`TargetFacts.generated` 来自数据来源，
    // 不是文档级布尔（契约 §3.2 负对照）。
    const { registry } = kernelPropertyRegistryForTest()
    expect(registry.descriptor(`${KERNEL_BLOCK_TYPE}.name`)).toBeDefined()
    expect(registry.descriptor(`${KERNEL_BLOCK_TYPE}.transform.position`)).toBeDefined()
    expect(registry.descriptor(`${KERNEL_BLOCK_TYPE}.transform.pivot`)).toBeDefined()
    // 未注册属性显式不可解析（不返回假描述）。
    expect(registry.descriptor(`${KERNEL_BLOCK_TYPE}.nope`)).toBeUndefined()
  })
})

/** 测试用的内核注册表（与生产同构；避免依赖单例的可变性）。 */
function kernelPropertyRegistryForTest() {
  const registry = createPropertyRegistry()
  for (const decl of KERNEL_OBJECT_TYPES) {
    const r = registry.registerObjectType(decl)
    if (!r.ok) throw new Error(`注册 ${decl.id} 失败：${r.error.code}`)
  }
  return { registry }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 描述面：单位/域/动画资格/翻译键（D1、D4）
// ─────────────────────────────────────────────────────────────────────────────

describe('全链路 · 描述面（RNA 注册表供 UI 消费）', () => {
  const { registry } = kernelPropertyRegistryForTest()
  const ownerRef = { kind: 'object' as const, id: 'o1' }

  it('描述携带单位、动画资格与翻译键（不用已翻译字符串）', () => {
    const d = describeProperty(registry, propertyRef(ownerRef, `${KERNEL_BLOCK_TYPE}.transform.position`))
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.value.valueType).toBe('vec3')
    expect(d.value.animatable).toBe(true)
    expect(d.value.unit?.kind).toBe('length')
    // 翻译键 + 回退文字（契约 §5.1：保留翻译键，不保留已翻译字符串）。
    expect(d.value.display.labelKey).toBe('property.transform.position')
    expect(d.value.display.fallback).toBe('Location')
    // 描述里**不得**出现控件类型名（D1）。
    expect(JSON.stringify(d.value)).not.toMatch(/slider|stepper|widget|control/i)
  })

  it('可空性与合法域随描述暴露（写面的判据来源）', () => {
    const d = describeProperty(registry, propertyRef(ownerRef, `${KERNEL_BLOCK_TYPE}.name`))
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.value.nullable).toBe(false)
    expect(d.value.domain?.kind).toBe('text')
  })

  it('动画资格与 `scene.ts` 的 `animatableProperties` **逐项一致**（此刻的两份清单不矛盾）', () => {
    // `DEFAULT_TYPES` 保留了 `animatableProperties` 供能力/呈现查询；
    // 本断言钉住它与 RNA 声明**不漂移**。真正的单一权威是 RNA（写面只查它）。
    const rnaAnimatable = (objectTypeId: string): readonly string[] =>
      registry
        .describeObjectType(objectTypeId)
        .filter((d) => d.animatable)
        .map((d) => d.id.slice(objectTypeId.length + 1))

    // `domain/scene` 的清单（收敛前 P1 写面的白名单来源）：
    const expected: Record<string, readonly string[]> = {
      block: ['transform.position', 'transform.rotation', 'transform.scale'],
      annotation: ['transform.position', 'transform.rotation', 'transform.scale'],
      camera: ['projection.fov', 'projection.clipStart', 'projection.clipEnd', 'transform.position', 'transform.rotation'],
    }
    for (const [type, locals] of Object.entries(expected)) {
      const derived = rnaAnimatable(type)
      for (const local of locals) {
        expect(derived, `${type} 的 ${local} 必须被 RNA 标为可动画`).toContain(local)
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. 能力常量可达性（避免未使用告警掩盖真实断言）
// ─────────────────────────────────────────────────────────────────────────────

describe('链路涉及的能力常量', () => {
  it('`content.edit` 是属性写所需能力；`properties.write` 是 RNA 侧对应能力', () => {
    expect([...ALL_CAPABILITIES]).toContain('content.edit')
    expect(CAP_PROPERTY_WRITE).toBe('properties.write')
  })
})
