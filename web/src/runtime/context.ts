import type { ComputedRef, Ref } from 'vue'
import type { BlockRef } from '@/context/selection'
import {
  createScreenHoverAnnotationIdRef,
  createScreenHoverBlockRef,
} from '@/runtime/hover/access'
import type { InjectionKey } from 'vue'
import { inject, provide } from 'vue'
import type { SelectionContext } from '@/context/selection'
import type { KernelUndoState, UndoManager } from '@/context/editHistory'
import type { ToolRegistry } from '@/workbench/tools/registry'
import type { Rect } from '@/shared/types'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import type { Main } from '@/runtime/main'
import type { WM } from '@/runtime/wm'
import type { WorkbenchServices } from '@/runtime/state'
import type { ViewportManager } from '@/runtime/viewportManager'
import type {
  ConnectionState,
  UIWorkspace,
  ViewportSlot,
  WorkbenchWorkspaceMode,
} from '@/runtime/types'
import type {
  EmbedSession,
  ShellSettings,
  ToolSettings,
  WorkbenchSession,
} from '@/runtime/contextAccess'
import type { createLogCenter } from '@/logging/LogCenter'
import type { DiagnosticsReadView } from '@/application/diagnostics'
import { asReadOnlyDiagnostics } from '@/application/diagnostics'
import type { ScreenRoot, RegionNode } from '@/runtime/screenRoot'
import { REGION } from '@/runtime/regionIds'
import { KERNEL_CONTEXT_ID, type KernelSession } from '@/runtime/kernelSession'
// #301 P10f C′1：帧声明的**判定**提成纯函数（D8 的判据必须能注入装配失败，
// 而 `Context` 的外壳六件套不该进测试）—— 本层只负责"取事实、交结果"。
import { resolveFrameDeclarations } from '@/runtime/frameDeclarations'
import { kernelAnnotationsOf, kernelMaterialsOf, projectAnnotationsToLegacy } from '@/runtime/annotationRead'
import { projectCellTooltipsToLegacy, type LegacyCellTooltips } from '@/runtime/tooltipRead'
import {
  gridViewOfLegacy,
  kernelGridOf,
  type KernelGridView,
  type LegacyGridLike,
} from '@/runtime/gridRead'
import {
  documentOfSnapshot,
  snapshotOf,
  type DocumentSnapshot,
} from '@/runtime/documentSnapshot'
import { projectKernelSaveView, type SaveProjection } from '@/composition/saveProjection'
import { projectKernelGrids, type KernelDeclarationProjection } from '@/composition/kernelProjection'
import {
  kernelRenderSourceFaceOf,
  type KernelRenderSourceFace,
} from '@/composition/kernelPresentationInputs'
import { resolveSideTable } from '@/runtime/sideTableResolution'
import { cloneViewportCameraState, setDocumentEmbedInitialView } from '@/context/embedInitialView'
import type { ViewportCameraState } from '@/runtime/viewportCamera'
import type { Command } from '@/application/commands'
import type { CommandOutcome } from '@/application/contracts'
import type { KernelAnnotationView, KernelMaterialView } from '@/runtime/annotationRead'

/** 空读面常量（eadonly 空数组：避免每次分配，且调用方不得改内联量）。 */
const EMPTY_MATERIAL_VIEWS: readonly KernelMaterialView[] = Object.freeze([])
import { frameCount as axisFrameCount, frameDurationsMs, type DocumentContent } from '@/domain/content'
import { sceneSecondsOf } from '@/domain/animation'
import type { Document } from '@/domain/document'
import type { MultiblockBody, MultiblockDeclaration } from '@/domain/multiblockDocument'
import {
  EMPTY_MULTIBLOCK_SELECTION,
  projectMultiblockSelection,
} from '@/domain/multiblockSelection'
import {
  declarationFactsOf,
  derivedPresentationDocument,
  evaluateMultiblockPresentation,
  type MultiblockEvaluation,
} from '@/composition/kernelMultiblockEvaluation'
import { findObjectData, type Scene } from '@/domain/scene'
import type { AreaHostApi } from '@/editors/useAreaHost'
import { createFieldRejectionStore, type FieldRejectionStore } from '@/runtime/fieldRejections'

function embedUnavailable(name: string): never {
  throw new Error(`embed: ${name} not available`)
}

function workbenchUnavailable(name: string): never {
  throw new Error(`workbench: ${name} not available`)
}

// ── #301 P10f D3：`documentMetadata` 的两处常量与两个窄取值器 ──────────────────
//
// 与 `EMPTY_MATERIAL_VIEWS` 同一处置：空读面用共享冻结常量（避免每次分配，
// 且调用方改不动）。取值器是**窄**的（只做类型收窄），刻意不抽成通用 "coerce"
// 工具 —— 通用强制转换会把"字段是脏的"静默吞掉，而这里的语义是"没有就如实给空"。
const EMPTY_TAGS: readonly string[] = Object.freeze([])
const ZERO_ORIGIN = Object.freeze({ x: 0, y: 0, z: 0 })

function strOf(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function vecOf(v: unknown): { readonly x: number; readonly y: number; readonly z: number } | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const x = o.x
  const y = o.y
  const z = o.z
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  return Object.freeze({ x, y, z })
}

export class Context {
  private workbenchHoverBlock: ComputedRef<BlockRef | null> | null = null
  private workbenchHoverAnnotation: ComputedRef<string | null> | null = null
  /** 只读诊断读面（构造时收窄一次；见 `getDiagnostics`）。 */
  private readonly readOnlyDiagnostics: DiagnosticsReadView
  /**
   * **字段级写拒绝的共享读面**（M4-3 R2）。
   *
   * 写点 = 唯一写路由的结算处（`editors/workbench-rna#submitPropertyWrite`），
   * 读点 = 字段模型构造（`buildField`）与底栏实时状态。放在 `Context` 上是为了
   * 让"输入端口提交的拒绝"也能被面板读到 —— 组件局部态结构性做不到（S0 域 2 ①）。
   *
   * **惰性创建**（`null` 到首次取用时才建）：它是纯内存的一次性分配，
   * 而 `Context` 也被诊断脚本以 `Object.create(Context.prototype)` 形态构造
   * （类字段初始化器不执行）——惰性化让那条路径不必知道本字段存在，
   * 也不会在构造期给每个实例多分配一张表。
   */
  private fieldRejections: FieldRejectionStore | null = null

  /**
   * 多方块求值的**失效驱动缓存**（M5-2 性能护栏；见 `kernelMultiblockEvaluation`）。
   *
   * 字段值是不可变快照：命中 ⇒ 返回**同一个**求值产物对象（消费方的 `computed`
   * 依赖因此稳定）；键变（写通道 / 换文档 / 换帧）⇒ 恰好一次重算。
   */
  private multiblockEvaluationCache: {
    readonly key: string
    readonly scene: Scene
    readonly content: DocumentContent
    readonly body: MultiblockBody | null
    readonly declaration: unknown
    readonly frameObjects: readonly string[]
    readonly value: MultiblockEvaluation
  } | null = null

  constructor(
    readonly main: Main,
    readonly wm: WM,
    readonly log: ReturnType<typeof createLogCenter>,
    readonly viewports: ViewportManager,
    readonly screen: ScreenRoot | null,
    readonly workbench: WorkbenchServices | null,
    /**
     * **本运行实例具备的能力集合**（来自装配解析结果，见 `composition/shell`）。
     *
     * ## 它替代了什么（B5 退役矩阵 #7）
     *
     * 旧实现里"我这个实例是不是 wiki 宿主"的答案是
     * `runtime/hostProfile.ts` 的**模块级可变单例**（`let hostProfile`），
     * 任何模块都能 `isWikiHostProfile()` 反查 —— 包括组件（#249 §10 明文禁止
     * "组件询问宿主名称"）与非组件的 operator `poll()`。
     *
     * 现在能力是 `Context` 的**构造参数**：一个实例有什么能力是**显式的**，
     * 且它来自装配结果（`Assembly.capabilities`），不是来自"当前宿主叫什么"。
     * 默认空集：**失败关闭** —— 忘了传能力会少做事，不会静默多做。
     */
    /**
     * **本运行实例具备的能力集合**（来自装配解析结果，见 `composition/shell`）。
     *
     * ## 它替代了什么（B5 退役矩阵 #7）
     *
     * 旧实现里"我这个实例是不是 wiki 宿主"的答案是
     * `runtime/hostProfile.ts` 的**模块级可变单例**（`let hostProfile`），
     * 任何模块都能 `isWikiHostProfile()` 反查 —— 包括组件（#249 §10 明文禁止
     * "组件询问宿主名称"）与非组件的 operator `poll()`。
     *
     * 现在能力是 `Context` 的**构造参数**：一个实例有什么能力是**显式的**，
     * 且它来自装配结果（`Assembly.capabilities`），不是来自"当前宿主叫什么"。
     * 默认空集：**失败关闭** —— 忘了传能力会少做事，不会静默多做。
     */
    readonly capabilities: readonly string[] = Object.freeze([]),
    /**
     * **页面级键盘接管端口**（来自外壳装配；见 `composition/shell` 的 `PageKeyboardClaim`）。
     *
     * `null` = 没有宿主接管页面键盘（独立页面/嵌入）。
     * 旧实现里这个事实写成 `isWikiHostProfile()` 的模块级反查；
     * 现在它是构造参数，于是"同一个函数在不同装配下的行为"可从调用点读出。
     */
    readonly pageKeyboard: import('@/composition/shell').PageKeyboardClaim | null = null,
    /**
     * **本运行实例的内核会话**（#261 / R-WK-03：内核接线的落点）。
     *
     * ## 为什么它是构造参数而不是模块级单例
     *
     * 旧实现把"权威状态"挂在一个全局可反查的位置（`Main` 上的 Vue Ref、
     * 或 B5 #7 那个模块级 `hostProfile`）。那让"同页两个实例"必然互相污染。
     * 会话是**实例**的：工作台有它自己的工作台会话，嵌入有它自己的嵌入会话，
     * 两者的时间/播放/文档互不可见 —— 这正是 #249 §19.7「语言/主题/偏好按实例隔离」
     * 在**状态**层的同族要求。
     *
     * ## 为什么允许 `null`
     *
     * `Context` 也被一些**非交互**路径构造（诊断脚本、装配测试）。
     * `null` 表示"这个实例没有内核会话" ⇒ 所有内核读面显式不可用
     * （`requireKernelSession` 抛错），而**不是**静默退化成一个空会话
     * —— 后者会让"忘了接线"表现为"时间永远静止"，那正是接缝 B 的 blocker 原文
     * 描述的行为回退形态。
     */
    readonly kernel: KernelSession | null = null,
  ) {
    // 绑到实例的 `this`：调用点会 `const t = ctx.t`（见字段文档）。
    this.t = (key: string) => this.wm.settings.t(key)
    this.readOnlyDiagnostics = asReadOnlyDiagnostics(this.wm.diagnostics)
  }

  /**
   * 本实例是否具备某能力。
   *
   * 这是**唯一**的分叉依据：调用方问"我能不能做 X"，
   * 而不是"我是谁"。名字（宿主名/profile 名）在 `Context` 上**不可读**。
   */
  hasCapability(capability: string): boolean {
    return this.capabilities.includes(capability)
  }

  isEmbed(): boolean {
    return this.workbench === null
  }

  // --- WM 输入域（活跃区域通道）---
  getActiveInputRegion(): string | null {
    return this.wm.events.getActiveRegion()
  }

  getCurrentInputRegion(): string | null {
    return this.wm.events.getCurrentRegionId()
  }

  resolveInputRegionId(props?: Record<string, unknown>): string | null {
    const fromProps = props?._regionId as string | undefined
    if (fromProps) return fromProps
    return this.getCurrentInputRegion() ?? this.getActiveInputRegion()
  }

  // --- Screen 树（UI 状态渠道）---
  getScreenRoot(): ScreenRoot | null {
    return this.screen
  }

  region(regionId: string): RegionNode | undefined {
    return this.screen?.region(regionId)
  }

  requireRegion(regionId: string): RegionNode {
    const r = this.region(regionId)
    if (!r) throw new Error(`region not found: ${regionId}`)
    return r
  }

  regionByInputId(wmInputId: string): RegionNode | undefined {
    return this.screen?.regionByInputId(wmInputId)
  }

  // --- Main ---
  //
  // ⚠️ **`getDoc()` 已删除**（#301 P10f D3，本批的终删目标）。
  //
  // 它曾是"文档内容的**权威读入口**"，46 处消费点经它读一切（保存/导出/属性/拾取/
  // 撤销/渲染）。现在每一类事实都有**具名读面**：
  //
  // | 事实 | 读面 |
  // |---|---|
  // | 有文档吗（存在性） | `hasLoadedDocument()`（GF-15） |
  // | 内核承载的是这份文档吗 | `hasAdoptedContent()`（GF-16） |
  // | 帧声明（数/时长/标签） | `frameDeclarations()` |
  // | 网格（尺寸/格/部件/条目/几何/说明） | `kernelGrid(frameIndex)` |
  // | 注解表 | `kernelAnnotations()` |
  // | 材质表 | `kernelMaterials()` |
  // | 逐格说明侧表 | `cellTooltips()` |
  // | 文档元数据 | `documentMetadata()` |
  // | 产物 plain | `plainForSave()` |
  // | 撤销快照 | `documentSnapshot()` / `restoreDocumentSnapshot()` |
  // | 保存基线（外部格式值） | `frozenDocumentValue()` |
  // | 渲染链旧格式源 | `legacyRenderSource()` |
  // | 宿主初始视图（观察视角） | `setHostEmbedInitialView()`（**写**面；读面是 `main.embedInitialView`） |
  //
  // ⚠️ **已终删**：旧数据模型取值口（`legacyDocumentModel()`）与网格编辑句柄
  //（`legacyGridForEdit()`）在 R1-β① C3 随消费者归零一并删除 —— §2.3 明文
  //「返回旧 `RuntimeDocument` 的具名读面**只减不增**」，故**不得**以任何名字加回来。
  //
  // ⚠️ **`RuntimeDocument` 类型不删**：它是**外部格式边界**的契约类型
  //（解析器/投影/保真记录/`plainRoot` 的 47 个引用面），按 D 批映射表 §一
  //（Lead comment 6034 裁决 1）保留。
  //
  // ⚠️ **防绕过**：`main` 仍是 `public readonly`（上面的读面都要读它）⇒
  // 只判"`getDoc(` 零命中"会被一行 `ctx.main.doc.value` 绕过。故
  // `boundary-scan.test.ts` 增了一条"`main.doc` 直接读取点白名单闭集"判据
  // （每一处登记者与理由），见 `tests/architecture/boundary-scan.test.ts`。

