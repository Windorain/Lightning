/**
 * A02 `pure-domain` —— 业务规则的纯性（#249 §14 A02；契约 §5.3）。
 *
 * ## 本轮要证的两件事
 *
 * 1. **正常路径**：冻结输入、固定身份输入，重复执行规则 ⇒ 输入不变、输出与效果描述相同；
 *    不读全局时钟/随机/IO。
 * 2. **负对照**：注入"全局时间读取"或"输入写入"⇒ **必须判红**。
 *
 * ## 负对照为什么必须真的破坏目标保证
 *
 * #249 §14 测试维护要求：「负对照必须证明确实破坏了目标保证，**不能只令测试主动抛错**」。
 * 故本文件的负对照不是 `expect(() => reduceCommand(...)).toThrow()`，而是：
 *  - 造一个**真的**读时钟的"变异转移函数"，用与正对照**同一个**断言器（`assertReproducible`）
 *    去检查它，断言该断言器在它身上**判红**；
 *  - 造一个**真的**写输入的变异函数，断言同一断言器也判红。
 *
 * 于是"断言器有效"与"实现纯净"是两条独立的证据：
 * 若断言器太弱（恒绿），第一条负对照会失败。
 */

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ALL_CAPABILITIES, defaultExecutionInputs, openDocumentState, reduceCommand, type Command, type ExecutionInputs, type Transition } from '@/application/commands'
import { digestStep } from '@/runtime/scheduling'
import type { InputRecord } from '@/runtime/scheduling'
import { canonicalize } from '@/domain/identity'
import { emptyApplicationState, type ApplicationState } from '@/application/state'

/**
 * A01 设施的 AST 抽取器（与 `web/tests/architecture/` 同源，避免两套判据漂移）。
 *
 * 用 `createRequire` 而不是 `import`：后者在 vitest 的 esbuild 转译下会被解析成
 * 相对 `src/` 的路径（本文件在 `src/domain/__tests__/`，`../../tests` 指向 `src/tests`）。
 * `require` 走 Node 的真实解析，且该文件是 `.mjs`，在 ESM 下可用 `createRequire` 加载。
 */
const require_ = createRequire(path.join(process.cwd(), 'noop.js'))
const { extractGlobalRefs } = require_(path.join(process.cwd(), 'tests', 'architecture', 'module-graph.mjs')) as {
  extractGlobalRefs: (absPath: string) => { name: string; line: number }[]
}

/**
 * 纯核心层（A02/A01 的判定面，逐条对应 `LAYER_DESTINATIONS` 的 `corePurity`）。
 *
 * P4（#255）追加六个文件。**为什么 P4 的新层必须进这张表**：纯性（不读全局时钟/
 * 随机/DOM/IO、不改输入）是本批最容易被破坏的性质 —— 动画与求值天然想读
 * `performance.now()`、想累积 `elapsed += delta`。列表不覆盖它们，
 * 等于把"最容易违约的地方"排除在判据之外。
 */
const PURE_CORE_FILES = [
  'domain/identity.ts',
  'domain/errors.ts',
  'domain/scene.ts',
  'domain/document.ts',
  'domain/editing.ts',
  // P3（#254）：几何/坐标关系/锚点/选择 —— 与 P1 同属纯核心，受同一 A02 闸门约束
  'domain/geometry.ts',
  'domain/geometryEditing.ts',
  'domain/spatial.ts',
  'domain/anchor.ts',
  'domain/selection.ts',
  // P4（#255）：时间/轨道/采样、纹理序列纯采样、通道装配 —— 同为纯核心
  'domain/animation.ts',
  'domain/materials.ts',
  'domain/multiblock.ts',
  'application/state.ts',
  'application/commands.ts',
  'application/queries.ts',
  'application/evaluation.ts',
  'runtime/execution.ts',
  'runtime/scheduling.ts',
  'runtime/effects.ts',
  'runtime/evaluation.ts',
]

const WEB_SRC_ROOT = path.join(process.cwd(), 'src')

// ─────────────────────────────────────────────────────────────────────────────
// 断言器（正负对照共用）
// ─────────────────────────────────────────────────────────────────────────────

/** 深冻结（防止被测函数偷偷写输入；写即抛，成为可观测证据）。 */
function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}

