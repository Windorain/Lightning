<script setup lang="ts">
import { computed } from 'vue'
import EmbedViewport from '@/embed/EmbedViewport.vue'
import UIRenderer from '@/workbench/ux/UIRenderer.vue'
import { useBContext } from '@/workbench/context/bContext'
import { sceneInfoPanel, wikiConfigPanel, blockStatsPanel } from '@/workbench/ux/panels'
import { defaultEmbedUi } from '@/preview/previewConfig'
import type { EmbedSettings, View3DFeatures } from '@/preview/previewConfig'

const bctx = useBContext()
const wikiConfig = bctx.wikiConfig as Record<string, any>

const wikiPanels = [sceneInfoPanel, wikiConfigPanel, blockStatsPanel]

const activeWikiPanels = computed(() =>
  wikiPanels
    .filter(p => p.poll(bctx))
    .map(p => ({ id: p.id, layout: p.layout(bctx), owner: p.owner?.(bctx) }))
)

function parseHex6(s: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s.trim())
  if (!m) return 0x5a5a5a
  return parseInt(m[1], 16)
}

const embedSettings = computed<EmbedSettings>(() => ({
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
}))
</script>

<template>
  <div class="ww-root">
    <div class="ww-preview-wrap">
      <div class="ww-preview" :style="{ width: `${wikiConfig.viewWidth ?? 800}px`, height: `${wikiConfig.viewHeight ?? 600}px` }">
        <EmbedViewport v-if="bctx.doc.value" :settings="embedSettings" />
        <div v-else class="ww-placeholder">
            <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
            <span class="ww-placeholder-text">No scene loaded</span>
          </div>
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
.ww-panel { flex-shrink: 0; width: 260px; border-left: 1px solid var(--wb-border); background: var(--wb-bg-deepest); overflow-y: auto; }
.ww-preview-wrap { flex: 1; display: flex; align-items: flex-start; justify-content: center; padding: 16px; overflow: auto; background: var(--wb-viewport-bg); }
.ww-preview { border: 1px solid var(--wb-border); border-radius: 4px; overflow: hidden; flex-shrink: 0; }
.ww-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  color: var(--wb-text-dim);
  font-size: 15px;
}
</style>
