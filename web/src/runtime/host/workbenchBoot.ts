import type { Context } from '@/runtime/context'

/**
 * Workbench 启动：若配置了 SDE apiBase 则自动连接并拉取工作区文档；
 * dev 模式下支持 ?sceneId= 加载内置场景。
 */
export async function autoConnectSde(ctx: Context): Promise<void> {
  if (ctx.getConnection().apiBase) {
    try { await ctx.getOperators().exec('OPERATOR_SDE_CONNECT') } catch { /* ignore */ }
    if (ctx.getConnection().connected) {
      try {
        const data = await (await import('@/workbench/sdeApi')).sdeGetWorkspaceDocument(
          ctx.getConnection().apiBase,
          ctx.getConnection().token,
        )
        if (data) {
          await ctx.getOperators().exec('OPERATOR_SDE_LOAD_WORKSPACE', { data })
        }
      } catch { /* ignore */ }
    }
  } else if (import.meta.env.DEV) {
    const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
    const sceneId = q?.get('sceneId')
    if (sceneId) {
      try { await ctx.getOperators().exec('OPERATOR_LOAD_BUILTIN', { sceneId }) } catch { /* ignore */ }
    }
  }
}
