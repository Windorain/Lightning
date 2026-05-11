<script setup lang="ts">
/**
 * 工作台 3D 视口：始终可编辑，点击选取方块，浮动 ToolShelf。
 * 与 EmbedViewer（Wiki 嵌入）分离，不共享 editMode/features 开关。
 */
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import type { Scene } from 'three'

import StructureViewport from '@/embed/components/StructureViewport.vue'
import LayerPreviewBar from '@/embed/components/LayerPreviewBar.vue'
import WorldFramePlayerControls from '@/embed/components/WorldFramePlayerControls.vue'
import WorldFrameScrubber from '@/embed/components/WorldFrameScrubber.vue'
import ToolTipBox from '@/embed/components/ToolTipBox.vue'
import type { PreviewConfig } from '@/preview/previewConfig'
import {
  PreviewSceneContextKey,
  createPreviewSceneStore,
} from '@/preview/sceneStore'
import { usePreviewTooltip, resolvePreviewTooltipText } from '@/preview/tooltip'
import { useSceneContext } from '@/workbench/sceneContext'
import { t } from '@/workbench/i18n'

const props = defineProps<{
  mergedConfig: PreviewConfig
}>()

const ctx = useSceneContext()

defineEmits<{}>()

const store = createPreviewSceneStore(props.mergedConfig)
provide(PreviewSceneContextKey, store)

watch(() => props.mergedConfig, async (cfg) => {
  try { await store.reloadFromConfig(cfg) } catch (e) { console.error('[Workbench] reloadFromConfig', e) }
})

const { hover, setHover, clearHover } = usePreviewTooltip()

const {
  loadStatus,
  structureDefinition,
  materialLibrary,
  layerPreviewMode,
  contentGroupRef,
  tooltipPalette,
  hasWorldMultiFrame,
  worldFrameIndex,
  worldFrameCount,
  layerPreviewLabel,
} = store

const tooltipDisplayText = computed(() => {
  const def = structureDefinition.value
  const h = hover.value
  if (!def || !h?.blockId) return ''
  return resolvePreviewTooltipText(def, tooltipPalette.value, h)
})

type BottomTab = 'frame' | 'layer'
const activeTab = ref<BottomTab>(hasWorldMultiFrame.value ? 'frame' : 'layer')

/* ---- Viewport events ---- */
async function onViewportReady(scene: Scene): Promise<void> {
  store.registerScene(scene)
  try { await store.rebuildContentMesh() } catch (e) { console.error('[Workbench] onViewportReady', e) }
}

function onViewportHover(
  p: { blockId: string; clientX: number; clientY: number; voxel: { column: number; row: number; zSlice: number } } | null,
): void {
  if (p) setHover({ ...p, source: 'viewport' })
  else clearHover('viewport')
}

function onViewportSelect(
  p: { blockId: string; voxel: { column: number; row: number; zSlice: number } } | null,
): void {
  ctx.setSelectedBlock(p ? { blockId: p.blockId, voxel: p.voxel } : null)
}

watch(
  worldFrameIndex,
  (i) => {
    ctx.setPreviewWorldFrameIndex(i)
  },
  { immediate: true },
)

onMounted(async () => { await store.loadStructureAndResources() })
onBeforeUnmount(() => { store.disposeCachesAndLibrary() })
</script>

