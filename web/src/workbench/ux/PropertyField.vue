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
 *  2/4. 提交时机与草稿是 `domain/textDraft.ts` 的纯状态机（见下"草稿权威"）；
 *  3. 控件选择是 `modelFor(desc)`，与描述同源（本组件只读 `field.control`）。
 *
 * ## 本组件不认识「写到哪里」
 *
 * 它**不接收 setter 闭包**，也不认识文档/命令。它只发两个**意图**：
 * `commit-value`（提交一个已解析值）与 `commit-component`（提交某分量）——
 * 都是"无草稿语义"的控件（boolean/枚举/滑块/色板/向量）。
 *
 * 文本类控件的草稿**不经过父级**：输入层（`runtime/inputSession`）判定完整合法后
 * 产出 `draft.commit`，命令层映射成 `setProperty`，落点由 `PropertyInspector` 登记
 * 进 `WM.applyPropertyRegistry`。故组件层**没有**任何可写旁路
 * （契约 §5.2「唯一写路由」在组件层的**结构性**形态：不是靠约定不写旁路，
 * 而是这里没有可用的旁路）。
 *
 * ## P10c（#286）：`draft`/`commit`/`cancel` 三个 emit 已删除
 *
 * 它们曾是 P2 那套"父级存草稿、父级判合法性"的接口。三个都已是死轨：
 *  - `commit`/`cancel` **从来没有发出点**（全树零 `emit('commit')`/`emit('cancel')`），
 *    父级的 `@commit`/`@cancel` 处理器不可达；
 *  - `draft` 只喂给 `PanelSession.drafts` 这份镜像，而镜像的写键与读键不同
 *    （写 `localPropertyOf(desc.id)`＝`tooltip`，读 `localIdOf`＝`block.tooltip`），
 *    生产 84 个属性无一命中 ⇒ 镜像从不影响渲染。
 *
 * 现在文本变化只由输入层消费（`adapters/inputBinding` 的 `input` 监听），
 * 显示文本读 `textProjection`。退役登记见 `composition/seams.ts`。
 *
 * ## 草稿权威 = `domain/textDraft`（P7 #258 合流后）
 *
 * ## 键盘归属也交给输入层，为什么
 *
 * P2 初版在本组件内 `onKeydown` 里直接消费 Enter/Escape。那有两个问题：
 *  1. **归属判据分散**：`g` 这类场景快捷键的归属由输入层判（`textFocus` 显式状态），
 *     而 Enter/Escape 由本组件判 —— 同一份"焦点在文本里"的事实被两处各自推断；
 *  2. **IME 无门**：`e.key === 'Enter'` 在输入法确认候选词时**也会**触发
 *     （确认键就是 Enter），P2 初版没有 `isComposing` 守卫 ⇒ 中文输入法下
 *     按回车确认候选会**顺带提交**（#249 §19.1「IME 组合未结束不得提交」）。
 *
 * 故本组件现在只声明**事实**（`data-input-control-id` / `data-input-kind` /
 * `data-input-display`），键盘与 IME 一律经 `InputPort` 路由：
 *  - `focusin`/`focusout`/`composition*`/`input` 由 `adapters/inputBinding` 的
 *    **唯一** document 级监听收下（不在这里再挂一套）；
 *  - Enter/Escape/Ctrl+Z 的判定在 `domain/input.ts`（纯路由）与
 *    `domain/textDraft.ts`（纯状态机）。
 *
 * ## 呈现如何跟随（只有一条数据流）
 *
 * `textProjection(controlId)` 是**只读**投影；本组件订阅 `InputPort.subscribe`
 * 在事件处理完后重读它。组件**不**自己存草稿，故不存在第二份权威
 * （这正是 #249 §19.1 要的结构）。
 */

import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import type { FieldViewModel } from '@/editors/property-controls'
import { contextKey, type Context } from '@/runtime/context'
import type { ControlBinding } from '@/application/inputCommands'
import type { DraftKind } from '@/domain/textDraft'

const props = defineProps<{ field: FieldViewModel }>()

