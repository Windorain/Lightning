/**
 * `composition/profiles` —— **工作台 / 嵌入（查看器）/ Wiki / 无界面的模块集合**（#249 §10；契约 §7）。
 *
 * ## 本模块替代的旧机制（B5 退役矩阵 #7）
 *
 * 「工作台/嵌入分叉功能与宿主开关」的替代物就是**这里的 profile 表**。
 * 旧实现的分叉形态（逐条对照，见 `boundary-rules.mjs` 的
 * `RETIREMENT_OWNERS['workbench-embed-fork']`）：
 *
 * | 旧形态 | 本模块的替代 |
 * |---|---|
 * | `runtime/hostProfile.ts` 模块级 `let hostProfile` | profile 是**值**：四个 `ProfileDecl` 常量，解析结果作参数传下去 |
 * | `import.meta.env.VITE_HOST_PROFILE === 'wiki'` 出现在组件里 | 组件不读任何 profile；差异全部落在**装配结果**（哪些模块被采纳、哪些落点被裁剪） |
 * | `if (hostProfile === 'wiki')` 等 19 处宿主分支 | `requires`/`optionalRequires` 声明 + 落点裁剪，全部可查询（`Assembly.pruned` / `prunedLandings`） |
 * | 嵌入与工作台各写一套功能 | `SHARED_FUNCTIONAL_MODULES` 是**同一批对象引用**，四个 profile 共用 |
 *
 * ## 「公共功能模块复用」怎么被证明
 *
 * `SHARED_FUNCTIONAL_MODULES` 里的每一项都是**同一个 `ModuleDecl` 对象**，
 * 被四个 profile 的 `composes` 同时引用。于是"公共时间轴/通道/视口复用"
 * 不是文档承诺，而是 `Object.is` 级可断言的事实。
 *
 * ## 四个 profile 的语义一致性（#257 H3）
 *
 * 「工作台/Wiki/无界面 profile 的**对象、时间、通道语义一致**」的落地方案：
 * 对象类型、求值、时间、通道这四组模块**全部**在 `SHARED_FUNCTIONAL_MODULES` 里。
 * `CORE_SEMANTIC_CAPABILITIES` 把"必须一致"的那组能力名显式列出，
 * 供测试对四个 profile 逐一断言 —— 于是"嵌入里的时间语义不一样"这类退化
 * 会在**装配层**就被抓住，而不是等到运行期。
 *
 * ## 查看器（A15）就是嵌入 profile
 *
 * A15 `viewer-pruning` 的"查看器构建"在本批对应 **`EMBED_PROFILE`**：
 * `#249` §13 要求「工作台与嵌入外壳使用共同功能模块，并**证明嵌入构建裁剪内容编辑实现**」。
 * 因此 `EMBED_PROFILE` 的装配结果必须具备三个可断言事实：
 *  1. 无 `content.edit` / `content.add` / `content.delete` 能力；
 *  2. 无 `tools.manipulators`、无内容编辑命令落点；
 *  3. **仍**有求值、播放、通道（A15 明文"播放/通道仍可用"）。
 */

import { CAPABILITY, moduleDecl, type CapabilityId, type ModuleDecl, type ProfileId } from './modules'
import { kernelObjectSelfDecls } from '@/application/kernel-properties'

// ─────────────────────────────────────────────────────────────────────────────
// 内核模块（所有 profile 都取）
// ─────────────────────────────────────────────────────────────────────────────

export const M_DOCUMENT = moduleDecl({
  id: 'kernel.document',
  provides: ['document.state', 'document.history', 'document.saveBaseline'],
  contributes: { evaluationNodes: [{ nodeId: 'node.document', dependsOn: [] }] },
  note: '文档内容/版本/历史/保存基线（P1 #252 交付）。',
})

export const M_EXECUTION = moduleDecl({
  id: 'kernel.execution',
  provides: ['execution.protocol'],
  requires: ['document.state'],
  note: '更新批次、原子发布、EditorClient 四方法面（P1 #252 交付）。',
})

export const M_EDIT_CONTEXT = moduleDecl({
  id: 'kernel.editContext',
  provides: ['edit.context', 'edit.selection'],
  requires: ['document.state'],
  note: '选择/时间/通道取值/活动交互暂存（P1 #252 交付）。',
})

export const M_WORKSPACE = moduleDecl({
  id: 'kernel.workspace',
  provides: ['workspace.layout', 'workspace.binding'],
  requires: ['edit.context'],
  note: 'Area 分割树、编辑器类型与固定目标、绑定（P6 #257，`domain/workspace`）。',
})

