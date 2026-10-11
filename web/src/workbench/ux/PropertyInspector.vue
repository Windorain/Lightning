<script setup lang="ts">
/**
 * #253 P2 · **生成式属性面板**（Inspector v1）。
 *
 * 依据：#249 §6（「基础 Inspector 由 RNA 生成控件；两者均支持固定目标、多选混合值、
 * 拒绝原因、交互暂存和动画入口」）、§19.1（编辑草稿与提交时机）、§19.9（诊断）。
 *
 * ## 这个组件替代了什么（退役 #3）
 *
 * 旧实现里「属性区」是**三个各写一遍的布局函数**加一个通用 `RNAWidget`：
 *  - `blockInspector.ts` / `sceneInfo.ts` / `wikiConfig.ts` 手写 `kind: 'property'` 列表；
 *  - `AnnotationEditorPanel.vue` 手写 `textarea` 绕过 RNA，再自建 `Proxy` 拦截 `set`；
 *  - 三者最终都落到 `RNAWidget` 的三条写路径（两条前缀分派 + 一条 `descriptor.set`）。
 *
 * 新形态：面板**只有一条**渲染路径 —— `buildInspector(ctx, session)` 产出的
 * `InspectorModel`（纯函数、可断言、无布局规格也能生成）。属性覆盖度由
 * `rnaCoverage()` 可查，「登记了但界面没有入口」不再是隐形的（#251 B7 的 E-6）。
 *
 * ## 提交时机
 *
 * 草稿与拒绝原因放在 `PanelSession`（跨重渲染保留），提交走
 * `commitFieldValue` → 唯一写路由。组件不判合法性、不碰文档。
 */

import { onBeforeUnmount, reactive, ref, watch } from 'vue'
import { inject } from 'vue'
import { contextKey, type Context } from '@/runtime/context'
import PropertyField from './PropertyField.vue'
import ReadonlyLayout from './ReadonlyLayout.vue'
import type { PropertyDescriptor } from '@/application/properties'
import type { UILayout } from './types/layout'
import {
  type PanelSession,
  buildField,
  commitFieldComponent,
  commitFieldValue,
  createPanelSession,
  workbenchRegistry,
} from '@/editors/workbench-rna'
import { localPropertyOf } from '@/editors/property-writers'
import { canCommitDraft } from '@/editors/property-controls'
import type { InspectorModel } from '@/editors/inspector'
import { buildInspector } from '@/editors/workbench-rna'

const props = defineProps<{
  ctx: Context
  /** 面板标题（如「方块检查器」）；仅呈现用。 */
  title?: string
  /** 该面板的**诊断/命令**片段（属性行不在此列，见 `ReadonlyLayout`）。 */
  fragment?: UILayout
}>()

const session: PanelSession = reactive(createPanelSession()) as PanelSession

const model = ref<InspectorModel>(buildInspector(props.ctx, session))

const version = ref(0)

/** 重算模型：订阅文档、结构纪元、选中集、悬停与工具设置。 */
watch(
  () => [
    props.ctx.getDoc().value,
    props.ctx.getContentRefreshTick().value,
    props.ctx.getSelection().items.value,
    props.ctx.getHoveredAnnotationId().value,
    props.ctx.getHoveredBlock().value,
    props.ctx.getToolSettings().snapEnabled.value,
    props.ctx.main.embedPublish.value,
  ],
  () => {
    model.value = buildInspector(props.ctx, session)
    version.value++
    // 每次重算后刷新提交落点登记：目标/选中集变化会改变 `resolveRefs` 的结果，
    // 而落点闭包必须按**当前**描述符与上下文解析（不是快照）。
    syncCommitSinks()
  },
  { immediate: true, deep: false },
)

/** 已登记的 controlId（卸载时按它清理，避免在 `applyPropertyRegistry` 里留孤儿）。 */
const registeredSinkIds = new Set<string>()

function syncCommitSinks(): void {
  for (const section of model.value.sections) {
    for (const row of section.rows) {
      const desc = descriptorOf(row.field.descriptor.id)
      if (!desc) continue
      // 只登记**可编辑且有草稿语义**的字段：只读字段没有提交落点
      // （`resolveRefs` 为空 ⇒ `edit.kind === 'readOnly'`）。
      const field = buildField(props.ctx, desc, session)
      if (field.edit.kind !== 'editable') continue
      registerCommitSink(desc)
      registeredSinkIds.add(`field:${desc.id}`)
    }
  }
}

