import type { InjectionKey, Ref } from 'vue'
import { inject, provide, ref, shallowRef } from 'vue'
import type { BContext } from '@/workbench/context/bContext'
import { globalOperators } from '@/workbench/operators/operatorRegistry'
import { logCenter } from '@/workbench/logging/LogCenter'

const OPERATOR_TOOL_META: Record<string, { icon: string; cursor?: string; defaultKey?: string }> = {
  OPERATOR_SELECT:       { icon: '▲', cursor: 'default' },
  OPERATOR_MOVE:          { icon: '↕', cursor: 'move', defaultKey: 'g' },
  OPERATOR_DELETE:        { icon: '✕', defaultKey: 'x' },
  OPERATOR_REPLACE:       { icon: '🖌', cursor: 'crosshair', defaultKey: 'r' },
  OPERATOR_FILL:          { icon: '⬛', defaultKey: 'f' },
  OPERATOR_EYEDROPPER:    { icon: '💉', defaultKey: 'e' },
  OPERATOR_MIRROR:        { icon: '↔', defaultKey: 'Ctrl+m' },
  OPERATOR_ADD_BLOCK:           { icon: '⬜', cursor: 'crosshair', defaultKey: 'h' },
  OPERATOR_ADD_ANNOTATION_BOX:  { icon: '📝', cursor: 'crosshair', defaultKey: 'j' },
  OPERATOR_ANNOTATION:    { icon: '📝' },
  OPERATOR_LABEL:         { icon: '🏷' },
}

export interface OperatorTool {
  id: string
  label: string
  icon: string
  cursor?: string
  defaultKey?: string
}

export interface ToolRegistry {
  readonly activeTool: Ref<OperatorTool | null>
  readonly tools: Ref<Map<string, OperatorTool>>
  activate(id: string, bctx?: BContext): void
  deactivate(): void
  getPreviousEditToolId(): string | null
  rebuildTools(): void
}

export const toolRegistryKey: InjectionKey<ToolRegistry> = Symbol('toolRegistry')

export function createToolRegistry(): ToolRegistry {
  const activeTool = ref<OperatorTool | null>(null)
  const tools = shallowRef<Map<string, OperatorTool>>(new Map())
  let previousEditToolId: string | null = null

  function rebuildTools(): void {
    const map = new Map<string, OperatorTool>()
    for (const op of globalOperators.all()) {
      const meta = OPERATOR_TOOL_META[op.id]
      if (!meta) continue // skip internal operators (e.g. OPERATOR_MOVE_GIZMO)
      map.set(op.id, {
        id: op.id,
        label: op.label,
        icon: meta.icon,
        cursor: meta.cursor,
        defaultKey: meta.defaultKey,
      })
    }
    tools.value = map
  }

  function activate(id: string, _bctx?: BContext): void {
    const tool = tools.value.get(id)
    if (!tool || activeTool.value?.id === id) return

    if (activeTool.value && activeTool.value.id !== 'OPERATOR_SELECT') {
      previousEditToolId = activeTool.value.id
    }

    activeTool.value = tool
    logCenter.operator('ToolRegistry', `tool activated: ${id}`, { toolId: id, action: 'activate' })
  }

  function deactivate(): void {
    activeTool.value = tools.value.get('OPERATOR_SELECT') ?? null
    previousEditToolId = null
  }

  function getPreviousEditToolId(): string | null {
    return previousEditToolId
  }

  return {
    activeTool,
    tools,
    activate,
    deactivate,
    getPreviousEditToolId,
    rebuildTools,
  }
}

export function provideToolRegistry(): ToolRegistry {
  const registry = createToolRegistry()
  provide(toolRegistryKey, registry)
  return registry
}

export function useToolRegistry(): ToolRegistry {
  const ctx = inject(toolRegistryKey)
  if (!ctx) throw new Error('useToolRegistry() 须在 WorkbenchRoot 子树内调用')
  return ctx
}
