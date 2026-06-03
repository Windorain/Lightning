import type { Context } from '@/runtime/context'

/** 打开新场景时清空各视口相机（下次 attach 会 registerViewportCamera） */
export function resetAllViewportCameras(ctx: Context): void {
  ctx.viewports.resetAllViewportCameras()
}
