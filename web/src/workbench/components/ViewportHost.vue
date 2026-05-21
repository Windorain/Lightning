<script setup lang="ts">
import { computed, watch } from 'vue'
import WorkbenchViewport from './WorkbenchViewport.vue'
import { useBContext } from '@/workbench/context/bContext'
import { ALL_FEATURES_OFF } from '@/preview/previewConfig'
import type { View3DConfig } from '@/preview/previewConfig'
import { view3DConfigFromDocument } from '@/preview/previewFromDocument'

const bctx = useBContext()

const hasScene = computed(() => bctx.doc.value !== null && bctx.materialLibrary.value !== null)

// Build minimal View3DConfig for mesh rebuild (reloadFromConfig still needs it)
async function buildMinimalConfig(): Promise<void> {
  const doc = bctx.doc.value?.toRaw()
  if (!doc) { bctx.config.value = null; return }
  try {
    const cfg: View3DConfig = await view3DConfigFromDocument({ ...doc as Record<string, unknown> })
    cfg.features = { ...cfg.features, ...ALL_FEATURES_OFF, frameControls: true, layerBar: true }
    bctx.config.value = cfg
  } catch { bctx.config.value = null }
}

// Watch structEpoch to rebuild config
watch(() => bctx.structEpoch.value, () => { void buildMinimalConfig() }, { immediate: true })
</script>

<template>
  <div class="vh-root">
    <WorkbenchViewport
      v-if="hasScene"
      :material-library="bctx.materialLibrary.value!"
      :scene-background="0x5a5a5a"
      :show-axes-gizmo="true"
      :struct-epoch="bctx.structEpoch.value"
    />
    <div v-else class="vh-placeholder"><span class="vh-placeholder-text">No scene loaded</span></div>
  </div>
</template>

<style scoped>
.vh-root { width: 100%; height: 100%; }
.vh-placeholder { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--nei-muted); font-size: 14px; }
</style>
