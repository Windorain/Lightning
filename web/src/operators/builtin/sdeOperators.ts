import type { OperatorType } from '@/operators/operatorType'
import {
  sdePing,
  sdeListExports,
  sdeGetExportFile,
  sdePutWorkspaceDocument,
} from '@/workbench/sdeApi'

export const SDEConnectOperator: OperatorType = {
  id: 'OPERATOR_SDE_CONNECT',
  label: '连接 SDE',
  description: '测试 SDE 连接并拉取导出列表',

  poll(_ctx) {
    return true
  },

  async exec(ctx, _props) {
    ctx.getConnection().connected = null
    if (!ctx.getConnection().apiBase) {
      ctx.getConnection().connected = false
      return
    }
    try {
      await sdePing(ctx.getConnection().apiBase, ctx.getConnection().token)
      ctx.getConnection().connected = true
      ctx.getConnection().exportsLoading = true
      try {
        ctx.getConnection().exports = await sdeListExports(ctx.getConnection().apiBase, ctx.getConnection().token)
      } catch { ctx.getConnection().exports = [] }
      finally { ctx.getConnection().exportsLoading = false }
    } catch { ctx.getConnection().connected = false }
  },
}

export const SDELoadExportOperator: OperatorType = {
  id: 'OPERATOR_SDE_LOAD',
  label: '加载导出',
  description: '从 SDE 导出列表加载指定场景',

  poll(ctx) {
    return ctx.getConnection().connected === true
  },

  async exec(ctx, _props) {
    const name = _props.name as string
    ctx.getSelection().clear()
    ctx.getEditHistory().clear()
    const data = await sdeGetExportFile(ctx.getConnection().apiBase, ctx.getConnection().token, name)
    ctx.getConnection().selectedExportName = name
    const result = await ctx.main.registries.parsers.detectAndParse(data)
    if (result.document) {
      ctx.main.replaceDoc( result.document)
      ctx.getCurrentFrameIndex().value = 0
      const totalBlocks = result.document.frames.reduce((sum, f) => sum + (f.grid?.count() ?? 0), 0)
      ctx.log.info('场景加载', `SDE · ${name}`, { fileName: name, frames: result.document.frameCount, blocks: totalBlocks })
    } else {
      ctx.main.replaceDoc( null)
      ctx.log.error('场景加载', result.error ?? '未知错误', { fileName: name, error: result.error })
    }
    ctx.getWorkspaceMode().value = 'sde'
    ctx.getLocalFileName().value = name
  },
}

export const SDELoadWorkspaceOperator: OperatorType = {
  id: 'OPERATOR_SDE_LOAD_WORKSPACE',
  label: '加载 SDE 工作区文档',
  poll(ctx) { return ctx.getConnection().connected === true },
  async exec(ctx, props) {
    const data = props.data
    ctx.getSelection().clear()
    ctx.getEditHistory().clear()
    const result = await ctx.main.registries.parsers.detectAndParse(data)
    if (result.document) {
      ctx.main.replaceDoc( result.document)
      ctx.getCurrentFrameIndex().value = 0
      ctx.log.info('场景加载', 'SDE workspace', { frames: result.document.frameCount })
    } else {
      ctx.main.replaceDoc( null)
      ctx.log.error('场景加载', result.error ?? '未知错误')
    }
    await ctx.getOperators().exec('OPERATOR_SET_WORKSPACE_MODE', { mode: 'sde' })
  },
}

export const SDEPushOperator: OperatorType = {
  id: 'OPERATOR_SDE_PUSH',
  label: '推送到 SDE',
  description: '将当前场景保存到 SDE 工作区',

  poll(ctx) {
    return ctx.getConnection().connected === true && ctx.getDoc().value !== null
  },

  async exec(ctx, _props) {
    if (!ctx.getConnection().apiBase || !ctx.getDoc().value) return
    await sdePutWorkspaceDocument(
      ctx.getConnection().apiBase,
      ctx.getConnection().token,
      ctx.getDoc().value!.serialize() as Record<string, unknown>,
    )
  },
}
