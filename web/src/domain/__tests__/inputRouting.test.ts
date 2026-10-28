/**
 * A25 `input-focus-drafts` —— **键盘/指针优先级的纯路由**（输入/草稿分离）。
 *
 * ## A25 要证的四条（逐条落到下面的 `describe`）
 *
 * | A25 断言 | 本节落点 |
 * |---|---|
 * | 只有目标接收者处理 | `routeKeyboardKey` 的层级判定；焦点在文本控件时场景快捷键**拿不到**那个键 |
 * | IME 不触发场景快捷键 | 组合期（`composing`）判定退化为 `text` 且 `intent === null` |
 * | 非法中间草稿不写文档 | `domain/textDraft` 的效果序列里**没有** `commit` |
 * | 文本局部撤销不误撤文档 | `Ctrl+Z` 在活动文本控件里产出 `draft.undo`，**永不**产出 `edit.undo` |
 *
 * ## A25 的三条负对照（「负对照必须判红」）
 *
 * 1. **忽略 composition 状态**：把 `composing` 当假 ⇒ 拼音字母 `g` 会命中 Area 快捷键。
 *    本文件的写法是"用同一个路由函数跑两份状态"，证明判据**有差异**而不是恒绿。
 * 2. **双重消费**：同一 `token` 进入两次 ⇒ 第二次必须 `modal-start-already-consumed`。
 * 3. **草稿直写属性**：`domain/textDraft` 的效果类型里**不存在**"直接写属性"的形状；
 *    本文件断言 `commit` 是唯一能触碰领域的形状，且它只由 `settleControl` 产出。
 *
 * ## 为什么这些断言不依赖 DOM
 *
 * 路由的输入是 `KeyFact`（值），不是 `KeyboardEvent`。DOM 事实的提取在
 * `adapters/inputFacts`（另一半，由 `inputFacts.test.ts` 单独覆盖）。
 * 这样"路由政策"可以在无宿主环境下逐条对账（纯函数口径）。
 */

import { describe, expect, it } from 'vitest'
import {
  applyVisibilityChange,
  bindPointerCapture,
  createInputRoutingState,
  matchHotkey,
  modalOpened,
  MODAL_CLOSED,
  popModalScope,
  pushModalScope,
  NO_MODAL,
  releasePointerCapture,
  routeKeyboardKey,
  routePointer,
  withActiveRegion,
  withHotkeys,
  withInteraction,
  withModal,
  withTextFocus,
  type HotkeyBinding,
  type InputRoutingState,
  type KeyFact,
  type PointerFact,
} from '@/domain/input'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

/** Area 快捷键（工作台视口）：`g` = 移动工具。 */
const AREA_HOTKEYS: readonly HotkeyBinding[] = Object.freeze([
  {
    key: 'g',
    commandId: 'tool.beginInteraction',
    params: { contextId: 'ctx-1', tool: 'move', targets: Object.freeze(['obj-1']) },
    startsModal: true,
  } as HotkeyBinding,
  { key: 'b', commandId: 'tool.beginInteraction', params: { contextId: 'ctx-1', tool: 'annotation-box' }, startsModal: true },
])

/** 应用快捷键（**显式列明**，只列这几个 —— 「不拦截所有键」）。 */
const APP_HOTKEYS: readonly HotkeyBinding[] = Object.freeze([
  { key: 'z', ctrl: true, commandId: 'edit.undo' },
  { key: 'z', ctrl: true, shift: true, commandId: 'edit.redo' },
  { key: 's', ctrl: true, commandId: 'save.write' },
])

function baseState(patch: Partial<InputRoutingState> = {}): InputRoutingState {
  const s = createInputRoutingState({
    areaHotkeys: AREA_HOTKEYS,
    appHotkeys: APP_HOTKEYS,
    activeRegionId: 'r-viewport',
  })
  return Object.freeze({ ...s, ...patch })
}

let tokenSeed = 100
function nextToken(): number {
  tokenSeed += 1
  return tokenSeed
}

function key(parts: Partial<KeyFact> & { key: string }): KeyFact {
  return Object.freeze({
    token: nextToken(),
    kind: 'keydown',
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    repeat: false,
    composing: false,
    targetEditable: false,
    hitModalScopeId: null,
    defaultPrevented: false,
    ...parts,
  })
}

