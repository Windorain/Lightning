<script setup lang="ts">
/**
 * 预览壳：previewSceneStore + StructureViewport + 可选周边组件。
 * 所有外围 UI（侧栏、分层条、播放器、标题、状态栏）按 `mergedConfig.features` 开关。
 * 工作台模式下关闭外围组件，由外围 ViewportHost 提供等价 UI。
 */
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import type { Scene } from 'three'

import BlockStatsSidebar from '@/embed/components/BlockStatsSidebar.vue'
import LayerPreviewBar from '@/embed/components/LayerPreviewBar.vue'
import StructureViewport from '@/embed/components/StructureViewport.vue'
import ToolTipBox from '@/embed/components/ToolTipBox.vue'
import WorldFramePlayerControls from '@/embed/components/WorldFramePlayerControls.vue'
import WorldFrameScrubber from '@/embed/components/WorldFrameScrubber.vue'
import type { PreviewConfig } from '@/preview/previewConfig'
import { readSceneMetaField } from '@/render/data/compactSceneDocument'
import { sceneDisplayTitleFromRootDocument } from '@/preview/sceneDisplayTitle'
import { PreviewSceneContextKey, createPreviewSceneStore } from '@/preview/sceneStore'
import { usePreviewTooltip, resolvePreviewTooltipText } from '@/preview/tooltip'
import { blockRegistryKeyForPalette } from '@/render/data/blockRegistryResolve'
import { renderTooltipHtml } from '@/workbench/components/renderTooltipHtml'

const props = defineProps<{
  mergedConfig: PreviewConfig
}>()

const store = createPreviewSceneStore(props.mergedConfig)
provide(PreviewSceneContextKey, store)

watch(() => props.mergedConfig, (cfg) => {
  store.config.value = cfg
})

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
  contentGroupRef,
  tooltipPalette,
  hasWorldMultiFrame,
  worldFrameIndex,
  worldFrameCount,
  layerPreviewLabel,
} = store

const f = computed(() => props.mergedConfig.features)
const showLayerBar = computed(() => f.value.layerBar)
const showFrameCtl = computed(() => f.value.frameControls)
const showTitle = computed(() => f.value.titleBar)
const showStats = computed(() => f.value.blockStatsSidebar)
const showDebugStatus = computed(() => f.value.debugStatusBar && props.mergedConfig.debug)

const hasBottomDock = computed(() =>
  (showFrameCtl.value && hasWorldMultiFrame.value) || showLayerBar.value,
)

type BottomTab = 'frame' | 'layer'
const activeTab = ref<BottomTab>(
  (showFrameCtl.value && hasWorldMultiFrame.value) ? 'frame' : 'layer',
)

const sceneDocument = computed(() => props.mergedConfig.renderBundle.document)

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

const tooltipDisplayText = computed(() => {
  const def = structureDefinition.value
  const h = hover.value
  if (!def || !h?.blockId) return ''
  return resolvePreviewTooltipText(def, tooltipPalette.value, h)
})

/** blockId → NEI tooltip 文本行（预计算映射） */
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
  const fromDoc = sceneDisplayTitleFromRootDocument(props.mergedConfig.renderBundle.document)
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

