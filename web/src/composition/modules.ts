/**
 * `composition/modules` —— **具名能力模块的贡献声明**（契约 §7 `ModuleDecl`；
 * #249 §10；GF-2 的落地）。
 *
 * ## 本模块替代的旧机制（B5 退役矩阵 #7 的装配半边）
 *
 * 旧实现的"装配"是**分散的模块级全局 + 宿主名分支**：
 *
 * | 旧形态 | 为什么它是要退役的 |
 * |---|---|
 * | `runtime/hostProfile.ts` 的模块级 `let hostProfile` | 模块级可变单例 = 隐式的全局"当前宿主"，与 #249 §2.1「不依赖可变单例」冲突 |
 * | `import.meta.env.VITE_HOST_PROFILE === 'wiki'` 直接出现在组件里 | 组件在**询问宿主名**（#249 §10 明文禁止）；且它是**构建期常量**，无法表达运行期 profile 组合 |
 * | 注册顺序决定谁覆盖谁 | #249 §10：「注册顺序不应产生**隐藏覆盖结果**」 |
 * | 一个万能注册表 | #249 §10：「不归并成万能服务定位器」 |
 *
 * ## 七类贡献**分别**贡献（契约 §7 的选择理由）
 *
 * 契约明文：七类分别对应七种**生命周期与所有权不同**的东西 ——
 * 对象类型持久进文档；宿主端口实现不进模型；外壳布局进工作环境存储（契约 §6 表）。
 * 合成一个 `services: Record<string, unknown>` 就等于放弃所有权表。
 *
 * `ModuleContributions` 因此是**七个独立具名数组**，类型上不存在
 * 一个泛化的"服务"槽位 —— 想塞东西进装配结果，必须选一个**有所有者**的角色。
 *
 * ## 静态装配
 *
 * 本批只做**静态**装配：`ModuleDecl` 是值，`resolveComposition` 是纯函数。
 * 任意运行期代码热加载为远期（需要独立生命周期与版本契约），
 * 本模块**不冒充支持**（#249 §10 末段）。
 */

// 贡献声明的 RNA 半边（`ObjectTypeContribution.rna`）：**只 import 类型** ——
// 本模块仍是一个纯契约模块（无运行期依赖），与"组件不得询问宿主名"同一条纪律。
import type { ObjectTypeDecl } from '@/application/properties'

// ─────────────────────────────────────────────────────────────────────────────
// 标识
// ─────────────────────────────────────────────────────────────────────────────

/** 模块 id（稳定、全局唯一）。 */
export type ModuleId = string
/** 能力 id（`provides`/`requires` 的元素）。 */
export type CapabilityId = string
/** profile id。 */
export type ProfileId = string

/**
 * 能力 id 的**命名约定**（由 `composition/profiles` 消费；本模块只提供常量）。
 *
 * 为什么把能力名抽成常量而不是散在字符串里：能力名是**跨批次契约**
 * （P1 的 `ALL_CAPABILITIES` 已经在用 `'content.edit'` 等字符串），
 * 散写会让"查看器构建必须被判 `UnsupportedOperation`"这条判据
 * （契约 §3.2 + A15）在两处漂移。
 */
