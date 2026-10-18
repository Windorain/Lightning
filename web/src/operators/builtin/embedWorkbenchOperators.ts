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

  /**
   * 可用性 = **宿主页面声明的跳转桥**（bootstrap 的 `workbenchEdit` 经
   * `OPERATOR_...`/`Main#embedWorkbenchEdit` 落到这里）。
   *
   * M7-5 之前这里还有一句"非嵌入才返回 false"的宿主身份判断 —— 那是宿主分叉。
   * 删掉它不改变任何生产行为：`Main#embedWorkbenchEdit` 缺省 `{enabled:false}`
   * 且只有嵌入宿主（`EmbedRoot` 的 bootstrap）会把它置真；工作台实例永远是 false。
   * ⇒ 唯一的权威是**宿主页面给的声明**（SPEC §10.1：一项事实一个权威），
   * 而不是"这个实例是不是嵌入"。
   */
  poll(ctx) {
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
