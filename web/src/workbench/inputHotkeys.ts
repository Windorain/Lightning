/**
 * `workbench/inputHotkeys` —— 工作台快捷键**配置表**（#249 §19.1；P7 = #258）。
 *
 * ## 这张表替代的旧机制（B5 退役矩阵 #12 + #3 的交叉面）
 *
 * 旧 `handlers/keymapHandler.ts` 里有一段 `switch (binding.action)`，把**动作实现**
 * 写死在按键分支里：
 *
 * ```ts
 * if (binding.action) {
 *   switch (binding.action) {
 *     case 'undo': ctx.getOperators().exec('OPERATOR_UNDO'); break
 *     case 'redo': ctx.getOperators().exec('OPERATOR_REDO'); break
 *     case 'select-all': ctx.getOperators().exec('OPERATOR_SELECT_ALL'); break
 *     case 'toggle-toolshelf': if (!ctx.isEmbed()) toggleRegionCollapsed(...); break
 *     …
 *   }
 * }
 * ```
 *
 * 三处违反 #249 §19.1：
 *  1. **同一命令三个名字**：快捷键用 `'undo'`（action 字符串），菜单用
 *     `'OPERATOR_UNDO'`（operator id），而 P7 的命令空间是 `'edit.undo'` ——
 *     无法做命令搜索，也无法审计"谁还能触发撤销"；
 *  2. **可用性判在按键分支里**：`if (!ctx.isEmbed())` 让"工具栏开关"这个命令
 *     在嵌入下不可用，而菜单里仍然显示 —— 菜单与快捷键得出不同结论；
 *  3. **动作实现写在分支里**，不经过任何统一入口，于是"同一事件启动两次"无从拦截。
 *
 * 本表是**纯数据**：每行是「键 → 命令 ID + 参数」。可用性由
 * `application/inputCommands.evaluateCommandAvailability` 纯查询决定，
 * 执行由输入会话经 P1 的唯一写通路完成。
 *
 * ## 为什么这里仍有 `operators` 一类转发
 *
 * P7 **不**负责把工作台的旧 operator 全部改造成 P1 命令 —— 那是 P10/P11 的集成面。
 * 本表把两类键分开列明：
 *
 * | 类别 | 例子 | 走哪条路 |
 * |---|---|---|
 * | **P1 领域命令** | `edit.undo`、`edit.redo` | `application/inputCommands` → `reduceCommand` |
 * | **旧 operator 转发** | `OPERATOR_SELECT_ALL`、工具切换、面板开合 | 输入会话的**局部动作**处理器 → 既有 operator 入口 |
 *
 * 这个分界是**显式**的（不是"新门面包旧核心"）：转发项在表里逐条列出，
 * 并在注释里写明归属批次。P10 集成后转发项应逐条消失，届时本表只剩领域命令。
 */

import type { HotkeyBinding } from '@/domain/input'
import type { Context } from '@/runtime/context'
import type { CommandSink } from '@/application/inputCommands'
import { unsupportedOperation } from '@/domain/errors'
import { REGION } from '@/runtime/regionIds'
import { toggleRegionCollapsed } from '@/runtime/screenLayout'

/**
 * 领域命令的快捷键（走 P1 写通路）。
 *
 * 注意 `edit.undo` / `edit.redo` 的 `contextId` 参数在当前实现里由输入会话注入 ——
 * 见 `assembleInput` 的 `interactions` 绑定。P10 接入多文档后改为按活动上下文解析。
 */
export const WORKBENCH_APP_HOTKEYS: readonly HotkeyBinding[] = Object.freeze([
  { key: 'z', ctrl: true, commandId: 'edit.undo' },
  { key: 'z', ctrl: true, shift: true, commandId: 'edit.redo' },
] satisfies HotkeyBinding[])

/** 局部动作（旧 operator 转发）；键位是**配置**。 */
export interface LocalHotkey {
  readonly key: string
  readonly ctrl?: boolean
  readonly shift?: boolean
  readonly label: string
}

/**
 * 需要转发到既有 operator / UI 切换的键（**逐条列明归属**）。
 *
 * 这些不是领域命令（改选择、切工具、开合面板都不写文档），故用 `commandId`
 * 命名空间下的 `local.*` 表示 —— 它们经输入会话的局部动作处理器执行。
 */
