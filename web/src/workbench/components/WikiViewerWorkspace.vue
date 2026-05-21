<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import EmbedViewport from '@/embed/EmbedViewport.vue'
import UIRenderer from '@/workbench/ux/UIRenderer.vue'
import { useBContext } from '@/workbench/context/bContext'
import { sceneInfoPanel, wikiConfigPanel, blockStatsPanel } from '@/workbench/ux/panels'
import type { EmbedSettings, View3DFeatures } from '@/preview/previewConfig'
import { defaultEmbedUi } from '@/preview/previewConfig'

const bctx = useBContext()
const wikiConfig = bctx.wikiConfig as Record<string, any>

const wikiPanels = [sceneInfoPanel, wikiConfigPanel, blockStatsPanel]

const activeWikiPanels = computed(() =>
  wikiPanels
    .filter(p => p.poll(bctx))
    .map(p => ({ id: p.id, layout: p.layout(bctx), owner: p.owner?.(bctx) }))
)

const embedDocument = ref<unknown>(null)

function parseHex6(s: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s.trim())
  if (!m) return 0x5a5a5a
  return parseInt(m[1], 16)
}

const embedSettings = computed<EmbedSettings | null>(() => {
  if (!embedDocument.value) return null
  return {
    features: {
      ...defaultEmbedUi.features,
      ...(wikiConfig.features ?? {}),
    } as View3DFeatures,
    blockIconCacheOptions: {
      ...defaultEmbedUi.blockIconCacheOptions,
      sizePx: wikiConfig.iconSizePx ?? defaultEmbedUi.blockIconCacheOptions.sizePx,
      orthoHalf: wikiConfig.iconOrthoHalf ?? defaultEmbedUi.blockIconCacheOptions.orthoHalf,
    },
    initialLayerWorldY: defaultEmbedUi.initialLayerWorldY,
    initialCamera: {
      yawDeg: wikiConfig.cameraYaw,
      elevationDeg: wikiConfig.cameraElevation,
      zoom: wikiConfig.cameraZoom,
    },
    sceneBackground: parseHex6(wikiConfig.sceneBackgroundHex ?? '#5a5a5a'),
    loadingMessage: defaultEmbedUi.loadingMessage,
    okMessage: defaultEmbedUi.okMessage,
    debug: wikiConfig.features?.debugStatusBar ?? false,
  }
})

const renderKey = ref(0)

// Bump key when doc ref or structEpoch changes → fresh EmbedViewport
// NOT on in-place doc mutations (e.g. annotation) — those don't change the mesh
watch([() => bctx.doc.value, () => bctx.structEpoch.value], () => {
  embedDocument.value = bctx.doc.value?.toRaw() ?? null
  renderKey.value++
}, { immediate: true })
</script>

<template>
  <div class="ww-root">
    <div class="ww-preview-wrap">
      <div class="ww-preview" :style="{ width: `${wikiConfig.viewWidth ?? 800}px`, height: `${wikiConfig.viewHeight ?? 600}px` }">
        <EmbedViewport v-if="embedDocument && embedSettings" :key="renderKey" :document="embedDocument" :settings="embedSettings" />
        <div v-else class="ww-placeholder">No scene loaded</div>
      </div>
    </div>
    <div class="ww-panel">
      <UIRenderer
        v-for="panel in activeWikiPanels"
        :key="panel.id"
        :layout="panel.layout"
        :rna="bctx.rna"
        :owner="panel.owner"
      />
    </div>
  </div>
</template>

<style scoped>
.ww-root { display: flex; height: 100%; overflow: hidden; }
.ww-panel { flex-shrink: 0; width: 260px; border-left: 1px solid var(--nei-border); background: var(--nei-bg-deep); overflow-y: auto; }
.ww-preview-wrap { flex: 1; display: flex; align-items: flex-start; justify-content: center; padding: 16px; overflow: auto; background: var(--nei-viewport-bg); }
.ww-preview { border: 1px solid var(--nei-border); border-radius: 4px; overflow: hidden; flex-shrink: 0; }
.ww-placeholder { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--nei-muted); font-size: 14px; }
</style>
