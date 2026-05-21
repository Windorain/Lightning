<script setup lang="ts">
import { useBContext } from '@/workbench/context/bContext'

const props = defineProps<{
  opId: string
  label: string
  icon?: string
  title?: string
  operatorProps?: Record<string, unknown>
}>()

const bctx = useBContext()

function onClick() {
  bctx.operators.exec(props.opId, props.operatorProps ?? {})
}
</script>

<template>
  <button
    class="ux-operator-btn"
    :class="{
      'ux-operator-btn--icon-only': !label,
      'ux-operator-btn--active': !label && operatorProps?.active
    }"
    :data-op-id="opId"
    :data-props="operatorProps ? JSON.stringify(operatorProps) : undefined"
    :title="title ?? label"
    @click="onClick"
  >
    <span v-if="icon" class="ux-icon" v-html="icon"></span>
    <template v-if="label">{{ label }}</template>
  </button>
</template>

<style scoped>
.ux-operator-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-bg-surface);
  color: var(--wb-accent-muted);
  cursor: pointer;
  font-size: 13px;
  line-height: 1.4;
  width: 100%;
  transition: background 0.15s, border-color 0.15s;
}
.ux-operator-btn:hover {
  background: var(--wb-bg-hover);
  border-color: var(--wb-accent);
  color: var(--wb-text);
}
.ux-operator-btn--primary {
  border-color: var(--wb-accent);
  background: var(--wb-bg-hover);
  color: var(--wb-accent);
  font-weight: 500;
}
.ux-operator-btn--danger {
  border-color: var(--wb-danger-bg);
  color: var(--wb-danger);
}
.ux-operator-btn--danger:hover {
  border-color: var(--wb-danger);
  background: var(--wb-danger-bg);
}
.ux-operator-btn:disabled {
  color: var(--wb-text-dim);
  cursor: default;
}
.ux-operator-btn--icon-only {
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: var(--wb-radius-md);
  justify-content: center;
  border: 1px solid transparent;
  background: transparent;
}
.ux-operator-btn--icon-only:hover {
  background: var(--wb-bg-hover);
  border-color: var(--wb-border);
}
.ux-operator-btn--active {
  background: var(--wb-bg-hover) !important;
  border-color: var(--wb-accent) !important;
  box-shadow: 0 0 10px rgba(77, 171, 247, 0.2);
}
.ux-icon {
  font-size: 14px;
  display: inline-flex;
  align-items: center;
}
.ux-icon :deep(svg) {
  width: 18px;
  height: 18px;
  display: block;
}
</style>