  /**
   * **文档是否已装载**（#301 P10f B′：GF-15 读面的**消费入口**）。
   *
   * ## 它与"旧文档非 null"的关系（B′ 的全部理由）
   *
   * A′ 建立了 `KernelSession.hasLoadedDocument()`，并把"文档替换"收口成
   * `Context.setDocument` 这**唯一写入口**。而生产里写入 `main.doc.value` 的
   * 位置**只有一处**（`runtime/main.ts` 的 `replaceDoc`，其唯一调用者即
   * `setDocument`）—— 实测：
   *
   * ```
   * 生产里 `main.doc.value =` 的全部命中：
   *   runtime/main.ts:164        this.doc.value = doc      ← 唯一赋值
   *   runtime/context.ts         this.main.replaceDoc(next) ← 唯一调用者
   * ```
   *
   * ⇒ 镜像**必然**发生在每一次文档替换上，于是
   * `hasLoadedDocument() === (旧文档 !== null)` 是一个
   * **由唯一写者维护的结构不变量**，在**任意读取点**成立 ——
   * 不只是 `setDocument` 的 21 个调用点。
   *
   * 这正是 B′ 能把 29 处存在性判定（含组件与 `poll()` 等**纯读点**）整批替换的
   * 依据：不是"逐点核对过恰好相等"，而是"不存在能绕开镜像的写路径"。
   * 该不变量由 `boundary-scan.test.ts` 的 `.replaceDoc(` 白名单机械把守。
   *
   * ## 为什么内核缺席时回落 legacy（而不是返回 `false`）
   *
   * `ctx.kernel` 是可空的（构造参数默认 `null`）。两个**生产**宿主都传
   * （`runtime/host/workbenchHost.ts`、`runtime/host/embedHost.ts`），但测试/诊断
   * 宿主可能不传。此时若返回 `false`，而 legacy 文档非 null ⇒ **行为变更**
   * （菜单项本该可选却变灰、`poll()` 恒假）。
   *
   * ⇒ 回落读 `this.main.doc.value !== null` —— 与替换前的表达式**逐字同义**。
   * ⚠️ 刻意读 `this.main.doc` 而**不是**（已删除的）旧访问器：后者会让本读面的引入
   * **增加** `raw-authority-object` 的命中数，而 B′ 的目标是把它降下来
   * （这笔"新增一处、消除 29 处"的账必须干净）。
   * ## ⚠️ **必须是响应式可追踪的**（B′ 实测抓出的真实回归，务必保留这一读）
   *
   * 本方法被 **2 处 `.vue` 模板**直接调用（`EmbedRoot.vue` 的
   * `v-else-if="ctx.hasLoadedDocument()"`、`WorkbenchRoot.vue` 的
   * `workspace === 'wiki' && ctx.hasLoadedDocument()`）。而模板的重新渲染
   * **只跟随它在渲染期读到的响应式依赖**。
   *
   * 首版实现只读内核侧的普通字段（`KernelSession` 的 `adoptedDocumentId`）——
   * 那不是响应式对象，**Vue 追踪不到**。后果是：嵌入外壳的文档装载完成后
   * 模板**不再重渲染**，`.wm-root` 永不出现 ⇒ `embed-mobile.spec.ts`
   * **7 条 e2e 全红**（实测：`.wm-root` "element(s) not found"）。
   *
   * 内核侧**不能**自己持有响应式状态：`runtime/kernelSession.ts` 在
   * `KERNEL_FILES` 内，而 `kernel-legacy-isolation.test.ts` 把 `ref(` 列为
   * 内核代码的**禁用词**（内核是纯核心，不得依赖 Vue）。
   *
   * ⇒ 响应式依赖由**本层**提供：下面第一句读 `this.main.doc.value`（它是
   * `Ref`，且**恰好在每一次文档替换时变化** —— 镜像就在同一次 `setDocument`
   * 里发生）。于是"文档变了 ⇒ 模板重算 ⇒ 读到内核的最新装载状态"成立。
   *
   * ⚠️ 这一读**不是**多余的"为了触发依赖而读"：它同时是**正确性**的一部分 ——
   * 装配成功路径（`adoptDocument` ⇒ `markLoaded`）在 `replaceDoc` **之后**发生，
   * 而同一次同步流程内的 `doc.value` 变化已足以让本次渲染读到最终状态。
   */
  hasLoadedDocument(): boolean {
    // 响应式依赖（见上方长注释：去掉这一读会让 2 处模板永不重渲染）。
    const legacyPresent = this.main.doc.value !== null
    const kernel = this.kernel
    if (kernel === null) return legacyPresent
    return kernel.hasLoadedDocument()
  }

  /**
   * **内核是否承载"装配成功"的内容**（#301 P10f C′1；**GF-16** 读面）。
   *
   * ## 为什么需要它（D8 的根因）
   *
   * `hasLoadedDocument()`（GF-15）回答"**有**一份文档吗"；本读面回答
   * "内核里的**就是**那份文档吗"。两者不等价，而 D8 正是那段缝：
   *
   * ```
   * setDocument(doc)      → GF-15 = true    （有文档）
   * adoptLoadedDocument   → 可能**失败**（内核不支持该形态，如实降级）
   *   成功 ⇒ GF-16 = true
   *   失败 ⇒ GF-16 = **false**，但 GF-15 仍为 true
   * ```
   *
   * 装配失败时内核文档是**构造期的空文档**，故任何"读内核"的消费者会读到
   * **空**（而不是 legacy 的真实内容）—— 而 legacy 照常渲染，**不报错**。
   * 帧源那条路径上，它表现为"帧数变 0"（D8）。
   *
   * ## 为什么内核缺席时回落 `false`（与 `hasLoadedDocument` 不同）
   *
   * `hasLoadedDocument` 在内核缺席时回落 `main.doc`（存在性在 legacy 侧总能回答）；
   * 而"装配成功"**在内核缺席时无法回答** —— 没有内核就没有装配。
   * ⇒ 回落 `false`，使消费者走各自的 legacy 兜底分支（那正是"能力不回退"）。
   *
   * ⚠️ 刻意读 `this.main.doc` 之外**不引入**新写入面：本读面只读内核的
   * 装配标记（`markContentAdopted` 仅由 `adoptDocument` 调用）。
   */
  hasAdoptedContent(): boolean {
    const kernel = this.kernel
    if (kernel === null) return false
    return kernel.hasAdoptedContent()
  }

  /**
   * **帧声明的唯一读取面**（#301 P10f C′1；D8 修复的落点）。
   *
   * ## 为什么必须是"一个"读面（而不是两处各写一遍同样的分流）
   *
   * 帧数有**两个**生产消费者：
   *  - `composition/useKernelFrameLoop` 的 `FrameSource`（驱动帧时钟）；
   *  - `workbench/components/StatusBar.vue`（显示"第 N 帧 / 共 M 帧"）。
   *
   * D8 的原形态正是"两处各自判断、判据不同"：帧循环问"文档存在吗"（恒真 ⇒ 读到 0），
   * 而状态栏直读 legacy（读到 N）⇒ **同一时刻两个读数不一致**
   * （#249 §19.9 诊断一致性要防的形态）。
   *
   * ⇒ 收敛成一处分流：**只要"装配成功"就以内核为权威，否则回落 legacy**。
   * 两个消费者读同一个函数，于是"不一致"在结构上不可能发生。
   *
   * ## `source` 字段：让"回落是否发生"可观测
   *
   * 返回哪个来源是**可判定的**事实，不是内部实现细节 —— 诊断与测试都要能问
   * "这一刻用的是内核还是 legacy"。把它藏起来会让 D8 那类缺陷无法被观测
   * （原缺陷之所以活了很久，正是因为"读了 0"看起来只是一个正常数值）。
   */
  frameDeclarations(): {
    readonly count: number
    readonly durationsMs: readonly number[]
    readonly labels: readonly (string | null)[]
    readonly source: 'kernel' | 'legacy'
  } {
    // ⚠️ **响应式依赖**（与 `hasLoadedDocument` 同一取舍，B′ 实测过代价）：
    // 消费者里有 `.vue` 的 `computed`（`StatusBar.vue`），而模板重渲染只跟随
    // 渲染期读到的响应式依赖。内核侧的装配标记是**普通字段**（Vue 追踪不到），
    // 故这里先读一次 `main.doc`（`Ref`，且在**每一次**文档替换时变化）。
    // 去掉这一读 ⇒ 装载后状态栏帧数不刷新（B′ 的 7 条 embed e2e 就是同型回归）。
    const legacyDoc = this.main.doc.value
    // 本方法只**取事实**；判定在纯函数里（理由：D8 的判据必须能注入装配失败，
    // 而 `Context` 的外壳六件套不该进测试 —— 见 `runtime/frameDeclarations` 文件头）。
    return resolveFrameDeclarations(this.kernelAdoptedFrames(), this.legacyFrames(legacyDoc))
  }

  /**
   * **保存/导出读面**（#301 P10f D2）：内核文档 → 旧格式 plain。
   *
   * ## 本方法替代的旧机制
   *
   * `ctx.getDoc().value?.serialize()` —— 保存、SDE 导出、wiki 信封、wiki 页保存、
   * 四个导出命令、`queries.getDocument` 全都从**旧文档**取产物字节。
   * 那些调用点现在改吃本读面 ⇒ 产物的**权威**从旧文档转到内核。
   *
   * ## ⚠️ `null` = "**内核不是权威**" ⇒ 调用方**必须**回落 legacy
   *
   * `null` **不是**"没有内容"。三种成因：无会话、未装配成功（GF-16）、
   * 投影面不可解释（实现缺陷）。三者在处置上都是"回落 legacy 的 `serialize()`"
   * —— 那是**能力不回退**（#171 硬底线）：内核支持不了的形态，旧路径照常能存。
   *
   * ⚠️ 刻意**不**返回一份"看起来能用"的空产物：那会让用户存下一个**空文件**
   * 而不是旧内容（比报错更糟 —— 与 `kernelProjection` 文件头的判据 2 同一口径）。
   *
   * ## 响应式依赖（与 `frameDeclarations` 同一取舍）
   *
   * 先读一次 `main.doc`（`Ref`，每次文档替换都变化）。内核侧的装配标记是
   * **普通字段**（Vue 追踪不到）⇒ 消费方若是 `.vue` 的 `computed`，
   * 少了这一读就不会在装载后刷新（B′ 的 7 条 embed e2e 是同型回归）。
   */
  kernelSaveView(): SaveProjection {
    // 响应式依赖（见上文）：不得优化掉。
    void this.main.doc.value
    return projectKernelSaveView(this.kernel)
  }

  /**
   * **保存/导出的产物 plain**（#301 P10f D2）—— 调用点唯一入口。
   *
   * ## 为什么把产物构造收在这里（而不是让每个调用点自己拼）
   *
   * 12 个调用点若各自构造产物，那么
   * ① 漏写一处 = 该处**静默**退回旧权威（本批要消灭的形态）；
   * ② 判据就得覆盖 12 份重复逻辑。
   * ⇒ 构造只有**一处**（与 `frameDeclarations` 的收敛同一理由：
   * "两个消费者读同一个函数，于是不一致在结构上不可能发生"）。
   *
   * ## ⚠️ R1-β① C5：**legacy 回落分支已删除**
   *
   * 旧实现是"内核投影优先，投影不可用则回落 `main.doc.serialize()`"。
   * 那是**保存权威双轨**，而 #387 的同批退役项明文含"`RuntimeDocument` 作为
   * 编辑、保存、呈现权威"；接缝 `fidelity-record-transport-unwired` 的（乙）
   * 子句即"该分支消失"（`seams.ts:574`）。
   *
   * 删除的**不是**能力：未装配（装配不支持的文档形态）时 `plain === null` +
   * `reason` 可判定，调用方据此**显式**失败或提示 —— 与 `composition/projectIo`
   * 的 `projectForSave` 逐字同口径（那里**从来**不回落，理由见其文件头：
   * "用旧文档填它需要先造一份内核 `Document`，那正是第二个权威的入口"）。
   *
   * ## `source` 与 `reason`：让"用了哪条权威 / 为什么没有"**可观测**
   *
   * `source` 恒 `'kernel'` —— 保留该字段是为了让"回落又回来了"这一形态**可被断言**
   * （它若重新出现 `'legacy'`，类型与判据同时判红）。
   * `plain === null` 时 `reason` 给出结构化成因（`no-session`/`not-adopted`/`unreadable`），
   * 调用方按"无内容可存"处理，**不**静默产出一份空产物。
   */
  plainForSave(): {
    readonly plain: Readonly<Record<string, unknown>> | null
    /** **恒 `'kernel'`**（R1-β① C5）：legacy 回落分支已删除，内核投影是唯一来源。 */
    readonly source: 'kernel'
    /** `plain === null` 时的**结构化原因**（非 null 时恒 `null`）—— 来自 `kernelSaveView()`。 */
    readonly reason: 'no-session' | 'not-adopted' | 'unreadable' | null
  } {
    const view = this.kernelSaveView()
    if (view.ok) return { plain: view.plain, source: 'kernel', reason: null }
    // ⚠️ **R1-β① C5：legacy 回落已删除**（#385 评论 7140 的消费者重写授权；
    // `fidelity-record-transport-unwired` 的（乙）子句即"该分支消失"）。
    // 旧写法在"无会话 / 未装配 / 投影面不可解释"时回落 `main.doc.serialize()` ——
    // 那让**保存权威**出现两个答案，而 #387 的同批退役项明文含"`RuntimeDocument`
    // 作为**保存**权威"。删除后语义与 `composition/projectIo#projectForSave`
    // **逐字同口径**：未装配即"无内容可存"，由调用方显式失败/提示，
    // **不**静默改写成另一份产物（静默回落 = 存下一份形状不同的文件，比报错更难发现）。
    return { plain: null, source: 'kernel', reason: view.reason }
  }

  /**
   * **无损装配源根**（G5）—— 装配这份文档时解析器看到的 plain 根；`null` = 未采集。
   *
   * ## 为什么它必须存在（而不是复用 `plainForSave()` 或 `frozenDocumentValue()`）
   *
   * | 候选 | 为什么不行 |
   * |---|---|
   * | `plainForSave().plain` | 它是**投影产物**（含 `annotations`/`format_version`/`labels`/`meta` 等**投影键**），不是源根；喂回装配层会**污染** `unknownFields`（实测：`documentFormat`/`fixtureFile`/`fixtureSynthetic`/`mode` 被当成"源里的未知顶层字段"） |
   * | `frozenDocumentValue().serialize()` / `legacyRenderSource()` | `RuntimeDocument` 是**有损**中间层：`label`/`author`/`description`/`gtnhVersion`/`modSource`/`globalConfig`/`schemaVersion` 七个根级键它列出了却从不读、也排除在 `_extra` 之外 ⇒ **无法恢复** |
   * | 让消费方自己去解包 | 解包判据只许有一份（`adapters/plainRoot#plainRootOf`）；且消费方（视口 composable）手里**没有**装载期的那份原文 |
   *
   * ⇒ 唯一正确来源是**装配期**记录的那份源根，由会话保管（`KernelSession#setAssemblySourceRoot`，
   * 生命周期 = 文档生命周期），本方法只是它的**具名读面**。
   *
   * ## 这是"内核侧供给"，不是旧格式面的续命
   *
   * 本读面的宿主是**内核会话**（装载时由 `composition/documentLoad` 置位），
   * 与 `legacyRenderSource()`（读 `main.doc`，旧文档权威）**不同源**：
   * 后者是接缝 `legacy-render-source-document` 要删除的面，前者在内核侧活着。
   *
   * ⚠️ `null` = **未采集**（无会话 / 未装配 / 装配不支持该形态）。消费方必须
   * 如实降级（不传 `plainRoot`，让装配层走它自己标注为"有损"的路径），
   * 不得伪造空对象冒充"无损"。
   */
  kernelSourceRoot(): Readonly<Record<string, unknown>> | null {
    const session = this.kernel
    return session === null ? null : session.assemblySourceRootOf()
  }

  /**
   * **多方块内层 body 的内核承运读面**（G3 / #388 裁决第 3 项）。
   *
   * ## 它替代的旧机制
   *
   * 多方块的**再装配**（按当前通道取值重算网格、构造渲染视图文档）原先只能拿
   * `legacyRenderSource()` 返回的旧文档，再读它的 `multiblockSource`（解析侧整份
   * 原始 JSON）。本读面把那个 body 换成**内核承运**：由类型化适配器对真实解析结果
   * 产出（`adapters/multiblockDeclaration#multiblockBodyContentOf`），装配期就地
   * 放在 `AssembledDocument#multiblockBody` 上，装载时交给会话保管
   * （`composition/documentLoad`），本方法只是它的**具名读面**。
   * 消费方是 `composition/kernelAssembly#assembleMultiblockKernelFace` —— 它的形参里
   * **没有** `RuntimeDocument`，故多方块再装配不再需要旧文档。
   *
   * ## 三态口径（与 `kernelSourceRoot` 同一纪律）
   *
   * | 值 | 含义 | 消费方必须做什么 |
   * |---|---|---|
   * | 非 `null` | 内核承运在场 | 直接喂再装配入口（**不要**再去旧文档取 body） |
   * | `null` | 该文档**没有**多方块声明（帧为主）或未装配 | 如实降级：走帧为主路径 |
   *
   * ⚠️ 与 `legacyRenderSource()` **不同源**：后者读 `main.doc`（旧文档权威，接缝
   * `legacy-render-source-document` 要删除的面），前者由内核会话保管、生命周期 =
   * 文档生命周期（装载置位 / 卸载清空 ⇒ 换文档不串档）。
   * 也**不是**"旧文档换个地方放"：本读面返回的是内核承运（摊平、去 `raw`、
   * 逐层冻结的类型化声明 + 逐帧参考网格的取证通道），没有任何 legacy 形状。
   */
  kernelMultiblockBody(): MultiblockBody | null {
    const session = this.kernel
    return session === null ? null : session.multiblockBodyOf()
  }

