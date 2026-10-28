<script setup lang="ts">
/**
 * BlockStatsSidebar — 统计栏（B-3：左栏纯物品展示；无视图切换 UI + 无统计规则能力）。
 *
 * 契约：`docs/contracts/format-parts-contract.md`
 *   （§9 物品索引表；旧统计字段 = 规则能力与三级配置的移除依据）。
 * 引擎：`@/pure/partStats`（行集/排序/退化语义由引擎钉死，本组件只呈现）。
 *
 * ── 形态（决策 C，取代原"三视图 + 视图切换工具条 + 配置来源徽标/provenance 面板"）──
 *  - **有部件数据**（部件模式）：左栏只列**物品行**（引擎 `StatsRow`：行键 = 图标键 =
 *    物品身份键，名称 = 游戏内显示名），固定按数量降序；
 *    **无视图切换 UI**（无 `部件物品/宿主/自定义` 标签、无配置来源徽标、无 provenance 面板）、
 *    **无宿主方块行**、**无配置读写**（`statsTemplate` / `statsOverride` / localStorage
 *    都不再参与任何语义）；
 *  - `items: []` 的无物品部件以"N 个无物品部件未计入清单"提示行呈现（不产生物品行）；
 *  - **无部件数据**（旧文件 / 当前过滤层无部件）：**完全走旧路径** —— 行集直接取自
 *    `entries` prop（`buildBlockStatsEntries` / `countBlocksById` 旧口径），tooltipMap
 *    友好名、悬停 tooltip、点选描边逐项与今天一致；DOM 零新增（回归锁见
 *    `__tests__/blockStatsSidebar.legacyHostRows.dom.test.ts`）。
 *
 * ── 事件通道（保留；B-4/B-5 的接入点）──
 *  `tooltip-hover` / `select-block` / `select-item` 都在发：物品行以**物品身份键**为 payload，
 *  旧路径行以宿主 blockId 为 payload。物品行不再有 `kind === 'host'` 短路 —— 事件通道不因
 *  移除宿主行而堵死。口径：**物品行的 tooltip 触发区 = 物品图标**（图标悬停出
 *  TooltipBox，行文本/数量区不出）；点选（B-5）保持整行。旧路径行保持整行悬停不回归。
 *  物品行**不套用** `--selected` 视觉（不引入"编辑/选中态"这类额外行 UI）：`selectedBlockId`
 *  的来源只剩旧文件退化路径（#6 §9 第 4 条）。
 *
 * ── 数据来源 ──
 *  `definition` prop 优先；缺省时回退 `cache.getStructure()`（图标缓存随结构重建，与视口渲染
 *  定义同源）。旧文档根字段（statsTemplate / statsOverride）仍随该对象存活，但**静默忽略**：
 *  残留或不可用的旧配置既不空栏也不报错。`layerPreview` prop 缺省 'all'
 *  （EmbedViewport 接线前部件清单不按层过滤，登记为集成点）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import BlockSlotPreview from './BlockSlotPreview.vue'
import type { BlockIconCache } from '@/render/interaction/blockIconCache'
import type { BlockStatRow } from '@/render/interaction/blockStats'
import {
  buildItemStats,
  type StatsRow,
  type ItemStatsResult,
} from '@/pure/partStats'
import { buildItemStatsInput } from '@/render/interaction/partStatsAdapter'
import { isItemUnresolved, type ItemHitIndex } from '@/pure/itemIndex'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import type { StructureDefinition } from '@/render/schema/types'

const props = defineProps<{
  entries: BlockStatRow[]
  cache: BlockIconCache
  collapsed?: boolean
  selectedBlockId?: string | null
  tooltipMap?: Map<string, string[]>
  /** 渲染定义（含 cellPartsGrid/partLists 与运行时挂载的文档根字段）；缺省回退 cache.getStructure() */
  definition?: StructureDefinition | null
  /** 分层预览过滤（缺省 'all'；与 countBlocksById 的 effectiveVoxelState 语义一致） */
  layerPreview?: LayerPreviewMode
  /** 部件物品图标纹理（物品身份键 → base64 PNG；嵌入纹理体系接入点，本轮 fixture 无） */
  partIconTextures?: Record<string, string> | null
  /**
   * B-5：**选中物品键集合**（物品行选中态的唯一数据位，取代单值语义）。
   * 仅物品行读它；旧文件宿主行仍读 `selectedBlockId`（`registryId` 匹配路径逐项不变）。
   */
  selectedItemKeys?: ReadonlySet<string> | null
  /** B-5：Shift 区间锚点行键（行内细标记，纯呈现；语义在 `pure/itemSelection.ts`） */
  selectionAnchor?: string | null
  /** B-5：物品索引反查表（`buildItemHitIndex` 产物）——无对应方块的行内标记判据 */
  itemIndex?: ItemHitIndex | null
  /** B-5：选择状态提示（无对应项 / 命中截断）；缺省 ⇒ 不渲染提示行 */
  selectionNotice?: string | null
}>()

