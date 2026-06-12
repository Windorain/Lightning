import type { OperatorType } from '@/operators/operatorType'
import { buildWorkbenchHubUrl } from '@/wiki/wikiUrls'

declare global {
  interface Window {
    WSR?: {
      openWorkbenchInNewTab?: (structureBase: string) => void
    }
  }
}

export const OpenWikiWorkbenchOperator: OperatorType = {
  id: 'OPERATOR_EMBED_OPEN_WIKI_WORKBENCH',
  label: '在结构工作台中打开',
  internal: true,

  poll(ctx) {
    if (!ctx.isEmbed()) return false
    const state = ctx.main.embedWorkbenchEdit.value
    const base = ctx.main.embedStructureBase.value
    return state.enabled && !!base
  },

  async exec(ctx) {
    const base = ctx.main.embedStructureBase.value
    if (!base) return

    const handlers = ctx.main.embedWorkbenchHandlers
    if (handlers?.beforeOpen) {
      const ok = await handlers.beforeOpen({ structureBase: base })
      if (ok === false) return
    }

    if (typeof window !== 'undefined' && window.WSR?.openWorkbenchInNewTab) {
      window.WSR.openWorkbenchInNewTab(base)
    } else if (typeof window !== 'undefined') {
      window.open(buildWorkbenchHubUrl(base), '_blank', 'noopener,noreferrer')
    }

    handlers?.afterOpen?.({ structureBase: base })
  },
}
