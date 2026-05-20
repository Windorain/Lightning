<script setup lang="ts">
/**
 * World 多帧：播放/暂停。状态来自 PreviewSceneContext（由 AppShell 提供 store）。
 */
import { computed, inject } from 'vue'

import { View3DContextKey } from '@/preview/sceneStore'

const store = inject(View3DContextKey)

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
      class="nei-ctrl-btn"
      :class="{ 'nei-ctrl-btn--active': playing }"
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
.nei-ctrl-btn {
  width: 34px; height: 34px;
  border: 3px solid;
  border-color: var(--nei-bevel-light) var(--nei-bevel-dark) var(--nei-bevel-dark) var(--nei-bevel-light);
  background: #3a3e4a;
  color: #c0c0c0;
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
  background: #3a3e60;
  color: #c0c0f0;
}
</style>
