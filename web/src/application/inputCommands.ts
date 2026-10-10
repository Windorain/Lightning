/**
 * `application/inputCommands` —— **统一命令入口**：把输入路由产出的命令意图
 * 接到 P1 的唯一写通路 `reduceCommand`（经 `submit` / `executeNow`）
 * —— #249 §19.1「菜单、按钮、快捷键、命令搜索引用**同一命令 ID 和参数描述**」
 * +「输入设备映射、命令可用性与业务执行分离」；P7 = #258。
 *
 * ## 这个模块存在的理由（它替代的旧机制）
 *
 * 旧实现里"同一个动作"有**多份**实现，各自直接落到不同 API：
 *  - 菜单栏（`panels/menuBar.ts`）产出 `OPERATOR_*` 字符串 → `ctx.getOperators().exec(...)`；
 *  - 快捷键（`handlers/keymapHandler.ts`）里一个 `switch (binding.action)` 直接
 *    `ctx.getOperators().exec('OPERATOR_UNDO')`、`toolRegistry.activate(...)`、
 *    `toggleRegionCollapsed(...)` —— **动作的具体实现写死在按键分支里**；
 *  - 按钮（`OperatorBtn.vue`）又走一遍 `invoke`。
 *
 * 后果有三个，都在 #249 里被点名：
 *  1. 「同一命令 ID 和参数描述」不成立：#171 的 `OPERATOR_UNDO`、`undo`（action 字符串）、
 *     菜单的 `OPERATOR_UNDO` 是**三套名字**，无法做命令搜索，也无法审计"谁还能触发它"；
 *  2. 「输入设备映射、命令可用性与业务执行**分离**」不成立：可用性判在按键分支里
 *     （`if (!ctx.isEmbed()) toggleRegionCollapsed(...)`），于是同一命令在菜单里
 *     可用、在快捷键里不可用（或反之）—— 这就是 #258 验收 I2「外壳只翻译事实」的反面；
 *  3. **业务执行**没走 P1 的唯一写通路，于是"两次模态操作"（A22 负对照）无人能拦。
 *
 * ## 本模块的三条边界
 *
 * | 归属 | 内容 | 为什么 |
 * |---|---|---|
 * | **本模块（`application`）** | 命令 ID → P1 `Command` 的**纯映射** + 可用性求值 | 跨域编排属 `application`（#249 §4 规则 2） |
 * | `domain/input` | 该谁收这个键、产出哪个命令 ID | 路由政策是纯规则（#249 §19.1） |
 * | `runtime` | 真正调 `submit`/`executeNow`、执行平台动作 | 接线层（#249 §4 规则 3） |
 *
 * 本模块**不** import Vue/Three/DOM，也**不** import `runtime/*` ——
 * 与执行器的接口是一个**端口**（`CommandSink`），由 `runtime` 侧结构化实现。
 * 这使"输入路由 → 命令"这条链路可在无宿主环境下逐条断言（A04 重放口径）。
 *
 * ## 一次事务边界（#258 验收 I1）
 *
 * 一条意图经 `resolveIntent` 得到**至多一条** `Command`。数字拖动（`pointer.*` →
 * `begin/update/commitInteraction`）与文字输入（`draft.commit` → `setProperty`）
 * **手势不同**，但落到同一条属性命令族；`draft.commit` 的效果里
 * `transaction: 'single'` 就是"只有一次事务边界"的机器可读标记（见 `domain/textDraft`）。
 */

import {
  type Command,
  type ImmediateCommand,
} from './commands'
import type { ExecutionInputs } from './commands'
import { err, invalidValue, ok, unsupportedOperation, type DomainError, type Result } from '@/domain/errors'
import type { PropertyRef } from '@/domain/identity'
import type { DraftCommitTrigger, DraftKind } from '@/domain/textDraft'
import type { CommandIntent, ParamValue } from '@/domain/input'
import type { Vec3 } from '@/domain/scene'

// ─────────────────────────────────────────────────────────────────────────────
// 端口（由 runtime 侧结构化实现；本模块不依赖 runtime）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 命令接收端口 —— P1 `EditorClient` 的**最小子集**（契约 §2）。
 *
 * 为什么用一个端口而不是直接 import `@/runtime/execution`：
 * `application` 依赖 `runtime` 会直接违反 #249 §4 导入规则 2
 * （「`application` 仅依赖领域与自身契约，不依赖 Vue/Three/DOM/**运行实例实现**」），
 * 并被 `npm run test:arch` 的 `gate/no-private-cross-layer` 判红。
 * 端口是**契约**（本层的东西），实现由 runtime 提供 —— 依赖方向仍然单向。
 */
