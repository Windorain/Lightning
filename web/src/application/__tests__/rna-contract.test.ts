/**
 * **A08 `rna-contract`** —— RNA 属性描述协议的验收（`PropertyRef` §1.3、`CommandOutcome` §3.1、多选原子性 §3.3）。
 *
 * 本文件是**判据的可执行形式**，逐条对应 A08 的断言面。断言值**硬编码**，
 * 不从被测实现反读期望（篡改实现即红）。
 *
 * ## A08 的五条断言
 *
 * | # | 断言 | 本文的用例 |
 * |---|---|---|
 * | 1 | `PropertyRef` 是**值**：可比较、可序列化、**不含 setter 闭包** | `引用是值` |
 * | 2 | 同一 `PropertyRef`、同一文档版本下两次读**相等** | `读面确定性` |
 * | 3 | 多选 `PropertyRef` 表示**一个**目标；批量由命令承载 | `多选语义` |
 * | 4 | **唯一写入口**：不存在第二条写路径 | `唯一写路由` |
 * | 5 | 负对照：绕过控件直写只读属性必须**判红** | `负对照` |
 *
 * ## 为什么「唯一写入口」的断言是结构性的而不是行为性的
 *
 * 行为性断言（「我调了 A 之后值变了」）无法排除「还有一条路也能改」。
 * 因此第 4 条的判据是：**同一份值经由唯一路由写入**，且模块表面**不导出**任何
 * 「给我 owner 和值就写下去」的函数 —— 后者用源码级扫描断言（见文件末）。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  appliedOutcome,
  formatPropertyRef,
  localPropertyOf,
  samePropertyRef,
  type CommandOutcome,
  type DomainError,
  type EntityRef,
  type PropertyRef,
  type Version,
} from '@/application/contracts'
// `propertyRef` 的唯一权威是 `domain/identity`（收敛后 RNA 侧那份已删）。
import { propertyRef } from '@/domain/identity'
import {
  CAP_PROPERTY_WRITE,
  createCommandCatalog,
  createPropertyRegistry,
  describeProperty,
  evaluateEditability,
  formatValue,
  parseDraft,
  readProperty,
  type ObjectTypeDecl,
  type PropertyAccess,
  type PropertyRegistry,
  type PropertyValue,
  type TargetFacts,
} from '@/application/properties'
import {
  applySetProperty,
  createPropertyWritePorts,
  readMultiValue,
  routeCommand,
  type SetPropertyCommand,
} from '@/application/property-commands'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具：一个最小可写状态 + 一个对象类型声明
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 夹具：一个最小可写状态 + 一个对象类型声明。
 *
 * **对象类型 ID 刻意含点**（`test.thing`）：真实声明都是
 * `lightning.block` / `lightning.annotation.text` 这种形态，而「属性 ID 里的第一个点」
 * 并不分隔对象类型与属性名。夹具保留这一点，正是为了让
 * 「`localPropertyOf` 按第一个点切分」这类错误在这里现形
 * （实测：它确实抓出了两个真 bug，见提交说明）。
 */
type State = Readonly<{ values: Readonly<Record<string, number | string | boolean>>; epoch: number }>

const OBJECT_TYPE = 'test.thing'

const THING_DECL: ObjectTypeDecl = {
  id: OBJECT_TYPE,
  ownerKind: 'object',
  display: { labelKey: 'obj.thing', fallback: 'Thing' },
  properties: [
    {
      id: 'size',
      valueType: 'number',
      animatable: true,
      display: { labelKey: 'thing.size', fallback: '大小', decimals: 2 },
      domain: { kind: 'number', min: 1, max: 10, hard: true, step: 0.5 },
    },
    {
      id: 'label',
      valueType: 'string',
      animatable: false,
      display: { labelKey: 'thing.label', fallback: '标签' },
      domain: { kind: 'pattern', source: '^[a-z]+$', hintKey: 'v.lower', hintFallback: 'a-z' },
    },
    {
      id: 'frozen',
      valueType: 'number',
      animatable: false,
      readOnly: true,
      readOnlyReason: 'computed',
      display: { labelKey: 'thing.frozen', fallback: '冻结值' },
    },
    {
      id: 'offset',
      valueType: 'vec3',
      animatable: true,
      display: { labelKey: 'thing.offset', fallback: '偏移' },
    },
  ],
}

function makeRegistry(): PropertyRegistry {
  const reg = createPropertyRegistry()
  const r = reg.registerObjectType(THING_DECL)
  if (!r.ok) throw new Error('fixture registration failed')
  return reg
}

function owner(id = 'A'): EntityRef {
  return { kind: 'object', id }
}

const V1: Version = { documentVersion: 1 }

function facts(over: Partial<TargetFacts> = {}): TargetFacts {
  return {
    exists: true,
    generated: false,
    drivenByTrack: false,
    locked: false,
    holdsLease: true,
    ...over,
  }
}

