import type { Context } from '@/runtime/context'

/**
 * Auto-connect to SDE on mount: if an apiBase is configured, attempt to connect
 * and load the workspace document.  In dev mode, also check for a ?sceneId=
 * query parameter and load a builtin scene.
 */
export async function autoConnectSde(ctx: Context): Promise<void> {
  if (ctx.connection.apiBase) {
    try { await ctx.operators.exec('OPERATOR_SDE_CONNECT') } catch { /* ignore */ }
    if (ctx.connection.connected) {
      try {
        const data = await (await import('@/workbench/sdeApi')).sdeGetWorkspaceDocument(ctx.connection.apiBase, ctx.connection.token)
        if (data) {
          const result = await ctx.main.registries.parsers.detectAndParse(data)
          if (result.document) {
            ctx.main.replaceDoc(result.document)
            await ctx.operators.exec('OPERATOR_SET_WORKSPACE_MODE', { mode: 'sde' })
          }
        }
      } catch { /* ignore */ }
    }
  } else if (import.meta.env.DEV) {
    const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
    const sceneId = q?.get('sceneId')
    if (sceneId) {
      try { await ctx.operators.exec('OPERATOR_LOAD_BUILTIN', { sceneId }) } catch { /* ignore */ }
    }
  }
}