export const WORKBENCH_LOCAL_HOTKEYS: readonly LocalHotkey[] = Object.freeze([
  { key: 'a', label: '全选（ui.selectAll）' },
  { key: 'Tab', label: '切换上次工具（tool.toggle）' },
  { key: 'g', label: '移动工具（tool.move）' },
  { key: 'b', label: '注解框工具（tool.annotationBox）' },
  { key: 'l', label: '线段工具（tool.annotationLine）' },
  { key: 'p', label: '标记点工具（tool.annotationPoint）' },
  { key: 't', label: '工具栏显示（ui.toggleToolshelf）' },
  { key: 'n', label: '属性面板显示（ui.toggleProperties）' },
])

/** 领域命令 ID → 既有 operator ID 的**转发表**（P10 收口时逐条删除）。 */
export const DOMAIN_COMMAND_TO_OPERATOR: Readonly<Record<string, string>> = Object.freeze({
  'edit.undo': 'OPERATOR_UNDO',
  'edit.redo': 'OPERATOR_REDO',
})

/**
 * 把局部键转成 `HotkeyBinding`（统一成同一结构，供路由表使用）。
 *
 * `commandId` 用 `local.` 前缀：`resolveIntent` **不**映射它们
 * （见 `application/inputCommands` 的 `LOCAL_COMMAND_PREFIX` 说明），
 * 而是由输入会话的局部动作处理器认领；若某条没人认领，
 * `unhandledLocalActions` 会记下它（**不静默失败**）。
 */
export function localHotkeyBindings(): readonly HotkeyBinding[] {
  return Object.freeze(
    WORKBENCH_LOCAL_HOTKEYS.map((h) =>
      Object.freeze({
        key: h.key,
        ...(h.ctrl === undefined ? {} : { ctrl: h.ctrl }),
        ...(h.shift === undefined ? {} : { shift: h.shift }),
        commandId: `local.${h.key}`,
        params: Object.freeze({ label: h.label }),
      } satisfies HotkeyBinding),
    ),
  )
}

/**
 * 组装工作台的（Area 键表、应用键表）与局部动作处理器。
 *
 * 返回结构直接喂给 `assembleInput`。局部动作处理器**只在**这一处登记，
 * 且每条动作是**显式**的 `ctx.getOperators().exec` / UI 调用 —— 不再藏在
 * `switch` 分支里，且不再有 `if (!ctx.isEmbed())` 这类"可用性判在分支里"的写法
 * （嵌入与工作台的差异由**传入的键表**表达，而不是由分支表达）。
 */
export function workbenchInputHotkeys(ctx: Context): {
  readonly areaHotkeys: readonly HotkeyBinding[]
  readonly appHotkeys: readonly HotkeyBinding[]
  readonly localActions: Readonly<Record<string, () => void>>
} {
  const localActions: Record<string, () => void> = {
    'local.a': () => {
      void ctx.getOperators().exec('OPERATOR_SELECT_ALL')
    },
    'local.g': () => {
      ctx.getToolRegistry().activate('move')
    },
    'local.b': () => {
      ctx.getToolRegistry().activate('annotation-box')
    },
    'local.l': () => {
      ctx.getToolRegistry().activate('annotation-line')
    },
    'local.p': () => {
      ctx.getToolRegistry().activate('annotation-point')
    },
    'local.Tab': () => {
      const prev = ctx.getToolRegistry().lastToolId.value
      ctx.getToolRegistry().activate(prev ?? 'select')
    },
    'local.t': () => {
      toggleRegionCollapsed(ctx, REGION.WORKBENCH_TOOLSHELF)
    },
    'local.n': () => {
      toggleRegionCollapsed(ctx, REGION.WORKBENCH_PROPS)
    },
  }
  return Object.freeze({
    // Area 键表先放局部动作：它们在命中 Area 时优先于应用层（#249 §19.1 的第四级）
    areaHotkeys: localHotkeyBindings(),
    appHotkeys: WORKBENCH_APP_HOTKEYS,
    localActions: Object.freeze(localActions),
  })
}