export const CAPABILITY = Object.freeze({
  /** 内容编辑（属性写、变换写、交互提交）。查看器构建**必须没有**它。 */
  CONTENT_EDIT: 'content.edit',
  /** 新增对象。 */
  CONTENT_ADD: 'content.add',
  /** 删除对象。 */
  CONTENT_DELETE: 'content.delete',
  /**
   * 开始交互（拖动/建注解）。
   *
   * **查看器构建保留它**：A15 明文要求"运行时拒绝写入，**播放/通道仍可用**"——
   * 通道/时间的播放走的是 `setChannelValue`/`setTime`（无能力要求），
   * 而"交互"在这里指"起一个**只读**观察交互"；真正的写权由 `content.*` 承载。
   */
  INTERACTION_BEGIN: 'interaction.begin',
  /** 保存写入。 */
  SAVE_WRITE: 'save.write',
  /** 导出（独立渲染作业）。 */
  EXPORT_RUN: 'export.run',
  /** 布局编辑命令（分割/合并/切类型）。嵌入外壳**没有**它。 */
  LAYOUT_EDIT: 'layout.edit',
  /** 布局恢复。嵌入外壳**没有**它。 */
  LAYOUT_RESTORE: 'layout.restore',
  /** Wiki 上传。只有 wiki profile 有它。 */
  WIKI_UPLOAD: 'wiki.upload',
  /** 对象拾取。查看器与工作台都有。 */
  PICKING: 'picking',
  /** 求值（场景求值、通道装配）。查看器与工作台都有。 */
  EVALUATE: 'evaluate',
  /** 面板/属性检查器。**查看器的裁剪判据之一**（A15：内容编辑 handlers 不在可达图）。 */
  INSPECTOR_PANELS: 'inspector.panels',
  /** 文本编辑工具（A21 的扩展证明用测试类型）。 */
  TEXT_EDIT: 'text.edit',
})

// ─────────────────────────────────────────────────────────────────────────────
// 七类贡献
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 1. 对象类型贡献（**持久进文档**）。
 *
 * `switch` 在**贡献方**，不在核心（#249 §13 A21「无需改 execution/装配解析器/既有对象分支」）。
 */
export interface ObjectTypeContribution {
  readonly type: string
  readonly dataKind: string
  readonly editable: boolean
  readonly animatableProperties: readonly string[]
  /**
   * 该类型的 **RNA 声明**（`#262` P11-F 段①：A21 的属性写半边）。
   *
   * ## 为什么贡献必须自带它（而不是核心按 `type` 现造一个）
   *
   * 「这个类型有哪些属性、各是什么值类型/值域/单位」是**贡献方**的知识。
   * 核心按 `type` 现造声明 = 核心里出现了逐类型的属性词汇表 ——
   * 那正是 #249 §13「扩展新类型不得改核心 switch」要禁止的形态
   * （`animatableProperties` 是旧的**字符串清单**，没有值类型，无法充当声明：
   * 按它猜值类型会得到一个"核心侧的隐式映射表"，同罪）。
   *
   * ## 它是可选的，且**只有内核不认识的新类型才需要**（不是遗漏）
   *
   * 内核自己的文档模型类型（`block`/`annotation`/`camera`/`mesh`）由
   * `application/kernel-properties` 的 `KERNEL_OBJECT_TYPES` 声明（那是它们**唯一**的
   * 权威）。若 profile 的贡献再声明一遍，就会出现**两份**描述 ⇒ 注册时显式报
   * `duplicate-object-type`（装配缺陷，不静默覆盖）。故：
   *
   * | 贡献形态 | 例 | 是否带 `rna` |
   * |---|---|---|
   * | 内核文档模型已有的类型 | `block`/`annotation`/`camera` | **不带**（声明归内核） |
   * | 经贡献接口**新增**的类型 | `text`（A21 的扩展证明） | **带**（声明归贡献方） |
   *
   * ## 它怎么到达属性写（唯一写入口不变）
   *
   * `composition/contributedObjectTypes#objectTypeDeclarationsOf(assembly)` 把它抽成
   * 内核声明清单，经 `ExecutionInputs.contributedObjectTypes` 进入
   * `reduceCommand` 使用的注册表与写端口 —— **不新增写通路**（GF-5 裁决：
   * 唯一更新入口仍是 `reduceCommand`），也不把注册表变成可变全局
   * （见 `kernel-properties` 的 `kernelPropertyRegistry(contributed)`）。
   */
  readonly rna?: ObjectTypeDecl
}

/** 2. 求值节点贡献（依赖图节点；不进文档）。 */
export interface EvaluationNodeContribution {
  readonly nodeId: string
  readonly dependsOn: readonly string[]
}

