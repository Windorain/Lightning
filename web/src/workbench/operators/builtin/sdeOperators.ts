import type { OperatorType } from '@/workbench/operators/operatorType'
import {
  sdePing,
  sdeListExports,
  sdeGetExportFile,
  sdePutWorkspaceDocument,
} from '@/workbench/sdeApi'
import { parserRegistry } from '@/workbench/context/parserRegistry'
import { logCenter } from '@/workbench/logging/LogCenter'

export const SDEConnectOperator: OperatorType = {
  id: 'OPERATOR_SDE_CONNECT',
  label: '连接 SDE',
  description: '测试 SDE 连接并拉取导出列表',

  poll(_bctx) {
    return true
  },

  async exec(bctx, _props) {
    bctx.connection.connected = null
    if (!bctx.connection.apiBase) {
      bctx.connection.connected = false
      return
    }
    try {
      await sdePing(bctx.connection.apiBase, bctx.connection.token)
      bctx.connection.connected = true
      bctx.connection.exportsLoading = true
      try {
        bctx.connection.exports = await sdeListExports(bctx.connection.apiBase, bctx.connection.token)
      } catch { bctx.connection.exports = [] }
      finally { bctx.connection.exportsLoading = false }
    } catch { bctx.connection.connected = false }
  },
}

export const SDELoadExportOperator: OperatorType = {
  id: 'OPERATOR_SDE_LOAD',
  label: '加载导出',
  description: '从 SDE 导出列表加载指定场景',

  poll(bctx) {
    return bctx.connection.connected === true
  },

  async exec(bctx, _props) {
    const name = _props.name as string
    bctx.selection.clear()
    bctx.editHistory.clear()
    const data = await sdeGetExportFile(bctx.connection.apiBase, bctx.connection.token, name)
    bctx.connection.selectedExportName = name
    const result = await parserRegistry.detectAndParse(data)
    bctx.doc.value = result.document ?? null
    if (result.document) {
      bctx.currentWorldFrameIndex.value = 0
      bctx.structEpoch.value += 1
      const totalBlocks = result.document.frames.reduce((sum, f) => sum + (f.grid?.count() ?? 0), 0)
      logCenter.info('场景加载', `SDE · ${name}`, { fileName: name, frames: result.document.frameCount, blocks: totalBlocks })
    } else {
      logCenter.error('场景加载', result.error ?? '未知错误', { fileName: name, error: result.error })
    }
    bctx.workspaceMode.value = 'sde'
    bctx.localFileName.value = name
    bctx.dirty.value = false
  },
}

export const SDEPushOperator: OperatorType = {
  id: 'OPERATOR_SDE_PUSH',
  label: '推送到 SDE',
  description: '将当前场景保存到 SDE 工作区',

  poll(bctx) {
    return bctx.connection.connected === true && bctx.doc.value !== null
  },

  async exec(bctx, _props) {
    if (!bctx.connection.apiBase || !bctx.doc.value) return
    await sdePutWorkspaceDocument(
      bctx.connection.apiBase,
      bctx.connection.token,
      bctx.doc.value.serialize() as Record<string, unknown>,
    )
    bctx.dirty.value = false
  },
}
