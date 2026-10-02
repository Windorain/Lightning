<script setup lang="ts">
/**
 * BlockStatsSidebar — 统计栏（P2.4 升级：部件物品清单 + 三视图切换 + 三级配置入口）。
 *
 * 契约：`docs/plan/format-parts-contract.md`（§5 物品身份、§9 三级配置）。
 * 引擎：`@/pure/partStats`（P2.3，行集/退化语义由引擎钉死，本组件只呈现）。
 *
 * ── 留白 #7 拍板登记（统计栏呈现细节，P2.4；将登记回计划 §9）──
 *
 * 【UI 结构】有部件数据时进入"部件模式"：
 *  - 头部保持既有形态；头部下方新增工具条 = 视图切换（部件物品 / 宿主 / 自定义分组）
 *    + 配置来源徽标（可展开逐字段来源面板）；
 *  - 默认视图 = 部件物品清单（引擎 parts 视图；文档 statsTemplate/覆盖/本地可改默认）；
 *  - 行 = 引擎 StatsRow 原样呈现：label = 游戏内显示名（硬约束），iconKey = 物品身份键；
 *  - 宿主行（宿主视图 / showHostRows 组）沿用 tooltipMap 友好名与旧的悬停/点选交互；
 *    部件行本轮不参与悬停 tooltip / 点选描边（其键不是宿主方块键，留 P2.5 细化）；
 *  - `items: []` 的无物品部件以"N 个无物品部件未计入清单"提示行呈现（不产生物品行）。
 *
 * 【provenance 呈现】配置入口 = 工具条来源徽标 + 展开面板：
 *  - 徽标常驻显示**视图**这一字段的来源（内建默认 / 文档默认 / 文档覆盖 / 本机修改），
 *    "默认值来自文档"这一事实由此对用户可见；
 *  - 展开面板逐字段列出视图 + 每个生效规则键的来源，并在存在本机修改时提供
 *    "清除本机修改"（写 localStorage null，回到文档级配置）。
 *
 * 【三级配置读写取舍】
 *  - 查看者本地层：完整实现。视图切换即写 localStorage（`lightning:stats:v1:<docId>`）；
 *    若所切视图与下层合成结果相同，则不落本地覆盖（保持 provenance 干净）；
 *  - 文档覆盖层（statsOverride）：**本轮只读**——读取并参与合成与 provenance 呈现，
 *    不做"编辑规则并写回文档"的 UI。理由：embed 查看器是只读消费场景，写回文档属于
 *    编辑流程（workbench 保存链路）；P2.3 已保证 statsOverride 随 `_extra` round-trip，
 *    写回 UI 留 P2.5 后增强。
 *
 * 【无部件旧文件退化】文件无部件数据（或当前过滤层无部件）时：
 *  **完全走旧路径**——不显示视图切换与配置入口，行集直接取自 `entries` prop
 *  （与今天逐像素、逐行为一致：tooltipMap 友好名、悬停 tooltip、点选描边全保留）。
 *  选择"不显示切换"而非"显示但不变化"：旧文件的 DOM 零新增，行为差异为零。
 *
 * 【数据来源】`definition` prop 优先；缺省时回退 `cache.getStructure()`（图标缓存随结构
 *  重建，与视口渲染定义同源）。文档根字段（statsTemplate/statsOverride）在运行时随
 *  `toStructureDefinition` 浅拷贝挂载在同对象上，直接读取。`layerPreview` prop 缺省 'all'
 *  （EmbedViewport 接线前部件视图不按层过滤，登记为集成点）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import BlockSlotPreview from './BlockSlotPreview.vue'
import type { BlockIconCache } from '@/render/interaction/blockIconCache'
import type { BlockStatRow } from '@/render/interaction/blockStats'
import {
  buildStatsView,
  resolveStatsConfig,
  type StatsConfigSource,
  type StatsRow,
  type StatsViewId,
  type StatsViewResult,
} from '@/pure/partStats'
import {
  buildPartStatsInput,
  statsConfigFromV2Template,
  statsOverrideFromDocumentRoot,
} from '@/render/interaction/partStatsAdapter'
import {
  loadViewerLocalStatsConfig,
  saveViewerLocalStatsConfig,
} from '@/render/interaction/statsConfigStorage'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import type { V2StatsTemplate } from '@/render/data/sceneDocumentV2'
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
  /** 部件物品图标纹理（物品身份键 → base64 PNG；P1.7/P1.8 嵌入纹理体系接入点，本轮 fixture 无） */
  partIconTextures?: Record<string, string> | null
}>()

