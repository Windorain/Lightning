import type { OperatorType } from '@/operators/operatorType'
import {
  sdePing,
  sdeListExports,
  sdeGetExportFile,
  sdePutWorkspaceDocument,
} from '@/workbench/sdeApi'
import { replaceDoc } from '@/context/replaceDoc'

export const SDEConnectOperator: OperatorType = {
  id: 'OPERATOR_SDE_CONNECT',
  label: '连接 SDE',
  description: '测试 SDE 连接并拉取导出列表',

  poll(_ctx) {
    return true
  },

  async exec(ctx, _props) {
    ctx.connection.connected = null
    if (!ctx.connection.apiBase) {
      ctx.connection.connected = false
      return
    }
    try {
      await sdePing(ctx.connection.apiBase, ctx.connection.token)
      ctx.connection.connected = true
      ctx.connection.exportsLoading = true
      try {
        ctx.connection.exports = await sdeListExports(ctx.connection.apiBase, ctx.connection.token)
      } catch { ctx.connection.exports = [] }
      finally { ctx.connection.exportsLoading = false }
    } catch { ctx.connection.connected = false }
  },
}

export const SDELoadExportOperator: OperatorType = {
  id: 'OPERATOR_SDE_LOAD',
  label: '加载导出',
  description: '从 SDE 导出列表加载指定场景',

  poll(ctx) {
    return ctx.connection.connected === true
  },

  async exec(ctx, _props) {
    const name = _props.name as string
    ctx.selection.clear()
    ctx.editHistory.clear()
    const data = await sdeGetExportFile(ctx.connection.apiBase, ctx.connection.token, name)
    ctx.connection.selectedExportName = name
    const result = await ctx.main.registries.parsers.detectAndParse(data)
    if (result.document) {
      replaceDoc(ctx, result.document)
      ctx.currentFrameIndex.value = 0
      const totalBlocks = result.document.frames.reduce((sum, f) => sum + (f.grid?.count() ?? 0), 0)
      ctx.log.info('场景加载', `SDE · ${name}`, { fileName: name, frames: result.document.frameCount, blocks: totalBlocks })
    } else {
      replaceDoc(ctx, null)
      ctx.log.error('场景加载', result.error ?? '未知错误', { fileName: name, error: result.error })
    }
    ctx.workspaceMode.value = 'sde'
    ctx.localFileName.value = name
  },
}

export const SDELoadWorkspaceOperator: OperatorType = {
  id: 'OPERATOR_SDE_LOAD_WORKSPACE',
  label: '加载 SDE 工作区文档',
  poll(ctx) { return ctx.connection.connected === true },
  async exec(ctx, props) {
    const data = props.data
    ctx.selection.clear()
    ctx.editHistory.clear()
    const result = await ctx.main.registries.parsers.detectAndParse(data)
    if (result.document) {
      replaceDoc(ctx, result.document)
      ctx.currentFrameIndex.value = 0
      ctx.log.info('场景加载', 'SDE workspace', { frames: result.document.frameCount })
    } else {
      replaceDoc(ctx, null)
      ctx.log.error('场景加载', result.error ?? '未知错误')
    }
    await ctx.operators.exec('OPERATOR_SET_WORKSPACE_MODE', { mode: 'sde' })
  },
}

export const SDEPushOperator: OperatorType = {
  id: 'OPERATOR_SDE_PUSH',
  label: '推送到 SDE',
  description: '将当前场景保存到 SDE 工作区',

  poll(ctx) {
    return ctx.connection.connected === true && ctx.doc.value !== null
  },

  async exec(ctx, _props) {
    if (!ctx.connection.apiBase || !ctx.doc.value) return
    await sdePutWorkspaceDocument(
      ctx.connection.apiBase,
      ctx.connection.token,
      ctx.doc.value.serialize() as Record<string, unknown>,
    )
  },
}
