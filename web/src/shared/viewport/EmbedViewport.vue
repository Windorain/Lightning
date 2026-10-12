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
import { useViewportRuntime } from '@/shared/viewport/useViewportRuntime'
import { useKernelChannels } from '@/shared/viewport/useKernelChannels'
import { availableDockTabs, defaultDockTab, resolveDockTab, type ViewportDockTab } from '@/shared/viewport/dockTabs'
import { blockRefFromViewportHover } from '@/runtime/hover'
import { createEmbedSidebarOutlineMasks } from '@/runtime/embedSidebarOutline'
import { createEmbedItemOutlineMasks } from '@/runtime/embedItemOutline'
import {
  getBlockGeometry,
  getPartMaskGeometry,
  gridCenterWorld,
  currentFrameKey,
} from '@/context/queries'
import { buildItemHitIndex, type ItemHitIndex } from '@/pure/itemIndex'
import {
  EMPTY_ITEM_SELECTION,
  applyItemRowClick,
  clearItemSelection,
  type ItemSelectionState,
} from '@/pure/itemSelection'
import { OUTLINE_MASK_LIMIT } from '@/presentation/outlineBudget'
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

/**
 * 多方块通道取值（**归内核编辑上下文**；#282 P10b）。
 *
 * 必须在 DRW 构造前创建，`renderDoc` 作为 DRW 的文档来源。
 * 帧为主文档时 `renderDoc` 即 `ctx.getDoc()`，渲染路径行为零变化。
 *
 * 与旧 `useMultiblockChannels` 的差别：本 composable **不持有**取值状态
 * （旧形态每视口自持 `state` + `revision`），取值权威是
 * `EditContext.channelValues`，写入经 `setChannelValue` 命令。
 * 于是"同一上下文的所有 Area 读到同一份取值"（#249 §3.3、A05）。
 */
const mb = useKernelChannels(ctx)
// #301 P10f D3（R9）：渲染链旧格式源文档的 **Ref 视图**（`Context` 只给值 ⇒
// 响应式包装留在调用点，避免第二处持有 `Ref<RuntimeDocument>` 的权威）。
const legacyRenderDoc = computed(() => ctx.legacyRenderSource())
const {
  isMultiblock, renderDoc,
  panel: channelPanel,
  setTier: setChannelTier, setChannelValue, setRunstate: setChannelRunstate,
} = mb

const {
  drw, vpSlot, loadStatus, meshBusy, blockIconCache, tooltipPalette,
  structureDefinition, mainMeshGroup, worldFrameIndex, layerWorldY, isPlaying,
  computed: drwComputed, materialLibrary,
} = useViewportRuntime({
  ctx,
  regionId: viewportRegionId,
  viewerPrefs: prefs,
  blockIconCacheOptions: props.settings?.blockIconCacheOptions ?? {},
  initialWorldFrameIndex: props.settings?.initialWorldFrameIndex,
  docOverride: renderDoc,
})

const {
  layerPreviewMode, layerPreviewLabel, gridHeight,
  hasWorldMultiFrame, worldFrameCount, blockStatsEntries,
} = drwComputed

/**
 * F2 接线（拍板：**prop 传递**，与 P2.4 的消费点一致 —— `BlockStatsSidebar` 已内建
 * `partIconTextures` prop 并在其 watch 内注入 `BlockIconCache#setPartIconTextureSource`，
 * 故本组件只负责把**文档根字段**送到该 prop，不在视口侧重复注入缓存）。
 *
 * 数据来源 = 渲染定义根（`structureDefinition`，即 DRW 解析后的 `StructureDefinition`）：
 * `partIconTextures` 是**文档根级**字段（非 structure 级），
 * 经解析链（StructureDataParser 根透传 / V2Plain `_extra` 兜底）→ `RuntimeDocument.serialize()`
 * 根展开 → `toStructureDefinition` 浅拷贝挂到该对象上；与侧栏回退读取的
 * `cache.getStructure()` 是**同一份对象**（DRW 用同一 definition 重建图标缓存）。
 * 键 = 物品身份键（`registry:damage[#nbt]`，契约 §5）；缺省/空 ⇒ null（纯回退链，行为同旧文件）。
 * （本轮同级的 `statsTemplate`/`statsOverride` 语义已随决策 C 作废，本组件不再读取。）
 */
