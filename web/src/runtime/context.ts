import type { ComputedRef, Ref } from 'vue'
import type { BlockRef } from '@/context/selection'
import {
  createWorkbenchHoverAnnotationIdRef,
  createWorkbenchHoverBlockRef,
} from '@/runtime/hover/access'
import type { InjectionKey } from 'vue'
import { inject, provide } from 'vue'
import type { SelectionContext } from '@/context/selection'
import type { UndoManager } from '@/context/editHistory'
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
import type { KernelSession } from '@/runtime/kernelSession'
// #301 P10f C′1：帧声明的**判定**提成纯函数（D8 的判据必须能注入装配失败，
// 而 `Context` 的外壳六件套不该进测试）—— 本层只负责"取事实、交结果"。
import { resolveFrameDeclarations } from '@/runtime/frameDeclarations'
import { kernelAnnotationsOf, kernelMaterialsOf, projectAnnotationsToLegacy } from '@/runtime/annotationRead'
import { projectCellTooltipsToLegacy } from '@/runtime/tooltipRead'
import { projectKernelSaveView, type SaveProjection } from '@/composition/saveProjection'
import { resolveSideTable } from '@/runtime/sideTableResolution'
import type { Command } from '@/application/commands'
import type { KernelAnnotationView, KernelMaterialView } from '@/runtime/annotationRead'

/** 空读面常量（eadonly 空数组：避免每次分配，且调用方不得改内联量）。 */
const EMPTY_MATERIAL_VIEWS: readonly KernelMaterialView[] = Object.freeze([])
import { frameCount as axisFrameCount, frameDurationsMs } from '@/domain/content'
import type { AreaHostApi } from '@/editors/useAreaHost'

function embedUnavailable(name: string): never {
  throw new Error(`embed: ${name} not available`)
}

function workbenchUnavailable(name: string): never {
  throw new Error(`workbench: ${name} not available`)
}

export class Context {
  private workbenchHoverBlock: ComputedRef<BlockRef | null> | null = null
  private workbenchHoverAnnotation: ComputedRef<string | null> | null = null
  /** 只读诊断读面（构造时收窄一次；见 `getDiagnostics`）。 */
  private readonly readOnlyDiagnostics: DiagnosticsReadView

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
  getDoc(): Ref<RuntimeDocument | null> {
    return this.main.doc
  }

  /**
   * **文档是否已装载**（#301 P10f B′：GF-15 读面的**消费入口**）。
   *
   * ## 它与 `getDoc().value !== null` 的关系（本批的全部理由）
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
   * `hasLoadedDocument() === (getDoc().value !== null)` 是一个
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
   * ⚠️ 刻意读 `this.main.doc` 而**不是** `this.getDoc()`：后者会让本读面的引入
   * **增加** `raw-authority-object` 的 `getDoc` 命中数，而 B′ 的目标是把它降下来
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
   * ## 为什么把"回落策略"收在这里（而不是让每个调用点自己判）
   *
   * 12 个调用点若各自写一遍"内核优先，否则 legacy"，那么
   * ① 漏写一处 = 该处**静默**退回旧权威（本批要消灭的形态）；
   * ② 判据就得覆盖 12 份重复逻辑。
   * ⇒ 分流只有**一处**（与 `frameDeclarations` 的收敛同一理由：
   * "两个消费者读同一个函数，于是不一致在结构上不可能发生"）。
   *
   * ## `source` 字段：让"回落是否发生"**可观测**
   *
   * 与 `frameDeclarations` 同口径 —— 诊断与测试要能问"这一刻用的是内核还是 legacy"。
   * 藏起来会让"内核明明装配好了却在读旧文档"这类缺陷无法被观测。
   *
   * ⚠️ 回落**不是**错误：那是 #171「能力不回退」的落点 ——
   * 内核支持不了的文档形态，旧路径照常能存。
   *
   * ## `plain === null` 的唯一成因
   *
   * 两条路都拿不到（无会话**且**无旧文档）。调用方按"无内容可存"处理。
   */
  plainForSave(): {
    readonly plain: Readonly<Record<string, unknown>> | null
    readonly source: 'kernel' | 'legacy'
  } {
    const view = this.kernelSaveView()
    if (view.ok) return { plain: view.plain, source: 'kernel' }
    // 回落：内核不是权威（无会话 / 未装配 / 投影面不可解释）⇒ 旧文档照常能存。
    const legacy = this.main.doc.value
    return {
      plain: legacy === null ? null : (legacy.serialize() as Record<string, unknown>),
      source: 'legacy',
    }
  }