const emit = defineEmits<{
  /** 请求提交一个**已解析**的值（boolean/枚举/滑块/色板/分量这些无草稿的控件）。 */
  (e: 'commit-value', value: unknown): void
  /** 请求提交某个向量分量（`component` 寻址）。 */
  (e: 'commit-component', index: number, value: number): void
}>()

const ctx = inject<Context | null>(contextKey, null)

const kind = computed(() => props.field.control.kind)
const isMixed = computed(() => props.field.value.kind === 'mixed')
const isReadOnly = computed(() => props.field.edit.kind === 'readOnly')
/** 数值类控件（走数字键盘与 `spinbutton` 语义，但仍用 `type=text` 保留中间草稿）。 */
const isNumeric = computed(() => kind.value === 'number' || kind.value === 'stepper' || kind.value === 'slider')
/** 只读原因（结构化，不是布尔）—— 呈现端只做展示，不重新判定。 */
const readOnlyReason = computed(() => (props.field.edit.kind === 'readOnly' ? props.field.edit.reason : null))

// ─────────────────────────────────────────────────────────────────────────────
// 输入层接线：控制 id、登记、投影订阅
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 本控件的**输入会话控制 id**（`data-input-control-id` 用它）。
 *
 * 用属性 id（`lightning.publishConfig.viewWidth`）而不是 DOM 位置：它在重渲染、
 * 面板切换、多目标之间**稳定**，故"登记 ↔ DOM 标注"不会像 `RNAWidget` 那样
 * 因实例复用而错位（那正是 P7 初版踩到的 `unboundControl`）。
 */
const controlId = computed(() => `field:${props.field.descriptor.id}`)

/** 该控件是否走草稿型（三态机）。无草稿语义的控件（toggle/dropdown/slider/color）不在其中。 */
const draftKind = computed<DraftKind | null>(() => {
  if (props.field.edit.kind !== 'editable') return null
  const k = kind.value
  if (k === 'number' || k === 'stepper') return 'number'
  if (k === 'text' || k === 'multiline-text' || k === 'string-list' || k === 'reference') return 'text'
  // color 的十六进制文本框也走草稿（色板那一支另发 commit-value）
  if (k === 'color') return 'text'
  return null
})

/**
 * 订阅信号：每次会话推进 +1，用来让 `projection()` 重新求值。
 *
 * 会话是**纯值**对象（不在 Vue 响应式图里），故需要这个显式触发点。
 */
const epoch = ref(0)
let unsubscribe: (() => void) | null = null

function projection(): { draft: string; status: string; reason: string | null; composing: boolean; submittable: number | string | null } | null {
  // 读 epoch 建立依赖：会话广播 ⇒ 本 computed/函数重新求值
  void epoch.value
  const port = ctx?.wm.inputPort ?? null
  if (port === null) return null
  return port.textProjection(controlId.value)
}

/**
 * 显示文本：**输入层投影优先**（P7 权威），投影不可用时用 P2 的 `displayText`。
 *
 * ## 为什么还留回落（P10c #286 之后）
 *
 * `draftKind !== null` 但控件**尚未登记**时 `textProjection` 返回 `null`
 * （会话以 `focusin` 事实驱动），此时显示的是已提交值的格式化文本 —— 正是
 * "还没开始编辑"的正确显示。回落**不再**读草稿镜像（那份镜像已删除），
 * 故这里不可能出现"两个真相"。
 */
const shownText = computed(() => {
  const p = projection()
  if (p !== null && p.draft !== '') return p.draft
  return props.field.displayText
})

/** 非法/中间态提示：**输入层**的原因码（P7 权威；投影不可用即无草稿）。 */
const inputProblem = computed(() => {
  if (draftKind.value === null) return ''
  const p = projection()
  if (p === null || p.status === 'complete') return ''
  return `${p.status === 'invalid' ? 'InvalidValue' : 'draftIncomplete'}: ${p.reason ?? ''}`
})

