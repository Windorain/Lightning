<script setup lang="ts">
/**
 * **生成式属性面板**（Inspector v1）。
 *
 * 依据：基础 Inspector 由属性描述生成控件；两者均支持固定目标、多选混合值、
 * 拒绝原因、交互暂存和动画入口；编辑草稿与提交时机分离；诊断面独立。
 *
 * ## 这个组件替代了什么（退役 #3）
 *
 * 旧实现里「属性区」是**三个各写一遍的布局函数**加一个通用 `RNAWidget`：
 *  - `blockInspector.ts` / `sceneInfo.ts` / `wikiConfig.ts` 手写 `kind: 'property'` 列表；
 *  - `AnnotationEditorPanel.vue` 手写 `textarea` 绕过 RNA，再自建 `Proxy` 拦截 `set`；
 *  - 三者最终都落到 `RNAWidget` 的三条写路径（两条前缀分派 + 一条 `descriptor.set`）。
 *
 * 新形态：面板**只有一条**渲染路径 —— `buildInspector(ctx)` 产出的
 * `InspectorModel`（纯函数、可断言、无布局规格也能生成）。属性覆盖度由
 * `rnaCoverage()` 可查，「登记了但界面没有入口」不再是隐形的。
 *
 * ## 提交时机与拒绝原因
 *
 * 提交走 `commitFieldValue` → 唯一写路由。**拒绝原因不再住在本组件里**：
 * 它是运行时共享读面（`Context#getFieldRejections()`），因为文本控件的提交经
 * 输入端口、结构性拿不到组件局部态（S0 域 2 ①）。本组件因此既不需要
 * `PanelSession`，也不需要 `applyOutcome` —— 结算发生在写路由那一层。
 * 组件仍然不判合法性、不碰文档。
 */

import { computed, ref, watch } from 'vue'
import { inject } from 'vue'
import { contextKey, type Context } from '@/runtime/context'
import PropertyField from './PropertyField.vue'
import ReadonlyLayout from './ReadonlyLayout.vue'
import type { PropertyDescriptor } from '@/application/properties'
import type { UILayout } from './types/layout'
import {
  buildField,
  commitFieldComponent,
  commitFieldValue,
  workbenchRegistry,
} from '@/editors/workbench-rna'
import type { InspectorModel, InspectorRow } from '@/editors/inspector'
import { buildInspector } from '@/editors/workbench-rna'
import { OBJECT_TYPE } from '@/editors/workbench-inspector'

const props = defineProps<{
  ctx: Context
  /** 面板标题（如「方块检查器」）；仅呈现用。 */
  title?: string
  /** 该面板的**诊断/命令**片段（属性行不在此列，见 `ReadonlyLayout`）。 */
  fragment?: UILayout
}>()

const model = ref<InspectorModel>(buildInspector(props.ctx))

const version = ref(0)

/** 重算模型：订阅文档、结构纪元、选中集、悬停与工具设置。 */
watch(
  () => [
    // 宽信号（内容重读）—— 原地编辑也要重算模型。
    props.ctx.getContentRefreshTick().value,
    props.ctx.getContentRefreshTick().value,
    props.ctx.getSelection().items.value,
    props.ctx.getHoveredAnnotationId().value,
    props.ctx.getHoveredBlock().value,
    props.ctx.getToolSettings().snapEnabled.value,
    props.ctx.main.embedPublish.value,
  ],
  () => {
    model.value = buildInspector(props.ctx)
    version.value++
  },
  { immediate: true, deep: false },
)

/**
 * **拒绝回执的订阅**。
 *
 * 共享读面是一张 `shallowRef` 表：写入会换对象 ⇒ 这里读到变化后重算模型，
 * 字段随即渲染 `.ux-field-problem[data-problem=rejected]`。
 *
 * 为什么必须单独订阅（而不是并进上面那条 watch）：上一条的依赖全是**文档/选中**信号，
 * 而"刚才那次写入被拒"不改变任何一项（拒绝的语义就是**内容不变**，SPEC §8）
 * —— 不订阅它，拒绝就永远等不到一次重渲染。
 */
