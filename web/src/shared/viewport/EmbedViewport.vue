<script setup lang="ts">
/**
 * EmbedViewport — 嵌入场景的视口消费者。
 *
 * 对齐 WorkbenchViewport：
 * - useContext() 取 ctx
 * - 本地 DRW 管理 mesh/材质/帧状态
 * - 叶子组件全部 props/emits
 */
import { computed, inject, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import * as THREE from 'three'
import { useContext } from '@/runtime/context'
import { hostKey } from '@/runtime/host'
import type { Host } from '@/runtime/host'
import { resolveEmbedViewportRegionId, resolveEmbedViewerPreferences } from '@/runtime/embedViewportRegion'
import { REGION } from '@/runtime/regionIds'
import { useViewportRuntime } from '@/shared/viewport/useViewportRuntime'
import { blockRefFromViewportHover } from '@/runtime/hover'
import { createEmbedSidebarOutlineMasks } from '@/runtime/embedSidebarOutline'
import { getBlockGeometry, gridCenterWorld } from '@/context/queries'
import RenderEngineHost from '@/shared/viewport/RenderEngineHost.vue'
import type { RenderEngineReadyPayload } from '@/runtime/renderEngine'
import { createHoverHandler } from '@/handlers/hoverHandler'
import ViewportFrameLayerDock from '@/shared/viewport/ViewportFrameLayerDock.vue'
import ToolTipBox from '@/embed/components/ToolTipBox.vue'
import BlockStatsSidebar from '@/embed/components/BlockStatsSidebar.vue'
import type { EmbedSettings } from '@/viewer/viewerConfig'
import { createKeymapHandler } from '@/handlers/keymapHandler'
import { createEmbedTouchHandler } from '@/embed/embedTouchHandler'
import { sceneDisplayTitleFromRootDocument } from '@/viewer/sceneDisplayTitle'
import { embedHoverFromState } from '@/runtime/hover'
import { useEmbedTooltip } from '@/embed/useEmbedTooltip'
import { useEmbedLayoutProfile } from '@/embed/useEmbedLayoutProfile'
import EmbedSettingsPanel from '@/embed/components/EmbedSettingsPanel.vue'

const props = defineProps<{
  settings?: EmbedSettings
}>()

const ctx = useContext()
const host = inject(hostKey)! as Host

const viewportRegionId = resolveEmbedViewportRegionId(ctx)
const viewportRegion = ctx.requireRegion(viewportRegionId)
const hoverState = viewportRegion.state.hover!
const prefs = resolveEmbedViewerPreferences(ctx)

const {
  drw, vpSlot, loadStatus, meshBusy, blockIconCache, tooltipPalette,
  structureDefinition, mainMeshGroup, worldFrameIndex, layerWorldY, framesPlaybackIsPlaying,
  computed: drwComputed, materialLibrary,
} = useViewportRuntime({
  ctx,
  regionId: viewportRegionId,
  viewerPrefs: prefs,
  blockIconCacheOptions: props.settings?.blockIconCacheOptions ?? {},
  initialWorldFrameIndex: props.settings?.initialWorldFrameIndex,
})

const {
  layerPreviewMode, layerPreviewLabel, gridHeight,
  hasWorldMultiFrame, worldFrameCount, blockStatsEntries,
} = drwComputed

const showSettingsPanel = ref(false)

// ---- Hover / tooltip（region.state.hover + 统一 HOVER handler）----
const hover = embedHoverFromState(hoverState)
const engineHostRef = ref<InstanceType<typeof RenderEngineHost> | null>(null)
const wmRoot = ref<HTMLDivElement | null>(null)
const sidebarCollapsed = ref(false)
const { layoutClass, profile } = useEmbedLayoutProfile(wmRoot)

watch(profile, (p) => {
  if (p === 'narrow' || p === 'tiny') sidebarCollapsed.value = true
}, { immediate: true })

const initCameraProps = { _regionId: viewportRegionId }

const didInitCamera = ref(false)
watch(loadStatus, (status) => {
  if (didInitCamera.value || status !== 'ok') return
  if (!mainMeshGroup.value) return
  didInitCamera.value = true
  void ctx.getOperators().exec('OPERATOR_INIT_VIEWPORT_CAMERA', initCameraProps)
})
watch(() => ctx.getDoc().value, () => {
  didInitCamera.value = false
})

const isWikiWorkbenchPreview = viewportRegionId === REGION.WIKI_PREVIEW
watch(
  () => [
    ctx.main.initialCameras.embed.value.yawDeg,
    ctx.main.initialCameras.embed.value.elevationDeg,
    ctx.main.initialCameras.embed.value.zoom,
  ],
  () => {
    if (!isWikiWorkbenchPreview || loadStatus.value !== 'ok' || !mainMeshGroup.value) return
    void ctx.getOperators().exec('OPERATOR_INIT_VIEWPORT_CAMERA', initCameraProps)
  },
)

const selectedBlockId = ref<string | null>(null)

/** 勿用 ref：深度响应式会代理 Mesh，破坏 Three.js 矩阵访问 */
const sidebarExtraMasks = shallowRef<THREE.Mesh[]>([])
const emptySelection = ref(new Set<import('@/context/selection').SelectedEntity>())
const hoveredBlockForOutline = computed(() =>
  blockRefFromViewportHover(ctx, hoverState.viewportBlock.value),
)
const { rebuildSelectionMasks } = createEmbedSidebarOutlineMasks({
  definitionRef: vpSlot.definition,
  masksRef: sidebarExtraMasks,
})

// ---- Tooltip text (extracted composable) ----
const { tooltipText, neiTooltipMap, showMetaHint } = useEmbedTooltip({
  hoverRef: hover,
  definitionRef: vpSlot.definition,
  tooltipPaletteRef: tooltipPalette,
  showHoverTooltipRef: computed(() => prefs.showHoverTooltip),
  docRef: ctx.getDoc(),
})

function onSidebarSelectBlock(blockId: string): void {
  selectedBlockId.value = selectedBlockId.value === blockId ? null : blockId
}

watch(selectedBlockId, (id) => { rebuildSelectionMasks(id) })

function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    document.exitFullscreen()
  } else {
    wmRoot.value?.requestFullscreen?.()
  }
}

