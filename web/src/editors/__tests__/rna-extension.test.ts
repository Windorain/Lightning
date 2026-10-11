/**
 * **A21 / D4 扩展性**（#253：「新增属性类型 / 普通对象类型**不得**要求改核心 switch」）。
 *
 * ## 证明路径与负对照
 *
 * 正向：本文件在**不修改 `src/application/**` 任何一行**的前提下，
 * 注册一个新的值类型（`duration`）与一个新的对象类型（`ext.timer`），
 * 并让它走完「描述 → 读 → 草稿解析 → 校验 → 原子写 → 格式化」全链路。
 *
 * 负对照（本文件同时断言）：
 *  1. 若核心存在 `switch (valueType) { case 'number': ... }` 这类硬编码分支，
 *     新值类型会在**未改核心**时无法工作 —— 我们用「新类型能工作」反过来证明没有该分支；
 *  2. 反向断言：把**未注册**的值类型放进声明，必须得到结构化
 *     `UnsupportedOperation`，**不得**静默回落成字符串/数字
 *     （「静默回落」正是硬编码 switch 的 `default:` 分支的典型表现）；
 *  3. `PropertyDescriptor` 里不得出现控件类型名（新类型也一样）——
 *     控件选择由 editors 层的 `modelFor` 做，不在核心。
 *
 * ## 为什么这条对 A21（#257）重要
 *
 * #257 要复用通用属性/轨道/采样，靠的就是「注册一个 handler」而不是「改一处 switch」。
 * 本文件是该挂点可用的**可执行证明**。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import {
  CAP_PROPERTY_WRITE,
  createPropertyRegistry,
  describeProperty,
  evaluateEditability,
  formatValue,
  parseDraft,
  readProperty,
  type ExtensionValue,
  type ObjectTypeDecl,
  type ParseOutcome,
  type PropertyAccess,
  type PropertyValue,
  type PropertyValueTypeHandler,
  type TargetFacts,
  type ValueContext,
} from '@/application/properties'
// `propertyRef` 的唯一权威是 `domain/identity`（#250 GF-5 收敛：RNA 侧那份已删）。
import { propertyRef } from '@/domain/identity'
import {
  applySetProperty,
  createPropertyWritePorts,
  type SetPropertyCommand,
} from '@/application/property-commands'
import { modelFor, createControlRegistry } from '@/editors/property-controls'

// ─────────────────────────────────────────────────────────────────────────────
// 1. 一个**扩展**值类型（不在内置清单里）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 扩展值形状：交叉 `ExtensionValue`（`Readonly<Record<string, unknown>>`）以显式声明
 * 「这是注册方自有形状」。结构化类型下它本就满足开放臂，交叉是为了让**意图**可读 ——
 * 也正因为有那个开放臂，注册 `duration` 才不需要改 `application/properties.ts`（D4）。
 */
type Duration = Readonly<{ ticks: number }> & ExtensionValue

const TICKS_PER_SECOND = 20

/**
 * `duration` handler —— 只实现契约要求的成员，**不接触任何核心代码**。
 *
 * 注意它自己决定「显示文本」「相等判据」「采样策略名」，核心对此零知识。
 */
const durationHandler: PropertyValueTypeHandler<Duration> = {
  id: 'ext.duration',
  parseDraft(draft, _ctx: ValueContext): ParseOutcome<Duration> {
    // `1.5s` / `30t` / `30`
    const t = draft.trim()
    if (t === '' || t === '-' || t.endsWith('.')) return { state: 'intermediate' }
    const m = /^(-?\d+(?:\.\d+)?)(s|t)?$/.exec(t)
    if (!m) return { state: 'invalid', error: { code: 'InvalidValue', params: { type: 'duration', draft } } }
    const n = Number(m[1])
    if (!Number.isFinite(n) || n < 0) {
      return { state: 'invalid', error: { code: 'InvalidValue', params: { type: 'duration', bound: 'min' } } }
    }
    const ticks = m[2] === 't' ? Math.round(n) : Math.round(n * TICKS_PER_SECOND)
    return { state: 'complete', value: { ticks } }
  },
  toDraft: (v) => `${v.ticks / TICKS_PER_SECOND}s`,
  validate(raw) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: { code: 'InvalidValue', params: { type: 'duration' } } }
    const ticks = (raw as Duration).ticks
    if (typeof ticks !== 'number' || !Number.isInteger(ticks) || ticks < 0) {
      return { ok: false, error: { code: 'InvalidValue', params: { type: 'duration' } } }
    }
    return { ok: true, value: { ticks } }
  },
  normalize: (v) => ({ ticks: v.ticks }),
  equals: (a, b) => a.ticks === b.ticks,
  format: (v) => `${(v.ticks / TICKS_PER_SECOND).toFixed(2)}s`,
  samplingStrategy: (decl) => (decl.animatable ? 'ext.duration-linear' : undefined),
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 一个**扩展**对象类型
// ─────────────────────────────────────────────────────────────────────────────

