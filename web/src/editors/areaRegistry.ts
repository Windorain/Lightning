/**
 * `editors/areaRegistry` —— **编辑器类型 → 组件 + 资源种类**的注册表
 * （#249 §10「编辑器」贡献类；#257 A21「不改核心 switch」）。
 *
 * ## 为什么是注册表而不是 `switch`
 *
 * A21 的判据之一是「无需改 execution/装配解析器/**既有对象分支**」。
 * 同理，把 `editorType` 映射到组件也不能用 `switch`：
 * 新增一个编辑器类型（例如 A21 的 `editor.text`）必须只是**多注册一条**，
 * 而不是在某个中心函数里多加一个 `case`。
 *
 * 与 `composition` 的分工：
 *  - `composition/modules` 声明"我**贡献**了编辑器类型 X"（能力与裁剪政策）；
 *  - `editors/areaRegistry` 声明"编辑器类型 X 长什么样、持有哪些资源"（实现绑定）。
 *
 * 两者分开的理由是所有权：#257 明说"能力缺失则启动失败、可选落点被裁剪"是
 * **装配**政策；而"X 用哪个 Vue 组件"是**呈现**细节，不该进装配解析器
 * （那会让解析器依赖 Vue）。
 *
 * ## 资源种类是**声明**，不是实现细节
 *
 * `resources` 列出一个编辑器类型挂载时必须 acquire 的资源种类。
 * 它必须在注册表里**显式**声明 —— 因为漏声明会让
 * `AreaHost` 少 acquire 一样，从而让 A13 的资源基线**假绿**
 * （账本上少了一笔，回收后自然为 0）。声明在注册表里使它可以被审查。
 */

import type { EditorTypeId } from '@/domain/workspace'

export interface EditorTypeRegistration {
  readonly editorType: EditorTypeId
  /**
   * 该类型的真实组件。
   *
   * ## 注册时**不给**组件，由调用方注入（P6 实测修正）
   *
   * 初版让 `builtinEditors.ts` 直接 `import WorkbenchViewport from
   * '@/workbench/components/WorkbenchViewport.vue'` —— 边界扫描立刻判红
   * （`gate/no-private-cross-layer`：新层导入旧层深度 3 的实现）。
   * 现在这里只声明"该类型需要什么样的组件"（`componentSlot`），
   * 真组件由外壳在挂载时按 **region/类型 → 组件** 的映射给出。
   *
   * 于是 `editors/` 层**零依赖**旧 `workbench/`，而"类型 → 组件"的绑定
   * 仍是装配的事（不是核心 `switch`）。
   */
  readonly componentSlot?: string
  /**
   * 挂载时必须 acquire 的资源种类。
   *
   * 空数组是合法的（纯计算型编辑器没有 GPU/DOM 资源），
   * 但**必须显式写出来** —— 省略字段与"确实没有资源"是两件事。
   */
  readonly resources: readonly string[]
  /** 该类型是否需要文档才能有意义地渲染（决定 `AreaHost` 的空态呈现）。 */
  readonly requiresDocument: boolean
}

/**
 * 编辑器类型注册表（**不**含 `switch`）。
 *
 * `register` 对重复 id 返回 `false`（不静默覆盖）：
 * #249 §10「注册顺序不应产生隐藏覆盖结果」在**组件层**的同一纪律。
 */
export class EditorTypeRegistry {
  private readonly byType = new Map<EditorTypeId, EditorTypeRegistration>()

  register(reg: EditorTypeRegistration): boolean {
    if (this.byType.has(reg.editorType)) return false
    this.byType.set(reg.editorType, reg)
    return true
  }

  get(editorType: EditorTypeId): EditorTypeRegistration | undefined {
    return this.byType.get(editorType)
  }
  /** 已注册的类型 id（稳定排序，供对账与诊断）。 */
  list(): readonly EditorTypeId[] {
    return Object.freeze([...this.byType.keys()].sort())
  }

  /** 该类型挂载时要 acquire 的资源；**未注册**的类型返回空数组（失败关闭：不多占资源）。 */
  resourcesOf(editorType: EditorTypeId): readonly string[] {
    return this.byType.get(editorType)?.resources ?? Object.freeze([])
  }

  /** 该类型的组件槽位名（未注册时为 `null`）。调用方据此从**自己的**映射取组件。 */
  componentSlotOf(editorType: EditorTypeId): string | null {
    return this.byType.get(editorType)?.componentSlot ?? null
  }
}

export function createEditorTypeRegistry(): EditorTypeRegistry {
  return new EditorTypeRegistry()
}

/**
 * 3D 视口持有的资源种类（A13 的资源基线按这些种类分项对账）。
 *
 * 命名与真实句柄一一对应，使 `runtime/lifecycle` 的计数能落到具体东西上：
 *  1. `renderer` —— `drw.dispose()` 释放的 Three WebGLRenderer；
 *  2. `webglContext` —— GPU 上下文本身（A30 图形恢复的归属物）；
 *  3. `resizeObserver` —— `useEmbedLayoutProfile`/面板调尺寸的观察者；
 *  4. `hoverListener` —— `attachViewport` 注册的 region handler 链；
 *  5. `frameHook` —— `RenderEngineHost.addFrameHook` 的逐帧回调；
 *  6. `multiblockChannelState` —— 视口本地的通道暂存（B5 #4 的消费者面）。
 */
export const VIEWPORT3D_RESOURCES: readonly string[] = Object.freeze([
  'renderer',
  'webglContext',
  'resizeObserver',
  'hoverListener',
  'frameHook',
  'multiblockChannelState',
])

/** 只读呈现型编辑器（Inspector/时间轴/通道）持有：DOM 订阅 + 面板状态。 */
export const PRESENTATION_RESOURCES: readonly string[] = Object.freeze([
  'domSubscription',
  'panelState',
])