  /**
   * 装配产物的帧声明；**`null` = 未装配成功**（GF-16）。
   *
   * ⚠️ 返回 `null` 而**不是** `{count: 0}`：两者语义不同 ——
   * 前者是"没有装配产物可用"（⇒ 该回落 legacy），后者是"装配产物声明了 0 帧"
   * （⇒ 内核权威，且 0 是真实答案）。把前者写成后者**就是 D8 的成因**。
   */
  private kernelAdoptedFrames(): { count: number; durationsMs: readonly number[] } | null {
    const kernel = this.kernel
    if (kernel === null) return null
    if (!kernel.hasAdoptedContent()) return null
    const kdoc = kernel.document()
    if (kdoc === undefined) return null
    const frames = kdoc.content.frameAxis.frames
    return { count: axisFrameCount({ frames }), durationsMs: frameDurationsMs({ frames }) }
  }

  /** 旧文档的帧声明；`null` = 无旧文档。 */
  private legacyFrames(
    doc: RuntimeDocument | null,
  ): { count: number; durationsMs: readonly number[] } | null {
    if (doc === null) return null
    const durations: number[] = []
    for (let i = 0; i < doc.frameCount; i++) {
      // `durationMs` 缺省按 0 如实给（与内核 `stripTimeline` 的回落同口径：
      // 猜一个值会让"没声明时长"与"声明了 50ms"无法区分）。
      durations.push(doc.frame(i)?.durationMs ?? 0)
    }
    return { count: doc.frameCount, durationsMs: durations }
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
   * legacy 的 `getDoc().value` **逐点对齐**。若 21 处各写一遍"写 legacy + 镜像内核"：
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
    this.main.replaceDoc(next)
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
    const next = current
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
   * ## 它与 `getDoc()` 的关系（这是本批最重要的一处说明）
   *
   * 两者此刻**并存**，且分工明确、各有退出条件：
   *  - `getDoc()` 是**文档内容**的读面（旧 `RuntimeDocument`）。工作台的
   *    文档内容迁移（`kernel-property-write-dual-track` 接缝的退出条件）
   *    需要 `ReadView` 的相机/embed 初始视图读面 + 属性写链迁移，
   *    本批补齐了读面但**未**完成内容迁移 ⇒ 该接缝仍登记在案；
   *  - 本方法是**时间 / 播放 / 帧下标**的读面。这一条本批**已完成**迁移：
   *    旧 `Main.currentFrameIndex` / `Main.framesPlaybackIsPlaying` 两个
   *    Vue Ref 已被删除，全部消费者改吃本会话（见 `retirementRegistry` 的
   *    `world-frame-playback` 组，相位已翻 `executed`）。
   *
   * ⇒ 两件事**不是**同一件未竟工作的两半：播放/时间面已收口，
   * 文档内容面仍开着。把它们混为一谈会让"播放已迁移"被误读成"迁移没做"。
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
    const kernel = this.kernel
    if (kernel === null) return false
    if (!kernel.hasAdoptedContent()) return false
    const ticket = kernel.submit(command)
    kernel.drain()
    const outcome = kernel.settlementOf(ticket)
    // ⚠️ 只有真的 `applied` 才回写：`rejected`/`unchanged` 时内核内容没变，
    // 回写会把 legacy 也改成"内核的旧值"，反而**抹掉**调用方可能要保留的状态。
    if (outcome === null || outcome.status !== 'applied') return false
    // 回写（`false` 表示引用未变 ⇒ 无需动作，不是失败）
    this.syncLegacyFromKernel()
    return true
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
   * | 选择/拾取要知道"当前帧的网格" | `ctx.getDoc().value?.frame(i)` | **文档内容**仍是旧 `RuntimeDocument`（该迁移未完成，见 `requireKernelSession` 的说明） |
   *
   * 第三行是本条与"文档内容迁移"的分界：帧**下标**（时间面）已迁到内核，
   * 帧**内容**（网格数据）仍读旧文档。混为一谈会让"下标已迁移"被误读成
   * "内容也迁移了"。
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
  getHoveredBlock(): Ref<BlockRef | null> {
    if (this.isEmbed()) workbenchUnavailable('hoveredBlock')
    this.workbenchHoverBlock ??= createWorkbenchHoverBlockRef(this)
    return this.workbenchHoverBlock
  }
  getHoveredAnnotationId(): Ref<string | null> {
    if (this.isEmbed()) workbenchUnavailable('hoveredAnnotationId')
    this.workbenchHoverAnnotation ??= createWorkbenchHoverAnnotationIdRef(this)
    return this.workbenchHoverAnnotation
  }

  getSelection(): SelectionContext {
    return this.workbench?.selection ?? embedUnavailable('selection')
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
