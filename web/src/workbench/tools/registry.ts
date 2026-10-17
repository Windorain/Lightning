// web/src/workbench/toolRegistry.ts
import type { InjectionKey, Ref } from 'vue'
import { inject, provide, ref } from 'vue'
import type { Tool, ToolGizmo, ToolContext } from '@/workbench/tools/tool'

export { type Tool, type ToolGizmo } from '@/workbench/tools/tool'

/**
 * 造一个 gizmo **实例**（M4-1：gizmo 与工具上下文都按 region 归属）。
 *
 * ## 为什么是工厂而不是实例
 *
 * gizmo 的呈现根是 Three 的 `Object3D`，而一个 `Object3D` 只能有一个父节点。
 * Area 分割出第二个 3D 视口后，"两区各有一份 gizmo"在结构上就等于
 * "每个视口槽位各自持有一个实例"—— 注册期还不知道未来会分割出哪些 region，
 * 故注册的是**造实例的工厂**，实例在某个 region 第一次需要时造出来并缓存
 * （见 {@link ToolRegistry#gizmoOf}）。
 */
export type ToolGizmoFactory = () => ToolGizmo

export interface ToolRegistry {
  readonly activeTool: Ref<Tool | null>
  readonly tools: Map<string, Tool>
  readonly lastToolId: Ref<string | null>

  register(tool: Tool, gizmo?: ToolGizmoFactory): void
  activate(id: string): void
  deactivate(): void
  getTool(id: string): Tool | undefined

  /**
   * 该工具是否**有** gizmo（纯判定，不造实例）。缺省 = 当前激活工具。
   *
   * keymapHandler 用它决定"指针按下后要不要进入拖拽转视角"—— 有 gizmo 时
   * 那次按下属于 gizmo，不能同时被解释成视角拖拽（既有语义）。
   */
  hasGizmo(toolId?: string): boolean

  /**
   * 登记**某个 region** 的工具上下文（该视口 ready 时以自己的 regionId 写入）。
   *
   * 旧实现是一个 `_toolCtx` 单例，"最后 ready 的视口赢"⇒ 第二区的 gizmo
   * 拿到的是第一区的构建的上下文（S0 域 1 缺口 ④）。
   */
  setToolContext(regionId: string, ctx: ToolContext): void
  /** 该 region 的视口卸载时调用（清上下文与该区实例，避免指向已拆的视口）。 */
  clearToolContext(regionId: string): void
  /** 某 region 的工具上下文（未 ready ⇒ `null`）。 */
  toolContextFor(regionId: string): ToolContext | null

  /** **当前工具**在某个 region 的 gizmo 实例（没有 ⇒ `null`）。 */
  gizmoFor(regionId: string): ToolGizmo | null
  /** **指定工具**在某个 region 的 gizmo 实例（呈现/挂载用；见 {@link ToolGizmoFactory}）。 */
  gizmoOf(toolId: string, regionId: string): ToolGizmo | null
}

export const toolRegistryKey: InjectionKey<ToolRegistry> = Symbol('toolRegistry')

export function provideToolRegistry(): ToolRegistry {
  const tools = new Map<string, Tool>()
  const factories = new Map<string, ToolGizmoFactory>()
  /** `${toolId}@${regionId}` → 实例（每区一份，见 {@link ToolGizmoFactory}） */
  const instances = new Map<string, ToolGizmo>()
  /** regionId → 该视口的工具上下文 */
  const contexts = new Map<string, ToolContext>()

  const activeTool = ref<Tool | null>(null)
  const lastToolId = ref<string | null>(null)

  const keyOf = (toolId: string, regionId: string): string => `${toolId}@${regionId}`

  /** 取/造某个工具在某个 region 的实例（纯缓存，不 activate）。 */
  function instanceOf(toolId: string, regionId: string): ToolGizmo | null {
    const factory = factories.get(toolId)
    if (!factory) return null
    const k = keyOf(toolId, regionId)
    let gizmo = instances.get(k)
    if (!gizmo) {
      gizmo = factory()
      instances.set(k, gizmo)
    }
    return gizmo
  }

  /** 激活某工具在**每一个已就绪 region** 的实例（各自拿到**自己**的上下文）。 */
  function activateEverywhere(toolId: string): void {
    for (const [regionId, tctx] of contexts) {
      instanceOf(toolId, regionId)?.activate(tctx)
    }
  }

  function deactivateAll(): void {
    for (const gizmo of instances.values()) gizmo.deactivate()
  }

  function register(tool: Tool, gizmo?: ToolGizmoFactory): void {
    tools.set(tool.id, tool)
    if (gizmo) factories.set(tool.id, gizmo)
  }

  function activate(id: string): void {
    const tool = tools.get(id)
    if (!tool || activeTool.value?.id === id) return

    // Deactivate previous tool（每个区的那一份都退）
    if (activeTool.value) deactivateAll()

    // Track last non-select tool for Tab toggle
    if (activeTool.value && activeTool.value.id !== 'select') {
      lastToolId.value = activeTool.value.id
    }

    activeTool.value = tool
    activateEverywhere(id)
  }

  function deactivate(): void {
    deactivateAll()
    activeTool.value = tools.get('select') ?? null
    lastToolId.value = null
  }

  function getTool(id: string): Tool | undefined {
    return tools.get(id)
  }

  function hasGizmo(toolId?: string): boolean {
    const id = toolId ?? activeTool.value?.id
    return id !== undefined && factories.has(id)
  }

  function setToolContext(regionId: string, ctx: ToolContext): void {
    contexts.set(regionId, ctx)
    const tool = activeTool.value
    if (!tool) return
    // 该区第一次 ready / 重挂后再 ready：让本区实例拿到**本区**的上下文。
    instanceOf(tool.id, regionId)?.activate(ctx)
  }

  function clearToolContext(regionId: string): void {
    contexts.delete(regionId)
    // 该区的实例随视口一起退场（其呈现根挂在该区的 toolsOverlayGroup 里）
    for (const [k, gizmo] of [...instances]) {
      if (!k.endsWith('@' + regionId)) continue
      gizmo.deactivate()
      instances.delete(k)
    }
  }

  function toolContextFor(regionId: string): ToolContext | null {
    return contexts.get(regionId) ?? null
  }

  function gizmoFor(regionId: string): ToolGizmo | null {
    const tool = activeTool.value
    return tool ? instanceOf(tool.id, regionId) : null
  }

  function gizmoOf(toolId: string, regionId: string): ToolGizmo | null {
    return instanceOf(toolId, regionId)
  }

  const registry: ToolRegistry = {
    activeTool, tools, lastToolId,
    register, activate, deactivate, getTool, hasGizmo,
    setToolContext, clearToolContext, toolContextFor,
    gizmoFor, gizmoOf,
  }
  provide(toolRegistryKey, registry)
  return registry
}

export function useToolRegistry(): ToolRegistry {
  const ctx = inject(toolRegistryKey)
  if (!ctx) throw new Error('useToolRegistry() must be called within WorkbenchRoot subtree')
  return ctx
}
