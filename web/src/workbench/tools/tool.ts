// web/src/workbench/tools/tool.ts
import type { Ref } from 'vue'
import type { SceneContext } from '@/workbench/sceneContext'
import type { SelectionContext, BlockRef } from '@/workbench/selectionContext'
import type { UndoManager } from '@/workbench/editHistoryContext'
import type { ViewportSlot } from '@/workbench/context/bContext'
import type { InputBinding } from '@/workbench/keymap'
import type { Frame } from '@/render/schema/types'

/** Tool 是纯数据结构，没有方法。交互走 Gizmo，数据改写走 Operator。 */
export interface Tool {
  id: string
  label: string
  icon: string
  cursor?: string

  /** 动态键映射：激活时注入，优先于默认 keymap 匹配 */
  keymap?: InputBinding[]
  /** 回退键映射：同一工具的第二组绑定（不是另一个 Tool） */
  keymapFallback?: InputBinding[]

  /** 主操作符 ID（内省 / 提示 / 快捷键标签） */
  operator?: string
  /** 操作符属性预设：键映射匹配时自动注入，keymap item 的 props 覆盖这些值 */
  properties?: Record<string, unknown>
}

/** Gizmo 是交互+渲染入口。一个 Tool 可以关联零个或一个 Gizmo。 */
export interface ToolGizmo {
  activate(ctx: ToolContext): void
  deactivate(): void

  onPointerDown?(ctx: ToolContext, event: PointerEvent): void
  onPointerMove?(ctx: ToolContext, event: PointerEvent): void
  onPointerUp?(ctx: ToolContext, event: PointerEvent): void

  /** rAF 每帧渲染 */
  render(ctx: ToolContext): void
}

/** ToolContext 是传递给 Tool 和 Gizmo 的运行环境。 */
export interface ToolContext {
  scene: SceneContext
  selection: SelectionContext
  editHistory: UndoManager
  viewport: ViewportSlot

  pickVoxel(event: PointerEvent): BlockRef | null
  getCurrentFrame(): Frame | null
  /** 将 Y-up GridPos 转换为世界空间体素中心坐标 */
  gridCenterWorld(pos: { x: number; y: number; z: number }): { x: number; y: number; z: number } | null

  /** 调用操作符 */
  invokeOperator(id: string, props?: Record<string, unknown>, event?: Event, regionId?: string): string
  execOperator(id: string, props?: Record<string, unknown>): void

  /** 当前活跃 Tool（切换工具时由 ToolRegistry 更新） */
  readonly activeTool: Ref<Tool | null>

  /** 工具 transient 状态（draft 注解数据等），工具切换时 reset */
  transient: Record<string, unknown>
  resetTransient(): void

  /** 查询指定 region 的模态栈深度。>0 表示有操作符在模态运行中 */
  modalDepth(regionId: string): number
}
