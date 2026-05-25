<script setup lang="ts">
/**
 * EmbedRoot — 嵌入场景的 bctx Owner。
 *
 * 对齐 WorkbenchRoot：
 * - 注册 parser → 解析 bootstrap → RuntimeDocument
 * - 创建 embed bctx（createEmbedContext）
 * - 提供 bctx 给子树
 * - EmbedViewport 消费 bctx
 */
import { ref, watch } from 'vue'
import type { EmbedBootstrapOptions } from '@/embed/embedContract'
import type { EmbedSettings } from '@/preview/previewConfig'
import { formatUnknownError } from '@/util/formatUnknownError'
import { parserRegistry } from '@/workbench/context/parserRegistry'
import { V2PlainParser } from '@/workbench/context/parsers/v2PlainParser'
import { EnvelopeParser } from '@/workbench/context/parsers/envelopeParser'
import { WorldParser } from '@/workbench/context/parsers/worldParser'
import { StructureDataParser } from '@/workbench/context/parsers/structureDataParser'
import { createEmbedContext, provideEmbedBContext } from '@/embed/embedContext'
import EmbedViewport from '@/embed/EmbedViewport.vue'
import { defaultEmbedUi } from '@/preview/previewConfig'
import type { View3DFeatures } from '@/preview/previewConfig'

// ---- 注册 parser（与 WorkbenchRoot 对齐） ----
parserRegistry.register(V2PlainParser)
parserRegistry.register(EnvelopeParser)
parserRegistry.register(WorldParser)
parserRegistry.register(StructureDataParser)

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

// ---- 同步创建 bctx + provide（Vue 要求 setup 期 provide） ----
const settings = buildEmbedSettings()
const bctx = createEmbedContext(settings)
provideEmbedBContext(bctx)

// ---- 异步解析 document → 填入 bctx.doc ----
const loadError = ref('')

async function load() {
  loadError.value = ''
  try {
    const rawDoc = props.bootstrap.data.document
    const result = await parserRegistry.detectAndParse(rawDoc)
    if (!result.document) {
      loadError.value = `无法解析文档（format: ${result.parser?.formatName ?? '未知'}）`
      return
    }
    bctx.doc.value = result.document
    bctx.markStructureDirty()
  } catch (e) {
    loadError.value = formatUnknownError(e)
    console.error('[EmbedRoot] parse', e)
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
  <EmbedViewport v-else-if="bctx.doc.value" />
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