  /**
   * **多方块声明的内核载体读面**（R2/S3）：`DocumentContent.multiblock` 本身。
   *
   * ## 它与 `kernelMultiblockBody()` 的关系（**不是**两份权威）
   *
   * 装配期有一个不变式（`composition/kernelAssembly.ts:622`）：
   * `multiblockBody.declaration` 与 `content.multiblock` 是**同一个对象**。
   * 两个读面服务两类消费者，各自只回答一个问题：
   *
   * | 读面 | 消费者要什么 |
   * |---|---|
   * | `kernelMultiblockBody()` | **body 承运**（再装配入口 `assembleMultiblockKernelFace` 的形参） |
   * | 本方法 | 声明的**事实**（通道/运行态/总档位域/说明 → 面板模型与选择投影） |
   *
   * ## `null` 的含义（与 `EMPTY_MULTIBLOCK_DECLARATION` 的分工）
   *
   * `null` = **本内核文档没有多方块声明**（帧为主）或未装配。判定依据是
   * `multiblockCount === 0`：`domain/multiblockDocument` 明文——真实声明恒为 `1`，
   * 故「空值 ⟺ 无声明」是**结构事实**而不是约定。这里**不**把那份空声明本身返回出去：
   * 消费方要的是"有没有"的一个答案，返回空对象会让两处各自再判一次。
   *
   * ⚠️ 响应式依赖：消费者是 `.vue` 的 `computed`，而内核侧的装配标记是普通字段
   * （Vue 追踪不到）⇒ 先读一次 `main.doc`（`Ref`，每次换文档都变化），
   * 与 `kernelSaveView()`/`frameDeclarations()` 同一取舍。
   */
  kernelMultiblockDeclaration(): MultiblockDeclaration | null {
    void this.main.doc.value
    const session = this.kernel
    if (session === null || !session.hasAdoptedContent()) return null
    const kernelDoc = session.document()
    if (kernelDoc === undefined) return null
    const decl = kernelDoc.content.multiblock
    return decl.multiblockCount === 0 ? null : decl
  }

  /**
   * 装配产物的帧声明；**`null` = 未装配成功**（GF-16）。
   *
   * ⚠️ 返回 `null` 而**不是** `{count: 0}`：两者语义不同 ——
   * 前者是"没有装配产物可用"（⇒ 该回落 legacy），后者是"装配产物声明了 0 帧"
   * （⇒ 内核权威，且 0 是真实答案）。把前者写成后者**就是 D8 的成因**。
   */
  private kernelAdoptedFrames(): {
    count: number
    durationsMs: readonly number[]
    labels: readonly (string | null)[]
  } | null {
    const kernel = this.kernel
    if (kernel === null) return null
    if (!kernel.hasAdoptedContent()) return null
    const kdoc = kernel.document()
    if (kdoc === undefined) return null
    const frames = kdoc.content.frameAxis.frames
    return {
      count: axisFrameCount({ frames }),
      durationsMs: frameDurationsMs({ frames }),
      // 帧标签是**同一份轴**上的声明事实（`FrameDeclaration.label`）——
      // 与 count/durations 同源，故同一处取出（不另开读面 ⇒ 不留旁路）。
      labels: frames.map((f) => f.label),
    }
  }

  /** 旧文档的帧声明；`null` = 无旧文档。 */
  private legacyFrames(
    doc: RuntimeDocument | null,
  ): { count: number; durationsMs: readonly number[]; labels: readonly (string | null)[] } | null {
    if (doc === null) return null
    const durations: number[] = []
    const labels: (string | null)[] = []
    for (let i = 0; i < doc.frameCount; i++) {
      const f = doc.frame(i)
      // `durationMs` 缺省按 0 如实给（与内核 `stripTimeline` 的回落同口径：
      // 猜一个值会让"没声明时长"与"声明了 50ms"无法区分）。
      durations.push(f?.durationMs ?? 0)
      // ⚠️ `?? null` **不**换成 `?? ''`：空标签与"没声明标签"不同
      //（与内核 `FrameDeclaration.label: string | null` 同一口径）。
      labels.push(f?.label ?? null)
    }
    return { count: doc.frameCount, durationsMs: durations, labels }
  }

  /**
   * **注解表读面**（#301 P10f C′1；N4 的字段完备部分）。
   *
   * 替代 `ctx.getDoc().value?.annotations`（`queries.ts:31` 供 `scenePick` 的盒拾取）。
   *
   * ## 本方法只**取事实**；**决定**在纯函数里
   *
   * 分流判定在 `runtime/sideTableResolution#resolveSideTable`。为什么提出来：
   * 我第一版把判定内联在这里，而测试宿主**复刻**了那段 ⇒ 判据**空转**
   * （实测：把它改成"永远返回空表"，测试仍全绿）。提出去之后测试判的是
   * **生产代码本身**。这与 `frameDeclarations` 是同一处置。
   *
   * ## ⚠️ 为什么这里**必须**回落 legacy（本批实测抓出的自身缺陷）
   *
   * 我最初让本读面在"未装配"时返回空表（理由是"诚实"）。那是**错的**：
   * `setDocument` 会清 GF-16，而**注解编辑路径**（`annotationOperators` 的
   * clone+push+`setDocument`）正是"换了 legacy 但没装配内核" ⇒ GF-16=false
   * ⇒ 若返回空表，用户新建一条注解后**连原有的注解也点不中**。
   * 实测该形态：legacy 2 条 / 内核读面 0 条。
   *
   * ## 字段完备性（实测）
   *
   * 消费者 `render/interaction/scenePick.ts` 只读 `id`/`type`/`visible`/`min`/`max`，
   * 全部由内核承载；字段级对比实测 **0 处不一致**（13 个字段逐个比对）。
   */
  kernelAnnotations(): readonly KernelAnnotationView[] {
    // 响应式依赖（与 `frameDeclarations` 同一取舍：`.vue` 消费者需要它）。
    const legacyDoc = this.main.doc.value
    return resolveSideTable(this.kernelAdoptedAnnotations(), this.legacyAnnotations(legacyDoc)).rows
  }

  /**
   * **材质资源表读面**（#301 P10f C′1）。
   *
   * 替代 `ctx.getDoc().value?.materialPalette` + `textureBlobs`
   * （`queries.ts:204` 的 `listMaterials`）。字段适配的机械依据见
   * `runtime/annotationRead#kernelMaterialsOf`。
   *
   * 分流与 `kernelAnnotations` **同一形态**（决定同样在 `resolveSideTable`）：
   * **若不回落**，任何一次 `setDocument`（含注解编辑）都会让材质面板**变空**。
   * 实测该形态：`listMaterials` 返回 0 条而 legacy 有 1 条。
   */
  kernelMaterials(): readonly KernelMaterialView[] {
    const legacyDoc = this.main.doc.value
    return resolveSideTable(this.kernelAdoptedMaterials(), this.legacyMaterials(legacyDoc)).rows
  }

  /**
   * **当前帧的网格读面**（#301 P10f D3；**R5**）。
   *
   * ## 它替代的旧机制（15 处消费点）
   *
   * `ctx.main.doc.value?.frame(i)?.grid` —— `context/queries.ts`（9 处）、
   * `runtime/hover/access.ts`（2）、`editors/workbench-rna.ts`（2）、
   * `operators/builtin/moveTranslate.ts`（1）、
   * `workbench/ux/panels/TooltipEditorPanel.vue`（1）。
   *
   * ## 为什么 B′ 撤回过它，而 D3 能交付（两处撤回理由各自被谁解决）
   *
   * B′ 的实现（`temp/p10f/bprime-n3-hold/`）实测出**两处不同义**并如实撤回
   * （理由留档在 `setDocument` 上方的长注释里）。两条的处置：
   *
   * | B′ 的撤回理由 | D3 的处置 |
   * |---|---|
   * | ① `moveTranslate.ts` 是**写**路径（把 `grid` 捕获进 `execute`/`undo` 并调 `grid.moveBlock`）—— 读面每次新建对象 ⇒ 写入**静默无效** | **保留 legacy 写句柄**：该处走 {@link legacyGridForEdit}（**编辑句柄**，不是读面），并登记双轨接缝 `legacy-grid-edit-handle`（见 `composition/seams.ts`） |
   * | ② 换文档但内核未重装时，内核读到**另一个文档**的网格 | 该前置已由 **C′1 的 GF-16**（`hasAdoptedContent`）解决：`setDocument` 在非 `content-sync` 意图下清 GF-16 ⇒ 本读面回落 legacy ⇒ 读到的是**当前**文档 |
   *
   * ## 分流（与 `frameDeclarations`/`kernelAnnotations` **同一形态**）
   *
   * 装配成功（GF-16）⇒ 内核 `blockGrid` 载荷；否则 ⇒ legacy `Grid` 经
   * `runtime/gridRead#gridViewOfLegacy` 归一到**同一形状**。
   * ⇒ 消费点零分支（它们不必知道两种数据模型）。
   *
   * ## ⚠️ 与 legacy 的**一处刻意不同**：`tooltipAt`
   *
   * legacy 的逐格说明**不在网格上**（在文档根的 `tooltipPalette`/`cellTooltipGrid`
   * 两个旁表里）⇒ `KernelGridView#tooltipAt` 在 legacy 分支返回 `undefined`。
   * 逐格说明有**自己**的读面（{@link cellTooltips}）—— 一个读面假装知道
   * 另一份事实正是 D8 的形态，故刻意不合并。
   */
  kernelGrid(frameIndex: number): KernelGridView | null {
    const kernel = this.kernel
    // 响应式依赖（与其它读面同一取舍：消费点是 `.vue` 的 computed / 模板）。
    const legacyDoc = this.main.doc.value
    if (kernel !== null && kernel.hasAdoptedContent()) {
      const view = kernelGridOf(kernel.document(), frameIndex)
      if (view !== null) return view
      // 内核装配成功但该帧没有 `blockGrid`（例如多方块文档的帧**设计上**
      // 没有网格，网格是装配产物）⇒ 如实返回 `null`，**不**回落 legacy：
      // 内核是权威，"这一帧确实没有网格"是它的真实答案（与 `frameDeclarations`
      // 的 `null`/`0` 之分同一口径）。
      return null
    }
    if (legacyDoc === null) return null
    const frame = legacyDoc.frame(frameIndex)
    const grid = frame?.grid
    if (grid === null || grid === undefined) return null
    return gridViewOfLegacy(grid as unknown as LegacyGridLike)
  }

  /**
   * **第 N 帧网格的具名对象 id**（R1-β① C1；`moveCells` 的 `objectId` 来源）。
   *
   * ## 为什么调用方不能自己拼 `structure:frame-<i>`
   *
   * `moveCells` 的 `objectId` 是**内核对象身份**，而它的构造约定
   * （`composition/kernelAssembly` 的 `` `structure:frame-${frame.index}` ``）
   * 是**装配实现细节**。`runtime/gridRead` 的 `blockGridPayloadAt` 已明文
   * 记录同一条口径：**投影层不得依赖该命名**（它按 `scene.order` 的出现序
   * 取第 N 个 `blockGrid`，不解析 id 前缀）。
   *
   * ⇒ 本访问器按**同一条口径**回答"第 N 帧是谁"：从装配面
   * （`KernelAssemblyFace#frameObjects`）取，缺装配面时按 `scene.order`
   * 的出现序推导（与 `projectKernelGrids`/`projectKernelDocument` 的缺省**逐字同口径**）。
   *
   * ## 为什么它是 `Context` 的方法而不是一个自由函数
   *
   * 它要读**内核会话**（装配面 + `Document`），而 `Context` 是持有会话的那一层。
   * 做成纯函数就必须把会话当参数传进来，于是每个调用方各写一次"怎么从会话找第 N 帧"
   * —— 那正是本项目三度实测的"两份实现必然漂移"。
   *
   * ## 与"读面"的关系（它是**寻址**，不是读内容）
   *
   * 它不回答"这一帧有哪些方块"（那是 {@link kernelGrid}），只回答
   * "这一帧的网格对象**叫什么**" —— 写命令需要一个具名目标，而名字不是内容。
   *
   * @returns `null` = 内核未装配 / 该帧没有 `blockGrid` 对象（如实降级，**不**伪造 id）
   */
  kernelGridObjectId(frameIndex: number): string | null {
    const kernel = this.kernel
    if (kernel === null || !kernel.hasAdoptedContent()) return null
    if (!Number.isInteger(frameIndex) || frameIndex < 0) return null
    const face = kernel.assemblyFaceOf()
    if (face !== null) {
      // 装配面是**权威**：它按装配的帧循环顺序记下每帧的 id（见 §2.4 GF-16 的
      // "两个事实"口径 —— 装配面存在就说明内核里的就是那份文档）。
      return face.frameObjects[frameIndex] ?? null
    }
    const kernelDoc = kernel.document()
    if (kernelDoc === undefined) return null
    // 缺装配面（测试夹具/未接线会话）：按 `scene.order` 的出现序推导 —— 与
    // `runtime/gridRead#blockGridPayloadAt` **同一条**取法，故"第 N 帧"在两处同义。
    let seen = 0
    for (const objectId of kernelDoc.scene.order) {
      const obj = kernelDoc.scene.objects[objectId]
      if (obj === undefined || obj.type !== 'block') continue
      const data = findObjectData(kernelDoc.scene, obj.dataId)
      if (data === undefined || data.payload.kind !== 'blockGrid') continue
      if (seen === frameIndex) return objectId
      seen += 1
    }
    return null
  }

  /**
   * **某对象的写权**（按拥有者判定；#249 §3.3）。
   *
   * ## 它为什么是内核事实（而不是"从旧文档读一位"）
   *
   * 写权由**对象数据的来源**决定：`source: 'content'`（装配产出的生成内容）⇒ 只读。
   * 该标记由**生产装配**写在对象数据上（`composition/kernelAssembly.ts:1810` 的
   * `objectData(dataId, blockGridPayload(payload), 'content')`，只在多方块生成分支），
   * 故它本来就是内核文档携带的事实 —— 不需要问旧载体。
   *
   * ## 它取代了什么（R1-β① C5）
   *
   * `editors/workbench-rna.ts` 原先靠"旧文档有没有 `multiblock` 节"回答"这块内容是不是
   * 生成的"，那是 `Context#legacyRenderSource()` 的消费点之一（接缝
   * `legacy-render-source-document`）。本读面把该判定改为**读内核自己的写权事实**，
   * 与 `application/kernel-properties.ts:539` 的 `generated: data?.source === 'content'`
   * **同一口径**（按拥有者判定，不是文档级布尔）。
   *
   * @returns `'missing'` = 未装配 / 无该对象（如实降级，**不**猜 `writable`）。
   */
  kernelWriteAuthority(objectId: string): 'writable' | 'readOnly' | 'missing' {
    const kernel = this.kernel
    if (kernel === null) return 'missing'
    // ⚠️ 由**会话**向领域取值、本层只转发（R1-β① C6 收口，闸门擒获）：
    // 本文件属**旧层**（`kernel-legacy-isolation` 的判定面），直接
    // `import { generatedObjectWriteAuthority } from '@/domain/multiblock'`
    // 会新增一条**未登记的旧→新依赖** —— 那等于用新内核给旧路径续命。
    // 会话属新层，让它取值、外壳转发，依赖方向才是单向的。
    return kernel.writeAuthorityOf(objectId)
  }

