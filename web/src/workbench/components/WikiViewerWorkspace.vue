<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import EmbedViewport from '@/embed/EmbedViewport.vue'
import UIRenderer from '@/workbench/ux/UIRenderer.vue'
import { useBContext } from '@/workbench/context/bContext'
import { sceneInfoPanel, wikiConfigPanel, blockStatsPanel } from '@/workbench/ux/panels'
import type { View3DConfig } from '@/preview/previewConfig'
import { view3DConfigFromDocument } from '@/preview/previewFromDocument'

const bctx = useBContext()
const wikiConfig = bctx.wikiConfig as Record<string, any>

const wikiPanels = [sceneInfoPanel, wikiConfigPanel, blockStatsPanel]

const activeWikiPanels = computed(() =>
  wikiPanels
    .filter(p => p.poll(bctx))
    .map(p => ({ id: p.id, layout: p.layout(bctx), owner: p.owner?.(bctx) }))
)

const embedConfig = ref<View3DConfig | null>(null)
const renderKey = ref(0)
let _buildSeq = 0

function parseHex6(s: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s.trim())
  if (!m) return 0x5a5a5a
  return parseInt(m[1], 16)
}

async function buildEmbedConfig(): Promise<void> {
  const doc = bctx.doc.value?.toRaw()
  if (!doc) { embedConfig.value = null; return }
  const seq = ++_buildSeq
  try {
    const cfg = await view3DConfigFromDocument({ ...doc as Record<string, unknown> })
    if (seq !== _buildSeq) return
    embedConfig.value = {
      ...cfg,
      features: { ...cfg.features, ...(wikiConfig.features ?? {}) },
      debug: wikiConfig.features?.debugStatusBar ?? false,
      sceneBackground: parseHex6(wikiConfig.sceneBackgroundHex ?? '#5a5a5a'),
      blockIconCacheOptions: {
        ...cfg.blockIconCacheOptions,
        sizePx: wikiConfig.iconSizePx ?? cfg.blockIconCacheOptions?.sizePx,
        orthoHalf: wikiConfig.iconOrthoHalf ?? cfg.blockIconCacheOptions?.orthoHalf,
      },
      initialCamera: {
        ...cfg.initialCamera,
        yawDeg: wikiConfig.cameraYaw ?? cfg.initialCamera?.yawDeg,
        elevationDeg: wikiConfig.cameraElevation ?? cfg.initialCamera?.elevationDeg,
        zoom: wikiConfig.cameraZoom ?? cfg.initialCamera?.zoom,
      },
    }
    renderKey.value += 1
  } catch { embedConfig.value = null }
}

// Rebuild on doc change or structEpoch bump
watch([() => bctx.doc.value, () => bctx.structEpoch.value], () => { void buildEmbedConfig() }, { immediate: true })
</script>

<template>
  <div class="ww-root">
    <div class="ww-preview-wrap">
      <div class="ww-preview" :style="{ width: `${wikiConfig.viewWidth ?? 800}px`, height: `${wikiConfig.viewHeight ?? 600}px` }">
        <EmbedViewport v-if="embedConfig" :key="renderKey" :config="embedConfig" />
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