const emit = defineEmits<{
  'toggle-collapse': []
  'tooltip-hover': [
    payload: {
      blockId: string; clientX: number; clientY: number; source: 'sidebar'
    } | null,
  ]
  /** 旧文件宿主行点选（payload = 宿主键，逐项不变；单击切换由上层实现） */
  'select-block': [blockId: string]
  /**
   * B-5：物品行点选。payload 只携带**事实**（行键 + 当前可见顺序 + 修饰键），
   * 选择语义（单击/Ctrl/Shift/Ctrl+Shift）由 `pure/itemSelection.ts` 在上层判定。
   */
  'select-item': [
    payload: { key: string; order: readonly string[]; ctrl: boolean; shift: boolean },
  ]
  /** B-5：清空选择（Esc / 点左栏空白；仅物品模式发出） */
  'clear-selection': []
}>()

// ---------------------------------------------------------------------------
// 物品清单（部件模式）；无部件 ⇒ statsResult = null ⇒ 完全走旧路径
// ---------------------------------------------------------------------------

const definition = computed<StructureDefinition | null>(
  () => props.definition ?? props.cache.getStructure(),
)
const layerPreviewMode = computed<LayerPreviewMode>(() => props.layerPreview ?? 'all')

const statsInput = computed(() => {
  const d = definition.value
  return d ? buildItemStatsInput(d, layerPreviewMode.value) : null
})
/** 无部件数据（旧文件 / 当前层无部件）⇒ 退化：完全走旧路径（拍板见文件头） */
const hasParts = computed(() => (statsInput.value?.parts.length ?? 0) > 0)

/**
 * 部件清单（决策 C：纯物品行，数量降序由引擎钉死）。
 * 无部件数据（旧文件 / 当前层无部件）⇒ null ⇒ 完全走旧路径（见文件头）。
 * 旧文档根字段（statsTemplate / statsOverride）**不读取**：残留配置静默忽略，不参与任何语义。
 */
const statsResult = computed<ItemStatsResult | null>(() => {
  const input = statsInput.value
  if (!input || !hasParts.value) return null
  return buildItemStats(input)
})

const empty = computed(() =>
  statsResult.value ? statsResult.value.rows.length === 0 : props.entries.length === 0,
)
const count = computed(() =>
  statsResult.value ? statsResult.value.rows.length : props.entries.length,
)
const statsRowTotal = computed(() => statsResult.value?.rows.length ?? 0)

// ---- 部件物品图标通道接线（键控纹理源；回退链在 BlockIconCache 内）----

watch(
  () => [props.cache, props.partIconTextures] as const,
  ([cache, textures]) => {
    cache.setPartIconTextureSource(textures ? (k) => textures[k] ?? null : null)
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  props.cache.setPartIconTextureSource(null)
})

/** 物品行图标：物品身份键走 ensurePartIcons（partIconTextures 两级回退链，硬约束：通道不变） */
watch(
  [statsResult, () => props.cache],
  () => {
    const r = statsResult.value
    if (!r) return
    props.cache.ensurePartIcons(r.rows.map((row) => row.iconKey))
  },
  { immediate: true, flush: 'post' },
)

// ---------------------------------------------------------------------------
// 行呈现（物品行）
// ---------------------------------------------------------------------------

/** 行显示名 = 游戏内显示名（`StatsRow.label`，硬约束：取部件物品而非宿主方块） */
function rowLabel(row: StatsRow): string {
  return row.label
}

/** 行副标题：去 modid 前缀（首个冒号前） */
function rowSubLabel(row: StatsRow): string {
  const key = row.iconKey
  const colon = key.indexOf(':')
  return colon >= 0 ? key.slice(colon + 1) : key
}

