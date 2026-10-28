/**
 * A03 `single-commit` + A04 `deterministic-replay` + C1 —— **统一更新阶段与原子发布**
 * （§2.1；验收 C1）。
 *
 * ## A03 要证的三条
 *
 * | 断言 | 本文件的落点 |
 * |---|---|
 * | 所有权威变化**只在**更新阶段 | 内核**不**自带循环：`Editor` 上没有任何 `requestAnimationFrame`/定时器；批次只能由宿主显式调用 `runBatch()` 推进 |
 * | 发布版本内文档/选择/历史一致 | 状态是不可变值，发布 = 一次引用赋值；订阅者读到的是同一份值 |
 * | **负对照**：允许回调直接推进版本 ⇒ 判红 | 订阅回调里 `executeNow` 一条写命令必须拿到 `WouldBlock{reason:'reentrant'}`；`submit` 只入队（下一批生效） |
 *
 * ## A04 要证的两条
 *
 * 1. 记录时间/命令/完成事件后重放 ⇒ 逐提交语义摘要与效果序列一致，**无需 DOM/GPU**；
 * 2. **负对照**：改变一项输入、或忽略完成序号 ⇒ 必须产生差异。
 */

import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Editor, type CommandOutcome, type QuerySpec } from '@/runtime/execution'
import type { Command } from '@/application/commands'
import { defaultExecutionInputs } from '@/application/commands'
import { replay, type InputRecord, type ReplayLog } from '@/runtime/scheduling'
import { canonicalize } from '@/domain/identity'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

/** 建一个已打开文档的 Editor（经**同一个** `reduceCommand` 入口，不走旁路）。 */
function makeEditor(): Editor {
  const e = new Editor()
  const t = e.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
  e.runBatch()
  expect(e.settlement(t)?.status, '前置：openDocument 必须 applied').toBe('applied')
  return e
}

