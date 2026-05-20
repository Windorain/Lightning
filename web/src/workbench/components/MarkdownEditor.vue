<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useBContext } from '@/workbench/context/bContext'
import { renderTooltipHtml } from './renderTooltipHtml'
import { copyTextToClipboard } from '@/util/browser'
import { useSelectionContext } from '@/workbench/selectionContext'
import { isWorldDocument, loadStructureOrWorld } from '@/render/data/bundleResolve'
import type { BlockPaletteEntry } from '@/render/schema/types'

const bctx = useBContext()
const selection = useSelectionContext()
const selectedBlock = computed(() => {
  if (selection.items.value.size === 0) return null
  const first = selection.items.value.values().next().value
  if (!first) return null
  const grid = bctx.scene.scene.value?.frame(0)?.grid
  return {
    blockId: first.block_state_id,
    voxel: {
      column: first.pos.x,
      row: grid ? grid.height - 1 - first.pos.y : first.pos.y,
      zSlice: first.pos.z,
    },
  }
})
const markdownText = ref('')
const saveFeedback = ref('')
const nbtPanelOpen = ref(true)

const paletteEntry = computed<BlockPaletteEntry | null>(() => {
  if (!selectedBlock.value) return null
  const doc = bctx.scene.scene.value?.toRaw()
  if (!doc) return null
  try {
    const def = loadStructureOrWorld(doc, undefined)
    return def.blockPalette.find(e => e.registryId === selectedBlock.value!.blockId) ?? null
  } catch { return null }
})

const nbtEntries = computed<Array<[string, unknown]>>(() => {
  if (!paletteEntry.value?.nbt) return []
  return Object.entries(paletteEntry.value.nbt)
})

function readCurrentTooltip(): string {
  const doc = bctx.scene.scene.value?.toRaw()
  if (!doc || !selectedBlock.value?.voxel) return ''
  const { zSlice, row, column } = selectedBlock.value.voxel
  let tp: unknown, ttg: unknown
  if (isWorldDocument(doc)) {
    tp = doc.tooltipPalette
    const frames = doc.frames
    if (Array.isArray(frames) && frames.length > 0) {
      ttg = ((frames[0] as Record<string, unknown>)?.structure as Record<string, unknown> | undefined)?.cellTooltipGrid
    }
  } else {
    tp = doc.tooltipPalette
    ttg = doc.cellTooltipGrid
  }
  if (!Array.isArray(tp) || tp.length === 0) return ''
  if (!Array.isArray(ttg)) return ''
  const zArr = ttg[zSlice]; if (!Array.isArray(zArr)) return ''
  const rArr = zArr[row]; if (!Array.isArray(rArr)) return ''
  const idx = rArr[column]
  if (typeof idx !== 'number' || idx < 0) return ''
  return String(tp[idx] ?? '')
}

function insertNbtKey(key: string, value: unknown): void {
  const valStr = typeof value === 'object' ? JSON.stringify(value) : String(value)
  const insertion = `${key}=${valStr}`
  markdownText.value += (markdownText.value ? '\n' : '') + insertion
}

function copyNbtValue(value: unknown): void {
  const valStr = typeof value === 'object' ? JSON.stringify(value) : String(value)
  copyTextToClipboard(valStr)
}

function copyAllNbtJson(): void {
  if (!paletteEntry.value?.nbt) return
  copyTextToClipboard(JSON.stringify(paletteEntry.value.nbt, null, 2))
}

async function saveTooltip(): Promise<void> {
  const block = selectedBlock.value
  if (!block) return
  bctx.operators.exec('OPERATOR_TOOLTIP_EDIT', {
    text: markdownText.value,
    pos: block.voxel,
  })
  void bctx.operators.exec('OPERATOR_SYNC_PREVIEW')
  saveFeedback.value = '已保存'
}

const previewHtml = computed(() => markdownText.value ? renderTooltipHtml(markdownText.value) : '')

watch(selectedBlock, () => { markdownText.value = selectedBlock.value ? readCurrentTooltip() : '' }, { immediate: true })
</script>

