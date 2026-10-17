// @vitest-environment jsdom
/**
 * **属性控件的交互契约**（#253 P2；#249 §19.1 显示值/编辑草稿/可提交值分离、D1/D2 界面要求）。
 *
 * ## 这些用例在锁什么（以及为什么必须用 DOM）
 *
 * 前两个测试文件锁的是**纯逻辑**（描述、路由、原子性）。本文件锁的是**呈现层**的三条
 * 用户可见契约 —— 它们只在真实 DOM 事件序列下才成立：
 *
 *  1. **中间草稿不写文档**：输入 `-` / `1.` / 空串时**不得**提交（旧实现每字符提交一次，
 *     于是「1.」会被 `Number('1.')` 变成 1 写下去，用户输入的中间态被静默吞掉）；
 *  2. **非法草稿保留并提示**，不暗中强制转换（校验判据来自 RNA 核心，不是组件自己写）；
 *  3. **只读字段不可聚焦且带结构化原因**（不是「能输入但没反应」——
 *     旧 `RNAWidget` 对 `material.*` / `annotation.created_at` 就是那样）。
 *
 * 事件全部用**真实用户事件**（`input`/`blur`/`keydown`），不从组件内部状态反读期望；
 * 期望值硬编码。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import PropertyField from '@/workbench/ux/PropertyField.vue'
import { createPropertyRegistry, describeProperty } from '@/application/properties'
import { buildFieldViewModel, type FieldViewModel } from '@/editors/property-controls'
import type { PropertyRef } from '@/application/contracts'
import { contextKey } from '@/runtime/context'
import { createInputPort } from '@/runtime/inputPort'
import { createInputSession } from '@/runtime/inputSession'

// ── 夹具（与组件同源：字段模型由 RNA 纯函数造，不手工拼） ──────────────────────

const OBJECT_TYPE = 'ui.thing'

function makeRegistry() {
  const reg = createPropertyRegistry()
  reg.registerObjectType({
    id: OBJECT_TYPE,
    ownerKind: 'object',
    display: { labelKey: 'obj.ui', fallback: 'UI' },
    properties: [
      {
        id: 'count',
        valueType: 'number',
        animatable: true,
        unit: { kind: 'count', symbolKey: 'unit.pcs', symbolFallback: '件' },
        display: { labelKey: 'ui.count', fallback: '数量', decimals: 2 },
        // **硬**约束 + 上下界齐全 ⇒ 渲染成 `slider`（D1.1 #6 的步长来源用例）。
        domain: { kind: 'number', min: 0, max: 100, hard: true, step: 5 },
      },
      {
        id: 'plain',
        valueType: 'number',
        animatable: false,
        display: { labelKey: 'ui.plain', fallback: '数值' },
        // 推荐域（非硬约束）⇒ 渲染成文本框，草稿/提交语义可测。
        domain: { kind: 'number', min: 0, max: 100, hard: false, step: 1 },
      },
      {
        id: 'mode',
        valueType: 'enum',
        animatable: false,
        display: { labelKey: 'ui.mode', fallback: '模式' },
        domain: {
          kind: 'enum',
          items: [
            { value: 'fast', display: { labelKey: 'm.fast', fallback: '快速' } },
            { value: 'slow', display: { labelKey: 'm.slow', fallback: '慢速' } },
          ],
        },
      },
      {
        id: 'enabled',
        valueType: 'boolean',
        animatable: false,
        display: { labelKey: 'ui.enabled', fallback: '启用' },
      },
      {
        id: 'offset',
        valueType: 'vec3',
        animatable: true,
        display: { labelKey: 'ui.offset', fallback: '偏移' },
      },
      {
        id: 'tint',
        valueType: 'color',
        animatable: false,
        display: { labelKey: 'ui.tint', fallback: '色调' },
      },
      {
        id: 'stamp',
        valueType: 'string',
        animatable: false,
        readOnly: true,
        readOnlyReason: 'timestamp',
        display: { labelKey: 'ui.stamp', fallback: '时间戳' },
      },
    ],
  })
  return reg
}

const owner: PropertyRef['owner'] = { kind: 'object', id: 'U1' }

/**
 * 本文件只锁**字段模型 → DOM** 这一段：字段模型的读状态由显式值给出，
 * 读面本身的判据在 `rna-contract.test.ts` 覆盖，不在这里重复。
 * 于是 DOM 用例的期望值全部硬编码，不依赖读面实现。
 *
 * （`access`/`PropertyAccess` 是上一版夹具的残留：它被 `fieldFor` 用来造
 * `readRaw`，但字段模型已经直接收显式值，故整段删除而非留作未用代码。）
 */

