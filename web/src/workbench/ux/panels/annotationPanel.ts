import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout, UILayoutItem } from '../types/layout'

export const annotationPanel: PanelDeclaration = {
  id: 'annotation-panel',
  label: '注解属性',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,

  poll(ctx: BContext): boolean {
    const state = (ctx as any).annotationState
    return state?.currentDraft != null
  },

  owner(ctx: BContext): unknown {
    return (ctx as any).annotationState?.currentDraft ?? null
  },

  layout(ctx: BContext): UILayout {
    const state = (ctx as any).annotationState
    const draft = state?.currentDraft as Record<string, any> | null

    if (!draft) {
      return {
        kind: 'column', align: false,
        items: [
          { kind: 'label', text: '无活跃注解' },
          { kind: 'label', text: '选择注解工具并在视口操作' },
        ],
      }
    }

    const items: UILayoutItem[] = []
    const t = draft.type as string

    // Common fields
    items.push(
      {
        kind: 'box', label: '基本信息', items: [
          { kind: 'property', rnaPath: 'annotation.title', label: '标题' },
          { kind: 'property', rnaPath: 'annotation.description', label: '描述', widget: 'text' },
        ],
      },
      { kind: 'separator' },
      {
        kind: 'box', label: '外观', items: [
          { kind: 'property', rnaPath: 'annotation.color', label: '颜色', widget: 'color' },
          { kind: 'property', rnaPath: 'annotation.visible', label: '可见', widget: 'checkbox' },
        ],
      },
    )

    // Type-specific fields
    switch (t) {
      case 'box':
        items.push(
          { kind: 'separator' },
          {
            kind: 'box', label: '包围盒', items: [
              { kind: 'label', text: `Min: ${fmtVec(draft.min)}` },
              { kind: 'label', text: `Max: ${fmtVec(draft.max)}` },
              { kind: 'property', rnaPath: 'annotation.renderStyle', label: '渲染样式', widget: 'dropdown' },
            ],
          },
        )
        break
      case 'point':
        items.push(
          { kind: 'separator' },
          {
            kind: 'box', label: '位置 & 图标', items: [
              { kind: 'label', text: `位置: ${fmtVec(draft.pos)}` },
              { kind: 'property', rnaPath: 'annotation.icon', label: '图标', widget: 'dropdown' },
              { kind: 'property', rnaPath: 'annotation.size', label: '大小' },
            ],
          },
        )
        break
      case 'line':
        items.push(
          { kind: 'separator' },
          {
            kind: 'box', label: '线段', items: [
              { kind: 'label', text: `${draft.points?.length ?? 0} 个点` },
              { kind: 'property', rnaPath: 'annotation.thickness', label: '粗细' },
              { kind: 'property', rnaPath: 'annotation.arrow', label: '箭头', widget: 'dropdown' },
            ],
          },
        )
        break
      case 'text':
        items.push(
          { kind: 'separator' },
          {
            kind: 'box', label: '文本', items: [
              { kind: 'property', rnaPath: 'annotation.text', label: '内容', widget: 'text' },
              { kind: 'property', rnaPath: 'annotation.fontSize', label: '字号' },
            ],
          },
        )
        break
    }

    // Action buttons
    items.push(
      { kind: 'separator' },
      { kind: 'operator', id: 'ANNOTATION_UPDATE', label: '保存', props: { id: draft.id, patch: draft } },
      { kind: 'operator', id: 'ANNOTATION_DELETE', label: '删除', props: { id: draft.id } },
    )

    return { kind: 'column', align: false, items }
  },
}

function fmtVec(v: { x?: number; y?: number; z?: number } | undefined): string {
  if (!v) return '()'
  return `(${(v.x ?? 0).toFixed(2)}, ${(v.y ?? 0).toFixed(2)}, ${(v.z ?? 0).toFixed(2)})`
}
