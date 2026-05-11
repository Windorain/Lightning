<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { renderTooltipHtml } from './renderTooltipHtml'
import { useSceneContext } from '@/workbench/sceneContext'
import { isWorldDocument, resolveRenderBundle } from '@/render/data/bundleResolve'
import { findBlockPaletteEntryByBlockId } from '@/render/data/blockRegistryResolve'
import { autoTooltipFromNbt } from '@/workbench/nbtTooltipTemplate'
import type { BlockPaletteEntry, RenderBundle } from '@/render/schema/types'

const ctx = useSceneContext()
const selectedBlock = computed(() => ctx.selectedBlock.value)
const tooltipText = ref('')
const saveFeedback = ref('')

const paletteEntry = computed<BlockPaletteEntry | null>(() => {
  if (!selectedBlock.value) return null
  const doc = ctx.scene.value
  if (!doc) return null
  try {
    const frameIdx = isWorldDocument(doc) ? ctx.previewWorldFrameIndex.value : undefined
    const { definition } = resolveRenderBundle({ document: doc } as RenderBundle, frameIdx)
    return findBlockPaletteEntryByBlockId(definition, selectedBlock.value.blockId) ?? null
  } catch { return null }
})

function autoFillFromNbt(): void {
  if (!paletteEntry.value?.nbt) return
  tooltipText.value = autoTooltipFromNbt(paletteEntry.value.nbt)
}

function readCurrentTooltip(): string {
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
      const fIdx = ((raw % n) + n) % n
      ttg = ((frames[fIdx] as Record<string, unknown>)?.structure as Record<string, unknown> | undefined)?.cellTooltipGrid
    }
  } else {
    tp = doc.tooltipPalette
    ttg = doc.cellTooltipGrid
  }
  if (!Array.isArray(tp) || tp.length === 0) return ''
  if (!Array.isArray(ttg)) return ''
  const zArr = ttg[zSlice]; if (!Array.isArray(zArr)) return ''
  const rArr = zArr[row]; if (!Array.isArray(rArr)) return ''
  const palIdx = rArr[column]
  if (typeof palIdx !== 'number' || palIdx < 0) return ''
  return String(tp[palIdx] ?? '')
}

function buildEmptyTooltipGrid(doc: Record<string, unknown>): number[][][] {
  const cg = doc.cellGrid
  if (!Array.isArray(cg) || cg.length === 0) return []
  const grid: number[][][] = []
  for (const zArr of cg) {
    if (!Array.isArray(zArr)) continue
    const rows: number[][] = []
    for (const rArr of zArr) {
      if (!Array.isArray(rArr)) continue
      rows.push(new Array(rArr.length).fill(-1))
    }
    grid.push(rows)
  }
  return grid
}

function setPaletteAndGrid(doc: Record<string, unknown>, z: number, r: number, c: number, text: string): void {
  if (isWorldDocument(doc)) {
    if (!Array.isArray(doc.tooltipPalette)) doc.tooltipPalette = []
    const tp = doc.tooltipPalette as string[]
    let idx = tp.indexOf(text)
    if (idx === -1 && text) { idx = tp.length; tp.push(text) }
    const frames = doc.frames
    if (Array.isArray(frames) && frames.length > 0) {
      const n = frames.length
      const raw = Math.floor(ctx.previewWorldFrameIndex.value)
      const fIdx = ((raw % n) + n) % n
      const st = (frames[fIdx] as Record<string, unknown>)?.structure as Record<string, unknown> | undefined
      if (st) {
        if (!Array.isArray(st.cellTooltipGrid)) st.cellTooltipGrid = buildEmptyTooltipGrid(st)
        const ttg = st.cellTooltipGrid as number[][][]
        if (ttg[z] && ttg[z][r]) ttg[z][r][c] = text ? idx : -1
      }
    }
  } else {
    if (!Array.isArray(doc.tooltipPalette)) doc.tooltipPalette = []
    const tp = doc.tooltipPalette as string[]
    let idx = tp.indexOf(text)
    if (idx === -1 && text) { idx = tp.length; tp.push(text) }
    if (!Array.isArray(doc.cellTooltipGrid)) doc.cellTooltipGrid = buildEmptyTooltipGrid(doc)
    const ttg = doc.cellTooltipGrid as number[][][]
    if (ttg[z] && ttg[z][r]) ttg[z][r][c] = text ? idx : -1
  }
}

