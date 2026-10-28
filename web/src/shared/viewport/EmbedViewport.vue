<script setup lang="ts">
/**
 * `EmbedViewport` —— 嵌入（查看器）视口的**薄包装**。
 *
 * ## 本文件现在只负责"嵌入这一侧的呈现与策略"
 *
 * 视口粘合（通道取值、视口运行时、载入时机、相机纪律、dock tab、卸载顺序）已收敛到
 * `shared/viewport/EditorViewportHost.vue`（唯一实现）。这里提供的是**嵌入特有**的
 * 呈现与策略：
 *
 * | 面 | 说明 |
 * |---|---|
 * | 标题栏 / 全屏 / 设置面板 / 调试状态栏 | 嵌入的页面壳（工作台没有这些 DOM） |
 * | 统计侧栏 + 物品行选中 → 描边 mask | 查看器的左栏（工作台用属性面板） |
 * | 悬浮 `ToolTipBox` | 编辑器视口无悬浮框，渲染器视口有 |
 * | 输入 | hover + **触摸** + keymap（工作台注入 gizmo/keymap） |
 * | dock | 由 `features` 开关决定、空时不渲染 |
 *
 * ## 它**没有** `if (宿主身份判断)`
 *
 * 差异全在策略值（`EditorViewportPolicy`）与装配（`ShellRuntime`）里；本组件内部不问
 * "我是不是嵌入"，也不问宿主名（SPEC §4.1 / §10.10）。
 *
 * ## 相机纪律：那一份 `didInitCamera` 已删除
 *
 * 旧实现自己在 `loadStatus==='ok'` 时执行一次 `OPERATOR_INIT_VIEWPORT_CAMERA`，与
 * `runtime/attachViewport#claimInitialViewportCamera` 的按 region 台账**重复**：
 * 一次挂载可能框选两次，且与"换文档才重新框选"的语义相反（台账是唯一纪律）。
 */
import { computed, ref, shallowRef, watch } from 'vue'
import * as THREE from 'three'
import { useContext } from '@/runtime/context'
import { resolveEmbedViewportRegionId, resolveEmbedViewerPreferences } from '@/runtime/embedViewportRegion'
import { blockRefFromViewportHover, embedHoverFromState } from '@/runtime/hover'
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
import { createHoverHandler } from '@/handlers/hoverHandler'
import { createKeymapHandler } from '@/handlers/keymapHandler'
import { createEmbedTouchHandler } from '@/embed/embedTouchHandler'
import { sceneDisplayTitleFromRootDocument } from '@/viewer/sceneDisplayTitle'
import { useEmbedTooltip } from '@/shared/viewport/useEmbedTooltip'
import { useEmbedLayoutProfile } from '@/embed/useEmbedLayoutProfile'
import EmbedSettingsPanel from '@/embed/components/EmbedSettingsPanel.vue'
import BlockStatsSidebar from '@/embed/components/BlockStatsSidebar.vue'
import ToolTipBox from '@/shared/viewport/ToolTipBox.vue'
import EditorViewportHost from '@/shared/viewport/EditorViewportHost.vue'
import EditorViewportDock from '@/shared/viewport/EditorViewportDock.vue'
import type { EditorViewportHostApi, EditorViewportPolicy } from '@/shared/viewport/editorViewportHost'
import type { EmbedSettings } from '@/viewer/viewerConfig'
import type { StructureDefinition } from '@/render/schema/types'

const props = defineProps<{
  settings?: EmbedSettings
}>()

const ctx = useContext()

/** 本实例的视口 region（独立嵌入 `r-embed` / Wiki 预览 `r-wiki-preview`）。 */
const viewportRegionId = resolveEmbedViewportRegionId(ctx)
const viewportRegion = ctx.requireRegion(viewportRegionId)
const hoverState = viewportRegion.state.hover!
const prefs = resolveEmbedViewerPreferences(ctx)

const showSettingsPanel = ref(false)
// ---- Hover / tooltip（region.state.hover + 统一 HOVER handler）----
const hover = embedHoverFromState(hoverState)
const wmRoot = ref<HTMLDivElement | null>(null)
const sidebarCollapsed = ref(false)
const { layoutClass, profile } = useEmbedLayoutProfile(wmRoot)

watch(profile, (p) => {
  if (p === 'narrow' || p === 'tiny') sidebarCollapsed.value = true
}, { immediate: true })

const initCameraProps = { _regionId: viewportRegionId }

/**
 * 旧文件（宿主清单）选中：单值，单击切换。
 * B-5 的**物品行**选择不走这里——见下方 `itemSelection`（集合 + 锚点）。
 */
const selectedBlockId = ref<string | null>(null)

