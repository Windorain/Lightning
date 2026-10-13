import type { OperatorType } from '@/operators/operatorType'
import type { WorkbenchWorkspaceMode } from '@/runtime/types'
import type { BlockRef } from '@/context/selection'
import { REGION } from '@/runtime/regionIds'
import { setRegionHoverAnnotation, setRegionHoverBlock } from '@/runtime/hover'
function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!
    if (!cur[key] || typeof cur[key] !== 'object') cur[key] = {}
    cur = cur[key] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]!] = value
}

// ──────────────────────────── 帧切换（P10 #261：改走内核命令） ────────────────────────────
//
// ## 本组 operator 的退役改造（B5 #8 `frame-sequence-as-animation`；R-WK-03 明列）
//
// 旧实现**直接写** `Main` 上的两个 Vue Ref：
//
// ```ts
// exec(ctx, _props) { ctx.main.currentFrameIndex.value = … }          // 独立权威
// exec(ctx)         { ctx.main.framesPlaybackIsPlaying.value = !… }   // 驱动 setTimeout 自续链
// ```
//
// 那是 #249 §2.1 禁止的"旁路写入"：写的是权威本身，且**绕过**唯一写通路
// （`reduceCommand`），于是 A03「所有权威变化只在更新阶段」与
// A04「相同输入可重放」都不成立（重放日志里不会有这次写入）。
//
// 现在它们提交**命令**：帧下标由 `EditContext.time` 派生（`seekFrame` 定位时间），
// 播放开关归 `EditContext.playing`（`setPlaying`）。于是：
//  - operator 只是"命令的 UI 入口"，不再持有权威；
//  - 两个 Area 读同一份时间/播放（A05）；
//  - 重放日志里能看到这些变化。

export const SetFrameIndexOperator: OperatorType = {
  id: 'OPERATOR_SET_FRAME_INDEX',
  label: '设置帧索引',
  description: '在多帧场景中切换当前帧',

  poll(ctx) {
    return ctx.hasLoadedDocument()
  },

  exec(ctx, _props) {
    const index = _props.index as number
    const i = Math.floor(index)
    // 经内核会话定位时间（帧下标随之派生）。非法值夹到 0，与旧行为一致。
    ctx.requireKernelSession().seekFrame(Number.isFinite(i) && i >= 0 ? i : 0)
  },
}

export const ToggleFramePlaybackOperator: OperatorType = {
  id: 'OPERATOR_TOGGLE_FRAME_PLAYBACK',
  label: '切换帧播放',
  poll(ctx) {
    // #301 P10f C′1（N1+N6）：存在性走 GF-15，帧数走**帧声明的唯一读取面**
    // （`ctx.frameDeclarations()` 按 GF-16 分流：装配成功 ⇒ 内核，否则 ⇒ legacy）。
    //
    // 原写法 `const doc = ctx.getDoc().value; return doc !== null && doc.frameCount > 1`
    // 有两处不同义风险：① 直读 legacy 帧数（装配成功后内核才是权威 —— 与 D8 同族）；
    // ② `doc.frameCount` 与帧循环读到的内核帧轴可能不一致（D8 正是"两个读数"的形态）。
    return ctx.hasLoadedDocument() && ctx.frameDeclarations().count > 1
  },
  exec(ctx) {
    // 播放状态归 `EditContext`（R-WK-03）⇒ 读当前值再翻转，经命令写回。
    const kernel = ctx.requireKernelSession()
    kernel.setPlaying(!kernel.playback().playing)
  },
}

export const SetFramePlaybackOperator: OperatorType = {
  id: 'OPERATOR_SET_FRAME_PLAYBACK',
  label: '设置帧播放',
  poll(ctx) {
    // 同上（`ToggleFramePlaybackOperator` 的姊妹算子，判据必须一致 —— 否则两个
    // 菜单项的可用性会在同一状态下给出不同答案，那本身就是一处不一致）。
    return ctx.hasLoadedDocument() && ctx.frameDeclarations().count > 1
  },
  exec(ctx, props) {
    ctx.requireKernelSession().setPlaying(Boolean(props.playing))
  },
}

export const SetFramePlaybackRateOperator: OperatorType = {
  id: 'OPERATOR_SET_FRAME_PLAYBACK_RATE',
  label: '设置帧播放倍率',
  description: '设置常量播放倍率（1 = 原速；0 = 暂停推进但保留播放状态）',
  poll(ctx) {
    return ctx.hasLoadedDocument()
  },
  exec(ctx, props) {
    const rate = Number(props.rate)
    if (!Number.isFinite(rate) || rate < 0) return
    ctx.requireKernelSession().setPlaybackRate(rate)
  },
}

