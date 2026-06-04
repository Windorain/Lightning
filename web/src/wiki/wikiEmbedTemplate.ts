import type { Context } from '@/runtime/context'
import { displayNameFromLocator } from '@/wiki/wikiUrls'

/** 生成 `{{渲染器|结构名称=…|…}}` wikitext（仅发布壳；初始视角在 Data JSON 的 meta.embed_initial_view） */
export function buildWikiEmbedWikitext(ctx: Context): string {
  const binding = ctx.getDocumentBinding().value
  const name = displayNameFromLocator(binding.locator)
  const pub = ctx.main.embedPublish.value
  const parts = [`结构名称=${name}`]

  if (pub.viewWidth !== 800) parts.push(`宽度=${pub.viewWidth}px`)
  if (pub.viewHeight !== 600) parts.push(`高度=${pub.viewHeight}px`)
  if (pub.features.blockStatsSidebar) parts.push('统计栏=true')
  if (pub.features.layerBar) parts.push('分层预览=true')
  if (pub.features.frameControls) parts.push('播放条=true')
  if (pub.features.titleBar) parts.push('标题栏=true')
  if (pub.features.debugStatusBar) parts.push('调试状态栏=true')
  if (pub.features.showAxesGizmo) parts.push('坐标轴=true')
  if (pub.sceneBackgroundHex && pub.sceneBackgroundHex !== '#5a5a5a') {
    parts.push(`背景色=${pub.sceneBackgroundHex}`)
  }

  return `{{渲染器|${parts.join('|')}}}`
}