/** 计数格式化：整数原样；非整数（导出侧给定的件数）保留至多两位 */
function formatCount(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}

// ---------------------------------------------------------------------------
// 以下为既有侧栏行为（旧路径 = 无部件文件逐行为一致）
// ---------------------------------------------------------------------------

const gridRef = ref<HTMLElement | null>(null)
const pullY = ref(0)
const glowTop = ref(false)
const glowBottom = ref(false)
const isPullDragging = ref(false)

const MAX_PULL_PX = 44
const GLOW_ON_PX = 6
const RUBBER_K = 36
/**
 * 点击/拖拽的**共享边界**：两轴位移 hypot 严格大于该值才算拖拽。
 * 下拉起点与 `onGridClick` 的“点空白”判定必须用同一个谓词，避免恰好 4px 时
 * 一处算点击、另一处算拖拽（那会让 click 与 pull 同时成立）。
 */
const DRAG_THRESHOLD_PX = 4

let resizeObs: ResizeObserver | null = null
let pullPointerId = -1
let pullStartClientY = 0
/** 最近一次 pointerdown 的位置：用于把"拖拽手势"与"点空白"区分开（见 `onGridClick`） */
let clickStartX = 0
let clickStartY = 0

/** 共享边界谓词：两轴位移 hypot 严格大于 `DRAG_THRESHOLD_PX` ⇒ 拖拽（否则点击）。 */
function isDragGesture(clientX: number, clientY: number): boolean {
  return Math.hypot(clientX - clickStartX, clientY - clickStartY) > DRAG_THRESHOLD_PX
}

function rubberOffset(deltaY: number): number {
  const sign = Math.sign(deltaY) || 1
  const abs = Math.abs(deltaY)
  return sign * MAX_PULL_PX * (1 - Math.exp(-abs / RUBBER_K))
}

function atScrollTop(el: HTMLElement): boolean {
  return el.scrollTop <= 1
}

function atScrollBottom(el: HTMLElement): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 2
}

function updateGlowFromPull(offset: number): void {
  glowTop.value = offset > GLOW_ON_PX
  glowBottom.value = offset < -GLOW_ON_PX
}

function resetPull(animate = true): void {
  detachWindowRelease()
  isPullDragging.value = false
  pullPointerId = -1
  pullY.value = 0
  glowTop.value = false
  glowBottom.value = false
  const inner = gridRef.value?.firstElementChild as HTMLElement | null
  if (inner) {
    inner.classList.toggle('nei-sidebar-grid-inner--snap', animate)
  }
}

/**
 * 窗口捕获阶段的释放收口：只处理“阈值前/未 capture 时在 grid 外释放”的 stale。
 *
 * - `pointerup` 落在 grid/行内 ⇒ 交给既有 `endPull`/`click` 路径，本监听不改事件顺序；
 * - `pointerup` 落在 grid 外且此前未 capture ⇒ `resetPull(false)` 并移除监听；
 * - `pointercancel` 一律收口（grid 没有单独 cancel 处理）。
 */
function onWindowPointerRelease(e: PointerEvent): void {
  if (e.pointerId !== pullPointerId) return
  const grid = gridRef.value
  if (!grid) {
    detachWindowRelease()
    return
  }
  const target = e.target as Node | null
  const insideGrid = target !== null && grid.contains(target)
  if (e.type === 'pointercancel' || !insideGrid) resetPull(false)
}

function attachWindowRelease(): void {
  window.addEventListener('pointerup', onWindowPointerRelease, true)
  window.addEventListener('pointercancel', onWindowPointerRelease, true)
}

function detachWindowRelease(): void {
  window.removeEventListener('pointerup', onWindowPointerRelease, true)
  window.removeEventListener('pointercancel', onWindowPointerRelease, true)
}

function onGridPointerDown(e: PointerEvent): void {
  const el = gridRef.value
  if (!el || e.button !== 0) return
  pullPointerId = e.pointerId
  pullStartClientY = e.clientY
  clickStartX = e.clientX
  clickStartY = e.clientY
  isPullDragging.value = false
  const inner = el.firstElementChild as HTMLElement | null
  inner?.classList.remove('nei-sidebar-grid-inner--snap')
  // 按下一激活即挂窗口释放收口；endPull/resetPull/unmount 负责移除，保证无泄漏。
  attachWindowRelease()
}

