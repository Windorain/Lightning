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
import { SelectionOutlinePass } from '@/render/postprocessing/SelectionOutlinePass'
import type { BakedQuad } from '@/render/schema/types'
import type { BlockIconCache } from '@/render/interaction/blockIconCache'

const props = defineProps<{
  settings?: EmbedSettings
}>()

const bctx = useBContext()

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
const viewerCoreRef = ref<InstanceType<typeof ViewerCore> | null>(null)
const wmRoot = ref<HTMLDivElement | null>(null)
const sidebarCollapsed = ref(false)
const selectedBlockId = ref<string | null>(null)
let _outlinePass: SelectionOutlinePass | null = null

function buildBlockMaskMesh(
  quads: BakedQuad[],
  cx: number, cy: number, cz: number,
): THREE.Mesh | null {
  const corner = { x: cx - 0.5, y: cy - 0.5, z: cz - 0.5 }
  const verts: number[] = []
  const indices: number[] = []
  let vi = 0

  for (const q of quads) {
    if (q.vertices.length < 4) continue
    const v0 = vi, v1 = vi + 1, v2 = vi + 2, v3 = vi + 3
    indices.push(v0, v1, v2, v0, v2, v3)
    for (const v of q.vertices) {
      verts.push(v.x + corner.x, v.y + corner.y, v.z + corner.z)
    }
    vi += 4
  }

  if (verts.length === 0) return null

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  geo.setIndex(indices)
  return new THREE.Mesh(geo)
}

function updateBlockHighlight(blockId: string | null): void {
  if (!_outlinePass) return

  if (!blockId) {
    _outlinePass.setMaskMeshes([])
    return
  }

  const def = vpSlot.definition.value
  if (!def) { _outlinePass.setMaskMeshes([]); return }

  const { cellGrid, blockPalette } = def
  const sizeZ = cellGrid.length
  const sizeRow = cellGrid[0]?.length ?? 0
  const sizeCol = cellGrid[0]?.[0]?.length ?? 0
  if (sizeZ === 0 || sizeRow === 0 || sizeCol === 0) { _outlinePass.setMaskMeshes([]); return }

  const masks: THREE.Mesh[] = []

  for (let z = 0; z < sizeZ; z++) {
    for (let row = 0; row < sizeRow; row++) {
      const sliceRow = cellGrid[z]?.[row]
      if (!sliceRow) continue
      for (let col = 0; col < sizeCol; col++) {
        const idx = sliceRow[col]
        if (idx === undefined || idx < 0) continue
        const entry = blockPalette[idx]
        if (!entry) continue
        if (blockRegistryKeyForPalette(entry.registryId, entry.meta) !== blockId) continue

        const voxelY = sizeRow - 1 - row
        const cx = col - sizeCol / 2 + 0.5
        const cy = voxelY - sizeRow / 2 + 0.5
        const cz = z - sizeZ / 2 + 0.5

        const quads = entry.geometry?.quads
        if (quads && quads.length > 0 && quads.some(q => q.vertices.length >= 4)) {
          const mesh = buildBlockMaskMesh(quads, cx, cy, cz)
          if (mesh) masks.push(mesh)
        } else {
          // Fallback: axis-aligned unit cube
          const geo = new THREE.BoxGeometry(1, 1, 1)
          geo.translate(cx, cy, cz)
          masks.push(new THREE.Mesh(geo))
        }
      }
    }
  }

  _outlinePass.setMaskMeshes(masks)
}

function onSidebarSelectBlock(blockId: string): void {
  selectedBlockId.value = selectedBlockId.value === blockId ? null : blockId
}

watch(selectedBlockId, (id) => {
  updateBlockHighlight(id)
})

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
  if (lines && lines.length > 0) {
    return lines.map(l => renderTooltipHtml(l)).join('<br>')
  }
  // Fallback: show blockId as display name when tooltip data is missing
  const colon = h.blockId.lastIndexOf(':')
  return colon >= 0 ? h.blockId.slice(colon + 1) : h.blockId
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

  // Screen-space outline pass for block highlight
  const outlinePass = new SelectionOutlinePass(
    new THREE.Vector2(payload.domElement.clientWidth, payload.domElement.clientHeight),
  )
  outlinePass.setCamera(payload.camera as THREE.Camera)
  payload.renderer.setOutlinePass(outlinePass)
  _outlinePass = outlinePass

  renderAssets.registerScene(payload.mainScene)
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

// ---- Annotation hover tooltip ----
const annotationHover = ref<{ annotationId: string; clientX: number; clientY: number } | null>(null)

