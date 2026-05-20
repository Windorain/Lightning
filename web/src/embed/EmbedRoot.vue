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
import type { View3DConfig } from '@/preview/previewConfig'
import { resolveBootstrapToView3DConfig, type EmbedBootstrapOptions } from '@/embed/embedContract'
import { createEmbedBContext, provideEmbedBContext } from '@/embed/embedContext'
import { formatUnknownError } from '@/util/formatUnknownError'

const props = defineProps<{
  bootstrap: EmbedBootstrapOptions
}>()

const mergedConfig = ref<View3DConfig | null>(null)
const loadError = ref<string | null>(null)
let bctx: ReturnType<typeof createEmbedBContext> | null = null
let _provided = false

function ensureBContext(config: View3DConfig) {
  if (!bctx) {
    bctx = createEmbedBContext(config)
  }
  if (!_provided) {
    provideEmbedBContext(bctx)
    _provided = true
  }
  return bctx
}

async function load() {
  loadError.value = null
  mergedConfig.value = null
  try {
    const cfg = await resolveBootstrapToView3DConfig(props.bootstrap)
    mergedConfig.value = cfg
    ensureBContext(cfg)
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
  <EmbedViewport v-else-if="mergedConfig && bctx" :config="mergedConfig" />
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