const TIMER_DECL: ObjectTypeDecl = {
  id: 'ext.timer',
  ownerKind: 'object',
  display: { labelKey: 'ext.timer', fallback: 'Timer' },
  properties: [
    {
      id: 'elapsed',
      valueType: 'ext.duration',
      animatable: true,
      display: { labelKey: 'ext.timer.elapsed', fallback: '已过时长' },
    },
    {
      id: 'loop',
      valueType: 'boolean',
      animatable: false,
      display: { labelKey: 'ext.timer.loop', fallback: '循环' },
    },
  ],
}

type State = Readonly<{ values: Readonly<Record<string, unknown>>; epoch: number }>

const owner = { kind: 'object', id: 'T1' } as const
const V1 = { documentVersion: 1 } as const

function facts(over: Partial<TargetFacts> = {}): TargetFacts {
  return { exists: true, generated: false, drivenByTrack: false, locked: false, holdsLease: true, ...over }
}

function makeRegistry() {
  const reg = createPropertyRegistry()
  const v = reg.registerValueType(durationHandler)
  if (!v.ok) throw new Error('value type registration failed')
  const o = reg.registerObjectType(TIMER_DECL)
  if (!o.ok) throw new Error('object type registration failed')
  return reg
}

function access(raw: Record<string, unknown>, over: Partial<TargetFacts> = {}): PropertyAccess {
  return {
    version: V1,
    readRaw: (ref) => {
      const local = ref.property.slice('ext.timer.'.length)
      const v = (raw[ref.owner.id] as Record<string, unknown> | undefined)?.[local]
      if (v === undefined) return { ok: false, error: { code: 'MissingTarget', params: { property: ref.property } } }
      return { ok: true, value: v }
    },
    facts: () => facts(over),
    capabilities: new Set([CAP_PROPERTY_WRITE]),
    language: 'zh',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 正向：新类型全链路可用，且**未改核心**
// ─────────────────────────────────────────────────────────────────────────────

describe('D4 正向：注册即可用的新值类型/对象类型（不改核心 switch）', () => {
  it('值类型经**公开**注册 API 登记（与内置类型同一路径）', () => {
    const reg = createPropertyRegistry()
    const r = reg.registerValueType(durationHandler)
    expect(r.ok).toBe(true)
    expect(reg.valueTypeHandler('ext.duration')?.id).toBe('ext.duration')
    // 内置类型也在同一张表里（同一个注册 API）
    expect(reg.valueTypeHandler('number')).toBeDefined()
    expect(reg.valueTypes()).toContain('number')
    expect(reg.valueTypes()).toContain('ext.duration')
  })

  it('新对象类型登记后，其属性描述可被 `describeProperty` 查到', () => {
    const reg = makeRegistry()
    const d = describeProperty(reg, propertyRef(owner, 'ext.timer.elapsed'))
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.value.valueType).toBe('ext.duration')
      expect(d.value.animatable).toBe(true)
      expect(d.value.display.labelKey).toBe('ext.timer.elapsed')
    }
  })

  it('新类型的读面可用（校验走扩展 handler）', () => {
    const reg = makeRegistry()
    const r = readProperty(reg, propertyRef(owner, 'ext.timer.elapsed'), 'authored', access({ T1: { elapsed: { ticks: 30 } } }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ ticks: 30 })
  })

  it('新类型的**草稿解析**可用（含它自己的中间态规则：`1.5s` / `30t`）', () => {
    const reg = makeRegistry()
    const d = describeProperty(reg, propertyRef(owner, 'ext.timer.elapsed'))
    if (!d.ok) throw new Error('desc')
    expect(parseDraft(reg, d.value, '').state).toBe('intermediate')
    expect(parseDraft(reg, d.value, '1.').state).toBe('intermediate')
    const secs = parseDraft(reg, d.value, '1.5s')
    expect(secs.state).toBe('complete')
    if (secs.state === 'complete') expect(secs.value).toEqual({ ticks: 30 })
    const ticks = parseDraft(reg, d.value, '30t')
    expect(ticks.state).toBe('complete')
    if (ticks.state === 'complete') expect(ticks.value).toEqual({ ticks: 30 })
    expect(parseDraft(reg, d.value, 'abc').state).toBe('invalid')
  })

  it('新类型的**格式化**走它自己的 handler（核心不猜格式）', () => {
    const reg = makeRegistry()
    const d = describeProperty(reg, propertyRef(owner, 'ext.timer.elapsed'))
    if (!d.ok) throw new Error('desc')
    expect(formatValue(reg, d.value, { ticks: 30 })).toBe('1.50s')
  })

  it('新类型可被**原子写路由**写入（含相等判定 ⇒ 无变化返回 unchanged）', () => {
    const reg = makeRegistry()
    const ports = createPropertyWritePorts<State>()
    ports.write('ext.timer', (state, ref, value) => ({
      ok: true,
      value: { values: { ...state.values, [ref.property]: value }, epoch: state.epoch + 1 },
    }))
    const acc = access({ T1: { elapsed: { ticks: 30 } } })
    const command: SetPropertyCommand = {
      kind: 'setProperty',
      refs: [propertyRef(owner, 'ext.timer.elapsed')],
      value: { ticks: 40 } as unknown as PropertyValue,
    }

    const changed = applySetProperty<State>({
      registry: reg,
      ports,
      state: { values: {}, epoch: 0 },
      command,
      env: { baseVersion: acc.version, currentVersion: acc.version },
      access: acc,
    })
    expect(changed.outcome.status).toBe('applied')

    // 写入相等值 ⇒ unchanged（用扩展 handler 的 `equals`，不是 `===`）
    const same = applySetProperty<State>({
      registry: reg,
      ports,
      state: { values: {}, epoch: 0 },
      command: {
        kind: 'setProperty',
        refs: [propertyRef(owner, 'ext.timer.elapsed')],
        value: { ticks: 30 } as unknown as PropertyValue,
      },
      env: { baseVersion: acc.version, currentVersion: acc.version },
      access: acc,
    })
    expect(same.outcome.status).toBe('unchanged')
  })

  it('新类型的可编辑性与其他类型走**同一套**求值（无需特判）', () => {
    const reg = makeRegistry()
    const ref = propertyRef(owner, 'ext.timer.elapsed')
    expect(evaluateEditability(reg, ref, access({ T1: { elapsed: { ticks: 1 } } })).editable).toBe(true)
    expect(evaluateEditability(reg, ref, access({ T1: { elapsed: { ticks: 1 } } }, { locked: true })).reason?.code).toBe('ReadOnly')
    expect(evaluateEditability(reg, ref, access({ T1: { elapsed: { ticks: 1 } } }, { exists: false })).reason?.code).toBe('MissingTarget')
  })

  it('扩展 handler 可自带**采样策略名**（#255 的挂点；核心不枚举策略）', () => {
    const reg = makeRegistry()
    const d = describeProperty(reg, propertyRef(owner, 'ext.timer.elapsed'))
    if (!d.ok) throw new Error('desc')
    const h = reg.valueTypeHandler('ext.duration')
    expect(h?.samplingStrategy?.(d.value)).toBe('ext.duration-linear')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. 负对照：未注册类型必须结构化拒绝，不得静默回落
// ─────────────────────────────────────────────────────────────────────────────

describe('D4 负对照：未注册的值类型必须判红（不得静默回落）', () => {
  it('声明里用了未注册的值类型 ⇒ 读面 `UnsupportedOperation`（不是当成字符串）', () => {
    const reg = createPropertyRegistry()
    reg.registerObjectType({
      id: 'ext.bad',
      ownerKind: 'object',
      display: { labelKey: 'ext.bad', fallback: 'Bad' },
      properties: [{ id: 'x', valueType: 'ext.not-registered', animatable: false, display: { labelKey: 'x', fallback: 'X' } }],
    })
    const r = readProperty(reg, propertyRef(owner, 'ext.bad.x'), 'authored', access({ T1: { x: 1 } }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('UnsupportedOperation')
      expect(r.error.params.reason).toBe('unknown-value-type')
      expect(r.error.params.valueType).toBe('ext.not-registered')
    }
  })

  it('未注册类型**不可写**（可编辑性给出结构化原因，而不是「能输入但没反应」）', () => {
    const reg = createPropertyRegistry()
    reg.registerObjectType({
      id: 'ext.bad2',
      ownerKind: 'object',
      display: { labelKey: 'ext.bad2', fallback: 'Bad2' },
      properties: [{ id: 'x', valueType: 'ext.nope', animatable: false, display: { labelKey: 'x', fallback: 'X' } }],
    })
    const ports = createPropertyWritePorts<State>()
    ports.write('ext.bad2', (s) => ({ ok: true, value: s }))
    const acc = access({ T1: { x: 1 } })
    const t = applySetProperty<State>({
      registry: reg,
      ports,
      state: { values: {}, epoch: 0 },
      command: { kind: 'setProperty', refs: [propertyRef(owner, 'ext.bad2.x')], value: 1 },
      env: { baseVersion: acc.version, currentVersion: acc.version },
      access: acc,
    })
    expect(t.outcome.status).toBe('rejected')
    if (t.outcome.status === 'rejected') expect(t.outcome.error.code).toBe('UnsupportedOperation')
  })

  it('重复注册同一值类型被拒（注册表不静默覆盖）', () => {
    const reg = createPropertyRegistry()
    expect(reg.registerValueType(durationHandler).ok).toBe(true)
    const again = reg.registerValueType(durationHandler)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.params.reason).toBe('duplicate-value-type')
  })

  it('重复属性 ID 被拒（不静默覆盖成后一个）', () => {
    const reg = createPropertyRegistry()
    const bad: ObjectTypeDecl = {
      id: 'ext.dup',
      ownerKind: 'object',
      display: { labelKey: 'ext.dup', fallback: 'Dup' },
      properties: [
        { id: 'a', valueType: 'number', animatable: false, display: { labelKey: 'a', fallback: 'A' } },
        { id: 'a', valueType: 'number', animatable: false, display: { labelKey: 'a2', fallback: 'A2' } },
      ],
    }
    const r = reg.registerObjectType(bad)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.params.reason).toBe('duplicate-property')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. 结构断言：核心无值类型硬编码分支
// ─────────────────────────────────────────────────────────────────────────────

describe('D4 结构断言：核心对「有哪些值类型」零分支', () => {
  const coreFiles = (): readonly string[] => {
    const dir = path.join(process.cwd(), 'src', 'application')
    return readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => path.join(dir, f))
  }

  it('`application/properties.ts` 里没有 `switch (…valueType…)` 的分派', () => {
    const src = stripCommentsAndStrings(
      readFileSync(path.join(process.cwd(), 'src', 'application', 'properties.ts'), 'utf8'),
    )
    // 允许按**值类型 ID 查表**（`valueTypes.get(id)`），不允许按 ID 分派实现。
    const switchOnValueType = /switch\s*\(\s*[^)]*valueType[^)]*\)/.test(src)
    expect(switchOnValueType, '核心不得按 valueType 做 switch 分派（那会让扩展必须改核心）').toBe(false)
  })

  it('内置值类型走的是**同一个**公开注册 API（不存在第二条「内置专用」通路）', () => {
    const src = stripCommentsAndStrings(
      readFileSync(path.join(process.cwd(), 'src', 'application', 'properties.ts'), 'utf8'),
    )
    // `createPropertyRegistry` 对传入的 valueTypes 与内置清单使用同一段注册代码
    expect(/for \(const h of options\?\.valueTypes \?\? BUILTIN_VALUE_TYPE_HANDLERS\)/.test(src)).toBe(true)
  })

  it('每个核心文件都不 import Vue/Three（结构上保证纯核心）', () => {
    for (const f of coreFiles()) {
      const src = stripCommentsAndStrings(readFileSync(f, 'utf8'))
      expect(/from ['"]vue['"]/.test(src), `${f} 不得 import vue`).toBe(false)
      expect(/from ['"]three/.test(src), `${f} 不得 import three`).toBe(false)
    }
  })

  it('控件选择**不在**核心：`PropertyDescriptor` 无控件名，`modelFor` 在 editors 层', () => {
    const reg = makeRegistry()
    for (const desc of reg.describeObjectType('ext.timer')) {
      const text = JSON.stringify(desc)
      for (const w of ['slider', 'stepper', 'checkbox', 'dropdown', 'uiWidget']) {
        expect(text.includes(w)).toBe(false)
      }
    }
    // 扩展值类型也能被 editors 层映射出控件（核心不需要认识它）
    const d = reg.descriptor('ext.timer.elapsed')
    if (!d) throw new Error('desc')
    const model = modelFor(d, createControlRegistry())
    expect(typeof model.kind).toBe('string')
  })
})

/** 与 A08 用同一份「剥注释/字符串」工具（源码级判据只看代码）。 */
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