/** 3. 命令贡献（具名命令 + 所需能力）。 */
export interface CommandContribution {
  readonly commandId: string
  /** 该命令要求的能力；**运行时**据此拒绝（契约 §3.2）。 */
  readonly requires: readonly CapabilityId[]
}

/** 4. 编辑器类型贡献（`'viewport3d'` / `'inspector'` / 扩展新增）。 */
export interface EditorContribution {
  readonly editorType: string
  /** 该编辑器需要的落点能力；缺任一 ⇒ 该落点被**裁剪**并记录原因。 */
  readonly requires: readonly CapabilityId[]
  /** 该编辑器是否提供**内容编辑**面。A15 的裁剪判据。 */
  readonly contentEditing: boolean
}

/** 5. RNA 控件贡献（属性 ID → 控件 id；RNA 不导入组件名 —— 契约 §5.1）。 */
export interface ControlContribution {
  readonly property: string
  readonly controlId: string
}

/** 6. 宿主端口实现贡献（**不进模型**；契约 §6 表末行）。 */
export interface HostPortContribution {
  readonly portId: string
  readonly implementation: string
}

/** 7. 外壳布局贡献（进工作环境存储）。 */
export interface ShellLayoutContribution {
  readonly shellId: string
  /** 该外壳是否有可调整 Area 布局（工作台有、嵌入没有 —— #257 明文）。 */
  readonly adjustableLayout: boolean
  /** 该外壳提供的落点（`'viewport'` / `'inspector'` / `'channels'`…）。 */
  readonly regions: readonly string[]
}

/** 七类贡献的**具名**集合（不是 `Record<string, unknown>`）。 */
export interface ModuleContributions {
  readonly objectTypes?: readonly ObjectTypeContribution[]
  readonly evaluationNodes?: readonly EvaluationNodeContribution[]
  readonly commands?: readonly CommandContribution[]
  readonly editors?: readonly EditorContribution[]
  readonly controls?: readonly ControlContribution[]
  readonly hostPorts?: readonly HostPortContribution[]
  readonly shellLayouts?: readonly ShellLayoutContribution[]
}

/**
 * `ModuleDecl` —— 契约 §7 的落地（含 GF-2 的七类子清单）。
 *
 * `composes` 是 profile 作组合模块的入口（契约 §7：「应用 profile 本身可作为组合模块
 * 引用其他模块」）：一个模块可以**声明它由哪些模块组成**，
 * 解析器据此展开成扁平模块集合，然后统一解析依赖。
 *
 * **注意**：`composes` 引用的模块必须由调用方一并提供（静态装配：不动态加载代码）。
 */
export interface ModuleDecl {
  readonly id: ModuleId
  readonly provides: readonly CapabilityId[]
  readonly requires?: readonly CapabilityId[]
  /**
   * 可选依赖：缺失时**不是**启动失败，而是"该模块被裁剪 + 记录原因"。
   *
   * 与 `requires` 的分界是契约 §7 的明文：「必需能力缺失则启动失败；
   * **可选落点被裁剪并记录原因**」。同一个能力既可以是被某模块必需、
   * 也可以是另一个模块的可选 —— 判定在**消费方**，不在能力本身。
   */
  readonly optionalRequires?: readonly CapabilityId[]
  readonly contributes?: ModuleContributions
  /** 该模块**由哪些模块组合而成**（profile 作组合模块用）。 */
  readonly composes?: readonly ModuleId[]
  /** 人类可读说明（进诊断，不参与语义）。 */
  readonly note?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// 构造助手（让模块声明文件短且一致）
// ─────────────────────────────────────────────────────────────────────────────

export function moduleDecl(decl: ModuleDecl): ModuleDecl {
  return Object.freeze({
    ...decl,
    provides: Object.freeze([...decl.provides]),
    ...(decl.requires ? { requires: Object.freeze([...decl.requires]) } : {}),
    ...(decl.optionalRequires ? { optionalRequires: Object.freeze([...decl.optionalRequires]) } : {}),
    ...(decl.composes ? { composes: Object.freeze([...decl.composes]) } : {}),
  })
}
