<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import type { BContext } from '@/workbench/context/bContext'
import type { BlockRef } from '@/workbench/selectionContext'
import { renderTooltipHtml } from '@/workbench/components/renderTooltipHtml'

const props = defineProps<{ bctx: BContext }>()

const AUTO_SAVE_DELAY = 300

const blockRef = computed<BlockRef | null>(() => {
  const items = [...props.bctx.selection.items.value].filter(e => e.kind === 'block')
  if (items.length !== 1) return null
  return items[0]!.ref
})

const blockName = computed(() => blockRef.value?.block_state_id ?? '(未选中)')

const h = computed(() => {
  const item = blockRef.value
  if (!item) return 0
  const g = props.bctx.doc.value?.frame(0)?.grid
  return g?.height ?? 0
})

const text = ref('')
const focused = ref(false)

function loadValue(): void {
  const item = blockRef.value
  if (!item) { text.value = ''; return }
  const doc = props.bctx.doc.value as Record<string, any> | null
  const grid = doc?.cellTooltipGrid as number[][][] | undefined
  const palette = doc?.tooltipPalette as string[] | undefined
  if (!grid || !palette) { text.value = ''; return }
  const row = h.value > 0 ? h.value - 1 - item.pos.y : item.pos.y
  const idx = grid[item.pos.z]?.[row]?.[item.pos.x]
  if (idx == null || idx < 0 || idx >= palette.length) { text.value = ''; return }
  text.value = palette[idx] ?? ''
}

watch(() => blockRef.value, () => { loadValue() }, { immediate: true })
watch(() => props.bctx.doc.value, () => { if (!focused.value) loadValue() })

let timer: ReturnType<typeof setTimeout> | undefined

function onInput(e: Event): void {
  text.value = (e.target as HTMLTextAreaElement).value
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    const item = blockRef.value
    if (!item) return
    const row = h.value > 0 ? h.value - 1 - item.pos.y : item.pos.y
    props.bctx.operators.invoke('OPERATOR_TOOLTIP_EDIT', {
      text: text.value || '',
      pos: { x: item.pos.x, y: row, z: item.pos.z },
    })
  }, AUTO_SAVE_DELAY)
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

const paletteNameLine = computed(() => {
  const item = blockRef.value
  if (!item) return ''
  const entry = props.bctx.queries.getBlockPaletteEntry(item.pos) as Record<string, any> | null
  const tooltip: string[] | undefined = entry?.tooltip
  if (tooltip && tooltip.length > 0) return tooltip[0]!
  return ''
})

const previewHtml = computed(() => {
  let t = text.value
  if (paletteNameLine.value) {
    const nl = t.indexOf('\n')
    const first = nl >= 0 ? t.slice(0, nl) : t
    if (first !== paletteNameLine.value) {
      t = paletteNameLine.value + '\n' + t
    }
  }
  return renderTooltipHtml(t)
})
</script>

<template>
  <div class="tooltip-editor" v-if="blockRef">
    <div class="tooltip-editor-header">
      <span class="tooltip-editor-block-id">{{ blockName }}</span>
    </div>
    <div class="tooltip-editor-body">
      <textarea
        class="tooltip-editor-textarea"
        :value="text"
        @input="onInput"
        @focus="focused = true"
        @blur="focused = false"
        placeholder="输入 Tooltip 文本（支持 § 颜色码和换行）"
        spellcheck="false"
      />
      <div class="tooltip-editor-preview wm-tooltip-surface wm-tooltip-surface--inline">
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div class="wm-tooltip-body" v-html="previewHtml" />
      </div>
    </div>
  </div>
  <div v-else class="tooltip-editor-empty">
    选中一个方块以编辑 Tooltip
  </div>
</template>

<style scoped>
.tooltip-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tooltip-editor-header {
  display: flex;
  align-items: center;
}
.tooltip-editor-block-id {
  font-size: 13px;
  color: var(--wb-text);
  font-family: var(--wb-font-mono);
  background: var(--wb-bg-surface);
  padding: 2px 8px;
  border-radius: var(--wb-radius-sm);
  border: 1px solid var(--wb-border);
}
.tooltip-editor-body {
  display: flex;
  gap: 8px;
}
.tooltip-editor-textarea {
  flex: 1;
  min-height: 120px;
  padding: 8px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-bg-surface);
  color: var(--wb-text);
  font-size: 13px;
  font-family: var(--wb-font-mono);
  line-height: 1.5;
  resize: vertical;
  outline: none;
  white-space: pre-wrap;
}
.tooltip-editor-textarea:focus {
  border-color: var(--wb-accent);
}
.tooltip-editor-preview {
  flex: 1;
  min-width: 0;
}
.tooltip-editor-empty {
  font-size: 13px;
  color: var(--wb-text-dim);
  padding: 20px 0;
  text-align: center;
}
</style>
