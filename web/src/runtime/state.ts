import type { SelectionContext } from '@/context/selection'
import type { UndoManager } from '@/context/editHistory'
import type { ToolRegistry } from '@/workbench/tools/registry'
import type { Rect } from '@/shared/types'

/**
 * Workbench 编辑服务（非 Screen 树状态）。
 *
 * **没有 `rna` 字段**：旧的 `rna: RNARegistry` 把一份自带
 * `get`/`set` 闭包的属性描述挂到服务上，等于给所有拿得到 `Context` 的地方
 * 发一把「直接改内存」的钥匙。新的属性访问在 `@/editors/workbench-rna`，
 * 以 `Context` 为**显式输入**，不经服务注册表。
 */
export interface WorkbenchServices {
  selection: SelectionContext
  editHistory: UndoManager
  toolRegistry: ToolRegistry
  ui: {
    boundsOfByOperator(opId: string): Rect[]
    boundsOfByRNAPath(rnaPath: string): Rect[]
  }
}