// ─────────────────────────────────────────────────────────────────────────────
// 交互（只读观察）：**四个 profile 都有**
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 只读观察交互：轨道机位、悬停、局部显示。
 *
 * 为什么它与内容编辑能力**分开**：P1 的能力闸门把 `beginInteraction`/`updateInteraction`
 * 挂在 `interaction.begin` 上、把 `commitInteraction` 挂在 `content.edit` 上。
 * 查看器需要前者（能转机位、能悬停），**绝不能**有后者（不能落盘内容）。
 * 把两者合成一个能力会让 A15 的"运行时拒绝写入"退化成"拒绝一切交互"——
 * 那会连带违反 A15 明文「播放/通道仍可用」。
 */
export const M_INTERACTION_OBSERVE = moduleDecl({
  id: 'interaction.observe',
  provides: [CAPABILITY.INTERACTION_BEGIN],
  requires: ['edit.context'],
  contributes: { commands: [{ commandId: 'beginInteraction', requires: [CAPABILITY.INTERACTION_BEGIN] }] },
  note: '只读观察交互（机位/悬停/局部显示）。内容落盘由 content.* 承载，两者必须分开。',
})

// ─────────────────────────────────────────────────────────────────────────────
// 对象类型（**公共功能模块**：所有 profile 语义一致 —— #257 H3）
// ─────────────────────────────────────────────────────────────────────────────

const BLOCK_TYPE = moduleDecl({
  id: 'objects.block',
  provides: ['objectType.block'],
  contributes: {
    objectTypes: [
      { type: 'block', dataKind: 'blockGrid', editable: true, animatableProperties: ['transform.position', 'transform.rotation', 'transform.scale'] },
    ],
  },
})

const ANNOTATION_TYPE = moduleDecl({
  id: 'objects.annotation',
  provides: ['objectType.annotation'],
  contributes: {
    objectTypes: [
      {
        type: 'annotation',
        dataKind: 'annotation',
        editable: true,
        animatableProperties: ['transform.position', 'transform.rotation', 'transform.scale', 'annotation.text'],
      },
    ],
  },
})

const CAMERA_TYPE = moduleDecl({
  id: 'objects.camera',
  provides: ['objectType.camera'],
  contributes: {
    objectTypes: [
      {
        type: 'camera',
        dataKind: 'camera',
        editable: true,
        animatableProperties: ['projection.fov', 'projection.clipStart', 'projection.clipEnd', 'transform.position', 'transform.rotation'],
      },
    ],
  },
})

export const M_OBJECT_TYPES: readonly ModuleDecl[] = Object.freeze([BLOCK_TYPE, ANNOTATION_TYPE, CAMERA_TYPE])

// ─────────────────────────────────────────────────────────────────────────────
// A21 扩展证明：**文字类型 + 专用控件**（经贡献接口新增，不改核心 switch）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A21 扩展证明（**对象类型 + 专用控件**）：四个 profile 共用。
 *
 * ## 为什么它必须在 `SHARED_FUNCTIONAL_MODULES` 里
 *
 * 一个**查看器**也要能显示文档里已有的文字对象 —— "知道有哪些对象类型"
 * 与"能不能编辑它们"是两件事（#249 §3.3：「多方块生成对象**可查询和拾取**，
 * 但写能力为只读」是同一分界）。若把类型贡献也按 profile 裁剪，
 * 查看器打开一份含文字对象的文档就会"看不见"它 —— 那是功能丢失，不是裁剪。
 *
 * 因此：**对象类型贡献是共享的**（四个 profile 的对象类型集合逐项相同，
 * 见 `CORE_SEMANTIC_CAPABILITIES` 与对应断言），
 * 而**编辑面**（`panels.inspectorEdit`、`tools.transformManipulators`、
 * `commands.content`）才是按 profile 裁剪的部分。
 *
 * 它通过**贡献接口**新增（A21 判据）：
 *  1. `contributes.objectTypes` 新增 `text` 类型；
 *  2. `contributes.controls` 新增专用控件（`annotation.text` → `textarea`）。
 *
 * **不改**以下任何一处：
 *  - `runtime/execution.ts`（执行器）；
 *  - `composition/resolver.ts`（装配解析器）；
 *  - 既有对象分支（`domain/scene.ts` 的 `DEFAULT_TYPES` 里**没有** `text`）。
 *
 * 它复用核心**已有的** `annotation` 数据载荷种类（该载荷本就带 `text?: string`）。
 * 这条分界是刻意的：「新增**对象类型**」是贡献方的开放集合，
 * 「新增**数据载荷种类**」是核心拥有的封闭集合。A21 只要求前者；
 * 若哪天要求后者也不改核心，说明骨架尚未成立（#249 §13 末段明文）。
 */