export interface CommandSink {
  /** 异步/长效果入口。**接收 ≠ 已生效**（契约 §1.5）。 */
  submit(command: Command, source?: string): { readonly ticketId: string; readonly commandId: string }
  /** 同步结算面；仅接受无效果、可有界完成的命令（契约 §2.1）。 */
  executeNow(command: ImmediateCommand): CommandOutcomeLike
}

/** 契约 §3.1 的最小投影（避免本层依赖 runtime 的完整类型）。 */
export type CommandOutcomeLike =
  | { readonly status: 'applied'; readonly version: { readonly documentVersion: number; readonly contentVersion?: number } }
  | { readonly status: 'unchanged'; readonly version: { readonly documentVersion: number; readonly contentVersion?: number } }
  | { readonly status: 'rejected'; readonly error: DomainError }

// ─────────────────────────────────────────────────────────────────────────────
// 控件绑定（控件声明的目标；草稿提交的落点）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一个属性控件对**领域属性**的声明（#249 §19.1「完整合法草稿按**控件声明**提交」）。
 *
 * `ref` 是 `PropertyRef`（值，不含 setter）—— 与 P1 的 `setProperty` 命令同源，
 * 因此"数字输入框"与"数字拖动"落到**同一条**属性写命令（#258 I1）。
 * 这里**没有** `set(owner, value)` 回调：那正是 P1 要退役的"控件自带写路径"。
 */
export interface ControlBinding {
  readonly controlId: string
  readonly contextId: string
  readonly ref: PropertyRef
  readonly kind: DraftKind
  readonly commitOn?: DraftCommitTrigger
  readonly min?: number
  readonly max?: number
  readonly required?: boolean
  /** 屏幕阅读/提示用的标签（标签与焦点可见性是组件基本质量，#249 §19.1）。 */
  readonly label: string
}

/** 活动交互的绑定（哪个上下文、目标对象）。 */
export interface InteractionBinding {
  readonly contextId: string
  readonly tool: string
  /** 交互提交时的命令标签（历史条目名）。 */
  readonly commitLabel: string
}

export interface InputCommandBindings {
  readonly controls: Readonly<Record<string, ControlBinding>>
  readonly interaction: Readonly<Record<string, InteractionBinding>>
}

export function createInputCommandBindings(parts: {
  controls?: readonly ControlBinding[]
  interactions?: readonly InteractionBinding[]
} = {}): InputCommandBindings {
  const controls: Record<string, ControlBinding> = {}
  for (const c of parts.controls ?? []) controls[c.controlId] = c
  const interaction: Record<string, InteractionBinding> = {}
  for (const i of parts.interactions ?? []) interaction[i.contextId] = i
  return Object.freeze({ controls: Object.freeze(controls), interaction: Object.freeze(interaction) })
}

// ─────────────────────────────────────────────────────────────────────────────
// 解析意图 → 命令
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 本层处理的命令 ID 全集（**显式列明**，不拦截所有键 —— #249 §19.1）。
 *
 * ## 为什么没有 `local.*`
 *
 * Area 快捷表里的"旧 operator 转发"项（`local.g` 一类，见
 * `workbench/inputHotkeys.ts`）**不**在 `resolveIntent` 里映射成 P1 命令 ——
 * 它们不写文档（切工具、开合面板、全选），映射成 `Command` 会凭空造出
 * 一批"看起来进写通路、实际不做领域事"的假命令，正是 #249 §13
 * 「不允许暴露假成功控件或空接口」要禁止的形态。
 *
 * 它们的归属由 `runtime/inputSession` 的**局部动作处理器**认领；
 * 若某条没人认领，`unhandledLocalActions` 会记下它（**不静默失败**）。
 */
export const INPUT_COMMAND_IDS = Object.freeze([
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
] as const)

export type InputCommandId = (typeof INPUT_COMMAND_IDS)[number]

/** `local.` 前缀：**不经本层映射**，由输入会话的局部动作处理器认领。 */
export const LOCAL_COMMAND_PREFIX = 'local.'

