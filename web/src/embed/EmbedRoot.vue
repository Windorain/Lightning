<script setup lang="ts">
/**
 * EmbedRoot — 嵌入场景的 ctx Owner。
 *
 * - createEmbedHost + provideContext
 * - OPERATOR_LOAD_EMBED_DOCUMENT 加载 bootstrap 文档
 */
import { ref, watch } from 'vue'
import type { EmbedBootstrapOptions } from '@/embed/embedContract'
import type { EmbedSettings } from '@/preview/previewConfig'
import { formatUnknownError } from '@/util/formatUnknownError'
import { createEmbedHost } from '@/runtime/host/embedHost'
import { hostKey } from '@/runtime/host'
import { provide } from 'vue'
import EmbedViewport from '@/embed/EmbedViewport.vue'
import { defaultEmbedUi } from '@/preview/previewConfig'
import type { View3DFeatures } from '@/preview/previewConfig'

const props = defineProps<{
  bootstrap: EmbedBootstrapOptions
}>()

function buildEmbedSettings(): EmbedSettings {
  const ui = props.bootstrap.ui ?? {}
  const features = props.bootstrap.features ?? {}
  return {
    features: {
      ...defaultEmbedUi.features,
      ...features,
    } as View3DFeatures,
    blockIconCacheOptions: {
      ...defaultEmbedUi.blockIconCacheOptions,
      ...ui.blockIconCacheOptions,
    },
    initialLayerWorldY: ui.initialLayerWorldY ?? defaultEmbedUi.initialLayerWorldY,
    initialWorldFrameIndex: ui.initialWorldFrameIndex,
    initialCamera: ui.initialCamera,
    sceneBackground: ui.sceneBackground ?? defaultEmbedUi.sceneBackground,
    loadingMessage: ui.loadingMessage ?? defaultEmbedUi.loadingMessage,
    okMessage: ui.okMessage ?? defaultEmbedUi.okMessage,
    debug: ui.debug ?? defaultEmbedUi.debug,
  }
}

const settings = buildEmbedSettings()
const { host, ctx } = createEmbedHost(settings)
provide(hostKey, host)

const loadError = ref('')

async function load() {
  loadError.value = ''
  try {
    await ctx.getOperators().exec('OPERATOR_LOAD_EMBED_DOCUMENT', {
      document: props.bootstrap.data.document,
    })
  } catch (e) {
    loadError.value = formatUnknownError(e)
    console.error('[EmbedRoot] load', e)
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
  <EmbedViewport v-else-if="ctx.getDoc().value" :settings="settings" />
  <div v-else class="embed-boot embed-boot--loading">
    <div class="embed-boot-spinner"></div>
    <span>加载中…</span>
  </div>
</template>

<style scoped>
.embed-boot {
  padding: 16px;
  font-family: system-ui, sans-serif;
  color: var(--wb-text);
  background: var(--wb-viewport-bg);
  min-height: 40vh;
}
.embed-boot--loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 120px;
}
.embed-boot-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--nei-border-panel);
  border-top-color: var(--nei-accent);
  border-radius: 50%;
  animation: embed-spin 0.6s linear infinite;
}
@keyframes embed-spin {
  to { transform: rotate(360deg); }
}
.embed-boot--err {
  color: #fecaca;
  white-space: pre-wrap;
}
</style>
