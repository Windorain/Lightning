/**
 * ToolRegistry — 对标 Blender 的工具激活系统。
 *
 * 现在是 OperatorRegistry 的薄包装层：
 * - 管理"活跃工具"（即当前被选中的操作符）
 * - 提供 ToolShelf 所需的显示元数据（icon, cursor, defaultKey）
 * - Tab 切换（select ↔ 上次编辑工具）
 *
 * 实际的交互事件由 activeToolHandler 直接通过 globalOperators 分发。
 */
import type { InjectionKey, Ref } from 'vue'
import { inject, provide, ref } from 'vue'
import type { BContext } from '@/workbench/context/bContext'
import { globalOperators } from '@/workbench/operators/operatorRegistry'
import { logToolActivated } from '@/workbench/debug/debugLog'

const OPERATOR_TOOL_META: Record<string, { icon: string; cursor?: string; defaultKey?: string }> = {
  OPERATOR_SELECT:       { icon: '▲', cursor: 'default' },
  OPERATOR_MOVE:          { icon: '↕', cursor: 'move', defaultKey: 'g' },
  OPERATOR_DELETE:        { icon: '✕', defaultKey: 'x' },
  OPERATOR_REPLACE:       { icon: '🖌', cursor: 'crosshair', defaultKey: 'r' },
  OPERATOR_FILL:          { icon: '⬛', defaultKey: 'f' },
  OPERATOR_EYEDROPPER:    { icon: '💉', defaultKey: 'e' },
  OPERATOR_MIRROR:        { icon: '↔', defaultKey: 'Ctrl+m' },
  OPERATOR_GENERATE:      { icon: '＋', defaultKey: 'Shift+a' },
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
  readonly tools: Map<string, OperatorTool>
  activate(id: string, bctx?: BContext): void
  deactivate(): void
  getPreviousEditToolId(): string | null
}

export const toolRegistryKey: InjectionKey<ToolRegistry> = Symbol('toolRegistry')

export function provideToolRegistry(): ToolRegistry {
  const activeTool = ref<OperatorTool | null>(null)
  let previousEditToolId: string | null = null

  function buildToolList(): Map<string, OperatorTool> {
    const map = new Map<string, OperatorTool>()
    for (const op of globalOperators.all()) {
      const meta = OPERATOR_TOOL_META[op.id] ?? { icon: '?' }
      map.set(op.id, {
        id: op.id,
        label: op.label,
        icon: meta.icon,
        cursor: meta.cursor,
        defaultKey: meta.defaultKey,
      })
    }
    return map
  }

  const tools = buildToolList()

  function activate(id: string, _bctx?: BContext): void {
    const tool = tools.get(id)
    if (!tool || activeTool.value?.id === id) return

    // Track last non-select tool for Tab toggle
    if (activeTool.value && activeTool.value.id !== 'OPERATOR_SELECT') {
      previousEditToolId = activeTool.value.id
    }

    activeTool.value = tool
    logToolActivated(id)
  }

  function deactivate(): void {
    activeTool.value = tools.get('OPERATOR_SELECT') ?? null
    previousEditToolId = null
  }

  function getPreviousEditToolId(): string | null {
    return previousEditToolId
  }

  const registry: ToolRegistry = {
    activeTool,
    tools,
    activate,
    deactivate,
    getPreviousEditToolId,
  }
  provide(toolRegistryKey, registry)
  return registry
}

export function useToolRegistry(): ToolRegistry {
  const ctx = inject(toolRegistryKey)
  if (!ctx) throw new Error('useToolRegistry() 须在 WorkbenchRoot 子树内调用')
  return ctx
}
