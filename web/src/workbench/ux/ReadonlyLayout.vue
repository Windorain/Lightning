<script setup lang="ts">
/**
 * #253 P2 · **只读诊断片段渲染器**。
 *
 * 用途：面板里那些**本来就只读**的内容（调色板渲染模式、朝向、NBT 预览等）仍然需要
 * 布局表达能力，但它们**不应**经过属性写面。
 *
 * 本组件与 `UIRenderer.vue` 的关键差别是**结构性的**：它**不实现** `kind: 'property'`
 * 这一支，也不接收 RNA 注册表或 owner —— 因此「用布局再开一条属性写通路」在这里
 * **没有可用的入口**（契约 §5.2：不存在第二条属性写通路）。
 *
 * 属性行一律由 `PropertyInspector` 从 RNA 声明生成；诊断文本走这里。
 */

import { h, type VNode } from 'vue'
import type { UILayout, UILayoutItem, LayoutWithItems } from './types/layout'

const props = defineProps<{ layout: UILayout }>()

function isContainer(item: UILayoutItem): item is UILayout {
  if (typeof item !== 'object' || item === null) return false
  const k = (item as { kind?: string }).kind
  return k === 'row' || k === 'column' || k === 'box' || k === 'split' || k === 'panel' || k === 'scroll'
}

function renderItem(item: UILayoutItem, prefix: string, index: number): VNode {
  const layoutId = prefix ? `${prefix}.item-${index}` : `item-${index}`
  if (isContainer(item)) return renderLayout(item, layoutId)

  switch (item.kind) {
    case 'label': {
      const cls = item.class ?? 'ux-label'
      if (item.html) return h('span', { class: cls, 'data-layout-id': layoutId, innerHTML: item.text })
      return h('span', { class: cls, 'data-layout-id': layoutId }, item.text)
    }
    case 'separator':
      return h('hr', { class: 'ux-sep', 'data-layout-id': layoutId })
    case 'operator':
      // 具名命令**允许**出现在诊断区（它是显式命令，不是字段 patch）。
      return h(
        'button',
        {
          class: 'ux-op-btn',
          'data-layout-id': layoutId,
          'data-op-id': item.id,
          onClick: () => emitOperator(item.id, item.props),
        },
        item.label,
      )
    case 'widget':
      // 未注册的专用部件：显式回落，不静默吞掉。
      return h('span', { class: 'ux-label', 'data-layout-id': layoutId }, `(${item.widget})`)
    case 'property':
      // **不实现**：属性行只能由 PropertyInspector 从 RNA 生成。
      return h('span', { class: 'ux-label', 'data-layout-id': layoutId }, '(property 需由属性面板生成)')
    default:
      return h('span', {}, '')
  }
}

function renderLayout(l: UILayout, key: string): VNode {
  const attrs: Record<string, unknown> = { 'data-layout-id': key }
  if (l.kind === 'split') {
    return h('div', { class: 'ux-split', ...attrs }, [
      h('div', { style: { width: `${l.percentage}%` } }, [renderLayout(l.left, `${key}-l`)]),
      h('div', { style: { width: `${100 - l.percentage}%` } }, [renderLayout(l.right, `${key}-r`)]),
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

/** 具名命令的调用口（由父级注入；**不是**字段写入）。 */
const emit = defineEmits<{ (e: 'operator', id: string, props?: Record<string, unknown>): void }>()
function emitOperator(id: string, props?: Record<string, unknown>): void {
  emit('operator', id, props)
}

void props
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
  display: block;
  font-size: 10px;
  font-weight: 600;
  color: var(--wb-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.8px;
  margin-bottom: 6px;
}
.ux-split { display: flex; flex-direction: row; }
.ux-scroll { overflow-y: auto; }
.ux-label {
  font-size: 13px;
  color: var(--wb-text-muted);
  font-family: var(--wb-font-mono);
  white-space: pre-wrap;
}
.ux-sep {
  border: none;
  border-top: 1px solid transparent;
  background: linear-gradient(90deg, var(--wb-border), transparent);
  height: 1px;
  margin: 6px 0;
}
.ux-op-btn {
  padding: 6px 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-bg-surface);
  color: var(--wb-text);
  font-size: 12px;
  cursor: pointer;
}
</style>
