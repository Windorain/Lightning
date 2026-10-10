<script setup lang="ts">
/**
 * #253 P2 · **属性字段控件**（受控读面 + 单一写路由的呈现端）。
 *
 * 依据：契约 §5.1/§5.2；#249 §2.1（接线层只协调，政策不藏进回调）、
 * §6（描述里不得有控件名 ⇒ 反向：控件依赖描述）、§19.1（显示值/编辑草稿/可提交值分离）。
 *
 * ## 这个组件替代了什么（退役 #3）
 *
 * 旧 `RNAWidget.vue` 一个文件里混了四件事，三件是**业务政策**：
 *  1. 按 `rnaPath` 的**字符串前缀**（`wikiconfig.` / `toolsettings.`）选写入通道；
 *  2. 直接 `descriptor.set(owner, val)` 写内存对象（无 clone / undo / 版本）；
 *  3. 自己 `inferWidget()` 猜控件、按 `range/100` 猜「友好步长」；
 *  4. 每敲一字符提交一次（20 字 = 20 条 undo），两处 debounce 各自实现，卸载只清定时器不 flush（丢字）。
 *
 * 新形态里四件事各有唯一归属：
 *  1. 前缀分派**不存在** —— 属性 ID 是 `lightning.publishConfig.viewWidth`，
 *     写入按键值注册的纯函数执行；
 *  2/4. 提交时机与草稿是 `editors/property-controls.ts` 的纯状态机；
 *  3. 控件选择是 `modelFor(desc)`，与描述同源（本组件只读 `field.control`）。
 *
 * ## 本组件不认识「写到哪里」
 *
 * 它**不接收 setter 闭包**，也不认识 `Context`/文档/命令。它只发三个**意图**：
 * `update:draft`（草稿变了）、`commit`（请提交当前草稿）、`cancel`（还原）。
 * 合法性判定与提交由父级用纯函数完成（`canCommitDraft` / `tryCommit`），
 * 因此「拒绝后不得报告 applied」在 UI 层无法被绕过 —— 组件根本没有写的能力。
 *
 * 这是契约 §5.2「唯一写路由」在组件层的**结构性**形态：不是靠约定不写旁路，
 * 而是这里没有可用的旁路。
 */

import { computed, ref, watch } from 'vue'
import type { FieldViewModel } from '@/editors/property-controls'

const props = defineProps<{ field: FieldViewModel }>()

const emit = defineEmits<{
  /** 草稿文本变化（**不**提交）。 */
  (e: 'update:draft', text: string): void
  /** 请求提交当前草稿（是否可提交由父级按 `draftState` 判定）。 */
  (e: 'commit'): void
  /** 请求提交一个**已解析**的值（boolean/枚举/滑块/色板/分量这些无草稿的控件）。 */
  (e: 'commit-value', value: unknown): void
  /** 请求提交某个向量分量（`component` 寻址）。 */
  (e: 'commit-component', index: number, value: number): void
  /** 还原草稿（Escape）。 */
  (e: 'cancel'): void
}>()

const focused = ref(false)

const kind = computed(() => props.field.control.kind)
const isMixed = computed(() => props.field.value.kind === 'mixed')
const isReadOnly = computed(() => props.field.edit.kind === 'readOnly')
/** 只读原因（结构化，不是布尔）—— 呈现端只做展示，不重新判定。 */
const readOnlyReason = computed(() => (props.field.edit.kind === 'readOnly' ? props.field.edit.reason : null))

/** 已解析值是否可直接用于受控控件的 `value` 绑定。 */
const scalarValue = computed<string | number | boolean>(() => {
  const v = props.field.value
  if (v.kind !== 'value') return ''
  const raw = v.value
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'string') return raw
  return ''
})

/** 草稿文本（编辑中优先，否则是展示文本）。 */
const textValue = computed(() => props.field.draft ?? props.field.displayText)

/** 非法草稿必须有可见提示（不静默吞输入）；拒绝原因同样可见。 */
const problemText = computed(() => {
  if (props.field.draftState.state === 'invalid') {
    const e = props.field.draftState.error
    const r = e.params.reason
    return r === undefined ? e.code : `${e.code}: ${String(r)}`
  }
  const e = props.field.rejection
  if (e) {
    const r = e.params.reason
    return r === undefined ? e.code : `${e.code}: ${String(r)}`
  }
  return ''
})

const problemKind = computed(() =>
  props.field.draftState.state === 'invalid' ? 'invalid' : props.field.rejection ? 'rejected' : '',
)

