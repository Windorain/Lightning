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
 * ## 本表里剩下的"转发"是什么（R1-β① C4 之后的边界）
 *
 * 下面 `workbenchInputHotkeys` 里的局部动作（`local.a` / 工具切换 / 面板开合）
 * **不是**领域命令的一部分 —— 它们不改文档，故**不**存在"转发给谁"的双轨问题：
 * 它们是本表自己的动作实现。C4 删掉的是**领域命令**那一侧的转发
 * （命令 ID → 旧 operator + 票号前缀），因为那才是"同一件事有两条权威"。
 *
 * 判据：`local.*` 不在 `application/inputCommands#resolveIntent` 的映射里
 * （见那里的说明），因此它们**进不了**领域写通路，也不可能被误当命令记账。
 */

import type { HotkeyBinding } from '@/domain/input'
import type { Context } from '@/runtime/context'
import type { Command } from '@/application/commands'
import type { CommandOutcome } from '@/application/contracts'
import type { CommandOutcomeLike, CommandSink } from '@/application/inputCommands'
import { unsupportedOperation } from '@/domain/errors'
import { commitDraftControlValue, versionOf } from '@/editors/workbench-rna'
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

/* R1-β① C4：这里的领域命令 → 旧 operator 转发表已删除（含其票号前缀）。 */

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
 * 走**内核提交路径**的领域命令（`Context#submitContentEditSettlement`：submit →
 * drain → 结算 → `syncLegacyFromKernel` 投影）。
 *
 * ## 为什么是逐条列出的字符串集合，而不是 `Command['kind']` 的穷尽 switch
 *
 * 这张表就是"输入面把哪些命令交给内核"的**可审计清单**（#249 §19.1 要求
 * "谁还能触发什么"可审计）。它必须能被判据逐条读出，故用数据而不是分支。
 *
 * ## 为什么 `setProperty` / `undo` / `redo` **不**在表里
 *
 * | 命令 | 为什么不直接发内核 |
 * |---|---|
 * | `setProperty` | 命令携带的是**面板寻址**（`owner.kind:'document'`、`property:'field:<描述符 id>'`）。按 R1-β① 裁决②，"旧寻址 → 内核 id"的映射只许落在**边界层**；内核核心不认识它 ⇒ 落点是 `editors/workbench-rna#commitDraftControlValue`（再走唯一写路由 `submitPropertyWrite`）。 |
 * | `undo`/`redo` | 撤销权威是内核历史，但入口必须是 `Context#submitKernelUndoRedo` —— 它额外定义了"栈空（`unchanged`）也算内核已生效、**不**回落旧栈"的语义；直接发 `submitContentEditSettlement` 会让"没什么可撤销"看起来像失败。 |
 */
const KERNEL_SETTLEMENT_KINDS: ReadonlySet<string> = new Set([
  'select',
  'setTime',
  'setPlaying',
  'setPlaybackRate',
  'advancePlayback',
  'setChannelValue',
  'setTransform',
  'beginInteraction',
  'updateInteraction',
  'commitInteraction',
  'cancelInteraction',
  'addObject',
  'deleteObject',
  'setCellTooltip',
  'setCellContent',
  'setCellIdentity',
  'moveCells',
  'setDocumentMeta',
  'insertKeyframe',
  'removeKeyframe',
  'setTrackEnabled',
  'publishDefault',
])

/**
 * **有副作用/改变文档集合**的命令（`application/commands#requiresQueue`）：
 * 它们**不属于**输入面（`executeNow` 的适用范围是"无效果、可有界完成"，契约 §2.1）。
 * 它们由宿主入口（打开/保存/关闭文档）驱动，故在输入端口上**显式拒绝**。
 */
const QUEUED_ONLY_KINDS: ReadonlySet<string> = new Set([
  'save',
  'saveCompleted',
  'openDocument',
  'closeDocument',
])

/** 内核结算 → 端口结算（结构同形；`null` = 内核未装配/未采纳内容 ⇒ 具名拒绝）。 */
function toOutcome(outcome: CommandOutcome | null): CommandOutcomeLike {
  if (outcome === null) {
    return {
      status: 'rejected',
      error: unsupportedOperation({ reason: 'noKernelContent', command: 'content-edit' }),
    }
  }
  return outcome
}

