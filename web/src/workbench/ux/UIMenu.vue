<script setup lang="ts">
import { ref } from 'vue'
import { useBContext } from '@/workbench/context/bContext'
import type { UIOperator, UILabel, UISeparator } from './types/layout'

defineProps<{
  label: string
  icon?: string
  items: (UIOperator | UILabel | UISeparator)[]
}>()

const bctx = useBContext()
const open = ref(false)

function toggle() { open.value = !open.value }
function close() { open.value = false }
function invokeOp(op: UIOperator) {
  close()
  bctx.operators.invoke(op.id, op.props ?? {})
}
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
          @click="invokeOp(item)"
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
  padding: 4px 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-bg-surface);
  color: var(--wb-accent-muted);
  cursor: pointer;
  font-size: 11px;
}
.ux-menu-btn:hover { background: var(--wb-bg-hover); }
.ux-arrow { font-size: 8px; }
.ux-menu-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  min-width: 160px;
  background: var(--wb-bg-elevated);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  z-index: 2100;
  padding: 4px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
}
.ux-menu-item {
  display: block;
  width: 100%;
  padding: 5px 12px;
  border: none;
  background: transparent;
  color: var(--wb-text);
  font-size: 11px;
  text-align: left;
  cursor: pointer;
  border-radius: var(--wb-radius-sm);
}
.ux-menu-item:hover { background: var(--wb-bg-hover); }
.ux-menu-label {
  display: block;
  padding: 5px 12px 3px;
  font-size: 9px;
  color: var(--wb-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.ux-menu-sep {
  margin: 4px 8px;
  border: none;
  border-top: 1px solid var(--wb-border);
}
</style>