<template>
  <div class="pe-panel">
    <div class="pe-title">Markdown 编辑</div>
    <template v-if="!selectedBlock">
      <p class="pe-muted">请在 3D 视口选取方块</p>
    </template>
    <template v-else>
      <div class="me-info">
        <span class="me-info-label">编辑:</span>
        <span class="me-info-val">{{ selectedBlock.blockId }}</span>
      </div>

      <div class="me-row">
        <div class="me-col">
          <span class="me-label">编辑</span>
          <textarea v-model="markdownText" class="me-textarea" rows="8" placeholder="支持 Markdown 语法和 §aMC 颜色码" />
        </div>
        <div class="me-col">
          <span class="me-label">预览</span>
          <div class="me-preview" v-html="previewHtml" />
        </div>
      </div>

      <div class="me-nbt-section">
        <div class="me-nbt-header" @click="nbtPanelOpen = !nbtPanelOpen">
          <span class="me-nbt-toggle">{{ nbtPanelOpen ? '▾' : '▸' }}</span>
          <span class="me-nbt-title">NBT 变量</span>
          <span v-if="nbtEntries.length" class="me-nbt-count">{{ nbtEntries.length }}</span>
        </div>
        <div v-if="nbtPanelOpen" class="me-nbt-body">
          <template v-if="nbtEntries.length">
            <div class="me-nbt-actions">
              <button class="pe-btn" @click="copyAllNbtJson">复制全部 NBT JSON</button>
            </div>
            <div class="me-nbt-list">
              <div v-for="[key, value] in nbtEntries" :key="key" class="me-nbt-row">
                <span class="me-nbt-key" @click="insertNbtKey(key, value)" :title="'点击插入: ' + key + '=' + String(value)">{{ key }}</span>
                <span class="me-nbt-val">{{ typeof value === 'object' ? JSON.stringify(value) : String(value) }}</span>
                <button class="me-nbt-copy" @click="copyNbtValue(value)" title="复制值">复制</button>
              </div>
            </div>
          </template>
          <p v-else class="pe-muted">无 NBT 数据</p>
        </div>
      </div>

      <div class="me-btns">
        <button class="pe-btn pe-btn--primary" @click="void saveTooltip()">保存</button>
        <button class="pe-btn" @click="markdownText = ''">清除</button>
      </div>
      <p v-if="saveFeedback" class="pe-feedback">{{ saveFeedback }}</p>
    </template>
  </div>
</template>

<style scoped>
.pe-panel { padding: 10px; font-size: 12px; }
.pe-title { font-size: 13px; font-weight: 600; color: var(--wb-text); margin-bottom: 8px; }
.pe-muted { font-size: 11px; color: var(--wb-text-dim); }
.pe-btn {
  padding: 4px 10px; border-radius: 4px; border: 1px solid var(--wb-border);
  background: var(--wb-bg-surface); color: var(--wb-accent-muted); cursor: pointer; font-size: 11px;
}
.pe-btn--primary {
  background: var(--wb-accent); border-color: var(--wb-accent);
  color: var(--wb-text);
}
.pe-feedback { margin-top: 6px; font-size: 11px; color: var(--wb-text-dim); }

.me-info { margin-bottom: 8px; display: flex; gap: 6px; align-items: center; }
.me-info-label { font-size: 10px; color: var(--wb-text-dim); text-transform: uppercase; }
.me-info-val { font-family: ui-monospace, monospace; font-size: 12px; color: var(--wb-text); background: var(--wb-bg-elevated); padding: 2px 6px; border: 1px solid var(--wb-border); }

.me-row { display: flex; gap: 8px; margin-bottom: 8px; }
.me-col { flex: 1; min-width: 0; }
.me-label { display: block; font-size: 10px; color: var(--wb-text-muted); text-transform: uppercase; margin-bottom: 3px; }

.me-textarea {
  width: 100%; padding: 6px; border-radius: 4px; border: 1px solid var(--wb-border);
  background: var(--wb-bg-surface); color: var(--wb-text); font-size: 12px;
  font-family: ui-monospace, monospace; resize: vertical; box-sizing: border-box;
}

.me-preview {
  padding: 6px; border-radius: 4px; border: 1px solid var(--wb-border);
  background: var(--wb-bg-surface); min-height: 60px; font-size: 12px; color: var(--wb-text); word-break: break-word;
}
.me-preview :deep(strong) { font-weight: 700; }
.me-preview :deep(em) { font-style: italic; }
.me-preview :deep(code) { font-family: ui-monospace, monospace; background: rgba(0,0,0,0.2); padding: 1px 3px; border-radius: 2px; }
.me-preview :deep(span) { color: inherit; }

.me-nbt-section { margin-bottom: 8px; border: 1px solid var(--wb-border); border-radius: 4px; }
.me-nbt-header {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px; cursor: pointer; user-select: none;
  background: var(--wb-bg-elevated);
}
.me-nbt-toggle { font-size: 10px; color: var(--wb-text-muted); }
.me-nbt-title { font-size: 11px; font-weight: 600; color: var(--wb-text); }
.me-nbt-count {
  font-size: 10px; color: var(--wb-text-dim);
  background: var(--wb-bg-surface); padding: 0 5px; border-radius: 8px;
  margin-left: auto;
}
.me-nbt-body { padding: 6px 8px; border-top: 1px solid var(--wb-border); }
.me-nbt-actions { margin-bottom: 4px; }
.me-nbt-list { max-height: 200px; overflow-y: auto; }
.me-nbt-row {
  display: flex; align-items: center; gap: 4px; padding: 2px 0;
  font-size: 11px; font-family: ui-monospace, monospace;
}
.me-nbt-key {
  color: var(--wb-accent); cursor: pointer; white-space: nowrap;
  flex-shrink: 0;
}
.me-nbt-key:hover { text-decoration: underline; }
.me-nbt-val {
  color: var(--wb-text); overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; flex: 1; min-width: 0;
}
.me-nbt-copy {
  font-size: 10px; padding: 1px 6px; border-radius: 3px;
  border: 1px solid var(--wb-border);
  background: var(--wb-bg-surface); color: var(--wb-accent-muted); cursor: pointer;
  flex-shrink: 0;
}
.me-nbt-copy:hover { background: var(--wb-accent); color: var(--wb-text); }

.me-btns { display: flex; gap: 6px; }
</style>
