<script setup lang="ts">
import { computed } from 'vue'
import BlockSlotPreview from './BlockSlotPreview.vue'
import type { BlockIconCache } from '@/render/interaction/blockIconCache'
import type { BlockStatRow } from '@/render/interaction/blockStats'

const props = defineProps<{
  entries: BlockStatRow[]
  cache: BlockIconCache
  collapsed?: boolean
}>()

const emit = defineEmits<{
  'toggle-collapse': []
  'tooltip-hover': [
    payload: {
      blockId: string; clientX: number; clientY: number; source: 'sidebar'
    } | null,
  ]
}>()

const empty = computed(() => props.entries.length === 0)
const count = computed(() => props.entries.length)

function onRowPointerEnter(e: PointerEvent, blockId: string): void {
  emit('tooltip-hover', { blockId, clientX: e.clientX, clientY: e.clientY, source: 'sidebar' })
}
function onRowPointerMove(e: PointerEvent, blockId: string): void {
  emit('tooltip-hover', { blockId, clientX: e.clientX, clientY: e.clientY, source: 'sidebar' })
}
function onRowPointerLeave(): void {
  emit('tooltip-hover', null)
}

/** Resolve block display name from registryId (strip namespace prefix) */
function displayName(row: BlockStatRow): string {
  const id = row.blockId
  if (!id) return '???'
  if (id === 'minecraft:air') return id
  const colon = id.lastIndexOf(':')
  return colon >= 0 ? id.slice(colon + 1) : id
}

</script>

<template>
  <aside
    class="nei-sidebar"
    :class="{ 'nei-sidebar--collapsed': collapsed }"
    aria-label="方块统计"
  >
    <!-- Header -->
    <div class="nei-sidebar-head">
      <template v-if="!collapsed">
        <span class="nei-sidebar-label">方块类型</span>
        <span class="nei-sidebar-count">{{ count }}</span>
      </template>
      <!-- Toggle chevron -->
      <button class="nei-sidebar-toggle" @click="emit('toggle-collapse')" :title="collapsed ? '展开侧栏' : '收起侧栏'">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nei-chevron">
          <polyline v-if="collapsed" points="9 18 15 12 9 6" />
          <polyline v-else points="15 18 9 12 15 6" />
        </svg>
      </button>
    </div>

    <!-- Empty state -->
    <div v-if="empty" class="nei-sidebar-empty">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h18"/></svg>
        <span>无方块数据</span>
      </div>

    <!-- Slot list -->
    <div
      v-else
      class="nei-sidebar-grid"
      :class="{ 'nei-sidebar-grid--collapsed': collapsed }"
    >
      <div
        v-for="row in entries"
        :key="row.blockId"
        class="nei-slot-row"
        :class="{ 'nei-slot-row--collapsed': collapsed }"
        @pointerenter="onRowPointerEnter($event, row.blockId)"
        @pointermove="onRowPointerMove($event, row.blockId)"
        @pointerleave="onRowPointerLeave"
        :title="collapsed ? displayName(row) : undefined"
      >
        <!-- Slot -->
        <BlockSlotPreview
          :cache="cache"
          :block-id="row.blockId"
          :count="row.count"
        />
        <!-- Expanded info -->
        <template v-if="!collapsed">
          <div class="nei-slot-info">
            <div class="nei-slot-name">{{ displayName(row) }}</div>
            <div class="nei-slot-id">{{ row.blockId }}</div>
          </div>
          <span class="nei-slot-qty">{{ row.count }}</span>
        </template>
      </div>
    </div>

    <!-- Bottom count badge (collapsed only) -->
    <div v-if="collapsed && !empty" class="nei-sidebar-foot">
      <span class="nei-sidebar-count">{{ count }}</span>
    </div>
  </aside>
</template>

<style scoped>
/* ===== Sidebar Container ===== */
.nei-sidebar {
  width: 220px;
  flex-shrink: 0;
  background: var(--nei-bg-surface);
  border-right: 3px solid var(--nei-border-panel);
  display: flex;
  flex-direction: column;
  transition: width 0.15s ease-out;
  overflow: hidden;
}
.nei-sidebar--collapsed {
  width: 50px;
}

/* ===== Header ===== */
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
  width: 22px; height: 22px;
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

/* ===== Empty ===== */
.nei-sidebar-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 24px 14px;
  font-size: 11px;
  color: var(--nei-text-dim);
  margin: 0;
}

/* ===== Grid (expanded) ===== */
.nei-sidebar-grid {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}
.nei-sidebar-grid--collapsed {
  display: flex;
  flex-direction: column;
  flex-wrap: wrap;
  align-content: flex-start;
  justify-content: flex-start;
  gap: 4px;
  padding: 6px 4px;
}

/* ===== Slot Row ===== */
.nei-slot-row {
  display: flex;
  align-items: center;
  padding: 2px 4px;
  cursor: pointer;
  transition: background 0.1s, box-shadow 0.1s;
}
.nei-slot-row:hover {
  background: var(--nei-bg-hover);
}
.nei-slot-row:active {
  background: var(--nei-accent-glow);
  box-shadow: inset 0 0 0 1px var(--nei-border-active);
}
.nei-slot-row--collapsed {
  padding: 0;
  width: 36px;
  height: 36px;
  justify-content: center;
  flex-shrink: 0;
}

/* ===== Expanded info ===== */
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

/* ===== Footer (collapsed only) ===== */
.nei-sidebar-foot {
  padding: 6px 0;
  border-top: 1px solid var(--nei-border-subtle);
  display: flex;
  justify-content: center;
}
</style>
