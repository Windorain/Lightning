<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import type { Context } from '@/runtime/context'
import type { BlockRef } from '@/context/selection'
import ContentText from '@/editors/ContentText.vue'
import { getBlockPaletteEntry } from '@/context/queries'

const props = defineProps<{ ctx: Context }>()

const AUTO_SAVE_DELAY = 300

const blockRef = computed<BlockRef | null>(() => {
  const items = [...props.ctx.getSelection().items.value].filter(e => e.kind === 'block')
  if (items.length !== 1) return null
  return items[0]!.ref
})

const blockName = computed(() => blockRef.value?.block_state_id ?? '(未选中)')

const h = computed(() => {
  const item = blockRef.value
  if (!item) return 0
  // #301 P10f D3（R5）：网格读面。帧下标**逐字保留 `0`**（旧实现即 `frame(0)`）。
  return props.ctx.kernelGrid(0)?.height ?? 0
})

const text = ref('')
const focused = ref(false)

function loadValue(): void {
  const item = blockRef.value
  if (!item) { text.value = ''; return }
  // #301 P10f D3（R6）：逐格说明有**自己**的读面（内容键 → 侧表的投影在
  // `runtime/tooltipRead`，与保存投影**同一条**取载荷规则 ⇒ 面板看到的 == 存出来的）。
  const tips = props.ctx.cellTooltips()
  if (!tips) { text.value = ''; return }
  // #80 修复：缺 tooltipPalette 按**空调色板**处理（写入侧会新建），不再把
  // "调色板缺省"当"无说明层"短路——否则面板上写入的内容读不回，表现为"接受了输入"。
  const grid = tips.grid
  const palette = tips.palette
  const row = h.value > 0 ? h.value - 1 - item.pos.y : item.pos.y
  const idx = grid[item.pos.z]?.[row]?.[item.pos.x]
  if (idx == null || idx < 0 || idx >= palette.length) { text.value = ''; return }
  text.value = palette[idx] ?? ''
}

watch(() => blockRef.value, () => { loadValue() }, { immediate: true })
// #301 P10f C′1（N9）：宽信号（内容重读）—— tooltip 侧表可能被原地改。
watch(() => props.ctx.getContentRefreshTick().value, () => { if (!focused.value) loadValue() })

let timer: ReturnType<typeof setTimeout> | undefined

function onInput(e: Event): void {
  text.value = (e.target as HTMLTextAreaElement).value
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    const item = blockRef.value
    if (!item) return
    const row = h.value > 0 ? h.value - 1 - item.pos.y : item.pos.y
    props.ctx.getOperators().invoke('OPERATOR_TOOLTIP_EDIT', {
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
  const entry = getBlockPaletteEntry(props.ctx, item.pos) as Record<string, any> | null
  const tooltip: string[] | undefined = entry?.tooltip
  if (tooltip && tooltip.length > 0) return tooltip[0]!
  return ''
})

/**
 * 预览**文本**（不是 HTML 串）：旧实现在这里调 `renderTooltipHtml` 再 `v-html`。
 * 前置宿主 NEI 名行的既有规则保留；解析交给公共受控边界。
 */
const previewText = computed(() => {
  let t = text.value
  if (paletteNameLine.value) {
    const nl = t.indexOf('\n')
    const first = nl >= 0 ? t.slice(0, nl) : t
    if (first !== paletteNameLine.value) {
      t = paletteNameLine.value + '\n' + t
    }
  }
  return t
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
        <!--
          外部文本（工具tip 草稿）经受控呈现边界；无 `v-html`。
          （#259 A32 退役项：本文件原为 6 条 `v-html` 直通路径之一。）
        -->
        <ContentText class="wm-tooltip-body" :text="previewText" mode="mc" />
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