  /**
   * **某格的方块身份在文档调色板里的内容键**（R1-β① C3；`setCellIdentity` 的
   * `paletteRef` 来源）。
   *
   * ## 它为什么必须存在（GF-7 的写侧）
   *
   * `cellPalette` 的值是**含真实命名空间的 `registryId`** 的内容键，而 `cells` 的值
   * 是**已截去命名空间**的注册名（`pure/gridTypes.ts:18`）。两者**互不推出**：
   * 同一个截前缀注册名可以对应多个不同 `registryId` 的条目。面板提交的是显示形态
   * `minecraft:<name>:<meta>`，若要写身份就必须拿到**真实存在的那一条**内容键 ——
   * 由名字反拼（`` `minecraft:${name}` ``）会把 `ae2:` / `appliedenergistics2:`
   * 之类的命名空间改写成 `minecraft:`（GF-7 投影侧实测 68 条调色板里 66 条被改写）。
   *
   * ## 命中口径：**只在精确命中时采信**（与 `kernelProjection.ts` 的 D9 表同一口径）
   *
   * 本访问器只回答"**调色板里已有一条**与 `(name, meta)` 相符的条目吗"，答"是"时
   * 返回那条的**内容键本身**（故命名空间来自文档，不是来自拼接）。
   * 不按 `assetId` 几何身份猜、不按名字尾段兜底 —— 那两条路径
   * （`kernelProjection.ts:500`/`:502`）实测会**引入**错误身份
   * （`multiblock-ebf-2ch` 的 `gregtech:gt.blockcasings@11` 与
   * `gregtech:gt.blockmachines@1000` 共享同一个 `assetId`）。
   *
   * @returns `null` = 未装配 / 该格无方块 / 调色板里没有相符条目 ⇒ 调用方**如实拒绝**，
   *   不得反拼引用兜底。
   */
  kernelCellIdentityRef(
    frameIndex: number,
    pos: { x: number; y: number; z: number },
    name: string,
    meta: number,
  ): string | null {
    const grid = this.kernelGrid(frameIndex)
    if (grid === null) return null
    return grid.identityRefOf(pos, name, meta)
  }

  /**
   * **逐格说明侧表读面**（#301 P10f D3；**R6**）。
   *
   * ## 它替代的旧机制
   *
   * `editors/workbench-rna.ts:263`（面板读 `cellTooltip` 属性）与
   * `workbench/ux/panels/TooltipEditorPanel.vue:33`（面板读当前值）
   * 直读旧文档根的 `tooltipPalette` + `cellTooltipGrid` 两个旁表。
   *
   * ## 内核分支**复用**已交付的投影（不写第二份）
   *
   * `runtime/tooltipRead#projectCellTooltipsToLegacy` 是 D2 收尾（#333）交付的
   * 回写投影，含 `-1` 哨兵与行序翻转，且它的"取哪一份载荷"规则与**保存投影**
   * （`composition/kernelProjection#tooltipPoolOfPayloads`）**同一条**
   * —— 由 `p10fPanelTooltipWrite.test.ts` 的"两侧投影必须一致"组把守。
   * 本读面只做"取事实 + GF-16 分流"。
   *
   * ## ⚠️ 这里**必须**回落 legacy（与注解/材质读面同一条实测理由）
   *
   * `syncLegacyFromKernel` 只在**装配成功**时把内核投影回 legacy
   * ⇒ 未装配时（例如 `metaEditOperators` 的回落分支刚写完 legacy）legacy 才是权威。
   * 若不回落，面板会读到"没有说明"而 legacy 明明有（#333 的同族形态）。
   *
   * @returns `null` = 两侧都"没有这一对字段"（**不是**"空池"：
   *          文件里写 `[]` 是"有但是空"，两者语义不同，见 `domain/cellContent` 判据 3）
   */
  cellTooltips(): (LegacyCellTooltips & { readonly source: 'kernel' | 'legacy' }) | null {
    const kernel = this.kernel
    // 响应式依赖（同上）。
    const legacyDoc = this.main.doc.value
    if (kernel !== null && kernel.hasAdoptedContent()) {
      const kernelDoc = kernel.document()
      if (kernelDoc !== undefined) {
        const projected = projectCellTooltipsToLegacy(kernelDoc)
        // 内核权威：`null` 就是"没有这一对字段"（**不**回落 —— 回落会让
        // "删掉最后一条说明"读回旧池，正是 #333 要修的那类静默失效）。
        return projected === null ? null : { ...projected, source: 'kernel' }
      }
    }
    if (legacyDoc === null) return null
    const palette = legacyDoc.tooltipPalette as readonly string[] | undefined
    const grid = legacyDoc.cellTooltipGrid as readonly number[][][] | undefined
    if (palette === undefined && grid === undefined) return null
    return { palette: palette ?? [], grid: grid ?? [], source: 'legacy' }
  }

  /**
   * **文档元数据读面**（#301 P10f D3；**R7**）。
   *
   * ## 它替代的旧机制
   *
   * `editors/workbench-rna.ts:285`（`ownerKind === 'document'` 的属性读）
   * 直读旧文档的 `meta.*` 与 `formatVersion`。
   *
   * ## 字段面（逐字段，**不**整体展开）
   *
   * | 本读面 | 内核承载 | legacy 承载 |
   * |---|---|---|
   * | `name`/`author`/`description`/`tags`/`origin`/`createdAtMs` | `DocumentContent.metadata`（`domain/content.ts`） | `doc.meta.*` |
   * | `formatVersion` | ❌ **不承载** | `doc.formatVersion` |
   *
   * ⚠️ `createdAtMs` 给的是**毫秒数**（`null` = 源里没有），
   * 而旧路径在 `workbench-rna` 里 `toLocaleString()` 成展示串
   * ⇒ **格式化留在调用点**（读面只给事实，不给表现）。
   *
   * ## ⚠️ `formatVersion`：**已在 R1-β① C5 由内核承载**（历史修正保留在案）
   *
   * D3 的第一版让它在内核分支回落到装配面的 `schemaVersion` —— 那**确实**是错的，
   * 实测推翻了它：`schemaVersion` 是**多方块声明**的格式版本（真实夹具 = `1`），
   * 而 `format_version` 是**文件格式**版本（= `2.0`）—— **两个不同的编号**。
   * 用前者冒充后者会让属性面板的"格式版本"从 `2.0` 变成 `1`
   * ⇒ **静默的行为变更**（用户看到错的版本号，而没有任何判据会变红）。
   *
   * D3 的处置是"如实转发旧文档的声明"（挂在 `legacy-render-source-document` 上）。
   * **C5 改为把声明本身carried 进内核元数据**（`domain/content#DocumentMetadata.formatVersion`
   * /`gtnhVersion`，由 `composition/kernelAssembly#metadataFromLegacy` 从源声明的
   * `format_version`/`gtnhVersion` 读入，缺省与旧解析器逐字相同）——
   * 于是内核分支**不再回头读旧文档**，而"用 `schemaVersion` 冒充"那条错法在结构上
   * 仍然不可能（两个字段各自具名、各自有源）。
   *
   * 这不是"为消费形状给内核塞字段"：**文档声明的版本**属文档元数据这一业务职责，
   * 而它的两个真实消费者（属性面板的格式版本、嵌入元信息提示的版本号）都是产品功能。
   */
  documentMetadata(): {
    readonly name: string
    readonly author: string
    readonly description: string
    readonly tags: readonly string[]
    readonly origin: { readonly x: number; readonly y: number; readonly z: number }
    readonly createdAtMs: number | null
    readonly formatVersion: string
    /** 声明里的 GTNH 版本（C5 新增，与 `formatVersion` 同族同源）。 */
    readonly gtnhVersion: string
    readonly source: 'kernel' | 'legacy'
  } {
    const kernel = this.kernel
    const legacyDoc = this.main.doc.value
    if (kernel !== null && kernel.hasAdoptedContent()) {
      const kernelDoc = kernel.document()
      if (kernelDoc !== undefined) {
        const m = kernelDoc.content.metadata
        return {
          name: m.name,
          author: m.author,
          description: m.description,
          tags: m.tags,
          origin: m.origin,
          createdAtMs: m.createdAtMs,
          formatVersion: m.formatVersion,
          gtnhVersion: m.gtnhVersion,
          source: 'kernel',
        }
      }
    }
    if (legacyDoc === null) {
      return {
        name: '',
        author: '',
        description: '',
        tags: EMPTY_TAGS,
        origin: ZERO_ORIGIN,
        createdAtMs: null,
        formatVersion: '',
        gtnhVersion: '',
        source: 'legacy',
      }
    }
    const meta = legacyDoc.meta as unknown as Record<string, unknown>
    const createdMs = meta.created_at_ms
    // 未装配侧（GF-16=false）仍取旧声明 —— 与 `cellTooltips`/`kernelAnnotations`
    // 的回落同一形态（内核不是权威时读载体），**不是**"内核装配好了却回读旧文档"。
    const plainRoot = legacyDoc.serialize() as Record<string, unknown>
    return {
      name: strOf(meta.name),
      author: strOf(meta.author),
      description: strOf(meta.description),
      tags: Array.isArray(meta.tags) ? (meta.tags as readonly string[]) : EMPTY_TAGS,
      origin: vecOf(meta.origin) ?? ZERO_ORIGIN,
      createdAtMs: typeof createdMs === 'number' && Number.isFinite(createdMs) ? createdMs : null,
      formatVersion: legacyDoc.formatVersion ?? '',
      gtnhVersion: strOf(plainRoot.gtnhVersion),
      source: 'legacy',
    }
  }

  /**
   * **已终删（R1-β① C3）**：`legacyDocumentModel()` —— "旧文档本体（不克隆）"取值口。
   *
   * ## 它当年是什么、为什么必须存在过
   *
   * `getDoc()`（46 处消费）终删后，仍有**两件事的形状**是旧文档：
   *  1. `editors/workbench-rna#documentStateOf` 造 `DocumentState` 时把旧文档交给
   *     `applySetProperty`（写模型仍是旧文档）；
   *  2. `context/captureEmbedInitialView` **原地**写 `meta.embed_initial_view`
   *     （观察视角，属宿主初始视图状态）。
   *
   * 于是留了这一个**具名**取值口，而不是让旧文档散在几十处 —— 白名单闭集
   *（`boundary-scan.test.ts` 的 D-7）把调用者钉死，使"还剩几处欠账"可数。
   *
   * ## 两个消费者各自怎么走的（这就是删除它的机械理由）
   *
   * | # | 消费者 | 去向 | 依据 |
   * |---|---|---|---|
   * | 1 | `context/captureEmbedInitialView` | {@link setHostEmbedInitialView}（**具名宿主装配面**，只收发 `ViewportCameraState`，不交出 `RuntimeDocument`） | #385 裁决④ + GF-8/GF-21 |
   * | 2 | `editors/workbench-rna#documentStateOf` | 文档内容写**全部**改走内核命令（`setCellIdentity`/`setCellTooltip`/`setProperty`/`setDocumentMeta`）；`DocumentState` 只剩壳设置 | R1-β① C3 本体 |
   *
   * ⇒ 调用者 **0**、`DocumentState.document` 字段**不存在**、`property-write-legacy-document-model`
   * 与 `kernel-property-write-dual-track` 两条登记同批核销。
   * **不得**以任何名字把它加回来（§2.3：返回旧 `RuntimeDocument` 的具名读面**只减不增**）。
   */

  /**
   * **宿主初始视图（观察视角）的唯一装配面**（R1-β① C3；#385 裁决④ / GF-8 / GF-21）。
   *
   * ## 为什么它是一个**具名宿主装配面**，而不是"再去取旧数据模型"
   *
   * `meta.embed_initial_view` 是**观察视角**（`{target,yawDeg,elevationDeg,distance,zoom}`）
   * —— #385 裁决④ 逐字：「属 3D 编辑器实例/宿主初始视图状态，**不**伪造进文档 camera
   * 投影参数（GF-8 既有口径）。给它**具名宿主装配面**。」它既不是文档**内容**
   * （内核 `DocumentContent` 不承载它，GF-8 明确禁止把它塞进文档内容来省一条接缝），
   * 也不是渲染链的主文档投影，因此**不该**经旧数据模型取值口
   * （`legacyDocumentModel()` 已随 R1-β① C3 终删）——那个口只为
   * "写模型仍是旧文档"这一件事存续过，而那件事已经结束。
   *
   * ## 语义（与迁移前**逐点相同**，不是"顺手换个写法"）
   *
   * - **原地**写 `doc.meta[EMBED_INITIAL_VIEW_META_KEY]`（`setDocumentEmbedInitialView`）：
   *   不换文档引用 ⇒ **不**推进 `documentRevision` ⇒ `EmbedViewport` 的相机自动初始化
   *   不被重置（若改成"克隆 + `setDocument`"，用户点一次"同步预览视角到文档"就会把
   *   嵌入机位顶回默认 —— 那是可感知的行为变更）；
   * - **同时**镜像 `Main.embedInitialView`（运行期读面；预览面板与机位初始化消费它）；
   * - 无文档 ⇒ 返回 `false`（调用方如实失败，**不**静默造一个）。
   *
   * ## 它为什么落在 `Context` 上（而不是另起一个宿主模块）
   *
   * 落盘读的是 `main.doc` 本体，而 `tests/architecture/boundary-scan.test.ts` 的
   * **D-7 防绕过**判据把 `main.doc` 的直接读取点钉成白名单闭集（本文件是"读面本体"那一格）。
   * 另起模块会让闭集**多一格**（那正是"放宽白名单"）；收口在此则与既有读面同一落点。
   *
   * @returns `true` = 已落到宿主初始视图状态；`false` = 此刻没有文档
   */
  setHostEmbedInitialView(view: ViewportCameraState | null): boolean {
    const doc = this.main.doc.value
    if (doc === null) return false
    setDocumentEmbedInitialView(doc, view)
    this.main.embedInitialView.value = view === null ? null : cloneViewportCameraState(view)
    return true
  }

  /**
   * **撤销快照令牌**（#301 P10f D3；**R8**）。
   *
   * ## 依据：Lead 裁决 R-WK-09 裁决 3（#250 comment 5861）逐字
   *
   * > 「**N10 无文档撤销**：裁 **(b) 受控双轨** —— `getDoc().value?.clone()`
   * > 在撤销路径存续（`before=null` 表达"撤销到无文档"，内核 `pushHistory`
   * > 只记同文档内 scene 前后态、结构性表达不了）；登记 seams 双轨
   * > （owner=P11，退出条件=#262 复杂度对账时复审 undo 权威归一）。」
   *
   * ⇒ **机制保留**（能力存续），但**访问器退出**：返回值是**不透明令牌**
   * （`runtime/documentSnapshot`），调用方拿不到 `RuntimeDocument`
   * —— 若新面直接返回旧文档，"终删"就只是改名（#171 禁）。
   *
   * ## 它替代的 9 处
   *
   * `operators/operatorRegistry.ts`（6）、`operators/modalOperatorWrapper.ts`（1）、
   * `operators/builtin/wikiOperators.ts:97`、`workbench/document/pipeline.ts:111`。
   * ⚠️ 后两处的用途**不同**（保存基线而非撤销），见 {@link frozenDocumentValue}。
   *
   * @returns `null` = **当时没有文档**（R-WK-09 的 `before=null` 形态）
   */
  documentSnapshot(): DocumentSnapshot | null {
    // 响应式依赖不需要：撤销项在**调用当刻**捕获（不是 computed/模板）。
    return snapshotOf(this.main.doc.value)
  }

