<script setup lang="ts">
import { computed } from 'vue'
import WorkbenchViewport from './WorkbenchViewport.vue'
import { useBContext } from '@/workbench/context/bContext'
import { ALL_FEATURES_OFF, type PreviewConfig } from '@/preview/previewConfig'

const bctx = useBContext()

const mergedConfig = computed<PreviewConfig | null>(() => {
  const c = bctx.scene.previewConfig.value
  if (!c) return null
  return { ...c, features: { ...c.features, ...ALL_FEATURES_OFF, frameControls: true, layerBar: true } }
})
</script>

<template>
  <div class="vh-root">
    <WorkbenchViewport
      v-if="mergedConfig"
      :merged-config="mergedConfig"
    />
    <div v-else class="vh-placeholder"><span class="vh-placeholder-text">No scene loaded</span></div>
  </div>
</template>

<style scoped>
.vh-root { width: 100%; height: 100%; }
.vh-placeholder { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--nei-muted); font-size: 14px; }
</style>
