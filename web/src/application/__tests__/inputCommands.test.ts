/**
 * A25 / I1 / I2 —— **统一命令入口**：菜单/按钮/快捷键/命令搜索引用同一命令 ID
 * （#249 §19.1；#258 验收 I1/I2；P7 = #258）。
 *
 * ## 本节要证的四条
 *
 * 1. **同一 ID**：一条意图经 `resolveIntent` 得到**至多一条** P1 命令；
 *    数字拖动与文字输入手势不同，但复用**同一条** `setProperty` 命令（I1）。
 * 2. **一次事务边界**：`draft.commit` 经这一层落到 `setProperty`，只有一条命令
 *    （I1：不是"输入时每条字符一条命令"）。
 * 3. **分离**：可用性由 `evaluateCommandAvailability` 纯查询决定，
 *    **不**在按键分支里判 —— 于是菜单与快捷键无法得出不同结论（I2 的正面）。
 * 4. **唯一分发 + 幂等**：`dispatchIntent` 对同一 `(token, commandId)` 第二次返回
 *    `duplicate`，**不再触达 sink**（A22 负对照在**命令层**的落点）。
 *
 * ## I2 负对照「Wiki 侧叠第二套领域快捷键政策」
 *
 * 本层的命令表是**显式列明**的（`INPUT_COMMAND_IDS`）。本文件断言：
 * 未列明的命令 ID 一律 `UnsupportedOperation`，**不静默忽略**。
 * 于是"某个外壳再叠一套自己的快捷键分支"会立刻暴露为未知命令，
 * 而不是静默走另一条实现。
 *
 * ## 为什么本文件不需要 `Editor`
 *
 * 用一个**记录型 sink**（记录被调用的命令）即可 —— 本节的判据是"这一层发出了什么命令"，
 * 不是"命令如何转移状态"（后者由 P1 的 `reduceCommand` 测试覆盖）。
 * 这样"输入→命令"这条链路的断言不依赖任何领域语义，失败时定位更清楚。
 */

import { describe, expect, it } from 'vitest'
import {
  alreadyDispatched,
  createInputCommandBindings,
  dispatchIntent,
  EMPTY_DISPATCH_LEDGER,
  evaluateCommandAvailability,
  INPUT_COMMAND_IDS,
  requiresSubmit,
  resolveIntent,
  type CommandSink,
  type ControlBinding,
  type DispatchLedger,
  type InteractionBinding,
} from '@/application/inputCommands'
import { propertyRef, objectRef } from '@/domain/identity'
import type { Command } from '@/application/commands'

// ─────────────────────────────────────────────────────────────────────────────
// 记录型 sink（无领域语义；只记"这一层发出了什么"）
// ─────────────────────────────────────────────────────────────────────────────

interface Recorded {
  readonly submitted: Command[]
  readonly executed: Command[]
}

function recordingSink(): { sink: CommandSink; recorded: Recorded } {
  const recorded = { submitted: [] as Command[], executed: [] as Command[] }
  const sink: CommandSink = {
    submit(command) {
      recorded.submitted.push(command)
      return { ticketId: `t${recorded.submitted.length}`, commandId: `${command.kind}#${recorded.submitted.length}` }
    },
    executeNow(command) {
      recorded.executed.push(command)
      return { status: 'applied', version: { documentVersion: 1, contentVersion: 1 } }
    },
  }
  return { sink, recorded }
}

const NAME_REF = propertyRef(objectRef('obj-1', 7), 'name')
const WIDTH_REF = propertyRef(objectRef('obj-2', 3), 'annotation.text')

const NAME_CONTROL: ControlBinding = { controlId: 'ctl-name', contextId: 'ctx-1', ref: NAME_REF, kind: 'text', label: '名称' }
const WIDTH_CONTROL: ControlBinding = { controlId: 'ctl-width', contextId: 'ctx-1', ref: WIDTH_REF, kind: 'number', min: 1, max: 256, label: '宽度' }
const INTERACTION: InteractionBinding = { contextId: 'ctx-1', tool: 'move', commitLabel: '移动' }

const BINDINGS = createInputCommandBindings({
  controls: [NAME_CONTROL, WIDTH_CONTROL],
  interactions: [INTERACTION],
})

