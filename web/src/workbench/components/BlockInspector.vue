<script setup lang="ts">
import { computed } from 'vue'
import { copyTextToClipboard } from '@/util/browser'
import { renderTooltipHtml } from './renderTooltipHtml'
import { useSceneContext } from '@/workbench/sceneContext'
import { useSelectionContext } from '@/workbench/selectionContext'
import { isWorldDocument, resolveRenderBundle } from '@/render/data/bundleResolve'
import { findBlockPaletteEntryByBlockId } from '@/render/data/blockRegistryResolve'
import type { BlockPaletteEntry, RenderBundle } from '@/render/schema/types'
import type { V2GuiState, V2BlockPart, V2BlockInstance } from '@/render/data/sceneDocumentV2'

function copyNbtToClipboard(): void {
  if (!paletteEntry.value?.nbt) return
  copyTextToClipboard(JSON.stringify(paletteEntry.value.nbt, null, 2))
}

const ctx = useSceneContext()
const selection = useSelectionContext()
const selectedBlock = computed(() => {
  if (selection.items.value.size === 0) return null
  const first = selection.items.value.values().next().value
  if (!first) return null
  return {
    blockId: first.block_state_id,
    voxel: { column: first.pos.x, row: first.pos.y, zSlice: first.pos.z },
  }
})

const paletteEntry = computed<BlockPaletteEntry | null>(() => {
  if (!selectedBlock.value) return null
  const doc = ctx.scene.value
  if (!doc) return null
  try {
    const frameIdx = isWorldDocument(doc) ? ctx.previewWorldFrameIndex.value : undefined
    const bundle = { document: doc } as RenderBundle
    const { definition } = resolveRenderBundle(bundle, frameIdx)
    return findBlockPaletteEntryByBlockId(definition, selectedBlock.value.blockId) ?? null
  } catch { return null }
})

const materialIndices = computed<number[]>(() => {
  const quads = paletteEntry.value?.geometry?.quads
  if (!quads || quads.length === 0) return []
  const seen = new Set<number>()
  for (const q of quads) seen.add(q.materialIndex)
  return [...seen].sort((a, c) => a - c)
})

function materialName(index: number): string {
  const doc = ctx.scene.value
  if (!doc) return `#${index}`
  let pal: unknown
  if (isWorldDocument(doc)) {
    pal = doc.materialPalette
  } else {
    pal = (doc as Record<string, unknown>).materialPalette
  }
  if (!Array.isArray(pal) || !pal[index]) return `#${index}`
  return (pal[index] as { locator?: string }).locator ?? `#${index}`
}

const tooltipPreview = computed(() => {
  const doc = ctx.scene.value
  if (!doc || !selectedBlock.value?.voxel) return ''
  const { zSlice, row, column } = selectedBlock.value.voxel
  let tp: unknown, ttg: unknown
  if (isWorldDocument(doc)) {
    tp = doc.tooltipPalette
    const frames = doc.frames
    if (Array.isArray(frames) && frames.length > 0) {
      const n = frames.length
      const raw = Math.floor(ctx.previewWorldFrameIndex.value)
      const idx = ((raw % n) + n) % n
      ttg = ((frames[idx] as Record<string, unknown>)?.structure as Record<string, unknown> | undefined)?.cellTooltipGrid
    }
  } else {
    tp = (doc as Record<string, unknown>).tooltipPalette
    ttg = (doc as Record<string, unknown>).cellTooltipGrid
  }
  if (!Array.isArray(tp) || tp.length === 0) return ''
  if (!Array.isArray(ttg)) return ''
  const zArr = ttg[zSlice]; if (!Array.isArray(zArr)) return ''
  const rArr = zArr[row]; if (!Array.isArray(rArr)) return ''
  const palIdx = rArr[column]
  if (typeof palIdx !== 'number' || palIdx < 0) return ''
  return String(tp[palIdx] ?? '')
})

const tooltipHtml = computed(() => tooltipPreview.value ? renderTooltipHtml(tooltipPreview.value) : '')