/** 造一个字段模型（走 RNA 纯函数，与真实面板同一路径）。 */
function fieldFor(
  reg: ReturnType<typeof makeRegistry>,
  localId: string,
  value: unknown,
): FieldViewModel {
  const propertyId = `${OBJECT_TYPE}.${localId}`
  const d = describeProperty(reg, { owner, property: propertyId })
  if (!d.ok) throw new Error(`describe failed: ${JSON.stringify(d.error)}`)
  const ref: PropertyRef = { owner, property: propertyId }
  return buildFieldViewModel(reg, ref, {
    descriptor: d.value,
    value: { kind: 'value', value: value as never },
    edit: { kind: 'editable' },
  })
}

function readonlyFieldFor(
  reg: ReturnType<typeof makeRegistry>,
  localId: string,
  value: unknown,
): FieldViewModel {
  const propertyId = `${OBJECT_TYPE}.${localId}`
  const d = describeProperty(reg, { owner, property: propertyId })
  if (!d.ok) throw new Error('describe failed')
  return buildFieldViewModel(reg, { owner, property: propertyId }, {
    descriptor: d.value,
    value: { kind: 'value', value: value as never },
    edit: { kind: 'readOnly', reason: { code: 'ReadOnly', params: { reason: 'timestamp', property: propertyId } } },
  })
}

// ── 挂载工具 ─────────────────────────────────────────────────────────────────

let app: App | null = null
let host: HTMLElement | null = null

/**
 * 挂载控件。
 *
 * `onDraft`/`onCommit`/`onCancel` 三个监听在 P10c（#286）随组件 emit 一起删除：
 * 组件不再转发文本变化（那走输入层的唯一 document 监听），`commit`/`cancel`
 * 从未有过发出点。留下的两个 emit 都是"无草稿语义"控件用的。
 */
function mount(field: FieldViewModel, ctx: unknown = null) {
  const events: { kind: string; payload?: unknown }[] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  host = container
  app = createApp(PropertyField, {
    field,
    onCommitValue: (v: unknown) => events.push({ kind: 'commit-value', payload: v }),
    onCommitComponent: (i: number, v: number) => events.push({ kind: 'component', payload: [i, v] }),
  })
  if (ctx !== null) app.provide(contextKey, ctx as never)
  app.mount(container)
  return { root: container, events }
}

/**
 * 造一个**真的**输入端口（不 mock 三态机）。
 *
 * ## 为什么这里必须用真端口（P10c #286 之后）
 *
 * 本文件原有两条用例依赖 P2 的草稿镜像（`FieldViewModel.draftState` 回落分支）
 * 来断言"非法草稿提示可见"。那份镜像已随单一权威收口删除，若继续用假端口，
 * 这些用例就会退化成"测一个不存在的回落路径"（假绿）。
 *
 * 用真端口后，断言走的是**生产同一条**数据流：
 * `InputPort.registerTextControl` → `applyTextInput` → `textProjection`。
 */
function makeInputPort() {
  const session = createInputSession({
    sink: {
      submit: () => ({ ticketId: 't', commandId: 'c' }),
      executeNow: () => ({ status: 'unchanged', version: { documentVersion: 0 } }),
    } as never,
  })
  const port = createInputPort(session)
  return { session, port }
}

