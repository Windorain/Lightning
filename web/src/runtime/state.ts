import { reactive, ref } from 'vue'
import type { BlockRef, SelectionContext } from '@/context/selection'
import type { UndoManager } from '@/context/editHistory'
import type { ToolRegistry } from '@/workbench/tools/registry'
import type { Rect, RNARegistry } from '@/shared/types'
import type { bScreen } from '@/workbench/ux/types/screen'
import type { ConnectionState, UIWorkspace, WorkbenchWorkspaceMode } from '@/runtime/types'
import type { EmbedSession, ToolSettings, WorkbenchSession } from '@/runtime/contextAccess'
import { defaultWikiConfig } from '@/runtime/wikiConfigDefaults'

/** 非 setting 服务：选中、撤销、工具注册、布局 RNA 等 */
export interface WorkbenchServices {
  selection: SelectionContext
  editHistory: UndoManager
  toolRegistry: ToolRegistry
  screen: bScreen | null
  rna: RNARegistry
  ui: {
    boundsOfByOperator(opId: string): Rect[]
    boundsOfByRNAPath(rnaPath: string): Rect[]
  }
}

export interface WorkbenchState extends WorkbenchServices {
  tool: ToolSettings
  session: WorkbenchSession
  wiki: Record<string, unknown>
}

export function createWorkbenchState(deps: {
  tool: ToolSettings
  selection: SelectionContext
  editHistory: UndoManager
  toolRegistry: ToolRegistry
  screen: bScreen | null
  rna: RNARegistry
  ui: WorkbenchState['ui']
  wiki?: Record<string, unknown>
}): WorkbenchState {
  return {
    selection: deps.selection,
    editHistory: deps.editHistory,
    toolRegistry: deps.toolRegistry,
    screen: deps.screen,
    rna: deps.rna,
    ui: deps.ui,
    tool: deps.tool,
    wiki: deps.wiki ?? defaultWikiConfig(),
    session: {
      workspaceMode: ref<WorkbenchWorkspaceMode>('local-file'),
      uiWorkspace: ref<UIWorkspace>('preview'),
      localFileName: ref<string | null>(null),
      connection: reactive<ConnectionState>({
        apiBase: '',
        token: '',
        connected: null,
        exports: [],
        exportsLoading: false,
        selectedExportName: null,
      }),
      layerWorldY: ref(-1),
      hoveredBlock: ref<BlockRef | null>(null),
    },
  }
}

export interface EmbedState {
  tool: ToolSettings
  session: EmbedSession
  wiki: Record<string, unknown>
}

export function createEmbedState(
  tool: ToolSettings,
  extras?: {
    initialCamera?: import('@/preview/previewConfig').InitialCamera
    initialLayerWorldY?: number
  },
): EmbedState {
  return {
    tool,
    wiki: {},
    session: {
      layerWorldY: ref(extras?.initialLayerWorldY ?? -1),
      initialCamera: extras?.initialCamera,
    },
  }
}
