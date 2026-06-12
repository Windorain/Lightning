import type { Context } from '@/runtime/context'
import { indexTitle, normalizeBase } from '@/util/wikiStructureData'

declare global {
  interface Window {
    __WSR_WORKBENCH_DATA_TITLE__?: string
  }
}

function readBootDataTitle(): string | null {
  if (typeof document === 'undefined') return null
  const fromGlobal = window.__WSR_WORKBENCH_DATA_TITLE__?.trim()
  if (fromGlobal) return indexTitle(fromGlobal)
  const root =
    document.querySelector('.web-structure-workbench') ??
    document.getElementById('wsr-workbench-app')
  const fromAttr = root?.getAttribute('data-wsw-data')?.trim()
  if (fromAttr) return indexTitle(fromAttr)
  const q = new URLSearchParams(window.location.search).get('data')?.trim()
  if (q) return indexTitle(q)
  return null
}

/** Wiki 宿主启动：仅在有 data 深链时自动载入；不弹「从 Wiki 加载」 */
export async function bootWikiWorkbench(ctx: Context): Promise<void> {
  const title = readBootDataTitle()
  if (!title) return
  try {
    await ctx.getOperators().exec('OPERATOR_DOCUMENT_LOAD', {
      sourceId: 'wiki-data',
      title,
    })
  } catch (e) {
    ctx.log.error('Wiki 启动载入', String(e))
  }
}
