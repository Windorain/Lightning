<script setup lang="ts">
/**
 * 工作空间标签栏。
 */
defineProps<{ modelValue: 'preview' | 'wiki' | 'export' }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: 'preview' | 'wiki' | 'export'): void }>()
import { t } from '@/workbench/i18n'

const tabs = [
  { id: 'preview' as const },
  { id: 'wiki' as const },
  { id: 'export' as const },
]
</script>

<template>
  <div class="wt-root">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      class="wt-tab"
      :class="{ 'wt-tab--active': modelValue === tab.id }"
      @click="emit('update:modelValue', tab.id)"
    >
      {{ t(tab.id) }}
    </button>
  </div>
</template>

<style scoped>
.wt-root {
  display: flex; align-items: stretch; height: 100%;
  padding: 0 6px; gap: 1px;
}
.wt-tab {
  padding: 0 14px; border: none; background: transparent;
  color: var(--nei-tab-text); font-size: 12px; cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}
.wt-tab:hover { color: var(--nei-text-dark); }
.wt-tab--active { color: var(--nei-tab-active-text); border-bottom-color: var(--nei-tab-active-border); }
</style>
