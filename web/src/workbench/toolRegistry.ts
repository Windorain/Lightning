// web/src/workbench/toolRegistry.ts

import type { InjectionKey, Ref } from 'vue'
import { inject, provide, ref } from 'vue'
import type { ThreeToolContext } from '@/workbench/tools/_base'
import { logToolActivated } from '@/workbench/debug/debugLog'

export interface Tool {
  id: string
  label: string
  icon: string
  cursor?: string
  defaultKey?: string
  onActivate?(ctx: ThreeToolContext): void
  onDeactivate?(): void
  onPointerDown?(ctx: ThreeToolContext, event: PointerEvent): void
  onPointerMove?(ctx: ThreeToolContext, event: PointerEvent): void
  onPointerUp?(ctx: ThreeToolContext, event: PointerEvent): void
  onKeyDown?(ctx: ThreeToolContext, event: KeyboardEvent): void
  renderOverlay?(ctx: ThreeToolContext): void
}

export interface ToolRegistry {
  readonly activeTool: Ref<Tool | null>
  readonly tools: Map<string, Tool>
  register(tool: Tool): void
  activate(id: string, ctx?: ThreeToolContext): void
  deactivate(): void
  getPreviousEditToolId(): string | null
  setToolContext(ctx: ThreeToolContext): void
}

export const toolRegistryKey: InjectionKey<ToolRegistry> = Symbol('toolRegistry')

export function provideToolRegistry(): ToolRegistry {
  const tools = new Map<string, Tool>()
  const activeTool = ref<Tool | null>(null)
  let previousEditToolId: string | null = null
  let _toolCtx: ThreeToolContext | undefined

  function register(tool: Tool): void {
    tools.set(tool.id, tool)
  }

  function activate(id: string, ctx?: ThreeToolContext): void {
    const tool = tools.get(id)
    if (!tool || activeTool.value?.id === id) return
    // Deactivate previous tool
    activeTool.value?.onDeactivate?.()
    // Track last non-select tool for Tab toggle
    if (activeTool.value && activeTool.value.id !== 'select') {
      previousEditToolId = activeTool.value.id
    }
    activeTool.value = tool
    const resolvedCtx = ctx ?? _toolCtx
    resolvedCtx?.resetTransientState()
    if (tool.onActivate && resolvedCtx) {
      tool.onActivate(resolvedCtx)
    }
    logToolActivated(id)
  }

  function deactivate(): void {
    activeTool.value?.onDeactivate?.()
    activeTool.value = tools.get('select') ?? null
    previousEditToolId = null
  }

  function getPreviousEditToolId(): string | null {
    return previousEditToolId
  }

  function setToolContext(ctx: ThreeToolContext): void {
    _toolCtx = ctx
  }

  const registry: ToolRegistry = { activeTool, tools, register, activate, deactivate, getPreviousEditToolId, setToolContext }
  provide(toolRegistryKey, registry)
  return registry
}

export function useToolRegistry(): ToolRegistry {
  const ctx = inject(toolRegistryKey)
  if (!ctx) throw new Error('useToolRegistry() 须在 WorkbenchRoot 子树内调用')
  return ctx
}
