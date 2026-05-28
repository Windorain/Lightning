<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import type { BContext } from '@/workbench/context/bContext'
import type { Annotation } from '@/render/data/annotationTypes'
import { renderTooltipHtml } from '@/workbench/components/renderTooltipHtml'
import UIRenderer from '@/workbench/ux/UIRenderer.vue'
import type { UILayout } from '@/workbench/ux/types/layout'

const props = defineProps<{ bctx: BContext }>()

const AUTO_SAVE_DELAY = 200

const anno = ref<Annotation | null>(null)
const proxyOwner = ref<Record<string, any> | null>(null)
const desc = ref('')
const focused = ref(false)

let timer: ReturnType<typeof setTimeout> | undefined

function createOwner(raw: Annotation): Record<string, any> {
  const target = raw as Record<string, any>
  return new Proxy(target, {
    set(_t, prop, value) {
      target[prop as string] = value
      if (prop === 'id' || prop === 'created_at' || prop === 'updated_at') return true
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        props.bctx.operators.invoke('ANNOTATION_UPDATE', { id: target.id, patch: { ...target } })
      }, AUTO_SAVE_DELAY)
      return true
    },
  })
}

function load(): void {
  const active = props.bctx.selection.active.value
  if (typeof active !== 'string') {
    anno.value = null
    proxyOwner.value = null
    return
  }
  const doc = props.bctx.doc.value as Record<string, any> | null
  const annos = doc?.annotations as Annotation[] | undefined
  const found = annos?.find(a => a.id === active) ?? null
  anno.value = found
  proxyOwner.value = found ? createOwner(found) : null
  if (!focused.value) {
    desc.value = (found as Record<string, any>)?.description ?? ''
  }
}

watch(
  () => [props.bctx.selection.active.value, props.bctx.doc.value] as const,
  () => { load() },
  { immediate: true },
)

function onDescInput(e: Event): void {
  desc.value = (e.target as HTMLTextAreaElement).value
  // Write through proxy owner so auto-save batches with other field changes
  if (proxyOwner.value) proxyOwner.value.description = desc.value
}

onBeforeUnmount(() => { if (timer) clearTimeout(timer) })

const previewHtml = computed(() => renderTooltipHtml(desc.value))

const typeLabel = computed(() => {
  const t = (anno.value as Record<string, any> | null)?.type as string
  const map: Record<string, string> = { box: '包围盒', point: '标记点', line: '线段', text: '文本', face: '选面' }
  return map[t] ?? t ?? ''
})

// Build the rest of the layout (exclude title/description which we render custom)
const restLayout = computed<UILayout | null>(() => {
  const a = anno.value as Record<string, any> | null
  if (!a) return null
  const t = a.type as string
  const items: any[] = []

  // Appearance
  items.push({
    kind: 'box' as const, label: '外观',
    items: [
      { kind: 'property' as const, rnaPath: 'annotation.color', label: '颜色' },
      { kind: 'property' as const, rnaPath: 'annotation.visible', label: '可见' },
      { kind: 'property' as const, rnaPath: 'annotation.locked', label: '锁定' },
    ],
  })

  // Type-specific
  switch (t) {
    case 'box':
      items.push({ kind: 'separator' as const })
      items.push({
        kind: 'box' as const, label: '包围盒',
        items: [
          { kind: 'property' as const, rnaPath: 'annotation.min', label: '最小坐标' },
          { kind: 'property' as const, rnaPath: 'annotation.max', label: '最大坐标' },
          { kind: 'property' as const, rnaPath: 'annotation.renderStyle', label: '渲染样式' },
          { kind: 'property' as const, rnaPath: 'annotation.renderOpacity', label: '不透明度' },
          { kind: 'property' as const, rnaPath: 'annotation.fillOpacity', label: '填充不透明度' },
          { kind: 'property' as const, rnaPath: 'annotation.frameThickness', label: '边框厚度' },
          { kind: 'property' as const, rnaPath: 'annotation.overlay', label: '覆盖层' },
        ],
      })
      break
    case 'point':
      items.push({ kind: 'separator' as const })
      items.push({
        kind: 'box' as const, label: '位置 & 图标',
        items: [
          { kind: 'property' as const, rnaPath: 'annotation.pos', label: '位置' },
          { kind: 'property' as const, rnaPath: 'annotation.icon', label: '图标' },
          { kind: 'property' as const, rnaPath: 'annotation.size', label: '大小' },
        ],
      })
      break
    case 'line':
      items.push({ kind: 'separator' as const })
      items.push({
        kind: 'box' as const, label: '线段',
        items: [
          { kind: 'property' as const, rnaPath: 'annotation.thickness', label: '粗细' },
          { kind: 'property' as const, rnaPath: 'annotation.arrow', label: '箭头' },
          { kind: 'property' as const, rnaPath: 'annotation.showPoints', label: '显示控制点' },
        ],
      })
      break
    case 'text':
      items.push({ kind: 'separator' as const })
      items.push({
        kind: 'box' as const, label: '文本',
        items: [
          { kind: 'property' as const, rnaPath: 'annotation.anchorPos', label: '锚点位置' },
          { kind: 'property' as const, rnaPath: 'annotation.text', label: '内容' },
          { kind: 'property' as const, rnaPath: 'annotation.fontSize', label: '字号' },
          { kind: 'property' as const, rnaPath: 'annotation.backgroundAlpha', label: '背景透明度' },
        ],
      })
      break
  }

  return { kind: 'column' as const, align: false, items }
})
</script>