type PartIconTexturesCarrier = { partIconTextures?: Record<string, string> }
const partIconTextures = computed<Record<string, string> | null>(() => {
  const raw = (structureDefinition.value as unknown as PartIconTexturesCarrier | null)?.partIconTextures
  return raw && typeof raw === 'object' ? raw : null
})

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
// #301 P10f C′1（N9）：这里要的是**窄**信号 —— "**换了一份文档**"。
// 原来 watch `getDoc().value`（文档 Ref 身份），等价物是 `getDocumentRevision()`
// （只在 `replaceDoc` 自增）。
// ⚠️ **不能**换成 `getContentRefreshTick()`：那一个原地编辑（`requestContentRefresh`，
// 例如移动方块）也会自增 ⇒ 用户编辑到一半机位被重置回初始视角。
watch(() => ctx.getDocumentRevision().value, () => {
  didInitCamera.value = false
})

/**
 * 旧文件（宿主清单）选中：单值，单击切换。
 * B-5 的**物品行**选择不走这里——见下方 `itemSelection`（集合 + 锚点）。
 */
const selectedBlockId = ref<string | null>(null)

/** B-5：左栏物品行选择（集合语义 + 锚点；语义实现 = `pure/itemSelection.ts`） */
const itemSelection = shallowRef<ItemSelectionState>(EMPTY_ITEM_SELECTION)
const selectedItemKeys = computed<ReadonlySet<string>>(() => itemSelection.value.selected)
const selectionAnchor = computed<string | null>(() => itemSelection.value.anchor)

/** B-2 落盘 `itemIndex` 的反查索引（消费点；旧文件缺省 ⇒ 空表 ⇒ 全部行"没有对应方块"） */
const itemHitIndex = computed<ItemHitIndex>(() => buildItemHitIndex(structureDefinition.value))

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

/**
 * B-5：选中物品键集合 → mask。与 `rebuildSelectionMasks` 写入**同一个** `sidebarExtraMasks`
 * 通道（`drw.bindSelectionOutline` 的 `extraMaskMeshes`），因此呈现与 hover 完全一致。
 */
const { rebuildItemSelectionMasks, plan: itemOutlinePlan } = createEmbedItemOutlineMasks({
  definitionRef: vpSlot.definition,
  masksRef: sidebarExtraMasks,
  indexRef: () => itemHitIndex.value,
  frameRef: () => currentFrameKey(ctx),
  getBlockGeometry: (pos) => getBlockGeometry(ctx, pos),
  gridCenterWorld: (pos) => gridCenterWorld(ctx, pos),
  getPartMaskGeometry: (ref) => getPartMaskGeometry(ctx, ref),
})

/**
 * 两条高亮路径**互斥**（部件文件走物品行、旧文件走宿主行），物品路径优先：
 * 切换路径时先清空另一条，避免上一份 mask 残留叠加（两个 builder 共用同一个 mask 槽）。
 * 定义变化（换帧/换文档）也要重算——命中下标是相对当前渲染定义解析的。
 */
function rebuildOutline(): void {
  const keys = selectedItemKeys.value
  if (keys.size > 0) {
    rebuildSelectionMasks(null)
    rebuildItemSelectionMasks(keys)
    return
  }
  rebuildItemSelectionMasks(null)
  rebuildSelectionMasks(selectedBlockId.value)
}

// ---- Tooltip text (extracted composable) ----
const { tooltipText, neiTooltipMap, showMetaHint } = useEmbedTooltip({
  hoverRef: hover,
  definitionRef: vpSlot.definition,
  tooltipPaletteRef: tooltipPalette,
  showHoverTooltipRef: computed(() => prefs.showHoverTooltip),
  // #301 P10f D3（R9）：渲染链的旧格式源文档（**已登记接缝** `legacy-render-source-document`）
  // —— `useEmbedTooltip` 的入参类型就是渲染侧形状，而渲染链终切在 D 批映射表 §八
  // 被显式排除 ⇒ 本处是那条接缝的落点，不是内容读入口。
  docRef: legacyRenderDoc,
})

/**
 * 左栏点选（B-5）：
 *  - 物品行 → 经典多选（单击/Ctrl/Shift/Ctrl+Shift，语义在 `pure/itemSelection.ts`）；
 *  - 旧文件宿主行 → 单击切换（`selectedBlockId`，registryId 匹配路径**逐项不变**）；
 *  - 两条路径互斥：谁被点击谁生效，另一条被清空（避免残留高亮）。
 */