export const M_TEXT_OBJECT_TYPE = moduleDecl({
  id: 'objects.text',
  provides: ['objectType.text'],
  contributes: {
    objectTypes: [
      {
        type: 'text',
        dataKind: 'annotation',
        editable: true,
        animatableProperties: ['annotation.text', 'transform.position'],
        /**
         * ## RNA 声明（`#262` P11-F 段①：A21 的属性写半边）
         *
         * 这个字段是 **P11-E 实测缺口**的修复落点：贡献类型此前**没有通向**内核
         * 属性注册表/写端口的缝 ⇒ `reduceCommand` 对它结构性拒绝
         * （`MissingTarget: property-not-registered`）。带上声明后，
         * `composition/contributedObjectTypes` 把它派生进 `ExecutionInputs`，
         * 属性写经**唯一入口** `reduceCommand` 生效（判据：`assembly.test.ts` A21 组 ⑤）。
         *
         * ## 属性词汇为什么是这几个（不是"随手抄 annotation 一份"）
         *
         * 本类型复用了核心**已有**的 `annotation` 数据载荷（见本模块顶部说明：
         * 「新增**对象类型**」开放、「新增**数据载荷种类**」是核心拥有的封闭集合）。
         * 故可写的局部属性就是内核写面在 annotation 载荷上支持的词汇：
         *  `name`/`visible`（对象自身）、`transform.*`（对象自身）、`text`（载荷字段）。
         * 局部 ID 用 `text`（不是 `annotation.text`）—— 否则限定式 ID 会成为
         * `text.annotation.text`，把载荷种类名混进属性路径（与 `KERNEL_ANNOTATION_TYPE`
         * 处同一条判据）。
         *
         * `animatableProperties` **保持原样**（它自 GF-5 收敛后零生产消费者，
         * 是历史清单，本批不改它的口径 —— 改它属于语义变更，不在本批范围）。
         */
        rna: {
          id: 'text',
          ownerKind: 'object',
          display: { labelKey: 'objectType.text', fallback: '文字' },
          /**
           * 对象**自身**属性（`name`/`visible`/`transform.*`）取内核的公共构造器 ——
           * 它们是 `SceneObject` 的字段（核心拥有的词汇），**每个**对象类型共用同一份
           * 声明（调用同一个 `applyKernelPropertyValue`）。类型特有的载荷属性
           * （下面的 `text`）由贡献方自己声明。
           */
          properties: [
            ...kernelObjectSelfDecls(),
            { id: 'text', valueType: 'string', animatable: false, display: { labelKey: 'annotation.text', fallback: '内容' } },
          ],
        },
      },
    ],
    controls: [{ property: 'annotation.text', controlId: 'textarea' }],
  },
  note: 'A21 扩展证明：经贡献接口新增文字类型与专用控件（不改 execution/解析器/既有对象分支）。',
})

/**
 * 文字类型的**编辑**落点（A21 的编辑器部分；按 profile 取舍）。
 *
 * 与 `M_TEXT_OBJECT_TYPE` 分开的理由是上一条注释的原则：
 * 类型贡献共享、编辑面裁剪。工作台/Wiki 需要它（要能编文字），
 * 查看器不需要（`objects.text` 已让查看器认识该类型）。
 */
export const M_TEXT_EDITOR = moduleDecl({
  id: 'editors.text',
  provides: [CAPABILITY.TEXT_EDIT],
  requires: ['objectType.text', 'edit.context'],
  contributes: {
    editors: [{ editorType: 'editor.text', requires: [CAPABILITY.TEXT_EDIT], contentEditing: true }],
    commands: [{ commandId: 'setAnnotationText', requires: [CAPABILITY.CONTENT_EDIT] }],
  },
  note: '文字类型的编辑落点（专用控件之外还需要一个编辑器类型落点）。',
})

// ─────────────────────────────────────────────────────────────────────────────
// 内容编辑（**查看器必须没有它们**，A15）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 文档持久化（本地文件保存）。
 *
 * `save.write` 是 P1 `ALL_CAPABILITIES` 里的一项，且它**不是**内容编辑能力 ——
 * 契约 §4 把"保存"与"编辑"分开（A16 保存竞态独立成项）。
 * 查看器（嵌入）**不**引用它：嵌入不提供保存面；工作台/Wiki/无界面都有。
 */
const M_SAVE_LOCAL = moduleDecl({
  id: 'persistence.saveLocal',
  provides: [CAPABILITY.SAVE_WRITE],
  requires: ['document.state'],
  contributes: { commands: [{ commandId: 'save', requires: [CAPABILITY.SAVE_WRITE] }] },
  note: '本地文件保存（工程保存；保存基线由文档状态域拥有）。',
})

