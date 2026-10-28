import { computed, watch } from 'vue'
import type { Context } from '@/runtime/context'
import type { ScreenRoot } from '@/runtime/screenRoot'
import { SpaceType, RegionType } from '@/runtime/screenTypes'
import { CAPABILITY } from '@/composition/modules'
import { relayout } from '@/workbench/ux/layout'

/**
 * 从 Screen 注册面板派生 toolshelf / properties / header 列表，并在变更后 relayout。
 *
 * ## 退役：`owner` 不再出现在面板查询结果里
 *
 * 旧实现给每个面板算一个 `owner`（`p.owner?.(ctx)`）再传给 `UIRenderer` → `RNAWidget`，
 * 由后者执行 `descriptor.set(owner, value)`。那是「**owner 绑定分派**」：
 * 同一个属性名在不同 owner 上语义不同，而 owner 是**运行时查出来的对象**，
 * 于是「写到哪里」变成不可静态审计的事实（实测：
 * owner 常是选区快照，改了根本不落文档）。
 *
 * 现在写入寻址是 `PropertyRef { owner, property }`：`owner` 从**选中集**按对象类型
 * 算出（`@/editors/workbench-rna` 的 `resolveRefs`），写入经唯一写路由。
 * 因此面板查询只需给出 `layout`（只读诊断/命令片段）与 `component`（生成式属性面板）。
 */
export function usePanelQueries(ctx: Context, screen: ScreenRoot) {
  const viewportArea = screen.areas.find(a => a.spaceType === SpaceType.VIEW_3D)!
  const propertiesArea = screen.areas.find(a => a.spaceType === SpaceType.PROPERTIES)!

  function panelInWorkspace(p: { workspaces?: string[] }): boolean {
    const ws = ctx.getUiWorkspace().value
    return !p.workspaces || p.workspaces.includes(ws)
  }

  const activeToolshelfPanels = computed(() =>
    viewportArea.regions.find(r => r.type === RegionType.TOOLSHELF)!.panels
      .filter(p => panelInWorkspace(p) && p.poll(ctx))
      .map(p => ({ id: p.id, layout: p.layout(ctx), component: p.component }))
  )

  const activePropertiesPanels = computed(() =>
    propertiesArea.regions.find(r => r.type === RegionType.MAIN)!.panels
      .filter(p => panelInWorkspace(p) && p.poll(ctx))
      .map(p => ({ id: p.id, label: p.label, icon: p.icon, layout: p.layout(ctx), component: p.component }))
  )

  const wikiMwReady = computed(() => {
    // 旧实现是 `if (!isWikiHostProfile()) return false`。
    // 现在问能力：只有装配了 Wiki 上传的外壳才有 Wiki 就绪状态。
    if (!ctx.hasCapability(CAPABILITY.WIKI_UPLOAD)) return false
    return ctx.wm.chrome.wikiUi?.mwReady.value ?? false
  })

  const activeHeaderPanels = computed(() => {
    void wikiMwReady.value
    return viewportArea.regions.find(r => r.type === RegionType.HEADER)!.panels
      .filter(p => panelInWorkspace(p) && p.poll(ctx))
      .map(p => ({ id: p.id, label: p.label, icon: p.icon, layout: p.layout(ctx) }))
  })

  watch([activeToolshelfPanels, activePropertiesPanels, activeHeaderPanels], () => {
    relayout(ctx)
  }, { flush: 'post' })

  return { activeToolshelfPanels, activePropertiesPanels, activeHeaderPanels }
}