/** 分量当前值（向量控件）。 */
function componentValue(index: number): number {
  const v = props.field.value
  if (v.kind !== 'value') return 0
  const name = ['x', 'y', 'z', 'w'][index]
  if (!name) return 0
  const n = (v.value as unknown as Record<string, number>)[name]
  return typeof n === 'number' ? n : 0
}

function onText(e: Event): void {
  emit('update:draft', (e.target as HTMLInputElement | HTMLTextAreaElement).value)
}

/**
 * 失焦：请求提交。**非法草稿保留**（不提交、不清除）——
 * 是否真的提交由父级按 `draftState === 'complete'` 判定，这里不重复实现该判据。
 */
function onBlur(): void {
  focused.value = false
  emit('commit')
}

/** Enter 提交、Escape 还原；两者都在此消费事件，避免冒泡后被重复处理。 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('cancel')
    return
  }
  if (e.key === 'Enter' && !e.shiftKey && !props.field.control.multiline) {
    e.preventDefault()
    emit('commit')
  }
}

// 外部值变化且未在编辑 ⇒ 草稿回落（编辑中不打断输入）。
watch(
  () => props.field.displayText,
  () => {
    if (!focused.value && props.field.draft !== null) emit('cancel')
  },
)
</script>

<template>
  <div
    class="ux-field"
    :class="{ 'ux-field--row': kind === 'toggle', 'ux-field--readonly': isReadOnly }"
    :data-property="field.descriptor.id"
    :data-control="kind"
    :data-mixed="isMixed ? '1' : '0'"
  >
    <label class="ux-field-label" :title="field.display.descriptionFallback ?? ''">
      {{ field.display.labelFallback }}
    </label>

    <div class="ux-field-input">
      <!-- 只读：不可聚焦 + 带**结构化原因**（不是「能输入但没反应」） -->
      <span
        v-if="isReadOnly"
        class="ux-field-readonly"
        tabindex="-1"
        :data-readonly-code="readOnlyReason?.code ?? ''"
        :data-readonly-reason="String(readOnlyReason?.params.reason ?? '')"
        :title="readOnlyReason ? `${readOnlyReason.code}: ${String(readOnlyReason.params.reason ?? '')}` : ''"
      >{{ field.displayText }}</span>

      <!-- boolean：原生可聚焦控件 + indeterminate（三态：真/假/混合） -->
      <input
        v-else-if="kind === 'toggle'"
        type="checkbox"
        class="ux-field-check"
        role="switch"
        :checked="field.value.kind === 'value' ? Boolean(field.value.value) : false"
        :indeterminate.prop="isMixed"
        :aria-checked="isMixed ? 'mixed' : (field.value.kind === 'value' && Boolean(field.value.value) ? 'true' : 'false')"
        @change="(e: Event) => emit('commit-value', (e.target as HTMLInputElement).checked)"
      />

      <!-- 枚举：显示名与值分离；混合态显式列出且需重新选择 -->
      <select
        v-else-if="kind === 'dropdown'"
        class="ux-field-select"
        :value="field.value.kind === 'value' ? String(field.value.value) : ''"
        @change="(e: Event) => emit('commit-value', (e.target as HTMLSelectElement).value)"
      >
        <option v-if="isMixed" value="">— 混合 —</option>
        <option v-for="opt in field.control.options ?? []" :key="opt.value" :value="opt.value">
          {{ opt.display.fallback ?? opt.display.labelKey }}
        </option>
      </select>

      <!-- 滑块：步长/范围来自描述符（不按 range/100 猜） -->
      <template v-else-if="kind === 'slider'">
        <input
          type="range"
          class="ux-field-range"
          :value="Number(scalarValue) || 0"
          :min="field.control.min ?? 0"
          :max="field.control.max ?? 100"
          :step="field.control.step ?? 1"
          @input="(e: Event) => emit('commit-value', Number((e.target as HTMLInputElement).value))"
        />
        <span class="ux-field-value">{{ field.displayText }}</span>
      </template>

      <!-- 向量：逐分量提交（每分量一次事务，其余分量保持） -->
      <template v-else-if="kind === 'vector'">
        <span v-for="(c, i) in field.control.components ?? []" :key="c" class="ux-field-comp">
          <span class="ux-field-comp-label">{{ c.toUpperCase() }}</span>
          <input
            type="number"
            class="ux-field-comp-input"
            :step="field.control.step ?? 1"
            :value="componentValue(i)"
            @change="(e: Event) => emit('commit-component', i, Number((e.target as HTMLInputElement).value))"
          />
        </span>
      </template>

      <!-- 颜色：色板给值 + 文本框给草稿（校验走同一条 handler 路径） -->
      <template v-else-if="kind === 'color'">
        <input
          type="color"
          class="ux-field-color"
          :value="typeof scalarValue === 'string' && /^#[0-9a-fA-F]{6}$/.test(scalarValue) ? scalarValue : '#000000'"
          @input="(e: Event) => emit('commit-value', (e.target as HTMLInputElement).value)"
        />
        <input
          type="text"
          class="ux-field-text ux-field-text--mono"
          :value="textValue"
          spellcheck="false"
          @input="onText"
          @focus="focused = true"
          @blur="onBlur"
          @keydown="onKeydown"
        />
      </template>

      <!-- 多行文本 -->
      <textarea
        v-else-if="kind === 'multiline-text'"
        class="ux-field-textarea"
        :value="textValue"
        spellcheck="false"
        @input="onText"
        @focus="focused = true"
        @blur="onBlur"
        @keydown="onKeydown"
      />

      <!-- 字符串列表（分隔符来自描述符）：混合态留空提示而非预填首项值 -->
      <input
        v-else-if="kind === 'string-list'"
        type="text"
        class="ux-field-text"
        :value="isMixed ? '' : textValue"
        :placeholder="isMixed ? '— 混合 —' : ''"
        @input="onText"
        @focus="focused = true"
        @blur="onBlur"
        @keydown="onKeydown"
      />

      <!-- 默认（number/stepper/text/reference）：草稿 + 显式提交 -->
      <input
        v-else
        :type="kind === 'number' || kind === 'stepper' ? 'number' : 'text'"
        class="ux-field-text"
        :value="textValue"
        :step="field.control.step"
        :placeholder="isMixed ? '— 混合 —' : ''"
        spellcheck="false"
        @input="onText"
        @focus="focused = true"
        @blur="onBlur"
        @keydown="onKeydown"
      />

      <span v-if="field.control.unit?.symbolFallback" class="ux-field-unit">{{
        field.control.unit.symbolFallback
      }}</span>
    </div>

    <span v-if="problemText" class="ux-field-problem" :data-problem="problemKind">{{ problemText }}</span>
  </div>
</template>

<style scoped>
.ux-field { display: flex; flex-direction: column; gap: 3px; padding: 3px 0; }
.ux-field--row { flex-direction: row; align-items: center; justify-content: space-between; }
.ux-field-label { font-size: 12px; color: var(--wb-text-muted); }
.ux-field-input { display: flex; align-items: center; gap: 4px; }
.ux-field-text, .ux-field-select {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-bg-surface);
  color: var(--wb-text);
  font-size: 13px;
  outline: none;
}
.ux-field-text--mono { font-family: var(--wb-font-mono); font-size: 11px; }
.ux-field-textarea {
  flex: 1;
  min-width: 0;
  min-height: 60px;
  padding: 6px 8px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-bg-surface);
  color: var(--wb-text);
  font-size: 12px;
  font-family: var(--wb-font-mono);
  resize: vertical;
  outline: none;
}
.ux-field-text:focus, .ux-field-select:focus, .ux-field-textarea:focus { border-color: var(--wb-accent); }
.ux-field-check { width: 16px; height: 16px; accent-color: var(--wb-accent); flex-shrink: 0; }
.ux-field-range { flex: 1; accent-color: var(--wb-accent); }
.ux-field-value {
  font-size: 11px;
  min-width: 32px;
  text-align: right;
  font-family: var(--wb-font-mono);
  color: var(--wb-accent);
}
.ux-field-color {
  width: 26px; height: 26px; padding: 0;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  cursor: pointer;
  flex-shrink: 0;
}
.ux-field-unit { font-size: 10px; color: var(--wb-text-dim); flex-shrink: 0; }
.ux-field-readonly {
  flex: 1;
  font-size: 12px;
  color: var(--wb-text-dim);
  font-family: var(--wb-font-mono);
  padding: 6px 8px;
  border: 1px dashed var(--wb-border);
  border-radius: var(--wb-radius-sm);
}
.ux-field-problem { font-size: 10px; color: #f87171; }
.ux-field-problem[data-problem='rejected'] { color: #fbbf24; }
.ux-field-comp { display: inline-flex; align-items: center; gap: 2px; }
.ux-field-comp-label { font-size: 9px; color: var(--wb-text-dim); width: 10px; text-align: center; }
.ux-field-comp-input {
  width: 44px;
  padding: 4px 2px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-bg-surface);
  color: var(--wb-text);
  font-size: 11px;
  font-family: var(--wb-font-mono);
  outline: none;
  text-align: center;
}
</style>