function onSidebarSelectBlock(blockId: string): void {
  itemSelection.value = EMPTY_ITEM_SELECTION
  selectedBlockId.value = selectedBlockId.value === blockId ? null : blockId
}

function onSidebarSelectItem(payload: {
  key: string; order: readonly string[]; ctrl: boolean; shift: boolean
}): void {
  selectedBlockId.value = null
  itemSelection.value = applyItemRowClick(itemSelection.value, payload.key, payload.order, {
    ctrl: payload.ctrl,
    shift: payload.shift,
  })
}

/** Esc / 点左栏空白 = 清空（#38）；两条路径一并清掉 */
function onSidebarClearSelection(): void {
  selectedBlockId.value = null
  itemSelection.value = clearItemSelection()
}

watch([selectedBlockId, itemSelection, vpSlot.definition], rebuildOutline)

/**
 * 选择状态提示（#38「不得静默失效」的呈现面）：
 *  - 无对应项 / 归属不在当前帧：说明"选了也不会亮"以及为什么；
 *  - 命中截断：命中总数超过描边通道上限 ⇒ 说明只亮了多少；
 *  - `drw.outlineMaskStats.dropped > 0`：**通道级**收口（旧路径大命中集也走这条）。
 */
const selectionNotice = computed<string | null>(() => {
  const parts: string[] = []
  const p = itemOutlinePlan.value
  if (p.selectedCount > 0) {
    if (p.unresolvedCount > 0) parts.push(`${p.unresolvedCount} 项没有对应方块（已选中，不高亮）`)
    if (p.offFrameCount > 0) parts.push(`${p.offFrameCount} 项的对应方块不在当前帧`)
    if (p.truncated) parts.push(`命中 ${p.totalHits} 处，仅高亮前 ${p.shownHits} 处`)
  }
  const st = drw.outlineMaskStats.value
  if (st.dropped > 0) {
    parts.push(`高亮命中 ${st.total} 处超出上限 ${OUTLINE_MASK_LIMIT}，仅显示前 ${st.shown} 处`)
  }
  return parts.length > 0 ? parts.join('；') : null
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
/** 与标题栏同显；仅当 data-wsr-feature-edit-workbench=false 时隐藏 */
const showEditInWorkbench = computed(() => {
  if (f.value?.editInWorkbench === false) return false
  return (f.value?.titleBar ?? false) || f.value?.editInWorkbench === true
})
const workbenchEdit = computed(() => ctx.main.embedWorkbenchEdit.value)
const editWorkbenchTitle = computed(() =>
  workbenchEdit.value.enabled ? '在结构工作台中打开' : workbenchEdit.value.reason,
)

/**
 * 下方栏 tab：可用性由「形态 + 既有特性开关」共同决定（两端共用 `dockTabs` 纯逻辑，行为一致）。
 * 通道 tab 由**文档形态**驱动（多方块为主文档），不受 `features` 开关影响。
 */
const dockTabAvailability = computed(() => ({
  showFrameTab: showFrameCtl.value,
  hasWorldMultiFrame: hasWorldMultiFrame.value,
  showLayerTab: showLayerBar.value,
  showChannelsTab: isMultiblock.value,
}))
const dockTabs = computed(() => availableDockTabs(dockTabAvailability.value))
const hasBottomDock = computed(() => dockTabs.value.length > 0)

const _preferredTab = ref<ViewportDockTab>(defaultDockTab(dockTabAvailability.value))
const activeTab = computed<ViewportDockTab>({
  get: () => resolveDockTab(_preferredTab.value, dockTabs.value),
  set: (v: ViewportDockTab) => { _preferredTab.value = v },
})

// ---- 多方块接线：取值变化 → 装配产物 → DRW 按**内容身份**自行重建 ----
//
// 旧形态：`bindMultiblockMeshSync(revision, drw)` 在每视口的 `revision` 计数器变化时
// **手动链式**调 `loadStructureAndResources()` + `rebuildContentMesh()`（B5 #5
// `manual-refresh-chain`）。那是"调用方手动刷新"，漏挂一处就得到"滑杆动了画面不动"。
//
// 现在：取值归内核 ⇒ `renderDoc`（下面的 `docOverride`）随之变化 ⇒ DRW 的
// `contentRefreshTick` 观察者按 `presentation/contentIdentity` **从数据算出**身份，
// 再按 `RebuildPlan` 分范围执行（见 `drwMeshPipeline` 文件头）。失效由数据决定，
// 不需要任何调用方声明 —— 故 `revision` 与 `bindMultiblockMeshSync` 一并消失。
/** 渲染定义随装配刷新：让 `vpSlot.definition` 始终等于"当前渲染的网格"（公开观测点） */
watch(structureDefinition, (d) => { vpSlot.definition.value = d ?? null }, { flush: 'post' })

function onChannelValue(payload: { key: string; value: number }): void {
  setChannelValue(payload.key, payload.value)
}

function onMetaHintPointerEnter(e: PointerEvent): void { hoverState.setMeta({ clientX: e.clientX, clientY: e.clientY }) }
function onMetaHintPointerMove(e: PointerEvent): void { hoverState.setMeta({ clientX: e.clientX, clientY: e.clientY }) }
function onMetaHintPointerLeave(): void { hoverState.setMeta(null) }
function onMetaHintFocusIn(e: FocusEvent): void { const t = e.currentTarget as HTMLElement; const r = t.getBoundingClientRect(); hoverState.setMeta({ clientX: r.left + r.width / 2, clientY: r.bottom }) }
function onMetaHintFocusOut(): void { hoverState.setMeta(null) }

const previewTitle = computed(() => {
  // #301 P10f D2：标题从**内核投影**取（未装配自动回落旧文档）。
  const plain = ctx.plainForSave().plain
  if (!plain) return ''
  const fromDoc = sceneDisplayTitleFromRootDocument(plain as never)
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
      // B-1：格 + 部件定位 → 该部件 mask（Wiki 预览的悬停描边走这里；独立 Embed 无部件悬停态）
      getPartMaskGeometry: (ref) => getPartMaskGeometry(ctx, ref),
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
  <!--
    实例作用域属性（#259 A33）：`data-lk-theme`/`data-lk-lang` 落在**实例根元素**上，
    自定义属性沿 DOM 继承 ⇒ 同页多实例各持主题/语言。旧路径把主题写到
    `document.documentElement`（全页一份），那是"模块级/全局写入改变所有实例"。
  -->
  <div ref="wmRoot" class="wm-root" :class="layoutClass" v-bind="ctx.getShellSettings().scopeAttrs">
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
        <button
          v-if="showEditInWorkbench"
          type="button"
          class="nei-icon-btn wsr-mobile-hide"
          :title="editWorkbenchTitle"
          :disabled="!workbenchEdit.enabled"
          @click="void ctx.getOperators().exec('OPERATOR_EMBED_OPEN_WIKI_WORKBENCH')"
        >
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
        :selected-item-keys="selectedItemKeys"
        :selection-anchor="selectionAnchor"
        :item-index="itemHitIndex"
        :selection-notice="selectionNotice"
        :tooltip-map="neiTooltipMap"
        :part-icon-textures="partIconTextures"
        @tooltip-hover="onSidebarTooltipHover"
        @toggle-collapse="sidebarCollapsed = !sidebarCollapsed"
        @select-block="onSidebarSelectBlock"
        @select-item="onSidebarSelectItem"
        @clear-selection="onSidebarClearSelection"
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
      :is-playing="isPlaying"
      :mesh-busy="meshBusy"
      :grid-height="gridHeight"
      :layer-world-y="layerWorldY"
      :layer-preview-label="layerPreviewLabel"
      :channel-panel="channelPanel"
      @set-frame="setFrameIndex"
      @toggle-playback="togglePlayback"
      @set-tier="setChannelTier"
      @set-channel-value="onChannelValue"
      @set-runstate="setChannelRunstate"
      @update:layer-y="(v: number) => { void ctx.getOperators().exec('OPERATOR_SET_LAYER_Y', { y: v }) }"
    />

    <!-- 调试状态栏 -->
    <div v-if="showDebugStatus" :class="statusBarClass" role="status" aria-live="polite">
      <span class="wm-status-dot" aria-hidden="true" />
      <span class="wm-status-text">{{ statusSummary }}</span>
    </div>

    <!-- Tooltip Teleport 到 body ⇒ 脱离实例根的继承链，须显式传本实例主题（#259 A33） -->
    <ToolTipBox
      v-if="hover && tooltipText"
      :text="tooltipText"
      :client-x="hover.clientX"
      :client-y="hover.clientY"
      :offset="prefs.tooltipOffset"
      :theme="ctx.getShellSettings().theme.value"
    />

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