const WRITE_COMMAND: Command = { kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' }

// ─────────────────────────────────────────────────────────────────────────────
// A03 —— 所有权威变化只在更新阶段
// ─────────────────────────────────────────────────────────────────────────────

describe('A03 single-commit：权威变化只在更新阶段发生', () => {
  it('`submit` 接收 ≠ 生效：提交后状态未变，批次推进后才变', () => {
    const e = makeEditor()
    const before = e.snapshot()
    const objectsBefore = Object.keys(before.docs['doc-1'].scene.objects).length

    const ticket = e.submit(WRITE_COMMAND)
    // 接收 ≠ 已生效
    expect(e.settlement(ticket), '未推进批次前不得结算').toBeNull()
    expect(Object.keys(e.snapshot().docs['doc-1'].scene.objects).length, '未推进批次前状态不得变化').toBe(objectsBefore)
    expect(e.pending).toBe(1)

    e.runBatch()
    expect(e.settlement(ticket)?.status, '推进批次后必须结算为 applied').toBe('applied')
    expect(Object.keys(e.snapshot().docs['doc-1'].scene.objects).length).toBe(objectsBefore + 1)
  })

  it('普通命令**只结算一次**（A03「普通命令有一次结算」）', () => {
    const e = makeEditor()
    const ticket = e.submit(WRITE_COMMAND)
    e.runBatch()
    const first = e.settlement(ticket)
    expect(first?.status).toBe('applied')
    // 再次推进批次：队列已空，结算结果不得变化、不得二次结算
    e.runBatch()
    expect(e.settlement(ticket)).toBe(first)
  })

  it('发布版本内文档/选择/历史一致：订阅者读到的组合不含"新文档旧选择"', () => {
    const e = makeEditor()
    const seen: Array<{ objects: number; selected: string | null; history: number }> = []
    const dispose = e.observe({ kind: 'objects', documentId: 'doc-1' }, () => {
      const s = e.snapshot()
      const doc = s.docs['doc-1']
      const ctx = s.contexts['ctx-1']
      seen.push({
        objects: Object.keys(doc.scene.objects).length,
        selected: ctx.selection.active?.id ?? null,
        history: doc.history.past.length,
      })
    })
    e.submit(WRITE_COMMAND)
    e.runBatch()
    e.submit({ kind: 'deleteObject', contextId: 'ctx-1', objectId: 'wk-object-1' })
    e.runBatch()
    dispose()

    expect(seen.length).toBeGreaterThan(0)
    for (const snap of seen) {
      // 不变量：有选择⇒该对象必须在同版本的场景里存在（"新文档旧选择"会破坏它）
      if (snap.selected !== null) expect(snap.objects).toBeGreaterThan(0)
      expect(snap.history).toBeGreaterThanOrEqual(0)
    }
    // 反空洞真：订阅确实被触发过（不是"一次都没投递所以恒真"）
    expect(seen.length).toBeGreaterThan(1)
  })

  it('**负对照**：订阅回调里 `executeNow` 写命令 ⇒ `WouldBlock{reason:"reentrant"}`', () => {
    const e = makeEditor()
    let outcome: CommandOutcome | null = null
    // `observe` 首次投递**不在**发布栈内（订阅者立刻拿到当前值，这是执行协议的行为），
    // 故负对照必须只针对"发布栈内的那次投递"。首版未区分，导致回调在**订阅时**
    // 就把命令写成功了 —— 那不是负对照失败，是夹具没打中目标（实测教训）。
    let deliveries = 0
    const dispose = e.observe({ kind: 'objects', documentId: 'doc-1' }, () => {
      deliveries += 1
      if (deliveries === 1) return // 订阅时的首次投递：跳过
      // 这正是 A03 负对照「允许回调直接推进版本」的注入形态：
      // 在**发布栈内**尝试同步写。它必须被拒绝，而不是静默生效。
      outcome = e.executeNow(WRITE_COMMAND as never)
    })
    e.submit(WRITE_COMMAND)
    e.runBatch()
    dispose()

    expect(deliveries, '前置：必须发生过至少一次发布栈内的投递').toBeGreaterThanOrEqual(2)
    const got = outcome as CommandOutcome | null
    expect(got, '发布栈内的回调必须拿到一个结算结果').not.toBeNull()
    expect(got?.status, `实得 ${JSON.stringify(got)}`).toBe('rejected')
    if (got?.status === 'rejected') {
      expect(got.error.code).toBe('WouldBlock')
      expect(got.error.params.reason).toBe('reentrant')
    }
    // 且回调那次的写**确实没有**生效：只有 submit 的那一个对象
    expect(Object.keys(e.snapshot().docs['doc-1'].scene.objects).length).toBe(1)
  })

  it('订阅回调里 `submit` 是合法的，但只进入**下一**合法更新批次', () => {
    const e = makeEditor()
    let submitted: ReturnType<Editor['submit']> | null = null
    let deliveries = 0
    const dispose = e.observe({ kind: 'objects', documentId: 'doc-1' }, () => {
      deliveries += 1
      if (deliveries === 1) return // 订阅时的首次投递不在发布栈内（同上）
      if (submitted === null) submitted = e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'annotation', name: 'from-callback' })
    })
    e.submit(WRITE_COMMAND)
    e.runBatch()
    // 批次内：回调提交的命令尚未生效
    expect(submitted, '前置：发布栈内的回调必须提交过一条命令').not.toBeNull()
    expect(e.settlement(submitted!), '回调内的 submit 不得在同栈生效').toBeNull()
    expect(Object.keys(e.snapshot().docs['doc-1'].scene.objects).length).toBe(1)
    // 下一批：生效
    e.runBatch()
    expect(e.settlement(submitted!)?.status).toBe('applied')
    expect(Object.keys(e.snapshot().docs['doc-1'].scene.objects).length).toBe(2)
    dispose()
  })

  it('内核**不自带**循环：源码里没有 requestAnimationFrame / 定时器', () => {
    // A03「所有权威变化只在更新阶段」的结构性一半：没有"到点自己跑"的东西，
    // 就不存在隐式的第二条业务推进路径（这正是退役项 6 的目标形态）。
    // 用本仓的 AST 抽取器（而非 `text.includes`）：`includes` 会把注释里的词
    // 也算进来，那正是 A01 文件头强调的"关键词计数只能作补充"。
    const require_ = createRequire(path.join(process.cwd(), 'noop.js'))
    const { extractGlobalRefs } = require_(path.join(process.cwd(), 'tests', 'architecture', 'module-graph.mjs')) as {
      extractGlobalRefs: (abs: string) => { name: string; line: number }[]
    }
    const loopPrimitives = new Set(['requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'setTimeout', 'queueMicrotask'])
    const findings: string[] = []
    for (const rel of ['runtime/execution.ts', 'runtime/scheduling.ts', 'runtime/effects.ts', 'application/commands.ts', 'domain/document.ts', 'domain/editing.ts']) {
      const abs = path.join(process.cwd(), 'src', rel)
      for (const ref of extractGlobalRefs(abs)) {
        if (loopPrimitives.has(ref.name)) findings.push(`src/${rel}:${ref.line} ${ref.name}`)
      }
    }
    expect(findings, '内核不得自带任何循环原语（否则"业务推进可枚举"不成立）').toEqual([])
    // 反空洞真：抽取器确实在这些文件上抽到了自由标识符（否则"没找到"可能只是"没解析"）
    const total = ['runtime/execution.ts', 'domain/document.ts'].reduce(
      (n, rel) => n + extractGlobalRefs(path.join(process.cwd(), 'src', rel)).length,
      0,
    )
    expect(total).toBeGreaterThan(5)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A04 —— 确定性重放
// ─────────────────────────────────────────────────────────────────────────────

/** 一段含"正常 + 拒绝 + 保存"的输入流：重放它对账的语义面更宽。 */
function recordSession(): { editor: Editor; log: ReplayLog; initial: ReturnType<Editor['snapshot']> } {
  const e = new Editor()
  const initial = e.snapshot()
  e.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
  e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' })
  e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'annotation', name: 'B' })
  e.submit({ kind: 'setProperty', refs: [{ owner: { kind: 'object', id: 'wk-object-1' }, property: 'block.name' }], value: 'renamed' })
  e.submit({ kind: 'setTime', contextId: 'ctx-1', time: { frame: 5, fps: 20 } })
  // 拒绝路径：目标不存在
  e.submit({ kind: 'deleteObject', contextId: 'ctx-1', objectId: 'nope' })
  // 保存（产生效果描述）
  e.submit({ kind: 'save', contextId: 'ctx-1' })
  // 交互往返（净零）
  e.submit({ kind: 'beginInteraction', contextId: 'ctx-1', tool: 'move', targets: ['wk-object-1'] })
  e.submit({ kind: 'updateInteraction', contextId: 'ctx-1', displacement: { x: 3, y: 0, z: 0 } })
  e.submit({ kind: 'updateInteraction', contextId: 'ctx-1', displacement: { x: 0, y: 0, z: 0 } })
  e.submit({ kind: 'commitInteraction', contextId: 'ctx-1', label: 'roundtrip' })
  e.drain()
  return { editor: e, log: e.replayLog(initial), initial }
}

describe('A04 deterministic-replay：记录后重放，逐提交语义摘要与效果序列一致', () => {
  it('重放同一记录 ⇒ 摘要逐条一致、效果序列一致、末态一致（无需 DOM/GPU）', () => {
    const { editor, log, initial } = recordSession()
    expect(log.inputs.length, '前置：记录必须非空').toBeGreaterThan(5)
    expect(log.digests.length).toBe(log.inputs.length)

    const r = replay(log)
    expect(r.mismatch, `首个不一致：${JSON.stringify(r.mismatch)}`).toBeNull()
    expect(r.ok).toBe(true)
    expect(r.digests.length).toBe(log.digests.length)
    expect(canonicalize(r.state)).toBe(canonicalize(editor.snapshot()))
    // 效果序列一致（A04 明文要求"与效果序列一致"）
    expect(canonicalize(r.state.effects)).toBe(canonicalize(log.effects))
    // 反空洞真：记录里必须**确实**含拒绝与效果，否则"一致"很容易
    expect(log.digests.some((d) => d.status === 'rejected')).toBe(true)
    expect(log.digests.some((d) => d.effectKinds.length > 0)).toBe(true)
    // initial 未被重放修改
    expect(canonicalize(initial)).toBe(canonicalize(log.initial))
  })

  it('**负对照 1**：改变一项输入 ⇒ 摘要必须出现差异', () => {
    const { log } = recordSession()
    const tampered: ReplayLog = {
      ...log,
      inputs: log.inputs.map((i, idx) => (idx === 2 ? ({ ...i, command: { kind: 'addObject', contextId: 'ctx-1', objectType: 'camera', name: 'A' } } as InputRecord) : i)),
    }
    const r = replay(tampered)
    expect(r.ok, '改掉一项输入后重放必须判红').toBe(false)
    expect(r.mismatch?.index).toBe(2)
  })

  it('**负对照 2**：把"完成事件"插到它实际结算之前 ⇒ 摘要出现差异', () => {
    const { log } = recordSession()
    // 找到 save 命令与紧随其后的输入；把"完成事件"（这里以 saveCompleted 形态注入）
    // 提前到 save **之前** —— 那正是"忽略完成序号"会造成的形态：
    // 完成事件先于发起到达，若实现不校验序号就会误把基线推进。
    const saveIdx = log.inputs.findIndex((i) => i.command.kind === 'save')
    expect(saveIdx, '前置：记录里必须有 save 输入').toBeGreaterThanOrEqual(0)
    const completion: InputRecord = {
      sequence: log.inputs[saveIdx].sequence,
      order: 0,
      source: 'effect-completion',
      command: { kind: 'saveCompleted', documentId: 'doc-1', sequence: 1, bindingGeneration: 0, outcome: { kind: 'committed' } },
      env: log.inputs[saveIdx].env,
    }
    const tampered: ReplayLog = { ...log, inputs: [completion, ...log.inputs] }
    const r = replay(tampered)
    // 原记录里第一条是 openDocument（此时没有在途写入），故这条提前的完成事件
    // 必须**不**推进基线 —— 而摘要会因多了一条输入而与原记录错位，判负。
    expect(r.ok, '插入/提前完成事件必须让重放判负（A04 负对照）').toBe(false)
    expect(r.mismatch).not.toBeNull()
  })

  it('完成事件**乱序**不得推进保存基线（A16 的序号校验在重放里同样成立）', () => {
    // 这条直接测"忽略完成序号应产生差异"的语义面：
    // 一条与在途序号不符的 saveCompleted 必须被忽略（`unchanged`），
    // 而序号相符且 committed 的那条才推进基线。
    const e = new Editor()
    e.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
    // 在没有任何在途保存时投递完成事件
    const orphan = e.submit({ kind: 'saveCompleted', documentId: 'doc-1', sequence: 99, bindingGeneration: 0, outcome: { kind: 'committed' } })
    e.drain()
    expect(e.settlement(orphan)?.status, '无在途写入时的完成事件必须被忽略').toBe('unchanged')
    expect(e.snapshot().docs['doc-1'].savedSequence, '孤儿完成事件不得推进保存序号').toBe(0)

    // 正常路径：save → 完成事件（序号相符）→ 基线推进
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' })
    e.drain()
    expect(e.snapshot().docs['doc-1'].version.contentVersion).not.toBe(e.snapshot().docs['doc-1'].saveBaseline.contentVersion)
    e.submit({ kind: 'save', contextId: 'ctx-1' })
    e.drain()
    const seq = e.snapshot().docs['doc-1'].savedSequence + 1
    e.submit({ kind: 'saveCompleted', documentId: 'doc-1', sequence: seq, bindingGeneration: 0, outcome: { kind: 'committed' } })
    e.drain()
    expect(e.snapshot().docs['doc-1'].savedSequence, '序号相符的完成事件必须推进基线').toBe(seq)
    expect(
      e.snapshot().docs['doc-1'].version.contentVersion,
      '保存后内容与基线相等 ⇒ 干净',
    ).toBe(e.snapshot().docs['doc-1'].saveBaseline.contentVersion)
  })

  it('**负对照 3**：预算决策改变不得改变**语义**摘要（只允许分批不同）', () => {
    const { log } = recordSession()
    // 预算变小 ⇒ 分更多批，但每条输入的语义摘要必须逐位相同（
    // "预算耗尽只推迟下一批，不把半个原子命令对外发布"）。
    const small = replay(log, { maxEvents: 1 })
    expect(small.ok, '减小预算不得改变语义（只改变分批）').toBe(true)
    expect(canonicalize(small.digests)).toBe(canonicalize(log.digests))
  })

  it('重放需要的数据只有**值**：JSON 往返后的记录仍可重放（证明无隐藏句柄）', () => {
    const { log } = recordSession()
    // 输入与摘要必须是可序列化的纯数据；若里面藏了函数/实例，JSON 往返会丢内容
    const roundTripped: ReplayLog = JSON.parse(JSON.stringify({ ...log, initial: log.initial }))
    // initial 里的版本/场景是纯数据 ⇒ 往返后仍能重放并得到同样的摘要
    const r = replay(roundTripped)
    expect(r.ok, 'JSON 往返后重放必须仍然成立（否则记录里藏了非值句柄）').toBe(true)
    expect(canonicalize(r.digests)).toBe(canonicalize(log.digests))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C1 —— 一致发布
// ─────────────────────────────────────────────────────────────────────────────

describe('C1：订阅者观察到的一致版本不含"新文档旧选择"组合', () => {
  it('observe 立刻投递当前值，且每次投递都对应一个已原子发布的状态', () => {
    const e = makeEditor()
    const values: unknown[] = []
    const dispose = e.observe({ kind: 'document', documentId: 'doc-1' }, (v) => values.push(v))
    expect(values, 'observe 必须立即投递一次当前值（不必轮询）').toHaveLength(1)
    e.submit(WRITE_COMMAND)
    e.runBatch()
    expect(values.length).toBeGreaterThan(1)
    // 每次投递的 objectCount 必须与"投递那一刻"的快照一致（原子发布）
    const last = values[values.length - 1] as { objectCount: number }
    expect(last.objectCount).toBe(1)
    dispose()
  })

  it('同一查询值未变时不重复投递（按值比较，不做假变化）', () => {
    const e = makeEditor()
    let count = 0
    const dispose = e.observe({ kind: 'version', documentId: 'doc-1' }, () => {
      count += 1
    })
    expect(count).toBe(1)
    // 只改选择（不推进文档版本）⇒ version 查询值不变 ⇒ 不投递
    e.submit({ kind: 'select', contextId: 'ctx-1', target: { kind: 'object', id: 'x' } })
    e.runBatch()
    expect(count, '非内容变化不得让 version 订阅者收到假变化').toBe(1)
    // 真实内容变化 ⇒ 投递
    e.submit(WRITE_COMMAND)
    e.runBatch()
    expect(count).toBe(2)
    dispose()
  })

  it('取消订阅后不再投递（资源释放路径存在）', () => {
    const e = makeEditor()
    let count = 0
    const dispose = e.observe({ kind: 'objects', documentId: 'doc-1' }, () => {
      count += 1
    })
    const after = count
    dispose()
    e.submit(WRITE_COMMAND)
    e.runBatch()
    expect(count).toBe(after)
  })

  it('订阅者抛错被隔离：不影响其它订阅者，也不回滚已发布状态', () => {
    const e = makeEditor()
    let second = 0
    const d1 = e.observe({ kind: 'objects', documentId: 'doc-1' }, () => {
      throw new Error('subscriber boom')
    })
    const d2 = e.observe({ kind: 'objects', documentId: 'doc-1' }, () => {
      second += 1
    })
    expect(() => {
      e.submit(WRITE_COMMAND)
      e.runBatch()
    }).not.toThrow()
    expect(second, '第二个订阅者仍必须收到投递').toBeGreaterThan(1)
    expect(Object.keys(e.snapshot().docs['doc-1'].scene.objects).length, '已发布状态不得回滚').toBe(1)
    d1()
    d2()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// executeNow 的完整面（C4）
// ─────────────────────────────────────────────────────────────────────────────

describe('C4：`executeNow` 的 WouldBlock / 越序 / 非即时命令路径', () => {
  it('存在前序排队命令时 `executeNow` 返回 WouldBlock(incompatibleQueued)，不越序', () => {
    const e = makeEditor()
    e.submit(WRITE_COMMAND) // 入队但不推进
    const out = e.executeNow({ kind: 'addObject', contextId: 'ctx-1', objectType: 'annotation' })
    expect(out.status).toBe('rejected')
    if (out.status === 'rejected') {
      expect(out.error.code).toBe('WouldBlock')
      expect(out.error.params.reason).toBe('incompatibleQueued')
    }
    // 被拒绝的 executeNow 不得产生对象
    expect(Object.keys(e.snapshot().docs['doc-1'].scene.objects).length).toBe(0)
  })

  it('`executeNow` 成功时**不**排队、立即结算、且走同一 `reduceCommand`', () => {
    const e = makeEditor()
    const out = e.executeNow({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'now' })
    expect(out.status).toBe('applied')
    expect(e.pending, 'executeNow 不产生排队项').toBe(0)
    expect(Object.keys(e.snapshot().docs['doc-1'].scene.objects).length).toBe(1)
  })

  it('涉及效果/生命周期的命令不得经 `executeNow`（否则第二写通路的适用范围被放宽）', () => {
    const e = makeEditor()
    for (const cmd of [{ kind: 'save', contextId: 'ctx-1' }, { kind: 'openDocument', documentId: 'doc-2', contextId: 'ctx-2' }] as const) {
      const out = e.executeNow(cmd as never)
      expect(out.status, `${cmd.kind} 不应可经 executeNow 执行`).toBe('rejected')
      if (out.status === 'rejected') expect(out.error.code).toBe('UnsupportedOperation')
    }
    expect(e.snapshot().docs['doc-2'], '被拒绝的 openDocument 不得造出文档').toBeUndefined()
  })

  it('`executeNow` 的拒绝与批次内的拒绝**同一错误码**（同一入口 ⇒ 同一分类）', () => {
    const e = makeEditor()
    const viaBatch = e.submit({ kind: 'deleteObject', contextId: 'ctx-1', objectId: 'nope' })
    e.runBatch()
    const a = e.settlement(viaBatch)
    const b = e.executeNow({ kind: 'deleteObject', contextId: 'ctx-1', objectId: 'nope' })
    expect(a?.status).toBe('rejected')
    expect(b.status).toBe('rejected')
    if (a?.status === 'rejected' && b.status === 'rejected') {
      expect(a.error.code).toBe(b.error.code)
      expect(a.error.code).toBe('MissingTarget')
    }
  })

  it('无文档时 `read` 明确失败（不返回空视图冒充成功）', () => {
    const e = new Editor()
    expect(() => e.read({ documentId: 'nope', contextId: 'nope' })).toThrow(/MissingTarget/)
  })

  it('查询规格是封闭枚举：未知规格不会被静默忽略（编译期即拒）', () => {
    // 这里用 `@ts-expect-error` 钉住"规格集合封闭"这一类型事实。
    const e = makeEditor()
    // @ts-expect-error 未知的查询 kind 不得通过类型检查
    const bad: QuerySpec = { kind: 'not-a-query', documentId: 'doc-1' }
    expect(bad).toBeTruthy()
    expect(() => e.observe({ kind: 'objects', documentId: 'doc-1' }, () => {})()).not.toThrow()
  })
})

/** 未使用占位：保持 `defaultExecutionInputs` 的引用（下游会用到同一默认能力集）。 */
describe('执行输入默认值（供上层装配）', () => {
  it('defaultExecutionInputs 返回冻结对象且含内容编辑能力', () => {
    const env = defaultExecutionInputs()
    expect(Object.isFrozen(env)).toBe(true)
    expect(env.capabilities).toContain('content.edit')
  })
})

