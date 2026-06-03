import type { SelectionContext } from '@/context/selection'
import type { UndoManager } from '@/context/editHistory'
import type { ToolRegistry } from '@/workbench/tools/registry'
import type { Rect, RNARegistry } from '@/shared/types'

/** Workbench 编辑服务（非 Screen 树状态） */
export interface WorkbenchServices {
  selection: SelectionContext
  editHistory: UndoManager
  toolRegistry: ToolRegistry
  rna: RNARegistry
  ui: {
    boundsOfByOperator(opId: string): Rect[]
    boundsOfByRNAPath(rnaPath: string): Rect[]
  }
}