/** 把端口塞进一个最小 `Context` 形状（组件只读 `ctx.wm.inputPort`）。 */
function ctxWithPort(port: unknown): unknown {
  return { wm: { inputPort: port } }
}

beforeEach(() => {
  app = null
  host = null
  document.body.innerHTML = ''
})

function teardown(): void {
  app?.unmount()
  host?.remove()
}

function fire(el: Element, type: string, init: Record<string, unknown> = {}): void {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(e, init)
  el.dispatchEvent(e)
}

// ── 用例 ─────────────────────────────────────────────────────────────────────

describe('控件：草稿不提交（#249 §19.1）', () => {
  /**
   * P10c（#286）：本条从"发 `draft` 事件"翻成"**不发任何提交意图**"。
   *
   * 组件不再有 `draft` emit（草稿走输入层的唯一监听）。判据不变，只是观察面
   * 从"组件转发的镜像"变成"组件自己的出口"：键入中间态**不得**触发任何出口。
   * 提交时机本身的行为判据在 `domain/__tests__/textDraft.test.ts`。
   */
  it('键入**中间态**不发任何提交意图（提交时机归输入层）', () => {
    const reg = makeRegistry()
    const { root, events } = mount(fieldFor(reg, 'plain', 10))
    const input = root.querySelector<HTMLInputElement>('input.ux-field-text')!
    expect(input).toBeTruthy()

    for (const text of ['-', '1.', '']) {
      events.length = 0
      input.value = text
      fire(input, 'input')
      expect(events, `草稿 ${JSON.stringify(text)} 不得提交`).toEqual([])
    }
    teardown()
  })

  /**
   * P10c（#286）：本条改用**真输入端口**，断言生产同一条数据流。
   *
   * 原实现用 `field.draftState`（P2 镜像）产生 `InvalidValue` 提示 —— 该镜像已删。
   * 现在非法草稿的可见提示来自 `InputPort.textProjection`：登记控件 → 输入非法草稿
   * → 投影给出 `invalid` + 原因，组件把它渲染成 `.ux-field-problem`。
   *
   * 这正是 e2e A25-3 走的路径（`input-routing.spec.ts`），此处以 jsdom 复现，
   * 使"非法草稿不静默吞掉"在单元层也有判据。
   */
  it('非法草稿：**保留**在输入层（投影可见）且提示可见，失焦不提交', async () => {
    const reg = makeRegistry()
    const field = fieldFor(reg, 'plain', 10)
    const { port } = makeInputPort()
    const { root, events } = mount(field, ctxWithPort(port))
    const input = root.querySelector<HTMLInputElement>('input.ux-field-text')!
    const controlId = `field:${OBJECT_TYPE}.plain`

    // 输入层的会话以**焦点事实**驱动（`adapters/inputBinding` 的 focusin）。
    port.registerTextControl(
      { controlId, kind: 'number', displayValue: '10' },
      port.nextToken(),
    )
    port.applyTextInput(controlId, 'abc', port.nextToken())
    const p = port.textProjection(controlId)!
    expect(p.status, '`abc` 对 number 非法 ⇒ invalid').toBe('invalid')
    expect(p.submittable, '非法草稿没有可提交值').toBeNull()
    expect(p.draft, '草稿**原样保留**（不暗中强制转换）').toBe('abc')
    port.publish()

    await nextTick()
    fire(input, 'blur')
    expect(events.filter((e) => e.kind === 'commit-value'), '失焦不得提交非法草稿').toHaveLength(0)
    // 提示必须可见（不静默吞输入）
    expect(root.querySelector('.ux-field-problem')?.textContent).toContain('InvalidValue')
    teardown()
  })

  /**
   * Enter/Escape 的**归属**自 P7（#258）合流起不在本组件 —— 改由输入层路由
   * （`domain/input.ts` 的纯路由 + `domain/textDraft.ts` 的三态机），
   * 组件只声明 `data-input-control-id` 事实。
   *
   * 故本条断言改为：①组件**不再**自行消费这两个键（否则同一次按键会被
   * 组件与输入层各提交一次）；②它**声明了**输入层路由所需的事实属性。
   * 路由与提交时机的行为判据在 `domain/__tests__/inputRouting.test.ts`、
   * `domain/__tests__/textDraft.test.ts` 与 e2e `input-routing.spec.ts` 覆盖。
   */
  it('Enter/Escape **不**由组件消费（改由输入层路由），且控件声明路由所需事实', () => {
    const reg = makeRegistry()
    const { root, events } = mount(fieldFor(reg, 'plain', 10))
    const input = root.querySelector<HTMLInputElement>('input.ux-field-text')!

    // ① 组件不再自行消费（这是"单一归属"的结构性证据）
    fire(input, 'keydown', { key: 'Enter' })
    fire(input, 'keydown', { key: 'Escape' })
    expect(events.map((e) => e.kind), 'Enter/Escape 不得由组件自行提交/取消').toEqual([])

    // ② 事实属性齐备：输入层据此判归属（语义层不读 document.activeElement）
    // 控制 id 带 `field:` 前缀 —— 与命令层 `ControlBinding.controlId`、
    // `WM.applyPropertyRegistry` 的键**同一个**命名空间（三者必须一致，
    // 否则会出现"登记了但提交找不到落点"）。
    expect(input.getAttribute('data-input-control-id')).toBe(`field:${OBJECT_TYPE}.plain`)
    expect(input.getAttribute('data-input-kind')).toBe('number')
    expect(input.getAttribute('data-input-display')).toBe('10')
    teardown()
  })

  /**
   * IME 守卫：输入法确认候选词的 Enter **不得**提交草稿。
   *
   * 组件级证明只能到"组件不消费"（上一条）；组合态的**政策**在
   * `domain/textDraft.ts`（`composing` 时 `settleControl` 一律不提交）。
   * 本组件已不持有该判据，故这里只锁"组件不会绕过它自行提交"。
   */
  it('组合期（`isComposing`）的 Enter 不会被组件提交（政策在输入层）', () => {
    const reg = makeRegistry()
    const { root, events } = mount(fieldFor(reg, 'plain', 10))
    const input = root.querySelector<HTMLInputElement>('input.ux-field-text')!
    fire(input, 'keydown', { key: 'Enter', isComposing: true })
    expect(events.filter((e) => e.kind === 'commit')).toHaveLength(0)
    teardown()
  })

  it('多行文本里 Enter **不**提交（换行优先）', () => {
    const reg = createPropertyRegistry()
    reg.registerObjectType({
      id: 'ui.multi',
      ownerKind: 'object',
      display: { labelKey: 'ui.multi', fallback: 'M' },
      properties: [
        {
          id: 'body',
          valueType: 'string',
          animatable: false,
          display: { labelKey: 'ui.body', fallback: '正文' },
          domain: { kind: 'text', multiline: true },
        },
      ],
    })
    const d = describeProperty(reg, { owner, property: 'ui.multi.body' })
    if (!d.ok) throw new Error('desc')
    const field = buildFieldViewModel(reg, { owner, property: 'ui.multi.body' }, {
      descriptor: d.value,
      value: { kind: 'value', value: 'line1' },
      edit: { kind: 'editable' },
    })
    const { root, events } = mount(field)
    const ta = root.querySelector<HTMLTextAreaElement>('textarea')!
    expect(ta).toBeTruthy()
    fire(ta, 'keydown', { key: 'Enter' })
    expect(events.filter((e) => e.kind === 'commit')).toHaveLength(0)
    teardown()
  })
})