function descriptorOf(propertyId: string): PropertyDescriptor | null {
  return workbenchRegistry().registry.descriptor(propertyId) ?? null
}

function fieldFor(propertyId: string) {
  const desc = descriptorOf(propertyId)
  if (!desc) return null
  return buildField(props.ctx, desc, session)
}

/** 草稿变化的**镜像**（呈现侧权威是输入层投影；此镜像供 P2 的会话/拒绝原因使用）。 */
function onDraft(desc: PropertyDescriptor, text: string): void {
  const local = localPropertyOf(desc.id)
  session.drafts[local] = text
  session.rejections[local] = undefined as never
}

/**
 * 把每个可编辑属性登记为**输入层的提交落点**。
 *
 * ## 为什么这条桥是必需的，以及它为什么在这里
 *
 * 输入层（`runtime/inputSession`）判定"草稿完整合法"后产出 `draft.commit`，
 * 命令层把它映射成 `setProperty`（`application/inputCommands`）。但命令只携带
 * `PropertyRef`（**值**，不含 setter）—— 真正的落点由装配侧按 `controlId` 解析。
 *
 * `application` 层不能认识呈现层的字段/描述符（那是分层倒置），
 * 故这个映射由**呈现侧自己**登记：本组件知道自己的描述符与写函数，
 * 于是把"controlId → 用唯一写路由提交这个值"注册进 `WM.applyPropertyRegistry`。
 *
 * 落点是 `commitFieldValue` —— 它经 `submitPropertyWrite` 走
 * `applySetProperty`（P2 的唯一写路由），**不是** `descriptor.set` 直写。
 *
 * 退出：真实文档换成内核 `Document` 后（P10），`draft.commit` 可直接映射成
 * 内核的 `setProperty`，本桥连同 `applyPropertyRegistry` 一起删除。
 * 已登记于 `composition/seams.ts`。
 */
function registerCommitSink(desc: PropertyDescriptor): void {
  props.ctx.wm.applyPropertyRegistry.set(`field:${desc.id}`, (value: number | string) => {
    // 输入层已判为完整合法；此处只做"交给唯一写路由"。
    // 被拒绝的原因落到 `session.rejections`（呈现可见，不静默）。
    const local = localPropertyOf(desc.id)
    const outcome = commitFieldValue(props.ctx, desc, value as never)
    applyOutcome(local, outcome)
  })
}

/** 提交当前草稿：仅在**完整合法**时提交（非法草稿保留并提示）。 */
function onCommit(desc: PropertyDescriptor): void {
  const local = localPropertyOf(desc.id)
  const field = buildField(props.ctx, desc, session)
  if (!canCommitDraft(field)) return
  if (field.draftState.state !== 'complete') return
  const outcome = commitFieldValue(props.ctx, desc, field.draftState.value)
  applyOutcome(local, outcome)
}

/** 提交一个已解析值（boolean/枚举/滑块/色板）。 */
function onCommitValue(desc: PropertyDescriptor, value: unknown): void {
  const local = localPropertyOf(desc.id)
  const outcome = commitFieldValue(props.ctx, desc, value as never)
  applyOutcome(local, outcome)
}

/** 提交某分量。 */
function onCommitComponent(desc: PropertyDescriptor, index: number, value: number): void {
  const local = localPropertyOf(desc.id)
  const outcome = commitFieldComponent(props.ctx, desc, index, value)
  applyOutcome(local, outcome)
}

function onCancel(desc: PropertyDescriptor): void {
  const local = localPropertyOf(desc.id)
  session.drafts[local] = null
}

/**
 * 结算：`applied` ⇒ 清草稿与拒绝原因；`rejected` ⇒ **保留草稿**并记录原因
 * （拒绝后不得报告成功，D5）；`unchanged` ⇒ 清草稿（无业务变化，不是失败）。
 */
function applyOutcome(local: string, outcome: { status: string; error?: unknown }): void {
  if (outcome.status === 'rejected') {
    session.rejections[local] = outcome.error as never
    return
  }
  session.drafts[local] = null
  session.rejections[local] = undefined as never
}