function onGridPointerMove(e: PointerEvent): void {
  // 兜底：窗口监听未覆盖到的 buttons=0 hover 也清理 stale；但无活动状态时
  // **不得** reset（否则普通 hover 会取消 snap 动画）。
  if (e.buttons === 0) {
    if (pullPointerId !== -1 || isPullDragging.value) resetPull(false)
    return
  }
  if (e.pointerId !== pullPointerId) return
  const el = gridRef.value
  if (!el) return

  // 指针捕获只在越过**点击/拖拽共享边界**后建立：若在 pointerdown 就捕获，
  // 浏览器会把随后的 pointerup/click 重定向到网格，行自己的 @click 不再触发
  // （真实鼠标点选静默失效）。方向/距离与 `onGridClick` 共用 `isDragGesture`。
  if (!isPullDragging.value && !isDragGesture(e.clientX, e.clientY)) return
  if (!isPullDragging.value) {
    try {
      el.setPointerCapture(e.pointerId)
    } catch { /* ignore */ }
  }
  const totalDy = e.clientY - pullStartClientY
  const overflow = el.scrollHeight - el.clientHeight > 4

  if (!overflow) {
    if (totalDy > 0) {
      isPullDragging.value = true
      pullY.value = rubberOffset(totalDy)
      updateGlowFromPull(pullY.value)
      e.preventDefault()
    } else if (totalDy < 0) {
      isPullDragging.value = true
      pullY.value = rubberOffset(totalDy)
      updateGlowFromPull(pullY.value)
      e.preventDefault()
    }
    return
  }

  const top = atScrollTop(el)
  const bottom = atScrollBottom(el)

  if (top && totalDy > 0) {
    isPullDragging.value = true
    pullY.value = rubberOffset(totalDy)
    updateGlowFromPull(pullY.value)
    if (el.scrollTop !== 0) el.scrollTop = 0
    e.preventDefault()
    return
  }

  if (bottom && totalDy < 0) {
    isPullDragging.value = true
    pullY.value = rubberOffset(totalDy)
    updateGlowFromPull(pullY.value)
    e.preventDefault()
    return
  }

  if (isPullDragging.value) {
    resetPull(true)
  }
}

function endPull(e: PointerEvent): void {
  if (e.pointerId !== pullPointerId) return
  const el = gridRef.value
  try {
    el?.releasePointerCapture(e.pointerId)
  } catch { /* ignore */ }
  resetPull(true)
}

watch(
  () => [props.entries.length, statsRowTotal.value, props.collapsed] as const,
  () => {
    void nextTick(resetPull)
  },
)

onMounted(() => {
  const el = gridRef.value
  if (el) {
    resizeObs = new ResizeObserver(() => resetPull(false))
    resizeObs.observe(el)
  }
  document.addEventListener('keydown', onDocumentKeydown)
})

onBeforeUnmount(() => {
  detachWindowRelease()
  resizeObs?.disconnect()
  document.removeEventListener('keydown', onDocumentKeydown)
})

function onRowPointerEnter(e: PointerEvent, blockId: string): void {
  emit('tooltip-hover', { blockId, clientX: e.clientX, clientY: e.clientY, source: 'sidebar' })
}
function onRowPointerMove(e: PointerEvent, blockId: string): void {
  emit('tooltip-hover', { blockId, clientX: e.clientX, clientY: e.clientY, source: 'sidebar' })
}
function onRowPointerLeave(): void {
  emit('tooltip-hover', null)
}
function onRowClick(blockId: string): void {
  emit('select-block', blockId)
}

// ---------------------------------------------------------------------------
// B-5：物品行点选（经典多选）
// ---------------------------------------------------------------------------

/** 当前左栏**可见顺序**（物品行键数组；区间选择在它上面生效，#7 §5 硬约束） */
function visibleItemOrder(): string[] {
  return statsResult.value?.rows.map((r) => r.key) ?? []
}

/** 物品行点击：只上报事实（修饰键 + 可见顺序），语义由上层 `pure/itemSelection.ts` 判定 */
function onItemRowClick(e: MouseEvent, key: string): void {
  emit('select-item', {
    key,
    order: visibleItemOrder(),
    ctrl: e.ctrlKey || e.metaKey,
    shift: e.shiftKey,
  })
}

