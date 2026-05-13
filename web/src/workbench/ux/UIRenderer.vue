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

function renderItem(item: UILayoutItem, index: number): VNode {
  if (isLayout(item)) {
    return renderLayout(item, `item-${index}`)
  }
  switch (item.kind) {
    case 'property': {
      const desc = props.rna.resolve(item.rnaPath)
      return h(RNAWidget, {
        descriptor: desc,
        label: item.label,
        owner: props.owner,
        'data-layout-id': `item-${index}`,
      })
    }
    case 'operator':
      return h(OperatorBtn, {
        opId: item.id,
        label: item.label,
        icon: (item as any).icon,
        operatorProps: (item as any).props,
        'data-layout-id': `item-${index}`,
      })
    case 'label':
      return h('span', { class: 'ux-label', 'data-layout-id': `item-${index}` }, item.text)
    case 'separator':
      return h('hr', { class: 'ux-sep', 'data-layout-id': `item-${index}` })
    case 'menu':
      return h(UIMenu, {
        label: item.label,
        icon: (item as any).icon,
        items: (item as any).items,
        'data-layout-id': `item-${index}`,
      })
    default:
      return h('span', {}, '')
  }
}

function renderLayout(l: UILayout, key: string): VNode {
  const attrs: Record<string, unknown> = { 'data-layout-id': key }

  // UISplit: no items array, uses left/right instead
  if (l.kind === 'split') {
    const leftPct = `${l.percentage}%`
    const rightPct = `${100 - l.percentage}%`
    return h('div', { class: 'ux-split', ...attrs }, [
      h('div', { style: { width: leftPct } }, [renderLayout(l.left, `${key}-l`)]),
      h('div', { style: { width: rightPct } }, [renderLayout(l.right, `${key}-r`)]),
    ])
  }

  const children = (l as LayoutWithItems).items.map((item, i) => renderItem(item, i))

  switch (l.kind) {
    case 'row':
      return h('div', { class: 'ux-row', ...attrs }, children)
    case 'column':
      return h('div', { class: 'ux-column', ...attrs }, children)
    case 'box':
      return h('div', { class: 'ux-box', ...attrs }, [
        h('label', { class: 'ux-box-label' }, l.label),
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

function isLayout(item: UILayoutItem): item is UILayout {
  if (typeof item !== 'object' || item === null) return false
  const k = (item as { kind?: string }).kind
  return k !== undefined && ['row', 'column', 'box', 'split', 'panel', 'scroll'].includes(k)
}

const vnode = renderLayout(props.layout, 'root')
</script>

<template>
  <component :is="() => vnode" />
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