/**
 * 内容编辑命令与能力（**查看器必须没有它们**，A15）。
 *
 * 它**不** provides `interaction.begin`：只读观察交互由
 * `M_INTERACTION_OBSERVE` 独立提供，且四个 profile 都有它 ——
 * 这样"查看器能转机位"与"查看器不能落盘内容"两件事互不牵连。
 */
const M_CONTENT_COMMANDS = moduleDecl({
  id: 'commands.content',
  provides: [CAPABILITY.CONTENT_EDIT, CAPABILITY.CONTENT_ADD, CAPABILITY.CONTENT_DELETE],
  requires: ['document.state', 'edit.context', CAPABILITY.INTERACTION_BEGIN],
  contributes: {
    commands: [
      { commandId: 'addObject', requires: [CAPABILITY.CONTENT_ADD] },
      { commandId: 'deleteObject', requires: [CAPABILITY.CONTENT_DELETE] },
      { commandId: 'setProperty', requires: [CAPABILITY.CONTENT_EDIT] },
      { commandId: 'setTransform', requires: [CAPABILITY.CONTENT_EDIT] },
      { commandId: 'commitInteraction', requires: [CAPABILITY.CONTENT_EDIT] },
    ],
  },
  note: '内容编辑命令与能力。查看器/无界面 profile **不引用**它。',
})

/**
 * 操纵工具（gizmo）。
 *
 * A15 明文要求它**不在**查看器构建的可达模块图里 ——
 * 本模块是一个**独立模块**（不是 `commands.content` 里的一个数组元素），
 * 就是为了让"查看器装配结果里没有这个模块 id"成为可断言的事实。
 */
export const M_MANIPULATORS = moduleDecl({
  id: 'tools.transformManipulators',
  provides: ['tools.manipulators'],
  requires: [CAPABILITY.CONTENT_EDIT, CAPABILITY.INTERACTION_BEGIN],
  contributes: { commands: [{ commandId: 'gizmo.translate', requires: [CAPABILITY.CONTENT_EDIT] }] },
  note: '操纵工具（gizmo/平移/旋转/缩放）。查看器构建不得可达。',
})

/** 属性写控件（内容编辑的 UI 面；查看器不得有）。 */
export const M_EDIT_PANELS = moduleDecl({
  id: 'panels.inspectorEdit',
  provides: ['inspector.editPanels'],
  requires: [CAPABILITY.CONTENT_EDIT],
  contributes: {
    controls: [{ property: 'transform.position', controlId: 'vec3' }],
  },
  note: '内容编辑属性面板。查看器不得有（A15：只隐藏按钮仍会导入编辑模块 ⇒ 判红）。',
})

// ─────────────────────────────────────────────────────────────────────────────
// 求值 / 拾取 / 播放 / 通道（**公共功能模块**）
// ─────────────────────────────────────────────────────────────────────────────

/** 场景求值（P4 #255 交付；本模块声明其装配位置）。 */
const M_EVALUATION = moduleDecl({
  id: 'evaluation.scene',
  provides: [CAPABILITY.EVALUATE],
  requires: ['document.state', 'edit.context'],
  contributes: {
    evaluationNodes: [
      { nodeId: 'node.scene', dependsOn: ['node.document'] },
      { nodeId: 'node.channels', dependsOn: ['node.scene'] },
      { nodeId: 'node.textures', dependsOn: [] },
    ],
  },
  note: '求值场景/依赖图/通道装配（P4 #255）。',
})

const M_PICKING = moduleDecl({
  id: 'picking.objects',
  provides: [CAPABILITY.PICKING],
  requires: [CAPABILITY.EVALUATE],
  note: '对象拾取接线与版本映射。',
})

/**
 * 播放时间轴 —— **能力组合**，不是专用调度器
 *（#257「编辑时间轴与播放时间轴经能力组合共用时间与采样模型」）。
 *
 * 关键：本模块**不** provides 任何"时间"实现，它 requires `evaluate`。
 * 于是"共用时间与采样模型"由 `evaluation.scene` **唯一**供给。
 * 若哪天有人为播放另建一个时间源，本表里就会出现第二个 provides `evaluate` 的模块
 * ⇒ 被能力并集审查发现（`capabilityOwners` 返回多主）。
 */
const M_TIMELINE_PLAYBACK = moduleDecl({
  id: 'timeline.playback',
  provides: ['timeline.playback'],
  requires: [CAPABILITY.EVALUATE, 'edit.context'],
  note: '播放时间轴：经能力组合共用求值器与采样策略（无专用播放循环）。',
})

