<script setup lang="ts">
import { ref } from 'vue'
import type { UIOperator, UILabel, UISeparator } from './types/layout'

defineProps<{
  label: string
  icon?: string
  items: (UIOperator | UILabel | UISeparator)[]
}>()

const open = ref(false)

function toggle() { open.value = !open.value }
function close() { open.value = false }
</script>

<template>
  <div class="ux-menu" @mouseleave="close">
    <button class="ux-menu-btn" @click="toggle">
      <span v-if="icon" class="ux-icon">{{ icon }}</span>
      {{ label }}
      <span class="ux-arrow">▼</span>
    </button>
    <div v-if="open" class="ux-menu-dropdown">
      <template v-for="(item, i) in items" :key="i">
        <hr v-if="item.kind === 'separator'" class="ux-menu-sep" />
        <span v-else-if="item.kind === 'label'" class="ux-menu-label">{{ item.text }}</span>
        <button
          v-else-if="item.kind === 'operator'"
          class="ux-menu-item"
          @click="close"
        >
          <span v-if="item.icon" class="ux-icon">{{ item.icon }}</span>
          {{ item.label }}
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ux-menu { position: relative; }
.ux-menu-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid var(--ui-border, #555);
  border-radius: 3px;
  background: var(--ui-btn-bg, #3a3a3a);
  color: var(--ui-text, #ccc);
  cursor: pointer;
  font-size: 12px;
}
.ux-arrow { font-size: 10px; }
.ux-menu-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  min-width: 160px;
  background: var(--ui-dropdown-bg, #333);
  border: 1px solid var(--ui-border, #555);
  border-radius: 4px;
  z-index: 2100;
  padding: 4px 0;
}
.ux-menu-item {
  display: block;
  width: 100%;
  padding: 4px 12px;
  border: none;
  background: transparent;
  color: var(--ui-text, #ccc);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.ux-menu-item:hover { background: var(--ui-item-hover, #4a4a4a); }
.ux-menu-label {
  display: block;
  padding: 2px 12px;
  font-size: 10px;
  color: var(--ui-label, #999);
}
.ux-menu-sep {
  margin: 4px 8px;
  border: none;
  border-top: 1px solid var(--ui-border, #555);
}
</style>