const emit = defineEmits<{
  'toggle-collapse': []
  'tooltip-hover': [
    payload: {
      blockId: string; clientX: number; clientY: number; source: 'sidebar'
    } | null,
  ]
  'select-block': [blockId: string]
}>()

// ---------------------------------------------------------------------------
// P2.4 统计视图（部件模式）；无部件 ⇒ statsResult = null ⇒ 完全走旧路径
// ---------------------------------------------------------------------------

/** 运行时挂载在 def 同对象上的文档根字段（toStructureDefinition 浅拷贝根 + 首帧 structure） */
type StatsRootCarrier = { statsTemplate?: V2StatsTemplate }

const definition = computed<StructureDefinition | null>(
  () => props.definition ?? props.cache.getStructure(),
)
const layerPreviewMode = computed<LayerPreviewMode>(() => props.layerPreview ?? 'all')

const statsInput = computed(() => {
  const d = definition.value
  return d ? buildPartStatsInput(d, layerPreviewMode.value) : null
})
/** 无部件数据（旧文件 / 当前层无部件）⇒ 退化：完全走旧路径（拍板见文件头） */
const hasParts = computed(() => (statsInput.value?.parts.length ?? 0) > 0)

const docId = computed(() => definition.value?.id?.trim() ?? '')

const docDefaultLayer = computed(() =>
  statsConfigFromV2Template((definition.value as StatsRootCarrier | null)?.statsTemplate),
)
const docOverrideLayer = computed(() =>
  statsOverrideFromDocumentRoot(definition.value as unknown as Record<string, unknown> | null),
)
/** 本地写入后自增，驱动 viewerLocalLayer 重算（loadViewerLocalStatsConfig 非响应式） */
const viewerLocalBump = ref(0)
const viewerLocalLayer = computed(() => {
  void viewerLocalBump.value
  const id = docId.value
  return id ? loadViewerLocalStatsConfig(id) : null
})

const resolved = computed(() =>
  resolveStatsConfig({
    documentDefault: docDefaultLayer.value,
    documentOverride: docOverrideLayer.value,
    viewerLocal: viewerLocalLayer.value,
  }),
)
const provenance = computed(() => resolved.value.provenance)

const statsResult = computed<StatsViewResult | null>(() => {
  const input = statsInput.value
  if (!input || !hasParts.value) return null
  return buildStatsView(input, resolved.value.config)
})

const statsRowTotal = computed(() =>
  statsResult.value ? statsResult.value.groups.reduce((n, g) => n + g.rows.length, 0) : 0,
)

const empty = computed(() =>
  statsResult.value ? statsRowTotal.value === 0 : props.entries.length === 0,
)
const count = computed(() =>
  statsResult.value ? statsRowTotal.value : props.entries.length,
)

// ---- 视图切换（写查看者本地层）----

const VIEW_TABS: ReadonlyArray<{ id: StatsViewId; label: string }> = [
  { id: 'parts', label: '部件物品' },
  { id: 'hosts', label: '宿主' },
  { id: 'custom', label: '自定义' },
]
const activeView = computed<StatsViewId>(() => statsResult.value?.view ?? resolved.value.config.view)

