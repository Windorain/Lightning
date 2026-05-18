<script setup lang="ts">
/**
 * 嵌入根：bootstrap → View3DConfig → EmbedViewer。
 */
import { ref, watch } from 'vue'

import EmbedShell from '@/embed/EmbedShell.vue'
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
    console.error('[EmbedRoot] resolveBootstrapToView3DConfig', e)
  }
}

watch(
  () => props.bootstrap,
  () => { void load() },
  { deep: true, immediate: true },
)
</script>

<template>
  <div v-if="loadError" class="embed-boot embed-boot--err">
    {{ loadError }}
  </div>
  <EmbedShell v-else-if="mergedConfig" :config="mergedConfig" />
  <div v-else class="embed-boot">
    加载中…
  </div>
</template>

<style scoped>
.embed-boot {
  padding: 16px;
  font-family: system-ui, sans-serif;
  color: var(--nei-text);
  background: var(--nei-viewport-bg);
  min-height: 40vh;
}
.embed-boot--err {
  color: var(--nei-error-text);
  white-space: pre-wrap;
}
</style>
