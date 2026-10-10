/**
 * `editors/builtinEditors` —— 内置编辑器类型的**实现绑定**（#249 §10；A21）。
 *
 * ## 与 `composition/profiles` 的分工
 *
 * | 文件 | 回答的问题 | 依赖 |
 * |---|---|---|
 * | `composition/profiles` | "本装配**采纳**了哪些编辑器类型"（能力 + 裁剪政策） | 只依赖 `composition/modules` |
 * | 本文件 | "编辑器类型 X 用**哪个组件**、持有哪些资源" | 由**调用方**注入组件 |
 *
 * ## 为什么这里**不 import 任何编辑器组件**（P6 实测修正）
 *
 * 初版在本文件 `import WorkbenchViewport from '@/workbench/components/WorkbenchViewport.vue'`，
 * 立刻被 `npm run test:arch` 的 `gate/no-private-cross-layer` 判红：
 * `editors/builtinEditors.ts`（新实现）导入了 `workbench/components/WorkbenchViewport`
 * （深度 3 > 公共出口 2）。那条判据是对的 —— 它抓住了"新层直接拽旧实现"这一形态，
 * 而那正是 #171 禁止的。
 *
 * ⇒ 本文件只声明**类型的资源清单与元数据**；**组件由调用方注入**
 * （`AreaHost` 的 `:is` 由外壳在挂载时给出）。于是：
 *   - `editors/` 层不含对 `workbench/` 的引用（边界干净）；
 *   - 旧组件仍在旧位置（`workbench/`）用着，直到出现真实的替代者
 *     （#171：已替代路径同批退出；这里**尚未**替代，故旧位置不动）；
 *   - 新层的能力（类型注册、资源显式声明、生命周期记账）**已经**生效 ——
 *     这不是空接口，`AreaHost.vue` 与 `useAreaHost.ts` 是真实消费者。
 *
 * 这一处修正让"新层建成"与"旧实现退役"分离得干干净净：
 * 前者是本批的交付，后者需要先有替代组件（归 #261 集成闭环）。
 */

import { createEditorTypeRegistry, PRESENTATION_RESOURCES, VIEWPORT3D_RESOURCES } from './areaRegistry'

export const editorTypeRegistry = createEditorTypeRegistry()

/**
 * 3D 视口：持 6 类资源（见 `VIEWPORT3D_RESOURCES` 的逐条说明）。
 *
 * `requiresDocument: true` —— 没有文档时它没有可渲染的内容，
 * `AreaHost` 会显示明确空态而不是挂一个空 canvas。
 */
editorTypeRegistry.register({
  editorType: 'viewport3d',
  resources: VIEWPORT3D_RESOURCES,
  requiresDocument: true,
})

/**
 * Inspector / 时间轴 / 通道：**只读呈现型**。
 *
 * 它们的组件由外壳提供（P6 的接线里由 `WorkbenchRoot` 的属性面板与
 * `ViewportFrameLayerDock` 呈现，不是独立 Area 组件）。注册它们仍必要 ——
 * 因为"资源种类"必须显式（`PRESENTATION_RESOURCES`），
 * 否则 A13 的资源对账会漏项。
 */
for (const editorType of ['inspector', 'timeline', 'channels'] as const) {
  editorTypeRegistry.register({
    editorType,
    resources: PRESENTATION_RESOURCES,
    requiresDocument: false,
  })
}

/**
 * A21 的扩展证明：文字类型的编辑器落点。
 *
 * 本批不交付文字编辑器产品（#249 §13：「文字类型可用契约夹具证明扩展，
 * 不要求本次完成文字编辑产品」），但它的**注册**证明两件事：
 *  1. 新增编辑器类型不改任何核心分支（没有 `switch`）；
 *  2. 新类型的资源种类必须显式声明（否则漏项）。
 */
editorTypeRegistry.register({
  editorType: 'editor.text',
  resources: PRESENTATION_RESOURCES,
  requiresDocument: true,
})

/** 全部已注册类型（供诊断与测试对账）。 */
export const REGISTERED_EDITOR_TYPES: readonly string[] = editorTypeRegistry.list()
