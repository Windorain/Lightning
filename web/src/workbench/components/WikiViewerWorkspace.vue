<script setup lang="ts">
import { computed } from 'vue'
import EmbedViewer from '@/embed/EmbedViewer.vue'
import PropertiesPanel from './PropertiesPanel.vue'
import { useSceneContext } from '@/workbench/sceneContext'
import { wikiConfig } from '@/workbench/wikiConfig'
import type { PreviewConfig } from '@/preview/previewConfig'

const ctx = useSceneContext()

function parseHex6(s: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s.trim())
  if (!m) return 0x5a5a5a
  return parseInt(m[1], 16)
}

const mergedConfig = computed<PreviewConfig | null>(() => {
  const c = ctx.previewConfig.value
  if (!c) return null
  return {
    ...c,
    features: { ...c.features, ...wikiConfig.features },
    debug: wikiConfig.features.debugStatusBar,
    sceneBackground: parseHex6(wikiConfig.sceneBackgroundHex),
    blockIconCacheOptions: {
      ...c.blockIconCacheOptions,
      sizePx: wikiConfig.iconSizePx,
      orthoHalf: wikiConfig.iconOrthoHalf,
    },
    initialCamera: {
      ...c.initialCamera,
      yawDeg: wikiConfig.cameraYaw,
      elevationDeg: wikiConfig.cameraElevation,
      zoom: wikiConfig.cameraZoom,
    },
  }
})
</script>

<template>
  <div class="ww-root">
    <div class="ww-preview-wrap">
      <div class="ww-preview" :style="{ width: `${wikiConfig.viewWidth}px`, height: `${wikiConfig.viewHeight}px` }">
        <EmbedViewer v-if="mergedConfig" :key="ctx.previewEpoch.value" :merged-config="mergedConfig" />
        <div v-else class="ww-placeholder">No scene loaded</div>
      </div>
    </div>
    <div class="ww-panel">
      <PropertiesPanel editors="wiki" />
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
