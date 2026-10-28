<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  hasWorldMultiFrame: boolean
  frameCount: number
  isPlaying: boolean
  meshBusy: boolean
  worldFrameIndex: number
}>()

const emit = defineEmits<{
  togglePlayback: []
  setFrame: [index: number]
}>()

const visible = computed(() => props.hasWorldMultiFrame)

const maxIdx = computed(() => Math.max(0, props.frameCount - 1))

const localIdx = ref(props.worldFrameIndex)
const dragging = ref(false)

watch(() => props.worldFrameIndex, (v) => {
  if (!dragging.value) localIdx.value = v
})

const fillPct = computed(() => {
  if (props.frameCount <= 1) return 0
  return (localIdx.value / maxIdx.value) * 100
})

function onInput(e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  localIdx.value = v
}

function onPointerDown(): void {
  dragging.value = true
  if (props.isPlaying) emit('togglePlayback')
}

function onChange(e: Event): void {
  dragging.value = false
  const v = Number((e.target as HTMLInputElement).value)
  localIdx.value = v
  emit('setFrame', v)
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
.wm-wfs__label { flex-shrink: 0; font-size: 10px; font-family: var(--nei-font-mono); color: var(--nei-text-mono); min-width: 4.5em; text-align: right; }
</style>
