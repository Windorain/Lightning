<script setup lang="ts">
defineProps<{ selectionCount?: number }>()
</script>

<template>
  <div class="batch-panel">
    <h4 class="bp-heading">Batch Edit</h4>
    <p class="bp-info" v-if="selectionCount">{{ selectionCount }} block(s) selected</p>
    <p class="bp-info" v-else>Select multiple blocks to batch edit</p>
  </div>
</template>

<style scoped>
.batch-panel { padding: 12px; color: var(--nei-text-dark); font-size: 12px; }
.bp-heading { margin: 0 0 4px; font-size: 12px; font-weight: 600; }
.bp-info { margin: 0; color: var(--nei-muted); }
</style>