/** B-5：左栏物品行选择（集合语义 + 锚点；语义实现 = `pure/itemSelection.ts`） */
const itemSelection = shallowRef<ItemSelectionState>(EMPTY_ITEM_SELECTION)
const selectedItemKeys = computed<ReadonlySet<string>>(() => itemSelection.value.selected)
const selectionAnchor = computed<string | null>(() => itemSelection.value.anchor)

/** 勿用 ref：深度响应式会代理 Mesh，破坏 Three.js 矩阵访问 */
const sidebarExtraMasks = shallowRef<THREE.Mesh[]>([])
const emptySelection = ref(new Set<import('@/context/selection').SelectedEntity>())

const hostRef = ref<InstanceType<typeof EditorViewportHost> | null>(null)
/**
 * 宿主的读面 + **它持有的 ref**（tooltip / 描边需要 `Ref` 形态的输入）。
 *
 * `vpApi` 用 computed 转发：api 的 getter 在模板/计算副作用里被读 ⇒ 依赖照常收集。
 * `definitionRef` / `tooltipPaletteRef` 同法转发到宿主内部的 ref（**不复制状态**：
 * 只有宿主一份定义与调色板，这里只是读路径）。
 */
const vpApi = computed<EditorViewportHostApi | null>(() => hostRef.value?.api ?? null)
const definitionRef = computed<StructureDefinition | null>(() => vpApi.value?.structureDefinition ?? null)
const tooltipPaletteRef = computed<readonly string[]>(() => vpApi.value?.tooltipPalette ?? [])

const hoveredBlockForOutline = computed(() =>
  blockRefFromViewportHover(ctx, hoverState.viewportBlock.value),
)

const { rebuildSelectionMasks } = createEmbedSidebarOutlineMasks({
  definitionRef,
  masksRef: sidebarExtraMasks,
})

/** B-2 落盘 `itemIndex` 的反查索引（消费点；旧文件缺省 ⇒ 空表 ⇒ 全部行"没有对应方块"） */
const itemHitIndex = computed<ItemHitIndex>(() => buildItemHitIndex(definitionRef.value))

/**
 * B-5：选中物品键集合 → mask。与 `rebuildSelectionMasks` 写入**同一个** `sidebarExtraMasks`
 * 通道（`drw.bindSelectionOutline` 的 `extraMaskMeshes`），因此呈现与 hover 完全一致。
 */
