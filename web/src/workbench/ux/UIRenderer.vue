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
.ux-row { display: flex; flex-direction: row; align-items: center; gap: 6px; }
.ux-column { display: flex; flex-direction: column; gap: 4px; }
.ux-box {
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  padding: 10px;
  margin: 4px 0;
  background: var(--wb-bg-surface);
}
.ux-box-label {
  font-size: 9px;
  font-weight: 600;
  color: var(--wb-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.8px;
  margin-bottom: 6px;
}
.ux-split { display: flex; flex-direction: row; }
.ux-scroll { overflow-y: auto; }
.ux-label { font-size: 11px; color: var(--wb-text-muted); }
.ux-sep {
  border: none;
  border-top: 1px solid transparent;
  background: linear-gradient(90deg, var(--wb-border), transparent);
  height: 1px;
  margin: 6px 0;
}
</style>