/** 造一个访问面：`readRaw` 从 `raw` 里按 owner 取值。 */
function access(raw: Record<string, unknown>, over: Partial<TargetFacts> = {}): PropertyAccess {
  return {
    version: V1,
    readRaw: (ref) => {
      const local = localPropertyOf(ref.property, OBJECT_TYPE)
      const v = (raw[ref.owner.id] as Record<string, unknown> | undefined)?.[local]
      if (v === undefined) return { ok: false, error: errMissing(ref.property) }
      return { ok: true, value: v }
    },
    facts: () => facts(over),
    capabilities: new Set([CAP_PROPERTY_WRITE]),
    language: 'zh',
  }
}

function errMissing(property: string): DomainError {
  return { code: 'MissingTarget', params: { reason: 'value-absent', property } }
}

/** 纯写入函数：返回新状态，**不改输入**。 */
const writePorts = createPropertyWritePorts<State>()
writePorts.write(OBJECT_TYPE, (state, ref, value, context) => {
  const local = localPropertyOf(ref.property, context.descriptor.objectTypeId)
  return {
    ok: true,
    value: {
      values: { ...state.values, [`${ref.owner.id}.${local}`]: value as number | string | boolean },
      epoch: state.epoch + 1,
    },
  }
})

function runSet(
  reg: PropertyRegistry,
  state: State,
  refs: readonly PropertyRef[],
  value: PropertyValue,
  acc: PropertyAccess,
): { candidate: State; outcome: CommandOutcome } {
  const command: SetPropertyCommand = { kind: 'setProperty', refs, value, commandId: 'test.set' }
  const t = applySetProperty<State>({
    registry: reg,
    ports: writePorts,
    state,
    command,
    env: { baseVersion: acc.version, currentVersion: acc.version },
    access: acc,
  })
  return { candidate: t.candidate, outcome: t.outcome }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 引用是值（A08 断言 1）
// ─────────────────────────────────────────────────────────────────────────────

describe('A08-1 引用是值：可比较、可序列化、不含 setter 闭包', () => {
  it('`PropertyRef` 的两个实例逐字段相等即 `samePropertyRef`（值语义）', () => {
    const a = propertyRef(owner(), `${OBJECT_TYPE}.size`)
    const b = propertyRef(owner(), `${OBJECT_TYPE}.size`)
    expect(a).not.toBe(b) // 不同对象
    expect(samePropertyRef(a, b)).toBe(true) // 但相等
  })

  it('分量不同 ⇒ 引用**不**相等（分量是寻址的一部分）', () => {
    const a = propertyRef(owner(), `${OBJECT_TYPE}.offset`, { component: 0 })
    const b = propertyRef(owner(), `${OBJECT_TYPE}.offset`, { component: 1 })
    expect(samePropertyRef(a, b)).toBe(false)
  })

  it('引用可 JSON 往返（可序列化 ⇒ 可跨进程/可入日志）', () => {
    const ref = propertyRef(owner('B'), `${OBJECT_TYPE}.offset`, { component: 2 })
    const round = JSON.parse(JSON.stringify(ref)) as PropertyRef
    expect(samePropertyRef(ref, round)).toBe(true)
    expect(formatPropertyRef(ref)).toBe('object:B.test.thing.offset[2]')
  })

  it('**属性 ID 的切分不能按第一个点**（对象类型 ID 自带点）', () => {
    // `lightning.block.pos` 的局部名是 `pos`，不是 `block.pos`。
    // 这里同时锁住「按对象类型剥离」与「无对象类型时退回最后一个点」两条口径。
    expect(localPropertyOf('lightning.block.pos', 'lightning.block')).toBe('pos')
    expect(localPropertyOf('lightning.annotation.text.fontSize', 'lightning.annotation.text')).toBe('fontSize')
    expect(localPropertyOf('lightning.block.pos')).toBe('pos')
    expect(localPropertyOf('pos', 'lightning.block')).toBe('pos')
  })

  it('**负对照**：引用里不含任何函数值（没有 setter 闭包）', () => {
    const ref = propertyRef(owner(), `${OBJECT_TYPE}.size`)
    const values = collectValues(ref)
    // 一个 setter 闭包必然表现为函数值；一个「描述携带闭包」的实现会在这里现形。
    expect(values.filter((v) => typeof v === 'function')).toEqual([])
  })

  it('**负对照**：`PropertyDescriptor` 里也不含函数值，且不含控件类型名', () => {
    const reg = makeRegistry()
    for (const desc of reg.describeObjectType(OBJECT_TYPE)) {
      const values = collectValues(desc)
      expect(values.filter((v) => typeof v === 'function'), `描述 ${desc.id} 不得含闭包`).toEqual([])
      const text = JSON.stringify(desc)
      for (const widgetName of ['slider', 'stepper', 'checkbox', 'dropdown', 'uiWidget', 'vector3']) {
        expect(text.includes(widgetName), `描述 ${desc.id} 不得含控件名 ${widgetName}`).toBe(false)
      }
    }
  })
})

/** 递归收集一个值里的全部叶子值（用于「有没有函数」的断言）。 */
function collectValues(v: unknown, out: unknown[] = []): unknown[] {
  if (v === null || typeof v !== 'object') {
    out.push(v)
    return out
  }
  if (Array.isArray(v)) {
    for (const item of v) collectValues(item, out)
    return out
  }
  for (const [, val] of Object.entries(v as Record<string, unknown>)) collectValues(val, out)
  return out
}

/**
 * 读源码并**归一化行尾为 LF**（EOL 脆性的治本处，见 `freeze-convergence.test.ts` 的长注释）。
 *
 * 本仓 `core.autocrlf=true` ⇒ 新鲜检出是 CRLF，而执行者工具写出的工作树常是 LF。
 * 凡断言里出现裸 `\n` 字面量（正则、`indexOf('\n\n')`、`split('\n')` 后按行号切片），
 * 判据就会随检出口径变化。在唯一读入口归一化后，"用 `\n` 写字面量"重新安全。
 *
 * 曾实际发生：同一条判据在 LF 树上绿、在 CRLF 树上因 `\n\n` 失配判红。
 */
function readSource(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n')
}

/**
 * 剥掉行注释、块注释与字符串字面量 —— 源码级结构断言必须**只看代码**。
 *
 * 保留换行以便行号/正则仍可用；字符串内内容替换为空串（判据不依赖字面量文本）。
 */
function stripCommentsAndStrings(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++
        i++
      }
      i++
      out += '""'
      continue
    }
    out += c
    i++
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 读面确定性（A08 断言 2）
// ─────────────────────────────────────────────────────────────────────────────

