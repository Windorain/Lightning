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
  ) {
    // 绑到实例的 `this`：调用点会 `const t = ctx.t`（见字段文档）。
    this.t = (key: string) => this.wm.settings.t(key)
    this.readOnlyDiagnostics = asReadOnlyDiagnostics(this.wm.diagnostics)
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
   * 内容**重读请求**（原 `getStructEpoch()`）。
   *
   * 它不是"重建版本"：呈现层会重读内容并自行判断要不要重建
   * （见 `presentation/contentSignal` 与 `runtime/drwMeshPipeline` 文件头）。
   */
  getContentRefreshTick(): Ref<number> {
    return this.main.contentRefreshTick
  }
  getCurrentFrameIndex(): Ref<number> {
    return this.main.currentFrameIndex
  }

  /** 按 region 取 Main 逻辑相机 */
  getViewportCamera(regionId?: string): Ref<import('@/runtime/viewportCamera').ViewportCameraState | null> {
    const rid = regionId ?? this.resolveInputRegionId() ?? this.viewports.activeId.value
    const slot = rid ? this.viewports.get(rid) : this.viewports.active.value
    if (!slot) throw new Error('getViewportCamera: no viewport slot')
    return this.main.cameras[slot.cameraMainKey]
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
