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

// ──────────────────────────── 帧切换 ────────────────────────────

export const SetFrameIndexOperator: OperatorType = {
  id: 'OPERATOR_SET_FRAME_INDEX',
  label: '设置帧索引',
  description: '在多帧场景中切换当前帧',

  poll(ctx) {
    return ctx.getDoc().value !== null
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
    const doc = ctx.getDoc().value
    return doc !== null && doc.frameCount > 1
  },
  exec(ctx) {
    ctx.main.framesPlaybackIsPlaying.value = !ctx.main.framesPlaybackIsPlaying.value
  },
}

export const SetFramePlaybackOperator: OperatorType = {
  id: 'OPERATOR_SET_FRAME_PLAYBACK',
  label: '设置帧播放',
  poll(ctx) {
    const doc = ctx.getDoc().value
    return doc !== null && doc.frameCount > 1
  },
  exec(ctx, props) {
    ctx.main.framesPlaybackIsPlaying.value = Boolean(props.playing)
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
    const shell = ctx.getShellSettings()
    shell.theme.value = shell.theme.value === 'dark' ? 'light' : 'dark'
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
    if (!ctx.isEmbed()) ctx.getShellSettings().lang.value = lang
  },
}

// ──────────────────────────── 撤销/重做 ────────────────────────────

export const UndoOperator: OperatorType = {
  id: 'OPERATOR_UNDO',
  label: '撤销',
  description: '撤销上一步操作',

  poll(ctx) {
    return ctx.getEditHistory().canUndo.value
  },

  exec(ctx, _props) {
    ctx.getEditHistory().undo()
  },
}

export const RedoOperator: OperatorType = {
  id: 'OPERATOR_REDO',
  label: '重做',
  description: '重做已撤销的操作',

  poll(ctx) {
    return ctx.getEditHistory().canRedo.value
  },

  exec(ctx, _props) {
    ctx.getEditHistory().redo()
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
      ctx.main.replaceDoc(null)
      ctx.main.currentFrameIndex.value = 0
      ctx.getLocalFileName().value = null
    }
    ctx.getWorkspaceMode().value = mode
  },
}

export const SetLayerYOperator: OperatorType = {
  id: 'OPERATOR_SET_LAYER_Y',
  label: '设置图层 Y',
  poll(ctx) { return ctx.getDoc().value !== null },
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
  poll(ctx) { return !ctx.isEmbed() && ctx.getDoc().value !== null },
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
