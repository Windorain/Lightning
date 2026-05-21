import type { OperatorType } from '@/workbench/operators/operatorType'
import type { WorkbenchWorkspaceMode } from '@/workbench/context/bContext'

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
