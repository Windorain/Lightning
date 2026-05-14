import type { OperatorType } from '@/workbench/operators/operatorType'

export const SDEConnectOperator: OperatorType = {
  id: 'OPERATOR_SDE_CONNECT',
  label: '连接 SDE',
  description: '测试 SDE 连接并拉取导出列表',

  poll(_bctx) {
    return true
  },

  async exec(bctx, _props) {
    const { connection } = bctx
    await connection.testConnection()
    if (connection.connected.value) {
      await connection.refreshExportList()
    }
  },
}

export const SDELoadExportOperator: OperatorType = {
  id: 'OPERATOR_SDE_LOAD',
  label: '加载导出',
  description: '从 SDE 导出列表加载指定场景',

  poll(bctx) {
    return bctx.connection.connected.value === true
  },

  async exec(bctx, _props) {
    const name = _props.name as string
    bctx.selection.clear()
    bctx.editHistory.clear()
    const data = await bctx.connection.fetchExportData(name)
    await bctx.scene.loadFromData(data, { mode: 'sde' })
  },
}

export const SDEPushOperator: OperatorType = {
  id: 'OPERATOR_SDE_PUSH',
  label: '推送到 SDE',
  description: '将当前场景保存到 SDE 工作区',

  poll(bctx) {
    return bctx.connection.connected.value === true && bctx.scene.scene.value !== null
  },

  async exec(bctx, _props) {
    await bctx.connection.pushToServer()
  },
}