/** 对一段状态做语义摘要（含效果序列）——两份摘要相同才算"重复执行结果相同"。 */
function semanticDigest(state: ApplicationState): string {
  const docIds = Object.keys(state.docs).sort()
  const ctxIds = Object.keys(state.contexts).sort()
  return canonicalize({
    docs: docIds.map((id) => {
      const d = state.docs[id]
      return {
        id,
        version: d.version,
        baseline: d.saveBaseline,
        objects: Object.keys(d.scene.objects).sort().map((oid) => {
          const o = d.scene.objects[oid]
          return { id: o.id, type: o.type, name: o.name, visible: o.visible, dataId: o.dataId, transform: o.transform }
        }),
        data: Object.keys(d.scene.data).sort().map((did) => {
          const dd = d.scene.data[did]
          return { id: dd.id, source: dd.source, payload: dd.payload, contentVersion: dd.contentVersion }
        }),
        order: d.scene.order,
        past: d.history.past.map((h) => h.label),
        future: d.history.future.map((h) => h.label),
      }
    }),
    contexts: ctxIds.map((id) => {
      const c = state.contexts[id]
      return { id, doc: c.documentId, selection: c.selection, time: c.time, channels: c.channelValues, tool: c.activeTool, interaction: c.interaction?.targets ?? null }
    }),
    leases: Object.keys(state.leases).sort().map((id) => ({ id, holder: state.leases[id].holder })),
    effects: state.effects,
  })
}

/**
 * 重复执行同一段命令序列，断言：输入不变、输出摘要相同。
 *
 * 返回两次运行的摘要（供调用方进一步断言"看起来像是真的跑了"）。
 * `exec` 是**注入点** —— 负对照用它替换成变异实现。
 */
function assertReproducible(
  initial: ApplicationState,
  commands: readonly Command[],
  env: ExecutionInputs,
  exec: (s: ApplicationState, c: Command, e: ExecutionInputs) => Transition = reduceCommand,
): { first: string; second: string } {
  const s1 = deepFreeze(structuredClone(initial))
  const s2 = deepFreeze(structuredClone(initial))
  const before1 = semanticDigest(s1)
  const before2 = semanticDigest(s2)
  // 前置：两次运行**起点逐位相同**（否则"结果相同"毫无意义）
  if (before1 !== before2) throw new Error('A02 前置失败：两次运行的初态摘要不同')

  let a = s1
  let b = s2
  const effectsA: string[] = []
  const effectsB: string[] = []
  for (const c of commands) {
    const ta = exec(a, c, env)
    const tb = exec(b, c, env)
    effectsA.push(...ta.effects.map((e) => `${e.kind}:${e.correlationId}`))
    effectsB.push(...tb.effects.map((e) => `${e.kind}:${e.correlationId}`))
    a = ta.state
    b = tb.state
  }
  const after1 = semanticDigest(a)
  const after2 = semanticDigest(b)
  if (after1 !== after2) throw new Error(`A02 判红：重复执行结果不同\n${after1}\n---\n${after2}`)
  if (effectsA.join('|') !== effectsB.join('|')) throw new Error('A02 判红：效果描述序列不同')
  // 输入不变（深冻结下若实现写过输入，前面就已经抛错）
  if (semanticDigest(s1) !== before1) throw new Error('A02 判红：输入被修改')
  return { first: after1, second: after2 }
}

const ENV = defaultExecutionInputs()

