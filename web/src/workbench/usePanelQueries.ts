import { computed, watch } from 'vue'
import type { Context } from '@/runtime/context'
import type { ScreenRoot } from '@/runtime/screenRoot'
import { SpaceType, RegionType } from '@/runtime/screenTypes'
import { isWikiHostProfile } from '@/runtime/hostProfile'
import { relayout } from '@/workbench/ux/layout'

/**
 * 从 Screen 注册面板派生 toolshelf / properties / header 列表，并在变更后 relayout。
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
      .map(p => ({ id: p.id, layout: p.layout(ctx), owner: p.owner?.(ctx), component: p.component }))
  )

  const activePropertiesPanels = computed(() =>
    propertiesArea.regions.find(r => r.type === RegionType.MAIN)!.panels
      .filter(p => panelInWorkspace(p) && p.poll(ctx))
      .map(p => ({ id: p.id, label: p.label, icon: p.icon, layout: p.layout(ctx), owner: p.owner?.(ctx), component: p.component }))
  )

  const wikiMwReady = computed(() => {
    if (!isWikiHostProfile()) return false
    return ctx.wm.chrome.wikiUi?.mwReady.value ?? false
  })

  const activeHeaderPanels = computed(() => {
    void wikiMwReady.value
    return viewportArea.regions.find(r => r.type === RegionType.HEADER)!.panels
      .filter(p => panelInWorkspace(p) && p.poll(ctx))
      .map(p => ({ id: p.id, label: p.label, icon: p.icon, layout: p.layout(ctx), owner: p.owner?.(ctx) }))
  })

  watch([activeToolshelfPanels, activePropertiesPanels, activeHeaderPanels], () => {
    relayout(ctx)
  }, { flush: 'post' })

  return { activeToolshelfPanels, activePropertiesPanels, activeHeaderPanels }
}