/** 编辑时间轴（拖动时间、跳帧）——同一个求值器。 */
const M_TIMELINE_EDIT = moduleDecl({
  id: 'timeline.edit',
  provides: ['timeline.edit'],
  requires: [CAPABILITY.EVALUATE, 'edit.context'],
  contributes: { commands: [{ commandId: 'setTime', requires: [] }] },
  note: '编辑时间轴：与播放时间轴共用同一时间与采样模型。',
})

/** 通道栏（通道取值属编辑上下文）。 */
const M_CHANNELS = moduleDecl({
  id: 'channels.panel',
  provides: ['channels.panel'],
  requires: [CAPABILITY.EVALUATE, 'edit.context'],
  contributes: { commands: [{ commandId: 'setChannelValue', requires: [] }] },
  note: '通道取值/面板：取值属 EditContext，四个 profile 共用。',
})

/**
 * 共享的公共功能模块（**四个 profile 引用同一批对象引用**）。
 *
 * 改这一个数组即改所有 profile 的核心语义 —— 这正是 #249 §13 要的
 * 「工作台与嵌入外壳使用共同功能模块」。
 */
export const SHARED_FUNCTIONAL_MODULES: readonly ModuleDecl[] = Object.freeze([
  M_DOCUMENT,
  M_EXECUTION,
  M_EDIT_CONTEXT,
  M_WORKSPACE,
  M_INTERACTION_OBSERVE,
  BLOCK_TYPE,
  ANNOTATION_TYPE,
  CAMERA_TYPE,
  M_TEXT_OBJECT_TYPE,
  M_EVALUATION,
  M_PICKING,
  M_TIMELINE_PLAYBACK,
  M_TIMELINE_EDIT,
  M_CHANNELS,
])

/**
 * 「对象、时间、通道语义一致」的**显式能力清单**（#257 H3 的判据面）。
 *
 * ## 为什么**不含** `picking` / `interaction.begin`
 *
 * H3 的原文是「工作台/Wiki/**无界面** profile 的**对象、时间、通道**语义一致」。
 * 无界面 profile 没有指针与视口，`picking`（对象拾取）与 `interaction.begin`
 * （指针交互）本就不适用 —— 把这两项塞进一致性清单会让判据
 * 要求"无界面必须有拾取"，那是把一致性判据用成了功能清单（过宽）。
 *
 * 它们是**有视口的外壳**才需要的能力，由 `WORKBENCH/WIKI/EMBED` 三者各自声明；
 * 一致性判据只覆盖**语义**（对象类型集合、时间模型、通道取值归属），
 * 而这三样恰好是四个 profile 都必须相同的。
 */
export const CORE_SEMANTIC_CAPABILITIES: readonly CapabilityId[] = Object.freeze([
  'document.state',
  'edit.context',
  'workspace.layout',
  'workspace.binding',
  'objectType.block',
  'objectType.annotation',
  'objectType.camera',
  'objectType.text',
  CAPABILITY.EVALUATE,
  'timeline.playback',
  'timeline.edit',
  'channels.panel',
])

// ─────────────────────────────────────────────────────────────────────────────
// 编辑器落点（P6 交付的 `editors/*`）
// ─────────────────────────────────────────────────────────────────────────────

/** 3D 视口。**不**提供内容编辑面（拖动由 `commands.content` 的能力承载）。 */
const M_EDITOR_VIEWPORT3D = moduleDecl({
  id: 'editors.viewport3d',
  provides: ['editor.viewport3d'],
  requires: [CAPABILITY.EVALUATE, CAPABILITY.PICKING, CAPABILITY.INTERACTION_BEGIN],
  contributes: {
    editors: [{ editorType: 'viewport3d', requires: [CAPABILITY.EVALUATE, CAPABILITY.PICKING], contentEditing: false }],
  },
  note: '3D 视口：观察视角/局部显示归实例，切回保留（#249 §3.4）。',
})

/** Inspector 面板落点（**只读**容器；四个 profile 里只有工作台/Wiki 取它）。 */
const M_INSPECTOR_PANELS = moduleDecl({
  id: 'panels.inspector',
  provides: ['inspector.panels'],
  requires: ['edit.context'],
  note: 'Inspector 面板容器落点（只读呈现）。',
})