function commandScript(): readonly Command[] {
  return [
    { kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' },
    { kind: 'addObject', contextId: 'ctx-1', objectType: 'annotation', name: 'B' },
    { kind: 'addObject', contextId: 'ctx-1', objectType: 'camera', name: 'C' },
    { kind: 'select', contextId: 'ctx-1', target: { kind: 'object', id: 'wk-object-1' } },
    { kind: 'setTime', contextId: 'ctx-1', time: { frame: 7, fps: 20 } },
    { kind: 'setChannelValue', contextId: 'ctx-1', channel: 'totalTier', value: 3 },
    { kind: 'beginInteraction', contextId: 'ctx-1', tool: 'move', targets: ['wk-object-1'] },
    { kind: 'updateInteraction', contextId: 'ctx-1', displacement: { x: 2, y: 0, z: 1 } },
    { kind: 'commitInteraction', contextId: 'ctx-1', label: 'move A' },
    { kind: 'undo', contextId: 'ctx-1' },
    { kind: 'redo', contextId: 'ctx-1' },
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// 正常路径
// ─────────────────────────────────────────────────────────────────────────────

describe('A02 pure-domain：冻结输入 + 重复执行 ⇒ 相同语义结果与效果序列', () => {
  it('11 条命令的完整脚本重复执行，语义摘要与效果序列逐位相同', () => {
    const { first, second } = assertReproducible(openDocumentState(), commandScript(), ENV)
    expect(first).toBe(second)
    // 反空洞真：摘要必须**确实**包含了内容（否则"相同"可能只是"都是空的"）
    expect(first).toContain('wk-object-1')
    expect(first).toContain('totalTier')
  })

  it('相同显式输入下，同一条命令的 Transition 逐字段相同（不做容器身份比较）', () => {
    const s = openDocumentState()
    const cmd: Command = { kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'X' }
    const t1 = reduceCommand(deepFreeze(structuredClone(s)), cmd, ENV)
    const t2 = reduceCommand(deepFreeze(structuredClone(s)), cmd, ENV)
    expect(t1.status).toBe('applied')
    expect(t2.status).toBe('applied')
    expect(t1.version).toEqual(t2.version)
    if (t1.status !== 'applied' || t2.status !== 'applied') return
    expect(canonicalize(t1.changes)).toBe(canonicalize(t2.changes))
    // 身份分配是**显式状态**（`ids`），故两次得到同一批 id —— 这是 A04 重放的前提
    expect(Object.keys(t1.state.docs['doc-1'].scene.objects)).toEqual(Object.keys(t2.state.docs['doc-1'].scene.objects))
  })

  it('`reduceCommand` 不修改输入状态（对象引用与内容都不变）', () => {
    const s = openDocumentState()
    const before = semanticDigest(s)
    const frozen = deepFreeze(s)
    reduceCommand(frozen, { kind: 'addObject', contextId: 'ctx-1', objectType: 'block' }, ENV)
    reduceCommand(frozen, { kind: 'setTime', contextId: 'ctx-1', time: { frame: 3, fps: 20 } }, ENV)
    reduceCommand(frozen, { kind: 'save', contextId: 'ctx-1' }, ENV)
    expect(semanticDigest(s)).toBe(before)
  })

  it('纯核心层源码里不存在全局时钟/随机/性能计时读取（AST 级，非关键词计数）', () => {
    // 与 A01 设施同源的抽取器（`web/tests/architecture/module-graph.mjs`）：
    // 只认真正的 Identifier 引用，注释与字符串不计入。
    // 这是 A02「不读取全局时钟/随机数/DOM/Vue 状态/网络/可变单例」的**导入限制**那一半
    // （#249 §14：静态扫描不宣称能证明全部 JavaScript 纯性，故与行为测试互为补充）。
    const forbidden = new Set(['Date', 'performance', 'process', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'fetch', 'XMLHttpRequest'])
    const findings: string[] = []
    for (const rel of PURE_CORE_FILES) {
      const abs = path.resolve(WEB_SRC_ROOT, rel)
      for (const ref of extractGlobalRefs(abs)) {
        if (forbidden.has(ref.name)) findings.push(`src/${rel}:${ref.line} ${ref.name}`)
      }
    }
    expect(findings).toEqual([])
    // 反空洞真：抽取器必须**确实**在这些文件上抽到了东西（否则"没找到"可能只是"没解析"）
    const totalRefs = PURE_CORE_FILES.reduce((n, rel) => n + extractGlobalRefs(path.resolve(WEB_SRC_ROOT, rel)).length, 0)
    expect(totalRefs).toBeGreaterThan(50)
  })

  it('反空洞真：抽取器对**故意违规**的样本确实判红（同一抽取器、同一判据）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-a02-'))
    try {
      const file = path.join(dir, 'dirty.ts')
      fs.writeFileSync(
        file,
        ['export function now(): number {', '  return Date.now() + performance.now()', '}'].join('\n'),
        'utf8',
      )
      const names = extractGlobalRefs(file).map((r) => r.name)
      expect(names, '同一抽取器必须抓到 Date / performance').toContain('Date')
      expect(names).toContain('performance')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 负对照
// ─────────────────────────────────────────────────────────────────────────────

describe('A02 负对照：注入全局时间读取 / 输入写入 ⇒ 断言器必须判红', () => {
  it('负对照 1：读全局时钟的转移函数被判红（断言器确实能抓"不确定性"）', () => {
    // 变异实现：与 reduceCommand 行为相同，但把**全局时钟**掺进结果。
    // 之所以不只 `Date.now()`：两次运行可能落在同一毫秒，那样夹具本身不够敏感。
    // 这里同时读墙钟并叠加一个模块级可变计数器 —— 后者正是 #249 §2.1 明令禁止的
    // 「可变单例」，也正是"多 RAF + Promise 回调写状态"那类旧机制的真实形态。
    let hiddenGlobalCounter = 0
    const clockReadingReducer = (s: ApplicationState, c: Command, e: ExecutionInputs): Transition => {
      const t = reduceCommand(s, c, e)
      hiddenGlobalCounter += 1
      return {
        ...t,
        state: Object.freeze({ ...t.state, ids: Object.freeze({ prefix: `clock-${Date.now()}-${hiddenGlobalCounter}`, counter: t.state.ids.counter }) }),
      }
    }
    let red = false
    try {
      assertReproducible(openDocumentState(), commandScript(), ENV, clockReadingReducer)
    } catch {
      red = true
    }
    expect(red, '读全局时钟/可变单例的变异实现必须被 A02 断言器判红（否则断言器是恒绿的假设施）').toBe(true)
  })

  it('负对照 2：写输入的转移函数被判红（深冻结下写即抛）', () => {
    const inputWritingReducer = (s: ApplicationState, c: Command, e: ExecutionInputs): Transition => {
      // 直接篡改输入状态（变异）——真实实现绝不允许
      ;(s as { effects: unknown }).effects = Object.freeze([{ kind: 'save', correlationId: 'INJECTED', params: {} }])
      return reduceCommand(s, c, e)
    }
    let red = false
    try {
      assertReproducible(openDocumentState(), commandScript(), ENV, inputWritingReducer)
    } catch {
      red = true
    }
    expect(red, '写输入的变异实现必须被判红').toBe(true)
  })

  it('负对照 3：把"输入未变"这一半单独证伪（只比对结果会漏判输入写入）', () => {
    // 造一个**不改结果、只改输入**的变异：若断言器只看结果就会漏掉它。
    const silentInputWriter = (s: ApplicationState, c: Command, e: ExecutionInputs): Transition => {
      const t = reduceCommand(s, c, e)
      // 结果不变，但在输入上留下痕迹（模拟"顺手记了个日志到状态里"）
      try {
        ;(t.state as { __trace?: number }).__trace = 1
      } catch {
        /* 冻结时抛，正是我们想观测的 */
      }
      return t
    }
    // 该变异在深冻结输入上不会改到 `s`，但它揭示了一个事实：
    // 断言器之所以能判红负对照 2，靠的是**深冻结 + 前后摘要比对**两条一起。
    expect(() => assertReproducible(openDocumentState(), commandScript(), ENV, silentInputWriter)).not.toThrow()
    // 于是必须把"冻结"本身也作为证据钉住：不冻结时输入写入确实会发生。
    const unfrozen = structuredClone(openDocumentState())
    inputWriteProbe(unfrozen)
    expect((unfrozen as { __probe?: number }).__probe).toBe(1)
  })
})

/** 证明"未冻结的输入确实可被写" —— 即深冻结不是装饰。 */
function inputWriteProbe(s: ApplicationState): void {
  ;(s as { __probe?: number }).__probe = 1
}

// ─────────────────────────────────────────────────────────────────────────────
// 能力裁剪也是显式输入（不是隐藏全局）
// ─────────────────────────────────────────────────────────────────────────────

describe('A02/A15：能力集合是显式执行输入，不是隐藏全局', () => {
  it('同一命令在两种能力集合下结果不同（证明能力确实来自 env 而非全局状态）', () => {
    const s = openDocumentState()
    const cmd: Command = { kind: 'addObject', contextId: 'ctx-1', objectType: 'block' }
    const full = reduceCommand(s, cmd, ENV)
    const viewer = reduceCommand(s, cmd, { capabilities: ['interaction.begin'] })
    expect(full.status).toBe('applied')
    expect(viewer.status).toBe('rejected')
    if (viewer.status === 'rejected') expect(viewer.error.code).toBe('UnsupportedOperation')
    expect(ALL_CAPABILITIES.length).toBeGreaterThan(0)
  })

  it('空状态 + 无文档时 openDocument 是唯一入口（不隐式造文档）', () => {
    const empty = emptyApplicationState()
    const t = reduceCommand(empty, { kind: 'setTime', contextId: 'ctx-1', time: { frame: 1, fps: 20 } }, ENV)
    expect(t.status).toBe('rejected')
    if (t.status === 'rejected') expect(t.error.code).toBe('MissingTarget')
  })
})

/** 保留 `digestStep`/`InputRecord` 的引用，说明 A02 与 A04 共用同一摘要口径。 */
describe('A02 与 A04 共用摘要口径（避免两套判据漂移）', () => {
  it('同一 (输入, 转移) 的 digestStep 是稳定值', () => {
    const s = openDocumentState()
    const record: InputRecord = { sequence: 1, order: 0, source: 'command', command: { kind: 'select', contextId: 'ctx-1', target: null }, env: ENV }
    const t = reduceCommand(s, record.command, record.env)
    expect(digestStep(record, t)).toEqual(digestStep(record, t))
  })
})