function setView(view: StatsViewId): void {
  const id = docId.value
  if (!id) return
  // 与下层（内建/文档默认/文档覆盖）合成结果相同 ⇒ 不落本地覆盖，保持 provenance 干净
  const lowerView = resolveStatsConfig({
    documentDefault: docDefaultLayer.value,
    documentOverride: docOverrideLayer.value,
  }).config.view
  const current = { ...(loadViewerLocalStatsConfig(id) ?? {}) }
  if (view === lowerView) delete current.view
  else current.view = view
  saveViewerLocalStatsConfig(
    id,
    current.view === undefined && current.rules === undefined ? null : current,
  )
  viewerLocalBump.value++
}

// ---- 配置来源（provenance）呈现 ----

const SOURCE_LABELS: Record<StatsConfigSource, string> = {
  builtin: '内建默认',
  'document-default': '文档默认',
  'document-override': '文档覆盖',
  'viewer-local': '本机修改',
}
function sourceLabel(s: StatsConfigSource): string {
  return SOURCE_LABELS[s]
}

const RULE_FIELD_LABELS: Record<string, string> = {
  ignore: '忽略表',
  scale: '系数换算',
  aliases: '别名合并',
  keyGranularity: '分组粒度',
  showHostRows: '宿主行开关',
  sortBy: '排序',
  groups: '显式分组',
  showOthers: '其他组开关',
  othersTitle: '其他组标题',
  hostGroupTitle: '宿主组标题',
}
const provenanceRuleFields = computed(() => {
  const out: Array<{ key: string; label: string; source: StatsConfigSource }> = []
  for (const [key, label] of Object.entries(RULE_FIELD_LABELS)) {
    const src = provenance.value.rules[key as keyof typeof provenance.value.rules]
    if (src) out.push({ key, label, source: src })
  }
  return out
})

const showProvenance = ref(false)
const hasViewerLocal = computed(() => viewerLocalLayer.value !== null)

function resetViewerLocal(): void {
  const id = docId.value
  if (!id) return
  saveViewerLocalStatsConfig(id, null)
  viewerLocalBump.value++
}

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

/** 部件模式行图标：部件键走 ensurePartIcons（回退链），宿主键走既有 ensure */
watch(
  [statsResult, () => props.cache],
  () => {
    const r = statsResult.value
    if (!r) return
    const partKeys: string[] = []
    const hostKeys: string[] = []
    for (const g of r.groups) {
      for (const row of g.rows) (row.kind === 'part' ? partKeys : hostKeys).push(row.iconKey)
    }
    props.cache.ensure(hostKeys)
    props.cache.ensurePartIcons(partKeys)
  },
  { immediate: true, flush: 'post' },
)

// ---------------------------------------------------------------------------
// 行呈现（部件模式）
// ---------------------------------------------------------------------------

/** 行显示名：部件行 = 游戏内显示名（StatsRow.label，硬约束）；宿主行沿用 tooltipMap 友好名 */
function rowLabel(row: StatsRow): string {
  if (row.kind === 'part') return row.label
  return displayNameById(row.key)
}

/** 行副标题：去 modid 前缀（首个冒号前），宿主 meta 段 `@` 显示为 `:` */
function rowSubLabel(row: StatsRow): string {
  const key = row.iconKey
  const colon = key.indexOf(':')
  const s = colon >= 0 ? key.slice(colon + 1) : key
  return s.replace('@', ':')
}

/** 计数格式化：整数原样；系数换算后的小数保留至多两位 */
function formatCount(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}

// ---------------------------------------------------------------------------
// 以下为既有侧栏行为（旧路径 = 无部件文件逐行为一致；部件模式的宿主行复用）
// ---------------------------------------------------------------------------

const gridRef = ref<HTMLElement | null>(null)
const pullY = ref(0)
const glowTop = ref(false)
const glowBottom = ref(false)
const isPullDragging = ref(false)

const MAX_PULL_PX = 44
const GLOW_ON_PX = 6
const RUBBER_K = 36

let resizeObs: ResizeObserver | null = null
let pullPointerId = -1
let pullStartClientY = 0

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