/**
 * 卸载前 flush：把**完整合法**的草稿提交掉。
 *
 * 旧实现的 `onBeforeUnmount` 只 `clearTimeout`，正在等待 debounce 的文本直接丢失
 * （#251 B7 的 C-11/D2.1 #23）。这里改为显式提交。
 */
onBeforeUnmount(() => {
  // 清理提交落点登记：本面板卸载后 `field:*` 不应再被解析（否则命令会打到
  // 一个已经不在界面上的字段，表现为"改了没反应"）。
  for (const id of registeredSinkIds) props.ctx.wm.applyPropertyRegistry.delete(id)
  registeredSinkIds.clear()
  for (const section of model.value.sections) {
    for (const row of section.rows) {
      const draft = session.drafts[row.localId]
      if (draft === null || draft === undefined) continue
      const desc = descriptorOf(row.field.descriptor.id)
      if (!desc) continue
      const field = buildField(props.ctx, desc, session)
      if (!canCommitDraft(field) || field.draftState.state !== 'complete') continue
      commitFieldValue(props.ctx, desc, field.draftState.value)
      session.drafts[row.localId] = null
    }
  }
})

/** 面板标题：多选时显示数量（不隐藏属性区 —— D6）。 */
const heading = ref('')
watch(
  () => [model.value.objectTypeId, model.value.targets.length],
  () => {
    const n = model.value.targets.length
    const base = props.title ?? objectLabel(model.value.objectTypeId)
    heading.value = n > 1 ? `${base} ×${n}` : base
  },
  { immediate: true },
)

function objectLabel(objectTypeId: string): string {
  const decl = workbenchRegistry().registry.objectType(objectTypeId)
  return decl?.display.fallback ?? decl?.display.labelKey ?? objectTypeId
}

void inject(contextKey, null)
</script>

<template>
  <div class="inspector" data-inspector="generated">
    <div v-if="model.targets.length === 0" class="inspector-empty">
      {{ model.objectTypeId ? '未选择目标' : '无可用属性' }}
    </div>

    <template v-else>
      <div class="inspector-head">
        <span class="inspector-title">{{ heading }}</span>
        <span v-if="model.generated" class="inspector-badge" title="无布局规格，按声明生成">自动</span>
      </div>

      <section v-for="section in model.sections" :key="section.id" class="inspector-section">
        <label class="inspector-section-label">{{ section.display.fallback ?? section.display.labelKey }}</label>

        <template v-for="row in section.rows" :key="row.localId">
          <PropertyField
            v-if="fieldFor(row.field.descriptor.id)"
            :field="fieldFor(row.field.descriptor.id)!"
            @draft="(t: string) => onDraft(row.field.descriptor, t)"
            @commit="() => onCommit(row.field.descriptor)"
            @commit-value="(v: unknown) => onCommitValue(row.field.descriptor, v)"
            @commit-component="(i: number, v: number) => onCommitComponent(row.field.descriptor, i, v)"
            @cancel="() => onCancel(row.field.descriptor)"
          />
        </template>
      </section>

      <!-- 面板的只读诊断/具名命令片段（该渲染器**没有**属性分支） -->
      <ReadonlyLayout
        v-if="fragment"
        :layout="fragment"
        @operator="(id: string, p?: Record<string, unknown>) => ctx.getOperators().exec(id, p)"
      />
    </template>
  </div>
</template>

<style scoped>
.inspector { display: flex; flex-direction: column; gap: 6px; }
.inspector-empty { font-size: 13px; color: var(--wb-text-dim); padding: 20px 0; text-align: center; }
.inspector-head { display: flex; align-items: center; gap: 6px; }
.inspector-title {
  font-size: 13px;
  color: var(--wb-text);
  font-family: var(--wb-font-mono);
  background: var(--wb-bg-surface);
  padding: 2px 8px;
  border-radius: var(--wb-radius-sm);
  border: 1px solid var(--wb-border);
}
.inspector-badge {
  font-size: 9px;
  color: var(--wb-text-dim);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  padding: 1px 5px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.inspector-section {
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  padding: 10px;
  margin: 4px 0;
  background: var(--wb-bg-surface);
}
.inspector-section-label {
  display: block;
  font-size: 10px;
  font-weight: 600;
  color: var(--wb-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.8px;
  margin-bottom: 6px;
}
</style>
