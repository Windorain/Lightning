<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import { View3DContextKey } from '@/preview/sceneStore'

const store = inject(View3DContextKey)
if (!store) throw new Error('LayerPreviewBar: PreviewSceneContext missing')

const { layerPreviewLabel, gridHeight, meshBusy } = store

const localY = ref<number>(store.layerWorldY.value)

// 非 busy 时同步 store 值到本地
watch(() => store!.layerWorldY.value, (v) => {
  if (!meshBusy.value) localY.value = v
})

const maxY = computed(() => Math.max(0, gridHeight.value - 1))

function onInput(e: Event): void {
  localY.value = Number((e.target as HTMLInputElement).value)
}

function onChange(e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  localY.value = v
  store!.layerWorldY.value = v
}
</script>

<template>
  <div v-if="gridHeight > 0" class="wm-layer-bar">
    <label class="wm-layer-label" for="wm-layer-range">分层预览</label>
    <div class="nei-slider">
      <div class="nei-slider__track" />
      <div class="nei-slider__fill" :style="{ width: `${(localY + 1) / (maxY + 1) * 100}%` }" />
      <input
        id="wm-layer-range"
        class="nei-slider__range"
        type="range"
        :min="-1"
        :max="maxY"
        step="1"
        :value="localY"
        :disabled="meshBusy"
        aria-label="分层预览：ALL 或按世界 Y 单层显示"
        @input="onInput"
        @change="onChange"
      />
    </div>
    <span class="wm-layer-value" aria-live="polite">{{ layerPreviewLabel }}</span>
  </div>
</template>

<style scoped>
.wm-layer-bar { display: flex; align-items: center; gap: 10px; padding: 0; background: transparent; font-size: 11px; color: var(--nei-text); width: 100%; }
.wm-layer-label { flex-shrink: 0; user-select: none; }
.wm-layer-value { flex-shrink: 0; min-width: 4.5em; text-align: right; color: var(--nei-text-dim); font-family: ui-monospace, monospace; }
</style>