/**
 * 工作台当前的**命令接收端口**实现 —— 领域命令交给**内核提交路径**（R1-β① C4）。
 *
 * ## 这个实现替代了什么（本函数的整体转发形态已消失）
 *
 * C4 之前，本函数把具名命令经一张「领域命令 → 旧 operator」**转发表**转发给旧算子，
 * 并返回 `<前缀>:<命令名>` 形态的票号：撤销打到旧栈、`setProperty` 打到
 * `WM.applyPropertyRegistry` 的闭包表、其余命令被拒绝。那张表与票号前缀**已删除**
 * （扫描口径见 `src/workbench/__tests__/inputPortKernelRouting.test.ts`：
 * 本文件内票号前缀 0 命中、全树该转发表标识符 0 命中）。
 *
 * 现在分治为三条，逐条可审计：
 *  1. **领域命令**（{@link KERNEL_SETTLEMENT_KINDS}）⇒ `Context#submitContentEditSettlement`
 *     （内核 submit → drain → 结算 → 投影回 legacy，读面/视口随之可见）；
 *  2. **面板草稿提交**（`setProperty`）⇒ `editors/workbench-rna#commitDraftControlValue`
 *     的**边界映射** ⇒ 唯一写路由；
 *  3. **撤销/重做** ⇒ `Context#submitKernelUndoRedo`（内核撤销为唯一权威）。
 *
 * ## 为什么不是 `editorCommandSink(editor)`
 *
 * `editorCommandSink`（`runtime/inputSession.ts:777`）是**结构等价适配**：
 * 它只把命令交给 `EditorClient`，**不** drain、**不**结算、**不**投影。在测试与
 * 其它外壳里那是对的（调用方自己持有 Editor 并读结算）；但生产工作台的文档权威是
 * `KernelSession`（它**不是** `EditorClient`：`read()` 无 scope、没有 `executeNow`/
 * `observe`），且生产没有帧循环 drain ⇒ 若拿它当生产 sink，命令会停在队列里、
 * legacy 载体不动 —— 那正是本文件旧注释警示的"命令被 applied、界面上什么都没变"的
 * **假成功**。故生产端口走 `Context` 的两条**已结算**入口（C1–C3 建立），
 * `editorCommandSink` 继续服务于 `EditorClient` 外壳。
 *
 * 调用方（`composition/assembleInput`）不变：它只要求一个 `CommandSink`。
 */
export function workbenchCommandSink(ctx: Context): CommandSink {
  return {
    submit(command) {
      // 生产输入面**不产生**排队命令：`application/inputCommands#resolveIntent`
      // 的全部 `kind:'command'` 分支都是 `queue:false`（`queue: true` 全文件 0 命中），
      // 而 `requiresQueue` 只覆盖 save/saveCompleted/openDocument/closeDocument ——
      // 那四条由宿主入口驱动，不经输入面。内核队列在生产**没有** drain 循环
      // （drain 调用点只有 `submitContentEditSettlement`/`submitKernelUndoRedo`/
      // `projectIo`），故在这里返回票号 = "接收了但永不结算"。
      //
      // ⚠️ `CommandSink.submit` 的签名**没有**拒绝通道（只返回票号）。故这里只能
      // 返回具名的 `unsupported:` 票号（非内核票号），并在下方 `executeNow` 的
      // `QUEUED_ONLY_KINDS` 上给出结构化拒绝；这是本端口暴露出的契约缺口之一。
      return { ticketId: `unsupported:${command.kind}`, commandId: command.kind }
    },
    executeNow(command) {
      // 端口签名是 `ImmediateCommand`，但生产分发点（`inputCommands#dispatchIntent`）
      // 把**全部** `queue:false` 的命令都交给本方法，其中 `commitInteraction`
      // **不在** `ImmediateCommand` 联合里（`commands.ts:717` 的说明）⇒ 这里按
      // `Command` 的实收形态处理，再逐个 kind 判定；未列出的一律具名拒绝。
      const cmd = command as Command
      const kind: string = cmd.kind

      // ① 面板草稿提交：映射在边界层做（裁决②），落点是唯一写路由。
      if (cmd.kind === 'setProperty') {
        const refs = cmd.refs
        const ref = refs.length === 1 ? refs[0] : undefined
        if (ref === undefined) {
          return {
            status: 'rejected',
            error: unsupportedOperation({ reason: 'unsupportedPropertyRefShape', command: kind }),
          }
        }
        return toOutcome(commitDraftControlValue(ctx, ref.property, cmd.value))
      }

      // ② 撤销/重做：内核撤销是唯一权威（C2 的入口自带"栈空也算已生效"语义）。
      if (kind === 'undo' || kind === 'redo') {
        if (ctx.submitKernelUndoRedo(kind)) {
          return { status: 'applied', version: versionOf(ctx) }
        }
        return {
          status: 'rejected',
          error: unsupportedOperation({ reason: 'kernelUndoUnavailable', command: kind }),
        }
      }

      // ③ 其余领域命令：内核提交路径（唯一写通路）。
      if (KERNEL_SETTLEMENT_KINDS.has(kind)) {
        return toOutcome(ctx.submitContentEditSettlement(cmd))
      }

      // ④ 有副作用/改变文档集合的命令：输入面**不是**它们的入口。
      if (QUEUED_ONLY_KINDS.has(kind)) {
        return {
          status: 'rejected',
          error: unsupportedOperation({ reason: 'effectfulCommandNotAcceptedByInputPort', command: kind }),
        }
      }

      // ⑤ 未知/未接通：显式拒绝（附命令名），绝不假装接收。
      return {
        status: 'rejected',
        error: unsupportedOperation({ reason: 'commandNotWiredToInputPort', command: kind }),
      }
    },
  }
}