export function isLocalCommandId(commandId: string): boolean {
  return commandId.startsWith(LOCAL_COMMAND_PREFIX)
}

/**
 * 解析结果。
 *
 * `'local'` 是**必须**存在的一类：草稿局部撤销（Ctrl+Z 作用于输入草稿）、
 * 弹窗关闭等**不进入领域写通路**（#249 §19.1「输入框活动编辑期间 Ctrl+Z 默认作用于
 * 输入草稿，不同时触发文档历史」）。若把它们也映射成领域命令，
 * 就会立刻产生 A25 负对照「文本局部撤销误撤文档」。
 */
export type ResolvedIntent =
  | { readonly kind: 'command'; readonly command: Command; readonly queue: boolean; readonly commandId: string }
  | { readonly kind: 'local'; readonly commandId: string; readonly params: Readonly<Record<string, ParamValue>> }
  | { readonly kind: 'none'; readonly commandId: string; readonly reason: string }

function asString(v: ParamValue | undefined): string | null {
  return typeof v === 'string' ? v : null
}

function asNumber(v: ParamValue | undefined): number | null {
  return typeof v === 'number' ? v : null
}

/** 字符串数组参数（交互目标集合）。非数组或缺省 ⇒ 空数组（**不**静默当成单目标）。 */
function asStringList(v: ParamValue | undefined): readonly string[] {
  if (!Array.isArray(v)) return Object.freeze([]) as readonly string[]
  return Object.freeze(v.filter((s): s is string => typeof s === 'string'))
}

/**
 * 属性值形态收窄：`SetPropertyCommand.value` 是 `PropertyValue | 'mixed'`
 * （契约 §5.2），而意图参数可能携带数组（`targets` 一类）。
 * 形态不符 ⇒ `null` ⇒ 调用方**显式拒绝**（不 cast，不夹取）。
 */
function asPropertyValue(v: ParamValue | undefined): number | string | boolean | null {
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v
  return null
}

/** 位移三元组来自参数（`x`/`y`/`z`）；缺失即 `null`（**不**默认 0 —— 默认 0 会静默变成"无位移提交"）。 */
function displacementOf(params: Readonly<Record<string, ParamValue>>): Vec3 | null {
  const x = asNumber(params.x)
  const y = asNumber(params.y)
  const z = asNumber(params.z)
  if (x === null || y === null || z === null) return null
  return Object.freeze({ x, y, z })
}

/**
 * 纯映射：命令意图 → P1 命令（或本层局部动作）。
 *
 * **不改输入**、不读全局、不产生副作用。能力（profile 裁剪）判定**不在这里** ——
 * 契约 §3.2 要求"必须可由**运行时**拒绝，不只靠 UI 隐藏按钮"，
 * 故本函数不复制一份能力表（那会造出第二处政策来源）。
 *
 * 未知 `commandId` 返回 `unsupportedOperation`：**显式拒绝**，不静默忽略
 * （否则"命令搜索里出现一个不存在的命令"会表现为"点了没反应"）。
 */