describe('控件：只读字段不可聚焦且带结构化原因', () => {
  it('只读字段渲染为不可聚焦元素，并带 `data-readonly-code`/`data-readonly-reason`', () => {
    const reg = makeRegistry()
    const { root } = mount(readonlyFieldFor(reg, 'stamp', '2026-01-01'))
    const el = root.querySelector('.ux-field-readonly')!
    expect(el).toBeTruthy()
    expect(el.getAttribute('tabindex')).toBe('-1')
    expect(el.getAttribute('data-readonly-code')).toBe('ReadOnly')
    expect(el.getAttribute('data-readonly-reason')).toBe('timestamp')
    // **没有**可输入的控件（「能输入但没反应」是旧实现的形态）
    expect(root.querySelector('input')).toBeNull()
    expect(root.querySelector('textarea')).toBeNull()
    expect(root.querySelector('select')).toBeNull()
    teardown()
  })
})

describe('控件：值类型驱动的控件选择（D1 的界面要求）', () => {
  it('boolean 用原生可聚焦控件（`input[type=checkbox]` + `role=switch`）', () => {
    const reg = makeRegistry()
    const { root } = mount(fieldFor(reg, 'enabled', true))
    const cb = root.querySelector<HTMLInputElement>('input[type=checkbox]')!
    expect(cb).toBeTruthy()
    expect(cb.getAttribute('role')).toBe('switch')
    expect(cb.getAttribute('aria-checked')).toBe('true')
    teardown()
  })

  it('boolean 点选发出 `commit-value`（不是草稿提交）', () => {
    const reg = makeRegistry()
    const { root, events } = mount(fieldFor(reg, 'enabled', false))
    const cb = root.querySelector<HTMLInputElement>('input[type=checkbox]')!
    cb.checked = true
    fire(cb, 'change')
    expect(events).toEqual([{ kind: 'commit-value', payload: true }])
    teardown()
  })

  it('枚举用 `select`，选项显示**本地化标签**而不是原始值', () => {
    const reg = makeRegistry()
    const { root } = mount(fieldFor(reg, 'mode', 'fast'))
    const sel = root.querySelector<HTMLSelectElement>('select.ux-field-select')!
    expect(sel).toBeTruthy()
    const labels = [...sel.options].map((o) => o.textContent?.trim())
    expect(labels).toEqual(['快速', '慢速'])
    expect([...sel.options].map((o) => o.value)).toEqual(['fast', 'slow'])
    teardown()
  })

  it('数值域声明为滑块时，`step` 来自描述符（不按 range/100 猜）', () => {
    const reg = makeRegistry()
    const reg2 = createPropertyRegistry()
    reg2.registerObjectType({
      id: 'ui.slider',
      ownerKind: 'object',
      display: { labelKey: 'ui.s', fallback: 'S' },
      properties: [
        {
          id: 'v',
          valueType: 'number',
          animatable: false,
          display: { labelKey: 'ui.v', fallback: 'V' },
          domain: { kind: 'number', min: 0, max: 1, hard: true, step: 0.05 },
        },
      ],
    })
    const d = describeProperty(reg2, { owner, property: 'ui.slider.v' })
    if (!d.ok) throw new Error('desc')
    const field = buildFieldViewModel(reg2, { owner, property: 'ui.slider.v' }, {
      descriptor: d.value,
      value: { kind: 'value', value: 0.5 },
      edit: { kind: 'editable' },
    })
    const { root } = mount(field)
    const range = root.querySelector<HTMLInputElement>('input[type=range]')!
    expect(range).toBeTruthy()
    expect(range.getAttribute('step')).toBe('0.05')
    expect(range.getAttribute('min')).toBe('0')
    expect(range.getAttribute('max')).toBe('1')
    void reg
    teardown()
  })

  it('向量渲染**逐分量**输入，改动发 `commit-component`（分量寻址）', () => {
    const reg = makeRegistry()
    const { root, events } = mount(fieldFor(reg, 'offset', { x: 1, y: 2, z: 3 }))
    const comps = root.querySelectorAll<HTMLInputElement>('.ux-field-comp-input')
    expect(comps).toHaveLength(3)
    expect([...comps].map((c) => c.value)).toEqual(['1', '2', '3'])
    comps[1]!.value = '9'
    fire(comps[1]!, 'change')
    expect(events).toEqual([{ kind: 'component', payload: [1, 9] }])
    teardown()
  })

  it('颜色有取色器 + 十六进制文本框；单位符号随描述显示', () => {
    const reg = makeRegistry()
    const { root } = mount(fieldFor(reg, 'tint', '#aabbcc'))
    expect(root.querySelector('input[type=color]')).toBeTruthy()
    expect(root.querySelector('.ux-field-text--mono')).toBeTruthy()

    const countField = fieldFor(reg, 'count', 10)
    const mounted = mount(countField)
    expect(mounted.root.querySelector('.ux-field-unit')?.textContent?.trim()).toBe('件')
    teardown()
    mounted.root.remove()
    app?.unmount()
  })
})