  /**
   * **回到快照**（撤销/重做的唯一入口）。
   *
   * 经**同一个**唯一写者 `setDocument` ⇒ 内核装载状态镜像与内容重读信号
   * 与其它路径**逐点一致**（`.replaceDoc(` 的 AST 白名单闸门因此仍然成立：
   * 调用点**没有**增加）。
   *
   * @param token `null` ⇒ 撤销到"**无文档**"（删掉 `next` 的所有格与帧 ⇒
   *              必须走 `setDocument(null)`，这正是 R-WK-09 说内核历史
   *              结构性表达不了的那一态）
   */
  restoreDocumentSnapshot(token: DocumentSnapshot | null): void {
    if (token === null) {
      this.setDocument(null)
      return
    }
    const doc = documentOfSnapshot(token)
    // 令牌不认识（伪造/跨 Realm/已被实现换掉）⇒ **不**静默当成"无文档"
    // （那会静默清空用户文档）。如实抛错：这是编程错误，不是用户输入。
    if (doc === undefined) {
      throw new Error('Context.restoreDocumentSnapshot: 未知的快照令牌（不是本实例发出的）')
    }
    this.setDocument(doc)
  }

  /**
   * **当前文档的冻结副本**（#301 P10f D3；R8 的第二种用途）。
   *
   * ## 它与 {@link documentSnapshot} 的分工（**不是**同一件事）
   *
   * | 用途 | 面 | 为什么 |
   * |---|---|---|
   * | 撤销/重做回到"那一刻" | `documentSnapshot()` 令牌 | 内核历史表达不了"无文档"，且令牌不会被误当内容读 |
   * | **保存基线**（"与哪一份内容相比是脏的"） | 本方法 | 基线的比较对象是**plain 产物**（`wikiEditSummary` 逐键比），而它的类型是外部格式边界（见下表） |
   *
   * ## 为什么返回值是 `RuntimeDocument`（而不是也做成令牌）
   *
   * `DocumentBinding.saveBaseline` 的字段类型**就是** `RuntimeDocument | null`
   * （`workbench/document/types.ts`），由 `adapters/files/documentBinding` 读写。
   * 把它不透明化就要改绑定层的对外类型 —— 那是**外部格式边界**，
   * 按 D 批映射表 §一（Lead comment 6034 裁决 1）**保留**。
   *
   * ⇒ 本方法是该边界上**唯一**的取值口：`getDoc()` 退出后，生产里没有第二处
   * "把旧文档交出去"的地方（由 `boundary-scan.test.ts` 的 `main.doc` 读取点
   * 白名单闭集机械把守）。
   */
  frozenDocumentValue(): RuntimeDocument | null {
    const doc = this.main.doc.value
    return doc === null ? null : doc.clone()
  }

  // ─────────────────────────────────────────────────────────────────────────
  // R2/S3（本批）：`legacyRenderSource(): RuntimeDocument | null` **已终删**
  // ─────────────────────────────────────────────────────────────────────────
  //
  // 它曾是接缝 `legacy-render-source-document` 的落点（#301 P10f D3；R9）：唯一用途是
  // 把旧格式文档交给渲染投影（当时喂 `composition/kernelRenderView#kernelRenderViewOf` ——
  // M5-2 起该入口**生产零调用**，投影改由 `kernelRenderViewFromFace` 吃已求值场景）。
  //
  // **删除依据（机械可复跑）**：全仓消费者集合 = 0。最后 1 处
  // （`shared/viewport/useKernelChannels.ts:199`）在本批改吃内核面：
  //   · 声明事实 ← `kernelMultiblockDeclaration()`（= `DocumentContent.multiblock`）+ 域层索引视图；
  //   · 内层 body ← `kernelMultiblockBody()`（经 `assembleMultiblockKernelFace` 再装配）；
  //   · 渲染投影 ← `composition/kernelRenderView#kernelRenderViewFromFace`（形参**无** `RuntimeDocument`）。
  // `e2e/helpers/multiblock/harness.ts`（**L0 看不见的目录**）的两处调用也在同批改接。
  // 判据：`src/runtime/__tests__/legacyRenderSourceConsumers.test.ts`（生产 = 0 **且** 全仓 = 0，
  // 各带负对照，含"往 `e2e/` 注入一处 ⇒ 必红"）。
  //
  // ⚠️ `composition/seams.ts` 的 `legacy-render-source-document` 登记**仍须在案**：
  // 它的另一个子句是"渲染链**画面**终切"（`presenter-surface-dual-track`），
  // 与本读面的删除是两件事（`tests/architecture/shared-viewport-upward-import-closure.test.ts`
  // 仍在断言该 id 在册）。

  /**
   * **内核渲染源面**（G4 · S2 第二半；接缝 `legacy-render-source-document` 的（乙）子句）。
   *
   * ## 它替代的旧机制
   *
   * 渲染链的**定义面 / 逐格说明池 / 材质库输入**原先只能由旧格式渲染视图文档解析
   * （`runtime/drwMeshPipeline` 的 `doc.serialize()` → `resolveRenderBundle`）。
   * 本方法把这三样改为**内核内容直出**：帧下标 → 内核对象 id 由装配面给出，
   * 定义由 `blockGrid` 载荷重建（`composition/kernelPresentationInputs`），
   * 说明池由逐格 `cellContent[].tooltip` 重聚，材质输入由 `content.resources` 派生。
   *
   * ## 为什么它**不是** `legacyRenderSource()` 的改名
   *
   * | | `legacyRenderSource()` | 本方法 |
   * |---|---|---|
   * | 返回 | 旧格式 `RuntimeDocument`（调用方自己再解析） | **具名三样**（定义/说明/材质输入） |
   * | 定义来源 | 旧格式 `frames[].structure`，且要求 `isWorldDocument && frames.length>0`（单结构文档**永不**解析出定义） | 内核 `blockGrid` 载荷（单结构/多方块/多帧同一路径） |
   * | 消费者 | 渲染链（多方块再装配 + 帧为主的旧投影） | 渲染链的**读面**（DRW 优先取它） |
   *
   * ⇒ 帧为主的文档上，渲染链**不再**需要旧格式源（DRW 优先读本面）。
   *
   * ## M5-2：场景取自**按当前取值求值的派生场景**（断点②的落点）
   *
   * 此前这里读的是内核文档场景 —— 那是**装载期**装配产物（`initialSelection`），
   * 通道取值从不写回它 ⇒ 滑杆动了画面不动（连 coil/glass 都不生效）。
   * 现在场景来自 {@link kernelMultiblockEvaluation}（`evaluateMultiblockPresentation`
   * 的唯一产物）；求值失败（`failed`）时本面返回 `null`（DRW 显式报错并保留上一帧），
   * **不**回落装载期场景 —— 回落就是"旧通路复活"，判据会红。
   *
   * ## 响应式
   *
   * 与 `plainForSave()`/`kernelSaveView()` 同一条：先 `void this.main.doc.value`
   * 建立对"换文档/装载内核"的依赖；通道取值变化经 `contentRefreshTick`（写通道时由
   * `useKernelChannels` 请求一次内容重读）传导，故消费方可以是 `computed`。
   */
  kernelRenderSourceFace(): KernelRenderSourceFace | null {
    void this.main.doc.value
    void this.main.contentRefreshTick.value
    const kernel = this.kernel
    if (kernel === null || !kernel.hasAdoptedContent()) return null
    const kernelDoc = kernel.document()
    if (kernelDoc === undefined) return null
    const evaluation = this.kernelMultiblockEvaluation()
    if (evaluation !== null) {
      // 求值失败 ⇒ **不**回落装载期场景（那会让"画面画的是旧取值"永远无法被判红）。
      if (evaluation.failed) return null
      return kernelRenderSourceFaceOf({
        scene: evaluation.scene,
        content: evaluation.content,
        frameObjects: evaluation.frameObjects,
      })
    }
    // **装配面缺席 ⇒ 本面缺席**（M5-2 退役）。
    //
    // 旧实现在此按 `scene.order` 的出现序**推导**帧对象，再拿**装载期场景**产定义面 ——
    // 那正是断点②的"旧通路"：通道取值变化后仍会画装载期装配的网格，且这条回落
    // 让"画面到底读哪份场景"永远有两个答案。生产里 `hasAdoptedContent()` 为真时
    // 装配面必在场（`composition/documentLoad` 同一次装载里 `setAssemblyFace`），
    // 故该分支是**兼容旁路**，按退役纪律同批删除（不留第二条画面源）。
    return null
  }

  /**
   * **渲染视图的装配面输入**（R2/S3）：内核面求值入口要的四样（会话保管的装配事实）。
   *
   * ## 为什么要有这个读面（而不是让视口直接读 `ctx.kernel`）
   *
   * `composition/kernelRenderView#kernelRenderViewFromFace` 的形参是
   * `{ scene, content, frameObjects, multiblockDeclaration }`：前三样在会话的内核文档上，
   * 第四样是**不透明载荷**（`KernelAssemblyFace.multiblock: unknown` —— 会话刻意不 import
   * 装配根的类型，见其字段说明）。若在**视口层**收窄它，视口就得 import 装配根类型
   * （`tests/architecture/shared-viewport-upward-import-closure.test.ts` 钉住的正是
   * "视口不得向上 import 装配根"这个方向）；而且**响应式依赖**（消费者是 `computed`）
   * 只有读面能统一建立。⇒ 收窄与依赖都放这里。
   *
   * `null` = 无会话 / 未装配成功 / **装配面未采集**（三态同 `kernelSourceRoot`：
   * 消费方如实降级，不伪造一份空输入 —— 那会把"未采集"静默变成"文档是空的"）。
   */
  kernelRenderViewInputs(): {
    readonly scene: Scene
    readonly content: DocumentContent
    readonly frameObjects: readonly string[]
    readonly multiblockDeclaration: KernelDeclarationProjection | null
    readonly identity: string
  } | null {
    const evaluation = this.kernelMultiblockEvaluation()
    if (evaluation === null || evaluation.failed) return null
    return {
      scene: evaluation.scene,
      content: evaluation.content,
      frameObjects: evaluation.frameObjects,
      multiblockDeclaration: evaluation.multiblockDeclaration,
      identity: evaluation.identity,
    }
  }

  /**
   * **按当前通道取值求值多方块**（M5-2 · 断点②唯一求值点）。
   *
   * ## 它替代什么
   *
   * 此前"画面"读的是 `kernelDoc.scene` —— 装载期装配（`initialSelection`：全通道 0、
   * tt=default）。通道取值变化既不重跑装配、也不写回该场景 ⇒ 画面恒定在初始取值
   * （s0-a §2.5-6）。本方法把「声明 + body + **当前取值**」交给
   * `composition/kernelMultiblockEvaluation#evaluateMultiblockPresentation`，
   * 产出**派生场景**供 DRW 定义面与呈现会话共用。
   *
   * ## 为什么是派生而不是写回（Lead 裁决）
   *
   * 写回会让内核文档的 `scene` 由取值改变 ⇒ 文档版本/历史/保存投影与"这次求值"
   * 纠缠，且同一份内容在不同取值下有多份"内容事实"。派生场景每次现算、不落存储、
   * 不进历史、不进保存（保存投影只带声明，见 `composition/kernelProjection` 的
   * `renderView` 边界）。
   *
   * ## 三态
   *
   * | 值 | 含义 |
   * |---|---|
   * | `null` | 无会话 / 未装配成功 / **装配面未采集**（消费方如实降级） |
   * | `failed: true` | 再装配失败（文档缺陷）：消费方**保留上一次可渲染结果**，不回落装载期场景 |
   * | `failed: false` | 正常；帧为主文档 `assembly === null` 且 `scene` 即内核场景 |
   *
   * ## 响应式
   *
   * `main.doc`（换文档）+ `contentRefreshTick`（内容/取值可能变了）两处依赖；
   * 取值本身由 `KernelSession#channelValues()` 投影，读它即依赖内核投递的快照。
   */
  kernelMultiblockEvaluation(): MultiblockEvaluation | null {
    void this.main.doc.value
    void this.main.contentRefreshTick.value
    const kernel = this.kernel
    if (kernel === null || !kernel.hasAdoptedContent()) return null
    const kernelDoc = kernel.document()
    if (kernelDoc === undefined) return null
    const face = kernel.assemblyFaceOf()
    if (face === null) return null
    const decl = declarationFactsOf(kernelDoc.content)
    const selection = decl === null
      ? EMPTY_MULTIBLOCK_SELECTION
      : projectMultiblockSelection(decl, kernel.channelValues())
    const frameIndex = this.getFrameIndex()
    const body = kernel.multiblockBodyOf()

    // ── 失效驱动的记忆化（M5-2 的性能护栏）───────────────────────────────
    //
    // 通道拖动是高频交互，而本方法是**每帧**被呈现循环调的（`applyPresenterSurface`）。
    // 没有记忆化 ⇒ 每帧全量再装配（432 个已声明组合的 fixture 上尤其贵）。
    // 缓存键 = **求值身份的全部输入**（文档版本 + 声明/场景/body 的对象身份 +
    // 取值 + 帧下标）：键不变 ⇒ 复用同一份求值产物（同对象，消费方的 computed 也稳定）。
    // 键变（写通道 / 换文档 / 换帧）⇒ 恰好一次重算 —— 这就是"只在取值变化时发生"。
    //
    // 为什么键里放对象**引用**而不是再算一份摘要：这些对象都是内核文档不可变值的一部分
    // （每次文档修改换新引用），引用比较既便宜又是**结构性**的（同引用 ⇒ 同内容）。
    const key = [
      kernelDoc.version.documentVersion,
      frameIndex,
      selection.totalTier,
      selection.runstate,
      Object.entries(selection.values)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join(','),
    ].join('|')
    // `?? null`：`Context` 也被诊断脚本/测试宿主以 `Object.create(Context.prototype)`
    // 构造（类字段初始化器不执行）—— 与 `fieldRejections` 同一处置。
    const cached = this.multiblockEvaluationCache ?? null
    if (
      cached !== null &&
      cached.key === key &&
      cached.scene === kernelDoc.scene &&
      cached.content === kernelDoc.content &&
      cached.body === body &&
      cached.declaration === (face.multiblock ?? null) &&
      cached.frameObjects === face.frameObjects
    ) {
      return cached.value
    }

    const value = evaluateMultiblockPresentation({
      scene: kernelDoc.scene,
      content: kernelDoc.content,
      frameObjects: face.frameObjects,
      multiblockDeclaration: (face.multiblock ?? null) as KernelDeclarationProjection | null,
      body,
      selection,
      frameIndex,
    })
    this.multiblockEvaluationCache = Object.freeze({
      key,
      scene: kernelDoc.scene,
      content: kernelDoc.content,
      body,
      declaration: face.multiblock ?? null,
      frameObjects: face.frameObjects,
      value,
    })
    return value
  }

  /**
   * **呈现会话要读的文档**（画面源；M5-2）。
   *
   * 帧为主文档 / 无多方块 ⇒ 原样返回内核文档（行为零变化）；多方块 ⇒ 同 id/版本/历史，
   * **只**把场景换成按当前取值求值的派生场景（见 {@link kernelMultiblockEvaluation}）。
   * 求值失败 ⇒ 原样返回内核文档（呈现会话按内容身份短路，画面保留上一次结果）。
   *
   * 它**不是**第二份文档权威：不落存储、不进历史、不进保存。
   */
  kernelPresentationDocument(): Document | null {
    const kernel = this.kernel
    if (kernel === null || !kernel.hasAdoptedContent()) return null
    const kernelDoc = kernel.document()
    if (kernelDoc === undefined) return null
    const evaluation = this.kernelMultiblockEvaluation()
    if (evaluation === null) return kernelDoc
    return derivedPresentationDocument(kernelDoc, evaluation)
  }

  /**
   * 内核侧注解行；**`null` = 未装配成功**（GF-16）。
   *
   * ⚠️ `null` 与 `[]` **不可互换**：前者是"没有可用来源"（⇒ 该回落 legacy），
   * 后者是"装配产物里确实没有注解"（⇒ 内核权威，空是真实答案）。
   * 把前者写成后者**就是**本批要修的那个错误。
   */
  private kernelAdoptedAnnotations(): readonly KernelAnnotationView[] | null {
    const kernel = this.kernel
    if (kernel === null) return null
    if (!kernel.hasAdoptedContent()) return null
    return kernelAnnotationsOf(kernel.document())
  }