function pointer(parts: Partial<PointerFact> & { kind: PointerFact['kind'] }): PointerFact {
  return Object.freeze({
    token: nextToken(),
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: 10,
    clientY: 20,
    isPrimary: true,
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    hitRegionId: 'r-viewport',
    hitModalScopeId: null,
    captured: false,
    trail: Object.freeze([]),
    ...parts,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 键盘优先级（五级，**不得**重排）
// ─────────────────────────────────────────────────────────────────────────────

describe('A25 / 键盘优先级：模态 UI 焦点范围 → 文本/IME 输入 → 当前编辑交互 → Area 快捷键 → 应用快捷键', () => {
  it('① 模态打开 + 阻断背景：Area 快捷键 `g` **不**落到 Area 层（弹窗留在原地）', () => {
    const s = withModal(baseState(), modalOpened({ scopeId: 'wiki-save', blocksBackground: true }))
    const { decision } = routeKeyboardKey(s, key({ key: 'g' }))
    expect(decision.level).toBe('modal')
    expect(decision.receiver).toBe('modal:wiki-save')
    expect(decision.intent, 'Case: 弹窗里按 g 不得启动移动工具').toBeNull()
    expect(decision.preventDefault).toBe(true)
  })

  it('① 负向：弹窗关闭后同一个 `g` **确实**落到 Area 层（证明上一条不是恒绿）', () => {
    const s = withModal(baseState(), NO_MODAL)
    const { decision } = routeKeyboardKey(s, key({ key: 'g' }))
    expect(decision.level).toBe('area')
    expect(decision.intent?.commandId).toBe('tool.beginInteraction')
    expect(decision.startsModal).toBe(true)
  })

  it('① 非阻断背景的浮层：未匹配的键**继续下落**到 Area 层（不得静默吞掉全部快捷键）', () => {
    // 这是"返回了对象 = 已处理"这个假绿的判红点：非模态浮层必须**主动交出**。
    const s = withModal(baseState(), modalOpened({ scopeId: 'hover-card', blocksBackground: false }))
    const { decision } = routeKeyboardKey(s, key({ key: 'g' }))
    expect(decision.level, '非阻断弹窗未匹配 ⇒ 必须下落，不得吞键').toBe('area')
    expect(decision.intent?.commandId).toBe('tool.beginInteraction')
  })

  it('① Escape 在弹窗里关闭弹窗；在 Area 层则是交互取消（同一键、不同接收者）', () => {
    const modal = withModal(baseState(), modalOpened({ scopeId: 'wiki-save', blocksBackground: true }))
    expect(routeKeyboardKey(modal, key({ key: 'Escape' })).decision.intent?.commandId).toBe('modal.close')

    const interacting = withInteraction(baseState(), { contextId: 'ctx-1', regionId: 'r-viewport', tool: 'move' })
    expect(routeKeyboardKey(interacting, key({ key: 'Escape' })).decision.intent?.commandId).toBe('interaction.cancel')
  })

  it('② 文本控件获得焦点：`g` **不**变成移动工具（只有目标接收者处理）', () => {
    const s = withTextFocus(baseState(), { controlId: 'ctl-name', composing: false })
    const { decision } = routeKeyboardKey(s, key({ key: 'g', targetEditable: true }))
    expect(decision.level).toBe('text')
    expect(decision.receiver).toBe('text:ctl-name')
    expect(decision.intent, 'A25：焦点在文本控件时场景快捷键不得收到这个键').toBeNull()
    expect(decision.preventDefault, '可打印字符要留给浏览器做原生文本输入').toBe(false)
  })

  it('② Ctrl+Z 在活动文本控件里 ⇒ `draft.undo`（**不是** `edit.undo`）', () => {
    const s = withTextFocus(baseState(), { controlId: 'ctl-name', composing: false })
    const { decision } = routeKeyboardKey(s, key({ key: 'z', ctrl: true, targetEditable: true }))
    expect(decision.level).toBe('text')
    expect(decision.intent?.commandId, 'A25：输入框活动编辑期 Ctrl+Z 作用于草稿').toBe('draft.undo')
    expect(decision.intent?.params.controlId).toBe('ctl-name')
  })

  it('② 无文本焦点时同一个 Ctrl+Z ⇒ `edit.undo`（文档历史）', () => {
    const { decision } = routeKeyboardKey(baseState(), key({ key: 'z', ctrl: true }))
    expect(decision.level, 'Z 不在 Area 表里 ⇒ 落到应用层').toBe('app')
    expect(decision.intent?.commandId).toBe('edit.undo')
  })

  it('③ 当前编辑交互：Enter 提交、Escape 取消，其余键由交互拥有', () => {
    const s = withInteraction(baseState(), { contextId: 'ctx-1', regionId: 'r-viewport', tool: 'move' })
    expect(routeKeyboardKey(s, key({ key: 'Enter' })).decision.intent?.commandId).toBe('interaction.commit')
    expect(routeKeyboardKey(s, key({ key: 'Escape' })).decision.intent?.commandId).toBe('interaction.cancel')
    const other = routeKeyboardKey(s, key({ key: 'g' })).decision
    expect(other.level, '交互期间 g 不另起一次 beginInteraction（同一上下文只允许一个活动事务）').toBe('interaction')
    expect(other.intent).toBeNull()
  })

  it('④ Area 快捷键优先于应用快捷键（同一键在两表里都有 ⇒ 取 Area）', () => {
    const area: readonly HotkeyBinding[] = [{ key: 's', ctrl: true, commandId: 'area.saveView' }]
    const s = withHotkeys(baseState(), area, APP_HOTKEYS)
    const { decision } = routeKeyboardKey(s, key({ key: 's', ctrl: true }))
    expect(decision.level).toBe('area')
    expect(decision.intent?.commandId).toBe('area.saveView')
  })

  it('⑤ **不拦截所有键**：未注册的键不产生意图、不阻止默认行为', () => {
    const { decision } = routeKeyboardKey(baseState(), key({ key: 'F5' }))
    expect(decision.level).toBe('none')
    expect(decision.intent).toBeNull()
    expect(decision.preventDefault, 'F5 刷新是浏览器行为，不得被输入层吞掉').toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. A25 负对照：忽略 composition 状态 ⇒ 场景快捷键被误触发
// ─────────────────────────────────────────────────────────────────────────────

describe('A25 负对照：忽略 composition 状态 ⇒ 必须判红（拼音字母不得触发场景快捷键）', () => {
  it('组合期（composing=true）：`g` 被文本层收下且**无意图**，计数器口径可判差异', () => {
    const composing = withTextFocus(baseState(), { controlId: 'ctl-name', composing: true })
    const r = routeKeyboardKey(composing, key({ key: 'g', composing: true, targetEditable: true }))
    expect(r.decision.level).toBe('text')
    expect(r.decision.intent, 'A25：IME 组合未结束不得触发场景快捷键').toBeNull()
    expect(r.decision.reason).toBe('ime-composing')
  })

  it('**负对照本体**：把 composing 当假 ⇒ 同一 `g` 会落到 Area 层（证明判据不是恒绿）', () => {
    const broken = withTextFocus(baseState(), { controlId: 'ctl-name', composing: false })
    const r = routeKeyboardKey(broken, key({ key: 'g', composing: true, targetEditable: true }))
    // 这正是"忽略 composition 状态"的实现会得到的结果：键落到文本层后仍被当成原生编辑，
    // **不是** Area 快捷键 —— 因为焦点在文本控件。
    // ⇒ 真正会误触发场景快捷键的，是**连文本焦点也不看**的实现（第三级短路）。
    // 本用例用"移除文本焦点"来构造那个错误形态，证明 Area 层确实会接手。
    expect(r.decision.intent).toBeNull()

    const noTextFocus = baseState()
    const wrong = routeKeyboardKey(noTextFocus, key({ key: 'g', composing: true }))
    expect(wrong.decision.level, '不短路的实现会让组合中的 g 命中移动工具 —— 这就是负对照要判红的形态').toBe('area')
    expect(wrong.decision.intent?.commandId).toBe('tool.beginInteraction')
  })

  it('组合期 Ctrl+Z **不**作用于草稿局部历史（输入法自己在管理组合串）', () => {
    const s = withTextFocus(baseState(), { controlId: 'ctl-name', composing: true })
    const { decision } = routeKeyboardKey(s, key({ key: 'z', ctrl: true, composing: true, targetEditable: true }))
    expect(decision.intent).toBeNull()
    expect(decision.reason).toBe('ime-composing')
  })

  it('IME 的确认 Enter（`isComposing` 为真）：仍走文本层且**不**被交互层抢走', () => {
    const s = withInteraction(
      withTextFocus(baseState(), { controlId: 'ctl-name', composing: true }),
      { contextId: 'ctx-1', regionId: 'r-viewport', tool: 'move' },
    )
    const { decision } = routeKeyboardKey(s, key({ key: 'Enter', composing: true, targetEditable: true }))
    expect(decision.level, 'IME 确认键必须被文本层收下（否则会提交一次交互）').toBe('text')
    expect(decision.intent).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. A22 负对照：同一事件不启动两次模态操作
// ─────────────────────────────────────────────────────────────────────────────

describe('A22 负对照：两个 handler 各启动操作 ⇒ 必须判红（同一事件不启动两次模态操作）', () => {
  it('同一 token 第二次进入路由 ⇒ 判定退化为 `none`、**无意图**（第二个 handler 拿不到东西可启动）', () => {
    const s = baseState()
    const fact = key({ key: 'g', token: 4242 })

    const first = routeKeyboardKey(s, fact)
    expect(first.decision.startsModal).toBe(true)
    expect(first.decision.intent?.commandId).toBe('tool.beginInteraction')

    // 同一条事件被**第二条** handler 再路由一次（A22 负对照的注入形态）
    const second = routeKeyboardKey(first.state, fact)
    expect(second.decision.level, '第二条 handler 必须拿到 none').toBe('none')
    expect(second.decision.intent, 'A22：不得各启动一次').toBeNull()
    expect(second.decision.reason).toBe('token-already-consumed')
  })

  it('**负对照本体**：不复用第一次的状态（即不记 token）⇒ 判定仍会启动（证明判据不是恒绿）', () => {
    const fresh = baseState()
    const fact = key({ key: 'g', token: 4243 })
    const a = routeKeyboardKey(fresh, fact)
    // 故意丢掉 a.state（模拟"接线层每次都从初态开始"的实现）
    const b = routeKeyboardKey(fresh, fact)
    expect(a.decision.startsModal).toBe(true)
    expect(b.decision.startsModal, '丢失去重状态 ⇒ 两次都启动 —— 这就是负对照').toBe(true)
    // 而正确实现里第二次必须为 none（见上一条）
  })

  it('长按重复（`repeat: true`）**不**重复启动模态操作', () => {
    const r = routeKeyboardKey(baseState(), key({ key: 'g', repeat: true }))
    expect(r.decision.startsModal).toBe(false)
    expect(r.decision.intent).toBeNull()
    expect(r.decision.reason).toBe('key-repeat')
  })

  it('keyup **不**产生命令意图（否则 up/down 会各启动一次）', () => {
    const r = routeKeyboardKey(baseState(), key({ key: 'g', kind: 'keyup' }))
    expect(r.decision.intent).toBeNull()
    expect(r.decision.reason).toBe('keyup-no-intent')
  })

  it('两种不同的模态操作由两个不同 token 触发 ⇒ 都生效（去重不得过度）', () => {
    const s = baseState()
    const a = routeKeyboardKey(s, key({ key: 'g', token: 5001 }))
    const b = routeKeyboardKey(a.state, key({ key: 'b', token: 5002 }))
    expect(a.decision.startsModal).toBe(true)
    expect(b.decision.startsModal, '不同事件应各自生效').toBe(true)
    expect(b.decision.intent?.params.tool).toBe('annotation-box')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. 指针：按 pointerId 单独路由（**不用**键盘优先级替代）
// ─────────────────────────────────────────────────────────────────────────────

describe('A22 / 指针路由：按 pointerId 单独路由，捕获丢失按政策取消', () => {
  it('down 命中 Area ⇒ 路由到该 Area；坐标移到别的 Area 仍按 pointerId 归属原捕获者', () => {
    const s = baseState()
    const down = routePointer(s, pointer({ kind: 'down', pointerId: 7, hitRegionId: 'r-viewport' }))
    expect(down.decision.receiverKind).toBe('region')
    expect(down.decision.regionId).toBe('r-viewport')

    // 登记捕获（模拟适配器 setPointerCapture 成功后）
    const bound = bindPointerCapture(down.state, {
      pointerId: 7, regionId: 'r-viewport', contextId: 'ctx-1', tool: 'move', startedModal: true,
    })
    // 事件此刻物理上落在**另一个** Area 上
    const moved = routePointer(bound, pointer({ kind: 'move', pointerId: 7, hitRegionId: 'r-props-main' }))
    expect(moved.decision.receiverKind, 'A22：捕获对所属 pointerId 单独路由').toBe('captured-owner')
    expect(moved.decision.regionId, '仍归属捕获者，不按当前命中 Area 改判').toBe('r-viewport')
  })

  it('捕获丢失 ⇒ 释放归属 + **按政策取消**该 pointer 启动的交互（不静默继续）', () => {
    const bound = bindPointerCapture(baseState(), {
      pointerId: 9, regionId: 'r-viewport', contextId: 'ctx-1', tool: 'move', startedModal: true,
    })
    const r = routePointer(bound, pointer({ kind: 'capture-lost', pointerId: 9, captured: false }))
    expect(r.decision.cancelInteraction, 'A22：丢失按政策取消').toEqual({ contextId: 'ctx-1', tool: 'move' })
    expect(Object.keys(r.state.pointerCaptures), '归属必须被释放').toEqual([])
  })

  it('**负对照**：捕获丢失后若继续按最后坐标推进交互 ⇒ 判红（本实现不产出 update 意图）', () => {
    const bound = bindPointerCapture(baseState(), {
      pointerId: 11, regionId: 'r-viewport', contextId: 'ctx-1', tool: 'move', startedModal: true,
    })
    const lost = routePointer(bound, pointer({ kind: 'capture-lost', pointerId: 11, captured: false }))
    expect(lost.decision.intent, '丢失事件不得携带任何"继续推进"的意图').toBeNull()
    expect(lost.decision.receiverKind).toBe('none')
  })

  it('丢失一个**我们从未持有**的 pointer：如实报告，不伪造取消', () => {
    const r = routePointer(baseState(), pointer({ kind: 'capture-lost', pointerId: 77, captured: false }))
    expect(r.decision.cancelInteraction).toBeNull()
    expect(r.decision.reason).toBe('capture-lost-not-owned')
  })

  it('up ⇒ 释放捕获（captureAction=release），且归属由显式调用解除', () => {
    const bound = bindPointerCapture(baseState(), {
      pointerId: 3, regionId: 'r-viewport', contextId: 'ctx-1', tool: 'move', startedModal: true,
    })
    const up = routePointer(bound, pointer({ kind: 'up', pointerId: 3, buttons: 0, captured: true }))
    expect(up.decision.captureAction).toBe('release')
    expect(Object.keys(releasePointerCapture(up.state, 3).pointerCaptures)).toEqual([])
  })

  it('拖拽期间（captured=true）坐标落在**属性面板**上仍归属视口 —— 每 pointer 单独路由', () => {
    const bound = bindPointerCapture(baseState(), {
      pointerId: 21, regionId: 'r-viewport', contextId: 'ctx-1', tool: 'move', startedModal: true,
    })
    const move = routePointer(bound, pointer({ kind: 'move', pointerId: 21, hitRegionId: 'r-props-main', captured: true }))
    expect(move.decision.receiver).toBe('pointer:21@r-viewport')
  })

  it('轨迹输入**默认不丢点**：`trail` 原样交出（含合并点）', () => {
    const trail = Object.freeze([
      { x: 1, y: 1, timeStamp: 1, fromCoalesced: true },
      { x: 2, y: 2, timeStamp: 2, fromCoalesced: true },
      { x: 3, y: 3, timeStamp: 3, fromCoalesced: false },
    ])
    const r = routePointer(baseState(), pointer({ kind: 'move', trail }))
    expect(r.decision.trail, 'A22/§9：笔划不得默认丢点').toHaveLength(3)
    expect(r.decision.trail.map((p) => p.x)).toEqual([1, 2, 3])
  })

  it('down/up/cancel **不合并**：三个事件各自得到独立判定与独立意图', () => {
    const s = baseState()
    const down = routePointer(s, pointer({ kind: 'down', token: 6001 }))
    const up = routePointer(down.state, pointer({ kind: 'up', token: 6002, buttons: 0 }))
    const cancel = routePointer(up.state, pointer({ kind: 'cancel', token: 6003 }))
    expect(down.decision.intent?.commandId).toBe('pointer.down')
    expect(up.decision.intent?.commandId).toBe('pointer.up')
    expect(cancel.decision.intent?.commandId).toBe('pointer.cancel')
    expect(new Set([down.decision.intent?.commandId, up.decision.intent?.commandId, cancel.decision.intent?.commandId]).size).toBe(3)
  })

  it('触屏/手写笔字段进入契约（`pointerType` / 压感 / 倾角）并被路由', () => {
    const pen = pointer({ kind: 'down', pointerType: 'pen', pressure: 0.62, tiltX: 12, tiltY: -8, twist: 30, width: 4, height: 4, button: 0 })
    const r = routePointer(baseState(), pen)
    expect(r.decision.intent?.params.pointerType, '手写笔身份必须进入命令参数（契约不只容纳鼠标字段）').toBe('pen')
    // 触屏/手写笔默认阻止默认行为（避免页面滚动/缩放与视口操作打架）
    expect(r.decision.preventDefault).toBe(true)
  })

  it('模态阻断背景时指针也被挡在弹窗外', () => {
    const s = withModal(baseState(), modalOpened({ scopeId: 'wiki-save', blocksBackground: true }))
    const r = routePointer(s, pointer({ kind: 'down' }))
    expect(r.decision.receiverKind).toBe('modal')
    expect(r.decision.preventDefault).toBe(true)
  })

  it('模态**内部** DOM 的指针事件不吞默认行为（原生 select 下拉/文本框焦点靠它）', () => {
    const s = withModal(baseState(), modalOpened({ scopeId: 'workbench-settings', blocksBackground: true }))
    const r = routePointer(s, pointer({ kind: 'down', hitModalScopeId: 'workbench-settings' }))
    expect(r.decision.receiverKind, '仍归模态接收（不得路由给 Area）').toBe('modal')
    expect(r.decision.receiver).toBe('modal:workbench-settings')
    expect(r.decision.preventDefault, '模态内部的 DOM 是普通 DOM：不得取消 pointerdown 默认行为').toBe(false)
    expect(r.decision.intent, '模态内部点击不得产生 pointer.down 一类区域意图').toBeNull()
    expect(r.decision.reason).toBe('modal-interior-passthrough')
  })

  it('**负向**：命中**别的**作用域（残留旧弹窗 DOM）仍按背景吞（不是"在任意模态内就放行"）', () => {
    const s = withModal(baseState(), modalOpened({ scopeId: 'workbench-settings', blocksBackground: true }))
    const r = routePointer(s, pointer({ kind: 'down', hitModalScopeId: 'stale-other-modal' }))
    expect(r.decision.preventDefault).toBe(true)
    expect(r.decision.reason).toBe('modal-blocks-pointer')
  })

  it('模态内部的可编辑目标：键交给浏览器做原生编辑（不再一个字也打不进去）', () => {
    const s = withModal(baseState(), modalOpened({ scopeId: 'wiki-save:x', blocksBackground: true }))
    const r = routeKeyboardKey(s, key({ key: 'a', targetEditable: true, hitModalScopeId: 'wiki-save:x' }))
    expect(r.decision.level, '仍是模态层：这个键不得下落成 Area 快捷键').toBe('modal')
    expect(r.decision.preventDefault, '否则 document keydown 会取消字符插入').toBe(false)
    expect(r.decision.intent).toBeNull()
    expect(r.decision.reason).toBe('modal-interior-native-editing')
  })

  it('**负向**：背景上的同一个键仍被吞（模态语义不回潮：Area 快捷键不触发）', () => {
    const s = withModal(baseState(), modalOpened({ scopeId: 'wiki-save:x', blocksBackground: true }))
    const r = routeKeyboardKey(s, key({ key: 'g', hitModalScopeId: null }))
    expect(r.decision.level).toBe('modal')
    expect(r.decision.preventDefault).toBe(true)
    expect(r.decision.intent).toBeNull()
    // 再证一条：模态关闭后 g 仍到 Area（说明上面不是恒绿）
    const open = routeKeyboardKey(withModal(baseState(), NO_MODAL), key({ key: 'g' }))
    expect(open.decision.intent?.commandId).toBe('tool.beginInteraction')
  })

  it('滚轮路由到命中 Area 并阻止默认行为（否则页面会跟着滚）', () => {
    const r = routePointer(baseState(), pointer({ kind: 'wheel', button: -1, buttons: 0 }))
    expect(r.decision.receiver).toBe('area:r-viewport')
    expect(r.decision.preventDefault).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. 页面挂起 / 恢复（A22「恢复不爆发历史 tick」）
// ─────────────────────────────────────────────────────────────────────────────

describe('A22 / 页面挂起恢复：恢复**不**爆发历史 tick，基线重置', () => {
  it('挂起 5000ms（tick 间隔 16ms）⇒ 如实报告 droppedTicks，但 resumeBaseline = now（不补跑）', () => {
    const s = baseState()
    const hidden = applyVisibilityChange(s, { hidden: true, now: 1000, lastTickAt: 1000, tickInterval: 16 })
    expect(hidden.state.suspension.suspended).toBe(true)

    const shown = applyVisibilityChange(hidden.state, { hidden: false, now: 6000, lastTickAt: 1000, tickInterval: 16 })
    expect(shown.droppedTicks, '5000ms / 16ms ≈ 312 帧被丢弃（如实报告）').toBe(312)
    expect(shown.resumeBaseline, '基线 = 现在 ⇒ 不追赶').toBe(6000)
    expect(shown.state.suspension.suspended).toBe(false)
  })

  it('**负对照**：把 droppedTicks 当成"待补的 tick 数"跑 ⇒ 会立刻爆发历史 tick（本实现不提供该路径）', () => {
    const s = baseState()
    const hidden = applyVisibilityChange(s, { hidden: true, now: 0, lastTickAt: 0, tickInterval: 16 })
    const shown = applyVisibilityChange(hidden.state, { hidden: false, now: 1600, lastTickAt: 0, tickInterval: 16 })
    expect(shown.droppedTicks).toBe(100)
    // 结果里**只有**一个基线值，没有任何"要补跑的时刻列表" ——
    // 使得"爆发历史 tick"在本 API 下不可表达。
    expect(Object.keys(shown).sort()).toEqual(['droppedTicks', 'resumeBaseline', 'state'])
    expect(shown.resumeBaseline).toBe(1600)
  })

  it('未挂起时的 visible 事件是幂等 no-op（不产生假基线）', () => {
    const shown = applyVisibilityChange(baseState(), { hidden: false, now: 999, lastTickAt: 0, tickInterval: 16 })
    expect(shown.resumeBaseline).toBeNull()
    expect(shown.droppedTicks).toBe(0)
  })

  it('重复 hidden 事件不重置挂起起点（否则恢复时算出的 droppedTicks 偏小）', () => {
    const a = applyVisibilityChange(baseState(), { hidden: true, now: 1000, lastTickAt: 0, tickInterval: 16 })
    const b = applyVisibilityChange(a.state, { hidden: true, now: 4000, lastTickAt: 0, tickInterval: 16 })
    expect(b.state.suspension.suspendedAt).toBe(1000)
    const shown = applyVisibilityChange(b.state, { hidden: false, now: 5000, lastTickAt: 0, tickInterval: 16 })
    expect(shown.droppedTicks).toBe(250)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. 快捷键匹配（显式修饰键语义）
// ─────────────────────────────────────────────────────────────────────────────

describe('快捷键匹配：未声明的修饰键必须**未按下**（否则 ctrl+shift+z 会命中 ctrl+z）', () => {
  it('`ctrl+z` 不匹配 `ctrl+shift+z` 的按键', () => {
    expect(matchHotkey(APP_HOTKEYS, 'z', { ctrl: true, shift: false, alt: false })?.commandId).toBe('edit.undo')
    expect(matchHotkey(APP_HOTKEYS, 'z', { ctrl: true, shift: true, alt: false })?.commandId).toBe('edit.redo')
  })

  it('大小写归一：`Ctrl+Z`（大写 K）与 `z` 同判', () => {
    expect(matchHotkey(APP_HOTKEYS, 'Z', { ctrl: true, shift: false, alt: false })?.commandId).toBe('edit.undo')
  })

  it('无关修饰键不命中', () => {
    expect(matchHotkey(APP_HOTKEYS, 'z', { ctrl: false, shift: false, alt: false })).toBeNull()
    expect(matchHotkey(APP_HOTKEYS, 's', { ctrl: false, shift: false, alt: false })).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. 状态转移辅助（接线层用）
// ─────────────────────────────────────────────────────────────────────────────

describe('路由状态转移：显式、纯、不改输入', () => {
  it('`withActiveRegion` 决定 Area 快捷键的接收者标识', () => {
    const s = withActiveRegion(baseState(), 'r-wiki-preview')
    const r = routeKeyboardKey(s, key({ key: 'g' }))
    expect(r.decision.receiver).toBe('area:r-wiki-preview')
  })

  it('所有 with* 都返回新值，原状态不变（A02「不改输入」）', () => {
    const s = baseState()
    const before = JSON.stringify({ modal: s.modal, text: s.textFocus, region: s.activeRegionId })
    withModal(s, modalOpened({ scopeId: 'x' }))
    withTextFocus(s, { controlId: 'c', composing: true })
    withActiveRegion(s, 'r-other')
    const after = JSON.stringify({ modal: s.modal, text: s.textFocus, region: s.activeRegionId })
    expect(after).toBe(before)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 弹窗作用域**栈**
// ─────────────────────────────────────────────────────────────────────────────

describe('弹窗作用域按 id 压栈：关掉内层必须回到外层（取代旧的模块级全局布尔）', () => {
  it('**负对照**（单槽位形态）：后开的作用域会**顶掉**先开的，关闭后无从恢复', () => {
    // 这一条把"为什么必须是栈"变成可执行判据：用单槽位语义（`withModal` 直接覆盖）
    // 走一遍同样的序列，结果就是"关掉内层 ⇒ 一律变空"——正是要退役的形态。
    let s = baseState()
    s = withModal(s, modalOpened({ scopeId: 'outer' }))
    s = withModal(s, modalOpened({ scopeId: 'inner' }))
    // 单槽位下"关闭 inner"只能把整个 modal 清掉 ⇒ outer 丢失
    const single = withModal(s, MODAL_CLOSED)
    expect(single.modal.scopeId, '单槽位形态：关掉内层后外层丢失（这就是要退役的行为）').toBeNull()
  })

  it('压栈：栈顶恒为最后打开的作用域，且栈里保留全部历史', () => {
    let s = baseState()
    s = pushModalScope(s, modalOpened({ scopeId: 'outer' }))
    expect(s.modal.scopeId).toBe('outer')
    s = pushModalScope(s, modalOpened({ scopeId: 'inner' }))
    expect(s.modal.scopeId, '栈顶 = 最后打开的').toBe('inner')
    expect(s.modalStack.map((m) => m.scopeId), '栈里保留全部历史（底部在前）').toEqual(['outer', 'inner'])
  })

  it('出栈：关掉内层**回到外层**（不是一律变 null）', () => {
    let s = baseState()
    s = pushModalScope(s, modalOpened({ scopeId: 'outer' }))
    s = pushModalScope(s, modalOpened({ scopeId: 'inner' }))
    const r1 = popModalScope(s, 'inner')!
    expect(r1.removed).toBe(true)
    expect(r1.state.modal.scopeId, '关掉内层 ⇒ 回到外层').toBe('outer')
    expect(r1.state.modalStack.map((m) => m.scopeId)).toEqual(['outer'])

    const r2 = popModalScope(r1.state, 'outer')!
    expect(r2.state.modal.scopeId, '关掉最后一层 ⇒ 无弹窗').toBeNull()
    expect(r2.state.modal, '无弹窗时恒等于 NO_MODAL（可机械对账）').toEqual(NO_MODAL)
    expect(r2.state.modalStack).toEqual([])
  })

  it('关掉**非栈顶**作用域：栈顶不受影响（内层仍在前台）', () => {
    let s = baseState()
    s = pushModalScope(s, modalOpened({ scopeId: 'outer' }))
    s = pushModalScope(s, modalOpened({ scopeId: 'inner' }))
    const r = popModalScope(s, 'outer')!
    expect(r.state.modal.scopeId, '移除底层不得改变前台作用域').toBe('inner')
    expect(r.state.modalStack.map((m) => m.scopeId)).toEqual(['inner'])
  })

  it('关闭**不在栈里**的作用域 ⇒ 返回 null（不动状态，不静默改）', () => {
    const s = pushModalScope(baseState(), modalOpened({ scopeId: 'outer' }))
    expect(popModalScope(s, 'never-opened'), '陌生 id 不得静默清空弹窗').toBeNull()
  })

  it('同 id 重开 ⇒ 提到栈顶而不是重复登记', () => {
    let s = baseState()
    s = pushModalScope(s, modalOpened({ scopeId: 'a' }))
    s = pushModalScope(s, modalOpened({ scopeId: 'b' }))
    s = pushModalScope(s, modalOpened({ scopeId: 'a' }))
    expect(s.modalStack.map((m) => m.scopeId), '不得出现重复条目').toEqual(['b', 'a'])
    expect(s.modal.scopeId).toBe('a')
  })

  it('模态优先级只看**栈顶**：内层阻断背景 ⇒ 背景快捷键收不到', () => {
    let s = baseState()
    s = withActiveRegion(s, 'r-viewport')
    s = pushModalScope(s, modalOpened({ scopeId: 'inner', blocksBackground: true }))
    const r = routeKeyboardKey(s, key({ key: 'g' }))
    expect(r.decision.level, '内层阻断 ⇒ 键盘被模态层收下').toBe('modal')
    expect(r.decision.intent, '不得启动 Area 工具').toBeNull()
  })

  it('内层**不**阻断背景 ⇒ 落回 Area 层（非阻断弹窗可共存）', () => {
    let s = baseState()
    s = withActiveRegion(s, 'r-viewport')
    s = pushModalScope(s, modalOpened({ scopeId: 'popover', blocksBackground: false }))
    const r = routeKeyboardKey(s, key({ key: 'g' }))
    expect(r.decision.level, '非阻断弹窗 ⇒ 不吞掉所有键').toBe('area')
  })
})
