<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import BlockSlotPreview from './BlockSlotPreview.vue'
import type { BlockIconCache } from '@/render/interaction/blockIconCache'
import type { BlockStatRow } from '@/render/interaction/blockStats'

const props = defineProps<{
  entries: BlockStatRow[]
  cache: BlockIconCache
  collapsed?: boolean
  selectedBlockId?: string | null
  tooltipMap?: Map<string, string[]>
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

const empty = computed(() => props.entries.length === 0)
const count = computed(() => props.entries.length)

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
  () => [props.entries.length, props.collapsed] as const,
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

function displayName(row: BlockStatRow): string {
  const id = row.blockId
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