<template>
  <div class="wv-root">
    <!-- 3D Viewport -->
    <div class="wv-viewport-wrap">
    <StructureViewport
      v-if="loadStatus === 'ok' && structureDefinition && materialLibrary"
      :definition="structureDefinition"
      :material-library="materialLibrary"
      :content-group="contentGroupRef"
      :layer-preview-mode="layerPreviewMode"
      :scene-background="mergedConfig.sceneBackground"
      :edit-mode="true"
      :selected-voxel="ctx.selectedBlock.value?.voxel ?? null"
      @ready="onViewportReady"
      @hover-block="onViewportHover"
      @select-block="onViewportSelect"
    />
    </div>

    <!-- 悬浮 ToolShelf -->
    <div class="wv-shelf">
      <div class="wv-shelf-panel">
        <div class="wv-shelf-title">{{ t('tools') }}</div>
        <button class="wv-tool-btn wv-tool-btn--active">{{ t('select') }}</button>
      </div>
    </div>

    <!-- 底部 Tab 控件栏 -->
    <div class="wv-bottom-dock">
      <div class="wv-tab-row">
        <button
          v-if="hasWorldMultiFrame"
          class="wv-tab"
          :class="{ 'wv-tab--active': activeTab === 'frame' }"
          @click="activeTab = 'frame'"
        >帧控制</button>
        <button
          class="wv-tab"
          :class="{ 'wv-tab--active': activeTab === 'layer' }"
          @click="activeTab = 'layer'"
        >分层预览</button>
        <div class="wv-tab-status">
          <span v-if="hasWorldMultiFrame" class="wv-tab-stat">帧 <strong>{{ worldFrameIndex + 1 }}/{{ worldFrameCount }}</strong></span>
          <span class="wv-tab-stat">层 <strong>{{ layerPreviewLabel }}</strong></span>
        </div>
      </div>
      <div v-if="hasWorldMultiFrame" class="wv-tab-panel" :class="{ 'wv-tab-panel--active': activeTab === 'frame' }">
        <WorldFramePlayerControls />
        <WorldFrameScrubber />
      </div>
      <div class="wv-tab-panel" :class="{ 'wv-tab-panel--active': activeTab === 'layer' }">
        <LayerPreviewBar />
      </div>
    </div>

    <!-- ToolTip -->
    <ToolTipBox
      v-if="hover && tooltipDisplayText"
      :text="tooltipDisplayText"
      :client-x="hover.clientX"
      :client-y="hover.clientY"
    />
  </div>
</template>

<style scoped>
.wv-root { width: 100%; height: 100%; position: relative; display: flex; flex-direction: column; }
.wv-viewport-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* ===== 底部 Tab 控件栏 ===== */
.wv-bottom-dock {
  flex-shrink: 0;
  display: flex; flex-direction: column;
  background: var(--nei-inset-bg);
}
.wv-tab-row {
  display: flex; align-items: center;
  padding: 0 4px;
  background: var(--nei-bg-deep);
  border-bottom: 1px solid var(--nei-shadow);
}
.wv-tab {
  padding: 6px 14px 5px;
  font-size: 11px; font-family: ui-monospace, 'Cascadia Code', monospace;
  font-weight: 600;
  color: var(--nei-text-muted);
  background: none; border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer; user-select: none;
  white-space: nowrap;
  transition: color 0.15s, border-color 0.15s;
}
.wv-tab:hover { color: var(--nei-text); }
.wv-tab--active {
  color: var(--nei-text);
  border-bottom-color: var(--nei-accent);
}
.wv-tab-status {
  margin-left: auto;
  display: flex; align-items: center; gap: 14px;
  padding: 0 10px;
  font-size: 11px; font-family: ui-monospace, 'Cascadia Code', monospace;
  color: var(--nei-text-muted);
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.4);
  flex-shrink: 0;
}
.wv-tab-stat strong {
  color: var(--nei-text);
  font-weight: 600;
}
.wv-tab-panel {
  display: none;
  padding: 6px 10px;
  align-items: center; gap: 10px;
  height: 40px;
  background: var(--nei-inset-bg);
}
.wv-tab-panel--active { display: flex; }

/* 子组件嵌入 tab panel 时：拉伸填满，剥除外层边框背景 */
.wv-tab-panel :deep(.wm-wfs) {
  flex: 1; min-width: 0;
  background: transparent; border: none; padding: 0;
}
.wv-tab-panel :deep(.wm-wfp-controls) {
  background: transparent; border: none; padding: 0;
}
.wv-tab-panel :deep(.wm-layer-bar) {
  flex: 1; min-width: 0;
  background: transparent; border: none; padding: 0;
}

.wv-shelf {
  position: absolute; top: 8px; left: 4px; z-index: 20;
}
.wv-shelf-panel {
  padding: 6px;
  background: var(--nei-bg);
  border-radius: 6px;
  border: 1px solid var(--nei-panel-hover);
  min-width: 72px;
  width: max-content;
  backdrop-filter: blur(6px);
}
.wv-shelf-title {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
  color: var(--nei-muted); margin-bottom: 4px; padding: 0 4px;
}
.wv-tool-btn {
  display: block; padding: 3px 6px; border: none;
  background: transparent; color: var(--nei-label); font-size: 11px;
  text-align: left; cursor: pointer; border-radius: 3px; margin-bottom: 1px;
}
.wv-tool-btn:hover { background: var(--nei-panel-hover); color: var(--nei-text-dark); }
.wv-tool-btn--active { background: var(--nei-panel-hover); color: var(--nei-text); }
</style>