async function onViewportReady(scene: Scene): Promise<void> {
  store.registerScene(scene)
  try { await store.rebuildContentMesh() } catch (e) { console.error('[StructureRenderer] onViewportReady', e) }
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
onBeforeUnmount(() => { store.disposeCachesAndLibrary() })
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
      <!-- 方块统计侧栏（嵌入模式） -->
      <BlockStatsSidebar
        v-if="showStats && loadStatus === 'ok' && blockIconCache"
        :entries="blockStatsEntries" :cache="blockIconCache"
        @tooltip-hover="onSidebarTooltipHover"
      />
      <div class="wm-viewport-column">
        <StructureViewport
          v-if="loadStatus === 'ok' && structureDefinition && materialLibrary"
          :definition="structureDefinition" :material-library="materialLibrary"
          :content-group="contentGroupRef"
          :layer-preview-mode="layerPreviewMode" :scene-background="mergedConfig.sceneBackground"
          :show-axes-gizmo="f.showAxesGizmo"
          @ready="onViewportReady"
          @hover-block="onViewportHover"
        />
      </div>
    </div>

    <!-- 底部 Tab 控件栏（全宽，在主舞台下方） -->
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
.wm-root { font-family: system-ui, 'Segoe UI', sans-serif; color: var(--nei-text-dark); background: var(--nei-bg); padding: 8px; box-sizing: border-box; height: 100%; display: flex; flex-direction: column; }
.wm-title { margin: 0 0 6px; font-size: 13px; font-weight: 700; color: var(--nei-text); text-shadow: var(--nei-label-shadow); display: flex; flex-direction: row; align-items: center; gap: 8px; }
.wm-title-text { flex: 1; min-width: 0; }
.wm-title-meta { flex-shrink: 0; font-size: 13px; font-weight: 700; color: var(--nei-text-muted); background: none; border: none; cursor: help; padding: 0 2px; line-height: 1; }
.wm-title-meta:hover { color: var(--nei-text); }
.wm-main-stage { display: flex; flex: 1; flex-direction: row; align-items: stretch; min-height: 0; width: 100%; border-radius: 0; overflow: hidden; border: var(--nei-bevel-w) solid; border-color: var(--nei-highlight) var(--nei-shadow) var(--nei-shadow) var(--nei-highlight); border-bottom: none; background: var(--nei-bg); }
.wm-viewport-column { flex: 1; min-width: 0; display: flex; flex-direction: column; }

/* ===== 底部 Tab 控件栏 ===== */
.wm-bottom-dock {
  flex-shrink: 0;
  display: flex; flex-direction: column;
  border: var(--nei-bevel-w) solid;
  border-color: var(--nei-shadow) var(--nei-highlight) var(--nei-highlight) var(--nei-shadow);
  border-top: none;
  background: var(--nei-inset-bg);
}
.wm-tab-row {
  display: flex; align-items: center;
  gap: 0;
  padding: 0 4px;
  background: var(--nei-bg-deep);
  border-bottom: 1px solid var(--nei-shadow);
}
.wm-tab {
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
.wm-tab:hover { color: var(--nei-text); }
.wm-tab--active {
  color: var(--nei-text);
  border-bottom-color: var(--nei-accent);
}
.wm-tab-status {
  margin-left: auto;
  display: flex; align-items: center; gap: 14px;
  padding: 0 10px;
  font-size: 11px; font-family: ui-monospace, 'Cascadia Code', monospace;
  color: var(--nei-text-muted);
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.4);
  flex-shrink: 0;
}
.wm-tab-stat strong {
  color: var(--nei-text);
  font-weight: 600;
}
.wm-tab-panel {
  display: none;
  padding: 6px 10px;
  align-items: center; gap: 10px;
  height: 40px;
  background: var(--nei-inset-bg);
}
.wm-tab-panel--active { display: flex; }

/* 子组件嵌入 tab panel 时：拉伸填满，剥除外层边框背景 */
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

.wm-status-bar { display: flex; align-items: flex-start; gap: 8px; margin-top: 0; padding: 8px 10px; font-size: 12px; line-height: 1.45; font-family: ui-monospace, 'Cascadia Code', monospace; border-radius: 0; border: var(--nei-bevel-w) solid; border-color: var(--nei-shadow) var(--nei-highlight) var(--nei-highlight) var(--nei-shadow); border-top: none; background: var(--nei-inset-bg); color: var(--nei-text-muted); text-shadow: 0 1px 0 rgba(0, 0, 0, 0.45); }
.wm-status-bar--loading { color: var(--nei-loading-text); } .wm-status-bar--ok { color: var(--nei-ok-text); } .wm-status-bar--warn { color: var(--nei-warn-text); } .wm-status-bar--err { color: var(--nei-error-text); background: var(--nei-error-bg); }
.wm-status-dot { flex-shrink: 0; width: 8px; height: 8px; margin-top: 4px; border-radius: 0; background: currentColor; opacity: 0.9; box-shadow: 1px 1px 0 rgba(0, 0, 0, 0.4); }
.wm-status-text { flex: 1; word-break: break-word; white-space: pre-wrap; }
</style>
