<script setup lang="ts">
import { computed } from 'vue'

import type { BlockIconCache } from '@/render/interaction/blockIconCache'
import type { BlockStatRow } from '@/render/interaction/blockStats'

import BlockSlotPreview from './BlockSlotPreview.vue'

/** 与 BlockSlotPreview 槽位一致（NEI 18×18 的 2×） */
const SLOT_PX = 36

const props = defineProps<{
  entries: BlockStatRow[]
  cache: BlockIconCache
}>()

const empty = computed(() => props.entries.length === 0)

const emit = defineEmits<{
  'tooltip-hover': [
    payload: {
      blockId: string
      clientX: number
      clientY: number
      source: 'sidebar'
    } | null,
  ]
}>()

function onRowPointerEnter(e: PointerEvent, blockId: string): void {
  emit('tooltip-hover', {
    blockId,
    clientX: e.clientX,
    clientY: e.clientY,
    source: 'sidebar',
  })
}

function onRowPointerMove(e: PointerEvent, blockId: string): void {
  emit('tooltip-hover', {
    blockId,
    clientX: e.clientX,
    clientY: e.clientY,
    source: 'sidebar',
  })
}

function onRowPointerLeave(): void {
  emit('tooltip-hover', null)
}
</script>

<template>
  <aside
    class="wm-block-stats"
    :style="{ '--wm-slot-px': `${SLOT_PX}px` }"
    aria-label="方块统计"
  >
    <div class="wm-block-stats-panel">
      <p
        v-if="empty"
        class="wm-block-stats-empty"
      >
        无方块数据
      </p>
      <ul
        v-else
        class="wm-block-stats-list"
        role="list"
        style="max-height: min(72vh, 640px)"
      >
        <li
          v-for="row in entries"
          :key="row.blockId"
          class="wm-block-stats-row"
          @pointerenter="onRowPointerEnter($event, row.blockId)"
          @pointermove="onRowPointerMove($event, row.blockId)"
          @pointerleave="onRowPointerLeave"
        >
          <BlockSlotPreview
            :block-id="row.blockId"
            :count="row.count"
            :cache="cache"
          />
        </li>
      </ul>
    </div>
  </aside>
</template>

<style scoped>
.wm-block-stats {
  --wm-slot-gap: 3px;
  --wm-block-stats-max-col-h: min(72vh, 640px);
  display: flex;
  flex-direction: column;
  width: max-content;
  min-width: calc(var(--wm-slot-px) + 8px);
  max-width: 100%;
  flex-shrink: 0;
  background: var(--nei-bg-deep);
  border-right: var(--nei-bevel-w) solid var(--nei-shadow);
  border-bottom: var(--nei-bevel-w) solid var(--nei-shadow);
  font-size: 12px;
  color: var(--nei-text-dark);
  overflow-y: auto;
}
.wm-block-stats-panel {
  flex: 0 0 auto;
  display: block;
  padding: 4px;
  background: var(--nei-bg-deep);
  overflow-x: auto;
  overflow-y: visible;
}
.wm-block-stats-empty {
  margin: 0;
  opacity: 0.85;
  font-size: 11px;
  color: var(--nei-text-dark);
}
.wm-block-stats-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  flex-wrap: wrap;
  align-content: flex-start;
  align-items: flex-start;
  gap: var(--wm-slot-gap);
  width: max-content;
  max-width: 100%;
  max-height: var(--wm-block-stats-max-col-h);
}
.wm-block-stats-row {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: var(--wm-slot-px);
  height: var(--wm-slot-px);
  min-width: 0;
}
</style>