export const SetToolSettingOperator: OperatorType = {
  id: 'OPERATOR_SET_TOOL_SETTING',
  label: '设置工具参数',
  poll(ctx) { return !ctx.isEmbed() },
  exec(ctx, props) {
    const key = props.key as string
    const tool = ctx.getToolSettings()
    const v = props.value
    switch (key) {
      case 'replaceBrush':
        tool.replaceBrush.value = v == null || v === '' ? null : String(v)
        break
      case 'fillBrush':
        tool.fillBrush.value = v == null || v === '' ? null : String(v)
        break
      case 'generateType':
        tool.generateType.value = v == null || v === '' ? null : String(v)
        break
      case 'snapEnabled':
        tool.snapEnabled.value = Boolean(v)
        break
      case 'dragSensitivity': {
        const n = Number(v)
        if (Number.isFinite(n)) tool.dragSensitivity = Math.max(0.01, Math.min(1, n))
        break
      }
      default:
        break
    }
  },
}

// ──────────────────────────── 外观 ────────────────────────────

export const ThemeToggleOperator: OperatorType = {
  id: 'OPERATOR_TOGGLE_THEME',
  label: '切换主题',
  description: '在暗色/亮色主题间切换',

  poll(_ctx) { return true },

  exec(ctx) {
    if (ctx.isEmbed()) return
    // 只改**本实例**设置（#259 A33）：旧实现在这里写 `wm.settings.theme`，
    // 而当时的 shellSettings 会把值落到 `document.documentElement` 与全局存储键上，
    // 于是同页另一个实例被迫同主题。现在写入的是实例作用域设置。
    const shell = ctx.getShellSettings()
    shell.setTheme(shell.theme.value === 'dark' ? 'light' : 'dark')
  },
}

export const SetLanguageOperator: OperatorType = {
  id: 'OPERATOR_SET_LANGUAGE',
  label: '设置语言',
  description: '设置界面语言（zh/en）',

  poll(_ctx) { return true },

  exec(ctx, props) {
    const lang = props.lang as 'zh' | 'en'
    if (lang !== 'zh' && lang !== 'en') return
    if (!ctx.isEmbed()) ctx.getShellSettings().setLang(lang)
  },
}

// ──────────────────────────── 撤销/重做 ────────────────────────────
//
// ## R1-β① C2：这两个算子的读面与写面都换了权威
//
// 修前：`poll` 读 `ctx.getEditHistory().canUndo.value`，`exec` 调
// `ctx.getEditHistory().undo()` —— 权威是旧 `UndoManager`（`context/editHistory`
// 的双栈），而内核 `Document.history` 另有一条并行历史。两条历史并存就是
// #385 评论 6988 裁决① 要消除的"写了撤不掉"的歧义形态。
//
// 修后：读 `ctx.kernelUndoState()`（内核 `Document#history` 的投影，
// 与 `application/queries#queryDocument` 同口径），写
// `ctx.submitKernelUndoRedo('undo' | 'redo')`（发 `{kind:'undo'|'redo'}` 命令，
// 记账由 `reduceUndoRedo` 在事务内完成，契约 §5.2）。
//
// ## ⚠️ 未装配时 `poll` 必须返回 `false`，**不得**回落旧栈
//
// `kernelUndoState()` 在"无会话/未 adopted"时返回 `null`。此处**刻意**把它读成
// "不可撤销"，而不是"去问旧栈"：
//  - 未装配 ⇒ 没有内核文档 ⇒ 内核历史为空，这是**如实**答案，不是退化；
//  - 若回落旧栈，那条旧栈就永远有人在读 ⇒ "旧栈是唯一的撤销权威"这个已退出的
//    事实会被这条读路径**保活**（#171 禁止的新门面包旧核心）。
// 而 `poll` 的语义本来就是"这个算子此刻可用吗" —— `false` 是**正确**的答案
// （不可用），不是错误（没有"抛错"的余地：`poll` 返回 `boolean`）。
//
// 未装配实例因此表现为"撤销/重做菜单项置灰"，与"没有可撤销的东西"逐点同形。
export const UndoOperator: OperatorType = {
  id: 'OPERATOR_UNDO',
  label: '撤销',
  description: '撤销上一步操作',

  poll(ctx) {
    return ctx.kernelUndoState()?.canUndo ?? false
  },

  exec(ctx, _props) {
    ctx.submitKernelUndoRedo('undo')
  },
}

export const RedoOperator: OperatorType = {
  id: 'OPERATOR_REDO',
  label: '重做',
  description: '重做已撤销的操作',

  poll(ctx) {
    return ctx.kernelUndoState()?.canRedo ?? false
  },

  exec(ctx, _props) {
    ctx.submitKernelUndoRedo('redo')
  },
}

// ──────────────────────────── 工作区 ────────────────────────────