/** 行是否选中（集合语义；旧路径的 `selectedBlockId` 单值语义不参与） */
function isItemRowSelected(key: string): boolean {
  return props.selectedItemKeys?.has(key) === true
}

/** 该物品**没有对应方块**（索引无条目 / 显式无对应）⇒ 行内标记 + "可选中、不高亮"提示 */
function isUnresolvedItem(key: string): boolean {
  return isItemUnresolved(props.itemIndex, key)
}

/**
 * 点左栏空白 = 清空选择。判定方式：命中链上不存在 `.nei-slot-row`
 * （行、行内图标与文本都算"点行"，其余算空白）。
 *
 * 拖拽手势不算"点空白"：滚动/下拉回弹结束时浏览器同样会派发 click，
 * 故与最近一次 pointerdown 的位置比较（共享 `isDragGesture` 谓词 ⇒ 视为拖拽，不清空）。
 * 仅在物品模式（`statsResult`）生效——旧文件宿主清单路径逐项不变（不引入新交互）。
 */
function onGridClick(e: MouseEvent): void {
  if (!statsResult.value) return
  if (isDragGesture(e.clientX, e.clientY)) return
  const t = e.target as HTMLElement | null
  if (t?.closest('.nei-slot-row')) return
  emit('clear-selection')
}

/** Esc = 清空选择（同一路径；同样只在物品模式生效） */
function onDocumentKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  if (!statsResult.value) return
  emit('clear-selection')
}

function formatBlockId(id: string): string {
  if (!id) return '???'
  if (id === 'minecraft:air') return 'air'
  let s = id
  const colon = s.lastIndexOf(':')
  if (colon >= 0) s = s.slice(colon + 1)
  return s.replace('@', ':')
}

function displayNameById(id: string): string {
  if (!id) return '???'
  if (id === 'minecraft:air') return id
  const lines = props.tooltipMap?.get(id)
  if (lines && lines.length > 0 && lines[0]) {
    const clean = lines[0].replace(/§./g, '').trim()
    if (clean) return clean
  }
  const colon = id.lastIndexOf(':')
  return colon >= 0 ? id.slice(colon + 1) : id
}

function displayName(row: BlockStatRow): string {
  return displayNameById(row.blockId)
}

const innerStyle = computed(() => ({
  transform: pullY.value ? `translateY(${pullY.value}px)` : undefined,
}))

/** 拉过头辉光：更快达到高亮 */
function edgeGlowOpacity(active: boolean): number {
  if (!active) return 0
  const t = Math.min(1, Math.abs(pullY.value) / (MAX_PULL_PX * 0.55))
  return 0.45 + t * 0.55
}
</script>

