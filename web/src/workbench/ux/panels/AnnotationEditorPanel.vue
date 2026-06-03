<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, shallowRef } from 'vue'
import type { Context } from '@/runtime/context'
import type { Annotation } from '@/render/data/annotationTypes'
import { renderTooltipHtml } from '@/pure/renderTooltipHtml'
import UIRenderer from '@/workbench/ux/UIRenderer.vue'
import type { UILayout, UILayoutItem } from '@/workbench/ux/types/layout'

const props = defineProps<{ ctx: Context }>()

const DESC_SAVE_DELAY = 200
const IMMEDIATE_KEYS = new Set(['description', 'id', 'created_at', 'updated_at', 'type'])

const annos = ref<Annotation[]>([])
const rnaOwner = shallowRef<object | null>(null)
const desc = ref('')
const focused = ref(false)

let descTimer: ReturnType<typeof setTimeout> | undefined

function selectedIds(): string[] {
  return annos.value.map(a => a.id)
}

function applyPatch(patch: Record<string, unknown>): void {
  for (const id of selectedIds()) {
    void props.ctx.getOperators().exec('ANNOTATION_UPDATE', { id, patch })
  }
}

function patchProperty(key: string, value: unknown): void {
  if (IMMEDIATE_KEYS.has(key)) return
  const patch: Record<string, unknown> = { [key]: value }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    patch[key] = { ...(value as Record<string, unknown>) }
  }
  applyPatch(patch)
}

function buildRnaOwner(first: Annotation): object {
  return new Proxy(first as object, {
    get(target, key) {
      return (target as Record<string, unknown>)[key as string]
    },
    set(_target, key, value) {
      const k = String(key)
      if (IMMEDIATE_KEYS.has(k) || k === 'description') return true
      patchProperty(k, value)
      return true
    },
  })
}

function load(): void {
  const sel = [...props.ctx.getSelection().items.value].filter(e => e.kind === 'annotation')
  const doc = props.ctx.getDoc().value
  const all = (doc?.annotations ?? []) as Annotation[]
  let found: Annotation[]
  if (sel.length === 0) {
    const hoverId = props.ctx.getHoveredAnnotationId().value
    const hovered = hoverId ? all.find(a => a.id === hoverId) : undefined
    if (!hovered) {
      annos.value = []
      rnaOwner.value = null
      return
    }
    found = [hovered]
  } else {
    found = sel.map(s => all.find(a => a.id === s.id)).filter(Boolean) as Annotation[]
  }
  annos.value = found
  if (found.length === 0) {
    rnaOwner.value = null
    return
  }

  rnaOwner.value = buildRnaOwner(found[0]!)

  if (!focused.value) {
    if (found.length === 1) {
      desc.value = found[0]!.description ?? ''
    } else {
      const firstDesc = found[0]!.description ?? ''
      const same = found.every(a => (a.description ?? '') === firstDesc)
      desc.value = same ? firstDesc : ''
    }
  }
}

watch(
  () => [
    props.ctx.getSelection().items.value,
    props.ctx.getDoc().value,
    props.ctx.getHoveredAnnotationId().value,
  ] as const,
  () => { load() },
  { immediate: true },
)

function onDescInput(e: Event): void {
  desc.value = (e.target as HTMLTextAreaElement).value
  if (descTimer) clearTimeout(descTimer)
  descTimer = setTimeout(() => {
    descTimer = undefined
    applyPatch({ description: desc.value })
  }, DESC_SAVE_DELAY)
}

onBeforeUnmount(() => { if (descTimer) clearTimeout(descTimer) })

const previewHtml = computed(() => renderTooltipHtml(desc.value))

const typeLabel = computed(() => {
  if (annos.value.length === 0) return ''
  const t = annos.value[0]!.type
  const map: Record<string, string> = { box: '包围盒', point: '标记点', line: '线段', text: '文本', face: '选面' }
  const base = map[t] ?? t ?? ''
  return annos.value.length > 1 ? `${base} ×${annos.value.length}` : base
})

const restLayout = computed<UILayout | null>(() => {
  const a = annos.value[0]
  if (!a) return null
  const multi = annos.value.length > 1
  const items: UILayoutItem[] = []

  items.push({
    kind: 'box',
    label: '外观',
    items: [
      { kind: 'property', rnaPath: 'annotation.color', label: '颜色' },
      { kind: 'property', rnaPath: 'annotation.visible', label: '可见' },
      { kind: 'property', rnaPath: 'annotation.locked', label: '锁定' },
    ],
  })

  if (multi) return { kind: 'column', align: false, items }

  switch (a.type) {
    case 'box':
      items.push({ kind: 'separator' })
      items.push({
        kind: 'box',
        label: '包围盒',
        items: [
          { kind: 'property', rnaPath: 'annotation.min', label: '最小坐标' },
          { kind: 'property', rnaPath: 'annotation.max', label: '最大坐标' },
          { kind: 'property', rnaPath: 'annotation.renderStyle', label: '渲染样式' },
          { kind: 'property', rnaPath: 'annotation.renderOpacity', label: '不透明度' },
          { kind: 'property', rnaPath: 'annotation.fillOpacity', label: '填充不透明度' },
          { kind: 'property', rnaPath: 'annotation.frameThickness', label: '边框厚度' },
          { kind: 'property', rnaPath: 'annotation.overlay', label: '覆盖层' },
        ],
      })
      break
    case 'point':
      items.push({ kind: 'separator' })
      items.push({
        kind: 'box',
        label: '位置 & 图标',
        items: [
          { kind: 'property', rnaPath: 'annotation.pos', label: '位置' },
          { kind: 'property', rnaPath: 'annotation.icon', label: '图标' },
          { kind: 'property', rnaPath: 'annotation.size', label: '大小' },
        ],
      })
      break
    case 'line':
      items.push({ kind: 'separator' })
      items.push({
        kind: 'box',
        label: '线段',
        items: [
          { kind: 'property', rnaPath: 'annotation.thickness', label: '粗细' },
          { kind: 'property', rnaPath: 'annotation.arrow', label: '箭头' },
          { kind: 'property', rnaPath: 'annotation.showPoints', label: '显示控制点' },
        ],
      })
      break
    case 'text':
      items.push({ kind: 'separator' })
      items.push({
        kind: 'box',
        label: '文本',
        items: [
          { kind: 'property', rnaPath: 'annotation.anchorPos', label: '锚点位置' },
          { kind: 'property', rnaPath: 'annotation.text', label: '内容' },
          { kind: 'property', rnaPath: 'annotation.fontSize', label: '字号' },
          { kind: 'property', rnaPath: 'annotation.backgroundAlpha', label: '背景透明度' },
        ],
      })
      break
  }

  return { kind: 'column', align: false, items }
})
</script>

<template>
  <div v-if="annos.length > 0" class="anno-editor">
    <div class="anno-editor-header">
      <span class="anno-editor-type">{{ typeLabel }}</span>
    </div>

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
      v-if="restLayout && rnaOwner"
      :layout="restLayout"
      :rna="ctx.getRna()"
      :owner="rnaOwner"
    />

    <hr class="ux-sep" />
    <button
      class="anno-editor-delete"
      @click="annos.forEach(a => ctx.getOperators().invoke('ANNOTATION_DELETE', { id: a.id }))"
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