/**
 * Inspector（属性检查器）。
 *
 * `optionalRequires: [inspector.panels]` —— 这就是 A14「**可选落点被裁剪并记录原因**」
 * 的**真实**案例（不是测试专用夹具）：
 *  - 工作台/Wiki profile 引用 `panels.inspector` ⇒ Inspector 落点被采纳；
 *  - **嵌入 profile 不引用它** ⇒ `editor.inspector` 落点被**裁剪**，
 *    `Assembly.prunedLandings` 留下
 *    `{ kind:'editor', id:'inspector', missingCapability:'inspector.panels' }`。
 *
 * 它**不是**"模块整个被丢掉"（那会过宽）：Inspector 模块的其余贡献照常生效。
 */
const M_EDITOR_INSPECTOR = moduleDecl({
  id: 'editors.inspector',
  provides: ['editor.inspector'],
  requires: ['edit.context'],
  optionalRequires: ['inspector.panels'],
  contributes: {
    editors: [{ editorType: 'inspector', requires: ['inspector.panels'], contentEditing: false }],
  },
  note: '属性检查器（由 RNA 生成控件，只读呈现本身；写面见 panels.inspectorEdit）。',
})

const M_EDITOR_TIMELINE = moduleDecl({
  id: 'editors.timeline',
  provides: ['editor.timeline'],
  requires: ['timeline.edit', 'timeline.playback'],
  contributes: { editors: [{ editorType: 'timeline', requires: ['timeline.edit'], contentEditing: false }] },
})

const M_EDITOR_CHANNELS = moduleDecl({
  id: 'editors.channels',
  provides: ['editor.channels'],
  requires: ['channels.panel'],
  contributes: { editors: [{ editorType: 'channels', requires: ['channels.panel'], contentEditing: false }] },
})

export const M_EDITORS: readonly ModuleDecl[] = Object.freeze([
  M_EDITOR_VIEWPORT3D,
  M_EDITOR_INSPECTOR,
  M_INSPECTOR_PANELS,
  M_EDITOR_TIMELINE,
  M_EDITOR_CHANNELS,
])

// ─────────────────────────────────────────────────────────────────────────────
// 布局与外壳
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 布局编辑命令（分割/合并/切类型/调尺寸/恢复）。
 *
 * ## 「嵌入配置省略布局编辑命令」（#257 明文）
 *
 * 嵌入 profile **不引用**本模块 ⇒ 装配结果里没有 `layout.edit` / `layout.restore`
 * ⇒ 嵌入壳体的布局编辑命令在**装配层**就不存在（不是"UI 上藏了按钮"）。
 * 这就是"可调整布局 vs 固定布局"的机器可检查形态。
 */
const M_LAYOUT_EDIT = moduleDecl({
  id: 'layout.editCommands',
  provides: [CAPABILITY.LAYOUT_EDIT, CAPABILITY.LAYOUT_RESTORE],
  requires: ['workspace.layout'],
  contributes: {
    commands: [
      { commandId: 'splitArea', requires: [CAPABILITY.LAYOUT_EDIT] },
      { commandId: 'mergeArea', requires: [CAPABILITY.LAYOUT_EDIT] },
      { commandId: 'setEditorType', requires: [CAPABILITY.LAYOUT_EDIT] },
      { commandId: 'setSplitRatio', requires: [CAPABILITY.LAYOUT_EDIT] },
      { commandId: 'restoreWorkspace', requires: [CAPABILITY.LAYOUT_RESTORE] },
    ],
  },
  note: '布局编辑命令。嵌入 profile 不引用它 ⇒ 固定布局（#257 明文）。',
})

/** 工作台外壳：**可调整 Area 布局**。 */
export const M_SHELL_WORKBENCH = moduleDecl({
  id: 'shells.workbench',
  provides: ['shell.workbench'],
  requires: [CAPABILITY.LAYOUT_EDIT, CAPABILITY.LAYOUT_RESTORE, 'workspace.layout'],
  contributes: {
    shellLayouts: [
      { shellId: 'workbench', adjustableLayout: true, regions: ['viewport', 'inspector', 'timeline', 'channels', 'toolshelf', 'menubar', 'statusbar'] },
    ],
  },
  note: '工作台外壳：可调整 Area 布局。',
})

/**
 * 嵌入外壳：**固定布局、省略布局编辑命令**。
 *
 * 注意它 `requires` 的是 `workspace.layout`（布局**模型**）而**不是** `layout.edit`
 * —— 于是"嵌入也有 Area 布局模型，但没有布局编辑能力"是装配层面的事实。
 * 「相同挂载机制」（#257 明文）由两端共用 `workspace.layout` + 同一个
 * `AreaHost` 承载（见 `editors/AreaHost.vue`）。
 */
