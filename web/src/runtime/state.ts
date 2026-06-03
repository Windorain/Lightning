import { reactive, ref } from 'vue'
import type { Ref } from 'vue'
import type { BlockRef, SelectionContext } from '@/context/selection'
import type { UndoManager } from '@/context/editHistory'
import type { ToolRegistry } from '@/workbench/tools/registry'
import type { Rect, RNARegistry } from '@/shared/types'
import type { bScreen } from '@/workbench/ux/types/screen'
import type {
  ConnectionState,
  ContextSettings,
  UIWorkspace,
  WorkbenchWorkspaceMode,
} from '@/runtime/types'
import { defaultWikiConfig } from '@/runtime/wikiConfigDefaults'

export interface WorkbenchState {
  selection: SelectionContext
  editHistory: UndoManager
  toolRegistry: ToolRegistry
  settings: ContextSettings
  workspaceMode: Ref<WorkbenchWorkspaceMode>
  uiWorkspace: Ref<UIWorkspace>
  localFileName: Ref<string | null>
  connection: ConnectionState
  wikiConfig: Record<string, unknown>
  layerWorldY: Ref<number>
  hoveredBlock: Ref<BlockRef | null>
  theme: Ref<'dark' | 'light'>
  lang: Ref<'zh' | 'en'>
  screen: bScreen | null
  rna: RNARegistry
  ui: {
    boundsOfByOperator(opId: string): Rect[]
    boundsOfByRNAPath(rnaPath: string): Rect[]
  }
}

export function createWorkbenchState(deps: {
  selection: SelectionContext
  editHistory: UndoManager
  toolRegistry: ToolRegistry
  settings: ContextSettings
  screen: bScreen | null
  rna: RNARegistry
  ui: WorkbenchState['ui']
  wikiConfig?: Record<string, unknown>
}): WorkbenchState {
  return {
    ...deps,
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
    wikiConfig: deps.wikiConfig ?? defaultWikiConfig(),
    layerWorldY: ref(-1),
    hoveredBlock: ref<BlockRef | null>(null),
    theme: ref(deps.settings.theme ?? 'dark'),
    lang: ref(deps.settings.language ?? 'zh'),
  }
}

export interface EmbedState {
  settings: ContextSettings
  wikiConfig: Record<string, unknown>
  initialCamera?: import('@/preview/previewConfig').InitialCamera
}

export function createEmbedState(
  settings: ContextSettings,
  extras?: { initialCamera?: import('@/preview/previewConfig').InitialCamera },
): EmbedState {
  return {
    settings,
    wikiConfig: {},
    initialCamera: extras?.initialCamera,
  }
}
