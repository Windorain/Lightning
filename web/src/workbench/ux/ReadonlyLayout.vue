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
import ContentText from '@/editors/ContentText.vue'
import UIMenu from './UIMenu.vue'
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
      // 声明式格式化内容：走**公共受控呈现边界**（Markdown + MC 码 → 受控节点）。
      // 旧实现是 `h('span', { innerHTML: item.text })` —— 任意字符串直通 DOM 标记，
      // 是 #259 A32 退役的直通路径之一。字段 `html` 已改名 `content`（P8，语义收窄为
      // "经受控边界解析"）；本文件是 P8 改名时漏掉的调用点，由合流类型检查抓出。
      if (item.content) return h(ContentText, { class: cls, text: item.text, mode: 'mc', 'data-layout-id': layoutId })
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
    /**
     * `kind: 'menu'` —— 下拉菜单（#282 P10b 实测修正）。
     *
     * ## 这是补一个**真实缺陷**，不是新功能
     *
     * `menuBar.ts` 的 File/Edit/View 三项都是 `kind: 'menu'`，但本渲染器此前
     * **没有这一支** ⇒ 落进 `default: return h('span', {}, '')` ⇒ **整个菜单栏
     * 渲染成空 span**（File/Edit/View 三个按钮不可见、点不到）。
     *
     * 唯一曾渲染菜单的 `UIRenderer.vue` 在 `66c0002`（P2 面板接生成式 Inspector）
     * 被删除，`UIMenu.vue` 因此**零引用**（只剩 `ux/index.ts` 的转出口）。
     * 于是"菜单栏是空的"从那时起就成立，而没有任何测试断言它 ——
     * 本批（Area 产品接线要经菜单暴露分割命令）才暴露出来。
     *
     * ## 为什么 `menu` 不进 `isContainer`
     *
     * `isContainer` 的成员是"**布局**容器"（row/column/box/panel/scroll），它们的
     * 子项是 `UILayoutItem`。而 `menu` 的子项是**菜单项**（`UIOperator`/`UILabel`/
     * `UISeparator`），语义与渲染都不同（点击展开、下拉定位）。故它走 `switch`
     * 分支交给 `UIMenu` 自己渲染，而不是被当作布局容器递归。
     *
     * 具名命令的调用仍由 `UIMenu` 经 `ctx.getOperators().invoke` 完成 ——
     * 与本文件 `operator` 分支的 `emit('operator', …)` 是**两条**合法入口
     * （前者是菜单项的既有实现，后者是本文件对父级的回调），都不是字段写入。
     */
    case 'menu':
      return h(UIMenu, {
        label: item.label,
        ...(item.icon === undefined ? {} : { icon: item.icon }),
        items: item.items,
        'data-layout-id': layoutId,
      })
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
