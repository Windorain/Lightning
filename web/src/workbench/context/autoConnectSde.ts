import type { BContext } from '@/context/bContext'
import type { ParserRegistryImpl } from '@/context/parserRegistry'
import { replaceDoc } from '@/context/replaceDoc'

/**
 * Auto-connect to SDE on mount: if an apiBase is configured, attempt to connect
 * and load the workspace document.  In dev mode, also check for a ?sceneId=
 * query parameter and load a builtin scene.
 */
export async function autoConnectSde(bctx: BContext, parserRegistry: ParserRegistryImpl): Promise<void> {
  if (bctx.connection.apiBase) {
    try { await bctx.operators.exec('OPERATOR_SDE_CONNECT') } catch { /* ignore */ }
    if (bctx.connection.connected) {
      try {
        const data = await (await import('@/workbench/sdeApi')).sdeGetWorkspaceDocument(bctx.connection.apiBase, bctx.connection.token)
        if (data) {
          const result = await parserRegistry.detectAndParse(data)
          if (result.document) {
            replaceDoc(bctx, result.document)
            bctx.workspaceMode.value = 'sde'
          }
        }
      } catch { /* ignore */ }
    }
  } else if (import.meta.env.DEV) {
    const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
    const sceneId = q?.get('sceneId')
    if (sceneId) {
      try { await bctx.operators.exec('OPERATOR_LOAD_BUILTIN', { sceneId }) } catch { /* ignore */ }
    }
  }
}