export const SetWorkspaceModeOperator: OperatorType = {
  id: 'OPERATOR_SET_WORKSPACE_MODE',
  label: '设置工作区模式',
  description: '切换 SDE/本地文件/本地 Bundle 工作区模式',

  poll(_ctx) {
    return true
  },

  exec(ctx, props) {
    const mode = props.mode as WorkbenchWorkspaceMode
    if (ctx.getWorkspaceMode().value === mode) return
    // 仅设置抽屉手动切换时清空场景；加载管线在写入文档后切模式，不可清 doc
    if (props.resetDocument === true) {
      // #301 A′：经唯一写入口（卸载语义 —— 内核侧同步为"未装载"）。
      ctx.setDocument(null)
      // 帧归零现在是"定位时间"（帧下标是派生值）—— 换文档时由宿主显式发出。
      ctx.requireKernelSession().seekFrame(0)
      ctx.getLocalFileName().value = null
    }
    ctx.getWorkspaceMode().value = mode
  },
}

export const SetLayerYOperator: OperatorType = {
  id: 'OPERATOR_SET_LAYER_Y',
  label: '设置图层 Y',
  poll(ctx) { return ctx.hasLoadedDocument() },
  exec(ctx, props) {
    const y = Math.floor(props.y as number)
    const v = Number.isFinite(y) ? y : -1
    ctx.getLayerWorldY().value = v
  },
}

/** 脚本/API 用；指针路径直写 Region.state.hover */
export const SetHoveredBlockOperator: OperatorType = {
  id: 'OPERATOR_SET_HOVERED_BLOCK',
  label: '设置悬停方块',
  internal: true,
  poll(ctx) { return !ctx.isEmbed() && ctx.hasLoadedDocument() },
  exec(ctx, props) {
    const block = props.block as BlockRef | null | undefined
    setRegionHoverBlock(ctx, REGION.WORKBENCH_VIEWPORT, block ?? null)
  },
}

export const SetHoveredAnnotationOperator: OperatorType = {
  id: 'OPERATOR_SET_HOVERED_ANNOTATION',
  label: '设置悬停注解',
  internal: true,
  poll(ctx) { return !ctx.isEmbed() },
  exec(ctx, props) {
    const id = props.annotationId as string | null | undefined
    setRegionHoverAnnotation(ctx, REGION.WORKBENCH_VIEWPORT, id ?? null)
  },
}

export const SetWikiConfigOperator: OperatorType = {
  id: 'OPERATOR_SET_WIKI_CONFIG',
  label: '设置 Wiki 配置',
  poll(ctx) { return !ctx.isEmbed() },
  exec(ctx, props) {
    const path = props.path as string
    if (!path) return
    const pub = ctx.main.embedPublish.value
    if (path.startsWith('features.')) {
      setNested(pub as unknown as Record<string, unknown>, path, props.value)
      return
    }
    if (path === 'viewWidth' || path === 'viewHeight' || path === 'sceneBackgroundHex') {
      setNested(pub as unknown as Record<string, unknown>, path, props.value)
    }
  },
}

export const SetRegionSettingOperator: OperatorType = {
  id: 'OPERATOR_SET_REGION_SETTING',
  label: '设置 Region 状态',
  poll(ctx) { return ctx.getScreenRoot() !== null },
  exec(ctx, props) {
    const regionId = props.regionId as string
    const path = props.path as string
    if (!regionId || !path) return
    const region = ctx.region(regionId)
    if (!region) return
    setNested(region.state as Record<string, unknown>, path, props.value)
  },
}

export const ApplySettingsOperator: OperatorType = {
  id: 'OPERATOR_APPLY_SETTINGS',
  label: '应用启动设置',
  poll() { return true },
  exec(ctx, props) {
    if (props.workspaceMode) ctx.getWorkspaceMode().value = props.workspaceMode as WorkbenchWorkspaceMode
    if (props.uiWorkspace) ctx.getUiWorkspace().value = props.uiWorkspace as import('@/runtime/types').UIWorkspace
    const conn = props.connection as Partial<import('@/runtime/types').ConnectionState> | undefined
    if (conn && !ctx.isEmbed()) {
      Object.assign(ctx.getConnection(), conn)
    }
  },
}

export const ResetLayoutOperator: OperatorType = {
  id: 'OPERATOR_RESET_LAYOUT',
  label: '重置布局',
  description: '清除布局缓存并刷新页面',

  poll(_ctx) {
    return true
  },

  exec(_ctx, _props) {
    // Direct DOM access is intentional here: we need to clear persisted layout
    // state and force a full page reload to re-initialise the Screen layout system.
    try { localStorage.removeItem('wsr-wb-left-w'); localStorage.removeItem('wsr-wb-right-w') } catch { /* */ }
    location.reload()
  },
}
