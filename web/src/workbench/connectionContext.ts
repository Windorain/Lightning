/**
 * SDE 连接上下文：管理 API 连接状态、导出列表、服务器通信。
 * 显式依赖 SceneContext（构造时注入），用于加载服务器数据后写入场景。
 */

import type { InjectionKey, Ref } from 'vue'
import { inject, provide, ref } from 'vue'

import {
  sdeGetExportFile,
  sdeGetWorkspaceDocument,
  sdeListExports,
  sdePing,
  sdePutWorkspaceDocument,
  type ExportFileInfo,
} from '@/workbench/sdeApi'
import { cloneDocument, normalizeApiBase } from '@/workbench/utils/sceneHelpers'
import type { SceneContext } from '@/workbench/sceneContext'

export interface ConnectionContext {
  // --- 连接状态 ---
  readonly apiBase: Ref<string>
  readonly token: Ref<string>
  readonly connected: Ref<boolean | null>

  // --- 导出列表 ---
  readonly exports: Ref<ExportFileInfo[]>
  readonly exportsLoading: Ref<boolean>
  readonly selectedExportName: Ref<string | null>

  // --- Setters ---
  setApiBase(raw: string): void
  setToken(raw: string): void

  // --- 副作用方法 ---
  /** @side-effect HTTP GET /ping */
  testConnection(): Promise<void>
  /** @side-effect HTTP GET /exports */
  refreshExportList(): Promise<void>
  /** @side-effect HTTP GET /exports/:name → 返回导出数据 */
  fetchExportData(name: string): Promise<unknown>
  /** @side-effect HTTP GET workspace → 返回工作区数据 */
  fetchWorkspaceData(): Promise<unknown>
  /** @side-effect HTTP PUT workspace */
  pushToServer(): Promise<void>
  /** @side-effect 清除连接/导出状态 */
  resetConnection(): void
}

export const connectionContextKey: InjectionKey<ConnectionContext> = Symbol('connectionContext')

export function createConnectionContext(_scene: SceneContext): ConnectionContext {
  const apiBase = ref('')
  const token = ref('')
  const connected = ref<boolean | null>(null)
  const exports = ref<ExportFileInfo[]>([])
  const exportsLoading = ref(false)
  const selectedExportName = ref<string | null>(null)

  function setApiBase(raw: string): void {
    apiBase.value = normalizeApiBase(raw)
  }

  function setToken(raw: string): void {
    token.value = raw.trim()
  }

  async function testConnection(): Promise<void> {
    connected.value = null
    if (!apiBase.value) {
      connected.value = false
      return
    }
    try {
      await sdePing(apiBase.value, token.value)
      connected.value = true
    } catch (_e) {
      connected.value = false
    }
  }

  async function refreshExportList(): Promise<void> {
    if (!apiBase.value) return
    exportsLoading.value = true
    try {
      exports.value = await sdeListExports(apiBase.value, token.value)
    } catch (_e) {
      exports.value = []
    } finally {
      exportsLoading.value = false
    }
  }

  async function fetchExportData(name: string): Promise<unknown> {
    if (!apiBase.value) throw new Error('未设置 API 基址')
    selectedExportName.value = name
    return await sdeGetExportFile(apiBase.value, token.value, name)
  }

  async function fetchWorkspaceData(): Promise<unknown> {
    if (!apiBase.value) return null
    const data = await sdeGetWorkspaceDocument(apiBase.value, token.value)
    const c = cloneDocument(data)
    if (c && Object.keys(c).length > 0) {
      return c
    }
    return null
  }

  async function pushToServer(): Promise<void> {
    if (!apiBase.value || !_scene.scene.value) return
    await sdePutWorkspaceDocument(apiBase.value, token.value, _scene.scene.value?.toRaw() as Record<string, unknown>)
    _scene.markClean()
    await _scene.syncPreview()
  }

  function resetConnection(): void {
    connected.value = null
    exports.value = []
    exportsLoading.value = false
    selectedExportName.value = null
  }

  return {
    apiBase: apiBase as unknown as Ref<string>,
    token: token as unknown as Ref<string>,
    connected: connected as unknown as Ref<boolean | null>,
    exports: exports as unknown as Ref<ExportFileInfo[]>,
    exportsLoading: exportsLoading as unknown as Ref<boolean>,
    selectedExportName: selectedExportName as unknown as Ref<string | null>,
    setApiBase,
    setToken,
    testConnection,
    refreshExportList,
    fetchExportData,
    fetchWorkspaceData,
    pushToServer,
    resetConnection,
  }
}

export function provideConnectionContext(scene: SceneContext): ConnectionContext {
  const ctx = createConnectionContext(scene)
  provide(connectionContextKey, ctx)
  return ctx
}

export function useConnectionContext(): ConnectionContext {
  const ctx = inject(connectionContextKey)
  if (!ctx) throw new Error('useConnectionContext() 须在 WorkbenchRoot 子树内调用')
  return ctx
}