// ---- Feature flags ----
const s = computed(() => props.settings)
const f = computed(() => s.value?.features)
const showLayerBar = computed(() => f.value?.layerBar ?? false)
const showFrameCtl = computed(() => f.value?.frameControls ?? false)
const showTitle = computed(() => f.value?.titleBar ?? false)
const showStats = computed(() => f.value?.blockStatsSidebar ?? false)
const showDebugStatus = computed(() => (f.value?.debugStatusBar ?? false) && (s.value?.debug ?? false))
const showAxesGizmo = computed(() => f.value?.showAxesGizmo ?? false)
const hasBottomDock = computed(() =>
  (showFrameCtl.value && hasWorldMultiFrame.value) || showLayerBar.value,
)

type BottomTab = 'frame' | 'layer'
const activeTab = ref<BottomTab>(
  (showFrameCtl.value && hasWorldMultiFrame.value) ? 'frame' : 'layer',
)

function onMetaHintPointerEnter(e: PointerEvent): void { hoverState.setMeta({ clientX: e.clientX, clientY: e.clientY }) }
function onMetaHintPointerMove(e: PointerEvent): void { hoverState.setMeta({ clientX: e.clientX, clientY: e.clientY }) }
function onMetaHintPointerLeave(): void { hoverState.setMeta(null) }
function onMetaHintFocusIn(e: FocusEvent): void { const t = e.currentTarget as HTMLElement; const r = t.getBoundingClientRect(); hoverState.setMeta({ clientX: r.left + r.width / 2, clientY: r.bottom }) }
function onMetaHintFocusOut(): void { hoverState.setMeta(null) }

const previewTitle = computed(() => {
  const doc = ctx.getDoc().value
  if (!doc) return ''
  const fromDoc = sceneDisplayTitleFromRootDocument(doc.serialize())
  if (fromDoc) return fromDoc
  const def = vpSlot.definition.value
  const lab = def?.label?.trim()
  if (lab) return lab
  const id = def?.id?.trim()
  if (id) return id
  return '结构预览'
})

const statusBarClass = computed(() => {
  if (loadStatus.value === 'error') return 'wm-status-bar wm-status-bar--err'
  if (loadStatus.value === 'loading') return 'wm-status-bar wm-status-bar--loading'
  return 'wm-status-bar wm-status-bar--ok'
})

const statusSummary = computed(() => {
  if (loadStatus.value === 'loading') return '加载中…'
  if (loadStatus.value === 'error') return ''
  const parts: string[] = ['场景已加载']
  if (hasWorldMultiFrame.value) {
    parts.push(`${worldFrameCount.value} Frames`)
  }
  return parts.join(' · ')
})

