import type { Context } from '@/runtime/context'
import { relayout } from '@/workbench/ux/layout'

/** 切换 Region 折叠并刷新布局缓存（键位 t/n 等） */
export function toggleRegionCollapsed(ctx: Context, regionId: string): void {
  const r = ctx.requireRegion(regionId)
  r.collapsed = !r.collapsed
  relayout(ctx)
}
