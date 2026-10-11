/**
 * **冻结项回归**（#250 裁决的 5 项收敛冻结）。
 *
 * 这 5 项是 P1/P2 合流时 Lead 逐一裁决的共享语义。它们的特点是：
 * **每一项都能被"局部看起来对、整体不一致"的实现悄悄破坏** ——
 * 例如属性 ID 不带限定前缀也能跑（只是两套口径并存）、
 * `owner.kind` 用 `'block'` 也能跑（只是契约 §1.1 失去含义）。
 *
 * 故本文件的断言刻意做成**跨模块**的：
 *  - 不是"某个函数返回什么"，而是"全树只有一份定义 / 两侧口径一致"；
 *  - 负对照与正例成对出现（负对照是本项目验收的硬要求）。
 *
 * 本文件只读源码文本 + 调用纯函数，不起组件、不连运行时。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CAP_PROPERTY_WRITE,
  createPropertyRegistry,
  describeProperty,
  type ObjectTypeDecl,
  type PropertyAccess,
  type PropertyRegistry,
  type TargetFacts,
} from '@/application/properties'
import { localPropertyOf, domainError, type EntityRef as ContractEntityRef } from '@/application/contracts'
import { applySetProperty, createPropertyWritePorts, type PropertyWritePorts } from '@/application/property-commands'
import { propertyRef } from '@/domain/identity'
import { kernelPropertyRegistry } from '@/application/kernel-properties'
import { err, ok, type Result } from '@/domain/errors'


const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8')

/**
 * 去掉注释后的**代码文本**（供"某符号是否仍在代码里"的判定）。
 *
 * 为什么必须去注释：本批在退役处写了**记录性注释**（"本文件曾有 X，现已迁至 Y"），
 * 裸正则会把注释里的 `propertyRef(`／`animatableProperties` 当成"代码 still 有" ——
 * 那是**假红**。反过来，若注释里留着实现，去注释也会掩盖它，故本函数只用于
 * "符号是否仍被定义/使用"的判定，**定义点**判定另有一套（见 `productionDefinitionsOf`）。
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/**
 * 全树**生产代码**文件清单（`web/src/**` 去掉 `__tests__` 与 `*.test.ts`）。
 *
 * 为什么要枚举全树而不是核对一份手写清单：手写清单只能证明"我列的那些文件里没有重复"，
 * 而 GF-5 的验收要求是"全树只有一份定义"。多出的第四份定义若出现在没被列到的文件里，
 * 清单式断言会放过它 —— 那是**空洞真**（#251「未实现的测试名称不得报告通过」的同类）。
 */
const PRODUCTION_FILES: readonly string[] = (() => {
  const src = path.join(ROOT, 'src')
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (entry === '__tests__' || entry === 'node_modules') continue
        walk(full)
        continue
      }
      if (!/\.ts$/.test(entry)) continue
      if (/\.test\.ts$/.test(entry)) continue
      out.push(path.relative(ROOT, full).replace(/\\/g, '/'))
    }
  }
  walk(src)
  return Object.freeze(out)
})()

// ── 夹具 ────────────────────────────────────────────────────────────────────

type State = Readonly<{ values: Readonly<Record<string, string | number | boolean | null>> }>

const OBJECT_TYPE = 'test.frozen'

const DECL: ObjectTypeDecl = {
  id: OBJECT_TYPE,
  ownerKind: 'object',
  display: { labelKey: 'obj.frozen', fallback: 'Frozen' },
  properties: [
    { id: 'plain', valueType: 'number', animatable: true, display: { labelKey: 'p.plain', fallback: 'plain' } },
    // 只有这一条声明 nullable —— 冻结 #4 的正/负对照都用它。
    { id: 'maybe', valueType: 'string', animatable: false, nullable: true, display: { labelKey: 'p.maybe', fallback: 'maybe' } },
    { id: 'never', valueType: 'string', animatable: false, display: { labelKey: 'p.never', fallback: 'never' } },
    {
      id: 'ro',
      valueType: 'number',
      animatable: false,
      readOnly: true,
      readOnlyReason: 'derived',
      display: { labelKey: 'p.ro', fallback: 'ro' },
    },
  ],
}

function makeRegistry(): PropertyRegistry {
  const reg = createPropertyRegistry()
  const r = reg.registerObjectType(DECL)
  if (!r.ok) throw new Error('fixture registration failed')
  return reg
}