/**
 * 非法草稿/拒绝原因的**可见提示**（不静默吞输入）。
 *
 * ## 权威归属：解析级取输入层，写入拒绝取 P2
 *
 * 解析级结论（草稿是否合法/中间态）**只**取输入层投影 —— 否则会出现"两个解析器
 * 各判一次"（域约束宽严/`required` 语义可能给出不同结论），界面就可能显示一条
 * 并不来自权威路径的错误。P10c（#286）删除了 P2 的 `draftState` 回落分支：
 * 那份镜像的写键与读键在生产里无一命中，回落在真实页面中从未生效。
 *
 * 写入被**拒绝**的原因始终取 P2（唯一写路由的真实结论），与解析级提示不同。
 */
const problemText = computed(() => {
  if (draftKind.value !== null) {
    if (inputProblem.value !== '') return inputProblem.value
    const e = props.field.rejection
    if (!e) return ''
    const r = e.params.reason
    return r === undefined ? e.code : `${e.code}: ${String(r)}`
  }
  const e = props.field.rejection
  if (!e) return ''
  const r = e.params.reason
  return r === undefined ? e.code : `${e.code}: ${String(r)}`
})

const problemKind = computed(() => {
  if (draftKind.value !== null && inputProblem.value !== '') return 'invalid'
  return props.field.rejection ? 'rejected' : ''
})

/** 向量分量输入不发草稿（逐分量 `commit-component`），故不声明为草稿控件。 */
function registerControl(): void {
  const port = ctx?.wm.inputPort
  const k = draftKind.value
  if (port === null || port === undefined || k === null) return
  const binding: ControlBinding = {
    controlId: controlId.value,
    contextId: 'workbench',
    // `ref` 是**值**（不含 setter）。`property` 用控制 id：命令层据此回查
    // `WM.applyPropertyRegistry` 的落点（P7 → P2 `commitFieldValue` 的桥，
    // 由 `PropertyInspector` 登记；见那里的 `applyPropertyRegistry`）。
    ref: { owner: { kind: 'document', id: '' }, property: controlId.value },
    kind: k,
    commitOn: 'enter-or-blur',
    ...(props.field.control.min === undefined ? {} : { min: props.field.control.min }),
    ...(props.field.control.max === undefined ? {} : { max: props.field.control.max }),
    label: props.field.display.labelFallback,
  }
  port.bindControl(binding)
}

onMounted(() => {
  const port = ctx?.wm.inputPort ?? null
  registerControl()
  if (port !== null) {
    unsubscribe = port.subscribe(() => {
      epoch.value += 1
    })
  }
  // **不**在此 `registerTextControl`：控件的会话登记由 `focusin` 事件驱动
  // （`adapters/inputBinding`）——那才是"焦点事实"的唯一来源。
  // 未登记时 `textProjection` 返回 `null`，呈现回落到 `field.displayText`，
  // 正是"还没开始编辑"的正确显示（#249 §19.1 的三个状态各有来源）。
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
  ctx?.wm.inputPort?.unbindControl(controlId.value)
})

/** 已解析值是否可直接用于受控控件的 `value` 绑定。 */
const scalarValue = computed<string | number | boolean>(() => {
  const v = props.field.value
  if (v.kind !== 'value') return ''
  const raw = v.value
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'string') return raw
  return ''
})

/**
 * 文本变化**不再由本组件转发**（P10c #286）。
 *
 * 旧实现有 `onText` → `emit('draft', …)`，把变化交给父级写进
 * `PanelSession.drafts` 这份镜像。镜像已删除（写键 `tooltip` 与读键
 * `block.tooltip` 在生产键空间无一命中，从不影响渲染）。
 *
 * 文本输入现在只由输入层的**唯一** document 级监听消费
 * （`adapters/inputBinding` 的 `input` → `InputSession.applyTextInput`），
 * 判定在 `domain/textDraft`。本组件只声明 `data-input-*` 事实。
 *
 * ## 失焦也不由本组件处理
 *
 * 失焦的提交时机属输入层（`commitOn: 'enter-or-blur'` 的政策在
 * `domain/textDraft.settleControl`）。本组件若也发一次提交，
 * 同一次失焦会被两处各提交一次 —— 那正是 A22/A25 要防的"重复消费"。
 * 实际的失焦提交由 `adapters/inputBinding` 的 `focusout` → `blurTextControl` 完成。
 */