  private kernelAdoptedMaterials(): readonly KernelMaterialView[] | null {
    const kernel = this.kernel
    if (kernel === null) return null
    if (!kernel.hasAdoptedContent()) return null
    return kernelMaterialsOf(kernel.document())
  }

  /** legacy 侧注解行；`null` = 无文档。字段同名，直接透传。 */
  private legacyAnnotations(doc: RuntimeDocument | null): readonly KernelAnnotationView[] | null {
    if (doc === null) return null
    return (doc.annotations ?? []) as unknown as readonly KernelAnnotationView[]
  }

  /**
   * legacy 侧材质行；`null` = 无文档。
   *
   * 就地适配 `materialPalette` + `textureBlobs`（下标旁表）⇒ 使读面**形状统一**
   * （调用方不必知道两种来源）。data URL 的补前缀规则与旧 `listMaterials` **逐字相同**
   * （已是 `data:` 的原样返回 —— 统一补前缀会产出坏 URL）。
   */
  private legacyMaterials(doc: RuntimeDocument | null): readonly KernelMaterialView[] | null {
    if (doc === null) return null
    const palette = doc.materialPalette as readonly Record<string, unknown>[] | undefined
    if (palette === undefined || palette.length === 0) return EMPTY_MATERIAL_VIEWS
    const blobs = doc.textureBlobs as Record<string, unknown> | undefined
    const dataUrlOfIndex = (idx: unknown): string | null => {
      if (typeof idx !== 'number' || !Number.isFinite(idx)) return null
      const b = blobs?.[String(Math.floor(idx))]
      if (typeof b !== 'string') return null
      const trimmed = b.trim()
      return trimmed.startsWith('data:') ? trimmed : `data:image/png;base64,${trimmed}`
    }
    return Object.freeze(
      palette.map((entry, i) =>
        Object.freeze({
          materialId: String(i),
          kind: (entry.kind ?? 'static16') as string,
          blend: entry.blend,
          locator: entry.locator,
          emissive: entry.emissive,
          animation: entry.animation,
          textureDataUrl: dataUrlOfIndex(entry.textureBlobIndex),
          atlas: entry.atlas,
          linear: entry.linear,
          useMipmaps: entry.useMipmaps,
        }),
      ),
    )
  }
  /**
   * **当前帧的网格** —— ⚠️ **本批撤回，未交付**（#301 P10f B′ 实测发现两处不同义）。
   *
   * ## 为什么它不在这里（撤回理由，留档以免后人重走）
   *
   * N3 的 14 处"读网格"看起来同源（都要一个 `Grid`），实现也照着
   * `projectToLegacyGrid` 复用做了（已实测逐格同义：帧为主/多方块/独立复算
   * 三类判据全绿）。但接线时实测出**两处不同义**，都不是"判据不够"，而是
   * **语义面不同**：
   *
   * ### ① `moveTranslate.ts:313/330` 是**写**路径，不是读
   *
   * 它把 `grid` 捕获进 `execute`/`undo` 并调 `grid.moveBlock(from, to)`。
   * 实测（探针，本批已跑）：
   * ```
   * legacy  frame(0).grid === frame(0).grid         → true   （同一对象，写入留存）
   * 读面    gridOf(doc,0) === gridOf(doc,0)         → false  （**每次新建**）
   * 经读面 moveBlock 后重新读该格                    → 改动**丢失**
   * ```
   * `projectToLegacyGrid` 每次调用**新建**一个 `Grid`。⇒ 替换后移动操作会
   * **静默无效**（不报错、不改盘、用户看不到变化）。
   *
   * ### ② 换文档但内核未重装时，内核读到**另一个文档**的网格
   *
   * A′ 只对齐**存在性**，内容同步明确归 C′。而 `NewScene`/`pushDocUndo`/
   * 模态取消等 6 条路径只调 `setDocument`、**不**装配内核 ⇒ 内核仍持旧文档，
   * 而 legacy 已换。实测：
   * ```
   * 装配 A（2 格）→ legacy 换成空文档（NewScene 形态）
   * legacy 方块数 = 0 ；内核读面方块数 = 2  ；divergent = true
   * ```
   * ⇒ 替换后 `getBlockTypeStats`/`getPartsAt`/描边 mask/拾取部件这些读
   * **会返回上一份文档的网格**（不只是"空"，而是**错文档**）。
   *
   * ## 结论
   *
   * N3 的真正前置不是"网格读面"（那已做出且同义），而是
   * **(a) 区分网格的读面与写面**、**(b) 内容同步**（`setDocument` 的
   * 各路径都装配内核）。两者都属 C′（`RuntimeDocument` 退出生产、
   * `Command` 联合扩展）——本批**不做**，如实回报 Lead 并登记。
   *
   * 已做出的读面与三类同义判据保存在 `temp/p10f/bprime-n3-hold/`
   * （不入树，见铁律 1），C′ 可直接取用。
   */

  /**
   * **文档替换的唯一写入口**（#301 P10f A′）。
   *
   * ## 它替代的旧机制
   *
   * | 旧机制 | 位置 | 本方法的替代 |
   * |---|---|---|
   * | 21 处裸调 `ctx.main.replaceDoc(next)` | 15 条路径（`docLifecycleOperators`/`sdeOperators`/`pipeline`/…） | 一处 `ctx.setDocument(next)` |
   *
   * ## 为什么必须收口（不是"顺手封装"）
   *
   * 内核侧的**装载状态**（`KernelSession.hasLoadedDocument()`，GF-15）必须与
   * legacy 侧的"有没有文档"（`main.doc.value !== null`）**逐点对齐**
   *（`getDoc()` 曾是这个事实的生产读入口，**#301 P10f D3 已终删**）。
   * 若 21 处各写一遍"写 legacy + 镜像内核"：
   *
   *  1. 那 21 份是**会漂移的判据**（本工程已三次实测"两份实现必然漂移"）；
   *  2. **将来**任何新调用点会绕过镜像 —— 而绕过是**静默**的
   *     （legacy 照常工作、内核状态悄悄错位），正是 A′ 要消除的形态。
   *
   * 收口后"文档被替换"在生产里只有一条路径，于是"镜像是否发生"可被**单点**断言，
   * 且闸门能机械地拒绝绕过（见 `boundary-scan.test.ts` 的 `.replaceDoc(` 白名单）。
   *
   * ## 顺序：**先** legacy、**后**内核（顺序是语义的一部分）
   *
   * 反过来的话，镜像写入期间若抛错，legacy 会停在旧值而内核已改
   * —— 两者的不一致会**留在**会话里。先写 legacy 使"最坏情况"退化为
   * "内核未镜像"（下一次替换会自愈），而不是"内核与 legacy 长期错位"。
   *
   * ## 签名：**单参数**（与 A′ 设计表的一处**已声明偏离**）
   *
   * A′ 的设计表核定过形态 `setDocument(next, adoption?: AdoptionInput)` ——
   * 由本方法**一并**完成内容装配。实现采用了**两段式**：
   *
   * ```
   * ctx.setDocument(result.document)                    // 本方法：legacy 写 + 存在性镜像
   * adoptLoadedDocument(ctx, result.document, plainRootOf(raw), locator)   // 调用点：内容装配
   * ```
   *
   * 理由三条（实现后才在完工报里声明，此处留档）：
   *
   *  1. **顺序**：装载路径的既有顺序是 `setDocument` → `seekFrame(0)` → `adopt`，
   *     且文件选择器路径本来就先 `seekFrame(0)` 再装配。把装配折进本方法会改变该顺序，
   *     而顺序是 A′ 明确要求保持不变的东西；
   *  2. **plainRoot 各异**：6 条装载路径的源各不相同（`data` / `raw` / `props.document` /
   *     `loadResult.raw`），全部收进本方法的参数会让本方法需要认识"这是什么加载路径"
   *     —— 那正是 A′ 要避免的职责扩散；
   *  3. **漏装配已被把守**：不装配的后果由 6 条装载路径的 `objects > 0` 判据机械抓住
   *     （`p10fDocumentLifecycle.test.ts`），故"折进本方法"换来的那点防漏并无额外收益。
   *
   * ⇒ 本方法只回答"legacy 文档是谁 + 内核是否已装载"，**内容装配留在调用点**。
   * 两句合起来才是"一次装载"；只做第一句的后果是"存在性对、内容空"，而那**可断言**。
   *
   * ## 原地修改路径的边界（**显式**不保证内容同步）
   *
   * 原地修改路径（注解增删改、tooltip 编辑、属性写）**只保证存在性对齐**，
   * **不**保证内核承载的内容与 legacy 产物同步（它们在旧文档上是 in-place 字段，
   * 内核侧对应物是对象载荷，映射需要新的命令面）。内容一致性归后续批次（C′），
   * 本批的判据**显式不断言**它。
   *
   * ## `intent` 参数（#301 P10f C′2 新增）：两种语义共用一个写者
   *
   * 本方法是 legacy 侧**唯一写入口**（由 AST 白名单闸门把守）。C′2 需要第二种写入语义
   * ——"把内核投影回 legacy"（{@link syncLegacyFromKernel}），它与"装载文档"的区别是
   * **内核侧的后果不同**：
   *
   * | intent | legacy | 内核状态 |
   * |---|---|---|
   * | `'load'`（缺省） | 换成 `next` | **镜像装载状态**（`markLoaded`/`markUnloaded`，清 GF-16） |
   * | `'content-sync'` | 换成 `next` | **不动**（内核仍是同一份已装配文档；GF-16 保持 `true`） |
   *
   * ⚠️ 为什么不让 `syncLegacyFromKernel` 自己调 `replaceDoc`（我第一版就是这么写的）：
   * 那会让 legacy 侧出现**第二个**写入口，而闸门立刻判红
   * （`p10fExistenceReadFace.test.ts` 的"`replaceDoc(` 调用点只有 `setDocument` 本体"）。
   * **闸门是对的** —— 多一个写入口就多一处"镜像是否发生"的静默错位面。
   * ⇒ 正确做法是让**唯一写者**能表达两种意图，而不是绕开它。
   *
   * ⚠️ 若 `'content-sync'` 时仍去 `markLoaded`，会把 GF-16 清掉
   * ⇒ 读面回落 legacy（内容其实在内核里，读面却不用它）；
   * 若 `'load'` 时不清 GF-16，则换文档后读到**上一份**文档的内容
   * （C′1 实测抓出的自身缺陷）。故两种意图**必须**分开。
   */
  setDocument(next: RuntimeDocument | null, intent: 'load' | 'content-sync' = 'load'): void {
    // ① legacy 先写（与收口前**逐字节相同**的行为：`replaceDoc` 会 bump 内容重读信号）
    //
    // ⚠️ R1-β① C1（裁决③）：`revision` 参数把"换文档"与"投影"分开 ——
    // `'content-sync'` 是**同一份文档的载体换内容**，**不得**推进窄信号
    // `documentRevision`（它是 `EmbedViewport.vue` 重置相机自动初始化的依据；
    // 推进它会让"编辑一格 ⇒ 嵌入机位跳回"）。宽信号 `contentRefreshTick`
    // 两种意图都要（读面靠它重读内容）。
    this.main.replaceDoc(next, intent === 'content-sync' ? 'content' : 'document')
    // ② 内核镜像**仅**在装载意图下发生（见上文表格）
    if (intent === 'content-sync') return
    const kernel = this.kernel
    if (kernel === null) return
    if (next === null) kernel.markUnloaded()
    else kernel.markLoaded()
  }