<template>
  <div v-if="anno" class="anno-editor">
    <div class="anno-editor-header">
      <span class="anno-editor-type">{{ typeLabel }}</span>
    </div>

    <!-- Annotation info: description -->
    <div class="ux-box">
      <label class="ux-box-label">注解信息</label>
      <div class="anno-editor-desc">
        <textarea
          class="anno-editor-textarea"
          :value="desc"
          @input="onDescInput"
          @focus="focused = true"
          @blur="focused = false"
          placeholder="描述（支持 § 颜色码和换行）"
          spellcheck="false"
        />
        <div class="anno-editor-preview wm-tooltip-surface wm-tooltip-surface--inline">
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div class="wm-tooltip-body" v-html="previewHtml" />
        </div>
      </div>
    </div>

    <UIRenderer
      v-if="restLayout"
      :layout="restLayout"
      :rna="bctx.rna"
      :owner="proxyOwner"
    />

    <hr class="ux-sep" />
    <button
      class="anno-editor-delete"
      @click="bctx.operators.invoke('ANNOTATION_DELETE', { id: (anno as Record<string, any>).id })"
    >删除注解</button>
  </div>
  <div v-else class="tooltip-editor-empty">
    选中一个注解以编辑
  </div>
</template>

<style scoped>
.anno-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.anno-editor-header {
  display: flex;
  align-items: center;
}
.anno-editor-type {
  font-size: 13px;
  color: var(--wb-text);
  font-family: var(--wb-font-mono);
  background: var(--wb-bg-surface);
  padding: 2px 8px;
  border-radius: var(--wb-radius-sm);
  border: 1px solid var(--wb-border);
}
.anno-editor-desc {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.anno-editor-textarea {
  flex: 1;
  min-height: 100px;
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
.anno-editor-textarea:focus {
  border-color: var(--wb-accent);
}
.anno-editor-preview {
  flex: 1;
  min-width: 0;
}
.anno-editor-delete {
  padding: 6px 12px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-bg-surface);
  color: #f87171;
  font-size: 13px;
  cursor: pointer;
}
.anno-editor-delete:hover {
  background: rgba(248, 113, 113, 0.1);
  border-color: #f87171;
}
.tooltip-editor-empty {
  font-size: 13px;
  color: var(--wb-text-dim);
  padding: 20px 0;
  text-align: center;
}
</style>

<!-- Global styles for ux-box/ux-box-label within this component -->
<style>
.ux-box {
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  padding: 10px;
  margin: 4px 0;
  background: var(--wb-bg-surface);
}
.ux-box-label {
  display: block;
  font-size: 10px;
  font-weight: 600;
  color: var(--wb-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.8px;
  margin-bottom: 6px;
}
.ux-sep {
  border: none;
  border-top: 1px solid transparent;
  background: linear-gradient(90deg, var(--wb-border), transparent);
  height: 1px;
  margin: 6px 0;
}
</style>
