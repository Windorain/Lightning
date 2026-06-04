import type { OperatorType } from '@/operators/operatorType'
import { hydrateMainEmbedInitialViewFromDoc } from '@/context/embedInitialView'
import { capturePreviewToDocument } from '@/context/captureEmbedInitialView'
import { resolveEmbedViewportRegionId } from '@/runtime/embedViewportRegion'

export const HydrateEmbedInitialViewOperator: OperatorType = {
  id: 'OPERATOR_HYDRATE_EMBED_INITIAL_VIEW',
  label: '水合嵌入初始视角',
  internal: true,
  poll(ctx) {
    return ctx.getDoc().value != null
  },
  exec(ctx) {
    hydrateMainEmbedInitialViewFromDoc(ctx.main)
  },
}

export const SyncEmbedInitialViewOperator: OperatorType = {
  id: 'OPERATOR_SYNC_EMBED_INITIAL_VIEW',
  label: '同步预览视角到文档',
  description: '将上方 Wiki 预览的当前视角写入文档 meta.embed_initial_view',
  flagUndo: false,
  poll(ctx) {
    const slot = ctx.viewports.get(resolveEmbedViewportRegionId(ctx))
    return slot?.camera.value != null && ctx.getDoc().value != null
  },
  exec(ctx) {
    if (!capturePreviewToDocument(ctx)) {
      ctx.log.warn('嵌入初始视角', '无法抓取预览视口相机（请确认 Wiki 预览已加载）')
      return
    }
    ctx.log.info('嵌入初始视角', '已写入文档，可保存到 Wiki')
  },
}