const { rebuildItemSelectionMasks, plan: itemOutlinePlan } = createEmbedItemOutlineMasks({
  definitionRef,
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

const metaRef = computed(() => {
  const m = ctx.documentMetadata()
  return { author: m.author, gtnhVersion: m.gtnhVersion }
})
const annotationsRef = computed(() => ctx.kernelAnnotations())

// ---- Tooltip text (extracted composable) ----
const { tooltipText, neiTooltipMap, showMetaHint } = useEmbedTooltip({
  hoverRef: hover,
  definitionRef,
  tooltipPaletteRef,
  showHoverTooltipRef: computed(() => prefs.showHoverTooltip),
  // 改为**内核读面**（元数据 + 注解行）⇒ 不再消费 `Context#legacyRenderSource()`。
  metaRef,
  annotationsRef,
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

/** Esc / 点左栏空白 = 清空；两条路径一并清掉 */
function onSidebarClearSelection(): void {
  selectedBlockId.value = null
  itemSelection.value = clearItemSelection()
}

watch([selectedBlockId, itemSelection, definitionRef], rebuildOutline)

/**
 * 选择状态提示（「不得静默失效」的呈现面）：
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
  const st = hostRef.value?.api.drw.outlineMaskStats.value
  if (st && st.dropped > 0) {
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

/** 本实例的宿主策略（差异全部是这些值；组件内部没有宿主名判断）。 */
const policy: EditorViewportPolicy = {
  ...(props.settings?.blockIconCacheOptions === undefined ? {} : { blockIconCacheOptions: props.settings.blockIconCacheOptions }),
  ...(props.settings?.initialWorldFrameIndex === undefined ? {} : { initialWorldFrameIndex: props.settings.initialWorldFrameIndex }),
  ...(props.settings?.sceneBackground === undefined ? {} : { sceneBackground: props.settings.sceneBackground }),
  showAxesGizmo: showAxesGizmo.value,
  /**
   * dock：**由 `features` 开关 + 文档形态共同决定**，空时不渲染
   * （通道 tab 由文档形态驱动，不受 features 影响 —— 与旧口径逐字相同）。
   */
  dock: {
    showFrameTab: showFrameCtl.value,
    showLayerTab: showLayerBar.value,
    hideWhenEmpty: true,
    theme: 'embed',
  },
  input: ({ regionId }) => ({
    hover: createHoverHandler(regionId, () => ctx),
    gizmo: createEmbedTouchHandler(regionId, () => ctx),
    keymap: createKeymapHandler(regionId, () => ctx),
  }),
  /** 嵌入没有页面级键盘输入面（无 InputPort）⇒ 不绑 document keydown。 */
  documentKeydown: false,
  selection: ({ prefs: p, outlinePlans }) => ({
    selectionItems: emptySelection,
    hoveredBlock: hoveredBlockForOutline,
    highlightOnHover: computed(() => p.highlightOnHover),
    getBlockGeometry: (pos) => getBlockGeometry(ctx, pos),
    gridCenterWorld: (pos) => gridCenterWorld(ctx, pos),
    // B-1：格 + 部件定位 → 该部件 mask（Wiki 预览的悬停描边走这里；独立 Embed 无部件悬停态）
    getPartMaskGeometry: (ref) => getPartMaskGeometry(ctx, ref),
    outlinePlans,
    extraMaskMeshes: sidebarExtraMasks,
  }),
}

function onMetaHintPointerEnter(e: PointerEvent): void { hoverState.setMeta({ clientX: e.clientX, clientY: e.clientY }) }
function onMetaHintPointerMove(e: PointerEvent): void { hoverState.setMeta({ clientX: e.clientX, clientY: e.clientY }) }
function onMetaHintPointerLeave(): void { hoverState.setMeta(null) }
function onMetaHintFocusIn(e: FocusEvent): void { const t = e.currentTarget as HTMLElement; const r = t.getBoundingClientRect(); hoverState.setMeta({ clientX: r.left + r.width / 2, clientY: r.bottom }) }
function onMetaHintFocusOut(): void { hoverState.setMeta(null) }

const previewTitle = computed(() => {
  // 标题从**内核投影**取（未装配自动回落旧文档）。
  const plain = ctx.plainForSave().plain
  if (!plain) return ''
  const fromDoc = sceneDisplayTitleFromRootDocument(plain as never)
  if (fromDoc) return fromDoc
  const def = definitionRef.value
  const lab = def?.label?.trim()
  if (lab) return lab
  const id = def?.id?.trim()
  if (id) return id
  return '结构预览'
})

const loadStatus = computed(() => vpApi.value?.loadStatus ?? 'loading')
const statusBarClass = computed(() => {
  if (loadStatus.value === 'error') return 'wm-status-bar wm-status-bar--err'
  if (loadStatus.value === 'loading') return 'wm-status-bar wm-status-bar--loading'
  return 'wm-status-bar wm-status-bar--ok'
})

const statusSummary = computed(() => {
  if (loadStatus.value === 'loading') return '加载中…'
  if (loadStatus.value === 'error') return ''
  const parts: string[] = ['场景已加载']
  if (vpApi.value?.hasWorldMultiFrame) parts.push(`${vpApi.value.worldFrameCount} Frames`)
  return parts.join(' · ')
})

/**
 * F2 接线（`partIconTextures` = 文档根级字段）：数据来源 = 渲染定义根，
 * 经解析链根透传后与侧栏回退读取的是**同一份对象**。
 */
type PartIconTexturesCarrier = { partIconTextures?: Record<string, string> }
const partIconTextures = computed<Record<string, string> | null>(() => {
  const raw = (definitionRef.value as unknown as PartIconTexturesCarrier | null)?.partIconTextures
  return raw && typeof raw === 'object' ? raw : null
})

function onSidebarTooltipHover(
  payload: { blockId: string; clientX: number; clientY: number; source: 'sidebar' } | null,
): void {
  hoverState.setSidebarBlock(payload)
}
</script>

<template>
  <!--
    实例作用域属性：`data-lk-theme`/`data-lk-lang` 落在**实例根元素**上，
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
        <!--
          口径：**文案必须明示例外性质** —— 这个按钮读的是当前活画布/活相机
          （`renderEngine#screenshot`），按产品定义是「即兴抓屏」，**不是**正式导出
          （正式导出走固定快照：ExportRequest + 资源清单 + ExportJob）。
        -->
        <button type="button" class="nei-icon-btn wsr-mobile-hide" title="截屏（当前画面，非正式导出）" @click="vpApi?.screenshot()">
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
        v-if="showStats && vpApi && loadStatus === 'ok' && vpApi.blockIconCache"
        :entries="vpApi.blockStatsEntries" :cache="vpApi.blockIconCache"
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
      <EditorViewportHost
        ref="hostRef"
        class="wm-viewport-column"
        :region-id="viewportRegionId"
        :policy="policy"
      />
    </div>

    <EditorViewportDock v-if="vpApi" :api="vpApi" />

    <!-- 调试状态栏 -->
    <div v-if="showDebugStatus" :class="statusBarClass" role="status" aria-live="polite">
      <span class="wm-status-dot" aria-hidden="true" />
      <span class="wm-status-text">{{ statusSummary }}</span>
    </div>

    <!-- Tooltip Teleport 到 body ⇒ 脱离实例根的继承链，须显式传本实例主题 -->
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