function onGridPointerDown(e: PointerEvent): void {
  const el = gridRef.value
  if (!el || e.button !== 0) return
  pullPointerId = e.pointerId
  pullStartClientY = e.clientY
  isPullDragging.value = false
  const inner = el.firstElementChild as HTMLElement | null
  inner?.classList.remove('nei-sidebar-grid-inner--snap')
  try {
    el.setPointerCapture(e.pointerId)
  } catch { /* ignore */ }
}

function onGridPointerMove(e: PointerEvent): void {
  if (e.pointerId !== pullPointerId) return
  const el = gridRef.value
  if (!el) return

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
})

onBeforeUnmount(() => {
  resizeObs?.disconnect()
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

    <!-- P2.4 部件模式工具条：视图切换 + 配置来源徽标（无部件旧文件不渲染，拍板见文件头） -->
    <div v-if="statsResult && !collapsed" class="nei-stats-toolbar">
      <div class="nei-stats-views" role="tablist" aria-label="统计视图">
        <button
          v-for="tab in VIEW_TABS"
          :key="tab.id"
          type="button"
          role="tab"
          class="nei-stats-view-btn"
          :class="{ 'nei-stats-view-btn--active': activeView === tab.id }"
          :aria-selected="activeView === tab.id"
          :data-stats-view-btn="tab.id"
          :title="`${tab.label}（视图来源：${sourceLabel(provenance.view)}）`"
          @click="setView(tab.id)"
        >{{ tab.label }}</button>
      </div>
      <button
        type="button"
        class="nei-stats-prov-pill"
        :class="{ 'nei-stats-prov-pill--open': showProvenance }"
        :data-stats-source="provenance.view"
        :title="`配置来源：${sourceLabel(provenance.view)}（点击展开逐字段来源）`"
        :aria-expanded="showProvenance"
        @click="showProvenance = !showProvenance"
      >{{ sourceLabel(provenance.view) }}</button>
    </div>

    <!-- 配置来源面板：逐字段 provenance（"默认值来自文档"对用户可见） -->
    <div
      v-if="statsResult && !collapsed && showProvenance"
      class="nei-stats-prov"
      data-stats-provenance
    >
      <div
        class="nei-stats-prov-row"
        data-stats-prov-field="view"
        :data-stats-prov-source="provenance.view"
      >
        <span class="nei-stats-prov-field">视图</span>
        <span class="nei-stats-prov-source">{{ sourceLabel(provenance.view) }}</span>
      </div>
      <div
        v-for="f in provenanceRuleFields"
        :key="f.key"
        class="nei-stats-prov-row"
        :data-stats-prov-field="f.key"
        :data-stats-prov-source="f.source"
      >
        <span class="nei-stats-prov-field">{{ f.label }}</span>
        <span class="nei-stats-prov-source">{{ sourceLabel(f.source) }}</span>
      </div>
      <div class="nei-stats-prov-note">修改保存在本机（localStorage），不写回文档</div>
      <button
        v-if="hasViewerLocal"
        type="button"
        class="nei-stats-prov-reset"
        data-stats-reset-local
        @click="resetViewerLocal"
      >清除本机修改</button>
    </div>

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
      >
        <div
          class="nei-sidebar-grid-inner nei-sidebar-grid-inner--snap"
          :class="{ 'nei-sidebar-grid-inner--collapsed': collapsed }"
          :style="innerStyle"
        >
          <!-- 部件模式：引擎 StatsRow 原样呈现（图标键 = 物品身份键，名称 = 游戏内显示名） -->
          <template v-if="statsResult">
            <div
              v-if="statsResult.itemlessPartCount > 0"
              class="nei-stats-itemless"
              data-stats-itemless
            >{{ statsResult.itemlessPartCount }} 个无物品部件未计入清单</div>
            <template v-for="(group, gi) in statsResult.groups" :key="group.title ?? gi">
              <div
                v-if="group.title && !collapsed"
                class="nei-stats-group-title"
                data-stats-group-title
              >{{ group.title }}</div>
              <div
                v-for="row in group.rows"
                :key="row.key"
                class="nei-slot-row"
                :class="{
                  'nei-slot-row--collapsed': collapsed,
                  'nei-slot-row--selected': row.kind === 'host' && row.key === selectedBlockId,
                }"
                :data-stats-row-key="row.key"
                :data-stats-row-kind="row.kind"
                :data-stats-icon-key="row.iconKey"
                @pointerenter="row.kind === 'host' && onRowPointerEnter($event, row.key)"
                @pointermove="row.kind === 'host' && onRowPointerMove($event, row.key)"
                @pointerleave="onRowPointerLeave"
                @click="row.kind === 'host' && onRowClick(row.key)"
                :title="collapsed ? rowLabel(row) : undefined"
              >
                <BlockSlotPreview
                  :cache="cache"
                  :block-id="row.iconKey"
                  :count="row.count"
                />
                <template v-if="!collapsed">
                  <div class="nei-slot-info">
                    <div class="nei-slot-name">{{ rowLabel(row) }}</div>
                    <div class="nei-slot-id">{{ rowSubLabel(row) }}</div>
                  </div>
                  <span class="nei-slot-qty">{{ formatCount(row.count) }}</span>
                </template>
              </div>
            </template>
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

/* ---- P2.4 部件模式：视图切换 + 配置来源 ---- */
.nei-stats-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  background: var(--nei-bg-panel);
  border-bottom: 1px solid var(--nei-border-subtle);
  flex-shrink: 0;
}
.nei-stats-views {
  display: flex;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.nei-stats-view-btn {
  flex: 1;
  min-width: 0;
  padding: 3px 2px;
  font-size: 10px;
  color: var(--nei-text-dim);
  background: var(--nei-bg-input);
  border: 1px solid var(--nei-border-panel);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nei-stats-view-btn:hover { color: var(--nei-text); }
.nei-stats-view-btn--active {
  color: var(--nei-text);
  background: var(--nei-bg-hover);
  border-color: var(--nei-accent);
  text-shadow: var(--nei-text-shadow);
}
.nei-stats-prov-pill {
  flex-shrink: 0;
  padding: 3px 6px;
  font-size: 9px;
  color: var(--nei-text-id);
  background: var(--nei-bg-input);
  border: 1px solid var(--nei-border-panel);
  cursor: pointer;
  white-space: nowrap;
}
.nei-stats-prov-pill:hover,
.nei-stats-prov-pill--open { color: var(--nei-text); border-color: var(--nei-accent); }

.nei-stats-prov {
  padding: 4px 8px 6px;
  background: var(--nei-bg-panel);
  border-bottom: 1px solid var(--nei-border-subtle);
  flex-shrink: 0;
  font-size: 10px;
}
.nei-stats-prov-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 1px 0;
}
.nei-stats-prov-field { color: var(--nei-text-dim); }
.nei-stats-prov-source { color: var(--nei-text); font-family: var(--nei-font-mono); }
.nei-stats-prov-note {
  margin-top: 4px;
  font-size: 9px;
  color: var(--nei-text-id);
}
.nei-stats-prov-reset {
  margin-top: 4px;
  padding: 2px 8px;
  font-size: 10px;
  color: var(--nei-text-dim);
  background: var(--nei-bg-input);
  border: 1px solid var(--nei-border-panel);
  cursor: pointer;
}
.nei-stats-prov-reset:hover { color: var(--nei-text); }

.nei-stats-group-title {
  padding: 4px 6px 2px;
  font-size: 10px;
  font-weight: 700;
  color: var(--nei-text-dim);
  text-transform: uppercase;
  text-shadow: var(--nei-text-shadow-deep);
}
.nei-stats-itemless {
  margin: 2px 4px;
  padding: 3px 6px;
  font-size: 10px;
  color: var(--nei-text-id);
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
.nei-slot-row:hover {
  background: var(--nei-bg-hover);
}
.nei-slot-row:active {
  background: var(--nei-bg-hover);
}
.nei-slot-row--selected {
  background: var(--nei-accent-glow);
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
