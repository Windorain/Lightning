<script setup lang="ts">
/**
 * 嵌入根：显式 bootstrap → View3DConfig → EmbedViewer。
 */
import { ref, watch } from 'vue'

import EmbedViewer from '@/embed/EmbedViewer.vue'
import type { View3DConfig } from '@/preview/previewConfig'
import { resolveBootstrapToView3DConfig, type EmbedBootstrapOptions } from '@/embed/embedContract'
import { formatUnknownError } from '@/util/formatUnknownError'

const props = defineProps<{
  bootstrap: EmbedBootstrapOptions
}>()

const mergedConfig = ref<View3DConfig | null>(null)
const loadError = ref<string | null>(null)

async function load() {
  loadError.value = null
  mergedConfig.value = null
  try {
    mergedConfig.value = await resolveBootstrapToView3DConfig(props.bootstrap)
  } catch (e) {
    loadError.value = formatUnknownError(e)
    console.error('[StructureRenderer] resolveBootstrapToView3DConfig', e)
  }
}

watch(
  () => props.bootstrap,
  () => {
    void load()
  },
  { deep: true, immediate: true },
)
</script>

<template>
  <div v-if="loadError" class="wm-boot wm-boot--err">
    {{ loadError }}
  </div>
  <EmbedViewer v-else-if="mergedConfig" :config="mergedConfig" />
  <div v-else class="wm-boot">
    加载中…
  </div>
</template>

<style scoped>
.wm-boot {
  padding: 16px;
  font-family: system-ui, sans-serif;
  color: var(--nei-text);
  background: var(--nei-viewport-bg);
  min-height: 40vh;
}
.wm-boot--err {
  color: var(--nei-error-text);
  white-space: pre-wrap;
}
</style>