  /**
   * **把内核内容投影回 legacy**（#301 P10f C′2；裁决 3 的"单权威"桥）。
   *
   * ## 它在 C′2 的位置
   *
   * C′2 的写路径是：
   *
   * ```
   * 用户编辑
   *   └─▶ ① 内核写：kernel.submit(Command) + drain     ← 唯一写权威（自带历史记账）
   *         └─▶ ② 本方法：内核 → legacy 投影回写
   *               └─▶ ③ 渲染链 / 保存读 legacy（本批保持现状；终切归 D）
   * ```
   *
   * ## 为什么必须回写（而不是让 legacy 停在旧值）
   *
   * 保存路径 `serialize()` 与渲染链都读 legacy，而 **D 批才终删 legacy**
   * ⇒ 在内核成为唯一权威的今天，legacy 必须被**投影**维护成最新，
   * 否则"内核改了、保存写出旧的"。
   *
   * ## 为什么是单方向（内核 → legacy），不做双向写
   *
   * 本项目三度实测"两份实现必然漂移"。双向写会让"谁是权威"再次不可判
   * —— 那正是 #171 要消除的形态。⇒ 内核是权威，legacy 是**投影产物**。
   *
   * ## ⚠️ 它回写**两类**事实：注解 + 逐格说明侧表
   *
   * | 事实 | 内核承载 | 回写入口 |
   * |---|---|---|
   * | 注解（新建/改字段/删除） | 场景里的 `annotation` 对象 | `projectAnnotationsToLegacy` + `withAnnotations`（C′2） |
   * | **逐格说明** | `blockGrid.cellContent[key].tooltip` | `projectCellTooltipsToLegacy` + `withCellTooltips`（**D2 收尾补做，回 #333**） |
   *
   * 网格/材质/帧轴仍**不写**（内核侧尚无对应写命令 ⇒ 无需回写）。
   * ⚠️ **教训（#333）**：下面那类"将来若要写它们，必须**同时**扩本方法"的声明，
   * 必须在**新增内核写命令**的同批兑现 —— D0 段二加了 `setCellTooltip`
   * 却没扩本方法，于是"内核写了、legacy 没投影"，而面板/保存读 legacy
   * ⇒ 表现为"提交成功但看不到"（e2e A25-3b 双 project 确定性红，单测全绿）。
   * ⇒ 判据面必须覆盖**面板入口的内核路径**（`p10fPanelTooltipWrite.test.ts`），
   * 只测命令层与算子层会漏掉这一整类。
   *
   * ## 不重置 `saveBaseline`（与 `adoptLoadedDocument` 的关键区别）
   *
   * `adoptLoadedDocument` 里 `saveBaseline: withScene.version` 的语义是
   * "**刚打开** = 与保存基线相同"（装载语义）。而本方法是**编辑**语义：
   * 回写后文档必须是**脏**的（`isDirty === true`），否则关窗不提示保存
   * ⇒ **用户丢工作**。⇒ 本方法只换侧表字段，**不碰**版本/基线/历史。
   *
   * @returns 是否真的回写了（`false` = 无会话 / 未装配 / 未换引用 ⇒ 调用方无须动作）
   */
  syncLegacyFromKernel(): boolean {
    const kernel = this.kernel
    if (kernel === null) return false
    // 未装配 ⇒ 内核里没有可投影的内容（GF-16；此时 legacy 才是权威）
    if (!kernel.hasAdoptedContent()) return false
    const current = this.main.doc.value
    if (current === null) return false
    const kernelDoc = kernel.document()
    // `document()` 的类型是 `Document | undefined`（未装载）。上面已由
    // `hasAdoptedContent()` 把守，但**如实**再守一次：`undefined` 时无从投影 ⇒
    // 不下任何结论（返回 `false` = 无须动作），而不是把 `undefined` 当空文档
    // （那会把 legacy 的注解/侧表**清空** —— 静默丢内容，比不写更糟）。
    if (kernelDoc === undefined) return false
    const rows = projectAnnotationsToLegacy(kernelDoc)
    // ── #333：逐格说明侧表**也必须**回写（D0 段二漏了这一步）──────────────────
    //
    // 见本方法文件头那句"将来若要写它们，必须**同时**扩本方法" —— D0 段二
    // 让逐格说明编辑走内核命令，却没扩本方法 ⇒ 内核写了、legacy 没投影，
    // 而面板与保存读 legacy ⇒ "提交成功但看不到"（e2e A25-3b 双 project 确定性红）。
    //
    // ⚠️ **`null` ⇒ 清除**（不是"不动"）：内核侧"没有任何逐格说明"是权威事实。
    // 若把 `null` 当"不改"，则"删掉最后一条说明"会无声地不生效（内核已删、
    // legacy 还留着旧池与旧网格）。语义见 `RuntimeDocument#withCellTooltips`。
    const tooltips = projectCellTooltipsToLegacy(kernelDoc)
    // ── R1-β① C1：**网格也必须回写**（三度同一条纪律：成对铁律第④项）──────────
    //
    // 为什么是本轮必须做的：`moveCells`/`setCellContent` 写的是 `blockGrid` 载荷，
    // 而渲染链（`shared/viewport/useViewportRuntime` 的 `docRef`）此刻仍读 legacy
    // ⇒ 不投影就是 #333 的第二次（"提交成功但看不见"）。
    //
    // 帧对应关系来自**装配面**（`frameObjects`：帧下标 → 内核对象 id）；缺省时
    // `projectKernelGrids` 按 `scene.order` 里 `block` 对象的顺序推导 ——
    // 与 `projectKernelDocument` 的缺省**逐字同口径**（同一个函数族，不另写一份）。
    //
    // ⚠️ **只在真的换了网格时**才动对应帧（`withGrid` 内容相同即返回 `this`），
    // 于是"没有网格写命令命中"的投影是**净零**的：不 bump 信号、不重建渲染。
    const face = kernel.assemblyFaceOf()
    const grids = projectKernelGrids({
      scene: kernelDoc.scene,
      ...(face === null ? {} : { frameObjectIds: face.frameObjects }),
    })
    let withGrids = current
    for (let i = 0; i < current.frames.length; i++) {
      const frame = current.frames[i]!
      // 帧下标 → 网格：`grids` 的下标是**装配面的帧序**，而 `frames` 的 `index`
      // 是文件声明里的帧号 ⇒ 按位置对应（与 `projectKernelDocument` 的
      // `axis = axisFrames[i]` 同一取法）。
      const next = grids[i] ?? null
      withGrids = withGrids.withGrid(frame.index, next)
    }
    const next = withGrids
      .withAnnotations(rows)
      .withCellTooltips(tooltips?.palette, tooltips?.grid)
    // 引用未变 ⇒ 不写（两个 `with*` 都在内容相同时返回 `this`）
    // ⇒ 不 bump 内容重读信号 ⇒ 渲染链不做无谓重建（净零往返零成本）。
    if (next === current) return false
    // ⚠️ **走同一个唯一写者** `setDocument`（不自己调 `replaceDoc`）。
    //
    // 我第一版直接调 `this.main.replaceDoc(next)` 以避开 `setDocument` 的内核镜像
    // —— 那立刻被 A′ 的闸门判红（"`replaceDoc(` 的调用点**只有** `setDocument` 本体"）。
    // **闸门是对的**：`replaceDoc` 是 legacy 侧唯一写入口，多一个调用点就多一处
    // "镜像是否发生"的静默错位面。
    //
    // ⇒ 正确做法是让 `setDocument` 能表达"**编辑**回写"这一意图（见其 `intent` 参数），
    // 而不是绕过它。
    this.setDocument(next, 'content-sync')
    return true
  }
  /**
   * **内核会话**（#261 / R-WK-03）。
   *
   * ## 它与**文档内容读面**的关系（#301 P10f D3 更新）
   *
   * 旧说明写的是"`getDoc()` 与它此刻**并存**"—— 那个访问器**已终删**
   *（46 处消费点各有具名读面，见上方 `// --- Main ---` 段的表）。
   * 现在的事实分两半：
   *
   * | 面 | 状态 |
   * |---|---|
   * | **内容面**（网格/注解/材质/帧声明/说明/元数据/产物 plain） | ✅ 各有具名读面（`kernelGrid`/`kernelAnnotations`/`kernelMaterials`/`frameDeclarations`/`cellTooltips`/`documentMetadata`/`plainForSave`） |
   * | **写模型**（旧数据模型原地 clone + 写） | ✅ **已核销（R1-β① C3，2026-10-13）** —— `property-write-legacy-document-model` 与 `kernel-property-write-dual-track` 两条登记已退出 `seams.ts`，`legacyDocumentModel()` 取值口与 `DocumentState.document` 均已删除；`tests/architecture/boundary-scan.test.ts` 把守"不得复活"。核销理由见 `seams.ts` 的核销段（#385 裁决④ + GF-21） |
   * | **渲染链的旧格式** | ⏳ 仍是旧文档载体（`legacy-render-source-document`，owner P11） |
   * | **时间 / 播放 / 帧下标**（本方法所在的这条） | ✅ 本批之前已完成：旧 `Main.currentFrameIndex` / `Main.framesPlaybackIsPlaying` 两个 Vue Ref 已删，全部消费者改吃本会话（见 `retirementRegistry` 的 `world-frame-playback` 组，相位已翻 `executed`） |
   *
   * ⇒ 三件事**不是**同一件未竟工作的三半：把它们混为一谈会让"播放已迁移"
   * 被误读成"迁移没做"，或让"读入口已终删"被误读成"旧数据模型全退了"。
   *
   * 未接线时抛错（**失败关闭**）：调用方若在没有会话的实例上调它，
   * 应立刻得到明确的失败，而不是一个"永远静止"的静默退化。
   */
  requireKernelSession(): KernelSession {
    if (this.kernel === null) {
      throw new Error('Context: 本实例没有内核会话（装配未接线，见 #261 / R-WK-03）')
    }
    return this.kernel
  }

  /** 是否有内核会话（供装配自检与诊断；不抛错）。 */
  hasKernelSession(): boolean {
    return this.kernel !== null
  }

  /**
   * **内容编辑的唯一入口**（#301 P10f C′2）：内核写 + 投影回写，**一次调用**。
   *
   * ## 为什么必须是一个入口（而不是让各 operator 自己组合）
   *
   * 编辑的正确形态是"① 内核写 → ② 投影回 legacy"，两步**缺一不可**：
   *  - 只做 ① ⇒ 保存/渲染读 legacy（D 批前）⇒ **画面不更新、存出旧内容**；
   *  - 只做 ② ⇒ 内核无权威 ⇒ 撤销链与内容身份与内核脱节。
   *
   * 让 9 处调用点各自组合 = 9 份会漂移的实现（本项目三度实测过的形态）。
   * ⇒ 收口到本方法：**调用方只表达"做了什么编辑"，不表达"怎么同步"**。
   *
   * ## 与"未装配"的关系（回落语义）
   *
   * 内核缺席或未装配（GF-16 = false）⇒ 本方法**不做**内核写，返回 `false`，
   * 由调用方走既有的 legacy 路径。这是 C′1 建立的对称分流的延续：
   * **装配成功 ⇒ 内核权威；否则 ⇒ legacy 权威**。
   * 刻意不在这里替调用方写 legacy —— 不同编辑的 legacy 写法各异
   * （注解是数组、tooltip 是侧表），收进来会让本方法需要认识每一种编辑。
   *
   * @returns `true` = 内核已写入并回写 legacy（调用方**不应**再写 legacy）；
   *          `false` = 未装配/无会话（调用方走既有 legacy 路径）
   */
  submitContentEdit(command: Command): boolean {
    const outcome = this.submitContentEditSettlement(command)
    return outcome !== null && outcome.status === 'applied'
  }

  /**
   * **内容编辑的唯一入口（细粒度结算形态）**（R1-β① C3）。
   *
   * ## 为什么必须有它（`submitContentEdit` 的 `boolean` 不够用）
   *
   * `submitContentEdit` 把内核的三种结算压成一个 `boolean`：只有 `applied` 才返回
   * `true`，于是 `unchanged` 与 `rejected` **不可区分**。而面板属性写必须区分：
   *  - `unchanged`（值没变）**不得**报告 `applied` —— 那是 A06「单选不得产生历史条目」
   *    的同族要求（无业务变化不记账）；
   *  - `rejected` 要把内核给的**结构化原因**如实回报（§3.1：拒绝必须具名）。
   *
   * 仍然只有**一条**写入路径：本方法就是 `submitContentEdit` 的本体，后者改为在它之上
   * 取 `applied`。回写（`syncLegacyFromKernel`）只在 `applied` 时发生 —— 与原实现
   * **逐点相同**（`rejected`/`unchanged` 时回写会把 legacy 改成"内核的旧值"，
   * 反而抹掉调用方可能要保留的状态）。
   *
   * @returns `null` = 无会话或**未装配**（GF-16 false）⇒ 调用方**如实失败**，
   *          不得静默回落旧栈（R1 的写权威只有内核这一条）
   */
  submitContentEditSettlement(command: Command): CommandOutcome | null {
    const kernel = this.kernel
    if (kernel === null) return null
    if (!kernel.hasAdoptedContent()) return null
    const ticket = kernel.submit(command)
    kernel.drain()
    const outcome = kernel.settlementOf(ticket)
    if (outcome !== null && outcome.status === 'applied') this.syncLegacyFromKernel()
    return outcome
  }

  /**
   * **Area 会话**（工作区布局 + 编辑器实例生命周期；#282 P10b）。
   *
   * ## 为什么它在 `Context` 上，而不是在渲染它的组件里
   *
   * #249 明文要求「**Area 与编辑器实例的寿命不依赖组件挂载**」。若布局归
   * `AreaLayoutHost.vue` 的 `ref`，那么：
   *
   *  - `WorkbenchRoot` 用 `:key="ws-${workspace}"` 切工作区时会**卸载并重建**子树
   *    （那是 P6 刻意改的：`v-show` → `v-if`，见该文件的注释）⇒ 切到 Wiki 再切回
   *    预览，分割出来的第二个 Area 与两个视口的机位**全部丢失**；
   *  - 而"切回恢复"正是 §13/A13 的判据（`localState` 存在的全部理由）。
   *
   * 放在 `Context` 上使布局与实例寿命**独立于任何组件**，与内核会话
   * （`kernel`）同一口径 —— 两者都是"运行实例的状态"，由宿主创建、随实例存亡。
   *
   * ## 为什么类型是 `AreaHostApi | null`
   *
   * 嵌入外壳（查看器）**没有**布局编辑能力（#257：装配层就不含 `layout.edit`）。
   * 用 `null` 表达"本实例没有 Area 会话"，与 `kernel` 字段同一手法；
   * `requireAreaSession()` 对"该有却没有"的情形显式抛错（失败关闭）。
   *
   * 由宿主在装配期设置（`runtime/host/workbenchHost`），不由组件设置。
   */
  private areaSession: AreaHostApi | null = null

  setAreaSession(session: AreaHostApi | null): void {
    this.areaSession = session
  }

  /**
   * 取 Area 会话；没有则抛错（**失败关闭**）。
   *
   * 布局命令（`splitArea`/`mergeArea`/`setEditorType`/`setSplitRatio`）的写面
   * 必须经它 —— 若某装配没有 Area 会话，调用方应立刻得到明确失败，
   * 而不是"点了分割没反应"（#249 §13 禁止的假成功控件形态）。
   */
  requireAreaSession(): AreaHostApi {
    if (this.areaSession === null) {
      throw new Error('Context: 本实例没有 Area 会话（布局编辑能力未装配，见 #282 / #257）')
    }
    return this.areaSession
  }

  /** 是否有 Area 会话（供装配自检与诊断；不抛错）。 */
  hasAreaSession(): boolean {
    return this.areaSession !== null
  }

  /**
   * **帧时钟**（外壳级；P10 #261）。
   *
   * ## 为什么它在 `Context` 上而不是每个视口自己起
   *
   * 时间属**共享** `EditContext`（#249 §3.4）：两个 Area 必须看到同一时间
   * （A05「两视口有效坐标相同」）。若每个视口各起一个帧时钟，同一时间会被
   * 推进两次（第二个视口让时间走两倍）—— 那是"双视口各播各的"的另一种形态。
   *
   * ⇒ 时钟归外壳，视口只**订阅**它（`onFrame`）并在自己那一帧变化时重绘。
   *
   * 由外壳在挂载时设置（`composition/kernelRuntime#createFrameClock`）；
   * `null` = 尚未设置（组件挂载早于外壳装配），此时视口退化为"静态第一帧"。
   */
  private frameClock: import('@/composition/kernelRuntime').FrameClock | null = null

  setFrameClock(clock: import('@/composition/kernelRuntime').FrameClock | null): void {
    this.frameClock = clock
  }

  getFrameClock(): import('@/composition/kernelRuntime').FrameClock | null {
    return this.frameClock
  }

  /**
   * 内容**重读请求**（原 `getStructEpoch()`）。
   *
   * 它不是"重建版本"：呈现层会重读内容并自行判断要不要重建
   * （见 `presentation/contentSignal` 与 `runtime/drwMeshPipeline` 文件头）。
   */
  getContentRefreshTick(): Ref<number> {
    return this.main.contentRefreshTick
  }

  /**
   * **文档身份计数**（#301 P10f C′1）：**只在换文档**时变（窄信号）。
   *
   * ## 为什么它不是 `getContentRefreshTick` 的别名（实测口径）
   *
   * | 信号 | 自增点 | 语义 |
   * |---|---|---|
   * | `getContentRefreshTick()` | `replaceDoc` **与** `requestContentRefresh` | "内容**可能**变了"（超集） |
   * | `getDocumentRevision()` | **仅** `replaceDoc` | "**换了一份文档**"（窄） |
   *
   * N9 的 6 处消费者**不是同一种信号**（C′1 逐处实测）：
   *  - `EmbedViewport.vue` 要的是**窄**的：换文档才重置相机自动初始化；
   *  - `MaterialGallery` / `PropertyInspector` / `AnnotationEditorPanel` /
   *    `TooltipEditorPanel` 要的是**宽**的（内容重读），原地编辑也要刷新
   *    ⇒ 它们改用 `getContentRefreshTick()`；
   *  - `WorkbenchViewport.vue` 要的是**跃变**（无→有），由 GF-15 的
   *    `hasLoadedDocument()` 的 `false→true` 表达。
   *
   * ⇒ 三种事实、三种读面。把 6 处一律换成 tick 会让"编辑中机位跳回"回归。
   */
  getDocumentRevision(): Ref<number> {
    return this.main.documentRevision
  }

  /**
   * **已删除**（P10 #261，退役 B5 #1 `raw-authority-object` 的
   * `getCurrentFrameIndex` 条目）：旧实现返回 `Ref<number>` —— 一个**可写**的
   * 帧下标权威（`return this.main.currentFrameIndex`），于是每个调用点都能
   * 直接 `.value = i` 改帧，与时间无关。
   *
   * ## 替代读面（按用途分三处，各自有明确的权威）
   *
   * | 用途 | 新读面 | 为什么 |
   * |---|---|---|
   * | 呈现要知道"当前画第几帧" | `requireKernelSession().frameIndex()` | 派生值，与时间同源 |
   * | 呈现/面板要知道"场景时间" | `requireKernelSession().playback().time` | 时间的唯一权威 |
   * | 选择/拾取要知道"当前帧的网格" | `ctx.kernelGrid(i)` | **网格读面**（#301 D3；内核 `blockGrid` 载荷为权威，未装配回落旧 `Grid` —— 两种来源**归一形状**） |
   *
   * 第三行是本条与"帧下标"的分界：帧**下标**（时间面）由本会话派生，
   * 帧**内容**（网格数据）走 `kernelGrid`。混为一谈会让"下标已迁移"被误读成
   * "内容也迁移了"。
   * ⚠️ **#301 P10f D3 更新**：第三行原写 `ctx.getDoc().value?.frame(i)` —— 该访问器已终删，
   * 网格读面是 `kernelGrid`（见 `runtime/gridRead`）。
   */
  /**
   * 当前帧下标（**只读**；P10 #261）。
   *
   * ## 与旧 `getCurrentFrameIndex(): Ref<number>` 的差别（这是本条的全部要点）
   *
   * | | 旧 | 新 |
   * |---|---|---|
   * | 返回 | `Ref<number>`（**可写**权威） | `number`（**派生**值快照） |
   * | 谁能改 | 任何拿到 Ref 的人（`.value = i`） | 只能经 `setTime`/`seekFrame` 命令 |
   * | 与时间的关系 | 无关（独立权威） | 由 `EditContext.time` 派生 |
   *
   * 消费者（`context/queries.ts`、`runtime/hover/access.ts` 等）用它**选帧内容**
   * （`doc.frame(i)` 取网格）。它们只需要一个数，不需要可写句柄 ——
   * 给 Ref 正是旧机制让"帧下标有多个写入者"的入口。
   *
   * ## 无会话时返回 0（而不是抛错）
   *
   * 这些消费者是**读**路径（拾取、统计、悬停）。无会话的装配里退化为
   * "总看第一帧"是正确的（静态呈现），而不是让拾取整条链崩掉。
   * 写面（operator）则用 `requireKernelSession()` 显式失败 —— 见其说明。
   */
  getFrameIndex(): number {
    return this.kernel?.frameIndex() ?? 0
  }