let tokenSeed = 9000
function tok(): number {
  tokenSeed += 1
  return tokenSeed
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 同一命令 ID（#249 §19.1）
// ─────────────────────────────────────────────────────────────────────────────

describe('I2 / 统一命令入口：同一 ID 与参数描述，四种入口共用一条映射', () => {
  it('命令 ID 表是**显式列明**的（∪ 断言：不拦截所有键、也不接受任意 ID）', () => {
    expect([...INPUT_COMMAND_IDS]).toEqual(
      [
        'edit.undo',
        'edit.redo',
        'tool.beginInteraction',
        'interaction.update',
        'interaction.commit',
        'interaction.cancel',
        'draft.commit',
        'draft.undo',
        'draft.redo',
        'draft.key',
        'modal.close',
        'modal.confirm',
        'pointer.down',
        'pointer.up',
        'pointer.cancel',
      ],
    )
  })

  it('未知命令 ID ⇒ `UnsupportedOperation`（**显式拒绝**，不静默忽略）', () => {
    const r = resolveIntent({ commandId: 'wiki.customShortcut', params: {} }, BINDINGS)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error.code).toBe('UnsupportedOperation')
    expect(r.ok === false && r.error.params.reason).toBe('unknownCommandId')
  })

  it('`edit.undo` 与 `edit.redo` 映射到 P1 的 `undo`/`redo` 命令（同一名字，无第二套）', () => {
    const undo = resolveIntent({ commandId: 'edit.undo', params: { contextId: 'ctx-1' } }, BINDINGS)
    const redo = resolveIntent({ commandId: 'edit.redo', params: { contextId: 'ctx-1' } }, BINDINGS)
    expect(undo.ok && undo.value.kind === 'command' && undo.value.command.kind).toBe('undo')
    expect(redo.ok && redo.value.kind === 'command' && redo.value.command.kind).toBe('redo')
  })

  it('缺参数 ⇒ `InvalidValue`（不静默补默认值）', () => {
    const r = resolveIntent({ commandId: 'edit.undo', params: {} }, BINDINGS)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error.code).toBe('InvalidValue')
    expect(r.ok === false && r.error.params.param).toBe('contextId')
  })

  it('`interaction.update` 缺位移 ⇒ 拒绝（**不**默认 0 —— 默认 0 会静默变成"无位移提交"）', () => {
    const r = resolveIntent({ commandId: 'interaction.update', params: { contextId: 'ctx-1' } }, BINDINGS)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error.params.reason).toBe('missingDisplacement')
  })

  it('`interaction.update` 位移取自显式 x/y/z（自起点的总位移语义）', () => {
    const r = resolveIntent({ commandId: 'interaction.update', params: { contextId: 'ctx-1', x: 1, y: -2, z: 3 } }, BINDINGS)
    expect(r.ok).toBe(true)
    const cmd = r.ok && r.value.kind === 'command' ? r.value.command : null
    expect(cmd?.kind).toBe('updateInteraction')
    expect(cmd?.kind === 'updateInteraction' && cmd.displacement).toEqual({ x: 1, y: -2, z: 3 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. I1：数字拖动与文字输入手势不同、复用同一属性命令
// ─────────────────────────────────────────────────────────────────────────────

describe('I1：手势可不同，命令**同一条**；领域提交只有一次事务边界', () => {
  it('文字输入提交 ⇒ `setProperty`（多选原子批次的**单目标**形态）', () => {
    const r = resolveIntent({ commandId: 'draft.commit', params: { controlId: 'ctl-name', value: '新名字' } }, BINDINGS)
    expect(r.ok).toBe(true)
    const cmd = r.ok && r.value.kind === 'command' ? r.value.command : null
    expect(cmd?.kind).toBe('setProperty')
    expect(cmd?.kind === 'setProperty' && cmd.refs).toHaveLength(1)
    expect(cmd?.kind === 'setProperty' && cmd.value).toBe('新名字')
    expect(cmd?.kind === 'setProperty' && cmd.refs[0]).toBe(NAME_REF)
  })

  it('数字输入提交 ⇒ **同样**是 `setProperty`，值已解析为 number（不是字符串）', () => {
    const r = resolveIntent({ commandId: 'draft.commit', params: { controlId: 'ctl-width', value: 64 } }, BINDINGS)
    const cmd = r.ok && r.value.kind === 'command' ? r.value.command : null
    expect(cmd?.kind, '数字与文字落到同一条属性写命令').toBe('setProperty')
    expect(cmd?.kind === 'setProperty' && typeof cmd.value).toBe('number')
  })

  it('值形态与控件声明不符 ⇒ 拒绝（控件声明 number 却给字符串）', () => {
    const r = resolveIntent({ commandId: 'draft.commit', params: { controlId: 'ctl-width', value: '64' } }, BINDINGS)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error.params.reason).toBe('controlExpectsNumber')
  })

  it('越界值在**入口**被拒（第二道防线：纯转移还会独立判一次）', () => {
    const r = resolveIntent({ commandId: 'draft.commit', params: { controlId: 'ctl-width', value: 999 } }, BINDINGS)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error.params.reason).toBe('outOfRange')
  })

  it('未绑定控件 ⇒ `UnsupportedOperation`（不猜目标）', () => {
    const r = resolveIntent({ commandId: 'draft.commit', params: { controlId: 'ctl-ghost', value: 'x' } }, BINDINGS)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error.params.reason).toBe('unboundControl')
  })

  it('一次提交 ⇒ **一条**命令（I1「一次事务边界」：不是每字符一条）', () => {
    const { sink, recorded } = recordingSink()
    const outcome = dispatchIntent(sink, EMPTY_DISPATCH_LEDGER, tok(), { commandId: 'draft.commit', params: { controlId: 'ctl-name', value: 'abc' } }, BINDINGS)
    expect(outcome.status).toBe('settled')
    expect(recorded.submitted, '`setProperty` 走 executeNow（无效果、可有界完成）').toHaveLength(0)
    expect(recorded.executed, '恰一条命令').toHaveLength(1)
    expect(recorded.executed[0]!.kind).toBe('setProperty')
  })

  it('交互提交同样只有一条命令（不是 begin+update+commit 一起发）', () => {
    const { sink, recorded } = recordingSink()
    dispatchIntent(sink, EMPTY_DISPATCH_LEDGER, tok(), { commandId: 'interaction.commit', params: { contextId: 'ctx-1' } }, BINDINGS)
    expect(recorded.executed).toHaveLength(1)
    expect(recorded.executed[0]!.kind).toBe('commitInteraction')
  })

  it('`beginInteraction` 的目标集合经**参数**承载（数组是一个命令的参数，不是命令数组化）', () => {
    const r = resolveIntent(
      { commandId: 'tool.beginInteraction', params: { contextId: 'ctx-1', tool: 'move', targets: ['a', 'b', 'c'] } },
      BINDINGS,
    )
    const cmd = r.ok && r.value.kind === 'command' ? r.value.command : null
    expect(cmd?.kind === 'beginInteraction' && cmd.targets).toEqual(['a', 'b', 'c'])
  })

  it('`requiresSubmit` 只对需要效果/队列的命令为真（本批输入命令全部为 false）', () => {
    for (const commandId of INPUT_COMMAND_IDS) {
      const r = resolveIntent({ commandId, params: { contextId: 'ctx-1', controlId: 'ctl-name', value: 'x', x: 0, y: 0, z: 0 } }, BINDINGS)
      if (!r.ok || r.value.kind !== 'command') continue
      expect(requiresSubmit(r.value), `${commandId} 不应要求排队`).toBe(false)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. 唯一分发 + 幂等（A22 在命令层的落点）
// ─────────────────────────────────────────────────────────────────────────────

describe('A22 负对照「两个 handler 各启动操作」在命令层的落点：同一意图只执行一次', () => {
  it('同一 token 的同一命令第二次 ⇒ `duplicate`，sink **未被再触达**', () => {
    const { sink, recorded } = recordingSink()
    const t = tok()
    const intent = { commandId: 'tool.beginInteraction', params: { contextId: 'ctx-1', tool: 'move', targets: ['obj-1'] } } as const

    const first = dispatchIntent(sink, EMPTY_DISPATCH_LEDGER, t, intent, BINDINGS)
    expect(first.status).toBe('settled')
    expect(recorded.executed).toHaveLength(1)

    const second = dispatchIntent(sink, first.ledger, t, intent, BINDINGS)
    expect(second.status).toBe('duplicate')
    expect(recorded.executed, '第二条 handler 不得再启动一次').toHaveLength(1)
  })

  it('**负对照本体**：不复用账本（每次从空账本开始）⇒ 会执行两次（证明判据不是恒绿）', () => {
    const { sink, recorded } = recordingSink()
    const t = tok()
    const intent = { commandId: 'tool.beginInteraction', params: { contextId: 'ctx-1', tool: 'move', targets: ['obj-1'] } } as const
    dispatchIntent(sink, EMPTY_DISPATCH_LEDGER, t, intent, BINDINGS)
    dispatchIntent(sink, EMPTY_DISPATCH_LEDGER, t, intent, BINDINGS) // 丢掉账本
    expect(recorded.executed, '丢账本 ⇒ 两次都执行 = 负对照判红的形态').toHaveLength(2)
  })

  it('不同 token 的同一命令都执行（去重不得过度）', () => {
    const { sink, recorded } = recordingSink()
    const intent = { commandId: 'edit.undo', params: { contextId: 'ctx-1' } } as const
    const a = dispatchIntent(sink, EMPTY_DISPATCH_LEDGER, tok(), intent, BINDINGS)
    const b = dispatchIntent(sink, a.ledger, tok(), intent, BINDINGS)
    expect(a.status).toBe('settled')
    expect(b.status).toBe('settled')
    expect(recorded.executed).toHaveLength(2)
  })

  it('token=0 表示"不参与幂等"（显式逃生舱，供纯内部推进）', () => {
    const { sink, recorded } = recordingSink()
    const intent = { commandId: 'edit.undo', params: { contextId: 'ctx-1' } } as const
    const a = dispatchIntent(sink, EMPTY_DISPATCH_LEDGER, 0, intent, BINDINGS)
    const b = dispatchIntent(sink, a.ledger, 0, intent, BINDINGS)
    expect(a.status).toBe('settled')
    expect(b.status).toBe('settled')
    expect(recorded.executed).toHaveLength(2)
  })

  it('不同的命令 ID 在同一 token 下互不干扰（幂等键是 (token, commandId)）', () => {
    const { sink, recorded } = recordingSink()
    const t = tok()
    const a = dispatchIntent(sink, EMPTY_DISPATCH_LEDGER, t, { commandId: 'edit.undo', params: { contextId: 'ctx-1' } }, BINDINGS)
    const b = dispatchIntent(sink, a.ledger, t, { commandId: 'edit.redo', params: { contextId: 'ctx-1' } }, BINDINGS)
    expect(a.status).toBe('settled')
    expect(b.status).toBe('settled')
    expect(recorded.executed.map((c) => c.kind)).toEqual(['undo', 'redo'])
  })

  it('账本有界（不无界增长）', () => {
    let ledger: DispatchLedger = EMPTY_DISPATCH_LEDGER
    for (let i = 0; i < 400; i++) {
      const r = dispatchIntent(recordingSink().sink, ledger, 1000 + i, { commandId: 'edit.undo', params: { contextId: 'ctx-1' } }, BINDINGS)
      ledger = r.ledger
    }
    expect(ledger.dispatched.length).toBeLessThanOrEqual(256)
    expect(alreadyDispatched(ledger, 1399, 'edit.undo'), '最近的仍在表里').toBe(true)
    expect(alreadyDispatched(ledger, 1000, 'edit.undo'), '最旧的已被挤出（有界）').toBe(false)
  })

  it('解析失败也记账（避免"失败的命令被反复重试"绕过幂等）', () => {
    const { sink } = recordingSink()
    const t = tok()
    const bad = { commandId: 'edit.undo', params: {} } as const
    const a = dispatchIntent(sink, EMPTY_DISPATCH_LEDGER, t, bad, BINDINGS)
    expect(a.status).toBe('rejected')
    const b = dispatchIntent(sink, a.ledger, t, bad, BINDINGS)
    expect(b.status, '第二次直接判 duplicate，不再重复解析').toBe('duplicate')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. 分离：可用性是纯查询（I2 的正面）
// ─────────────────────────────────────────────────────────────────────────────

describe('I2 正面：可用性由纯查询决定 —— 菜单/快捷键/命令搜索无法得出不同结论', () => {
  it('`edit.undo` 在无上下文时不可用，有上下文时可用（同一函数，两处调用一致）', () => {
    const noCtx = evaluateCommandAvailability('edit.undo', BINDINGS, { capabilities: [] })
    const withCtx = evaluateCommandAvailability('edit.undo', BINDINGS, { capabilities: [], contextId: 'ctx-1' })
    expect(noCtx.available).toBe(false)
    expect(noCtx.reason).toBe('noContext')
    expect(withCtx.available).toBe(true)
  })

  it('`tool.beginInteraction` 需要「有上下文 + 有选择 + 有交互绑定」三者', () => {
    expect(evaluateCommandAvailability('tool.beginInteraction', BINDINGS, { capabilities: [] }).reason).toBe('noContext')
    expect(
      evaluateCommandAvailability('tool.beginInteraction', BINDINGS, { capabilities: [], contextId: 'ctx-1' }).reason,
    ).toBe('noSelection')
    expect(
      evaluateCommandAvailability('tool.beginInteraction', BINDINGS, { capabilities: [], contextId: 'ctx-1', hasSelection: true }).available,
    ).toBe(true)
    // 上下文存在但**没有**交互绑定 ⇒ 不可用且原因明确
    expect(
      evaluateCommandAvailability('tool.beginInteraction', createInputCommandBindings(), { capabilities: [], contextId: 'ctx-1', hasSelection: true }).reason,
    ).toBe('noInteractionBinding')
  })

  it('`draft.commit` 需要 `content.edit` 能力（查看器 profile 下不可用 —— 与运行时拒绝一致）', () => {
    expect(evaluateCommandAvailability('draft.commit', BINDINGS, { capabilities: [] }).reason).toBe('capabilityMissing:content.edit')
    expect(evaluateCommandAvailability('draft.commit', BINDINGS, { capabilities: ['content.edit'] }).available).toBe(true)
  })

  it('`modal.confirm` 的可用性来自弹窗**自己的声明**（不反查 DOM）', () => {
    expect(evaluateCommandAvailability('modal.confirm', BINDINGS, { capabilities: [] }).reason).toBe('modalConfirmNotDeclared')
    expect(evaluateCommandAvailability('modal.confirm', BINDINGS, { capabilities: [], modalConfirmOnEnter: true }).available).toBe(true)
  })

  it('局部动作恒可用（它们不写文档）', () => {
    for (const id of ['draft.undo', 'draft.redo', 'draft.key', 'modal.close', 'pointer.down', 'pointer.up', 'pointer.cancel']) {
      expect(evaluateCommandAvailability(id, BINDINGS, { capabilities: [] }).available, `${id} 应恒可用`).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. 局部动作：不进入领域写通路
// ─────────────────────────────────────────────────────────────────────────────

describe('局部动作不进入领域写通路（A25「文本局部撤销不误撤文档」的命令层落点）', () => {
  it('`draft.undo` / `draft.redo` 解析为 `local`，**不产生**任何 Command', () => {
    for (const id of ['draft.undo', 'draft.redo']) {
      const r = resolveIntent({ commandId: id, params: { controlId: 'ctl-name' } }, BINDINGS)
      expect(r.ok && r.value.kind).toBe('local')
    }
  })

  it('`draft.undo` 经分发只返回 local，sink 一次都没被调用', () => {
    const { sink, recorded } = recordingSink()
    const outcome = dispatchIntent(sink, EMPTY_DISPATCH_LEDGER, tok(), { commandId: 'draft.undo', params: { controlId: 'ctl-name' } }, BINDINGS)
    expect(outcome.status).toBe('local')
    expect(recorded.executed).toHaveLength(0)
    expect(recorded.submitted).toHaveLength(0)
  })

  it('`modal.close` / `pointer.down` 同样是 local（外壳只翻译事实，不写领域）', () => {
    const { sink, recorded } = recordingSink()
    dispatchIntent(sink, EMPTY_DISPATCH_LEDGER, tok(), { commandId: 'modal.close', params: { scopeId: 's' } }, BINDINGS)
    dispatchIntent(sink, EMPTY_DISPATCH_LEDGER, tok(), { commandId: 'pointer.down', params: { regionId: 'r-viewport', button: 0 } }, BINDINGS)
    expect(recorded.executed).toHaveLength(0)
    expect(recorded.submitted).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. 纯性（A02 口径）
// ─────────────────────────────────────────────────────────────────────────────

describe('纯性：`resolveIntent` 不改输入、不读全局', () => {
  it('同一意图重复解析两次逐项一致', () => {
    const intent = { commandId: 'draft.commit', params: { controlId: 'ctl-name', value: 'x' } } as const
    const a = resolveIntent(intent, BINDINGS)
    const b = resolveIntent(intent, BINDINGS)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('输入对象与其参数未被修改（冻结传入即证明）', () => {
    const params = Object.freeze({ controlId: 'ctl-name', value: 'x' })
    const intent = Object.freeze({ commandId: 'draft.commit', params })
    expect(() => resolveIntent(intent, BINDINGS)).not.toThrow()
    expect(Object.keys(params)).toEqual(['controlId', 'value'])
  })
})
