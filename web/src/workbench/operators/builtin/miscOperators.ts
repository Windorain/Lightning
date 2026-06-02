import type { OperatorType } from '@/workbench/operators/operatorType'
import { toggleTheme } from '@/workbench/composables/useNeiTheme'
import { setLang } from '@/workbench/i18n'
import type { WorkbenchWorkspaceMode } from '@/workbench/context/bContext'

// ──────────────────────────── 工具 ────────────────────────────

export const ToolSetOperator: OperatorType = {
  id: 'OPERATOR_TOOL_SET',
  label: '切换工具',
  description: '激活指定工具',

  exec(bctx, props) {
    const toolId = props.toolId as string
    if (!toolId) return
    bctx.toolRegistry.activate(toolId)
  },
}

// ──────────────────────────── 帧切换 ────────────────────────────

export const SetFrameIndexOperator: OperatorType = {
  id: 'OPERATOR_SET_FRAME_INDEX',
  label: '设置帧索引',
  description: '在多帧场景中切换当前帧',

  poll(bctx) {
    return bctx.doc.value !== null
  },

  exec(bctx, _props) {
    const index = _props.index as number
    const i = Math.floor(index)
    bctx.currentWorldFrameIndex.value = Number.isFinite(i) && i >= 0 ? i : 0
  },
}

// ──────────────────────────── 外观 ────────────────────────────

export const ThemeToggleOperator: OperatorType = {
  id: 'OPERATOR_TOGGLE_THEME',
  label: '切换主题',
  description: '在暗色/亮色主题间切换',

  poll(_bctx) { return true },

  exec(_bctx) {
    toggleTheme()
  },
}

export const SetLanguageOperator: OperatorType = {
  id: 'OPERATOR_SET_LANGUAGE',
  label: '设置语言',
  description: '设置界面语言（zh/en）',

  poll(_bctx) { return true },

  exec(_bctx, props) {
    const lang = props.lang as 'zh' | 'en'
    if (lang !== 'zh' && lang !== 'en') return
    setLang(lang)
  },
}

// ──────────────────────────── 撤销/重做 ────────────────────────────

export const UndoOperator: OperatorType = {
  id: 'OPERATOR_UNDO',
  label: '撤销',
  description: '撤销上一步操作',

  poll(bctx) {
    return bctx.editHistory.canUndo.value
  },

  exec(bctx, _props) {
    bctx.editHistory.undo()
  },
}

export const RedoOperator: OperatorType = {
  id: 'OPERATOR_REDO',
  label: '重做',
  description: '重做已撤销的操作',

  poll(bctx) {
    return bctx.editHistory.canRedo.value
  },

  exec(bctx, _props) {
    bctx.editHistory.redo()
  },
}

// ──────────────────────────── 工作区 ────────────────────────────

export const SetWorkspaceModeOperator: OperatorType = {
  id: 'OPERATOR_SET_WORKSPACE_MODE',
  label: '设置工作区模式',
  description: '切换 SDE/本地文件/本地 Bundle 工作区模式',

  poll(_bctx) {
    return true
  },

  exec(bctx, _props) {
    const mode = _props.mode as WorkbenchWorkspaceMode
    if (bctx.workspaceMode.value === mode) return
    bctx.doc.value = null
    bctx.dirty.value = false
    bctx.structEpoch.value = 0
    bctx.currentWorldFrameIndex.value = 0
    bctx.localFileName.value = null
    bctx.workspaceMode.value = mode
  },
}

export const ResetLayoutOperator: OperatorType = {
  id: 'OPERATOR_RESET_LAYOUT',
  label: '重置布局',
  description: '清除布局缓存并刷新页面',

  poll(_bctx) {
    return true
  },

  exec(_bctx, _props) {
    try { localStorage.removeItem('wsr-wb-left-w'); localStorage.removeItem('wsr-wb-right-w') } catch { /* */ }
    location.reload()
  },
}