export function resolveIntent(
  intent: CommandIntent,
  bindings: InputCommandBindings,
  env: Pick<ExecutionInputs, 'capabilities'> = { capabilities: [] },
): Result<ResolvedIntent> {
  void env // 能力判定归 runtime（契约 §3.2），此处只做形态映射。
  const p = intent.params

  switch (intent.commandId) {
    // ── 文档历史（**只在无活动文本控件时会到达** —— 见 `domain/input` 的优先级）──
    case 'edit.undo':
    case 'edit.redo': {
      const contextId = asString(p.contextId)
      if (contextId === null) return err(invalidValue({ reason: 'missingParam', param: 'contextId', commandId: intent.commandId }))
      const command: Command = intent.commandId === 'edit.undo' ? { kind: 'undo', contextId } : { kind: 'redo', contextId }
      return ok({ kind: 'command', command, queue: false, commandId: intent.commandId })
    }

    // ── 交互：开始 ──
    case 'tool.beginInteraction': {
      const contextId = asString(p.contextId)
      if (contextId === null) return err(invalidValue({ reason: 'missingParam', param: 'contextId', commandId: intent.commandId }))
      const binding = bindings.interaction[contextId]
      const tool = asString(p.tool) ?? binding?.tool
      if (tool === undefined) return err(invalidValue({ reason: 'unknownInteraction', contextId, commandId: intent.commandId }))
      const targets = asStringList(p.targets)
      const command: Command = { kind: 'beginInteraction', contextId, tool, targets }
      // 目标集为空 ⇒ 纯转移会 `InvalidValue`（`domain/editing.beginInteraction`）。
      // 此处**不**预先拦下：让政策只有一个来源（命令层），本层只做形态映射。
      return ok({ kind: 'command', command, queue: false, commandId: intent.commandId })
    }

    // ── 交互：推进（**自起点的总位移**，不是增量 —— #249 §8 无漂移）──
    case 'interaction.update': {
      const contextId = asString(p.contextId)
      if (contextId === null) return err(invalidValue({ reason: 'missingParam', param: 'contextId', commandId: intent.commandId }))
      const displacement = displacementOf(p)
      if (displacement === null) return err(invalidValue({ reason: 'missingDisplacement', contextId, commandId: intent.commandId }))
      const command: Command = { kind: 'updateInteraction', contextId, displacement }
      return ok({ kind: 'command', command, queue: false, commandId: intent.commandId })
    }

    // ── 交互：提交（**唯一**事务边界）──
    case 'interaction.commit': {
      const contextId = asString(p.contextId)
      if (contextId === null) return err(invalidValue({ reason: 'missingParam', param: 'contextId', commandId: intent.commandId }))
      const label = asString(p.label) ?? bindings.interaction[contextId]?.commitLabel ?? 'interaction'
      const command: Command = { kind: 'commitInteraction', contextId, label }
      return ok({ kind: 'command', command, queue: false, commandId: intent.commandId })
    }

    // ── 交互：取消（Escape / 捕获丢失政策）──
    case 'interaction.cancel': {
      const contextId = asString(p.contextId)
      if (contextId === null) return err(invalidValue({ reason: 'missingParam', param: 'contextId', commandId: intent.commandId }))
      const command: Command = { kind: 'cancelInteraction', contextId }
      return ok({ kind: 'command', command, queue: false, commandId: intent.commandId })
    }

    // ── 草稿提交：落到**同一条**属性写命令（#258 I1）──
    case 'draft.commit': {
      const controlId = asString(p.controlId)
      if (controlId === null) return err(invalidValue({ reason: 'missingParam', param: 'controlId', commandId: intent.commandId }))
      const binding = bindings.controls[controlId]
      if (!binding) return err(unsupportedOperation({ reason: 'unboundControl', controlId }))
      const raw = p.value
      if (raw === undefined) return err(invalidValue({ reason: 'missingParam', param: 'value', controlId }))
      const value = asPropertyValue(raw)
      if (value === null) {
        return err(invalidValue({ reason: 'unsupportedValueForm', controlId, got: Array.isArray(raw) ? 'array' : typeof raw }))
      }
      // 值形态与控件声明不符 ⇒ 显式拒绝（不夹取、不转换）
      if (binding.kind === 'number' && typeof value !== 'number') {
        return err(invalidValue({ reason: 'controlExpectsNumber', controlId, got: typeof value }))
      }
      if (binding.kind === 'text' && typeof value !== 'string') {
        return err(invalidValue({ reason: 'controlExpectsText', controlId, got: typeof value }))
      }
      if (binding.kind === 'number' && typeof value === 'number') {
        if (binding.min !== undefined && value < binding.min) {
          return err(invalidValue({ reason: 'outOfRange', controlId, min: binding.min, value }))
        }
        if (binding.max !== undefined && value > binding.max) {
          return err(invalidValue({ reason: 'outOfRange', controlId, max: binding.max, value }))
        }
      }
      const command: Command = { kind: 'setProperty', contextId: binding.contextId, refs: Object.freeze([binding.ref]), value }
      return ok({ kind: 'command', command, queue: false, commandId: intent.commandId })
    }

    // ── 草稿局部动作：**不进入领域写通路**（A25 负对照的正面落点）──
    case 'draft.undo':
    case 'draft.redo':
    case 'draft.key': {
      const controlId = asString(p.controlId)
      if (controlId === null) return err(invalidValue({ reason: 'missingParam', param: 'controlId', commandId: intent.commandId }))
      return ok({ kind: 'local', commandId: intent.commandId, params: Object.freeze({ ...p }) })
    }

    // ── 弹窗作用域：局部（焦点范围是自己的，不写文档）──
    case 'modal.close':
    case 'modal.confirm': {
      return ok({ kind: 'local', commandId: intent.commandId, params: Object.freeze({ ...p }) })
    }

    // ── 指针：down/up/cancel **不合并**（#249 §9）──
    case 'pointer.down':
    case 'pointer.up':
    case 'pointer.cancel': {
      const regionId = asString(p.regionId) ?? ''
      return ok({
        kind: 'local',
        commandId: intent.commandId,
        params: Object.freeze({ ...p, regionId }),
      })
    }

    default:
      return err(unsupportedOperation({ reason: 'unknownCommandId', commandId: intent.commandId }))
  }
}

