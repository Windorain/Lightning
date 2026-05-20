import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout, UILayoutItem } from '../types/layout'
import type { Annotation } from '@/render/data/annotationTypes'

const AUTO_SAVE_DELAY = 200

function activeAnnotation(ctx: BContext): Annotation | null {
  const active = ctx.selection.active.value
  if (typeof active !== 'string') return null
  const doc = ctx.scene.scene.value as Record<string, any> | null
  const annos = doc?.annotations as Annotation[] | undefined
  return annos?.find(a => a.id === active) ?? null
}

export const annotationPanel: PanelDeclaration = {
  id: 'annotation-panel',
  label: '注解属性',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,

  poll(ctx: BContext): boolean {
    return activeAnnotation(ctx) !== null
  },

  owner(ctx: BContext): unknown {
    const anno = activeAnnotation(ctx)
    if (!anno) return null

    let timer: ReturnType<typeof setTimeout> | undefined

    return new Proxy(anno as Record<string, any>, {
      set(target, prop, value) {
        target[prop as string] = value
        if (prop === 'id' || prop === 'created_at' || prop === 'updated_at') return true
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = undefined
          ctx.operators.invoke('ANNOTATION_UPDATE', { id: target.id, patch: { ...target } })
        }, AUTO_SAVE_DELAY)
        return true
      },
    })
  },

  layout(ctx: BContext): UILayout {
    const anno = activeAnnotation(ctx)
    const draft = anno as Record<string, any> | null

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
          { kind: 'property', rnaPath: 'annotation.color', label: '颜色' },
          { kind: 'property', rnaPath: 'annotation.visible', label: '可见' },
          { kind: 'property', rnaPath: 'annotation.locked', label: '锁定' },
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
              { kind: 'property', rnaPath: 'annotation.min', label: '最小坐标' },
              { kind: 'property', rnaPath: 'annotation.max', label: '最大坐标' },
              { kind: 'property', rnaPath: 'annotation.renderStyle', label: '渲染样式' },
              { kind: 'property', rnaPath: 'annotation.renderOpacity', label: '不透明度', widget: 'stepper' },
              { kind: 'property', rnaPath: 'annotation.fillOpacity', label: '填充不透明度', widget: 'stepper' },
              { kind: 'property', rnaPath: 'annotation.frameThickness', label: '边框厚度', widget: 'stepper' },
              { kind: 'property', rnaPath: 'annotation.overlay', label: '覆盖层' },
            ],
          },
        )
        break
      case 'point':
        items.push(
          { kind: 'separator' },
          {
            kind: 'box', label: '位置 & 图标', items: [
              { kind: 'property', rnaPath: 'annotation.pos', label: '位置' },
              { kind: 'property', rnaPath: 'annotation.icon', label: '图标' },
              { kind: 'property', rnaPath: 'annotation.size', label: '大小', widget: 'stepper' },
            ],
          },
        )
        break
      case 'line':
        items.push(
          { kind: 'separator' },
          {
            kind: 'box', label: '线段', items: [
              { kind: 'property', rnaPath: 'annotation.thickness', label: '粗细', widget: 'stepper' },
              { kind: 'property', rnaPath: 'annotation.arrow', label: '箭头' },
              { kind: 'property', rnaPath: 'annotation.showPoints', label: '显示控制点' },
            ],
          },
        )
        break
      case 'text':
        items.push(
          { kind: 'separator' },
          {
            kind: 'box', label: '文本', items: [
              { kind: 'property', rnaPath: 'annotation.anchorPos', label: '锚点位置' },
              { kind: 'property', rnaPath: 'annotation.text', label: '内容' },
              { kind: 'property', rnaPath: 'annotation.fontSize', label: '字号', widget: 'stepper' },
              { kind: 'property', rnaPath: 'annotation.backgroundAlpha', label: '背景透明度', widget: 'stepper' },
            ],
          },
        )
        break
    }

    items.push(
      { kind: 'separator' },
      { kind: 'operator', id: 'ANNOTATION_DELETE', label: '删除', props: { id: draft.id } },
    )

    return { kind: 'column', align: false, items }
  },
}