<template>
  <aside
    class="nei-sidebar"
    :class="{ 'nei-sidebar--collapsed': collapsed }"
    aria-label="方块统计"
  >
    <div class="nei-sidebar-head">
      <template v-if="!collapsed">
        <span class="nei-sidebar-label">方块类型</span>
        <span class="nei-sidebar-count">{{ count }}</span>
      </template>
      <button class="nei-sidebar-toggle" @click="emit('toggle-collapse')" :title="collapsed ? '展开侧栏' : '收起侧栏'">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nei-chevron">
          <polyline v-if="collapsed" points="9 18 15 12 9 6" />
          <polyline v-else points="15 18 9 12 15 6" />
        </svg>
      </button>
    </div>

    <!-- B-3：无视图切换工具条、无配置来源徽标 / provenance 面板（决策 C 已整套移除） -->

    <div v-if="empty" class="nei-sidebar-empty">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h18"/></svg>
      <span>无方块数据</span>
    </div>

    <div v-else class="nei-sidebar-scroll-shell">
      <div
        class="nei-sidebar-edge-glow nei-sidebar-edge-glow--top"
        :class="{ 'nei-sidebar-edge-glow--on': glowTop }"
        :style="{ opacity: edgeGlowOpacity(glowTop) }"
        aria-hidden="true"
      />
      <div
        ref="gridRef"
        class="nei-sidebar-grid"
        :class="{ 'nei-sidebar-grid--collapsed': collapsed }"
        @pointerdown="onGridPointerDown"
        @pointermove="onGridPointerMove"
        @pointerup="endPull"
        @pointercancel="endPull"
        @click="onGridClick"
      >
        <div
          class="nei-sidebar-grid-inner nei-sidebar-grid-inner--snap"
          :class="{ 'nei-sidebar-grid-inner--collapsed': collapsed }"
          :style="innerStyle"
        >
          <!--
            部件模式：只列物品行（引擎 StatsRow 原样呈现；行键 = 图标键 = 物品身份键，
            名称 = 游戏内显示名）。**悬停 tooltip 触发区 = 物品图标**（口径：
            悬停图标出 TooltipBox，行其他区域不出）；点选（B-5）保持整行 = 经典多选，
            选中态为**集合语义**（`selectedItemKeys`）。
          -->
          <template v-if="statsResult">
            <div
              v-if="statsResult.itemlessPartCount > 0"
              class="nei-stats-itemless"
              data-stats-itemless
            >{{ statsResult.itemlessPartCount }} 个无物品部件未计入清单</div>
            <!-- B-5：选择状态提示（无对应项 / 命中截断）——不得静默失效 -->
            <div
              v-if="selectionNotice"
              class="nei-stats-notice"
              data-stats-selection-notice
              role="status"
            >{{ selectionNotice }}</div>
            <div
              v-for="row in statsResult.rows"
              :key="row.key"
              class="nei-slot-row"
              :class="{
                'nei-slot-row--collapsed': collapsed,
                'nei-slot-row--selected': isItemRowSelected(row.key),
                'nei-slot-row--unresolved': isUnresolvedItem(row.key),
                'nei-slot-row--anchor': selectionAnchor === row.key,
              }"
              :data-stats-row-key="row.key"
              :data-stats-icon-key="row.iconKey"
              :data-stats-selected="isItemRowSelected(row.key) ? 'true' : 'false'"
              :data-stats-unresolved="isUnresolvedItem(row.key) ? 'true' : 'false'"
              :data-stats-anchor="selectionAnchor === row.key ? 'true' : 'false'"
              @click="onItemRowClick($event, row.key)"
              :title="collapsed ? rowLabel(row) : undefined"
            >
              <!-- 口径：tooltip-hover 触发区收窄到图标（行文本区悬停不出 TooltipBox） -->
              <span
                class="nei-slot-icon"
                :data-stats-icon-hover="row.key"
                @pointerenter="onRowPointerEnter($event, row.key)"
                @pointermove="onRowPointerMove($event, row.key)"
                @pointerleave="onRowPointerLeave"
              >
                <BlockSlotPreview
                  :cache="cache"
                  :block-id="row.iconKey"
                  :count="row.count"
                />
              </span>
              <template v-if="!collapsed">
                <div class="nei-slot-info">
                  <div class="nei-slot-name">
                    {{ rowLabel(row) }}<span
                      v-if="isUnresolvedItem(row.key)"
                      class="nei-slot-unresolved-dot"
                      data-stats-unresolved-dot
                      title="没有对应方块"
                      aria-label="没有对应方块"
                    />
                  </div>
                  <div class="nei-slot-id">{{ rowSubLabel(row) }}</div>
                </div>
                <span class="nei-slot-qty">{{ formatCount(row.count) }}</span>
              </template>
            </div>
          </template>

          <!-- 旧路径（无部件文件 = 今天行为，逐 DOM 一致） -->
          <template v-else>
            <div
              v-for="row in entries"
              :key="row.blockId"
              class="nei-slot-row"
              :class="{
                'nei-slot-row--collapsed': collapsed,
                'nei-slot-row--selected': row.blockId === selectedBlockId,
              }"
              @pointerenter="onRowPointerEnter($event, row.blockId)"
              @pointermove="onRowPointerMove($event, row.blockId)"
              @pointerleave="onRowPointerLeave"
              @click="onRowClick(row.blockId)"
              :title="collapsed ? displayName(row) : undefined"
            >
              <BlockSlotPreview
                :cache="cache"
                :block-id="row.blockId"
                :count="row.count"
              />
              <template v-if="!collapsed">
                <div class="nei-slot-info">
                  <div class="nei-slot-name">{{ displayName(row) }}</div>
                  <div class="nei-slot-id">{{ formatBlockId(row.blockId) }}</div>
                </div>
                <span class="nei-slot-qty">{{ row.count }}</span>
              </template>
            </div>
          </template>
        </div>
      </div>
      <div
        class="nei-sidebar-edge-glow nei-sidebar-edge-glow--bottom"
        :class="{ 'nei-sidebar-edge-glow--on': glowBottom }"
        :style="{ opacity: edgeGlowOpacity(glowBottom) }"
        aria-hidden="true"
      />
    </div>

    <div v-if="collapsed && !empty" class="nei-sidebar-foot">
      <span class="nei-sidebar-count">{{ count }}</span>
    </div>
  </aside>
