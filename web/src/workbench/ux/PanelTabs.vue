<script setup lang="ts">
import { ref, watch, computed, type Component } from 'vue'
import ReadonlyLayout from './ReadonlyLayout.vue'
import type { UILayout } from './types/layout'

export interface PanelTabItem {
  id: string
  label: string
  icon?: string
  layout: UILayout
  owner?: unknown
  component?: Component
}

const props = defineProps<{
  panels: PanelTabItem[]
  ctx?: unknown
}>()

/**
 * 具名命令的执行口（面板容器持有上下文）。
 *
 * 这里只执行**具名命令**；属性写入一律经属性面板 → 唯一写路由，
 * 故容器不需要 RNA 注册表，也不传 owner（退役 #3：owner 绑定分派已删除）。
 */
const emit = defineEmits<{ (e: 'operator', id: string, props?: Record<string, unknown>): void }>()

function onOperator(id: string, p?: Record<string, unknown>): void {
  emit('operator', id, p)
}

const activeId = ref<string | null>(null)

// Auto-select: preserve current tab unless it was removed
watch(
  () => props.panels,
  (list) => {
    if (list.length === 0) {
      activeId.value = null
      return
    }
    const curIds = new Set(list.map(p => p.id))
    if (!activeId.value || !curIds.has(activeId.value)) {
      activeId.value = list[0].id
    }
  },
  { immediate: true },
)

const activePanel = computed(() => {
  if (!activeId.value) return null
  return props.panels.find(p => p.id === activeId.value) ?? null
})

function selectTab(id: string): void {
  activeId.value = id
}

/**
 * 竖排标签栏的**文字缩写/符号**（M3-shell B1）。
 *
 * 本仓没有图标体系，B1 不引入图标库（设计明文）：用面板 id → 一个等宽可读的
 * 符号，未知面板回落到 label 首字 —— 于是新增面板也总有可点的标记。
 * 完整的 tab 文案仍由 `.pt-tab-label` 逐字渲染（e2e 按文案定位）。
 */
const TAB_GLYPHS: Readonly<Record<string, string>> = {
  'block-inspector': '▦',
  'transform-panel': '✥',
  'scene-info-panel': 'ⓘ',
  'block-stats-panel': '∑',
  'annotation-panel': '✎',
  'wiki-config-panel': '⚙',
  'tooltip-editor': '☰',
}

function glyphFor(p: PanelTabItem): string {
  return p.icon ?? TAB_GLYPHS[p.id] ?? p.label.slice(0, 1)
}
</script>

<template>
  <div class="pt-root" v-if="panels.length > 0">
    <!--
      M3-shell B1：标签栏从顶部横排改为**左缘竖排**（Blender properties 式）。
      类名 `.pt-tabs`/`.pt-tab`/`.pt-content` 与全部 tab 文案逐字保留 ——
      e2e 按文案定位（`kernel-undo-redo` 的「变换」、`input-routing` 的逐 tab 遍历）。
    -->
    <div class="pt-tabs" role="tablist" aria-orientation="vertical">
      <button
        v-for="p in panels"
        :key="p.id"
        class="pt-tab"
        :class="{ 'pt-tab--active': activeId === p.id }"
        :title="p.label"
        role="tab"
        :aria-selected="activeId === p.id"
        @click="selectTab(p.id)"
      >
        <span class="pt-tab-icon" aria-hidden="true">{{ glyphFor(p) }}</span>
        <span class="pt-tab-label">{{ p.label }}</span>
      </button>
    </div>
    <div class="pt-content">
      <component
        v-if="activePanel?.component"
        :is="activePanel.component"
        :ctx="ctx"
        :title="activePanel.label"
        :fragment="activePanel.layout"
      />
      <ReadonlyLayout
        v-else-if="activePanel"
        :layout="activePanel.layout"
        @operator="(id: string, p?: Record<string, unknown>) => onOperator(id, p)"
      />
    </div>
  </div>
</template>

<style scoped>
.pt-root {
  display: flex;
  flex-direction: row;
  height: 100%;
  min-height: 0;
}
/* 左缘竖排标签栏：窄栏 + 可纵向滚动（面板多时仍可点到最后一个）。 */
.pt-tabs {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  width: 58px;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--wb-bg-surface);
  border-right: 1px solid var(--wb-border);
  padding: 4px 0;
}
.pt-tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 8px 2px 6px;
  border: none;
  border-left: 2px solid transparent;
  background: transparent;
  color: var(--wb-text-muted);
  font-size: 10px;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.pt-tab:hover {
  color: var(--wb-text);
  background: var(--wb-bg-hover);
}
.pt-tab--active {
  color: var(--wb-text);
  border-left-color: var(--wb-accent);
  background: var(--wb-bg-hover);
  font-weight: 500;
}
.pt-tab:focus-visible {
  outline: 2px solid var(--wb-accent);
  outline-offset: -2px;
  border-radius: 2px;
}
.pt-tab-icon {
  font-size: 15px;
  line-height: 1;
}
.pt-tab-label {
  display: block;
  font-weight: inherit;
  max-width: 54px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 10px;
  line-height: 1.2;
}
.pt-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 10px 12px;
}
</style>
