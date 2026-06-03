<script setup lang="ts">
import { computed } from 'vue'
import LayerPreviewBar from '@/shared/viewport/LayerPreviewBar.vue'
import WorldFramePlayerControls from '@/shared/viewport/WorldFramePlayerControls.vue'
import WorldFrameScrubber from '@/shared/viewport/WorldFrameScrubber.vue'

export type ViewportDockTab = 'frame' | 'layer'

const props = withDefaults(defineProps<{
  theme?: 'embed' | 'workbench'
  showFrameTab?: boolean
  showLayerTab?: boolean
  hasWorldMultiFrame: boolean
  worldFrameIndex: number
  worldFrameCount: number
  framesPlaybackIsPlaying: boolean
  meshBusy: boolean
  gridHeight: number
  layerWorldY: number
  layerPreviewLabel: string
}>(), {
  theme: 'workbench',
  showFrameTab: true,
  showLayerTab: true,
})

const activeTab = defineModel<ViewportDockTab>('activeTab', { required: true })

const showFramePanel = computed(
  () => props.showFrameTab && props.hasWorldMultiFrame && activeTab.value === 'frame',
)
const showLayerPanel = computed(
  () => props.showLayerTab && activeTab.value === 'layer',
)

const emit = defineEmits<{
  setFrame: [index: number]
  togglePlayback: []
  'update:layerY': [y: number]
}>()
</script>

<template>
  <div class="vp-dock" :class="`vp-dock--${theme}`">
    <div class="vp-dock__tab-row">
      <button
        v-if="showFrameTab && hasWorldMultiFrame"
        type="button"
        class="vp-dock__tab"
        :class="{ 'vp-dock__tab--active': activeTab === 'frame' }"
        @click="activeTab = 'frame'"
      >帧控制</button>
      <button
        v-if="showLayerTab"
        type="button"
        class="vp-dock__tab"
        :class="{ 'vp-dock__tab--active': activeTab === 'layer' }"
        @click="activeTab = 'layer'"
      >分层预览</button>
      <div class="vp-dock__tab-status">
        <span v-if="showFrameTab && hasWorldMultiFrame" class="vp-dock__stat">
          帧 <strong>{{ worldFrameIndex + 1 }}/{{ worldFrameCount }}</strong>
        </span>
        <span v-if="showLayerTab" class="vp-dock__stat">
          层 <strong>{{ layerPreviewLabel }}</strong>
        </span>
      </div>
    </div>
    <div v-if="showFramePanel" class="vp-dock__panel vp-dock__panel--active">
      <WorldFramePlayerControls
        :has-world-multi-frame="hasWorldMultiFrame"
        :is-playing="framesPlaybackIsPlaying"
        @toggle="emit('togglePlayback')"
      />
      <WorldFrameScrubber
        :has-world-multi-frame="hasWorldMultiFrame"
        :frame-count="worldFrameCount"
        :is-playing="framesPlaybackIsPlaying"
        :mesh-busy="meshBusy"
        :world-frame-index="worldFrameIndex"
        @toggle-playback="emit('togglePlayback')"
        @set-frame="emit('setFrame', $event)"
      />
    </div>
    <div v-if="showLayerPanel" class="vp-dock__panel vp-dock__panel--active">
      <LayerPreviewBar
        :grid-height="gridHeight"
        :mesh-busy="meshBusy"
        :layer-world-y="layerWorldY"
        :layer-preview-label="layerPreviewLabel"
        @update:layer-y="emit('update:layerY', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.vp-dock { flex-shrink: 0; width: 100%; display: flex; flex-direction: column; }
.vp-dock--embed {
  border: var(--nei-bevel-w) solid;
  border-color: var(--nei-shadow) var(--nei-highlight) var(--nei-highlight) var(--nei-shadow);
  border-top: none;
  background: var(--nei-inset-bg);
}
.vp-dock--workbench {
  background: var(--wb-bg-elevated);
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.12);
}
.vp-dock__tab-row {
  display: flex; align-items: center; padding: 0 4px;
}
.vp-dock--embed .vp-dock__tab-row {
  background: var(--nei-bg-deep);
  border-bottom: 1px solid var(--nei-shadow);
  box-shadow: 0 1px 0 var(--nei-highlight);
}
.vp-dock--workbench .vp-dock__tab-row {
  background: var(--wb-bg-surface);
  border-bottom: 1px solid var(--wb-border);
}
.vp-dock__tab {
  padding: 6px 14px 5px; font-weight: 600;
  background: none; border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer; user-select: none; white-space: nowrap;
  transition: color 0.15s, border-color 0.15s;
}
.vp-dock--embed .vp-dock__tab {
  font-size: 11px; font-family: var(--nei-font-mono);
  color: var(--nei-text-muted);
}
.vp-dock--embed .vp-dock__tab:hover { color: var(--nei-text); }
.vp-dock--embed .vp-dock__tab--active {
  color: var(--nei-text);
  border-bottom-color: var(--nei-accent);
}
.vp-dock--workbench .vp-dock__tab {
  font-size: 12px; font-family: system-ui, sans-serif;
  color: var(--wb-text-muted);
}
.vp-dock--workbench .vp-dock__tab:hover { color: var(--wb-text); }
.vp-dock--workbench .vp-dock__tab--active {
  color: var(--wb-text);
  border-bottom-color: var(--wb-accent);
}
.vp-dock__tab-status {
  margin-left: auto; display: flex; align-items: center; gap: 14px;
  padding: 0 10px; flex-shrink: 0;
}
.vp-dock--embed .vp-dock__tab-status {
  font-size: 11px; font-family: var(--nei-font-mono);
  color: var(--nei-text-muted);
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.4);
}
.vp-dock--workbench .vp-dock__tab-status {
  font-size: 12px; font-family: system-ui, sans-serif;
  color: var(--wb-text-muted);
}
.vp-dock__stat strong { font-weight: 600; }
.vp-dock--embed .vp-dock__stat strong { color: var(--nei-text); }
.vp-dock--workbench .vp-dock__stat strong { color: var(--wb-text); }
.vp-dock__panel {
  display: flex; width: 100%; box-sizing: border-box;
  padding: 6px 10px; align-items: center; gap: 10px;
}
.vp-dock--embed .vp-dock__panel { height: 48px; background: var(--nei-inset-bg); }
.vp-dock--workbench .vp-dock__panel { height: 40px; background: var(--wb-bg-elevated); }
.vp-dock__panel :deep(.wm-wfs),
.vp-dock__panel :deep(.wm-wfp-controls),
.vp-dock__panel :deep(.wm-layer-bar) {
  flex: 1; min-width: 0; background: transparent; border: none; padding: 0;
}
[data-nei-theme="light"] .vp-dock--embed .vp-dock__panel :deep(.wm-layer-label),
[data-nei-theme="light"] .vp-dock--embed .vp-dock__panel :deep(.wm-wfs__label) {
  color: #e0e0e0;
}
</style>