</template>

<style scoped>
.nei-sidebar {
  width: 220px;
  flex-shrink: 0;
  align-self: stretch;
  min-height: 0;
  background: var(--nei-bg-surface);
  border-right: 3px solid var(--nei-border-panel);
  display: flex;
  flex-direction: column;
  transition: width 0.15s ease-out;
  overflow: hidden;
}
.nei-sidebar--collapsed {
  width: 48px;
}

.nei-sidebar-head {
  padding: 8px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--nei-bg-panel);
  border-bottom: 3px solid;
  border-color: var(--nei-bevel-dark) var(--nei-border-subtle) var(--nei-border-subtle) var(--nei-bevel-dark);
  flex-shrink: 0;
}
.nei-sidebar--collapsed .nei-sidebar-head {
  justify-content: center;
  padding: 8px 0 6px;
}
.nei-sidebar-label {
  color: var(--nei-text);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  text-shadow: var(--nei-text-shadow-deep);
}
.nei-sidebar-count {
  margin-left: auto;
  font-size: 10px;
  color: var(--nei-text-mono);
  font-family: var(--nei-font-mono);
  background: var(--nei-bg-panel);
  padding: 2px 8px;
  border: 1px solid var(--nei-border-panel);
}
.nei-sidebar--collapsed .nei-sidebar-count {
  margin-left: 0;
}
.nei-sidebar-toggle {
  width: 22px;
  height: 22px;
  border: none;
  background: none;
  color: var(--nei-text-dim);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  flex-shrink: 0;
}
.nei-sidebar-toggle:hover { color: var(--nei-text); }
.nei-chevron { width: 16px; height: 16px; }

/* ---- 物品清单：无物品部件提示行（B-3 保留；工具条/视图按钮/来源徽标样式随决策 C 移除）---- */
.nei-stats-itemless {
  margin: 2px 4px;
  padding: 3px 6px;
  font-size: 10px;
  color: var(--nei-text-id);
  background: var(--nei-bg-panel);
  border: 1px dashed var(--nei-border-panel);
}

/*
 * B-5 选择状态提示（无对应项 / 命中截断）：与行同宽的一条窄带，颜色取警告色
 * ——"有话说但不阻断操作"（不得静默失效的呈现面）。
 */
.nei-stats-notice {
  margin: 2px 4px;
  padding: 3px 6px;
  font-size: 10px;
  line-height: 1.4;
  color: var(--nei-warn-text);
  background: var(--nei-bg-panel);
  border: 1px dashed var(--nei-border-panel);
}

.nei-sidebar-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 24px 14px;
  font-size: 11px;
  color: var(--nei-text-dim);
}

