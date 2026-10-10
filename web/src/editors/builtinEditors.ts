/**
 * `editors/builtinEditors` —— 内置编辑器类型的**实现绑定**（#249 §10；A21）。
 *
 * ## 与 `composition/profiles` 的分工
 *
 * | 文件 | 回答的问题 | 依赖 |
 * |---|---|---|
 * | `composition/profiles` | "本装配**采纳**了哪些编辑器类型"（能力 + 裁剪政策） | 只依赖 `composition/modules` |
 * | 本文件 | "编辑器类型 X 用**哪个组件**、持有哪些**资源**" | 依赖 Vue 组件 |
 *
 * 分开的理由：装配解析器**不得**依赖 Vue（契约 §7.1 规则 2）。
 * 若把组件塞进 `ModuleDecl`，解析器就会被拖进组件世界，
 * 那正是旧实现里"宿主开关与组件纠缠"的同构问题。
 *
 * ## A21 的扩展在这里的样子
 *
 * 新增一个编辑器类型 = 在本文件**多注册一条**（`editor.text` 在两处出现：
 * `composition/profiles` 的 `M_TEXT_EDITOR` 声明能力，本文件的 `register` 绑定组件）。
 * **不需要**改 `AreaHost.vue`、`useAreaHost.ts` 或解析器 —— 一条 `switch` 都没有。
 */

import { createEditorTypeRegistry, PRESENTATION_RESOURCES, VIEWPORT3D_RESOURCES } from './areaRegistry'
import WorkbenchViewport from '@/workbench/components/WorkbenchViewport.vue'

export const editorTypeRegistry = createEditorTypeRegistry()

/**
 * 3D 视口：持 6 类资源（见 `VIEWPORT3D_RESOURCES` 的逐条说明）。
 *
 * `requiresDocument: true` —— 没有文档时它没有可渲染的内容，
 * `AreaHost` 会显示明确空态而不是挂一个空 canvas。
 */
editorTypeRegistry.register({
  editorType: 'viewport3d',
  component: WorkbenchViewport,
  resources: VIEWPORT3D_RESOURCES,
  requiresDocument: true,
})

/**
 * Inspector / 时间轴 / 通道：**只读呈现型**，由工作台面板承载。
 *
 * `component: null` 是**如实**的：这三个类型在 P6 的接线里由
 * `WorkbenchRoot` 的属性面板与 `ViewportFrameLayerDock` 呈现，
 * 不是独立 Area 组件。注册它们仍必要 —— 因为"资源种类"必须显式
 * （`PRESENTATION_RESOURCES`），否则 A13 的资源对账会漏项。
 *
 * 它们的 `component` 由后续批次（#261 集成闭环）替换为真实组件；
 * **本批不留假组件**：`null` 让 `AreaHost` 显示"该落点在本装配中不可用"，
 * 而不是挂一个空接口冒充支持（#249 §13 明文）。
 */
for (const editorType of ['inspector', 'timeline', 'channels'] as const) {
  editorTypeRegistry.register({
    editorType,
    component: null,
    resources: PRESENTATION_RESOURCES,
    requiresDocument: false,
  })
}

/**
 * A21 的扩展证明：文字类型的编辑器落点。
 *
 * 它复用 `inspector` 的呈现方式（本批不交付文字编辑器产品 ——
 * #249 §13：「文字类型可用契约夹具证明扩展，不要求本次完成文字编辑产品」），
 * 但它的**注册**证明了两件事：
 *  1. 新增编辑器类型不改任何核心分支（没有 `switch`）；
 *  2. 新类型的资源种类必须显式声明（否则漏项）。
 */
editorTypeRegistry.register({
  editorType: 'editor.text',
  component: null,
  resources: PRESENTATION_RESOURCES,
  requiresDocument: true,
})

/** 全部已注册类型（供诊断与测试对账）。 */
export const REGISTERED_EDITOR_TYPES: readonly string[] = editorTypeRegistry.list()
