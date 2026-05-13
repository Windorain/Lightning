<script setup lang="ts">
import { useBContext } from '@/workbench/context/bContext'

const props = defineProps<{
  opId: string
  label: string
  icon?: string
  operatorProps?: Record<string, unknown>
}>()

const bctx = useBContext()

function onClick() {
  bctx.operators.invoke(props.opId, props.operatorProps ?? {})
}
</script>

<template>
  <button
    class="ux-operator-btn"
    :data-op-id="opId"
    @click="onClick"
  >
    <span v-if="icon" class="ux-icon">{{ icon }}</span>
    {{ label }}
  </button>
</template>

<style scoped>
.ux-operator-btn {
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
  line-height: 1.4;
  width: 100%;
}
.ux-operator-btn:hover {
  background: var(--ui-btn-hover, #555);
}
.ux-icon {
  font-size: 14px;
}
</style>
