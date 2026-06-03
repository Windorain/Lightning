import { computed, watch } from 'vue'
import type { Context } from '@/runtime/context'
import type { bScreen } from '@/workbench/ux/types/screen'
import { SpaceType, RegionType } from '@/workbench/ux/types/screen'
import { relayout } from '@/workbench/ux/layout'

/**
 * Composable that derives the three reactive panel lists (toolshelf, properties,
 * header) from the registered panels on the default screen, filtering by
 * workspace and poll result.  A post-flush watch triggers widget-cache
 * recomputation whenever the active panel set changes.
 */
export function usePanelQueries(ctx: Context, screen: bScreen) {
  const viewportArea = screen.areas.find(a => a.spaceType === SpaceType.VIEW_3D)!
  const propertiesArea = screen.areas.find(a => a.spaceType === SpaceType.PROPERTIES)!

  function panelInWorkspace(p: { workspaces?: string[] }): boolean {
    const ws = ctx.uiWorkspace.value
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

  const activeHeaderPanels = computed(() =>
    viewportArea.regions.find(r => r.type === RegionType.HEADER)!.panels
      .filter(p => panelInWorkspace(p) && p.poll(ctx))
      .map(p => ({ id: p.id, label: p.label, icon: p.icon, layout: p.layout(ctx), owner: p.owner?.(ctx) }))
  )

  // Keep widgetCache in sync with reactive panel changes so boundsOfByOperator / boundsOfByRNAPath stay current
  watch([activeToolshelfPanels, activePropertiesPanels, activeHeaderPanels], () => {
    relayout(ctx)
  }, { flush: 'post' })

  return { activeToolshelfPanels, activePropertiesPanels, activeHeaderPanels }
}
