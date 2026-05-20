<script setup lang="ts">
/**
 * EmbedViewer — 纯 View 组件 (Modern NEI redesign).
 *
 * 职责：创建 View3DStore 做场景编排，渲染 NEI 风格 UI
 * （标题栏、可收起侧栏、视口、底部多 Tab 控件、tooltip）。
 */
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'

import BlockStatsSidebar from '@/embed/components/BlockStatsSidebar.vue'
import LayerPreviewBar from '@/embed/components/LayerPreviewBar.vue'
import ViewerCore from '@/embed/components/ViewerCore.vue'
import type { ViewerCoreReadyPayload } from '@/embed/components/ViewerCore.vue'
import ToolTipBox from '@/embed/components/ToolTipBox.vue'
import WorldFramePlayerControls from '@/embed/components/WorldFramePlayerControls.vue'
import WorldFrameScrubber from '@/embed/components/WorldFrameScrubber.vue'
import type { View3DConfig } from '@/preview/previewConfig'
import { readSceneMetaField } from '@/render/data/compactSceneDocument'
import { sceneDisplayTitleFromRootDocument } from '@/preview/sceneDisplayTitle'
import {
  View3DContextKey,
  createView3DStore,
} from '@/preview/sceneStore'
import { usePreviewTooltip, resolvePreviewTooltipText } from '@/preview/tooltip'
import { blockRegistryKeyForPalette } from '@/render/data/blockRegistryResolve'
import { renderTooltipHtml } from '@/workbench/components/renderTooltipHtml'

const emit = defineEmits<{
  ready: [payload: ViewerCoreReadyPayload]
}>()

const props = defineProps<{
  config: View3DConfig
}>()

// ---- View3DStore ----
const store = createView3DStore(props.config)
provide(View3DContextKey, store)

watch(() => props.config, (cfg) => { store.config.value = cfg })

const { hover, setHover, clearHover } = usePreviewTooltip()

const {
  loadStatus, statusBarTone, statusMessage,
  structureDefinition, materialLibrary, blockIconCache,
  blockStatsEntries, layerPreviewMode, mainMeshGroup, tooltipPalette,
  hasWorldMultiFrame, worldFrameIndex, worldFrameCount, layerPreviewLabel,
} = store

// ---- Feature flags ----
const f = computed(() => props.config.features)
const showLayerBar = computed(() => f.value.layerBar)
const showFrameCtl = computed(() => f.value.frameControls)
const showTitle = computed(() => f.value.titleBar)
const showStats = computed(() => f.value.blockStatsSidebar)
const showDebugStatus = computed(() => f.value.debugStatusBar && props.config.debug)

const hasBottomDock = computed(() =>
  (showFrameCtl.value && hasWorldMultiFrame.value) || showLayerBar.value)

type BottomTab = 'frame' | 'layer'
const activeTab = ref<BottomTab>(
  (showFrameCtl.value && hasWorldMultiFrame.value) ? 'frame' : 'layer')

// ---- Sidebar collapse ----
const sidebarCollapsed = ref(false)
function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value }

// ---- Title / meta ----
const sceneDocument = computed(() => props.config.renderBundle.document)

const metaTooltipText = computed(() => {
  const d = sceneDocument.value
  if (!d || typeof d !== 'object') return ''
  const rows: string[] = []
  const pick = (label: string, key: string) => {
    const v = readSceneMetaField(d, key).trim()
    if (v) rows.push(`${label}：${v}`)
  }
  pick('作者', 'author')
  pick('版本号', 'gtnhVersion')
  return rows.join('\n')
})

const showMetaHint = computed(() => metaTooltipText.value.length > 0)
const metaHintPointer = ref<{ clientX: number; clientY: number } | null>(null)

function onMetaHintPointerEnter(e: PointerEvent): void { metaHintPointer.value = { clientX: e.clientX, clientY: e.clientY } }
function onMetaHintPointerMove(e: PointerEvent): void { if (!metaHintPointer.value) return; metaHintPointer.value = { clientX: e.clientX, clientY: e.clientY } }
function onMetaHintPointerLeave(): void { metaHintPointer.value = null }

