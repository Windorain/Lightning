/**
 * `shared/viewport/editorViewportHost` —— **单一视口宿主**的策略与读面类型（M7-4 段 B）。
 *
 * ## 本模块替代的分叉（S0-A §2 #6 / S0-B D7）
 *
 * M7-4 之前，`WorkbenchViewport`（496 行）与 `EmbedViewport`（603 行）各写一遍
 * 同一段"视口粘合"：
 *
 * | 粘合 | 旧工作台 | 旧嵌入 |
 * |---|---|---|
 * | 通道取值 / 视口运行时 | `useViewportRuntime` + `useKernelChannels` | 同一对（各自调用一次） |
 * | 载入时机 | onMounted + 文档 false→true 重装 | 仅 onMounted |
 * | 相机纪律 | `attachViewport` 的台账 | **另写一份** `didInitCamera` watch |
 * | 卸载顺序 | detach → 注销 region → drw.dispose → **归零槽位** | detach → 注销 region → drw.dispose（**漏归零**，D6） |
 * | dock tab 默认 | 用户选择/文档形态分离 | setup 时求值一次（同一类 bug 的旧形态） |
 *
 * 现在这些只有一份实现：`EditorViewportHost.vue`。两壳只提供**呈现**（标题栏/侧栏/
 * 状态栏/提示条）与**策略**（走这个文件里的类型）：
 *
 *  - `EditorViewportPolicy`：呈现输入（场景背景/图标缓存/轴）、dock 允许项、
 *    输入处理器、描边绑定、装载后钩子、局部状态、拖放能力。
 *  - `EditorViewportHostApi`：宿主暴露给壳的读面（视口运行时结果 + dock 状态 + 动作）。
 *
 * ## 为什么差异用**策略字段**而不是 `if (isEmbed)`
 *
 * SPEC §4.1 / §10.10：外壳与宿主不是领域规则的另一个实现，同一规则适用于所有宿主。
 * 合壳后若某个能力是"嵌入故意没有"的，它必须表达为**能力/装配**（`ShellRuntime`）
 * 或**策略值**（本文件的字段），而不是组件内部的宿主名判断。本文件里没有任何
 * `isEmbed` / profile 字段 —— 每个差异都对应一个显式策略项。
 */

import type { UnwrapRef } from 'vue'
import type { Context } from '@/runtime/context'
import type { DRW, OutlinePlanPort } from '@/runtime/drw'
import type { RenderEngineReadyPayload } from '@/runtime/renderEngine'
import type { ViewportSlot } from '@/runtime/types'
import type { ViewportBinderHandlers } from '@/runtime/viewportBinder'
import type { SelectionOutlineBind } from '@/runtime/attachViewport'
import type { ViewerPreferences } from '@/viewer/preferences'
import type { BlockIconCacheOptions } from '@/render/interaction/blockIconCache'
import type { useViewportRuntime } from '@/shared/viewport/useViewportRuntime'
import type { useKernelChannels } from '@/shared/viewport/useKernelChannels'
import type { ViewportDockTab } from '@/shared/viewport/dockTabs'

type Runtime = ReturnType<typeof useViewportRuntime>
type Channels = ReturnType<typeof useKernelChannels>
type Value<T> = UnwrapRef<T>

/** dock 的宿主策略（工作台恒显示分层/帧；嵌入由 `features` 开关决定）。 */
export interface EditorViewportDockPolicy {
  /** 帧控制 tab 是否被允许（还需文档确实是多帧）。 */
  readonly showFrameTab: boolean
  /** 分层预览 tab 是否被允许。 */
  readonly showLayerTab: boolean
  /**
   * `true` ⇒ 可用 tab 为空时不渲染 dock（嵌入的 `hasBottomDock` 语义）；
   * `false` ⇒ 只要场景已装载就渲染（工作台恒有帧/层两个 tab）。
   */
  readonly hideWhenEmpty: boolean
  readonly theme: 'workbench' | 'embed'
}

/** 装载完成后的宿主接线面（工作台用它挂 gizmo / 逐帧 overlay）。 */
export interface EditorViewportAttachedApi {
  readonly ctx: Context
  readonly regionId: string
  readonly drw: DRW
  readonly vpSlot: ViewportSlot
  readonly payload: RenderEngineReadyPayload
  /** 向本视口的渲染引擎登记逐帧钩子；**卸载时宿主统一摘除**（调用方不要自己存）。 */
  addFrameHook(fn: () => void): void
  /** 本视口是否仍活着（迟到的 rAF 回调用它早退；卸载后恒 false）。 */
  isAlive(): boolean
}

