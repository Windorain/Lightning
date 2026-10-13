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
    // #301 P10f C′1（N9）：宽信号（内容重读）—— 原地编辑也要重算模型。
    props.ctx.getContentRefreshTick().value,
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

/** 草稿变化的**镜像**：P10c（#286）起已删除，本回调随之退役。
 *
 * ## 为什么可以删（实测，不是判断）
 *
 * 这里曾把 `PropertyField` 的 `draft` 事件写进 `session.drafts[local]`。
 * 但那条镜像的**写键与读键不同**：本文件写 `localPropertyOf(desc.id)`（= `tooltip`），
 * 而 `editors/inspector.ts` 的 `makeRow` 与卸载 flush 读 `localIdOf`（= `block.tooltip`）
 * —— 生产 84 个属性无一命中，故镜像从未喂到模型；唯一同键读取点 `buildField`
 * 又只被这条镜像链消费，环上没有生产行为。
 *
 * 草稿的唯一权威是输入层：`domain/textDraft`（判定）+ `runtime/inputSession`（时序），
 * 呈现读 `InputPort.textProjection`。接缝登记见 `composition/seams.ts`。
 */

/**
 * 把每个可编辑属性登记为**输入层的提交落点** —— R1-β① C4 **已删除**。
 *
 * ## 它曾经是什么，为什么不再需要
 *
 * 输入层（`runtime/inputSession`）判定"草稿完整合法"后产出 `draft.commit`，
 * 命令层把它映射成 `setProperty`（`application/inputCommands`），命令携带
 * `PropertyRef`（**值**，不含 setter）。旧实现在**呈现层**按 `controlId` 登记一张
 * 闭包表供端口回查 —— 那使"命令落到哪里"取决于组件挂载与目标快照。
 *
 * 现在解析是**数据驱动**的：`editors/workbench-rna#commitDraftControlValue`
 * 读描述符注册表（面板的同一张数据表）→ `resolveRefs` → `submitPropertyWrite`
 * （唯一写路由）。本组件不再登记任何提交落点，也不再持有清理责任。
 */

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

/**
 * 结算：`applied`/`unchanged` ⇒ 清拒绝原因；`rejected` ⇒ **记录原因**（拒绝后不得
 * 报告成功，D5）。
 *
 * P10c（#286）：`session.drafts` 已删，故这里不再清草稿 —— 草稿由输入层持有，
 * 非法/中间态的**可见提示**来自 `InputPort.textProjection`（呈现侧读面）。
 */
function applyOutcome(local: string, outcome: { status: string; error?: unknown }): void {
  if (outcome.status === 'rejected') {
    session.rejections[local] = outcome.error as never
    return
  }
  session.rejections[local] = undefined as never
}

/**
 * ## R1-β① C4：本组件的"提交落点登记"已删除
 *
 * 旧实现在这里遍历模型、把每个可编辑描述符注册成一张**闭包表**的一行
 * （`field:<描述符 id>` → 「用唯一写路由提交这个值」），供输入端口按 `controlId` 回查。
 * 那条链让命令的落点依赖**组件是否挂载**（没挂载 ⇒ `controlNotRegistered`，
 * 表现为"输入了没反应"）。C4 把解析移到边界层
 * （`editors/workbench-rna#commitDraftControlValue`：控件 id → 描述符注册表 →
 * 唯一写路由），于是落点是**装配事实**而不是组件生命周期事实，本文件不再持有它。
 *
 * ## P10c（#286）：草稿 flush 循环已删除
 *
 * 旧实现在卸载前遍历模型、把 `session.drafts[row.localId]` 里"完整合法"的草稿提交掉。
 * 但那段代码读的键是 `row.localId`（`localIdOf` ⇒ `block.tooltip`），
 * 而镜像写入用的键是 `localPropertyOf(desc.id)`（⇒ `tooltip`）——**两键在生产键空间
 * 里无一命中**（84/84 不等），故 flush 体从未执行过一次。
 *
 * "卸载不丢字"这条能力**仍然成立**，只是归属变了：文本控件的失焦/关闭由输入层结算
 * （`domain/textDraft.blurControl`：`blur`/`focus-switch`/`enter` 经 `settleControl`
 * 提交，`close`/`target-invalid` 取消并还原），`PropertyField` 卸载时
 * `unbindControl` 也会以 `target-invalid` 结算。判据在
 * `domain/__tests__/textDraft.test.ts` 的焦点切换/禁用集与 e2e `input-routing.spec.ts`。
 */

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
            @commit-value="(v: unknown) => onCommitValue(row.field.descriptor, v)"
            @commit-component="(i: number, v: number) => onCommitComponent(row.field.descriptor, i, v)"
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