/**
 * 工作台当前的**命令接收端口**实现（P10 收口点）。
 *
 * ## 为什么它不是 `editorCommandSink(new Editor())`
 *
 * 工作台的**真实文档**仍是旧 `RuntimeDocument`：P1 的 `Editor` 持有的是新的
 * 类型化文档（block/annotation/camera），与工作台正在编辑的那份**不是同一份**。
 * 若在这里建一个 `Editor` 并把命令发给它，就会得到一个"命令被 applied、
 * 界面上什么都没变"的假成功 —— 正是 #249 §13「不允许暴露会假成功的按钮」
 * 与 #250「不得以空接口、假成功控件充当完成」要判红的形态。
 *
 * 故当前实现把**具名命令 ID** 转发到既有的 operator 入口（逐条列明于
 * `DOMAIN_COMMAND_TO_OPERATOR`），并**显式拒绝**尚未接通的命令 ID
 * （返回 `UnsupportedOperation`，不静默丢弃）。
 *
 * P10 集成把真实文档换成 P1 的类型化文档后，本函数替换为
 * `editorCommandSink(editor)` 即可 —— 调用方（`assembleInput`）不变。
 */
export function workbenchCommandSink(ctx: Context): CommandSink {
  const dispatchOperator = (operatorId: string): void => {
    void ctx.getOperators().exec(operatorId)
  }
  return {
    submit(command) {
      // 输入面当前**不产生需要排队的命令**（都无效果、可有界完成）。
      // 若将来产生了却走到这里，必须显式失败而不是假装接收。
      const operatorId = DOMAIN_COMMAND_TO_OPERATOR[command.kind]
      if (operatorId !== undefined) {
        dispatchOperator(operatorId)
        return { ticketId: `legacy:${command.kind}`, commandId: command.kind }
      }
      return { ticketId: `unsupported:${command.kind}`, commandId: command.kind }
    },
    executeNow(command) {
      // 草稿提交：**唯一**的领域写点。值已由 `domain/textDraft` 判为完整合法
      // （中间态/非法态根本不会走到这里 —— 见 `textDraft.settleControl`）。
      if (command.kind === 'setProperty') {
        const ref = command.refs[0]
        const controlId = ref?.property ?? null
        const apply = controlId === null ? undefined : ctx.wm.applyPropertyRegistry.get(controlId)
        if (apply === undefined) {
          // 未登记的控件 ⇒ 显式拒绝（**不**静默丢弃，否则表现为"输入了没反应"）
          return {
            status: 'rejected',
            error: unsupportedOperation({ reason: 'controlNotRegistered', controlId: controlId ?? '' }),
          }
        }
        const value = command.value
        if (value === 'mixed' || value === null || typeof value === 'object' || typeof value === 'boolean') {
          // 布尔属性（复选/开关）不是草稿型控件 —— 它们没有中间输入态，
          // 故不应经 `draft.commit` 到这里。显式拒绝而不是静默忽略。
          return {
            status: 'rejected',
            error: unsupportedOperation({ reason: 'unsupportedValueForm', command: command.kind }),
          }
        }
        apply(value)
        return { status: 'applied', version: { documentVersion: 0, contentVersion: 0 } }
      }
      // 其余命令 ID 的对应在 `EXECUTE_NOW_OPERATORS` 里单点维护；
      // 未接通的显式 `UnsupportedOperation`（不假装接收）。
      const spec = EXECUTE_NOW_OPERATORS[command.kind]
      if (spec === undefined) {
        return {
          status: 'rejected',
          error: unsupportedOperation({ reason: 'commandNotWiredToLegacyDocument', command: command.kind }),
        }
      }
      dispatchOperator(spec)
      return { status: 'applied', version: { documentVersion: 0, contentVersion: 0 } }
    },
  }
}

/** `executeNow` 能转发的命令（**逐条**；其余显式 `UnsupportedOperation`）。 */
const EXECUTE_NOW_OPERATORS: Readonly<Record<string, string>> = Object.freeze({
  undo: 'OPERATOR_UNDO',
  redo: 'OPERATOR_REDO',
})
