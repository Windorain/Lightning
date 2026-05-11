<script setup lang="ts">
/**
 * World 多帧：播放/暂停。状态来自 PreviewSceneContext（由 AppShell 提供 store）。
 */
import { computed, inject } from 'vue'

import { PreviewSceneContextKey } from '@/preview/sceneStore'

const store = inject(PreviewSceneContextKey)

const visible = computed(() => store?.hasWorldMultiFrame.value ?? false)
const playing = computed(() => store?.framesPlaybackIsPlaying.value ?? false)

function onToggle(): void {
  store?.toggleWorldFramesPlayback()
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