export interface EditorViewportPolicy {
  /** 渲染配置（来自宿主设置；工作台用缺省）。 */
  readonly blockIconCacheOptions?: BlockIconCacheOptions
  readonly initialWorldFrameIndex?: number
  readonly sceneBackground?: number
  readonly showAxesGizmo?: boolean
  /** dock 策略。 */
  readonly dock: EditorViewportDockPolicy
  /** 指针/键盘处理器（工作台注入 gizmo+keymap；嵌入注入 touch+keymap）。 */
  input(api: { ctx: Context; regionId: string }): ViewportBinderHandlers
  /** 是否绑定 document 级 keydown（嵌入为 false：没有页面级输入面）。 */
  readonly documentKeydown?: boolean
  /** 描边绑定（选择集/悬停/几何源由壳提供；描边规划端口由宿主注入）。 */
  selection(api: {
    ctx: Context
    regionId: string
    prefs: ViewerPreferences
    outlinePlans: OutlinePlanPort
  }): SelectionOutlineBind
  /** 装载完成后的壳接线（可选）。 */
  onAttached?(api: EditorViewportAttachedApi): void
  /** detach 之前的壳清理（可选；工作台清工具上下文）。 */
  onBeforeDetach?(api: { ctx: Context; regionId: string }): void
  /** 本视口的局部状态（dock tab 的用户显式选择；缺省 = 没选过）。 */
  readonly localState?: Record<string, unknown>
  /** 文件拖放能力（**存在即可用**；嵌入不提供，于是没有拖放）。 */
  onDropFile?(file: File): void
}

/** dock 的呈现状态（宿主按当前文档形态算好；壳只负责放到正确位置）。 */
export interface EditorViewportDockState {
  readonly show: boolean
  readonly theme: 'workbench' | 'embed'
  readonly showFrameTab: boolean
  readonly showLayerTab: boolean
  readonly hasWorldMultiFrame: boolean
  readonly worldFrameIndex: number
  readonly worldFrameCount: number
  readonly isPlaying: boolean
  readonly meshBusy: boolean
  readonly gridHeight: number
  readonly layerWorldY: number
  readonly layerPreviewLabel: string
  readonly channelPanel: Channels['panel']['value']
  readonly activeTab: ViewportDockTab
}

/**
 * `EditorViewportHost` 暴露给壳的读面。
 *
 * 全部是**值 / 函数**（不是 `Ref`）：宿主用 getter 暴露，壳在模板里读它们时
 * 依赖收集发生在壳的渲染副作用上 ⇒ 状态变化照常触发重渲（见宿主文件的说明）。
 */
export interface EditorViewportHostApi {
  readonly drw: DRW
  readonly vpSlot: ViewportSlot
  readonly loadStatus: Value<Runtime['loadStatus']>
  readonly meshBusy: Value<Runtime['meshBusy']>
  readonly blockIconCache: Value<Runtime['blockIconCache']>
  readonly tooltipPalette: Value<Runtime['tooltipPalette']>
  readonly structureDefinition: Value<Runtime['structureDefinition']>
  readonly mainMeshGroup: Value<Runtime['mainMeshGroup']>
  readonly worldFrameIndex: Value<Runtime['worldFrameIndex']>
  readonly layerWorldY: Value<Runtime['layerWorldY']>
  readonly isPlaying: Value<Runtime['isPlaying']>
  readonly layerPreviewMode: Value<Runtime['computed']['layerPreviewMode']>
  readonly layerPreviewLabel: Value<Runtime['computed']['layerPreviewLabel']>
  readonly gridHeight: Value<Runtime['computed']['gridHeight']>
  readonly hasWorldMultiFrame: Value<Runtime['computed']['hasWorldMultiFrame']>
  readonly worldFrameCount: Value<Runtime['computed']['worldFrameCount']>
  readonly blockStatsEntries: Value<Runtime['computed']['blockStatsEntries']>
  readonly channelPanel: Channels['panel']['value']
  /** dock 的当前状态（宿主算好；壳决定渲染位置）。 */
  readonly dock: EditorViewportDockState
  /** 是否正有文件悬停在画布上（只有提供了 `onDropFile` 的宿主会为真）。 */
  readonly dragOver: boolean
  setActiveTab(tab: ViewportDockTab): void
  setFrameIndex(index: number): void
  togglePlayback(): void
  setLayerY(y: number): void
  setChannelTier(value: number): void
  setChannelValue(payload: { key: string; value: number }): void
  setChannelRunstate(id: string): void
  /** 本实例的局部状态（由 `AreaHost` 在关闭前问）。 */
  captureLocalState(): Record<string, unknown>
  /** 即兴抓屏（M6-6：**不是**正式导出；读当前活画布）。 */
  screenshot(): void
}