watch(
  () => props.ctx.getFieldRejections().table.value,
  () => {
    model.value = buildInspector(props.ctx)
    version.value++
  },
)

/**
 * ## `syncCommitSinks` 与 `registeredSinkIds` 已**整体删除**
 *
 * 旧实现在这里遍历模型，把每个可编辑描述符登记成 `WM.applyPropertyRegistry` 的一张
 * 闭包表（`field:<描述符 id>` → 「用唯一写路由提交这个值」）供输入端口按 `controlId`
 * 回查，并在卸载时清理。那条链使**命令的落点取决于组件是否挂载**：未挂载 ⇒
 * `controlNotRegistered` ⇒ 表现为"输入了没反应"。
 *
 * 现在解析在**边界层**：`editors/workbench-rna#commitDraftControlValue`
 * （控件 id → 描述符注册表 → `submitPropertyWrite` 唯一写路由），由
 * `workbench/inputHotkeys` 的端口调用 ⇒ 落点是**装配事实**，不是组件生命周期事实。
 *
 * ⚠️ `WM.applyPropertyRegistry` 容器本身尚存（`WorkbenchRoot.vue:310` 的诊断读面仍在读
 * 它的键集），退役归后续接缝核销；**本文件已不再向它登记任何东西**。
 */

function descriptorOf(propertyId: string): PropertyDescriptor | null {
  return workbenchRegistry().registry.descriptor(propertyId) ?? null
}

/**
 * 某属性行的字段模型（每次渲染重算）。
 *
 * 拒绝原因来自运行时共享读面（`buildField` 内部读
 * `Context#getFieldRejections()`），故这里不再需要任何会话参数。
 */
function fieldFor(propertyId: string) {
  const desc = descriptorOf(propertyId)
  if (!desc) return null
  return buildField(props.ctx, desc)
}

/** 草稿变化的**镜像**：已删除，本回调随之退役。
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
 * 把每个可编辑属性登记为**输入层的提交落点** —— 该登记**已删除**。
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

/**
 * 提交一个已解析值（boolean/枚举/滑块/色板）。
 *
 * 结算（记拒绝 / 清拒绝 / 写底栏）已在唯一写路由里做完——
 * 本组件**不再**维护第二份拒绝态，因此这里不处理 `outcome`。
 */
function onCommitValue(desc: PropertyDescriptor, value: unknown): void {
  commitFieldValue(props.ctx, desc, value as never)
}

/** 提交某分量。 */
function onCommitComponent(desc: PropertyDescriptor, index: number, value: number): void {
  commitFieldComponent(props.ctx, desc, index, value)
}

/**
 * ## 本组件的"提交落点登记"已删除
 *
 * 旧实现在这里遍历模型、把每个可编辑描述符注册成一张**闭包表**的一行
 * （`field:<描述符 id>` → 「用唯一写路由提交这个值」），供输入端口按 `controlId` 回查。
 * 那条链让命令的落点依赖**组件是否挂载**（没挂载 ⇒ `controlNotRegistered`，
 * 表现为"输入了没反应"）。现在解析在边界层
 * （`editors/workbench-rna#commitDraftControlValue`：控件 id → 描述符注册表 →
 * 唯一写路由），于是落点是**装配事实**而不是组件生命周期事实，本文件不再持有它。
 *
 * ## 草稿 flush 循环已删除
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

/**
 * ## **呈现层**的 section 分组（方块检查器）
 *
 * 设计简报 C4 要求：身份 / 坐标 / 说明（逐格说明与方块 Tooltip **分开**，
 * SPEC §3.5 两种对象不混）。这**不是**改模型：`BLOCK_LAYOUT` 仍是
 * 「标识（id/tooltip/cellTooltip）+ 位置（pos）」两节，`buildInspectorModel`
 * 与 `BLOCK_DECL` 一字未动；本组件只是把同一批行**重新分节呈现**，
 * 于是读取路径、写路径、重算信号全部保持原状。
 *
 * 非方块对象类型（注解、场景元信息、发布配置……）仍按模型自带的分节渲染 ——
 * 那一侧的分节语义属于各自的布局规格，本组件不重新解释。
 */