// ---- Tooltip text ----
const tooltipDisplayText = computed(() => {
  const def = structureDefinition.value
  const h = hover.value
  if (!def || !h?.blockId) return ''
  return resolvePreviewTooltipText(def, tooltipPalette.value, h)
})

const neiTooltipMap = computed<Map<string, string[]>>(() => {
  const def = structureDefinition.value
  if (!def) return new Map()
  const map = new Map<string, string[]>()
  for (const e of def.blockPalette) {
    const key = blockRegistryKeyForPalette(e.registryId, e.meta)
    if (!map.has(key) && e.tooltip && e.tooltip.length > 0) map.set(key, e.tooltip)
  }
  return map
})

const neiTooltipText = computed(() => {
  const h = hover.value
  if (!h || h.source !== 'sidebar') return ''
  const lines = neiTooltipMap.value.get(h.blockId)
  return lines && lines.length > 0 ? lines.map(l => renderTooltipHtml(l)).join('<br>') : ''
})

const previewTitle = computed(() => {
  const fromDoc = sceneDisplayTitleFromRootDocument(props.config.renderBundle.document)
  if (fromDoc) return fromDoc
  const def = structureDefinition.value
  return def?.label?.trim() || def?.id?.trim() || '结构预览'
})

const statusBarClass = computed(() => {
  if (loadStatus.value === 'error') return 'nei-status-bar nei-status-bar--err'
  if (loadStatus.value === 'loading') return 'nei-status-bar nei-status-bar--loading'
  if (statusBarTone.value === 'warn') return 'nei-status-bar nei-status-bar--warn'
  return 'nei-status-bar nei-status-bar--ok'
})

const statusSummary = computed(() => {
  if (loadStatus.value === 'loading') return '加载中…'
  if (loadStatus.value === 'error') return statusMessage.value
  const parts: string[] = ['场景已加载']
  if (hasWorldMultiFrame.value) parts.push(`${worldFrameCount.value} Frames`)
  return parts.join(' · ')
})

// ---- Viewport events ----
function onViewportReady(payload: ViewerCoreReadyPayload): void {
  store.registerScene(payload.scene)
  store.rebuildContentMesh().catch(e => { console.error('[EmbedViewer] rebuildContentMesh', e) })
  emit('ready', payload)
}

function onViewportHover(payload: { blockId: string; clientX: number; clientY: number; source: 'viewport'; voxel: { column: number; row: number; zSlice: number } } | null): void {
  if (payload) setHover(payload)
  else clearHover('viewport')
}

function onSidebarTooltipHover(payload: { blockId: string; clientX: number; clientY: number; source: 'sidebar' } | null): void {
  if (payload) setHover(payload)
  else clearHover('sidebar')
}

onMounted(async () => { await store.loadStructureAndResources() })
onBeforeUnmount(() => { store.disposeCachesAndLibrary() })
</script>

