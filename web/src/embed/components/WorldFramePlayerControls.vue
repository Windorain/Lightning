<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  hasWorldMultiFrame: boolean
  isPlaying: boolean
}>()

const emit = defineEmits<{
  toggle: []
}>()

const visible = computed(() => props.hasWorldMultiFrame)
const playing = computed(() => props.isPlaying)

function onToggle(): void {
  emit('toggle')
}
</script>

<template>
  <div v-if="visible" class="wm-wfp-controls">
    <button
      type="button"
      class="nei-ctrl-btn"
      :class="{ 'nei-ctrl-btn--active': playing }"
      :title="playing ? '暂停多帧轮播' : '播放 World.frames 多帧'"
      :aria-pressed="playing"
      @click="onToggle"
    >
      <svg v-if="playing" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
      <svg v-else viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
    </button>
  </div>
</template>

<style scoped>
.wm-wfp-controls {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}
.nei-ctrl-btn {
  width: 34px; height: 34px;
  border: 3px solid;
  border-color: var(--nei-bevel-light) var(--nei-bevel-dark) var(--nei-bevel-dark) var(--nei-bevel-light);
  background: var(--nei-bg-elevated);
  color: var(--nei-icon-color);
  font-size: 15px;
  font-weight: bold;
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.nei-ctrl-btn:hover { color: var(--nei-text); }
.nei-ctrl-btn--active {
  border-color: var(--nei-accent-border-light) var(--nei-accent-border-dark) var(--nei-accent-border-dark) var(--nei-accent-border-light);
  background: rgba(80, 80, 160, 0.2);
  color: var(--nei-text-accent);
}
</style>