describe('控件：多选混合值（D6 属性区不消失）', () => {
  it('混合值显示「混合」并**不**预填任何一方的值', () => {
    const reg = makeRegistry()
    const d = describeProperty(reg, { owner, property: `${OBJECT_TYPE}.plain` })
    if (!d.ok) throw new Error('desc')
    const field = buildFieldViewModel(reg, { owner, property: `${OBJECT_TYPE}.plain` }, {
      descriptor: d.value,
      value: { kind: 'mixed', refs: [{ owner, property: `${OBJECT_TYPE}.plain` }] },
      edit: { kind: 'editable' },
    })
    const { root, events } = mount(field)
    expect(root.querySelector('.ux-field')?.getAttribute('data-mixed')).toBe('1')
    const input = root.querySelector<HTMLInputElement>('input.ux-field-text')!
    // 不预填首项值（旧实现用「首项值」冒充全体并广播覆盖）
    expect(input.value).toBe('—')
    // 仍可输入统一值（属性区没有因多选而消失）：键入不得触发任何提交意图，
    // 且输入**不**预填首项值 —— 这条在 P10c 后由"组件无提交出口"把守。
    input.value = '42'
    fire(input, 'input')
    expect(events, '键入只改输入层草稿，组件不发提交意图').toEqual([])
    teardown()
  })

  it('混合态的 boolean 用 `aria-checked="mixed"`（三态，不是二态猜测）', () => {
    const reg = makeRegistry()
    const d = describeProperty(reg, { owner, property: `${OBJECT_TYPE}.enabled` })
    if (!d.ok) throw new Error('desc')
    const field = buildFieldViewModel(reg, { owner, property: `${OBJECT_TYPE}.enabled` }, {
      descriptor: d.value,
      value: { kind: 'mixed', refs: [{ owner, property: `${OBJECT_TYPE}.enabled` }] },
      edit: { kind: 'editable' },
    })
    const { root } = mount(field)
    const cb = root.querySelector<HTMLInputElement>('input[type=checkbox]')!
    expect(cb.getAttribute('aria-checked')).toBe('mixed')
    teardown()
  })
})