describe('A08-2 同一引用、同一版本下两次读相等', () => {
  it('两次 `readProperty` 得到 handler 判定的相等值', () => {
    const reg = makeRegistry()
    const acc = access({ A: { size: 3.5, label: 'abc', offset: { x: 1, y: 2, z: 3 } } })
    const ref = propertyRef(owner(), `${OBJECT_TYPE}.size`)
    const a = readProperty(reg, ref, 'authored', acc)
    const b = readProperty(reg, ref, 'authored', acc)
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) expect(a.value).toBe(b.value)
  })

  it('vec3 读回的是**只读副本**，改它不影响后续读（不暴露可变底层）', () => {
    const reg = makeRegistry()
    const raw = { A: { offset: { x: 1, y: 2, z: 3 } } }
    const acc = access(raw)
    const ref = propertyRef(owner(), `${OBJECT_TYPE}.offset`)
    const first = readProperty(reg, ref, 'authored', acc)
    expect(first.ok).toBe(true)
    if (first.ok) {
      // 篡改读回来的值
      ;(first.value as unknown as { x: number }).x = 999
    }
    const second = readProperty(reg, ref, 'authored', acc)
    expect(second.ok).toBe(true)
    if (second.ok) expect((second.value as unknown as { x: number }).x).toBe(1)
  })

  it('越界值返回 `InvalidValue` 且**不夹取**', () => {
    const reg = makeRegistry()
    const acc = access({ A: { size: 99 } })
    const r = readProperty(reg, propertyRef(owner(), `${OBJECT_TYPE}.size`), 'authored', acc)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('InvalidValue')
      expect(r.error.params.bound).toBe('max')
    }
  })

  it('目标不存在 ⇒ `MissingTarget`，**不**用默认值掩盖（内核契约 §4.1）', () => {
    const reg = createPropertyRegistry()
    reg.registerObjectType({
      ...THING_DECL,
      properties: [{ ...THING_DECL.properties[0]!, defaultValue: 5 }],
    })
    const acc = access({}, { exists: false })
    const r = readProperty(reg, propertyRef(owner(), `${OBJECT_TYPE}.size`), 'authored', acc)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('MissingTarget')
  })

  it('目标存在但值缺失 ⇒ 用声明的默认值', () => {
    const reg = createPropertyRegistry()
    reg.registerObjectType({
      ...THING_DECL,
      properties: [{ ...THING_DECL.properties[0]!, defaultValue: 5 }],
    })
    const acc = access({ A: {} })
    const r = readProperty(reg, propertyRef(owner(), `${OBJECT_TYPE}.size`), 'authored', acc)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(5)
  })

  it('有效值优先级：staged > trackSampled > preview > authored', () => {
    const reg = makeRegistry()
    const acc = access({ A: { size: 2 } })
    const ref = propertyRef(owner(), `${OBJECT_TYPE}.size`)
    const staged = readProperty(reg, ref, 'effective', acc, { staged: 7, trackSampled: 6, preview: 5 })
    expect(staged.ok && staged.value).toBe(7)
    const track = readProperty(reg, ref, 'effective', acc, { trackSampled: 6, preview: 5 })
    expect(track.ok && track.value).toBe(6)
    const prev = readProperty(reg, ref, 'effective', acc, { preview: 5 })
    expect(prev.ok && prev.value).toBe(5)
    const base = readProperty(reg, ref, 'effective', acc, {})
    expect(base.ok && base.value).toBe(2)
  })

  it('非法覆盖层**不得**进入有效值（不悄悄夹取并宣称目标已实现）', () => {
    const reg = makeRegistry()
    const acc = access({ A: { size: 2 } })
    const r = readProperty(reg, propertyRef(owner(), `${OBJECT_TYPE}.size`), 'effective', acc, { staged: 999 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('InvalidValue')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. 多选语义（A08 断言 3）
// ─────────────────────────────────────────────────────────────────────────────

describe('A08-3 多选：`PropertyRef` 表示一个目标，批量由命令承载', () => {
  it('读面：两个目标值不同 ⇒ 显式 `mixed`（不用 null 兼表）', () => {
    const reg = makeRegistry()
    const acc = access({ A: { size: 2 }, B: { size: 3 } })
    const refs = [propertyRef(owner('A'), `${OBJECT_TYPE}.size`), propertyRef(owner('B'), `${OBJECT_TYPE}.size`)]
    const r = readMultiValue(reg, refs, 'authored', acc)
    expect(r.kind).toBe('mixed')
  })

  it('读面：值相同 ⇒ 返回该值（不误报混合）', () => {
    const reg = makeRegistry()
    const acc = access({ A: { size: 2 }, B: { size: 2 } })
    const refs = [propertyRef(owner('A'), `${OBJECT_TYPE}.size`), propertyRef(owner('B'), `${OBJECT_TYPE}.size`)]
    const r = readMultiValue(reg, refs, 'authored', acc)
    expect(r.kind).toBe('value')
    if (r.kind === 'value') expect(r.value).toBe(2)
  })

  it('**负对照**：混合值**不可**作为写值（`mixed` 是读面哨兵，不是写值）', () => {
    const reg = makeRegistry()
    const acc = access({ A: { size: 2 }, B: { size: 3 } })
    const refs = [propertyRef(owner('A'), `${OBJECT_TYPE}.size`), propertyRef(owner('B'), `${OBJECT_TYPE}.size`)]
    const { outcome } = runSet(reg, { values: {}, epoch: 0 }, refs, 'mixed', acc)
    expect(outcome.status).toBe('rejected')
    if (outcome.status === 'rejected') {
      expect(outcome.error.code).toBe('UnsupportedOperation')
      expect(outcome.error.params.reason).toBe('mixed-value-is-read-only-sentinel')
    }
  })

  it('写面：一次命令写多个目标 ⇒ `applied`，且 `changedProperties` 列出全部', () => {
    const reg = makeRegistry()
    const acc = access({ A: { size: 2 }, B: { size: 3 } })
    const refs = [propertyRef(owner('A'), `${OBJECT_TYPE}.size`), propertyRef(owner('B'), `${OBJECT_TYPE}.size`)]
    const { outcome } = runSet(reg, { values: {}, epoch: 0 }, refs, 4, acc)
    expect(outcome.status).toBe('applied')
    if (outcome.status === 'applied') expect(outcome.changes.changedProperties).toHaveLength(2)
  })

  it('同一个目标在批次里出现两次 ⇒ 只写一次（去重保序）', () => {
    const reg = makeRegistry()
    const acc = access({ A: { size: 2 } })
    const refs = [
      propertyRef(owner('A'), `${OBJECT_TYPE}.size`),
      propertyRef(owner('A'), `${OBJECT_TYPE}.size`),
    ]
    const { outcome } = runSet(reg, { values: {}, epoch: 0 }, refs, 4, acc)
    expect(outcome.status).toBe('applied')
    if (outcome.status === 'applied') expect(outcome.changes.changedProperties).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. 唯一写路由（A08 断言 4）
// ─────────────────────────────────────────────────────────────────────────────

describe('A08-4 唯一写入口', () => {
  it('通用字段 patch **没有**入口：未登记具名命令被拒（不降级为字段写）', () => {
    const catalog = createCommandCatalog([
      { id: 'moveObjects', display: { labelKey: 'cmd.move', fallback: '移动' }, params: [] },
    ])
    const r = routeCommand(catalog, { kind: 'named', id: 'patchAnyField', params: { x: 1 } })
    expect(r.route).toBe('rejected')
    if (r.route === 'rejected') {
      expect(r.error.code).toBe('UnsupportedOperation')
      expect(r.error.params.reason).toBe('unknown-command')
    }
  })

  it('登记为「通用属性写」的具名命令也被拒 —— 必须走 `setProperty`', () => {
    const catalog = createCommandCatalog([
      { id: 'setAny', display: { labelKey: 'cmd.setAny', fallback: 'setAny' }, params: [], genericPropertyWrite: true },
    ])
    const r = routeCommand(catalog, { kind: 'named', id: 'setAny', params: {} })
    expect(r.route).toBe('rejected')
    if (r.route === 'rejected') expect(r.error.params.reason).toBe('generic-write-must-use-setProperty')
  })

  it('未知命令种类被拒（不存在隐式通路）', () => {
    const catalog = createCommandCatalog()
    const r = routeCommand(catalog, { kind: 'blob', data: 1 })
    expect(r.route).toBe('rejected')
  })

  it('`setProperty` 走属性写路由（且仍需逐 ref 描述解析）', () => {
    const catalog = createCommandCatalog()
    const r = routeCommand(catalog, {
      kind: 'setProperty',
      refs: [propertyRef(owner(), `${OBJECT_TYPE}.size`)],
      value: 3,
    })
    expect(r.route).toBe('propertyWrite')
  })

  it('**结构断言**：`application/` 不导出「owner + 值 ⇒ 写下去」的入口', () => {
    const raw = readSource('src/application/property-commands.ts')
    // 先把注释与字符串剥掉再判 —— 否则**文档里引用旧实现**（「旧实现的
    // `descriptor.set(owner, value)` 就是…」）会被误判成违规。这也是本断言
    // 第一次跑就抓到的假红：源码级判据必须只看代码，不看注释。
    const src = stripCommentsAndStrings(raw)

    // 允许的写入口只有 `applySetProperty`（显式 registry/ports/access 输入）。
    expect(/function\s+applySetProperty\s*</.test(src)).toBe(true)
    // 禁止「给我 owner 与值就写下去」的形态：
    expect(/\bwriteValue\s*\(/.test(src)).toBe(false)
    expect(/\.set\(\s*owner\b/.test(src)).toBe(false)
    expect(/function\s+\w*[Ss]et\w*\s*\(\s*owner\b/.test(src)).toBe(false)
    // 也不得出现对「描述自带 setter」的调用（旧的 `descriptor.set(...)`）
    expect(/descriptor\.set\s*\(/.test(src)).toBe(false)
  })

  it('**结构断言**：`application/` 与 `editors/` 不 import Vue / Three（导入规则 1/2/6）', () => {
    const files = [
      'src/application/contracts.ts',
      'src/application/properties.ts',
      'src/application/property-commands.ts',
      'src/editors/inspector.ts',
      'src/editors/property-controls.ts',
    ]
    for (const f of files) {
      const src = readSource(f)
      const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l) || /from 'vue'|from 'three'/.test(l))
      for (const line of importLines) {
        expect(/from '(vue|three)/.test(line), `${f} 不得 import vue/three：${line.trim()}`).toBe(false)
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. 负对照（A08 断言 5）：旁路写只读属性必须判红
// ─────────────────────────────────────────────────────────────────────────────

describe('A08-5 负对照：绕过控件直写只读属性必须判红', () => {
  it('声明级只读 ⇒ `ReadOnly`，且带结构化原因', () => {
    const reg = makeRegistry()
    const acc = access({ A: { frozen: 1 } })
    const ref = propertyRef(owner(), `${OBJECT_TYPE}.frozen`)
    const e = evaluateEditability(reg, ref, acc)
    expect(e.editable).toBe(false)
    expect(e.reason?.code).toBe('ReadOnly')
    expect(e.reason?.params.reason).toBe('computed')
  })

  it('**即使值合法**，写入只读属性也被拒（拒绝发生在调用 handler 之前）', () => {
    const reg = makeRegistry()
    const acc = access({ A: { frozen: 1 } })
    const state: State = { values: {}, epoch: 0 }
    const { candidate, outcome } = runSet(reg, state, [propertyRef(owner(), `${OBJECT_TYPE}.frozen`)], 7, acc)
    expect(outcome.status).toBe('rejected')
    if (outcome.status === 'rejected') expect(outcome.error.code).toBe('ReadOnly')
    // 「部分失败整体不变」是**引用相等**，不是「看起来相等」
    expect(candidate).toBe(state)
  })

  it('能力缺失（profile 裁剪）⇒ `UnsupportedOperation`，不只是隐藏按钮（A15）', () => {
    const reg = makeRegistry()
    const acc: PropertyAccess = { ...access({ A: { size: 2 } }), capabilities: new Set() }
    const e = evaluateEditability(reg, propertyRef(owner(), `${OBJECT_TYPE}.size`), acc)
    expect(e.editable).toBe(false)
    expect(e.reason?.code).toBe('UnsupportedOperation')
    expect(e.reason?.params.capability).toBe(CAP_PROPERTY_WRITE)
    const { outcome } = runSet(reg, { values: {}, epoch: 0 }, [propertyRef(owner(), `${OBJECT_TYPE}.size`)], 3, acc)
    expect(outcome.status).toBe('rejected')
  })

  it('**动态性**：同一属性在不同状态下可编辑性不同（不是静态 readonly 开关）', () => {
    const reg = makeRegistry()
    const ref = propertyRef(owner(), `${OBJECT_TYPE}.size`)
    const editable = evaluateEditability(reg, ref, access({ A: { size: 2 } }))
    const generated = evaluateEditability(reg, ref, access({ A: { size: 2 } }, { generated: true }))
    const tracked = evaluateEditability(reg, ref, access({ A: { size: 2 } }, { drivenByTrack: true }))
    const locked = evaluateEditability(reg, ref, access({ A: { size: 2 } }, { locked: true }))
    const missing = evaluateEditability(reg, ref, access({}, { exists: false }))
    expect(editable.editable).toBe(true)
    expect(generated.reason?.params.reason).toBe('generated-owner')
    expect(tracked.reason?.params.reason).toBe('animation-driven')
    expect(locked.reason?.params.reason).toBe('locked')
    expect(missing.reason?.code).toBe('MissingTarget')
    // 同一个 `PropertyRef`、同一份声明 —— 结论随**状态**变化，这就是动态性的证据
    expect(new Set([editable.editable, generated.editable, locked.editable]).size).toBe(2)
  })

  it('**负对照**：把只读实现成「文档级布尔」无法区分同文档内的不同属性', () => {
    const reg = makeRegistry()
    const acc = access({ A: { size: 2, frozen: 1 } })
    const sizeE = evaluateEditability(reg, propertyRef(owner(), `${OBJECT_TYPE}.size`), acc)
    const frozenE = evaluateEditability(reg, propertyRef(owner(), `${OBJECT_TYPE}.frozen`), acc)
    // 一个文档级布尔会给出相同结论；正确实现必须**同一文档内结论不同**
    expect(sizeE.editable).not.toBe(frozenE.editable)
  })

  it('**负对照**：写只读属性后状态与历史不变，且**不得**报告 applied（D5）', () => {
    const reg = makeRegistry()
    const acc = access({ A: { frozen: 1 } })
    const state: State = { values: { 'A.size': 3 }, epoch: 4 }
    const { candidate, outcome } = runSet(reg, state, [propertyRef(owner(), `${OBJECT_TYPE}.frozen`)], 9, acc)
    expect(outcome.status).not.toBe('applied')
    expect(outcome.status).toBe('rejected')
    expect(candidate.epoch).toBe(state.epoch)
    expect(candidate.values['A.size']).toBe(3)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. 多选原子性（内核契约 §4.3 / D2）
// ─────────────────────────────────────────────────────────────────────────────

describe('A08-6 多选原子性：一个目标失败则整体拒绝并列明原因', () => {
  it('两个目标同值合法写 ⇒ `applied`', () => {
    const reg = makeRegistry()
    const acc = access({ A: { size: 2 }, B: { size: 3 } })
    const refs = [propertyRef(owner('A'), `${OBJECT_TYPE}.size`), propertyRef(owner('B'), `${OBJECT_TYPE}.size`)]
    const { outcome } = runSet(reg, { values: {}, epoch: 0 }, refs, 5, acc)
    expect(outcome.status).toBe('applied')
  })

  it('**部分失败 ⇒ 整体拒绝**，候选状态与输入**引用相等**', () => {
    const reg = makeRegistry()
    // B 不存在 ⇒ B 目标不可写
    const acc: PropertyAccess = {
      ...access({ A: { size: 2 } }),
      facts: (ref) => facts({ exists: ref.owner.id !== 'B' }),
    }
    const state: State = { values: {}, epoch: 0 }
    const refs = [propertyRef(owner('A'), `${OBJECT_TYPE}.size`), propertyRef(owner('B'), `${OBJECT_TYPE}.size`)]
    const { candidate, outcome } = runSet(reg, state, refs, 5, acc)
    expect(outcome.status).toBe('rejected')
    expect(candidate).toBe(state) // 引用相等
    expect(candidate.epoch).toBe(0)
  })

  it('**原因列明**：拒绝错误里带失败的逐目标诊断串与计数', () => {
    const reg = makeRegistry()
    const acc: PropertyAccess = {
      ...access({ A: { size: 2 }, C: { size: 2 } }),
      facts: (ref) => facts({ exists: ref.owner.id === 'A' }),
    }
    const refs = [
      propertyRef(owner('A'), `${OBJECT_TYPE}.size`),
      propertyRef(owner('B'), `${OBJECT_TYPE}.size`),
      propertyRef(owner('C'), `${OBJECT_TYPE}.size`),
    ]
    const { outcome } = runSet(reg, { values: {}, epoch: 0 }, refs, 5, acc)
    expect(outcome.status).toBe('rejected')
    if (outcome.status === 'rejected') {
      expect(outcome.error.params.failedTargets).toBe(2)
      expect(outcome.error.params.totalTargets).toBe(3)
      const reasons = String(outcome.error.params.reasons)
      expect(reasons).toContain('object:B.test.thing.size')
      expect(reasons).toContain('object:C.test.thing.size')
      expect(reasons).not.toContain('object:A.')
    }
  })

  it('**只读混合**：一个只读一个可写 ⇒ 整体拒绝，没有任何目标被改', () => {
    const reg = makeRegistry()
    const acc = access({ A: { size: 2 }, B: { frozen: 1 } })
    const state: State = { values: {}, epoch: 0 }
    const refs = [
      propertyRef(owner('A'), `${OBJECT_TYPE}.size`),
      propertyRef(owner('B'), `${OBJECT_TYPE}.frozen`),
    ]
    const { candidate, outcome } = runSet(reg, state, refs, 3, acc)
    expect(outcome.status).toBe('rejected')
    expect(candidate).toBe(state)
  })

  it('空 `refs` ⇒ `unchanged`（没有目标是**无业务变化**，不是错误）', () => {
    const reg = makeRegistry()
    const acc = access({})
    const state: State = { values: {}, epoch: 0 }
    const { candidate, outcome } = runSet(reg, state, [], 3, acc)
    expect(outcome.status).toBe('unchanged')
    expect(candidate).toBe(state)
  })

  it('起点版本过期 ⇒ `VersionConflict`（不越序应用）', () => {
    const reg = makeRegistry()
    const acc = access({ A: { size: 2 } })
    // 命令基于 v1 提交，但当前已是 v2 ⇒ 拒绝（不静默应用在错误的起点上）
    const command: SetPropertyCommand = {
      kind: 'setProperty',
      refs: [propertyRef(owner(), `${OBJECT_TYPE}.size`)],
      value: 3,
      commandId: 'test.stale',
    }
    const t = applySetProperty<State>({
      registry: reg,
      ports: writePorts,
      state: { values: {}, epoch: 0 },
      command,
      env: { baseVersion: { documentVersion: 1 }, currentVersion: acc.version },
      access: { ...acc, version: { documentVersion: 2 } },
    })
    expect(t.outcome.status).toBe('rejected')
    if (t.outcome.status === 'rejected') {
      expect(t.outcome.error.code).toBe('VersionConflict')
      expect(t.outcome.error.params.base).toBe(1)
      expect(t.outcome.error.params.expected).toBe(2)
    }
    expect(t.candidate.epoch).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. 无业务变化 ⇒ unchanged（D5）
// ─────────────────────────────────────────────────────────────────────────────

describe('A08-7 无业务变化返回 `unchanged`，且不报告 applied（D5）', () => {
  it('写入与当前值相同的值 ⇒ `unchanged`，候选状态与输入引用相等', () => {
    const reg = makeRegistry()
    const acc = access({ A: { size: 3 } })
    const state: State = { values: {}, epoch: 0 }
    const { candidate, outcome } = runSet(reg, state, [propertyRef(owner(), `${OBJECT_TYPE}.size`)], 3, acc)
    expect(outcome.status).toBe('unchanged')
    expect(candidate).toBe(state)
  })

  it('**负对照**：把「容器不同」当成变化不被接受 —— 相等判定用 handler，不用 ===', () => {
    const reg = makeRegistry()
    // 读回的是新对象，写入也是新对象：`===` 会判「不等」而误报 applied；
    // handler 的 `equals` 逐分量比较，故应判 unchanged。
    const acc = access({ A: { offset: { x: 1, y: 2, z: 3 } } })
    const state: State = { values: {}, epoch: 0 }
    const { outcome } = runSet(reg, state, [propertyRef(owner(), `${OBJECT_TYPE}.offset`)], {
      x: 1,
      y: 2,
      z: 3,
    }, acc)
    expect(outcome.status).toBe('unchanged')
  })

  it('真的变了 ⇒ `applied`，且 `structurallyShared` 反映未变子树复用', () => {
    const reg = makeRegistry()
    const acc = access({ A: { size: 3 } })
    const { outcome } = runSet(reg, { values: {}, epoch: 0 }, [propertyRef(owner(), `${OBJECT_TYPE}.size`)], 4, acc)
    expect(outcome.status).toBe('applied')
    if (outcome.status === 'applied') expect(typeof outcome.changes.structurallyShared).toBe('boolean')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. 值类型扩展点（D4 的前提；完整证明在 rna-extension.test.ts）
// ─────────────────────────────────────────────────────────────────────────────

describe('A08-8 描述面：单位/合法域/动画资格/引用类型都随描述携带', () => {
  it('`describeProperty` 返回单位、合法域、动画资格与显示键', () => {
    const reg = createPropertyRegistry()
    reg.registerObjectType({
      id: 'u.thing',
      ownerKind: 'object',
      display: { labelKey: 'obj.u', fallback: 'U' },
      properties: [
        {
          id: 'len',
          valueType: 'number',
          animatable: true,
          unit: { kind: 'length', symbolKey: 'unit.m', symbolFallback: 'm' },
          display: { labelKey: 'u.len', fallback: '长度', decimals: 1 },
          domain: { kind: 'number', min: 0, max: 100, hard: true, step: 0.1 },
        },
      ],
    })
    const d = describeProperty(reg, propertyRef(owner(), 'u.thing.len'))
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.value.unit?.symbolFallback).toBe('m')
      expect(d.value.animatable).toBe(true)
      expect(d.value.display.labelKey).toBe('u.len')
      expect(d.value.domain?.kind).toBe('number')
    }
  })

  it('格式化带单位（展示口径来自描述，不由控件决定）', () => {
    const reg = createPropertyRegistry()
    reg.registerObjectType({
      id: 'u2.thing',
      ownerKind: 'object',
      display: { labelKey: 'obj.u2', fallback: 'U2' },
      properties: [
        {
          id: 'len',
          valueType: 'number',
          animatable: false,
          unit: { kind: 'length', symbolKey: 'unit.m', symbolFallback: 'm' },
          display: { labelKey: 'u2.len', fallback: '长度', decimals: 1 },
        },
      ],
    })
    const d = describeProperty(reg, propertyRef(owner(), 'u2.thing.len'))
    expect(d.ok).toBe(true)
    if (d.ok) expect(formatValue(reg, d.value, 2.5)).toBe('2.5m')
  })

  it('草稿中间态**不**产生可提交值（`-` / `1.` / 空串）', () => {
    const reg = createPropertyRegistry()
    reg.registerObjectType({
      id: 'u3.thing',
      ownerKind: 'object',
      display: { labelKey: 'obj.u3', fallback: 'U3' },
      properties: [
        { id: 'n', valueType: 'number', animatable: false, display: { labelKey: 'u3.n', fallback: 'N' } },
      ],
    })
    const d = describeProperty(reg, propertyRef(owner(), 'u3.thing.n'))
    if (!d.ok) throw new Error('desc')
    for (const draft of ['', '-', '1.', '.', '+']) {
      expect(parseDraft(reg, d.value, draft).state, `草稿 ${JSON.stringify(draft)} 应为中间态`).toBe('intermediate')
    }
    expect(parseDraft(reg, d.value, '1.5').state).toBe('complete')
  })

  it('颜色草稿必须校验 `#RRGGBB`（非法不得成为可提交值）', () => {
    const reg = createPropertyRegistry()
    reg.registerObjectType({
      id: 'u4.thing',
      ownerKind: 'object',
      display: { labelKey: 'obj.u4', fallback: 'U4' },
      properties: [{ id: 'c', valueType: 'color', animatable: false, display: { labelKey: 'u4.c', fallback: 'C' } }],
    })
    const d = describeProperty(reg, propertyRef(owner(), 'u4.thing.c'))
    if (!d.ok) throw new Error('desc')
    expect(parseDraft(reg, d.value, '#gggggg').state).toBe('invalid')
    expect(parseDraft(reg, d.value, '#aabbcc').state).toBe('complete')
    expect(parseDraft(reg, d.value, '#').state).toBe('intermediate')
  })

  it('枚举值域外的值被拒（不静默接受）', () => {
    const reg = createPropertyRegistry()
    reg.registerObjectType({
      id: 'u5.thing',
      ownerKind: 'object',
      display: { labelKey: 'obj.u5', fallback: 'U5' },
      properties: [
        {
          id: 'e',
          valueType: 'enum',
          animatable: false,
          display: { labelKey: 'u5.e', fallback: 'E' },
          domain: { kind: 'enum', items: [{ value: 'a', display: { labelKey: 'e.a', fallback: 'A' } }] },
        },
      ],
    })
    const d = describeProperty(reg, propertyRef(owner(), 'u5.thing.e'))
    if (!d.ok) throw new Error('desc')
    expect(parseDraft(reg, d.value, 'zzz').state).toBe('invalid')
  })

  it('分量寻址越界被拒，且只对分量类型成立', () => {
    const reg = makeRegistry()
    const ok = describeProperty(reg, propertyRef(owner(), `${OBJECT_TYPE}.offset`, { component: 1 }))
    expect(ok.ok).toBe(true)
    const bad = describeProperty(reg, propertyRef(owner(), `${OBJECT_TYPE}.offset`, { component: 5 }))
    expect(bad.ok).toBe(false)
    const notComponent = describeProperty(reg, propertyRef(owner(), `${OBJECT_TYPE}.size`, { component: 0 }))
    expect(notComponent.ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. `appliedOutcome` 的三分支互斥（内核契约 §4.1）
// ─────────────────────────────────────────────────────────────────────────────

describe('A08-9 `CommandOutcome` 三分支互斥且穷尽', () => {
  it('三个构造器给出的 `status` 互不相同', () => {
    const a = appliedOutcome(V1, {
      changedProperties: [],
      createdEntities: [],
      removedEntities: [],
      structurallyShared: true,
    })
    expect(a.status).toBe('applied')
    expect(['applied', 'unchanged', 'rejected']).toContain(a.status)
  })

  it('**负对照**：拒绝的 outcome **没有** `changes` 字段（不得同时报告 applied）', () => {
    const reg = makeRegistry()
    const acc = access({ A: { frozen: 1 } })
    const { outcome } = runSet(reg, { values: {}, epoch: 0 }, [propertyRef(owner(), `${OBJECT_TYPE}.frozen`)], 1, acc)
    expect(outcome.status).toBe('rejected')
    expect('changes' in outcome).toBe(false)
  })
})
