<script setup lang="ts">
import { h, type VNode } from 'vue'
import type { UILayout, UILayoutItem, LayoutWithItems } from './types/layout'
import type { RNARegistry } from './rna/types'
import RNAWidget from './RNAWidget.vue'
import OperatorBtn from './OperatorBtn.vue'
import UIMenu from './UIMenu.vue'

const props = defineProps<{
  layout: UILayout
  rna: RNARegistry
  owner?: unknown
}>()

/** Render a leaf item. prefix matches computeWidgetRects convention. */
function renderItem(item: UILayoutItem, prefix: string, index: number): VNode {
  const layoutId = prefix ? `${prefix}.item-${index}` : `item-${index}`

  if (isLayoutItem(item)) {
    return renderLayout(item, layoutId)
  }

  switch (item.kind) {
    case 'property': {
      const desc = props.rna.resolve(item.rnaPath)
      return h(RNAWidget, { descriptor: desc, label: item.label, rnaPath: item.rnaPath, owner: props.owner, 'data-layout-id': layoutId })
    }
    case 'operator':
      return h(OperatorBtn, { opId: item.id, label: item.label, icon: item.icon, title: item.title, operatorProps: item.props, 'data-layout-id': layoutId })
    case 'label':
      return h('span', { class: 'ux-label', 'data-layout-id': layoutId }, item.text)
    case 'separator':
      return h('hr', { class: 'ux-sep', 'data-layout-id': layoutId })
    case 'menu':
      return h(UIMenu, { label: item.label, icon: item.icon, items: item.items, 'data-layout-id': layoutId })
    default:
      return h('span', {}, '')
  }
}

/** Render a layout container. key is the cumulative layoutId path. */
function renderLayout(l: UILayout, key: string): VNode {
  const attrs: Record<string, unknown> = { 'data-layout-id': key }

  if (l.kind === 'split') {
    const leftPct = `${l.percentage}%`
    const rightPct = `${100 - l.percentage}%`
    return h('div', { class: 'ux-split', ...attrs }, [
      h('div', { style: { width: leftPct } }, [renderLayout(l.left, `${key}-l`)]),
      h('div', { style: { width: rightPct } }, [renderLayout(l.right, `${key}-r`)]),
    ])
  }

  const children = (l as LayoutWithItems).items.map((item, i) => renderItem(item, key, i))

  switch (l.kind) {
    case 'row':
      return h('div', { class: 'ux-row', ...attrs }, children)
    case 'column':
      return h('div', { class: 'ux-column', ...attrs }, children)
    case 'box':
      return h('div', { class: 'ux-box', ...attrs }, [
        h('label', { class: 'ux-box-label', 'data-layout-id': key }, l.label),
        ...children,
      ])
    case 'panel':
      return h('div', { class: 'ux-panel', ...attrs, 'data-panel-id': l.id }, children)
    case 'scroll':
      return h('div', { class: 'ux-scroll', ...attrs }, children)
    default:
      return h('div', {}, children)
  }
}

function isLayoutItem(item: UILayoutItem): item is UILayout {
  if (typeof item !== 'object' || item === null) return false
  const k = (item as { kind?: string }).kind
  return k !== undefined && ['row', 'column', 'box', 'split', 'panel', 'scroll'].includes(k)
}

</script>

<template>
  <component :is="renderLayout(layout, 'root')" />
</template>

<style scoped>
.ux-row { display: flex; flex-direction: row; align-items: center; gap: 4px; }
.ux-column { display: flex; flex-direction: column; gap: 2px; }
.ux-box { border: 1px solid var(--ui-border, #555); border-radius: 4px; padding: 6px; margin: 2px 0; }
.ux-box-label { font-size: 10px; font-weight: bold; color: var(--ui-label, #999); text-transform: uppercase; margin-bottom: 4px; }
.ux-split { display: flex; flex-direction: row; }
.ux-scroll { overflow-y: auto; }
.ux-label { font-size: 12px; color: var(--ui-text, #ccc); }
.ux-sep { border: none; border-top: 1px solid var(--ui-border, #555); margin: 4px 0; }
</style>