function onAnnotationHover(
  payload: { annotationId: string; clientX: number; clientY: number } | null,
): void {
  annotationHover.value = payload
}

const annotationTooltipText = computed(() => {
  const h = annotationHover.value
  if (!h) return ''
  const doc = bctx.doc.value
  if (!doc) return ''
  const plain = doc.serialize() as Record<string, any>
  const annos = plain.annotations as Annotation[] | undefined
  const anno = annos?.find(a => a.id === h.annotationId)
  if (!anno) return ''
  const parts: string[] = []
  if (anno.title) parts.push(anno.title)
  if (anno.description) parts.push(anno.description)
  return parts.join('\n')
})

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
  if (_outlinePass) {
    _outlinePass.dispose()
    _outlinePass = null
  }
  renderAssets.disposeCachesAndLibrary()
})
</script>

<template>
  <div ref="wmRoot" class="wm-root">
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
        <button type="button" class="nei-icon-btn" title="复位视角" @click="viewerCoreRef?.resetView()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 3.1L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-3.1L3 16"/><path d="M3 21v-5h5"/></svg>
        </button>
        <button type="button" class="nei-icon-btn" title="截屏" @click="viewerCoreRef?.screenshot()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
        </button>
        <button type="button" class="nei-icon-btn" title="全屏" @click="toggleFullscreen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
        </button>
        <span class="wm-titlebar-sep" />
        <button type="button" class="nei-icon-btn" title="在编辑器中打开 (TODO)" disabled>
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
        <ViewerCore
          ref="viewerCoreRef"
          v-if="loadStatus === 'ok' && structureDefinition && materialLibrary"
          :definition="structureDefinition"
          :material-library="materialLibrary"
          :content-group="mainMeshGroup"
          :layer-preview-mode="layerPreviewMode"
          :initial-camera="initialCamera"
          :scene-background="s?.sceneBackground ?? 0x5a5a5a"
          :show-axes-gizmo="showAxesGizmo"
          @ready="onViewportReady"
          @hover-block="onViewportHover"
          @hover-annotation="onAnnotationHover"
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
    <ToolTipBox v-if="annotationHover && annotationTooltipText" :text="annotationTooltipText" :client-x="annotationHover.clientX" :client-y="annotationHover.clientY" />
    <ToolTipBox v-if="metaHintPointer && metaTooltipText" :text="metaTooltipText" :client-x="metaHintPointer.clientX" :client-y="metaHintPointer.clientY" />

    <!-- 设置面板 -->
    <Transition name="fade">
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
    </Transition>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active { transition: opacity 0.15s ease; }
.fade-enter-from,
.fade-leave-to { opacity: 0; }

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
  box-shadow: 0 1px 0 var(--nei-highlight);
}
.wm-tab {
  padding: 6px 14px 5px;
  font-size: 11px; font-family: var(--nei-font-mono);
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
  font-size: 11px; font-family: var(--nei-font-mono);
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
  height: 48px;
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

.wm-status-bar { display: flex; align-items: flex-start; gap: 8px; margin-top: 0; padding: 8px 10px; font-size: 12px; line-height: 1.45; font-family: var(--nei-font-mono); border-radius: 0; border: var(--nei-bevel-w) solid; border-color: var(--nei-shadow) var(--nei-highlight) var(--nei-highlight) var(--nei-shadow); border-top: none; background: var(--nei-inset-bg); color: var(--nei-text-muted); text-shadow: 0 1px 0 rgba(0, 0, 0, 0.45); }
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
  background: var(--nei-bg-deep);
  border: var(--nei-bevel-w) solid;
  border-color: var(--nei-bevel-light) var(--nei-bevel-dark) var(--nei-bevel-dark) var(--nei-bevel-light);
  min-width: 280px; max-width: 400px;
  font-family: var(--nei-font-mono); font-size: 12px; color: var(--nei-text);
}
.wm-settings-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px;
  background: var(--nei-bg-panel);
  border-bottom: 1px solid var(--nei-shadow);
  box-shadow: 0 1px 0 var(--nei-highlight);
}
.nei-icon-btn:focus-visible {
  outline: 2px solid var(--nei-focus-ring);
  outline-offset: 2px;
}
.wm-tab:focus-visible {
  outline: 2px solid var(--nei-focus-ring);
  outline-offset: -1px;
}

.wm-settings-close {
  border: none; background: none; color: var(--nei-icon-color); cursor: pointer;
  font-size: 14px; line-height: 1; padding: 2px 6px;
}
.wm-settings-close:hover { color: var(--nei-text); }
.wm-settings-body { padding: 16px; }
.wm-settings-hint { margin: 0; color: var(--nei-text-dim); }
</style>
