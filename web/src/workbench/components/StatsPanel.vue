<script setup lang="ts">
import { computed } from 'vue'
import { useBContext } from '@/workbench/context/bContext'
import { useSelectionContext } from '@/workbench/selectionContext'
import { usePanelState } from '@/workbench/panelState'
import type { V2StatsTemplate } from '@/render/data/sceneDocumentV2'

const bctx = useBContext()
const selection = useSelectionContext()
const { highlightType, clearHighlight, pinType } = usePanelState()

const template = computed<V2StatsTemplate | null>(() => {
  return (bctx.doc.value?.toRaw() as any)?.stats_template ?? null
})

const mode = computed(() => template.value?.mode ?? 'auto')

interface StatRow {
  block_state_id: string
  label: string
  count: number
}

const rows = computed<StatRow[]>(() => {
  const doc = bctx.doc.value?.toRaw()
  if (!doc) return []
  const currentFrame = (doc as any).frames?.[selection.frameIndex.value ?? 0]
  const blocks = (currentFrame?.blocks ?? []) as Array<{ block_state_id: string }>

  if (mode.value === 'auto') {
    const counts = new Map<string, number>()
    for (const b of blocks) {
      counts.set(b.block_state_id, (counts.get(b.block_state_id) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([id, n]) => ({ block_state_id: id, label: id, count: n }))
      .sort((a, b) => b.count - a.count)
  }

  // Custom mode
  const groups = template.value?.groups ?? []
  const countMap = new Map<string, number>()
  for (const b of blocks) {
    countMap.set(b.block_state_id, (countMap.get(b.block_state_id) ?? 0) + 1)
  }
  const result: StatRow[] = []
  for (const g of groups) {
    for (const e of g.entries) {
      result.push({
        block_state_id: e.block_state_id,
        label: e.label_override ?? e.block_state_id,
        count: countMap.get(e.block_state_id) ?? 0,
      })
    }
  }
  return result
})

function onMouseEnter(id: string): void { highlightType(id) }
function onMouseLeave(): void { clearHighlight() }
function onClick(id: string): void { pinType(id) }
</script>

<template>
  <div class="stats-panel">
    <div class="stats-panel__header">
      <span>Stats ({{ mode }})</span>
    </div>
    <div class="stats-panel__list">
      <div
        v-for="row in rows"
        :key="row.block_state_id"
        class="stats-row"
        @mouseenter="onMouseEnter(row.block_state_id)"
        @mouseleave="onMouseLeave"
        @click="onClick(row.block_state_id)"
      >
        <span class="stats-row__label">{{ row.label }}</span>
        <span class="stats-row__count">{{ row.count }}</span>
      </div>
      <div v-if="rows.length === 0" class="stats-row stats-row--empty">
        No blocks in current frame
      </div>
    </div>
  </div>
</template>

<style scoped>
.stats-panel { padding: 8px; font-size: 12px; color: var(--nei-text-dark); height: 100%; display: flex; flex-direction: column; }
.stats-panel__header { font-weight: 600; margin-bottom: 4px; flex-shrink: 0; }
.stats-panel__list { flex: 1; overflow-y: auto; }
.stats-row {
  display: flex; justify-content: space-between; padding: 2px 6px;
  border-radius: 3px; cursor: pointer;
}
.stats-row:hover { background: var(--nei-panel-hover); }
.stats-row--empty { cursor: default; color: var(--nei-muted); justify-content: center; }
.stats-row--empty:hover { background: transparent; }
.stats-row__label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stats-row__count { font-variant-numeric: tabular-nums; color: var(--nei-muted); margin-left: 8px; }
</style>
