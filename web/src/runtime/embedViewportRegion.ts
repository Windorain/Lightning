import type { Context } from '@/runtime/context'
import type { ViewerPreferences } from '@/preview/preferences'
import { REGION } from '@/runtime/regionIds'

/** EmbedViewport 使用的 WM/视口 region：独立 Embed 或 Workbench Wiki 预览 */
export function resolveEmbedViewportRegionId(ctx: Context): string {
  if (ctx.region(REGION.EMBED)) return REGION.EMBED
  if (ctx.region(REGION.WIKI_PREVIEW)) return REGION.WIKI_PREVIEW
  throw new Error('no embed viewport region on screen (expected r-embed or r-wiki-preview)')
}

export function resolveEmbedViewerPreferences(ctx: Context): ViewerPreferences {
  const rid = resolveEmbedViewportRegionId(ctx)
  const prefs = ctx.requireRegion(rid).state.viewer
  if (!prefs) throw new Error(`viewer preferences missing on ${rid}`)
  return prefs
}