describe('控件：拒绝原因可见（不得静默失败）', () => {
  it('字段带 `rejection` 时渲染**成句原因**（M4-3：不再是裸错误码）', () => {
    const reg = makeRegistry()
    const d = describeProperty(reg, { owner, property: `${OBJECT_TYPE}.count` })
    if (!d.ok) throw new Error('desc')
    const field = buildFieldViewModel(reg, { owner, property: `${OBJECT_TYPE}.count` }, {
      descriptor: d.value,
      value: { kind: 'value', value: 10 },
      edit: { kind: 'editable' },
      rejection: { code: 'ReadOnly', params: { reason: 'generated-owner' } },
    })
    const { root } = mount(field)
    const problem = root.querySelector('.ux-field-problem')!
    // 用户裁决（2026-10-17）：字段级给**人能读的原因**。裸码 `ReadOnly: generated-owner`
    // 只对开发者有意义；工具提示与 e2e 断言改为读句子。
    expect(problem.textContent).toContain('生成物')
    expect(problem.textContent, '不得再直接输出错误码').not.toContain('generated-owner')
    expect(problem.getAttribute('data-problem'), '拒绝态仍由机器可读属性承载').toBe('rejected')
    teardown()
  })

  it('未知拒绝码**不吞**：句子带原码文本（运行期防御）', () => {
    const reg = makeRegistry()
    const d = describeProperty(reg, { owner, property: `${OBJECT_TYPE}.count` })
    if (!d.ok) throw new Error('desc')
    const field = buildFieldViewModel(reg, { owner, property: `${OBJECT_TYPE}.count` }, {
      descriptor: d.value,
      value: { kind: 'value', value: 10 },
      edit: { kind: 'editable' },
      rejection: { code: 'TotallyUnknown', params: { reason: 'x' } } as never,
    })
    const { root } = mount(field)
    expect(root.querySelector('.ux-field-problem')!.textContent).toContain('TotallyUnknown')
    teardown()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A25（P11-E #262 补）：焦点可见性与**控件标签**的 DOM 判据
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## 这条补的是 A25 的子句缺口（#262 comment 6421 A25 行）
 *
 * B1 的定性：「事实面存在：`PropertyField.vue:294` 产出
 * `aria-label = field.display.labelFallback`、`:483` 有 `:focus` 样式；
 * 但 `workbench/ux/__tests__/property-field.dom.test.ts` 对 `aria-label` **0 命中**
 * ⇒ 有实现无断言，补一条 DOM 判据即可（**改掉 aria-label 即判红**）」。
 *
 * ## 判据口径（为什么期望值**硬编码**而不是从组件内部状态反读）
 *
 * 与本文件头的纪律一致：输入只有 DOM 事件、观察只有 DOM 事实。故 `aria-label`
 * 的期望值写成**字面量**（`'数值'`/`'正文'`/`'色调'`，取自 `makeRegistry()` 里的
 * `display.fallback`）——若实现改成"通用名"（旧 `RNAWidget` 的形态：所有控件都叫
 * `field`），本判据立刻判红。
 *
 * ## 覆盖面的诚实边界（本批只新增判据，不改生产行为）
 *
 * `aria-label` 由 `textFacts` 注入，而 `textFacts` 只绑在**文本族**控件上
 * （默认文本框 / 多行文本 / 字符串列表 / 颜色旁的十六进制框）。复选框、下拉、
 * 滑块目前**没有**程序化可访问名（它们只有同字段内可见的 `<label class="ux-field-label">`
 * 元素，二者未做 `for`/`id` 关联）—— 那是**能力缺口**（补齐需改生产模板，超出本批
 * 「只新增/收紧判据」的范围），故本组：① 对文本族做 `aria-label` 判据；
 * ② 对全部控件做"可见标签存在且文本 = 回退标签"的判据；③ 在完工报里登记该残余。
 */
describe('A25 input-focus-drafts：控件标签（可访问名 + 可见标签）', () => {
  /** 判据本尊（正/负对照共用一份）。 */
  function judgeAccessibleName(el: Element, expected: string): void {
    expect(el.getAttribute('aria-label'), 'A25：控件必须带可访问名（`aria-label`）').toBe(expected)
  }

  /** 可见标签判据：同字段内的 `.ux-field-label` 必须显示回退标签（人读的那一半）。 */
  function judgeVisibleLabel(root: Element, expected: string): void {
    const label = root.querySelector('.ux-field-label')
    expect(label, 'A25：字段必须有可见标签元素').not.toBeNull()
    expect(label?.textContent?.trim(), 'A25：可见标签必须显示回退标签').toBe(expected)
  }

  /** 断言器判红 = 它抛错。 */
  function redOf(run: () => void): boolean {
    try {
      run()
      return false
    } catch {
      return true
    }
  }

  it('正对照：文本族控件的 `aria-label` = 字段回退标签；可见标签同样在案', () => {
    const reg = makeRegistry()
    // ① 默认文本框（number 非硬约束 ⇒ `input.ux-field-text`）
    const plain = mount(fieldFor(reg, 'plain', 10))
    const input = plain.root.querySelector<HTMLInputElement>('input.ux-field-text')!
    expect(input).toBeTruthy()
    judgeAccessibleName(input, '数值')
    judgeVisibleLabel(plain.root, '数值')
    teardown()

    // ② 滑块字段：可见标签必须在（滑块本身无 `aria-label`，见上面的边界说明）
    const count = mount(fieldFor(reg, 'count', 10))
    expect(count.root.querySelector('input[type=range]')).toBeTruthy()
    judgeVisibleLabel(count.root, '数量')
    teardown()

    // ③ 颜色字段：取色器 + 十六进制文本框；后者带可访问名
    const tint = mount(fieldFor(reg, 'tint', '#aabbcc'))
    judgeAccessibleName(tint.root.querySelector<HTMLInputElement>('input.ux-field-text--mono')!, '色调')
    judgeVisibleLabel(tint.root, '色调')
    teardown()
  })

  it('正对照：多行文本的 `aria-label` 走**同一条**事实注入（textarea 也带）', () => {
    const reg = createPropertyRegistry()
    reg.registerObjectType({
      id: 'ui.multi',
      ownerKind: 'object',
      display: { labelKey: 'ui.multi', fallback: 'M' },
      properties: [
        { id: 'body', valueType: 'string', animatable: false, display: { labelKey: 'ui.body', fallback: '正文' }, domain: { kind: 'text', multiline: true } },
      ],
    })
    const d = describeProperty(reg, { owner, property: 'ui.multi.body' })
    if (!d.ok) throw new Error('desc')
    const field = buildFieldViewModel(reg, { owner, property: 'ui.multi.body' }, {
      descriptor: d.value,
      value: { kind: 'value', value: 'line1' },
      edit: { kind: 'editable' },
    })
    const { root } = mount(field)
    const ta = root.querySelector<HTMLTextAreaElement>('textarea')!
    expect(ta).toBeTruthy()
    judgeAccessibleName(ta, '正文')
    teardown()
  })

  it('**负对照**：把 `aria-label` 去掉 / 改成通用名 ⇒ 同一判据判红（含对**真实渲染 DOM** 的就地变异）', () => {
    const reg = makeRegistry()
    const { root } = mount(fieldFor(reg, 'plain', 10))
    const input = root.querySelector<HTMLInputElement>('input.ux-field-text')!
    // 前置：正对照判绿
    expect(redOf(() => judgeAccessibleName(input, '数值'))).toBe(false)

    // 就地变异 1：**真的**把属性摘掉（模拟"实现里不再产出 aria-label"）
    const original = input.getAttribute('aria-label')
    input.removeAttribute('aria-label')
    expect(redOf(() => judgeAccessibleName(input, '数值')), '摘掉 aria-label ⇒ 必须判红').toBe(true)

    // 就地变异 2：改成**通用名**（旧 `RNAWidget` 的形态：所有控件都叫 field）
    input.setAttribute('aria-label', 'field')
    expect(redOf(() => judgeAccessibleName(input, '数值')), '改成通用名 ⇒ 必须判红').toBe(true)

    // 就地变异 3：改名（不再是该字段的回退标签）
    input.setAttribute('aria-label', '数量')
    expect(redOf(() => judgeAccessibleName(input, '数值')), '写成别的字段的标签 ⇒ 必须判红').toBe(true)

    // 恢复 ⇒ 判绿（证明判据咬的是这个属性本身，不是"恒红"）
    input.setAttribute('aria-label', original ?? '')
    expect(redOf(() => judgeAccessibleName(input, '数值')), '恢复原值 ⇒ 判绿').toBe(false)

    // 可见标签同样有区分力：清空它 ⇒ 判红
    const label = root.querySelector('.ux-field-label')!
    label.textContent = ''
    expect(redOf(() => judgeVisibleLabel(root, '数值')), '可见标签被清空 ⇒ 必须判红').toBe(true)
    label.textContent = '数值'
    expect(redOf(() => judgeVisibleLabel(root, '数值'))).toBe(false)
    teardown()
  })
})

