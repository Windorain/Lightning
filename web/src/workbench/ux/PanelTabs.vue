<script setup lang="ts">
import { ref, watch, computed, type Component } from 'vue'
import UIRenderer from './UIRenderer.vue'
import type { RNARegistry } from './rna/types'
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
  rna: RNARegistry
  bctx?: unknown
}>()

const activeId = ref<string | null>(null)
let prevIds = new Set<string>()

// Auto-select: newly appeared panels take priority, otherwise preserve current
watch(
  () => props.panels,
  (list) => {
    if (list.length === 0) {
      activeId.value = null
      prevIds = new Set()
      return
    }
    const curIds = new Set(list.map(p => p.id))
    // New panel appeared — switch to it
    const added = list.find(p => !prevIds.has(p.id))
    if (added) {
      activeId.value = added.id
    } else if (!list.find(p => p.id === activeId.value)) {
      // Current panel removed — fall back to first
      activeId.value = list[0].id
    }
    prevIds = curIds
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
</script>

<template>
  <div class="pt-root" v-if="panels.length > 0">
    <div class="pt-tabs">
      <button
        v-for="p in panels"
        :key="p.id"
        class="pt-tab"
        :class="{ 'pt-tab--active': activeId === p.id }"
        @click="selectTab(p.id)"
        :title="p.label"
      >
        <span v-if="p.icon" class="pt-tab-icon">{{ p.icon }}</span>
        <span class="pt-tab-label">{{ p.label }}</span>
      </button>
    </div>
    <div class="pt-content">
      <component
        v-if="activePanel?.component"
        :is="activePanel.component"
        :bctx="bctx"
      />
      <UIRenderer
        v-else-if="activePanel"
        :layout="activePanel.layout"
        :rna="rna"
        :owner="activePanel.owner"
      />
    </div>
  </div>
</template>

<style scoped>
.pt-root {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.pt-tabs {
  flex-shrink: 0;
  display: flex;
  background: var(--wb-bg-surface);
  overflow-x: auto;
  height: 34px;
  position: relative;
}
.pt-tabs::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent 0%, var(--wb-border) 20%, var(--wb-border) 80%, transparent 100%);
}
.pt-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 16px;
  border: none;
  background: transparent;
  color: var(--wb-text-muted);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.pt-tab:hover {
  color: var(--wb-text);
  background: var(--wb-bg-hover);
}
.pt-tab--active {
  color: var(--wb-text);
  border-bottom-color: var(--wb-accent);
  font-weight: 500;
}
.pt-tab:focus-visible {
  outline: 2px solid var(--wb-accent);
  outline-offset: -2px;
  border-radius: 2px;
}
.pt-tab-icon {
  font-size: 14px;
  line-height: 1;
}
.pt-tab-label {
  font-weight: inherit;
}
.pt-content {
  flex: 1;
  overflow-y: auto;
  padding: 10px 12px;
}
</style>