<template>
  <div class="nei-root">
    <!-- ===== Title Bar (NEI bevel) ===== -->
    <header v-if="showTitle" class="nei-titlebar">
      <span class="nei-titlebar-brand">LIGHTNING</span>
      <span class="nei-titlebar-title">{{ previewTitle }}</span>
      <span
        v-if="showMetaHint" class="nei-titlebar-meta" tabindex="0"
        @pointerenter="onMetaHintPointerEnter" @pointermove="onMetaHintPointerMove"
        @pointerleave="onMetaHintPointerLeave"
      >?</span>

      <!-- Action icons -->
      <div class="nei-titlebar-actions">
        <!-- Reset view -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="nei-icon-btn" title="复位视角">
          <polyline points="1 4 1 10 7 10"/><path d="M3.5 18a9 9 0 1 0 2.1-13.4L1 10"/>
        </svg>
        <!-- Screenshot -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="nei-icon-btn" title="截屏">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>
        </svg>
        <!-- Fullscreen -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="nei-icon-btn" title="全屏">
          <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
          <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
        </svg>
        <div class="nei-titlebar-divider" />
        <!-- Workbench -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="nei-icon-btn" title="在线编辑">
          <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/><circle cx="12" cy="10" r="1"/>
        </svg>
        <!-- Settings -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="nei-icon-btn" title="设置">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </div>
    </header>

    <!-- ===== Main Stage ===== -->
    <div class="nei-main-stage">
      <!-- Collapsible Block Sidebar -->
      <BlockStatsSidebar
        v-if="showStats && loadStatus === 'ok' && blockIconCache"
        :entries="blockStatsEntries" :cache="blockIconCache"
        :collapsed="sidebarCollapsed"
        @toggle-collapse="toggleSidebar"
        @tooltip-hover="onSidebarTooltipHover"
      />
      <!-- Viewport -->
      <div class="nei-viewport-col">
        <ViewerCore
          v-if="loadStatus === 'ok' && structureDefinition && materialLibrary"
          :definition="structureDefinition" :material-library="materialLibrary"
          :content-group="mainMeshGroup"
          :layer-preview-mode="layerPreviewMode" :scene-background="0x0a0e18"
          :show-axes-gizmo="f.showAxesGizmo"
          @ready="onViewportReady"
          @hover-block="onViewportHover"
        />
      </div>
    </div>

    <!-- ===== Bottom Dock ===== -->
    <div v-if="hasBottomDock && loadStatus === 'ok'" class="nei-bottom-dock">
      <!-- Tab row (NEI bevel) -->
      <div class="nei-tab-row">
        <button v-if="showFrameCtl && hasWorldMultiFrame" class="nei-tab" :class="{ 'nei-tab--active': activeTab === 'frame' }" @click="activeTab = 'frame'">
          帧控制
        </button>
        <button v-if="showLayerBar" class="nei-tab" :class="{ 'nei-tab--active': activeTab === 'layer' }" @click="activeTab = 'layer'">
          分层预览
        </button>
        <div class="nei-tab-info">
          <span v-if="showFrameCtl && hasWorldMultiFrame">帧 {{ worldFrameIndex + 1 }} / {{ worldFrameCount }}</span>
          <span v-if="showLayerBar">层 {{ layerPreviewLabel }}</span>
        </div>
      </div>
      <!-- Frame panel -->
      <div v-if="showFrameCtl && hasWorldMultiFrame" class="nei-tab-panel" :class="{ 'nei-tab-panel--active': activeTab === 'frame' }">
        <WorldFramePlayerControls />
        <WorldFrameScrubber />
      </div>
      <!-- Layer panel -->
      <div v-if="showLayerBar" class="nei-tab-panel" :class="{ 'nei-tab-panel--active': activeTab === 'layer' }">
        <LayerPreviewBar />
      </div>
    </div>

    <!-- Debug status bar -->
    <div v-if="showDebugStatus" :class="statusBarClass" role="status" aria-live="polite">
      <span class="nei-status-dot" />
      <span class="nei-status-text">{{ statusSummary }}</span>
    </div>

    <ToolTipBox v-if="hover && tooltipDisplayText" :text="tooltipDisplayText" :client-x="hover.clientX" :client-y="hover.clientY" />
    <ToolTipBox v-if="hover && neiTooltipText" :text="neiTooltipText" :client-x="hover.clientX" :client-y="hover.clientY" />
    <ToolTipBox v-if="metaHintPointer && metaTooltipText" :text="metaTooltipText" :client-x="metaHintPointer.clientX" :client-y="metaHintPointer.clientY" />
  </div>
</template>