/** 分量当前值（向量控件）。 */
function componentValue(index: number): number {
  const v = props.field.value
  if (v.kind !== 'value') return 0
  const name = ['x', 'y', 'z', 'w'][index]
  if (!name) return 0
  const n = (v.value as unknown as Record<string, number>)[name]
  return typeof n === 'number' ? n : 0
}

/**
 * 文本控件的**事实标注**（`adapters/inputBinding` 读它们提取 `KeyFact`/`PointerFact`）。
 *
 * 这正是 #249 §19.1「语义层不读 `document.activeElement`」的落点：
 * DOM 只**声明事实**（我是哪个控件、什么类型、当前显示值是什么、域约束是什么），
 * "谁该收到这个键 / 这份草稿能不能提交"由纯路由与纯解析按显式输入判定。
 *
 * ## 为什么域约束也走 DOM 事实
 *
 * 属性描述自带域（`pattern` / `min` / `max` / `required`）。适配器**不认识**
 * 属性描述符（那会把它变成领域层），但它可以读 DOM 上的**声明**。
 * 于是约束的传递路径是"描述 → 呈现声明 → 适配器读事实 → 纯解析判定"，
 * 每一跳都只有一种职责，且判定始终只有一个来源（`domain/textDraft`）。
 *
 * 不这样做就会出现**两个解析器各判一次**：输入层判 `complete`、
 * 属性自己的 pattern 判非法 —— 界面显示"可提交"，提交却被唯一写路由拒绝，
 * 用户看到的是"输入没反应"（P7 合流实测到的 `bad value` 情形）。
 */
const textFacts = computed(() => {
  const domain = props.field.descriptor.domain
  const facts: Record<string, string> = {
    'data-input-control-id': controlId.value,
    'data-input-kind': draftKind.value ?? 'text',
    'data-input-display': props.field.displayText,
    'aria-label': props.field.display.labelFallback,
  }
  if (domain?.kind === 'pattern') {
    facts['data-input-pattern'] = domain.source
    if (domain.hintFallback !== undefined) facts['data-input-pattern-reason'] = domain.hintFallback
  }
  if (domain?.kind === 'text' && domain.maxLength !== undefined) {
    facts['data-input-maxlength'] = String(domain.maxLength)
  }
  return facts
})
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
          v-bind="textFacts"
          type="text"
          class="ux-field-text ux-field-text--mono"
          :value="shownText"
          spellcheck="false"
        />
      </template>

      <!-- 多行文本 -->
      <textarea
        v-else-if="kind === 'multiline-text'"
        v-bind="textFacts"
        class="ux-field-textarea"
        :value="shownText"
        spellcheck="false"
      />

      <!-- 字符串列表（分隔符来自描述符）：混合态留空提示而非预填首项值 -->
      <input
        v-else-if="kind === 'string-list'"
        v-bind="textFacts"
        type="text"
        class="ux-field-text"
        :value="isMixed ? '' : shownText"
        :placeholder="isMixed ? '— 混合 —' : ''"
      />

      <!-- 默认（number/stepper/text/reference）：草稿 + 显式提交 -->
      <!--
        数值用 `type="text"` + `inputmode="decimal"`，**不用** `type="number"`。
        原因（jsdom 与真实浏览器同此行为）：`type=number` 会把 `-`、`1.` 这类中间态
        读成空串（`value === ''`、`valueAsNumber === NaN`），于是「草稿」拿不到用户
        敲的原文 —— 而 #249 §19.1 要求中间态**保留并可提示**（旧实现正是因此把
        `1.` 静默变成 `1`）。`inputmode` 保证移动端弹数字键盘，
        `role="spinbutton"` + `aria-value*` 保证无障碍语义（D2.5 #31）。
      -->
      <input
        v-else
        v-bind="textFacts"
        type="text"
        :inputmode="isNumeric ? 'decimal' : undefined"
        :role="isNumeric ? 'spinbutton' : undefined"
        :aria-valuemin="isNumeric ? field.control.min : undefined"
        :aria-valuemax="isNumeric ? field.control.max : undefined"
        class="ux-field-text"
        :class="{ 'ux-field-text--mono': kind === 'reference' }"
        :value="shownText"
        :placeholder="isMixed ? '— 混合 —' : ''"
        spellcheck="false"
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
