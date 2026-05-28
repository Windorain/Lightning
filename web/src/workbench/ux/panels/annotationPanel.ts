import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout } from '../types/layout'
import type { Annotation } from '@/render/data/annotationTypes'
import AnnotationEditorPanel from './AnnotationEditorPanel.vue'

function activeAnnotation(ctx: BContext): Annotation | null {
  const active = ctx.selection.active.value
  if (typeof active !== 'string') return null
  const doc = ctx.doc.value as Record<string, any> | null
  const annos = doc?.annotations as Annotation[] | undefined
  return annos?.find(a => a.id === active) ?? null
}

export const annotationPanel: PanelDeclaration = {
  id: 'annotation-panel',
  label: '注解属性',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,
  workspaces: ['preview'],

  poll(ctx: BContext): boolean {
    return activeAnnotation(ctx) !== null
  },

  component: AnnotationEditorPanel,

  layout(_ctx: BContext): UILayout {
    return { kind: 'column', align: false, items: [] }
  },
}