async function onViewportReady(payload: RenderEngineReadyPayload): Promise<void> {
  await host.attachViewport(viewportRegionId, {
    drw,
    payload,
    layerPreviewMode: layerPreviewMode.value,
    structureDefinition,
    mainMeshGroup,
    handlers: {
      hover: createHoverHandler(viewportRegionId, () => ctx),
      gizmo: createEmbedTouchHandler(viewportRegionId, () => ctx),
      keymap: createKeymapHandler(viewportRegionId, () => ctx),
    },
    selectionOutline: {
      selectionItems: emptySelection,
      hoveredBlock: hoveredBlockForOutline,
      highlightOnHover: computed(() => prefs.highlightOnHover),
      getBlockGeometry: (pos) => getBlockGeometry(ctx, pos),
      gridCenterWorld: (pos) => gridCenterWorld(ctx, pos),
      extraMaskMeshes: sidebarExtraMasks,
    },
    documentKeydown: false,
  })
}

function setFrameIndex(i: number): void {
  void ctx.getOperators().exec('OPERATOR_SET_FRAME_INDEX', { index: i })
}

function togglePlayback(): void {
  void ctx.getOperators().exec('OPERATOR_TOGGLE_FRAME_PLAYBACK')
}

function onSidebarTooltipHover(
  payload: { blockId: string; clientX: number; clientY: number; source: 'sidebar' } | null,
): void {
  hoverState.setSidebarBlock(payload)
}

onMounted(async () => { await drw.loadStructureAndResources() })
onBeforeUnmount(() => {
  host.detachViewport(viewportRegionId)
  ctx.wm.events.unregisterRegion(viewportRegionId)
  drw.dispose()
})
</script>

<template>
  <div ref="wmRoot" class="wm-root" :class="layoutClass">
    <!-- Title bar -->
    <header v-if="showTitle" class="wm-titlebar">
      <div class="wm-titlebar-left">
        <span class="wm-title-text">{{ previewTitle }}</span>
        <span
          v-if="showMetaHint" class="wm-title-meta" tabindex="0" aria-label="作者与版本号"
          @pointerenter="onMetaHintPointerEnter" @pointermove="onMetaHintPointerMove"
          @pointerleave="onMetaHintPointerLeave" @focusin="onMetaHintFocusIn" @focusout="onMetaHintFocusOut"
        >?</span>
      </div>
      <div class="wm-titlebar-actions">
        <button type="button" class="nei-icon-btn wsr-mobile-hide" title="复位视角" @click="void ctx.getOperators().exec('OPERATOR_VIEW_RESET', initCameraProps)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 3.1L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-3.1L3 16"/><path d="M3 21v-5h5"/></svg>
        </button>
        <button type="button" class="nei-icon-btn wsr-mobile-hide" title="截屏" @click="engineHostRef?.screenshot()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
        </button>
        <button type="button" class="nei-icon-btn" title="全屏" @click="toggleFullscreen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
        </button>
        <span class="wm-titlebar-sep wsr-mobile-hide" />
        <button type="button" class="nei-icon-btn wsr-mobile-hide" title="在编辑器中打开 (TODO)" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
        <button type="button" class="nei-icon-btn" title="设置" @click="showSettingsPanel = !showSettingsPanel">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      </div>
    </header>

    <div class="wm-main-stage">
      <BlockStatsSidebar
        v-if="showStats && loadStatus === 'ok' && blockIconCache"
        :entries="blockStatsEntries" :cache="blockIconCache"
        :collapsed="sidebarCollapsed"
        :selected-block-id="selectedBlockId"
        :tooltip-map="neiTooltipMap"
        @tooltip-hover="onSidebarTooltipHover"
        @toggle-collapse="sidebarCollapsed = !sidebarCollapsed"
        @select-block="onSidebarSelectBlock"
      />
      <div class="wm-viewport-column">
        <RenderEngineHost
          ref="engineHostRef"
          v-if="loadStatus === 'ok' && structureDefinition && materialLibrary"
          :definition="structureDefinition"
          :material-library="materialLibrary"
          :content-group="mainMeshGroup"
          :layer-preview-mode="layerPreviewMode"
          :scene-background="s?.sceneBackground ?? 0x5a5a5a"
          :show-axes-gizmo="showAxesGizmo"
          @ready="onViewportReady"
        />
      </div>
    </div>

    <ViewportFrameLayerDock
      v-if="hasBottomDock && loadStatus === 'ok'"
      v-model:active-tab="activeTab"
      theme="embed"
      :show-frame-tab="showFrameCtl"
      :show-layer-tab="showLayerBar"
      :has-world-multi-frame="hasWorldMultiFrame"
      :world-frame-index="worldFrameIndex"
      :world-frame-count="worldFrameCount"
      :frames-playback-is-playing="framesPlaybackIsPlaying"
      :mesh-busy="meshBusy"
      :grid-height="gridHeight"
      :layer-world-y="layerWorldY"
      :layer-preview-label="layerPreviewLabel"
      @set-frame="setFrameIndex"
      @toggle-playback="togglePlayback"
      @update:layer-y="(v: number) => { void ctx.getOperators().exec('OPERATOR_SET_LAYER_Y', { y: v }) }"
    />

    <!-- 调试状态栏 -->
    <div v-if="showDebugStatus" :class="statusBarClass" role="status" aria-live="polite">
      <span class="wm-status-dot" aria-hidden="true" />
      <span class="wm-status-text">{{ statusSummary }}</span>
    </div>

    <ToolTipBox v-if="hover && tooltipText" :text="tooltipText" :client-x="hover.clientX" :client-y="hover.clientY" :offset="prefs.tooltipOffset" />

    <EmbedSettingsPanel :show="showSettingsPanel" :prefs="prefs" @close="showSettingsPanel = false" />
  </div>