const neiTooltipLines = computed<string[]>(() => paletteEntry.value?.tooltip ?? [])

function copyTooltipLine(line: string): void {
  copyTextToClipboard(line)
}

function copyAllTooltip(): void {
  copyTextToClipboard(neiTooltipLines.value.join('\n'))
}

// Computed helpers for gui_state and parts
function findSelectedBlockInstance(): V2BlockInstance | null {
  if (!selectedBlock.value) return null
  const doc = ctx.scene.value
  if (!doc) return null
  const v = selectedBlock.value.voxel
  const frameIdx = isWorldDocument(doc) ? ctx.previewWorldFrameIndex.value : 0
  const frame = (doc as any).frames?.[frameIdx]
  if (!frame?.blocks) return null
  return (frame.blocks as V2BlockInstance[]).find(
    (b: V2BlockInstance) => b.pos.x === v.column && b.pos.y === v.row && b.pos.z === v.zSlice
  ) ?? null
}

const guiState = computed<V2GuiState | null>(() => {
  return findSelectedBlockInstance()?.gui_state ?? null
})

const parts = computed<V2BlockPart[]>(() => {
  return findSelectedBlockInstance()?.parts ?? []
})
</script>

<template>
  <div class="pe-panel">
    <div class="pe-title">方块检查器</div>
    <template v-if="!selectedBlock">
      <p class="pe-muted">点击 3D 视口选取方块</p>
    </template>
    <template v-else>
      <h3>身份</h3>
      <table class="bi-table">
        <tr><td>registryId</td><td class="bi-td-val">{{ selectedBlock.blockId }}</td></tr>
        <tr v-if="paletteEntry"><td>meta</td><td class="bi-td-val">{{ paletteEntry.meta }}</td></tr>
        <tr v-if="paletteEntry?.facing"><td>facing</td><td class="bi-td-val">{{ paletteEntry.facing }}</td></tr>
        <tr v-if="paletteEntry"><td>renderMode</td><td class="bi-td-val">{{ paletteEntry.renderMode }}</td></tr>
      </table>

      <template v-if="selectedBlock.voxel">
        <h3>位置</h3>
        <span class="bi-pos">{{ selectedBlock.voxel.column }}, {{ selectedBlock.voxel.row }}, {{ selectedBlock.voxel.zSlice }}</span>
      </template>

      <h3>注解</h3>
      <div v-if="tooltipHtml" class="wm-tooltip-surface wm-tooltip-surface--inline">
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div class="wm-tooltip-body" v-html="tooltipHtml" />
      </div>
      <p v-else class="pe-muted">无注解</p>

      <h3>NEI 导出 ToolTip</h3>
      <template v-if="neiTooltipLines.length">
        <div class="bi-tooltip-lines">
          <div v-for="(line, idx) in neiTooltipLines" :key="idx"
               class="bi-tooltip-row" title="点击复制原格式文本"
               @click="copyTooltipLine(line)">
            <span class="bi-tooltip-text" v-html="renderTooltipHtml(line)" />
          </div>
        </div>
        <div class="bi-tooltip-actions">
          <button class="pe-btn pe-btn--sm" @click="copyAllTooltip">复制全部</button>
        </div>
        <p class="pe-hint">由 SDE 在客户端 finalize 时抓取，非手工注解</p>
      </template>
      <p v-else class="pe-muted">无 NEI ToolTip 数据</p>

      <h3>材质引用</h3>
      <template v-if="materialIndices.length">
        <div v-for="mi in materialIndices" :key="mi" class="bi-mat-row">
          <span class="bi-mat-idx">{{ mi }}</span>
          <span class="bi-mat-name">{{ materialName(mi) }}</span>
        </div>
      </template>
      <p v-else class="pe-muted">无材质信息</p>

      <h3>NBT 数据</h3>
      <template v-if="paletteEntry?.nbt && Object.keys(paletteEntry.nbt).length">
        <div class="bi-nbt-wrap">
          <pre class="bi-nbt-pre">{{ JSON.stringify(paletteEntry.nbt, null, 2) }}</pre>
          <button class="pe-btn" @click="copyNbtToClipboard">复制 NBT JSON</button>
        </div>
      </template>
      <p v-else class="pe-muted">无 NBT 数据</p>
      <!-- gui_state: simplified machine GUI -->
      <div v-if="guiState" class="bi-section">
        <h4 class="bi-section-title">Machine GUI</h4>
        <div class="bi-gui">
          <div v-if="guiState.item_slots && guiState.item_slots.length" class="bi-gui-slots">
            <div v-for="slot in guiState.item_slots" :key="slot.slot_index" class="bi-gui-slot">
              <span class="bi-gui-slot-idx">{{ slot.slot_index }}</span>
              <span class="bi-gui-slot-item">{{ slot.item_id }}</span>
              <span v-if="slot.count > 0" class="bi-gui-slot-count">×{{ slot.count }}</span>
            </div>
          </div>
          <div v-if="guiState.fluid_tanks && guiState.fluid_tanks.length" class="bi-gui-tanks">
            <div v-for="tank in guiState.fluid_tanks" :key="tank.tank_index" class="bi-gui-tank">
              <span class="bi-gui-tank-label">{{ tank.fluid_id || 'Empty' }}</span>
              <div class="bi-gui-tank-bar">
                <div class="bi-gui-tank-fill" :style="{ width: tank.capacity_mb ? (tank.amount_mb / tank.capacity_mb * 100) + '%' : '0%' }" />
              </div>
              <span class="bi-gui-tank-amount">{{ tank.amount_mb }} / {{ tank.capacity_mb }} mB</span>
            </div>
          </div>
          <div v-if="guiState.energy" class="bi-gui-energy">
            <span class="bi-gui-energy-label">Energy</span>
            <div class="bi-gui-tank-bar">
              <div class="bi-gui-energy-fill" :style="{ width: guiState.energy.capacity_eu ? (guiState.energy.stored_eu / guiState.energy.capacity_eu * 100) + '%' : '0%' }" />
            </div>
            <span class="bi-gui-energy-amount">{{ guiState.energy.stored_eu }} / {{ guiState.energy.capacity_eu }} EU</span>
          </div>
          <div v-if="guiState.config && Object.keys(guiState.config).length" class="bi-gui-config">
            <div v-for="(_v, k) in guiState.config" :key="k" class="bi-gui-config-row">
              <span class="bi-gui-config-key">{{ k }}</span>
              <span class="bi-gui-config-val">{{ _v }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- parts: multipart sub-block display -->
      <div v-if="parts && parts.length" class="bi-section">
        <h4 class="bi-section-title">Parts ({{ parts.length }})</h4>
        <div v-for="part in parts" :key="part.local_id" class="bi-part">
          <span class="bi-part-kind">{{ part.part_kind }}</span>
          <span class="bi-part-dir">dir: {{ part.direction >= 0 ? ['DOWN','UP','NORTH','SOUTH','WEST','EAST','CENTER'][part.direction] : 'N/A' }}</span>
          <span v-if="part.tooltip" class="bi-part-tooltip">{{ part.tooltip }}</span>
        </div>
      </div>
    </template>
  </div>
</template>
<style scoped>
.pe-panel { padding: 10px; font-size: 12px; }
.pe-title { font-size: 13px; font-weight: 600; color: var(--nei-text); text-shadow: var(--nei-label-shadow); margin-bottom: 8px; }
.pe-muted { font-size: 11px; color: var(--nei-muted); }
.pe-hint { font-size: 10px; color: var(--nei-muted); margin-top: 3px; }
.bi-tooltip-lines { display: flex; flex-direction: column; gap: 2px; }
.bi-tooltip-row {
  display: flex; align-items: center; padding: 2px 6px; border-radius: 3px;
  border: 1px solid var(--nei-border); background: var(--nei-inset-bg); cursor: pointer;
  transition: background 0.1s;
}
.bi-tooltip-row:hover { background: var(--nei-bg); border-color: var(--nei-highlight); }
.bi-tooltip-row:active { background: var(--nei-btn-bg); }
.bi-tooltip-text { font-size: 12px; color: var(--nei-text); word-break: break-word; user-select: none; }
.bi-tooltip-actions { margin-top: 6px; }
.pe-btn--sm { font-size: 10px; padding: 2px 8px; }
h3 { font-size: 10px; font-weight: 600; color: var(--nei-label); text-transform: uppercase; letter-spacing: 0.3px; margin: 10px 0 4px; }
.bi-table { width: 100%; border-collapse: collapse; }
.bi-table td { padding: 2px 6px 2px 0; font-size: 11px; }
.bi-table td:first-child { color: var(--nei-label); width: 80px; }
.bi-td-val { font-family: ui-monospace, monospace; color: var(--nei-text-dark); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: var(--nei-bg); padding: 1px 4px; border: 1px solid var(--nei-border); }
.bi-pos { font-family: ui-monospace, monospace; font-size: 12px; color: var(--nei-text-dark); }
.bi-mat-row { display: flex; gap: 6px; padding: 2px 0; }
.bi-mat-idx { font-family: ui-monospace, monospace; font-size: 11px; color: var(--nei-label); min-width: 24px; }
.bi-mat-name { font-family: ui-monospace, monospace; font-size: 11px; color: var(--nei-text-dark); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bi-nbt-wrap { margin: 4px 0; }
.bi-nbt-pre {
  padding: 6px; margin: 4px 0;
  background: var(--nei-inset-bg);
  border: 1px solid var(--nei-border); border-radius: 4px;
  font-size: 10px; max-height: 200px; overflow: auto;
  white-space: pre-wrap; word-break: break-all;
  font-family: ui-monospace, monospace;
  color: var(--nei-text-dark);
}
/* gui_state styles */
.bi-section { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--nei-border); }
.bi-section-title { margin: 0 0 4px; font-size: 11px; font-weight: 600; color: var(--nei-muted); text-transform: uppercase; letter-spacing: 0.5px; }
.bi-gui { font-size: 11px; }
.bi-gui-slots { display: flex; flex-wrap: wrap; gap: 3px; }
.bi-gui-slot { display: flex; align-items: center; gap: 3px; padding: 2px 6px; background: var(--nei-bg); border: 1px solid var(--nei-border); border-radius: 3px; }
.bi-gui-slot-idx { color: var(--nei-muted); font-size: 10px; }
.bi-gui-slot-item { font-size: 10px; overflow: hidden; text-overflow: ellipsis; max-width: 100px; white-space: nowrap; }
.bi-gui-slot-count { color: var(--nei-label); font-size: 10px; }
.bi-gui-tank, .bi-gui-energy { margin-top: 4px; }
.bi-gui-tank-label, .bi-gui-energy-label { font-size: 10px; color: var(--nei-muted); }
.bi-gui-tank-bar { height: 6px; background: var(--nei-bg); border: 1px solid var(--nei-border); border-radius: 3px; margin: 2px 0; overflow: hidden; }
.bi-gui-tank-fill { height: 100%; background: #4488cc; border-radius: 2px; transition: width 0.2s; }
.bi-gui-energy-fill { height: 100%; background: #cc4444; border-radius: 2px; transition: width 0.2s; }
.bi-gui-tank-amount, .bi-gui-energy-amount { font-size: 10px; color: var(--nei-muted); font-variant-numeric: tabular-nums; }
.bi-gui-config { margin-top: 4px; }
.bi-gui-config-row { display: flex; gap: 6px; font-size: 10px; padding: 1px 0; }
.bi-gui-config-key { color: var(--nei-muted); }
.bi-gui-config-val { color: var(--nei-label); }

/* parts display */
.bi-part { display: flex; align-items: center; gap: 6px; padding: 2px 4px; font-size: 10px; }
.bi-part-kind { color: var(--nei-label); font-weight: 500; }
.bi-part-dir { color: var(--nei-muted); font-size: 10px; }
.bi-part-tooltip { color: var(--nei-text-dark); font-style: italic; }
</style>
