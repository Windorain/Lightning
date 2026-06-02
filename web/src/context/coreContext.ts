/**
 * Core BContext 共享字段工厂 — 被 workbench 和 embed 复用。
 *
 * createCoreBContext() 创建 workbench 和 embed 共用的字段：
 * doc, dirty, structEpoch, currentWorldFrameIndex, workspaceMode, uiWorkspace,
 * localFileName, connection, viewports, eventDispatcher, wikiConfig, operators。
 *
 * 调用方传入自己的 operators 对象（workbench 和 embed 的 operators 行为不同）。
 * 调用方可覆盖默认值（如 embed 将 uiWorkspace 默认改为 'wiki'）。
 */
import { reactive, ref } from 'vue'
import type { Ref } from 'vue'
import type { BContext, WorkbenchWorkspaceMode, UIWorkspace, ConnectionState } from '@/context/bContext'
import { createViewportManager } from '@/context/bContext'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { EventDispatcherImpl } from '@/events/dispatcher'

export interface CoreBContext {
  doc: Ref<RuntimeDocument | null>
  dirty: Ref<boolean>
  structEpoch: Ref<number>
  currentWorldFrameIndex: Ref<number>
  workspaceMode: Ref<WorkbenchWorkspaceMode>
  uiWorkspace: Ref<UIWorkspace>
  localFileName: Ref<string | null>
  connection: ConnectionState
  viewports: ReturnType<typeof createViewportManager>
  eventDispatcher: EventDispatcherImpl
  wikiConfig: Record<string, any>
  operators: BContext['operators']
}

export function createCoreBContext(operators: BContext['operators']): CoreBContext {
  return {
    doc: ref(null),
    dirty: ref(false),
    structEpoch: ref(0),
    currentWorldFrameIndex: ref(0),
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
    viewports: createViewportManager(),
    eventDispatcher: new EventDispatcherImpl(),
    wikiConfig: {},
    operators,
  }
}
