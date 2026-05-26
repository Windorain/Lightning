<script setup lang="ts">
import type { ToolHint } from '@/workbench/tools/tool'

defineProps<{
  hints: ToolHint[]
}>()
</script>

<template>
  <Transition name="hints-bar">
    <div v-if="hints.length > 0" :key="hints.map(h => h.keys.join('+') + h.action).join('|')" class="tool-hints-bar">
      <span
        v-for="(hint, i) in hints"
        :key="i"
        class="hint-group"
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
  </Transition>
</template>

<style scoped>
.tool-hints-bar {
  position: absolute;
  bottom: 12px;
  right: 12px;
  display: flex;
  gap: 0;
  padding: 6px 8px;
  background: rgba(8, 13, 18, 0.92);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--wb-radius-lg, 6px);
  font-family: var(--wb-font-mono, 'JetBrains Mono', monospace);
  font-size: 12px;
  color: var(--wb-text-muted, #889eb8);
  pointer-events: none;
  user-select: none;
  z-index: 200;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
}

/* -- hint groups separated by a subtle vertical rule -- */
.hint-group {
  display: flex;
  align-items: center;
  gap: 0;
}

.hint-group + .hint-group {
  margin-left: 2px;
  padding-left: 8px;
  border-left: 1px solid rgba(255, 255, 255, 0.08);
}

/* -- keys container -- */
.hint-keys {
  display: flex;
  gap: 0;
  align-items: center;
  margin-right: 6px;
}

/* -- 3D keycap: gradient face + bottom thickness + inset highlight -- */
.hint-key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 21px;
  padding: 0 5px;
  font-family: inherit;
  font-size: 11px;
  font-weight: 500;
  color: var(--wb-text, #c5d8e8);
  line-height: 1;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.09) 0%, rgba(255, 255, 255, 0.04) 100%);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-bottom: 2px solid rgba(255, 255, 255, 0.18);
  border-radius: var(--wb-radius-sm, 3px);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.06),
    0 1px 2px rgba(0, 0, 0, 0.35);
}

.hint-key + .hint-key {
  margin-left: 4px;
}

/* "plus" rendered via CSS to keep DOM clean */
.hint-keys .hint-key + .hint-key::before {
  content: '+';
  margin-right: 4px;
  color: var(--wb-text-dim, #6a7e96);
}

/* -- action label -- */
.hint-action {
  color: var(--wb-text-muted, #889eb8);
  white-space: nowrap;
  font-size: 12px;
  letter-spacing: 0.02em;
}

/* -- Vue transition: fade + slide on hint change -- */
.hints-bar-enter-active {
  transition: opacity 200ms cubic-bezier(0.16, 1, 0.3, 1), transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
}
.hints-bar-leave-active {
  transition: opacity 120ms ease, transform 120ms ease;
}
.hints-bar-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.hints-bar-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