</template>

<style scoped>
.wm-root { font-family: system-ui, 'Segoe UI', sans-serif; color: var(--nei-text); background: var(--nei-bg); box-sizing: border-box; height: 100%; display: flex; flex-direction: column; }
/* Title bar — 40px, 2-tone bevel bottom (MC: highlight line + shadow line) */
.wm-titlebar { flex-shrink: 0; height: var(--nei-title-height); display: flex; align-items: center; padding: 0 10px; border-bottom: 1px solid var(--nei-shadow); box-shadow: 0 1px 0 var(--nei-highlight); background: var(--nei-bg-panel); }
.wm-titlebar-left { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
.wm-title-text { font-size: 13px; font-weight: 700; color: var(--nei-text); text-shadow: var(--nei-text-shadow-deep); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wm-title-meta { flex-shrink: 0; font-size: 13px; font-weight: 700; color: var(--nei-text-dim); background: none; border: none; cursor: help; padding: 0 2px; line-height: 1; }
.wm-title-meta:hover { color: var(--nei-text); }
.wm-titlebar-actions { display: flex; align-items: center; gap: 3px; flex-shrink: 0; margin-left: 12px; }
.wm-titlebar-sep { width: 1px; height: 18px; background: var(--nei-titlebar-sep); margin: 0 5px; flex-shrink: 0; }
/* Icon buttons — MC bevel: raised on normal, inset on active */
.nei-icon-btn { width: var(--nei-icon-btn-size); height: var(--nei-icon-btn-size); padding: 0; display: inline-flex; align-items: center; justify-content: center; color: var(--nei-icon-color); background: var(--nei-bg); border: var(--nei-bevel-w) solid; border-color: var(--nei-highlight) var(--nei-shadow) var(--nei-shadow) var(--nei-highlight); cursor: pointer; }
.nei-icon-btn:hover { color: var(--nei-icon-hover); filter: brightness(1.06); }
.nei-icon-btn:active { color: var(--nei-icon-active); border-color: var(--nei-shadow) var(--nei-highlight) var(--nei-highlight) var(--nei-shadow); }
.nei-icon-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.nei-icon-btn svg { width: var(--nei-icon-svg-size); height: var(--nei-icon-svg-size); }
.wm-main-stage { display: flex; flex: 1; flex-direction: row; align-items: stretch; min-height: 0; width: 100%; overflow: hidden; background: var(--nei-bg); }
.wm-viewport-column { flex: 1; min-width: 0; display: flex; flex-direction: column; }

.wm-status-bar { display: flex; align-items: flex-start; gap: 8px; margin-top: 0; padding: 8px 10px; font-size: 12px; line-height: 1.45; font-family: var(--nei-font-mono); border-radius: 0; border: var(--nei-bevel-w) solid; border-color: var(--nei-shadow) var(--nei-highlight) var(--nei-highlight) var(--nei-shadow); border-top: none; background: var(--nei-inset-bg); color: var(--nei-text-muted); text-shadow: 0 1px 0 rgba(0, 0, 0, 0.45); }
.wm-status-bar--loading { color: var(--nei-loading-text); } .wm-status-bar--ok { color: var(--nei-ok-text); } .wm-status-bar--warn { color: var(--nei-warn-text); } .wm-status-bar--err { color: var(--nei-error-text); background: var(--nei-error-bg); }
.wm-status-dot { flex-shrink: 0; width: 8px; height: 8px; margin-top: 4px; border-radius: 0; background: currentColor; opacity: 0.9; box-shadow: 1px 1px 0 rgba(0, 0, 0, 0.4); }
.wm-status-text { flex: 1; word-break: break-word; white-space: pre-wrap; }

.nei-icon-btn:focus-visible {
  outline: 2px solid var(--nei-focus-ring);
  outline-offset: 2px;
}

.wm-root.wsr-layout-narrow .wsr-mobile-hide,
.wm-root.wsr-layout-tiny .wsr-mobile-hide {
  display: none !important;
}
</style>