<style scoped>
/* ===== Root ===== */
.nei-root {
  font-family: system-ui, 'Segoe UI', sans-serif;
  color: var(--nei-text);
  background: var(--nei-bg-panel);
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ===== Title Bar ===== */
.nei-titlebar {
  flex-shrink: 0;
  height: 40px;
  background: var(--nei-bg-elevated);
  display: flex;
  align-items: center;
  padding: 0 14px;
  gap: 14px;
  border-bottom: 3px solid;
  border-color: var(--nei-bevel-light) var(--nei-bevel-dark) var(--nei-bevel-dark) var(--nei-bevel-light);
}
.nei-titlebar-brand {
  color: var(--nei-text);
  font-size: 14px;
  font-weight: 700;
  text-shadow: var(--nei-text-shadow-deep);
  user-select: none;
}
.nei-titlebar-title {
  color: var(--nei-text);
  font-size: 15px;
  font-weight: 700;
  text-shadow: var(--nei-text-shadow-deep);
}
.nei-titlebar-meta {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 700;
  color: var(--nei-text-dim);
  cursor: help;
  text-shadow: var(--nei-text-shadow);
}
.nei-titlebar-meta:hover { color: var(--nei-text); }
.nei-titlebar-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}
.nei-icon-btn {
  width: 20px; height: 20px;
  color: var(--nei-text-dim);
  cursor: pointer;
  flex-shrink: 0;
}
.nei-icon-btn:hover { color: var(--nei-text); }
.nei-titlebar-divider {
  width: 1px; height: 20px;
  background: var(--nei-border-panel);
  margin: 0 2px;
}

/* ===== Main Stage ===== */
.nei-main-stage {
  flex: 1;
  display: flex;
  min-height: 0;
}
.nei-viewport-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* ===== Bottom Dock ===== */
.nei-bottom-dock {
  flex-shrink: 0;
  background: var(--nei-bg-surface);
  border-top: 3px solid var(--nei-border-panel);
}

/* Tab row — NEI bevel */
.nei-tab-row {
  display: flex;
  align-items: stretch;
  padding: 0 4px;
  gap: 2px;
  height: 34px;
  background: var(--nei-bg-panel);
  border-bottom: 3px solid;
  border-color: var(--nei-bevel-dark) var(--nei-border-subtle) var(--nei-border-subtle) var(--nei-bevel-dark);
}
.nei-tab {
  padding: 0 16px;
  height: 100%;
  font-size: 11px;
  font-weight: 700;
  color: var(--nei-text-dim);
  background: transparent;
  border: 3px solid transparent;
  cursor: pointer;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 5px;
}
.nei-tab:hover { color: var(--nei-text); }
.nei-tab--active {
  color: var(--nei-text);
  background: var(--nei-bg-elevated);
  border-color: var(--nei-bevel-light) var(--nei-bevel-dark) var(--nei-bevel-dark) var(--nei-bevel-light);
  border-bottom-color: var(--nei-bg-elevated);
  text-shadow: var(--nei-text-shadow-deep);
  position: relative;
  z-index: 1;
  margin-bottom: -2px;
}
.nei-tab-info {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding-right: 10px;
  font-size: 10px;
  color: var(--nei-text-mono);
  font-family: ui-monospace, monospace;
}
.nei-tab-panel {
  display: none;
  padding: 10px 14px;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  background: var(--nei-bg-surface);
}
.nei-tab-panel--active { display: flex; }
.nei-tab-panel :deep(.wm-wfs) { flex: 1; min-width: 0; background: transparent; border: none; padding: 0; }
.nei-tab-panel :deep(.wm-wfp-controls) { background: transparent; border: none; padding: 0; }
.nei-tab-panel :deep(.wm-layer-bar) { flex: 1; min-width: 0; background: transparent; border: none; padding: 0; }

/* ===== Debug Status Bar ===== */
.nei-status-bar {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px; font-size: 10px;
  border-top: 1px solid var(--nei-border-panel);
  background: var(--nei-bg-panel);
  color: var(--nei-text-dim);
}
.nei-status-bar--loading { color: #fcd34d; }
.nei-status-bar--ok { color: #86efac; }
.nei-status-bar--warn { color: #fde047; }
.nei-status-bar--err { color: #fecaca; background: #301a1a; }
.nei-status-dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.9;
  flex-shrink: 0;
}
.nei-status-text { flex: 1; word-break: break-word; white-space: pre-wrap; }
</style>
