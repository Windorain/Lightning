<script setup lang="ts">
/**
 * EmbedViewport — 嵌入场景的视口消费者。
 *
 * 对齐 WorkbenchViewport：
 * - useBContext() 取 bctx
 * - 本地 createRenderAssets 管理全部渲染状态
 * - 叶子组件全部 props/emits
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useBContext } from '@/workbench/context/bContext'
import { createRenderAssets } from '@/workbench/context/sceneLifecycle'
import ViewerCore, { type ViewerCoreReadyPayload } from '@/embed/components/ViewerCore.vue'
import LayerPreviewBar from '@/embed/components/LayerPreviewBar.vue'
import ToolTipBox from '@/embed/components/ToolTipBox.vue'
import WorldFramePlayerControls from '@/embed/components/WorldFramePlayerControls.vue'
import WorldFrameScrubber from '@/embed/components/WorldFrameScrubber.vue'
import BlockStatsSidebar from '@/embed/components/BlockStatsSidebar.vue'
import type { Annotation } from '@/render/data/annotationTypes'
import * as THREE from 'three'
import type { EmbedSettings } from '@/preview/previewConfig'
import type { InitialCamera } from '@/preview/previewConfig'
import { createEmbedKeymapHandler } from '@/embed/embedKeymap'
import { readSceneMetaField } from '@/render/data/compactSceneDocument'
import { sceneDisplayTitleFromRootDocument } from '@/preview/sceneDisplayTitle'
import { usePreviewTooltip, resolvePreviewTooltipText } from '@/preview/tooltip'
import { blockRegistryKeyForPalette } from '@/render/data/blockRegistryResolve'
import { renderTooltipHtml } from '@/workbench/components/renderTooltipHtml'
import type { BlockIconCache } from '@/render/interaction/blockIconCache'

// Embed operators — registered on bctx if not already present (Wiki mode)
import { ViewRotateOperator, ViewPanOperator, ViewZoomOperator } from '@/workbench/operators/builtin/viewOperators'
import { ResetViewOperator } from '@/embed/operators/resetViewOperator'

const props = defineProps<{
  settings?: EmbedSettings
}>()

const bctx = useBContext()

// Ensure embed operators are registered (workbench bctx may not have them)
for (const op of [ViewRotateOperator, ViewPanOperator, ViewZoomOperator, ResetViewOperator]) {
  if (!bctx.operators.find(op.id)) bctx.operators.register(op)
}

const EMBED_REGION = 'r-embed'
const vpSlot = bctx.viewports.get(EMBED_REGION) ?? bctx.viewports.register(EMBED_REGION)

// ---- 本地 ref —— 全部 renderAssets 自管 ----
const sceneRef = shallowRef<THREE.Scene | null>(null)
const loadStatus = ref<'loading' | 'ok' | 'error'>('loading')
const meshBusy = ref(false)
const blockIconCache = shallowRef<BlockIconCache | null>(null)
const tooltipPalette = shallowRef<string[]>([])
const worldFrameIndex = ref(0)
const layerWorldY = ref(props.settings?.initialLayerWorldY ?? -1)
const framesPlaybackIsPlaying = ref(false)
const showSettingsPanel = ref(false)

const docRef = computed(() => bctx.doc.value)

// ---- renderAssets ----
const renderAssets = createRenderAssets({
  docRef,
  loadStatus,
  meshBusy,
  blockIconCache,
  tooltipPalette,
  structureDefinition: vpSlot.definition,
  mainMeshGroup: vpSlot.contentGroup,
  sceneRef,
  worldFrameIndex,
  layerWorldY,
  framesPlaybackIsPlaying,
  blockIconCacheOptions: props.settings?.blockIconCacheOptions ?? {},
  initialWorldFrameIndex: props.settings?.initialWorldFrameIndex,
})

const {
  layerPreviewMode, layerPreviewLabel, gridHeight,
  hasWorldMultiFrame, worldFrameCount, blockStatsEntries,
} = renderAssets.computed

const materialLibrary = renderAssets.textureCache
const structureDefinition = computed(() => vpSlot.definition.value)
const mainMeshGroup = computed(() => vpSlot.contentGroup.value)

// ---- structEpoch → 重建 mesh（Wiki 模式同步） ----
watch(() => bctx.structEpoch.value, () => {
  void renderAssets.rebuildAll()
})

// ---- Hover / tooltip ----
const { hover, setHover, clearHover } = usePreviewTooltip()

// ---- Feature flags ----
const s = computed(() => props.settings)
const f = computed(() => s.value?.features)
const showLayerBar = computed(() => f.value?.layerBar ?? false)
const showFrameCtl = computed(() => f.value?.frameControls ?? false)
const showTitle = computed(() => f.value?.titleBar ?? false)
const showStats = computed(() => f.value?.blockStatsSidebar ?? false)
const showDebugStatus = computed(() => (f.value?.debugStatusBar ?? false) && (s.value?.debug ?? false))
const showAxesGizmo = computed(() => f.value?.showAxesGizmo ?? false)
const initialCamera = computed<InitialCamera | undefined>(() => s.value?.initialCamera)

const hasBottomDock = computed(() =>
  (showFrameCtl.value && hasWorldMultiFrame.value) || showLayerBar.value,
)

type BottomTab = 'frame' | 'layer'
const activeTab = ref<BottomTab>(
  (showFrameCtl.value && hasWorldMultiFrame.value) ? 'frame' : 'layer',
)

// ---- Title / meta hint ----
const sceneDocument = computed(() => bctx.doc.value)

const metaTooltipText = computed(() => {
  const d = sceneDocument.value
  if (!d) return ''
  const plain = d.serialize()
  const rows: string[] = []
  const pick = (label: string, key: string) => {
    const v = readSceneMetaField(plain, key).trim()
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
  const def = vpSlot.definition.value
  const h = hover.value
  if (!def || !h?.blockId) return ''
  return resolvePreviewTooltipText(def, tooltipPalette.value, h)
})

const neiTooltipMap = computed<Map<string, string[]>>(() => {
  const def = vpSlot.definition.value
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
  const doc = bctx.doc.value
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

// ---- Viewport events ----
let _annoGroup: THREE.Group | null = null
let _annoHash = ''
let _annoPending = false
let _alive = true
let _annoRafId: number | undefined
let unregHandlers: Array<() => void> = []

function updateAnnotationOverlay(): void {
  const doc = bctx.doc.value
  if (!doc) return
  const plain = doc.serialize() as Record<string, any>
  const annos: Annotation[] = plain.annotations ?? []
  const maxUpdated = annos.length > 0
    ? annos.reduce((max, a) => Math.max(max, a.updated_at), 0)
    : 0
  const hash = annos.length > 0 ? `${annos.length}_${maxUpdated}` : 'empty'
  if (hash === _annoHash || _annoPending) return
  _annoHash = hash
  _annoPending = true

  renderAssets.rebuildAnnotationOverlay(annos).then(group => {
    _annoPending = false
    if (_annoGroup) {
      vpSlot.overlayGroup.value?.remove(_annoGroup)
      _annoGroup.traverse((c) => {
        if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments || c instanceof THREE.Line) {
          c.geometry?.dispose()
          ;(c.material as THREE.Material)?.dispose()
        }
      })
      _annoGroup = null
    }
    if (group) {
      _annoGroup = group
      vpSlot.overlayGroup.value?.add(_annoGroup)
    }
  }).catch(() => { _annoPending = false })
}

function onViewportReady(payload: ViewerCoreReadyPayload): void {
  // Activate embed viewport slot so bctx.viewport (singular) resolves to this one
  bctx.viewports.activeId.value = EMBED_REGION

  renderAssets.registerScene(payload.scene)
  renderAssets.rebuildContentMesh().catch(e => { console.error('[EmbedViewport] rebuildContentMesh', e) })

  updateAnnotationOverlay()

  vpSlot.orbitTarget.value = payload.orbitTarget
  vpSlot.camera.value = payload.camera
  vpSlot.contentGroup.value = mainMeshGroup.value ?? new THREE.Group()
  vpSlot.domElement.value = payload.domElement
  vpSlot.definition.value = structureDefinition.value ?? null
  vpSlot.layerPreview.value = layerPreviewMode.value
  vpSlot.overlayGroup.value = payload.layers.overlay

  bctx.eventDispatcher.registerRegion(EMBED_REGION)
  unregHandlers.push(
    bctx.eventDispatcher.registerRegionHandler(
      EMBED_REGION,
      createEmbedKeymapHandler(EMBED_REGION, () => bctx),
    ),
  )

  const dom = payload.domElement
  dom.addEventListener('pointerdown', (e) => {
    bctx.viewports.activeId.value = EMBED_REGION
    if (e.button !== 0) e.preventDefault()
    bctx.eventDispatcher.dispatch(e, { regionId: EMBED_REGION })
  }, { capture: true })
  dom.addEventListener('pointermove', (e) => {
    bctx.eventDispatcher.dispatch(e, { regionId: EMBED_REGION })
  }, { capture: true })
  dom.addEventListener('pointerup', (e) => {
    bctx.eventDispatcher.dispatch(e, { regionId: EMBED_REGION })
  }, { capture: true })
  dom.addEventListener('wheel', (e) => {
    bctx.eventDispatcher.dispatch(e, { regionId: EMBED_REGION })
    e.preventDefault()
  }, { capture: true, passive: false })
  dom.addEventListener('contextmenu', (e) => { e.preventDefault() }, { capture: true })

  function rafTick() {
    if (!_alive) return
    _annoRafId = requestAnimationFrame(rafTick)
    updateAnnotationOverlay()
  }
  _annoRafId = requestAnimationFrame(rafTick)
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

onMounted(async () => { await renderAssets.loadStructureAndResources() })
onBeforeUnmount(() => {
  unregHandlers.forEach(fn => fn())
  bctx.eventDispatcher.unregisterRegion(EMBED_REGION)
  _alive = false
  if (_annoRafId) cancelAnimationFrame(_annoRafId)
  if (_annoGroup) {
    _annoGroup.traverse((c) => {
      if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments || c instanceof THREE.Line) {
        c.geometry?.dispose()
        ;(c.material as THREE.Material)?.dispose()
      }
    })
    _annoGroup = null
  }
  renderAssets.disposeCachesAndLibrary()
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
          :definition="structureDefinition"
          :material-library="materialLibrary"
          :content-group="mainMeshGroup"
          :layer-preview-mode="layerPreviewMode"
          :initial-camera="initialCamera"
          :scene-background="s?.sceneBackground ?? 0x5a5a5a"
          :show-axes-gizmo="showAxesGizmo"
          @ready="onViewportReady"
          @open-settings="showSettingsPanel = !showSettingsPanel"
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
        <WorldFramePlayerControls
          :has-world-multi-frame="hasWorldMultiFrame"
          :is-playing="framesPlaybackIsPlaying"
          @toggle="renderAssets.toggleWorldFramesPlayback()"
        />
        <WorldFrameScrubber
          :has-world-multi-frame="hasWorldMultiFrame"
          :frame-count="worldFrameCount"
          :is-playing="framesPlaybackIsPlaying"
          :mesh-busy="meshBusy"
          :world-frame-index="worldFrameIndex"
          @toggle-playback="renderAssets.toggleWorldFramesPlayback()"
          @set-frame="(i: number) => renderAssets.setCurrentWorldFrame(i)"
        />
      </div>
      <div v-if="showLayerBar" class="wm-tab-panel" :class="{ 'wm-tab-panel--active': activeTab === 'layer' }">
        <LayerPreviewBar
          :grid-height="gridHeight"
          :mesh-busy="meshBusy"
          :layer-world-y="layerWorldY"
          :layer-preview-label="layerPreviewLabel"
          @update:layer-y="(v: number) => { layerWorldY = v }"
        />
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

    <!-- 设置面板 -->
    <div v-if="showSettingsPanel" class="wm-settings-overlay" @click.self="showSettingsPanel = false">
      <div class="wm-settings-panel">
        <div class="wm-settings-head">
          <span>视口设置</span>
          <button class="wm-settings-close" @click="showSettingsPanel = false">✕</button>
        </div>
        <div class="wm-settings-body">
          <!-- TODO: 持久化设置 UI -->
          <p class="wm-settings-hint">设置面板 (WIP)</p>
          <p class="wm-settings-hint">功能开关通过 EmbedSettings.features 控制</p>
        </div>
      </div>
    </div>
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

/* Settings panel overlay */
.wm-settings-overlay {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0,0,0,0.55);
  display: flex; align-items: center; justify-content: center;
}
.wm-settings-panel {
  background: var(--nei-bg-deep, #1a1e28);
  border: 3px solid;
  border-color: var(--nei-bevel-light, #555) var(--nei-bevel-dark, #2a2a2a) var(--nei-bevel-dark, #2a2a2a) var(--nei-bevel-light, #555);
  min-width: 280px; max-width: 400px;
  font-family: ui-monospace, monospace; font-size: 12px; color: var(--nei-text, #c0c0c0);
}
.wm-settings-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px;
  background: var(--nei-bg-panel, #161a24);
  border-bottom: 2px solid var(--nei-border-subtle, #2a2a2a);
}
.wm-settings-close {
  border: none; background: none; color: #8a8e98; cursor: pointer;
  font-size: 14px; line-height: 1; padding: 2px 6px;
}
.wm-settings-close:hover { color: var(--nei-text, #c0c0c0); }
.wm-settings-body { padding: 16px; }
.wm-settings-hint { margin: 0; color: var(--nei-text-dim, #6a6e78); }
</style>