export const M_SHELL_EMBED = moduleDecl({
  id: 'shells.embed',
  provides: ['shell.embed'],
  requires: ['workspace.layout', CAPABILITY.EVALUATE, CAPABILITY.INTERACTION_BEGIN],
  contributes: {
    shellLayouts: [{ shellId: 'embed', adjustableLayout: false, regions: ['viewport', 'channels', 'timeline'] }],
  },
  note: '嵌入外壳（查看器）：固定布局，省略布局编辑命令；与工作台共用相同挂载机制。',
})

/** Wiki 工作台外壳（工作台的 Wiki 宿主形态）。 */
export const M_SHELL_WIKI = moduleDecl({
  id: 'shells.wikiWorkbench',
  provides: ['shell.wikiWorkbench'],
  requires: ['shell.workbench'],
  contributes: {
    shellLayouts: [
      { shellId: 'wikiWorkbench', adjustableLayout: true, regions: ['viewport', 'inspector', 'wikiStatus', 'menubar'] },
    ],
  },
  note: 'Wiki 工作台：工作台外壳 + Wiki 状态/上传落点。',
})

/** Wiki 上传（只有 Wiki profile）。 */
export const M_WIKI_UPLOAD = moduleDecl({
  id: 'wiki.upload',
  provides: [CAPABILITY.WIKI_UPLOAD],
  requires: ['shell.wikiWorkbench', 'document.state'],
  contributes: { commands: [{ commandId: 'wikiUpload', requires: [CAPABILITY.WIKI_UPLOAD] }] },
  note: 'Wiki 上传：只有 Wiki profile 有它（旧实现是"到处问宿主是不是 wiki"，见装配根文件头的退役对照）。',
})

/** 无界面外壳（headless：无 DOM 外壳，只装配领域 + 求值 + 布局模型）。 */
export const M_SHELL_HEADLESS = moduleDecl({
  id: 'shells.headless',
  provides: ['shell.headless'],
  requires: ['workspace.layout', CAPABILITY.EVALUATE],
  contributes: { shellLayouts: [{ shellId: 'headless', adjustableLayout: true, regions: [] }] },
  note: '无界面 profile：无 DOM 外壳；布局模型与求值语义与其它 profile 一致（#257 H3）。',
})

// ─────────────────────────────────────────────────────────────────────────────
// 适配器端口 / 导出 / 持久化
// ─────────────────────────────────────────────────────────────────────────────

const M_PORT_BROWSER = moduleDecl({
  id: 'ports.browser',
  provides: ['port.browser'],
  contributes: {
    hostPorts: [
      { portId: 'clock', implementation: 'adapters.browser.clock' },
      { portId: 'dom', implementation: 'adapters.browser.dom' },
      { portId: 'storage', implementation: 'adapters.storage.local' },
    ],
  },
  note: '浏览器宿主端口实现（时钟/DOM/存储）；不进模型（契约 §6 表末行）。',
})

/** 布局持久化（工作环境存储；**布局独立于工程内容** —— #249 §1.1 方向 13）。 */
export const M_LAYOUT_STORAGE = moduleDecl({
  id: 'persistence.workspace',
  provides: ['workspace.storage'],
  requires: ['workspace.layout', 'port.browser'],
  contributes: { hostPorts: [{ portId: 'workspaceStore', implementation: 'adapters.storage.workspace' }] },
  note: '工作环境存储：布局/局部状态/活动 Area 的保留政策见 `domain/workspace` 的 `WORKSPACE_RETENTION`。',
})

/** 导出（独立渲染作业；P9 #260 交付）。 */
const M_EXPORT = moduleDecl({
  id: 'export.snapshot',
  provides: [CAPABILITY.EXPORT_RUN],
  requires: [CAPABILITY.EVALUATE, 'document.state'],
  note: '固定快照导出（P9 #260）。',
})

// ─────────────────────────────────────────────────────────────────────────────
// Profile 声明
// ─────────────────────────────────────────────────────────────────────────────

export interface ProfileDecl {
  readonly id: ProfileId
  /**
   * profile 自身作为**组合模块**（契约 §7：「应用 profile 本身可作为组合模块
   * 引用其他模块；运行实例由解析结果创建」）。
   */
  readonly module: ModuleDecl
  /** 该 profile 的全部模块（扁平、含 profile 自身、已去重）—— 直接喂给 `resolveComposition`。 */
  readonly modules: readonly ModuleDecl[]
  /** 人类可读说明。 */
  readonly note: string
}

function profile(id: ProfileId, extra: readonly ModuleDecl[], note: string): ProfileDecl {
  const all: ModuleDecl[] = []
  const seen = new Set<string>()
  for (const m of [...SHARED_FUNCTIONAL_MODULES, ...extra]) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    all.push(m)
  }
  const self = moduleDecl({
    id: `profile.${id}`,
    provides: [`profile.${id}`],
    composes: all.map((m) => m.id),
    note,
  })
  return Object.freeze({ id, module: self, modules: Object.freeze([self, ...all]), note })
}