const owner = (id = 'A'): ContractEntityRef => ({ kind: 'object', id })

function makePorts(): PropertyWritePorts<State> {
  const ports = createPropertyWritePorts<State>()
  ports.write(OBJECT_TYPE, (state, ref, value) => {
    const local = ref.property.slice(`${OBJECT_TYPE}.`.length)
    if (local === 'ro') return { ok: false, error: domainError('ReadOnly', { reason: 'derived' }) }
    return { ok: true, value: { values: { ...state.values, [`${ref.owner.id}.${local}`]: value as never } } }
  })
  return ports
}

const V1 = { documentVersion: 1 } as const

function facts(over: Partial<TargetFacts> = {}): TargetFacts {
  return {
    exists: true,
    generated: false,
    holdsLease: true,
    locked: false,
    ...over,
  } as TargetFacts
}

/**
 * 造一个访问面（与 `rna-contract.test.ts` 同口径）。
 *
 * `facts` 可以是**逐目标函数**：冻结 #5 的「逐目标原因」正需要三个目标
 * 各有不同事实（不存在 / 锁定 / 正常），用一个全局事实无法表达。
 */
function access(
  over: Partial<TargetFacts> | ((ref: ContractEntityRef) => Partial<TargetFacts>) = {},
  raw: Record<string, Record<string, unknown>> = {},
): PropertyAccess {
  return {
    version: V1,
    readRaw: (ref): Result<unknown> => {
      const local = localPropertyOf(ref.property, OBJECT_TYPE)
      const v = raw[ref.owner.id]?.[local]
      if (v === undefined) return err(domainError('MissingTarget', { reason: 'no-value', property: ref.property }))
      return ok(v)
    },
    facts: (ref) => facts(typeof over === 'function' ? over(ref.owner) : over),
    capabilities: new Set([CAP_PROPERTY_WRITE]),
    language: 'zh',
  } as PropertyAccess
}

// ════════════════════════════════════════════════════════════════════════════
// 冻结 #1：属性 ID 用**限定式**
// ════════════════════════════════════════════════════════════════════════════