/** 该命令是否必须经 `submit`（有副作用/需要效果）而不是 `executeNow`。 */
export function requiresSubmit(resolved: ResolvedIntent): boolean {
  return resolved.kind === 'command' && resolved.queue
}

// ─────────────────────────────────────────────────────────────────────────────
// 分发（唯一入口 + 一次结算）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 分发账本（**纯值**）。
 *
 * 记录"哪些 (token, commandId) 已经分发过"。存在的理由与 `domain/input` 的
 * `modalStartTokens` 同源但**层次不同**：
 *  - 输入层保证"同一事件只产生一个意图"；
 *  - 本账本保证"同一意图**只执行一次**" —— 即使接线层被调用两次
 *    （例如两条 handler 都拿到了同一个意图），第二次也**不会**再进 `submit`。
 *
 * A22 负对照「两个 handler 各启动操作」在两处都有落点，这是**有意的冗余**：
 * 单靠输入层的去重，接线层写错一次就失效；两处都判，才说得上"唯一归属"。
 */
export interface DispatchLedger {
  readonly dispatched: readonly string[]
}

export const EMPTY_DISPATCH_LEDGER: DispatchLedger = Object.freeze({ dispatched: Object.freeze([]) })

const DISPATCH_LEDGER_LIMIT = 256

function ledgerKey(token: number, commandId: string): string {
  return `${token}\u0000${commandId}`
}

export function alreadyDispatched(ledger: DispatchLedger, token: number, commandId: string): boolean {
  if (token === 0) return false
  return ledger.dispatched.includes(ledgerKey(token, commandId))
}

export function recordDispatch(ledger: DispatchLedger, token: number, commandId: string): DispatchLedger {
  if (token === 0) return ledger
  const key = ledgerKey(token, commandId)
  if (ledger.dispatched.includes(key)) return ledger
  const next = [...ledger.dispatched, key]
  return Object.freeze({
    dispatched: Object.freeze(next.length > DISPATCH_LEDGER_LIMIT ? next.slice(next.length - DISPATCH_LEDGER_LIMIT) : next),
  })
}

/** 一次分发的结果（含**接收 ≠ 已生效**的事实：`ticketId` 只表示已被接纳）。 */
export type DispatchOutcome =
  | { readonly status: 'submitted'; readonly ticketId: string; readonly commandId: string; readonly ledger: DispatchLedger }
  | { readonly status: 'settled'; readonly outcome: CommandOutcomeLike; readonly commandId: string; readonly ledger: DispatchLedger }
  | { readonly status: 'local'; readonly commandId: string; readonly params: Readonly<Record<string, ParamValue>>; readonly ledger: DispatchLedger }
  | { readonly status: 'rejected'; readonly error: DomainError; readonly commandId: string; readonly ledger: DispatchLedger }
  | { readonly status: 'duplicate'; readonly commandId: string; readonly ledger: DispatchLedger }

/**
 * **唯一分发入口**。
 *
 * 顺序：幂等判定 → 意图解析 → 按 `queue` 选 `submit` 或 `executeNow` → 记账。
 *
 * 为什么幂等判定在**最前**：A22 要求"同一事件不启动两次模态操作"。
 * 若先把命令发出去再记账，第二次调用仍会真的启动一次 —— 判据就变成空文。
 *
 * ## 为什么**解析失败也记账**
 *
 * `token` 标识的是**事件**，不是"某次成功解析"。同一事件的第二次分发无论上次
 * 成没成功，都应当被拒 —— 否则"一个每帧重试的 handler"会不断重复解析同一条
 * 非法意图（表现为日志刷屏与重复诊断）。**不同事件**有不同的 token，
 * 因此这一条不会误伤合法的重试。
 */
