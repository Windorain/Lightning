import type { OperatorType } from '@/operators/operatorType'
import { theme } from '@/workbench/composables/useNeiTheme'
import { currentLang } from '@/config/i18n'
import type { WorkbenchWorkspaceMode } from '@/runtime/types'
import { replaceDoc } from '@/context/replaceDoc'

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

// ──────────────────────────── 帧切换 ────────────────────────────

export const SetFrameIndexOperator: OperatorType = {
  id: 'OPERATOR_SET_FRAME_INDEX',
  label: '设置帧索引',
  description: '在多帧场景中切换当前帧',

  poll(ctx) {
    return ctx.doc.value !== null
  },

  exec(ctx, _props) {
    const index = _props.index as number
    const i = Math.floor(index)
    ctx.main.currentFrameIndex.value = Number.isFinite(i) && i >= 0 ? i : 0
  },
}

export const ToggleFramePlaybackOperator: OperatorType = {
  id: 'OPERATOR_TOGGLE_FRAME_PLAYBACK',
  label: '切换帧播放',
  poll(ctx) {
    const doc = ctx.doc.value
    return doc !== null && doc.frameCount > 1
  },
  exec(ctx) {
    ctx.main.framesPlaybackIsPlaying.value = !ctx.main.framesPlaybackIsPlaying.value
  },
}

// ──────────────────────────── 外观 ────────────────────────────

export const ThemeToggleOperator: OperatorType = {
  id: 'OPERATOR_TOGGLE_THEME',
  label: '切换主题',
  description: '在暗色/亮色主题间切换',

  poll(_ctx) { return true },

  exec(ctx) {
    if (ctx.isEmbed) return
    const next = ctx.workbench!.theme.value === 'dark' ? 'light' : 'dark'
    ctx.workbench!.theme.value = next
    theme.value = next
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
    if (!ctx.isEmbed) ctx.workbench!.lang.value = lang
    currentLang.value = lang
    try { localStorage.setItem('wsr-wb-lang', lang) } catch { /* */ }
  },
}

// ──────────────────────────── 撤销/重做 ────────────────────────────

export const UndoOperator: OperatorType = {
  id: 'OPERATOR_UNDO',
  label: '撤销',
  description: '撤销上一步操作',

  poll(ctx) {
    return ctx.editHistory.canUndo.value
  },

  exec(ctx, _props) {
    ctx.editHistory.undo()
  },
}

export const RedoOperator: OperatorType = {
  id: 'OPERATOR_REDO',
  label: '重做',
  description: '重做已撤销的操作',

  poll(ctx) {
    return ctx.editHistory.canRedo.value
  },

  exec(ctx, _props) {
    ctx.editHistory.redo()
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

  exec(ctx, _props) {
    const mode = _props.mode as WorkbenchWorkspaceMode
    if (ctx.workspaceMode.value === mode) return
    replaceDoc(ctx, null)
    ctx.main.currentFrameIndex.value = 0
    ctx.localFileName.value = null
    ctx.workspaceMode.value = mode
  },
}

export const SetLayerYOperator: OperatorType = {
  id: 'OPERATOR_SET_LAYER_Y',
  label: '设置图层 Y',
  poll(ctx) { return !ctx.isEmbed && ctx.doc.value !== null },
  exec(ctx, props) {
    const y = Math.floor(props.y as number)
    ctx.workbench!.layerWorldY.value = Number.isFinite(y) ? y : -1
  },
}

export const SetWikiConfigOperator: OperatorType = {
  id: 'OPERATOR_SET_WIKI_CONFIG',
  label: '设置 Wiki 配置',
  poll(ctx) { return !ctx.isEmbed },
  exec(ctx, props) {
    const path = props.path as string
    if (!path) return
    setNested(ctx.wikiConfig, path, props.value)
  },
}

export const ApplySettingsOperator: OperatorType = {
  id: 'OPERATOR_APPLY_SETTINGS',
  label: '应用启动设置',
  poll() { return true },
  exec(ctx, props) {
    if (props.workspaceMode) ctx.workspaceMode.value = props.workspaceMode as WorkbenchWorkspaceMode
    if (props.uiWorkspace) ctx.uiWorkspace.value = props.uiWorkspace as import('@/runtime/types').UIWorkspace
    const conn = props.connection as Partial<import('@/runtime/types').ConnectionState> | undefined
    if (conn && !ctx.isEmbed) {
      Object.assign(ctx.connection, conn)
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