/**
 * **工作台**：可调整 Area 布局 + 内容编辑 + 操纵工具 + 保存 + 导出 + Inspector。
 */
export const WORKBENCH_PROFILE: ProfileDecl = profile(
  'workbench',
  [
    ...M_EDITORS,
    M_CONTENT_COMMANDS,
    M_MANIPULATORS,
    M_EDIT_PANELS,
    M_LAYOUT_EDIT,
    M_TEXT_EDITOR,
    M_SHELL_WORKBENCH,
    M_LAYOUT_STORAGE,
    M_SAVE_LOCAL,
    M_PORT_BROWSER,
    M_EXPORT,
  ],
  '工作台：可调整布局 + 内容编辑 + 操纵工具 + 保存 + 导出。',
)

/**
 * **嵌入预览器（= A15 的"查看器构建"）**：固定布局、省略布局编辑命令、
 * **无内容编辑能力**、**无操纵工具**、**无保存**。
 *
 * 它与工作台共用 `SHARED_FUNCTIONAL_MODULES`（同一批对象引用）——
 * 于是"公共功能模块复用"是可断言的事实。
 *
 * 它还**不**引用 `panels.inspector` ⇒ `editors.inspector` 的可选落点被裁剪
 * （A14 的可选裁剪在**真实** profile 上的证据）。
 */
export const EMBED_PROFILE: ProfileDecl = profile(
  'embed',
  [M_EDITOR_VIEWPORT3D, M_EDITOR_INSPECTOR, M_EDITOR_TIMELINE, M_EDITOR_CHANNELS, M_SHELL_EMBED, M_PORT_BROWSER],
  '嵌入预览器/查看器：固定布局，省略布局编辑命令；视口/时间轴/通道与工作台共用。',
)

/** **Wiki 工作台**：工作台能力 + Wiki 上传与状态落点。 */
export const WIKI_PROFILE: ProfileDecl = profile(
  'wiki',
  [
    ...M_EDITORS,
    M_CONTENT_COMMANDS,
    M_MANIPULATORS,
    M_EDIT_PANELS,
    M_LAYOUT_EDIT,
    M_TEXT_EDITOR,
    M_SHELL_WORKBENCH,
    M_SHELL_WIKI,
    M_WIKI_UPLOAD,
    M_LAYOUT_STORAGE,
    M_SAVE_LOCAL,
    M_PORT_BROWSER,
  ],
  'Wiki 工作台：工作台能力 + Wiki 上传/状态。',
)

/**
 * **无界面**：无 DOM 外壳、无内容编辑、无拾取落点；
 * 但对象/时间/通道语义与工作台**一致**（#257 H3）。
 *
 * `WORKBENCH_PROFILE` 缺失的 `picking` / `interaction.begin` 也随之缺失
 * （无界面没有指针），故 `CORE_SEMANTIC_CAPABILITIES` **不含**这两项 ——
 * 那两项是"有视口的外壳"才需要的，一致性判据只覆盖对象/时间/通道。
 */
export const HEADLESS_PROFILE: ProfileDecl = profile(
  'headless',
  [M_EDITOR_TIMELINE, M_EDITOR_CHANNELS, M_SHELL_HEADLESS, M_TEXT_EDITOR, M_SAVE_LOCAL],
  '无界面：无 DOM 外壳；对象/时间/通道语义与工作台一致（H3）。',
)

export const ALL_PROFILES: readonly ProfileDecl[] = Object.freeze([
  WORKBENCH_PROFILE,
  EMBED_PROFILE,
  WIKI_PROFILE,
  HEADLESS_PROFILE,
])

/**
 * 宿主名（`'desktop'`/`'wiki'`）**不在本文件出现**。
 *
 * profile 是唯一的分叉维度，且它是**装配输入**而不是"当前宿主"的全局状态。
 * 旧 `runtime/hostProfile.ts` 的宿主判别（两个取值：桌面 / wiki）与四个 profile
 * 不是同一维度（前者描述"跑在哪"，后者描述"装配了什么"）。
 * 因此本批**删除**旧模块而**不**做名字映射 ——
 * 名字映射会让旧判别在两个系统里同时存活（#171 明令禁止的"新门面包旧核心"）。
 */

/** 按 id 取 profile；未知 id 返回 `undefined`（由调用方决定如何报错）。 */
export function profileById(id: ProfileId): ProfileDecl | undefined {
  return ALL_PROFILES.find((p) => p.id === id)
}
