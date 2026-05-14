import type { OperatorType } from '@/workbench/operators/operatorType'
import type { WorkbenchWorkspaceMode } from '@/workbench/sceneContext'

export const SetWorkspaceModeOperator: OperatorType = {
  id: 'OPERATOR_SET_WORKSPACE_MODE',
  label: '设置工作区模式',
  description: '切换 SDE/本地文件/本地 Bundle 工作区模式',

  poll(_bctx) {
    return true
  },

  exec(bctx, _props) {
    const mode = _props.mode as WorkbenchWorkspaceMode
    bctx.scene.setWorkspaceMode(mode)
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