async function saveTooltip(): Promise<void> {
  const doc = ctx.scene.value
  if (!doc || !selectedBlock.value?.voxel) return
  const { zSlice, row, column } = selectedBlock.value.voxel
  try {
    setPaletteAndGrid(doc, zSlice, row, column, tooltipText.value)
    ctx.markDirty()
    void ctx.syncPreview()
    saveFeedback.value = '已保存'
  } catch (e) {
    saveFeedback.value = e instanceof Error ? e.message : String(e)
  }
}

const previewHtml = computed(() => tooltipText.value ? renderTooltipHtml(tooltipText.value) : '')

watch(
  () => [selectedBlock.value, ctx.previewWorldFrameIndex.value] as const,
  () => { tooltipText.value = selectedBlock.value ? readCurrentTooltip() : '' },
  { immediate: true },
)
</script>

<template>
  <div class="pe-panel">
    <div class="pe-title">Tooltip 编辑</div>
    <template v-if="!selectedBlock">
      <p class="pe-muted">请在 3D 视口选取方块</p>
    </template>
    <template v-else>
      <div class="te-info">
        <span class="te-info-label">编辑:</span>
        <span class="te-info-val">{{ selectedBlock.blockId }}</span>
      </div>
      <div class="te-row">
        <div class="te-col">
          <span class="te-label">编辑</span>
          <textarea v-model="tooltipText" class="te-textarea" rows="6" placeholder="Markdown + §aMC颜色码" />
        </div>
        <div class="te-col">
          <span class="te-label">预览</span>
          <div class="wm-tooltip-surface wm-tooltip-surface--inline te-tooltip-preview-min">
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div v-if="previewHtml" class="wm-tooltip-body" v-html="previewHtml" />
            <div v-else class="wm-tooltip-body te-preview-empty">（空）</div>
          </div>
        </div>
      </div>
      <div class="te-btns">
        <button v-if="paletteEntry?.nbt" class="pe-btn" @click="autoFillFromNbt">从 NBT 生成</button>
        <button class="pe-btn pe-btn--primary" @click="void saveTooltip()">保存</button>
        <button class="pe-btn" @click="tooltipText = ''">清除</button>
      </div>
      <p v-if="saveFeedback" class="pe-feedback">{{ saveFeedback }}</p>
    </template>
  </div>
</template>

<style scoped>
.pe-panel { padding: 10px; font-size: 12px; }
.pe-title { font-size: 13px; font-weight: 600; color: var(--nei-text); text-shadow: var(--nei-label-shadow); margin-bottom: 8px; }
.pe-muted { font-size: 11px; color: var(--nei-muted); }
.te-info { margin-bottom: 8px; display: flex; gap: 6px; align-items: center; }
.te-info-label { font-size: 10px; color: var(--nei-muted); text-transform: uppercase; }
.te-info-val { font-family: ui-monospace, monospace; font-size: 12px; color: var(--nei-text-dark); background: var(--nei-bg); padding: 2px 6px; border: 1px solid var(--nei-border); }
.te-row { display: flex; gap: 8px; margin-bottom: 8px; }
.te-col { flex: 1; min-width: 0; }
.te-label { display: block; font-size: 10px; color: var(--nei-label); text-transform: uppercase; margin-bottom: 3px; }
.te-textarea {
  width: 100%; padding: 6px; border-radius: 4px; border: var(--nei-bevel-w) solid;
  border-color: var(--nei-shadow) var(--nei-highlight) var(--nei-highlight) var(--nei-shadow);
  background: var(--nei-inset-bg); color: var(--nei-text); font-size: 12px;
  font-family: ui-monospace, monospace; resize: vertical; box-sizing: border-box;
}
.te-tooltip-preview-min { min-height: 60px; }
.te-preview-empty { opacity: 0.65; font-style: italic; }
.te-btns { display: flex; gap: 6px; }
.pe-btn {
  padding: 4px 10px; border-radius: 4px; border: var(--nei-bevel-w) solid;
  border-color: var(--nei-highlight) var(--nei-shadow) var(--nei-shadow) var(--nei-highlight);
  background: var(--nei-btn-bg); color: var(--nei-btn-text); cursor: pointer; font-size: 11px;
}
.pe-btn--primary {
  background: var(--nei-accent); border-color: var(--nei-accent-shadow);
  color: var(--nei-accent-text); text-shadow: var(--nei-accent-shadow);
}
.pe-feedback { margin-top: 6px; font-size: 11px; color: var(--nei-muted); }
</style>
