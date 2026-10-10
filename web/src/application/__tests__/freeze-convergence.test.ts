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

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CAP_PROPERTY_WRITE,
  createPropertyRegistry,
  describeProperty,
  propertyRef,
  type ObjectTypeDecl,
  type PropertyAccess,
  type PropertyRegistry,
  type TargetFacts,
} from '@/application/properties'
import { localPropertyOf, domainError, type EntityRef as ContractEntityRef } from '@/application/contracts'
import { applySetProperty, createPropertyWritePorts, type PropertyWritePorts } from '@/application/property-commands'
import { PROPERTY_OBJECT_TYPES as WORKBENCH_OBJECT_TYPES } from '@/editors/workbench-inspector'
import { err, ok, type Result } from '@/domain/errors'


const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8')

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

  it('**实测**：注册表实际用的是 `contracts.ts` 的**开放**联合（GF-5 相关第二处未收敛）', () => {
    // P1 `domain/identity` 的 `EntityOwnerKind` 已符合 §1.1（封闭八种）；
    // P2 `contracts.ts` 那份仍是开放联合（带 `| (string & {})`），
    // 且 `properties.ts`（RNA 注册表）import 的正是**后者** ——
    // 故注册表并未受 P1 封闭联合约束。这是 GF-5 未通过的第二处证据。
    const contracts = read('src/application/contracts.ts')
    const identity = read('src/domain/identity.ts')
    const idStart = identity.indexOf('export type EntityOwnerKind')
    expect(identity.slice(idStart, identity.indexOf(';', idStart))).not.toMatch(/string\s*&\s*\{\}/)
    expect(contracts).toMatch(/string\s*&\s*\{\}/)
    expect(read('src/application/properties.ts')).toMatch(/type EntityOwnerKind[\s\S]{0,200}from '\.\/contracts'/)
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
// 单一权威：**当前实测**（GF-5 未通过项的证据，不是判据放宽）
// ════════════════════════════════════════════════════════════════════════════
//
// 本节的断言**刻意断言现状而非目标态**，因为「全树单一 `PropertyValue`/
// `PropertyDescriptor`/`SetPropertyCommand` 定义」这一条**尚未达成**：
// P1 的 `commands.ts`/`queries.ts` 仍各有自己的定义，且它们描述的是
// **另一套文档模型**（`Scene`：`name`/`visible`/`transform.*`）——
// 与 P2 的 RNA 声明（描述仍在使用中的 `RuntimeDocument`：`id`/`pos`/`tooltip`）
// **不是同一批属性**。把两套合并需要先决定用哪套文档模型作权威，
// 而把实时工作台从 `RuntimeDocument` 迁到 P1 的 `ApplicationState` 是
// P6（#257）的所有权面（见 `boundary-rules.mjs` 的 `RETIREMENT_OWNERS`）。
//
// 按契约 §8 第 3 条：**缺口只影响本批次某条验收 ⇒ 该条报"未通过"并注明缺口编号**，
// 其余条目照常交付；**不得**为让判据变绿而自行放宽或用近似实现顶替。
// 故此处把现状**测出来并计数**（作为 GF-5 的量化证据），
// 真到收敛那天，这个断言会因为"定义数变少"而失败 —— 那正是提醒把它改成 `toBe(1)`。

describe('GF-5 未通过项的证据：重复权威定义（现状计数）', () => {
  const SRC_FILES = [
    'src/application/contracts.ts',
    'src/application/properties.ts',
    'src/application/property-commands.ts',
    'src/application/commands.ts',
    'src/application/queries.ts',
    'src/domain/errors.ts',
    'src/domain/identity.ts',
    'src/runtime/execution.ts',
  ]

  function definitionsOf(name: string): string[] {
    const out: string[] = []
    for (const f of SRC_FILES) {
      let src: string
      try {
        src = read(f)
      } catch {
        continue
      }
      // 只看**定义**，不看 import / 再出口。
      const stripped = src
        .replace(/^import[\s\S]*?from\s+'[^']*'\s*$/gm, '')
        .replace(/^export\s+(type\s+)?\{[^}]*\}\s*from\s+'[^']*'\s*$/gm, '')
      if (
        new RegExp(`export\\s+interface\\s+${name}\\b`).test(stripped) ||
        new RegExp(`export\\s+type\\s+${name}\\s*=`).test(stripped)
      ) {
        out.push(f)
      }
    }
    return out
  }

  it('`PropertyValue` / `PropertyDescriptor` / `SetPropertyCommand` 的定义点计数（目标：各 1）', () => {
    const measured = {
      PropertyValue: definitionsOf('PropertyValue'),
      PropertyDescriptor: definitionsOf('PropertyDescriptor'),
      SetPropertyCommand: definitionsOf('SetPropertyCommand'),
    }
    // 当前实测（GF-5）：
    //   PropertyValue      = contracts + properties + commands + queries
    //   PropertyDescriptor = properties + queries
    //   SetPropertyCommand = commands + property-commands
    // 断言"至少存在一份权威定义"（保证本文件不是空转），
    // 并把**多份**作为证据记录下来（不在这里判绿/判红）。
    for (const [name, files] of Object.entries(measured)) {
      expect(files.length, `${name} 至少要有一份定义`).toBeGreaterThanOrEqual(1)
    }
    // 收敛后应改为 `expect(files).toHaveLength(1)`；现在把现状固化，
    // 使"谁在什么时候少了一份"在 diff 里可见。
    expect(measured.PropertyDescriptor.length).toBeGreaterThan(1)
    expect(measured.SetPropertyCommand.length).toBeGreaterThan(1)
  })

  it('`application/contracts.ts` **仍是**第二份契约定义（GF-5 未收敛，实测计数）', () => {
    const src = read('src/application/contracts.ts')
    // 实测（本批 **未** 达成"薄再出口"）：contracts.ts 仍本地定义
    //   Result / EntityOwnerKind / EntityRef / ElementRef / PropertyId /
    //   PropertyRef / Version / ChangeSummary / DomainErrorCode / WouldBlockReason /
    //   DomainError / CommandOutcome
    // 与 P1 的 `domain/errors`（Result/DomainError/八码/WouldBlockReason）
    // 与 `domain/identity`（EntityRef/PropertyRef/Version/ChangeSummary）
    // **同名同义各一份**。这是 GF-5 未通过的第二处证据。
    const localTypes = [...src.matchAll(/^export\s+(?:type|interface)\s+(\w+)/gm)].map((m) => m[1]!)
    expect(localTypes).toContain('EntityRef')
    expect(localTypes).toContain('PropertyRef')
    expect(localTypes).toContain('Version')
    expect(localTypes).toContain('DomainError')
    expect(localTypes).toContain('Result')
    // 若哪天收敛完成（本文件改为纯再出口），这条断言会失败 ——
    // 那正是提醒把它改成 `expect(localTypes).toEqual([])`。
    expect(localTypes.length).toBeGreaterThan(0)
  })

  it('P2 的 `propertyRef` 与 P1 `domain/identity` 的同名函数并存（第三处重复）', () => {
    // 两处都叫 `propertyRef`、签名兼容但实现不同（一个 Object.freeze，一个不冻）。
    // 这是"名义上同一概念、实际两份实现"的典型 —— 冻结靠测试钉住现状。
    const p2 = read('src/application/properties.ts')
    const p1 = read('src/domain/identity.ts')
    expect(p2).toMatch(/export function propertyRef\(/)
    expect(p1).toMatch(/export function propertyRef\(/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// GF-5 缺口本身的可复现证据
// ════════════════════════════════════════════════════════════════════════════

describe('GF-5 缺口的可复现证据：两套文档模型的属性词汇不相交', () => {
  it('**机械测量**：P1 写面的 10 个属性 ID 在 P2 注册表里 0 个可解析', () => {
    // 这是 GF-5 的核心证据：不是"风格不一致"，而是**两个模型没有交集**。
    // P1 `reduceSetProperty` 实际会写的属性（从 `commands.ts` 抄出）：
    const p1Writable = [
      'name',
      'visible',
      'transform.position',
      'transform.rotation',
      'transform.scale',
      'transform.pivot',
      'projection.fov',
      'projection.clipStart',
      'projection.clipEnd',
      'annotation.text',
    ]
    // P2 的注册表（真实声明，非夹具）：
    const reg = createPropertyRegistry()
    for (const decl of WORKBENCH_OBJECT_TYPES) reg.registerObjectType(decl)

    // 逐个尝试"把 P1 的 obj.type 当 objectTypeId"的几种合理拼法。
    const resolved: string[] = []
    for (const p of p1Writable) {
      const attempts = [`block.${p}`, `annotation.${p}`, `camera.${p}`, p]
      if (attempts.some((id) => describeProperty(reg, propertyRef(owner('x'), id)).ok)) resolved.push(p)
    }
    // 实测 0 —— 若哪天大于 0，说明两套模型开始汇合，本断言与 GF-5 状态都要更新。
    expect({ resolved, count: resolved.length }).toEqual({ resolved: [], count: 0 })
  })

  it('P1 的 `Scene` 对象类型 `annotation`/`camera` 在 P2 声明里没有对应', () => {
    // P2 的注解被拆成 5 个 objectType（按 shape），相机根本没有声明。
    const ids = WORKBENCH_OBJECT_TYPES.map((d) => d.id)
    expect(ids).not.toContain('annotation')
    expect(ids).not.toContain('camera')
    expect(ids).toContain('lightning.annotation.box')
  })

  it('P1 `reduceCommand` 写的属性词 ≠ P2 RNA 声明的属性词', () => {
    const p1 = read('src/application/commands.ts')
    const p2 = read('src/editors/workbench-inspector.ts')
    // P1 侧（`Scene` 模型）：name / visible / transform.* / projection.*
    expect(p1).toMatch(/ref\.property === 'name'/)
    expect(p1).toMatch(/startsWith\('transform\.'\)/)
    // P2 侧（`RuntimeDocument` 模型）：id / pos / tooltip / cellTooltip
    expect(p2).toMatch(/id: 'tooltip'/)
    expect(p2).toMatch(/id: 'cellTooltip'/)
    // 负对照：P1 的 `transform.position` **没有**出现在 P2 的声明里。
    expect(p2).not.toMatch(/id: 'transform\.position'/)
  })

  it('实时工作台仍读旧 `RuntimeDocument`（P1 核心未被实时应用实例化）', () => {
    // P1 的 `Editor`/`EditorClient` 在生产代码里**零实例化**。
    const runtime = read('src/runtime/context.ts')
    expect(runtime).toMatch(/getDoc\(\): Ref<RuntimeDocument \| null>/)
  })
})
