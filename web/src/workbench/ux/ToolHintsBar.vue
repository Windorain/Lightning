<script setup lang="ts">
import type { ToolHint } from '@/workbench/tools/tool'

defineProps<{
  hints: ToolHint[]
}>()
</script>

<template>
  <div v-if="hints.length > 0" class="tool-hints-bar">
    <span
      v-for="(hint, i) in hints"
      :key="i"
      class="hint-item"
    >
      <span class="hint-keys">
        <kbd
          v-for="(k, j) in hint.keys"
          :key="j"
          class="hint-key"
        >{{ k }}</kbd>
      </span>
      <span class="hint-action">{{ hint.action }}</span>
    </span>
  </div>
</template>

<style scoped>
.tool-hints-bar {
  position: absolute;
  bottom: 8px;
  right: 8px;
  display: flex;
  gap: 12px;
  padding: 6px 12px;
  background: rgba(12, 16, 20, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  font-size: 12px;
  color: #b0b8c0;
  pointer-events: none;
  user-select: none;
  z-index: 200;
}

.hint-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.hint-keys {
  display: flex;
  gap: 2px;
  align-items: center;
}

.hint-key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 3px;
  font-family: inherit;
  font-size: 11px;
  color: #d0d8e0;
  line-height: 1;
}

.hint-key:not(:last-child)::after {
  content: '+';
  margin-left: 2px;
  margin-right: -3px;
  color: #606870;
}

.hint-action {
  color: #8890a0;
  white-space: nowrap;
}
</style>
