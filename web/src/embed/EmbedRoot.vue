<script setup lang="ts">
/**
 * EmbedRoot — 嵌入场景的 bctx Owner。
 *
 * 对齐 WorkbenchRoot：
 * - 解析 bootstrap → View3DConfig
 * - 创建 embed bctx（createEmbedBContext）
 * - 提供 bctx 给子树
 * - EmbedViewport 消费 bctx
 */
import { ref, watch } from 'vue'

import EmbedViewport from '@/embed/EmbedViewport.vue'
import type { EmbedSettings } from '@/preview/previewConfig'
import { embedSettingsFromConfig } from '@/preview/previewConfig'
import { resolveBootstrapToView3DConfig, type EmbedBootstrapOptions } from '@/embed/embedContract'
import { formatUnknownError } from '@/util/formatUnknownError'

const props = defineProps<{
  bootstrap: EmbedBootstrapOptions
}>()

const embedDocument = ref<unknown>(null)
const embedSettings = ref<EmbedSettings | null>(null)
const loadError = ref<string | null>(null)

async function load() {
  loadError.value = null
  embedDocument.value = null
  embedSettings.value = null
  try {
    const cfg = await resolveBootstrapToView3DConfig(props.bootstrap)
    embedDocument.value = cfg.renderBundle.document
    embedSettings.value = embedSettingsFromConfig(cfg)
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
  <EmbedViewport v-else-if="embedDocument && embedSettings" :document="embedDocument" :settings="embedSettings" />
  <div v-else class="embed-boot">
    加载中…
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
.embed-boot--err {
  color: #fecaca;
  white-space: pre-wrap;
}
</style>
