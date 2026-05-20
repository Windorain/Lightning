<script setup lang="ts">
/**
 * EmbedViewer — 纯 View 组件。
 *
 * 职责：
 * - 创建 View3DStore 做场景编排（加载/mesh/帧/层）
 * - 渲染 UI 组件（标题栏、侧栏、视口、底部控件、tooltip）
 * - 处理 hover/tooltip 状态
 * - ViewerCore @ready 后注册 scene、重建 mesh，向上 emit ready 供 Controller 层装配事件
 *
 * 不创建 EmbedContext、不注册 region/handler、不加 capture listener。
 * 事件装配由上级 Controller 负责：
 *   独立嵌入 → EmbedShell (embed/EmbedShell.vue)
 *   工作台内 → Workbench Area/Region 路由
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

// ---- View3DStore (scene orchestration) ----
const store = createView3DStore(props.config)
provide(View3DContextKey, store)

watch(() => props.config, (cfg) => {
  store.config.value = cfg
})

// ---- Hover / tooltip ----
const { hover, setHover, clearHover } = usePreviewTooltip()

const {
  loadStatus,
  statusBarTone,
  statusMessage,
  structureDefinition,
  materialLibrary,
  blockIconCache,
  blockStatsEntries,
  layerPreviewMode,
  mainMeshGroup,
  tooltipPalette,
  hasWorldMultiFrame,
  worldFrameIndex,
  worldFrameCount,
  layerPreviewLabel,
} = store

// ---- Feature flags ----
const f = computed(() => props.config.features)
const showLayerBar = computed(() => f.value.layerBar)
const showFrameCtl = computed(() => f.value.frameControls)
const showTitle = computed(() => f.value.titleBar)
const showStats = computed(() => f.value.blockStatsSidebar)
const showDebugStatus = computed(() => f.value.debugStatusBar && props.config.debug)

const hasBottomDock = computed(() =>
  (showFrameCtl.value && hasWorldMultiFrame.value) || showLayerBar.value,
)

type BottomTab = 'frame' | 'layer'
const activeTab = ref<BottomTab>(
  (showFrameCtl.value && hasWorldMultiFrame.value) ? 'frame' : 'layer',
)

// ---- Title / meta hint ----
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
function onMetaHintFocusIn(e: FocusEvent): void { const t = e.currentTarget as HTMLElement; const r = t.getBoundingClientRect(); metaHintPointer.value = { clientX: r.left + r.width / 2, clientY: r.bottom } }
function onMetaHintFocusOut(): void { metaHintPointer.value = null }

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
    if (!map.has(key) && e.tooltip && e.tooltip.length > 0) {
      map.set(key, e.tooltip)
    }
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
  const lab = def?.label?.trim()
  if (lab) return lab
  const id = def?.id?.trim()
  if (id) return id
  return '结构预览'
})

const statusBarClass = computed(() => {
  if (loadStatus.value === 'error') return 'wm-status-bar wm-status-bar--err'
  if (loadStatus.value === 'loading') return 'wm-status-bar wm-status-bar--loading'
  if (statusBarTone.value === 'warn') return 'wm-status-bar wm-status-bar--warn'
  return 'wm-status-bar wm-status-bar--ok'
})

const statusSummary = computed(() => {
  if (loadStatus.value === 'loading') return '加载中…'
  if (loadStatus.value === 'error') return statusMessage.value
  const parts: string[] = ['场景已加载']
  if (hasWorldMultiFrame.value) {
    parts.push(`${worldFrameCount.value} Frames`)
  }
  return parts.join(' · ')
})

// ---- Viewport events ----
function onViewportReady(payload: ViewerCoreReadyPayload): void {
  store.registerScene(payload.scene)
  store.rebuildContentMesh().catch(e => { console.error('[EmbedViewer] rebuildContentMesh', e) })
  emit('ready', payload)
}

function onViewportHover(
  payload: { blockId: string; clientX: number; clientY: number; source: 'viewport'; voxel: { column: number; row: number; zSlice: number } } | null,
): void {
  if (payload) setHover(payload)
  else clearHover('viewport')
}

function onSidebarTooltipHover(
  payload: { blockId: string; clientX: number; clientY: number; source: 'sidebar' } | null,
): void {
  if (payload) setHover(payload)
  else clearHover('sidebar')
}

onMounted(async () => { await store.loadStructureAndResources() })
onBeforeUnmount(() => {
  store.disposeCachesAndLibrary()
})
</script>

<template>
  <div class="wm-root">
    <!-- 标题栏 -->
    <p v-if="showTitle" class="wm-title">
      <span class="wm-title-text">{{ previewTitle }}</span>
      <span
        v-if="showMetaHint" class="wm-title-meta" tabindex="0" aria-label="作者与版本号"
        @pointerenter="onMetaHintPointerEnter" @pointermove="onMetaHintPointerMove"
        @pointerleave="onMetaHintPointerLeave" @focusin="onMetaHintFocusIn" @focusout="onMetaHintFocusOut"
      >?</span>
    </p>

    <div class="wm-main-stage">
      <BlockStatsSidebar
        v-if="showStats && loadStatus === 'ok' && blockIconCache"
        :entries="blockStatsEntries" :cache="blockIconCache"
        @tooltip-hover="onSidebarTooltipHover"
      />
      <div class="wm-viewport-column">
        <ViewerCore
          v-if="loadStatus === 'ok' && structureDefinition && materialLibrary"
          :definition="structureDefinition" :material-library="materialLibrary"
          :content-group="mainMeshGroup"
          :layer-preview-mode="layerPreviewMode" :scene-background="config.sceneBackground"
          :show-axes-gizmo="f.showAxesGizmo"
          @ready="onViewportReady"
          @hover-block="onViewportHover"
        />
      </div>
    </div>

    <!-- 底部 Tab 控件栏 -->
    <div v-if="hasBottomDock && loadStatus === 'ok'" class="wm-bottom-dock">
      <div class="wm-tab-row">
        <button
          v-if="showFrameCtl && hasWorldMultiFrame"
          class="wm-tab"
          :class="{ 'wm-tab--active': activeTab === 'frame' }"
          @click="activeTab = 'frame'"
        >帧控制</button>
        <button
          v-if="showLayerBar"
          class="wm-tab"
          :class="{ 'wm-tab--active': activeTab === 'layer' }"
          @click="activeTab = 'layer'"
        >分层预览</button>
        <div class="wm-tab-status">
          <span v-if="showFrameCtl && hasWorldMultiFrame" class="wm-tab-stat">帧 <strong>{{ worldFrameIndex + 1 }}/{{ worldFrameCount }}</strong></span>
          <span v-if="showLayerBar" class="wm-tab-stat">层 <strong>{{ layerPreviewLabel }}</strong></span>
        </div>
      </div>
      <div v-if="showFrameCtl && hasWorldMultiFrame" class="wm-tab-panel" :class="{ 'wm-tab-panel--active': activeTab === 'frame' }">
        <WorldFramePlayerControls />
        <WorldFrameScrubber />
      </div>
      <div v-if="showLayerBar" class="wm-tab-panel" :class="{ 'wm-tab-panel--active': activeTab === 'layer' }">
        <LayerPreviewBar />
      </div>
    </div>

    <!-- 调试状态栏 -->
    <div v-if="showDebugStatus" :class="statusBarClass" role="status" aria-live="polite">
      <span class="wm-status-dot" aria-hidden="true" />
      <span class="wm-status-text">{{ statusSummary }}</span>
    </div>

    <ToolTipBox v-if="hover && tooltipDisplayText" :text="tooltipDisplayText" :client-x="hover.clientX" :client-y="hover.clientY" />
    <ToolTipBox v-if="hover && neiTooltipText" :text="neiTooltipText" :client-x="hover.clientX" :client-y="hover.clientY" />
    <ToolTipBox v-if="metaHintPointer && metaTooltipText" :text="metaTooltipText" :client-x="metaHintPointer.clientX" :client-y="metaHintPointer.clientY" />
  </div>
</template>

<style scoped>
.wm-root { font-family: system-ui, 'Segoe UI', sans-serif; color: var(--wb-text); background: var(--wb-bg-deepest); padding: 8px; box-sizing: border-box; height: 100%; display: flex; flex-direction: column; }
.wm-title { margin: 0 0 6px; font-size: 13px; font-weight: 700; color: var(--wb-text); display: flex; flex-direction: row; align-items: center; gap: 8px; }
.wm-title-text { flex: 1; min-width: 0; }
.wm-title-meta { flex-shrink: 0; font-size: 13px; font-weight: 700; color: var(--wb-text-muted); background: none; border: none; cursor: help; padding: 0 2px; line-height: 1; }
.wm-title-meta:hover { color: var(--wb-text); }
.wm-main-stage { display: flex; flex: 1; flex-direction: row; align-items: stretch; min-height: 0; width: 100%; border-radius: 0; overflow: hidden; border: 1px solid var(--wb-border); border-bottom: none; background: var(--wb-bg-elevated); }
.wm-viewport-column { flex: 1; min-width: 0; display: flex; flex-direction: column; }

.wm-bottom-dock {
  flex-shrink: 0;
  display: flex; flex-direction: column;
  border: 1px solid var(--wb-border);
  border-top: none;
  background: var(--wb-bg-surface);
}
.wm-tab-row {
  display: flex; align-items: center;
  gap: 0;
  padding: 0 4px;
  background: var(--wb-bg-deepest);
  border-bottom: 1px solid var(--wb-border);
}
.wm-tab {
  padding: 0 14px;
  font-size: 11px; font-weight: 500;
  color: var(--wb-text-muted);
  background: none; border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer; user-select: none;
  white-space: nowrap;
  transition: color 0.15s, border-color 0.15s;
  height: 100%; display: flex; align-items: center;
}
.wm-tab:hover { color: var(--wb-text); }
.wm-tab--active {
  color: var(--wb-text);
  border-bottom-color: var(--wb-accent);
}
.wm-tab-status {
  margin-left: auto;
  display: flex; align-items: center; gap: 14px;
  padding: 0 10px;
  font-size: 10px;
  color: var(--wb-text-muted);
  flex-shrink: 0;
}
.wm-tab-stat strong {
  color: var(--wb-text);
  font-weight: 600;
}
.wm-tab-panel {
  display: none;
  padding: 8px 12px;
  align-items: center; gap: 10px;
  min-height: 44px;
  background: var(--wb-bg-elevated);
}
.wm-tab-panel--active { display: flex; }

.wm-tab-panel :deep(.wm-wfs) {
  flex: 1; min-width: 0;
  background: transparent; border: none; padding: 0;
}
.wm-tab-panel :deep(.wm-wfp-controls) {
  background: transparent; border: none; padding: 0;
}
.wm-tab-panel :deep(.wm-layer-bar) {
  flex: 1; min-width: 0;
  background: transparent; border: none; padding: 0;
}

.wm-status-bar { display: flex; align-items: flex-start; gap: 8px; margin-top: 0; padding: 8px 10px; font-size: 11px; line-height: 1.45; border-radius: 0; border: 1px solid var(--wb-border); border-top: none; background: var(--wb-bg-surface); color: var(--wb-text-muted); }
.wm-status-bar--loading { color: #fcd34d; } .wm-status-bar--ok { color: #86efac; } .wm-status-bar--warn { color: #fde047; } .wm-status-bar--err { color: #fecaca; background: var(--wb-danger-bg); }
.wm-status-dot { flex-shrink: 0; width: 7px; height: 7px; margin-top: 4px; border-radius: 50%; background: currentColor; opacity: 0.9; }
.wm-status-text { flex: 1; word-break: break-word; white-space: pre-wrap; }
</style>