export function dispatchIntent(
  sink: CommandSink,
  ledger: DispatchLedger,
  token: number,
  intent: CommandIntent,
  bindings: InputCommandBindings,
  env: Pick<ExecutionInputs, 'capabilities'> = { capabilities: [] },
): DispatchOutcome {
  if (alreadyDispatched(ledger, token, intent.commandId)) {
    return { status: 'duplicate', commandId: intent.commandId, ledger }
  }
  const resolved = resolveIntent(intent, bindings, env)
  if (!resolved.ok) {
    return { status: 'rejected', error: resolved.error, commandId: intent.commandId, ledger: recordDispatch(ledger, token, intent.commandId) }
  }
  const r = resolved.value
  const nextLedger = recordDispatch(ledger, token, r.commandId)

  if (r.kind === 'none') {
    return { status: 'rejected', error: unsupportedOperation({ reason: r.reason, commandId: r.commandId }), commandId: r.commandId, ledger: nextLedger }
  }
  if (r.kind === 'local') {
    return { status: 'local', commandId: r.commandId, params: r.params, ledger: nextLedger }
  }
  if (r.queue) {
    const ticket = sink.submit(r.command, 'host-input')
    return { status: 'submitted', ticketId: ticket.ticketId, commandId: r.commandId, ledger: nextLedger }
  }
  const outcome = sink.executeNow(r.command as ImmediateCommand)
  return { status: 'settled', outcome, commandId: r.commandId, ledger: nextLedger }
}

// ─────────────────────────────────────────────────────────────────────────────
// 可用性（输入设备映射 / 可用性 / 业务执行**分离** —— #249 §19.1）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 命令可用性求值（**纯**）。
 *
 * #249 §19.1：「输入设备映射、命令**可用性**与业务执行分离」。
 * 故可用性是一个纯查询：给定（命令 ID + 已注册绑定 + 能力集合）返回可用/不可用及原因。
 * 菜单项、快捷键、命令搜索**共用**它 —— 于是"菜单里能动、快捷键里不能动"这类
 * 不一致无法再出现（这正是 #258 验收 I2 要证的那条）。
 *
 * 注意：**可用性 ≠ 执行时的合法性**。执行仍由 `reduceCommand` 独立判定
 * （契约 §3.2 要求运行时拒绝）。本函数只回答"现在该不该把它呈现为可触发"。
 */
export interface CommandAvailability {
  readonly available: boolean
  readonly reason: string | null
}

export function evaluateCommandAvailability(
  commandId: string,
  bindings: InputCommandBindings,
  env: {
    readonly capabilities: readonly string[]
    readonly contextId?: string
    readonly hasSelection?: boolean
    /** 弹窗是否声明"Enter 即确认"（`ModalScopeState.confirmOnEnter`）。 */
    readonly modalConfirmOnEnter?: boolean
  },
): CommandAvailability {
  switch (commandId) {
    case 'edit.undo':
    case 'edit.redo':
      return env.contextId === undefined ? { available: false, reason: 'noContext' } : { available: true, reason: null }
    case 'tool.beginInteraction':
      if (env.contextId === undefined) return { available: false, reason: 'noContext' }
      if (env.hasSelection !== true) return { available: false, reason: 'noSelection' }
      return bindings.interaction[env.contextId] === undefined
        ? { available: false, reason: 'noInteractionBinding' }
        : { available: true, reason: null }
    case 'draft.commit':
      return env.capabilities.includes('content.edit') ? { available: true, reason: null } : { available: false, reason: 'capabilityMissing:content.edit' }
    case 'modal.confirm':
      // 弹窗确认的可用性来自**弹窗自己的声明**（`ModalScopeState.confirmOnEnter`），
      // 由调用方经显式输入传入 —— 不在这里反查 DOM 上有没有按钮。
      return env.modalConfirmOnEnter === true
        ? { available: true, reason: null }
        : { available: false, reason: 'modalConfirmNotDeclared' }
    default:
      // 局部动作恒可用（它们不写文档）
      return { available: true, reason: null }
  }
}