.nei-sidebar-scroll-shell {
  --nei-edge-glow-core: color-mix(in srgb, var(--nei-accent) 55%, transparent);
  --nei-edge-glow-mid: color-mix(in srgb, var(--nei-accent) 35%, var(--nei-accent-glow));
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 拉到头继续拖时：边缘辉光（强度随过度拉伸变化） */
.nei-sidebar-edge-glow {
  position: absolute;
  left: 0;
  right: 0;
  height: 42px;
  pointer-events: none;
  z-index: 3;
  opacity: 0;
  transition: opacity 0.12s ease-out;
  filter: brightness(1.15) saturate(1.2);
}
.nei-sidebar-edge-glow--on {
  transition: opacity 0.08s ease-out;
}
.nei-sidebar-edge-glow--top {
  top: 0;
  background: linear-gradient(
    to bottom,
    var(--nei-edge-glow-core) 0%,
    var(--nei-edge-glow-mid) 40%,
    transparent 100%
  );
  box-shadow:
    inset 0 12px 36px var(--nei-edge-glow-mid),
    inset 0 2px 12px var(--nei-edge-glow-core),
    0 0 24px 6px var(--nei-accent-glow),
    0 0 40px 2px var(--nei-edge-glow-mid);
}
.nei-sidebar-edge-glow--bottom {
  bottom: 0;
  background: linear-gradient(
    to top,
    var(--nei-edge-glow-core) 0%,
    var(--nei-edge-glow-mid) 40%,
    transparent 100%
  );
  box-shadow:
    inset 0 -12px 36px var(--nei-edge-glow-mid),
    inset 0 -2px 12px var(--nei-edge-glow-core),
    0 0 24px 6px var(--nei-accent-glow),
    0 0 40px 2px var(--nei-edge-glow-mid);
}

.nei-sidebar-grid {
  box-sizing: border-box;
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: none;
  -webkit-overflow-scrolling: touch;
  touch-action: pan-y;
  padding: 0;
  scrollbar-width: none;
}
.nei-sidebar-grid::-webkit-scrollbar {
  display: none;
}

.nei-sidebar-grid-inner {
  padding: 4px;
  will-change: transform;
}
.nei-sidebar-grid-inner--snap {
  transition: transform 0.38s cubic-bezier(0.33, 1.1, 0.54, 1);
}
.nei-sidebar-grid-inner--collapsed {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 2px 1px;
}

.nei-slot-row {
  display: flex;
  align-items: center;
  padding: 2px 4px;
  cursor: pointer;
  transition: background 0.1s;
}
/* 口径：物品行的 tooltip 触发区 = 图标包裹元素（行其余区域不发 tooltip-hover） */
.nei-slot-icon {
  display: inline-flex;
  flex: none;
}
.nei-slot-row:hover {
  background: var(--nei-bg-hover);
}
.nei-slot-row:active {
  background: var(--nei-bg-hover);
}
.nei-slot-row--selected {
  background: var(--nei-accent-glow);
}
/*
 * B-5 选中态（集合语义）与"无对应方块"标记共存：
 *  - `--unresolved`：行内色点（见 `.nei-slot-unresolved-dot`）+ 左侧警示细条
 *    ——该行可选中，但**永远不会亮**；混选时逐项可辨认（硬约束）。
 *  - `--selected.--unresolved`：换成"选中但不会亮"的虚线边框，与"已选中且会亮"区分。
 *  - `--anchor`：Shift 区间锚点，左侧 2px 强调条（不改行内布局）。
 */
.nei-slot-row--unresolved {
  position: relative;
}
.nei-slot-row--unresolved::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--nei-warn-text);
  opacity: 0.75;
}
.nei-slot-row--anchor {
  position: relative;
}
.nei-slot-row--anchor::after {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--nei-accent);
}
.nei-slot-row--selected.nei-slot-row--unresolved {
  background: var(--nei-bg-hover);
  box-shadow: inset 0 0 0 1px var(--nei-warn-text);
}
.nei-slot-unresolved-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 5px;
  vertical-align: middle;
  background: var(--nei-warn-text);
  box-shadow: 1px 1px 0 rgba(0, 0, 0, 0.4);
}
.nei-slot-row--collapsed .nei-slot-unresolved-dot {
  display: none;
}
.nei-slot-row--collapsed {
  box-sizing: border-box;
  padding: 2px 0;
  width: 100%;
  max-width: 40px;
  height: 44px;
  justify-content: center;
  flex-shrink: 0;
}
.nei-slot-row--collapsed.nei-slot-row--selected {
  box-shadow: inset 0 0 0 2px var(--nei-accent);
}

.nei-slot-info {
  min-width: 0;
  margin-left: 10px;
  line-height: 1.35;
}
.nei-slot-name {
  font-size: 12px;
  color: var(--nei-text);
  text-shadow: var(--nei-text-shadow);
}
.nei-slot-qty {
  margin-left: auto;
  font-size: 12px;
  color: var(--nei-text-dim);
  font-family: var(--nei-font-mono);
}
.nei-slot-id {
  font-size: 9px;
  color: var(--nei-text-id);
  font-family: var(--nei-font-mono);
}

.nei-sidebar-foot {
  flex-shrink: 0;
  padding: 6px 0;
  border-top: 1px solid var(--nei-border-subtle);
  display: flex;
  justify-content: center;
}
</style>