interface PresentationSection {
  id: string
  label: string
  rows: readonly InspectorRow[]
}

/**
 * 方块字段的呈现分组。
 *
 * ⚠️ 键是 `InspectorRow.localId` —— `editors/inspector#localIdOf` 取**第一个点之后**的整段
 * （`'lightning.block.pos'` ⇒ `'block.pos'`），不是末段。实测踩过：按末段分组会让
 * 四个字段全部落到「其他」。
 */
const BLOCK_PRESENTATION: readonly { id: string; label: string; properties: readonly string[] }[] = [
  { id: 'b1.identity', label: '身份', properties: ['block.id'] },
  { id: 'b1.position', label: '坐标', properties: ['block.pos'] },
  { id: 'b1.tooltip', label: '说明', properties: ['block.tooltip'] },
  { id: 'b1.cell-tooltip', label: '单元格 Tooltip', properties: ['block.cellTooltip'] },
]

const presentationSections = computed<readonly PresentationSection[]>(() => {
  const sections = model.value.sections
  if (model.value.objectTypeId !== OBJECT_TYPE.block) {
    return sections.map((s) => ({
      id: s.id,
      label: s.display.fallback ?? s.display.labelKey,
      rows: s.rows,
    }))
  }

  const byLocalId = new Map<string, InspectorRow>()
  for (const s of sections) for (const row of s.rows) byLocalId.set(row.localId, row)

  const out: PresentationSection[] = []
  const placed = new Set<string>()
  for (const group of BLOCK_PRESENTATION) {
    const rows: InspectorRow[] = []
    for (const propertyId of group.properties) {
      const row = byLocalId.get(propertyId)
      if (!row) continue
      placed.add(propertyId)
      rows.push(row)
    }
    if (rows.length > 0) out.push({ id: group.id, label: group.label, rows })
  }
  // 未来新增的方块属性：落到「其他」，不静默丢弃（生成式补齐的可见性同样适用）。
  const rest = [...byLocalId.values()].filter((row) => !placed.has(row.localId))
  if (rest.length > 0) out.push({ id: 'b1.rest', label: '其他', rows: rest })
  return out
})

/** section 收合状态：组件内即可（设计明说不持久化，后续再议）。 */
const collapsed = ref<Record<string, boolean>>({})
function toggleSection(id: string): void {
  collapsed.value[id] = !collapsed.value[id]
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

      <!--
        分节头可点击收合。用 v-show（**不卸载**字段）：PropertyField 的输入
        控件绑定/文本草稿由输入层结算，卸载会把它当 target-invalid 收尾。
      -->
      <section v-for="section in presentationSections" :key="section.id" class="inspector-section">
        <button
          type="button"
          class="inspector-section-label"
          :aria-expanded="!collapsed[section.id]"
          @click="toggleSection(section.id)"
        >
          <span class="inspector-section-caret" aria-hidden="true">{{ collapsed[section.id] ? '▸' : '▾' }}</span>
          {{ section.label }}
        </button>

        <div v-show="!collapsed[section.id]" class="inspector-section-body">
          <template v-for="row in section.rows" :key="row.localId">
            <PropertyField
              v-if="fieldFor(row.field.descriptor.id)"
              :field="fieldFor(row.field.descriptor.id)!"
              @commit-value="(v: unknown) => onCommitValue(row.field.descriptor, v)"
              @commit-component="(i: number, v: number) => onCommitComponent(row.field.descriptor, i, v)"
            />
          </template>
        </div>
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
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  font-size: 10px;
  font-weight: 600;
  color: var(--wb-text-dim);
  /* 不经 text-transform：分组标题是中文文案（「单元格 Tooltip」），大写化会改写呈现文字。 */
  letter-spacing: 0.4px;
  text-align: left;
  cursor: pointer;
}
.inspector-section-label:hover { color: var(--wb-text); }
.inspector-section-caret { width: 10px; flex-shrink: 0; font-size: 9px; }
.inspector-section-body { display: flex; flex-direction: column; gap: 6px; padding-top: 6px; }
</style>
