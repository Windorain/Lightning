import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout } from '../types/layout'
import AnnotationEditorPanel from './AnnotationEditorPanel.vue'

function hasAnnotationSelected(ctx: BContext): boolean {
  return [...ctx.selection.items.value].some(e => e.kind === 'annotation')
}

export const annotationPanel: PanelDeclaration = {
  id: 'annotation-panel',
  label: '注解属性',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,
  workspaces: ['preview'],

  poll(ctx: BContext): boolean {
    return hasAnnotationSelected(ctx)
  },

  component: AnnotationEditorPanel,

  layout(_ctx: BContext): UILayout {
    return { kind: 'column', align: false, items: [] }
  },
}
