<script setup lang="ts">
/**
 * World 多帧时间轴：拖动时只更新本地显示，松开后才触发帧切换。
 */
import { computed, inject, ref, watch } from 'vue'

import { PreviewSceneContextKey } from '@/preview/sceneStore'

const store = inject(PreviewSceneContextKey)

const visible = computed(() => store?.hasWorldMultiFrame.value ?? false)
const frameCount = computed(() => store?.worldFrameCount.value ?? 0)
const isPlaying = computed(() => store?.framesPlaybackIsPlaying.value ?? false)
const meshBusy = computed(() => store?.meshBusy.value ?? false)

const maxIdx = computed(() => Math.max(0, frameCount.value - 1))

const localIdx = ref(store?.worldFrameIndex.value ?? 0)
const dragging = ref(false)

watch(() => store?.worldFrameIndex.value ?? 0, (v) => {
  if (!dragging.value) localIdx.value = v
})

const fillPct = computed(() => {
  if (frameCount.value <= 1) return 0
  return (localIdx.value / maxIdx.value) * 100
})

function onInput(e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  localIdx.value = v
}

function onPointerDown(): void {
  dragging.value = true
  if (isPlaying.value) store?.toggleWorldFramesPlayback()
}

function onChange(e: Event): void {
  dragging.value = false
  const v = Number((e.target as HTMLInputElement).value)
  localIdx.value = v
  store?.setCurrentWorldFrame(v)
}
</script>

<template>
  <div v-if="visible" class="wm-wfs" :class="{ 'wm-wfs--busy': meshBusy }">
    <div class="nei-slider">
      <div class="nei-slider__track" />
      <div class="nei-slider__fill" :style="{ width: `${fillPct}%` }" />
      <input
        class="nei-slider__range"
        type="range"
        :min="0"
        :max="maxIdx"
        :value="localIdx"
        :disabled="meshBusy"
        :aria-label="`当前帧，共 ${frameCount} 帧`"
        :aria-valuetext="`帧 ${localIdx + 1}，共 ${frameCount} 帧`"
        :aria-valuemin="0"
        :aria-valuemax="maxIdx"
        :aria-valuenow="localIdx"
        @pointerdown="onPointerDown"
        @input="onInput"
        @change="onChange"
      />
    </div>
    <span class="wm-wfs__label" aria-hidden="true">{{ localIdx + 1 }} / {{ frameCount }}</span>
  </div>
</template>

<style scoped>
.wm-wfs { display: flex; flex: 1; min-width: 0; align-items: center; gap: 10px; user-select: none; }
.wm-wfs--busy { opacity: 0.65; pointer-events: none; }
.wm-wfs__label { flex-shrink: 0; font-size: 11px; font-family: ui-monospace, 'Cascadia Code', monospace; color: var(--nei-text-muted); text-shadow: 0 1px 0 rgba(0, 0, 0, 0.4); min-width: 4.5em; text-align: right; }
</style>
