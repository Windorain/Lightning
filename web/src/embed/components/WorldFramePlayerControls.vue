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
      class="nei-btn wm-wfp-btn"
      :title="playing ? '暂停多帧轮播' : '播放 World.frames 多帧'"
      :aria-pressed="playing"
      @click="onToggle"
    >
      {{ playing ? '⏸' : '▶' }}
    </button>
  </div>
</template>

<style scoped>
.wm-wfp-controls {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}
</style>
