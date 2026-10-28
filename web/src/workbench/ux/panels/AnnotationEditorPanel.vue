<script setup lang="ts">
/**
 * **注解属性**面板。
 *
 * 依据：基础 Inspector 由属性描述生成；草稿与提交分离；唯一写路由。
 *
 * ## 退役 #3：本文件原来的三样东西都删了
 *
 *  1. **`buildRnaOwner()` 的 `Proxy`**（原 40–54 行）：一个 `set` 陷阱把赋值转成
 *     `ANNOTATION_UPDATE`。那是**旁路写入的隐式形式** —— 赋值语法触发写命令，
 *     静态上无法列出「谁写了什么」，且它绕过了 RNA 的合法性/可编辑性判定。
 *  2. **手写 `restLayout`**（原 20 条 `kind: 'property'`）：每条都要人记得加，
 *     且 `annotation.description` 干脆不走 RNA（自建 `textarea` + 200ms debounce）。
 *  3. **`IMMEDIATE_KEYS` 过滤**：`description`/`id`/`created_at`/`updated_at`/`type`
 *     在 Proxy 里被静默 `return true`（即「写成功」但不做任何事）——
 *     用户改了没反应且**没有任何提示**。
 *
 * 现在：属性由 `lightning.annotation.*` 声明生成（`PropertyInspector`），
 * 写入经唯一写路由；只读属性由 `evaluateEditability` 给出**结构化原因**并显示，
 * 不再是「静默吞掉」。本文件只保留注解面板**特有**的两件事：
 *  - 描述字段的 tooltip 富文本预览（呈现功能，不是写面）；
 *  - 「删除注解」具名命令（删除不是字段写入）。
 */

import { computed, ref, watch } from 'vue'
import type { Context } from '@/runtime/context'
import type { Annotation } from '@/render/data/annotationTypes'
import ContentText from '@/editors/ContentText.vue'
import PropertyInspector from '@/workbench/ux/PropertyInspector.vue'

const props = defineProps<{ ctx: Context }>()

const annos = ref<Annotation[]>([])

function load(): void {
  const sel = [...props.ctx.getSelection().items.value].filter(e => e.kind === 'annotation')
  // 注解表走内核注解读面（`KernelAnnotationView`）。
  // ⚠️ 面板的 `Annotation` 类型比读面**宽**（含 `renderOpacity`/`fontSize` 等 legacy
  // 专有字段）⇒ 两跳断言（`as unknown as`）是刻意的：读面给的是**它承载的那一份**，
  // 未承载字段在面板上表现为 `undefined`（不显示），而**不是**被伪造一个默认值。
  // 该收窄登记在 `composition/seams.ts` 的 `annotation-wide-field-face`。
  const all = props.ctx.kernelAnnotations() as unknown as Annotation[]
  if (sel.length === 0) {
    const hoverId = props.ctx.getHoveredAnnotationId().value
    const hovered = hoverId ? all.find(a => a.id === hoverId) : undefined
    annos.value = hovered ? [hovered] : []
    return
  }
  annos.value = sel.map(s => all.find(a => a.id === s.id)).filter(Boolean) as Annotation[]
}

watch(
  () => [
    props.ctx.getSelection().items.value,
    // 宽信号（内容重读）。
    props.ctx.getContentRefreshTick().value,
    props.ctx.getContentRefreshTick().value,
    props.ctx.getHoveredAnnotationId().value,
  ] as const,
  () => {
    load()
  },
  { immediate: true },
)

/**
 * 描述预览文本：读**已提交**的描述（不是本地草稿）。
 *
 * 旧实现里预览用本地 `desc` 而写入走 200ms debounce，于是「预览已经变了但文档还没变」
 * 是个用户可见的不一致窗口。现在预览跟随文档（提交后立即一致），
 * 草稿态由 `PropertyField` 自己管理。
 *
 * 呈现侧：只算出**要呈现的文本**，解析交给公共受控边界（`ContentText`）——
 * 不再产 HTML 串再 `v-html`（退役项：本文件原为 6 条直通路径之一；
 * 旧的 `pure/renderTooltipHtml.ts` 已删除）。
 * 于是注解预览与 Tooltip 框、Tooltip 编辑预览走同一条规则。
 */
const previewText = computed(() => annos.value[0]?.description ?? '')

const typeLabel = computed(() => {
  if (annos.value.length === 0) return ''
  const t = annos.value[0]!.type
  const map: Record<string, string> = { box: '包围盒', point: '标记点', line: '线段', text: '文本', face: '选面' }
  const base = map[t] ?? t ?? ''
  return annos.value.length > 1 ? `${base} ×${annos.value.length}` : base
})

/** 删除是**具名命令**（不是字段写入）—— 故不经属性面板。 */
function deleteSelected(): void {
  for (const a of annos.value) void props.ctx.getOperators().invoke('ANNOTATION_DELETE', { id: a.id })
}
</script>

<template>
  <div v-if="annos.length > 0" class="anno-editor">
    <div class="anno-editor-header">
      <span class="anno-editor-type">{{ typeLabel }}</span>
    </div>

    <!--
      描述预览（呈现功能；描述本身是 RNA 属性，由下方属性面板渲染与提交）。
      外部文本（注解描述）经受控呈现边界；**无 `v-html`**。
      （退役项：本文件原为 6 条 `v-html` 直通路径之一。）
    -->
    <div class="anno-editor-preview wm-tooltip-surface wm-tooltip-surface--inline">
      <ContentText class="wm-tooltip-body" :text="previewText" mode="mc" />
    </div>

    <!-- 全部注解属性（含 description）：生成式，写入经唯一写路由 -->
    <PropertyInspector :ctx="ctx" title="注解属性" />

    <hr class="ux-sep" />
    <button class="anno-editor-delete" @click="deleteSelected">删除注解</button>
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
.anno-editor-preview {
  min-width: 0;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  padding: 8px;
  background: var(--wb-bg-surface);
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
.ux-sep {
  border: none;
  border-top: 1px solid transparent;
  background: linear-gradient(90deg, var(--wb-border), transparent);
  height: 1px;
  margin: 6px 0;
}
</style>