describe('冻结 #1 属性 ID 是限定式（objectType.property）', () => {
  it('注册后描述 id 带 objectType 前缀（不是裸属性名）', () => {
    const reg = makeRegistry()
    const d = describeProperty(reg, propertyRef(owner(), `${OBJECT_TYPE}.plain`))
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.value.id).toBe(`${OBJECT_TYPE}.plain`)
      expect(d.value.objectTypeId).toBe(OBJECT_TYPE)
    }
  })

  it('负对照：裸属性名**查不到**描述（不静默按后缀匹配）', () => {
    const reg = makeRegistry()
    const bare = describeProperty(reg, propertyRef(owner(), 'plain'))
    expect(bare.ok).toBe(false)
    if (!bare.ok) expect(bare.error.code).toBe('MissingTarget')
  })

  it('对象类型 ID 含点时，限定前缀按**完整 objectTypeId** 剥离（不是首个点）', () => {
    // 唯一实现按传入的 objectTypeId 前缀剥离。
    expect(localPropertyOf('test.frozen.plain', 'test.frozen')).toBe('plain')
    expect(localPropertyOf('lightning.block.pos', 'lightning.block')).toBe('pos')
    // **负对照**：若"取第一个点之后"（那个真踩过的坑），
    // `lightning.block.pos` 会得到 `block.pos` —— 断言结果**不是**它。
    expect(localPropertyOf('lightning.block.pos', 'lightning.block')).not.toBe('block.pos')
    // 拿不到 objectTypeId 时退回**最后一个点**（同样是"不是首个点"）。
    expect(localPropertyOf('lightning.block.pos')).toBe('pos')
    expect(localPropertyOf('lightning.annotation.text.fontSize')).toBe('fontSize')
    // 两个不同 objectType 的同名属性互不串味（真实注册表）。
    const reg2 = createPropertyRegistry()
    reg2.registerObjectType({ ...DECL, id: 'test.frozen.plain' } as ObjectTypeDecl)
    reg2.registerObjectType(DECL)
    expect(reg2.descriptor(`${OBJECT_TYPE}.plain`)?.objectTypeId).toBe(OBJECT_TYPE)
    expect(reg2.descriptor('test.frozen.plain.plain')?.objectTypeId).toBe('test.frozen.plain')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 冻结 #2：owner.kind 用契约 §1.1 实体种类；block/annotation 是 objectType
// ════════════════════════════════════════════════════════════════════════════

describe('冻结 #2 owner.kind 只用契约 §1.1 实体种类', () => {
  it('`domain/identity` 的 EntityOwnerKind 不是开放联合（无 `string & {}` 逃生口）', () => {
    const src = read('src/domain/identity.ts')
    // 取 `export type EntityOwnerKind =` 到闭合的分号为止。
    const start = src.indexOf('export type EntityOwnerKind')
    expect(start).toBeGreaterThanOrEqual(0)
    const body = src.slice(start, src.indexOf(';', start))
    // 负对照：开放联合（`| (string & {})`）会让"实体种类"失去可检查含义。
    expect(body).not.toMatch(/string\s*&\s*\{\}/)
    // 正例：契约 §1.1 的实体种类都在。
    for (const kind of ['document', 'scene', 'object', 'objectData', 'editContext', 'workspace', 'asset', 'evaluation']) {
      expect(body).toContain(`'${kind}'`)
    }
  })

  it('场景对象（方块/注解）的 owner.kind 是 `object`，不是 `block`/`annotation`', () => {
    const src = read('src/editors/workbench-inspector.ts')
    // owner 构造函数：两者都必须产出 kind: 'object'。
    expect(src).toMatch(/export function blockOwner[\s\S]*?return \{ kind: 'object', id:/)
    expect(src).toMatch(/export function annotationOwner[\s\S]*?return \{ kind: 'object', id \}/)
    // 负对照：不得再有 `kind: 'block'` / `kind: 'annotation'` 作为 **owner**。
    const ownerKindBlock = /owner:\s*\{\s*kind:\s*'(block|annotation)'/
    expect(ownerKindBlock.test(src)).toBe(false)
  })

  it('本批修复：声明与分支都用契约 §1.1 的种类（无 `shellSettings`/`toolSettings` 自造种类）', () => {
    const src = read('src/editors/workbench-inspector.ts')
    const rna = read('src/editors/workbench-rna.ts')
    // 自造种类已从**声明**里消除：发布配置 ⇒ workspace、工具参数 ⇒ editContext。
    expect(src).toMatch(/id: OBJECT_TYPE\.publishConfig,\s*\n\s*ownerKind: 'workspace'/)
    expect(src).toMatch(/id: OBJECT_TYPE\.toolSettings,\s*\n\s*ownerKind: 'editContext'/)
    expect(src).not.toMatch(/ownerKind: 'shellSettings'/)
    expect(src).not.toMatch(/ownerKind: 'toolSettings'/)
    // 分支也不再按自造种类判（否则那些分支是死代码 —— 本批实测抓到过这个问题）。
    expect(rna).not.toMatch(/kind === 'shellSettings'/)
    expect(rna).not.toMatch(/kind === 'toolSettings'/)
    // 有**唯一**映射点把 objectTypeId 映到 §1.1 的种类。
    expect(src).toMatch(/export function contractKindOf/)
  })

  it('冻结 #2 类型级收敛：注册表用的是 `domain/identity` 的**封闭**联合（无开放逃生口）', () => {
    // 收敛前：P1 `domain/identity` 是封闭八种，而 P2 `contracts.ts` 自带一份**开放**联合
    // （带 `| (string & {})`），且 `properties.ts`（RNA 注册表）import 的正是后者 ——
    // 于是 `owner.kind` 可以塞进任意字符串（`readOnlyDiagnostics` 就曾把 `objectTypeId`
    // 塞进 `kind`，类型检查看不出来）。
    //
    // 收敛后全树只有 `domain/identity` 一份 `EntityOwnerKind`，`properties.ts` 从
    // `./contracts` 拿到的是**再导出**的同一定义。本断言把这件事测在类型来源上。
    const identity = read('src/domain/identity.ts')
    const contracts = read('src/application/contracts.ts')
    const idStart = identity.indexOf('export type EntityOwnerKind')
    expect(identity.slice(idStart, identity.indexOf('\n\n', idStart))).not.toMatch(/string\s*&\s*\{\}/)
    // contracts.ts 改为再导出后**不再**自带定义（连 `(string & {})` 也不该在这里出现）。
    expect(contracts).not.toMatch(/export type EntityOwnerKind\s*=/)
    expect(contracts).not.toMatch(/string\s*&\s*\{\}/)
    // 注册表经 `contracts` 拿到的就是 identity 那一份（再导出，不是第二个定义）。
    expect(read('src/application/properties.ts')).toMatch(/type EntityOwnerKind[\s\S]{0,200}from '\.\/contracts'/)
    expect(contracts).toMatch(/export type \{[^}]*EntityOwnerKind[^}]*\}/)
  })

  it('声明里的 ownerKind 不再出现 `block`/`annotation`（它们是 objectType）', () => {
    const src = read('src/editors/workbench-inspector.ts')
    const decls = [...src.matchAll(/id: OBJECT_TYPE\.\w+,\s*\n\s*ownerKind: '([a-zA-Z]+)'/g)].map((m) => m[1]!)
    expect(decls.length).toBeGreaterThan(0)
    expect(decls).not.toContain('block')
    expect(decls).not.toContain('annotation')
  })

  it('场景对象种类由 objectTypeId 推出（`sceneKindOf`），且两种注解都认得', () => {
    const src = read('src/editors/workbench-inspector.ts')
    expect(src).toMatch(/export function sceneKindOf/)
    // 唯一映射点：'lightning.block' ⇒ block，'lightning.annotation.*' ⇒ annotation。
    expect(src).toMatch(/OBJECT_TYPE\.block/)
    expect(src).toMatch(/startsWith\('lightning\.annotation\.'\)/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 冻结 #3：WouldBlockReason 统一 camelCase
// ════════════════════════════════════════════════════════════════════════════

describe('冻结 #3 WouldBlockReason 统一 camelCase', () => {
  it('`incompatibleQueued` 是唯一拼法，全树无 `queued-incompatible`', () => {
    const identity = read('src/domain/identity.ts')
    const contracts = read('src/application/contracts.ts')
    // 权威定义在 domain/errors，identity/contracts 若有再出口也应一致。
    const errors = read('src/domain/errors.ts')
    expect(errors).toContain("'incompatibleQueued'")
    expect(errors).not.toContain("'queued-incompatible'")
    expect(identity).not.toContain("'queued-incompatible'")
    expect(contracts).not.toContain("'queued-incompatible'")
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 冻结 #4：PropertyValue 含 null；null 只在声明 nullable 时合法
// ════════════════════════════════════════════════════════════════════════════

describe('冻结 #4 `null` 是合法值，但受理权在描述（nullable）', () => {
  it('`PropertyValue` 含 `null`（三处权威定义必须一致）', () => {
    const props = read('src/application/properties.ts')
    const m = props.match(/export type PropertyValue\s*=([\s\S]*?)\n\n/)
    expect(m).not.toBeNull()
    expect(m![1]).toMatch(/\|\s*null/)
  })

  it('描述带 `nullable` 字段（且缺省为 false）', () => {
    const reg = makeRegistry()
    const maybe = describeProperty(reg, propertyRef(owner(), `${OBJECT_TYPE}.maybe`))
    const never = describeProperty(reg, propertyRef(owner(), `${OBJECT_TYPE}.never`))
    expect(maybe.ok && maybe.value.nullable).toBe(true)
    expect(never.ok && never.value.nullable).toBe(false)
  })

  it('正例：声明 `nullable` 的属性接受 `null` 写入', () => {
    const t = applySetProperty<State>({
      registry: makeRegistry(),
      ports: makePorts(),
      state: { values: {} },
      command: { kind: 'setProperty', refs: [propertyRef(owner(), `${OBJECT_TYPE}.maybe`)], value: null },
      env: { baseVersion: V1, currentVersion: V1 },
      access: access(),
    })
    expect(t.outcome.status).toBe('applied')
  })

  it('负对照：未声明 `nullable` 的属性收到 `null` ⇒ `InvalidValue`（不是 UnsupportedOperation）', () => {
    const t = applySetProperty<State>({
      registry: makeRegistry(),
      ports: makePorts(),
      state: { values: {} },
      command: { kind: 'setProperty', refs: [propertyRef(owner(), `${OBJECT_TYPE}.never`)], value: null },
      env: { baseVersion: V1, currentVersion: V1 },
      access: access(),
    })
    expect(t.outcome.status).toBe('rejected')
    if (t.outcome.status === 'rejected') {
      expect(t.outcome.error.code).toBe('InvalidValue')
      expect(t.outcome.error.params.reason).toBe('not-nullable')
    }
  })

  it('`null`（显式空值）与 `\'mixed\'`（多选值不同）是两个不同的东西', () => {
    // 负对照：若用 `null` 兼表混合值，下列两类错误就不可区分。
    const reg = makeRegistry()
    expect(reg.descriptor(`${OBJECT_TYPE}.maybe`)).toBeDefined()
    // 哨兵值定义在 `application/properties.ts`（RNA 核心），写路由从那里 import。
    expect(read('src/application/properties.ts')).toMatch(/MIXED_VALUE = 'mixed'/)
    // `mixed` 不能被当作具体值写下去。
    const t = applySetProperty<State>({
      registry: reg,
      ports: makePorts(),
      state: { values: {} },
      command: { kind: 'setProperty', refs: [propertyRef(owner(), `${OBJECT_TYPE}.maybe`)], value: 'mixed' as never },
      env: { baseVersion: V1, currentVersion: V1 },
      access: access(),
    })
    expect(t.outcome.status).toBe('rejected')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 冻结 #5：多选拒绝 = 整体拒绝 + 逐目标原因
// ════════════════════════════════════════════════════════════════════════════

describe('冻结 #5 多选拒绝：整体拒绝且逐目标列明原因', () => {
  /** 三个目标各有各的失败原因（只读 / 不存在 / 锁定）——用来验证"不只报第一个"。 */
  function threeFailures() {
    const reg = makeRegistry()
    const ports = makePorts()
    const refs = [
      propertyRef(owner('A'), `${OBJECT_TYPE}.ro`), // 声明级只读
      propertyRef(owner('B'), `${OBJECT_TYPE}.plain`), // facts.exists = false
      propertyRef(owner('C'), `${OBJECT_TYPE}.plain`), // locked
    ]
    return { reg, ports, refs }
  }

  it('整体拒绝：一个目标不可改即**不写任何目标**（原子）', () => {
    const { reg, ports, refs } = threeFailures()
    const state: State = { values: {} }
    const t = applySetProperty<State>({
      registry: reg,
      ports,
      state,
      command: { kind: 'setProperty', refs, value: 2 },
      env: { baseVersion: V1, currentVersion: V1 },
      access: access((ref) =>
        ref.id === 'B' ? { exists: false, holdsLease: false } : { exists: true, holdsLease: true },
      ),
    })
    expect(t.outcome.status).toBe('rejected')
    // 原子性：状态引用未变（无部分成功）。
    if (t.outcome.status === 'rejected') expect(t.candidate).toBe(state)
  })

  it('拒绝携带**逐目标**原因（不是只看第一个）', () => {
    const { reg, ports, refs } = threeFailures()
    // A 只读（声明级）、B 不存在、C 锁定 —— 三者原因不同。
    const t = applySetProperty<State>({
      registry: reg,
      ports,
      state: { values: {} },
      command: { kind: 'setProperty', refs, value: 2 },
      env: { baseVersion: V1, currentVersion: V1 },
      access: access((ref) => {
        if (ref.id === 'B') return { exists: false, holdsLease: false }
        if (ref.id === 'C') return { exists: true, locked: true }
        return { exists: true, holdsLease: true }
      }),
    })
    expect(t.outcome.status).toBe('rejected')
    if (t.outcome.status !== 'rejected') return
    // 三条 ref 全部被检查（即使第一条已失败）。
    expect(t.outcome.error.params.failedTargets).toBe(3)
    expect(t.outcome.error.params.totalTargets).toBe(3)
    // `reasons` 逐目标列出（不是一句概括）。
    const reasons = String(t.outcome.error.params.reasons)
    expect(reasons).toContain('A.')
    expect(reasons).toContain('B.')
    expect(reasons).toContain('C.')
    expect(reasons.split(';').length).toBe(3)
  })

  it('单目标失败也带聚合字段（形态统一，调用方不必按目标数分支）', () => {
    const reg = makeRegistry()
    const t = applySetProperty<State>({
      registry: reg,
      ports: makePorts(),
      state: { values: {} },
      command: { kind: 'setProperty', refs: [propertyRef(owner(), `${OBJECT_TYPE}.ro`)], value: 1 },
      env: { baseVersion: V1, currentVersion: V1 },
      access: access(),
    })
    expect(t.outcome.status).toBe('rejected')
    if (t.outcome.status === 'rejected') {
      // 与多目标同一形态 —— 这是冻结 #5「统一」的含义：
      // "为什么被拒"的读取方式不随选择数量变化。
      expect(t.outcome.error.params.failedTargets).toBe(1)
      expect(t.outcome.error.params.totalTargets).toBe(1)
      expect(String(t.outcome.error.params.reasons)).toContain('A.')
    }
  })

  it('P1 侧 `reduceCommand` 的聚合形态与 P2 侧一致（同一组字段名）', () => {
    // 两处同形态是刻意的：面板显示的原因与核心返回的必须是同一份。
    const p1 = read('src/application/commands.ts')
    const p2 = read('src/application/property-commands.ts')
    for (const field of ['failedTargets', 'totalTargets', 'reasons', 'homogeneous']) {
      expect(p1).toContain(field)
      expect(p2).toContain(field)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// GF-5 **已收敛**：全树单一权威定义（本节由"断言现状"翻转为"断言目标态"）
// ════════════════════════════════════════════════════════════════════════════
//
// 本节原先把"重复定义仍在"测成事实（GF-5 的量化证据）。#250 裁决本批收敛后，
// 断言翻转为**目标态**：每个契约类型在全树**恰好一份**定义。
//
// 覆盖面是**生产代码**（`web/src/**` 去掉 `__tests__`）—— 测试夹具自己造窄化替身
// 是允许的（它们不构成第二权威，没有生产消费者指向它们），但生产文件一个都不许有。

describe('GF-5 已收敛：全树单一权威定义', () => {
  /**
   * 去掉注释与 import/再导出后的**代码文本**。
   *
   * 为什么必须去注释：本批在退役处写了**记录性注释**（"本文件曾有 X，现已迁至 Y"），
   * 裸正则会把注释里的 `propertyRef(`/`animatableProperties` 当成"代码still有"——
   * 那是**假红**。反过来，若注释里留着实现，去注释也会掩盖它 —— 故本函数只用于
   * "符号是否仍被定义/使用"的判定，定义点判定另有 `productionDefinitionsOf`。
   */
  function codeOf(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  }

  /** 全树生产文件的 `export type/interface X = …` 定义点。 */
  function productionDefinitionsOf(name: string): string[] {
    const out: string[] = []
    for (const rel of PRODUCTION_FILES) {
      let src: string
      try {
        src = read(rel)
      } catch {
        continue
      }
      // 去掉 import 与 `export {...} from`（再导出**不算**定义）。
      const stripped = codeOf(src)
        .replace(/^import[\s\S]*?from\s+'[^']*'\s*$/gm, '')
        .replace(/^export\s+(?:type\s+)?\{[^}]*\}\s*from\s+'[^']*'\s*$/gm, '')
      if (
        new RegExp(`export\\s+interface\\s+${name}\\b`).test(stripped) ||
        new RegExp(`export\\s+type\\s+${name}\\s*=`).test(stripped)
      ) {
        out.push(rel)
      }
    }
    return out
  }

  /** 单行形态的 `export type X = …`（`Result<T>` 带泛型参数，故单独判）。 */
  function productionsDeclaring(name: string): string[] {
    const out: string[] = []
    for (const rel of PRODUCTION_FILES) {
      let src: string
      try {
        src = read(rel)
      } catch {
        continue
      }
      const stripped = codeOf(src).replace(/^import[\s\S]*?from\s+'[^']*'\s*$/gm, '')
      if (new RegExp(`export\\s+type\\s+${name}\\s*(<[^>]*>)?\\s*=`).test(stripped)) out.push(rel)
    }
    return out
  }

  for (const name of [
    'PropertyValue',
    'PropertyDescriptor',
    'SetPropertyCommand',
    'EntityRef',
    'ElementRef',
    'PropertyRef',
    'PropertyId',
    'EntityOwnerKind',
    'Version',
    'ChangeSummary',
    'DomainError',
    'DomainErrorCode',
    'WouldBlockReason',
    'CommandOutcome',
  ]) {
    it(`\`${name}\` 在全树生产代码里**恰好一份**定义`, () => {
      const defs = productionDefinitionsOf(name)
      expect(defs, `${name} 的定义点应恰好 1 处，实测：${defs.join(', ') || '（无）'}`).toHaveLength(1)
    })
  }

  it('`Result` 在全树生产代码里**恰好一份**定义（带泛型参数，单独判）', () => {
    const defs = productionsDeclaring('Result')
    expect(defs, `Result 的定义点应恰好 1 处，实测：${defs.join(', ') || '（无）'}`).toHaveLength(1)
  })

  it('`application/contracts.ts` 是**再导出**，不再本地定义任何契约类型', () => {
    const src = read('src/application/contracts.ts')
    // 允许的定义只有"无家可归"的 `CommandOutcome`（它属命令结算，
    // 不属身份也不属错误）；其余契约类型一律再导出。
    const localTypes = [...codeOf(src).matchAll(/^export\s+(?:type|interface)\s+(\w+)/gm)].map((m) => m[1]!)
    expect(localTypes.sort()).toEqual(['CommandOutcome'])
    // 再导出的类型必须覆盖引用与错误两侧（否则消费方会各自找地方定义）。
    for (const re of [
      /export type \{[^}]*EntityRef[^}]*\}/,
      /export type \{[^}]*Version[^}]*\}/,
      /export type \{[^}]*DomainError[^}]*\}/,
      /export type \{[^}]*Result[^}]*\}/,
    ]) {
      expect(src).toMatch(re)
    }
  })

  it('`propertyRef` 只有 `domain/identity` 一份实现（RNA 侧不再重复）', () => {
    const p1 = codeOf(read('src/domain/identity.ts'))
    const p2 = codeOf(read('src/application/properties.ts'))
    expect(p1).toMatch(/export function propertyRef\(/)
    // 收敛前 `properties.ts` 有第二份 `propertyRef`（一个 freeze、一个不冻）。
    expect(p2).not.toMatch(/export function propertyRef\(/)
  })

  it('`reduceSetProperty` 不再有内联属性词汇（白名单/switch 已删）', () => {
    const commands = codeOf(read('src/application/commands.ts'))
    // 收敛前的内联面：`isStructuralProperty`、`applyPropertyValue` 的 switch、
    // `doc.types[...].animatableProperties` 白名单、第二份失败聚合。
    expect(commands).not.toMatch(/function isStructuralProperty/)
    expect(commands).not.toMatch(/function applyPropertyValue/)
    expect(commands).not.toMatch(/function validatePropertyWrite/)
    expect(commands).not.toMatch(/animatableProperties/)
    expect(commands).not.toMatch(/function aggregatePropertyFailures/)
    // 收敛后它把注册表交给 RNA 的 `applySetProperty`（单一写路由）。
    expect(commands).toMatch(/applySetProperty<Document>/)
    expect(commands).toMatch(/kernelPropertyRegistry\(\)/)
  })

  it('`queries.ts` 不再有 `STRUCTURAL_DESCRIPTORS` 或窄化的描述/值/可编辑性类型', () => {
    const queries = codeOf(read('src/application/queries.ts'))
    expect(queries).not.toMatch(/STRUCTURAL_DESCRIPTORS/)
    // 三个类型改为再导出 RNA 的权威定义。
    expect(read('src/application/queries.ts')).toMatch(/export type \{ PropertyDescriptor \}/)
    expect(read('src/application/queries.ts')).toMatch(/export type \{ PropertyValue \}/)
    expect(read('src/application/queries.ts')).toMatch(/export type \{ Editability \}/)
    // 窄化的可编辑性联合（`kind: 'editable'|'readOnly'|'missing'`）已删。
    expect(queries).not.toMatch(/readonly kind: 'editable'/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 内核属性词汇**已进入** RNA 注册表（GF-5 收敛项 2）
// ════════════════════════════════════════════════════════════════════════════
//
// 收敛前实测：P1 `reduceSetProperty` 会写的 10 个属性 ID（`name`/`visible`/
// `transform.*`/`projection.*`/`annotation.text`）在 P2 的 RNA 注册表里
// **0 个可解析** —— 因为两边描述的是两套不相交的文档模型，且 P1 的属性语义
// 是内联在命令里的白名单。
//
// 收敛后：内核侧（`domain/scene` 的 `Scene` 模型）的属性按限定式 ID
// **注册进 RNA 表**（`application/kernel-properties.ts`），`reduceSetProperty`
// 零属性词汇、只路由。故原先"0/10"的测量现在必须全部可解析。

describe('GF-5 收敛：内核属性词汇已注册进 RNA 表（原先实测 0/10）', () => {
  /** 内核写面**实际支持**的属性（限定式 ID）——与 `scene.ts` 的字段一一对应。 */
  const KERNEL_WRITABLE = [
    'block.name',
    'block.visible',
    'block.transform.position',
    'block.transform.rotation',
    'block.transform.scale',
    'block.transform.pivot',
    'annotation.text',
    'camera.projection.fov',
    'camera.projection.clipStart',
    'camera.projection.clipEnd',
  ]

  it('**机械测量**：内核写面的 10 个属性 ID 在 RNA 注册表里**全部**可解析', () => {
    for (const id of KERNEL_WRITABLE) {
      const d = describeProperty(kernelPropertyRegistry().registry, propertyRef(owner('o1'), id))
      expect(d.ok, `内核属性 ${id} 必须在 RNA 注册表里可解析`).toBe(true)
    }
    expect(KERNEL_WRITABLE).toHaveLength(10)
  })

  it('负对照：**未注册**的属性仍然被拒（收敛不是"什么都能解析"）', () => {
    const reg = kernelPropertyRegistry().registry
    for (const bad of ['block.nope', 'camera.text', 'annotation.projection.fov', 'nope', 'name']) {
      expect(describeProperty(reg, propertyRef(owner('o1'), bad)).ok, `${bad} 不得可解析`).toBe(false)
    }
  })

  it('限定式 ID：`<objectTypeId>.<localId>`，且 objectTypeId 是 `domain/scene` 的类型字面量', () => {
    const decls = kernelPropertyRegistry().registry.objectTypes().map((d) => d.id)
    expect(decls.sort()).toEqual(['annotation', 'block', 'camera'])
    // 属性 ID 的第一段就是 objectTypeId（冻结 #1 的限定形式）。
    for (const id of KERNEL_WRITABLE) {
      const objectTypeId = id.slice(0, id.indexOf('.'))
      expect(decls).toContain(objectTypeId)
    }
  })

  it('`commands.ts` 的内联属性词汇已删除（白名单/switch 不再是第二权威）', () => {
    // 只看**代码**：本文件在退役处留了记录性注释（列出被删函数与现归属），
    // 裸正则会把注释里的名字当成"代码still有"。去注释后再判，避免假红。
    const p1 = stripComments(read('src/application/commands.ts'))
    expect(p1).not.toMatch(/isStructuralProperty/)
    expect(p1).not.toMatch(/animatableProperties/)
    expect(p1).not.toMatch(/function applyPropertyValue/)
    expect(p1).not.toMatch(/function validatePropertyWrite/)
    expect(p1).not.toMatch(/function aggregatePropertyFailures/)
    // 收敛后它经 RNA 注册表路由。
    expect(p1).toMatch(/applySetProperty<Document>/)
    expect(p1).toMatch(/kernelPropertyRegistry\(\)/)
  })

  it('工作台面板声明仍是**独立**注册表（双轨登记：负责人 P10/#261，退出于工作台迁移）', () => {
    // 本批**不**合并面板旧轨（#253 退出边界：不做 Area/外壳）。
    // 但两条轨道现在共用**同一套 RNA 机制**（同一个 `registerObjectType`/
    // `applySetProperty`），差别只在文档模型与声明内容 —— 这是"暂存双轨"的
    // 明确定义：机制已统一，数据模型待迁移。
    const p2 = read('src/editors/workbench-inspector.ts')
    expect(p2).toMatch(/PROPERTY_OBJECT_TYPES/)
    expect(p2).toMatch(/lightning\.block/)
    // 旧轨登记：面板侧写路径仍是 `submitPropertyWrite`（→ `applySetProperty`）。
    const rna = read('src/editors/workbench-rna.ts')
    expect(rna).toMatch(/export function submitPropertyWrite/)
    expect(rna).toMatch(/applySetProperty<DocumentState>/)
  })
})
