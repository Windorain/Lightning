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
    bctx.connectionConnected.value = null
    if (!bctx.connectionApiBase.value) {
      bctx.connectionConnected.value = false
      return
    }
    try {
      await sdePing(bctx.connectionApiBase.value, bctx.connectionToken.value)
      bctx.connectionConnected.value = true
      bctx.connectionExportsLoading.value = true
      try {
        bctx.connectionExports.value = await sdeListExports(bctx.connectionApiBase.value, bctx.connectionToken.value)
      } catch { bctx.connectionExports.value = [] }
      finally { bctx.connectionExportsLoading.value = false }
    } catch { bctx.connectionConnected.value = false }
  },
}

export const SDELoadExportOperator: OperatorType = {
  id: 'OPERATOR_SDE_LOAD',
  label: '加载导出',
  description: '从 SDE 导出列表加载指定场景',

  poll(bctx) {
    return bctx.connectionConnected.value === true
  },

  async exec(bctx, _props) {
    const name = _props.name as string
    bctx.selection.clear()
    bctx.editHistory.clear()
    const data = await sdeGetExportFile(bctx.connectionApiBase.value, bctx.connectionToken.value, name)
    bctx.connectionSelectedExportName.value = name
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
    return bctx.connectionConnected.value === true && bctx.doc.value !== null
  },

  async exec(bctx, _props) {
    if (!bctx.connectionApiBase.value || !bctx.doc.value) return
    await sdePutWorkspaceDocument(
      bctx.connectionApiBase.value,
      bctx.connectionToken.value,
      bctx.doc.value.toRaw() as Record<string, unknown>,
    )
    bctx.dirty.value = false
  },
}
