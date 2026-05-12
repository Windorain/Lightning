<script setup lang="ts">
import { computed } from 'vue'
import { useSelectionContext } from '@/workbench/selectionContext'

const selection = useSelectionContext()
const selectionCount = computed(() => selection.items.value.size)
</script>

<template>
  <div class="transform-panel">
    <h4 class="tp-heading">Transform</h4>
    <p class="tp-info">{{ selectionCount }} block(s) selected</p>
  </div>
</template>

<style scoped>
.transform-panel { padding: 12px; color: var(--nei-text-dark); font-size: 12px; }
.tp-heading { margin: 0 0 4px; font-size: 12px; font-weight: 600; }
.tp-info { margin: 0; color: var(--nei-muted); }
</style>
