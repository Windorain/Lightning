// web/src/workbench/toolRegistry.ts
import type { InjectionKey, Ref } from 'vue'
import { inject, provide, ref } from 'vue'
import type { Tool, ToolGizmo, ToolContext } from '@/workbench/tools/tool'

export { type Tool, type ToolGizmo } from '@/workbench/tools/tool'

export interface ToolRegistry {
  readonly activeTool: Ref<Tool | null>
  readonly activeGizmo: Ref<ToolGizmo | null>
  readonly tools: Map<string, Tool>
  readonly lastToolId: Ref<string | null>

  register(tool: Tool, gizmo?: ToolGizmo): void
  activate(id: string): void
  deactivate(): void
  getTool(id: string): Tool | undefined
  setToolContext(ctx: ToolContext): void
}

export const toolRegistryKey: InjectionKey<ToolRegistry> = Symbol('toolRegistry')

export function provideToolRegistry(): ToolRegistry {
  const tools = new Map<string, Tool>()
  const gizmos = new Map<string, ToolGizmo>()
  const activeTool = ref<Tool | null>(null)
  const activeGizmo = ref<ToolGizmo | null>(null)
  const lastToolId = ref<string | null>(null)
  let _toolCtx: ToolContext | null = null

  function register(tool: Tool, gizmo?: ToolGizmo): void {
    tools.set(tool.id, tool)
    if (gizmo) gizmos.set(tool.id, gizmo)
  }

  function activate(id: string): void {
    const tool = tools.get(id)
    if (!tool || activeTool.value?.id === id) return

    // Deactivate previous tool
    if (activeTool.value) {
      activeGizmo.value?.deactivate()
    }

    // Track last non-select tool for Tab toggle
    if (activeTool.value && activeTool.value.id !== 'select') {
      lastToolId.value = activeTool.value.id
    }

    activeTool.value = tool
    const gizmo = gizmos.get(id) ?? null
    activeGizmo.value = gizmo
    if (gizmo && _toolCtx) {
      gizmo.activate(_toolCtx)
    }
  }

  function deactivate(): void {
    activeGizmo.value?.deactivate()
    const select = tools.get('select')
    activeTool.value = select ?? null
    activeGizmo.value = select ? (gizmos.get('select') ?? null) : null
    lastToolId.value = null
  }

  function getTool(id: string): Tool | undefined {
    return tools.get(id)
  }

  function setToolContext(ctx: ToolContext): void {
    _toolCtx = ctx
    if (activeGizmo.value) {
      activeGizmo.value.activate(ctx)
    }
  }

  const registry: ToolRegistry = {
    activeTool, activeGizmo, tools, lastToolId,
    register, activate, deactivate, getTool, setToolContext,
  }
  provide(toolRegistryKey, registry)
  return registry
}

export function useToolRegistry(): ToolRegistry {
  const ctx = inject(toolRegistryKey)
  if (!ctx) throw new Error('useToolRegistry() must be called within WorkbenchRoot subtree')
  return ctx
}
