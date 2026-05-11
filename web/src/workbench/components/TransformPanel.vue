<script setup lang="ts">
defineProps<{ selectionCount?: number }>()
</script>

<template>
  <div class="transform-panel">
    <h4 class="tp-heading">Transform</h4>
    <p class="tp-info" v-if="selectionCount">{{ selectionCount }} block(s) selected</p>
    <p class="tp-info" v-else>No selection</p>
  </div>
</template>

<style scoped>
.transform-panel { padding: 12px; color: var(--nei-text-dark); font-size: 12px; }
.tp-heading { margin: 0 0 4px; font-size: 12px; font-weight: 600; }
.tp-info { margin: 0; color: var(--nei-muted); }
</style>