  /**
   * **场景秒数**（唯一权威 `domain/animation#sceneClockOf` 的只读投影；无会话 ⇒ 0）。
   *
   * 为什么是"场景秒数"而不是"帧下标 × 帧时长"：后者是**离散帧轴**口径
   * （缺省 50 ms、且只在有帧轴的文档上成立），与视口/导出的连续口径不同源。
   * 面板缩略图与视口纹理必须读**同一个**时间值 —— 否则同一时刻会得到不同样本
   * （A27 的判据形态）。
   *
   * 无会话时给 0（与 `getFrameIndex()` 同一条读路径纪律：静态呈现，而不是让面板崩）。
   */
  getSceneSeconds(): number {
    const kernel = this.kernel
    // `null` 与 `undefined` 都表示"尚无会话"（与 `getFrameIndex()` 的 `?.` 同一口径）。
    return kernel == null ? 0 : sceneSecondsOf(kernel.playback().time)
  }

  /** 按 region 取 Main 逻辑相机 */
  getViewportCamera(regionId?: string): Ref<import('@/runtime/viewportCamera').ViewportCameraState | null> {
    const rid = regionId ?? this.resolveInputRegionId() ?? this.viewports.activeId.value
    const slot = rid ? this.viewports.get(rid) : this.viewports.active.value
    if (!slot) throw new Error('getViewportCamera: no viewport slot')
    // `ensureCamera`：键空间按 region 开放（#282）—— 新视口的键可能尚未创建。
    return this.main.ensureCamera(slot.cameraMainKey)
  }

  getOperators(): Main['registries']['operatorsFacade'] {
    return this.main.registries.operatorsFacade
  }

  getShellSettings(): ShellSettings {
    return this.wm.settings
  }

  /**
   * 字段级写拒绝的共享读面（M4-3 R2）。
   *
   * 返回的是**存储本身**（含 `reject`/`clear` 写方法）：写点只有唯一写路由的结算处，
   * 读面（`table`/`get`）供字段模型与诊断使用。与 `getDiagnostics()` 的"只读视图"
   * 处置不同 —— 那里收窄是为了防止顺手改状态，而这里**必须**让结算处能写，
   * 且写入口只有一个（本文件不提供第二个写路径）。
   */
  getFieldRejections(): FieldRejectionStore {
    this.fieldRejections ??= createFieldRejectionStore()
    return this.fieldRejections
  }

  /**
   * 本实例的翻译（#259 A33）。
   *
   * 消费**本实例** `wm.settings.lang`，没有模块级"活动语言"。
   * 在渲染/计算上下文里调用时会读到 `lang.value`，因此语言切换能触发重渲染；
   * 同页另一实例的切换**不**影响这里（它有自己的 `wm`）。
   *
   * **是实例属性（箭头函数）而不是原型方法**：调用点普遍写作
   * `const t = ctx.t`（为了在模板里直接用 `t(...)`），这会把方法从 `ctx` 上
   * **摘下来**。原型方法被摘下后 `this` 丢失，运行期报
   * `Cannot read properties of undefined (reading 'wm')` —— 本批实机启动
   * 曾因此整页白屏（`wb-boot--err`）。箭头函数在构造时绑定 `this`，
   * 摘下后仍可用。
   */
  readonly t: (key: string) => string

  /** 本实例的 DOM 作用域标识（供 `id`/`for`/ARIA 引用加后缀，防同页撞车）。 */
  getScopeId(): string {
    return this.wm.settings.scopeId
  }

  /**
   * 本实例的**只读**诊断读面（#249 §19.9 / #259 A35 J1）。
   *
   * 返回类型是 `DiagnosticsReadView`（只有查询方法），**不**暴露
   * `DiagnosticRecorder.record` —— 验收经此接口取证，不会顺手改状态。
   * 同页两实例各持自己的记录器（挂在 `wm` 上），因此诊断不跨实例混杂。
   */
  getDiagnostics(): DiagnosticsReadView {
    // 运行期同样只读：`asReadOnlyDiagnostics` 返回**不含 record** 的新对象，
    // 因此 `as any` / JS 调用方也无法顺手写诊断（不只是类型标注）。
    return this.readOnlyDiagnostics
  }

  getSession(): WorkbenchSession | EmbedSession {
    if (!this.screen) throw new Error('screen not available')
    return this.screen.session
  }

  getToolSettings(): ToolSettings {
    const rid = this.isEmbed() ? REGION.EMBED : REGION.WORKBENCH_TOOLSHELF
    const tool = this.requireRegion(rid).state.tool
    if (!tool) throw new Error(`tool settings missing on region ${rid}`)
    return tool as ToolSettings
  }

  getWorkspaceMode(): Ref<WorkbenchWorkspaceMode> {
    if (this.isEmbed()) workbenchUnavailable('workspaceMode')
    return (this.getSession() as WorkbenchSession).workspaceMode
  }
  getUiWorkspace(): Ref<UIWorkspace> {
    if (this.isEmbed()) workbenchUnavailable('uiWorkspace')
    return (this.getSession() as WorkbenchSession).uiWorkspace
  }
  getLocalFileName(): Ref<string | null> {
    if (this.isEmbed()) workbenchUnavailable('localFileName')
    return (this.getSession() as WorkbenchSession).localFileName
  }

  getDocumentBinding() {
    if (this.isEmbed()) workbenchUnavailable('documentBinding')
    return (this.getSession() as WorkbenchSession).documentBinding
  }
  getConnection(): ConnectionState {
    if (this.isEmbed()) workbenchUnavailable('connection')
    return (this.getSession() as WorkbenchSession).connection
  }
  getLayerWorldY(): Ref<number> {
    return this.getSession().layerWorldY
  }
  /**
   * **全域悬停方块读面**（底栏读数 / 右栏检查器回落 / 属性目标解析）。
   *
   * ## M4-1（双区归属）改了什么
   *
   * 旧实现固定读**根区**（`createWorkbenchHoverBlockRef` 里写死
   * `REGION.WORKBENCH_VIEWPORT`）⇒ 第二区悬停时底栏与检查器毫无读数
   * （S0 域 1 缺口 ①）。"全域单例"读面不该属于某一个区，故现在读
   * **最近写入过悬停的那个区**（见 `runtime/hover/access#createScreenHoverRegionRef`）。
   *
   * 单视口装配里屏幕只有一个会写悬停的区 ⇒ 行为与改动前**逐字一致**
   * （M3-shell B1 的底栏 `data-hovered-cell` 判据不回潮）。
   *
   * 要读"某一个区自己的悬停"（例如该视口的悬停描边），用
   * `createWorkbenchHoverBlockRef(this, regionId)` —— 不要用本读面。
   */
  getHoveredBlock(): Ref<BlockRef | null> {
    if (this.isEmbed()) workbenchUnavailable('hoveredBlock')
    this.workbenchHoverBlock ??= createScreenHoverBlockRef(this)
    return this.workbenchHoverBlock
  }
  /** 全域悬停注解读面（与 {@link getHoveredBlock} 同一条"最近悬停区"规则）。 */
  getHoveredAnnotationId(): Ref<string | null> {
    if (this.isEmbed()) workbenchUnavailable('hoveredAnnotationId')
    this.workbenchHoverAnnotation ??= createScreenHoverAnnotationIdRef(this)
    return this.workbenchHoverAnnotation
  }

  getSelection(): SelectionContext {
    return this.workbench?.selection ?? embedUnavailable('selection')
  }

  /**
   * **撤销权威读面**（R1-β① C2）。
   *
   * ## 它替代的旧机制
   *
   * 旧实现是 `return this.workbench?.editHistory ?? embedUnavailable('editHistory')`
   * —— 直接把旧 `UndoManager`（`context/editHistory` 的双栈）交出去，于是
   * 「撤销权威是谁」在类型上**就是旧栈**，而内核 `Document.history` 另有一条并行历史。
   * 两条历史并存正是 #385 评论 6988 裁决① 点名要消除的形态（"写了撤不掉"的歧义）。
   *
   * ## 为什么是"读面 + 转发"而不是"把内核对象包成 UndoManager"
   *
   * 内核撤销**不是**一个可从外部 `push` 的栈 —— 它是 `Command` 联合里的
   * `{kind:'undo'|'redo'}` 两条**语义命令**，历史记账由 `reduceUndoRedo`
   * 在事务内完成（契约 §5.2）。若这里造一个 `push()` 能塞任意闭包的 `UndoManager`，
   * 就等于把旧栈的形状**保活**成新门面（#171 明令禁止）。
   *
   * ⇒ 本访问器只交出**读**（`canUndo`/`canRedo`/`undoLabel`/`redoLabel`），
   * 而 `undo()`/`redo()` 走 {@link submitKernelUndoRedo} —— 它们发的是**命令**。
   *
   * @returns `null` = 内核未装配（此时调用方必须走旧栈；见 {@link getEditHistory} 的分流）
   */
  kernelUndoState(): KernelUndoState | null {
    const kernel = this.kernel
    if (kernel === null || !kernel.hasAdoptedContent()) return null
    // #301 P10f C′1 同一条取舍：响应式依赖挂在**内容重读信号**上
    // （`contentRefreshTick` 在 `replaceDoc` 与 `requestContentRefresh` 两处自增）
    // —— 撤销/重做推进文档版本 ⇒ 必须让消费点的 computed 重算。
    void this.main.contentRefreshTick.value
    const summary = kernel.documentSummary()
    if (summary === null) return null
    return {
      canUndo: summary.canUndo,
      canRedo: summary.canRedo,
      undoLabel: summary.undoLabel,
      redoLabel: summary.redoLabel,
    }
  }

  /**
   * **经内核提交撤销/重做**（R1-β① C2；内核撤销成为唯一撤销）。
   *
   * ## 为什么它必须与 {@link submitContentEdit} 一样带投影
   *
   * `submitContentEdit` 的注释写明了编辑的正确形态是"① 内核写 → ② 投影回 legacy"。
   * 撤销/重做**同样是内容变更**（它换掉 scene 的前后态）⇒ 缺了 ②，legacy 载体
   * 会停在撤销前的值：保存写出**已撤销**的内容、渲染链看不见变化
   * —— 正是 #333 那类"提交成功但看不见"。
   *
   * ## 为什么收口在这里而不是让调用方各自组合
   *
   * 与 `submitContentEdit` 同一条理由（"9 处调用点各自组合 = 9 份会漂移的实现"）：
   * "内核事务提交后投影"是**一个**事实，故它只有一处实现（本方法）。
   *
   * @returns `true` = 内核已执行并投影（调用方**不应**再动旧栈）；
   *          `false` = 未装配 / 命令被拒（调用方走旧栈）
   */
  submitKernelUndoRedo(kind: 'undo' | 'redo'): boolean {
    const kernel = this.kernel
    if (kernel === null) return false
    if (!kernel.hasAdoptedContent()) return false
    const ticket = kernel.submit({ kind, contextId: KERNEL_CONTEXT_ID })
    kernel.drain()
    const outcome = kernel.settlementOf(ticket)
    // 与 `submitContentEdit` **同一条**判据：只有真的生效才投影。
    //
    // ⚠️ `unchanged`（栈空：没什么可撤销）也算**生效**的"无事发生"：它**不**改变
    // 内容 ⇒ 投影是净零的（`syncLegacyFromKernel` 自己会在引用未变时返回 `false`）。
    // 故对 `unchanged` 也返回 `true` —— 内核**已经是**权威，调用方不应回落到旧栈：
    // 把"内核栈空"误读成"未装配"会去动一条**不该再有人动**的旧栈。
    // 而 `rejected`（版本冲突等）返回 `false`：那是真的没生效，调用方需要知道。
    if (outcome === null) return false
    if (outcome.status !== 'applied' && outcome.status !== 'unchanged') return false
    this.syncLegacyFromKernel()
    return true
  }

  /**
   * **文档脏读面**（R1-beta-C2）。
   *
   * `dirty` 是内核的**基线比较**（`application/queries#queryDocument` 的
   * `!sameContentVersion(doc.version, doc.saveBaseline)`），而旧栈时代工作台一直用
   * 「撤销栈非空」（`canUndo`）当它的**代理** —— 这也是
   * `workbench/document/pipeline#afterDocumentSave` 必须在保存后 `getEditHistory().clear()`
   * 的原因：不 clear，代理就永远为真。
   *
   * 内核已在 `saveCompleted` -> `completeSave` 里推进 `saveBaseline`
   * （`application/__tests__/saveRaceHistory.test.ts` 断言「只有 committed 且绑定代数相符
   * 才推进基线」「失败不得改基线」）⇒ **代理不再需要**：清空撤销栈既非必要（基线已表达
   * 「已保存」），也不正确（存盘不应摧毁撤销能力）。
   *
   * @returns `null` = 内核未装配 / 无该文档（调用方按各自语义决定，**不回落旧栈**）
   */
  kernelDirty(): boolean | null {
    const kernel = this.kernel
    if (kernel === null || !kernel.hasAdoptedContent()) return null
    void this.main.contentRefreshTick.value
    const summary = kernel.documentSummary()
    return summary === null ? null : summary.dirty
  }

  getEditHistory(): UndoManager {
    return this.workbench?.editHistory ?? embedUnavailable('editHistory')
  }
  getToolRegistry(): ToolRegistry {
    return this.workbench?.toolRegistry ?? embedUnavailable('toolRegistry')
  }
  /**
   * 属性访问（#253 P2）。
   *
   * 旧接口 `getRna(): RNARegistry` 返回一个**自带 `get`/`set` 闭包**的结构注册表 ——
   * 那正是「调用方拿到闭包直接改内存」的旁路写面（契约 §5.2 禁止；退役 #3）。
   * 新形态不向 `Context` 暴露任何属性访问器：属性读面与写面都在
   * `@/editors/workbench-rna`（以 `Context` 为显式输入构造 `PropertyAccess`），
   * 因此「在任意位置 `ctx.getRna().resolve(...).set(...)`」这条路**在类型上不存在**。
   */
  getUi(): { boundsOfByOperator(opId: string): Rect[]; boundsOfByRNAPath(rnaPath: string): Rect[] } {
    return this.workbench?.ui ?? embedUnavailable('ui')
  }

  getViewport(): ViewportSlot {
    return this.viewports.active.value!
  }

  viewportBinding(regionId: string): ViewportSlot | undefined {
    return this.viewports.get(regionId)
  }
}

export function resolveViewportSlot(
  ctx: Context,
  props: Record<string, unknown> | undefined,
): ViewportSlot {
  const rid = ctx.resolveInputRegionId(props) ?? undefined
  if (rid) {
    const slot = ctx.viewports.get(rid)
    if (slot) return slot
  }
  return ctx.getViewport()
}

export const contextKey: InjectionKey<Context> = Symbol('context')

export function provideContext(ctx: Context): void {
  provide(contextKey, ctx)
}

export function useContext(): Context {
  const ctx = inject(contextKey)
  if (!ctx) throw new Error('useContext() 须在 Host Root 子树内调用')
  return ctx
}
