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
