/**
 * 场景上下文：场景数据的唯一真源，以及其预览派生、文件 I/O。
 * 自包含，不依赖其他 context。
 *
 * 数据流（单向）：
 * 1. 入口：文件 / SDE 数据 / 内置示例 → loadSceneDocument → scene (Plain)
 * 2. 编辑：编辑器直接读写 ctx.scene，调用 syncPreview
 * 3. 预览：syncPreview() 浅拷贝 scene 后构建 PreviewConfig
 * 4. 导出：保存直接序列化 Plain；Envelope 仅导出时 buildEnvelopePackage
 */

import type { InjectionKey, Ref, ShallowRef } from 'vue'
import { inject, provide, ref, shallowRef } from 'vue'

import type { PreviewConfig } from '@/preview/previewConfig'
import { DEFAULT_PREVIEW_SCENE_ID } from '@/preview/previewSession'
import { getDevSceneDocument } from '@/dev/devScenes'
import { formatSdeError } from '@/workbench/sdeApi'
import { isEnvelopeDocument, normalizeEnvelopeToPlain } from '@/render/data/compactSceneDocument'
import { documentLooksPreviewable, previewConfigFromDocument } from '@/preview/previewFromDocument'
import { formatDispatcher } from '@/workbench/context/documentHandler'
import { downloadJson } from '@/util/browser'
import { getShowSaveFilePicker } from '@/util/browser'
import { logCenter } from '@/workbench/logging/LogCenter'
import {
  cloneDocument,
  parseWorkbenchQuery,
  suggestedJsonBaseName,
  type WorkbenchScene,
} from '@/workbench/utils/sceneHelpers'

export type WorkbenchWorkspaceMode = 'sde' | 'local-file' | 'local-bundle'
export type { WorkbenchScene }

export interface SceneContext {
  // --- 场景状态 ---
  readonly scene: Ref<WorkbenchScene | null>
  readonly dirty: Ref<boolean>
  readonly sceneLoadEpoch: Ref<number>
  /** World 多帧：与预览视口一致的当前 `frames` 下标（单结构恒为 0） */
  readonly previewWorldFrameIndex: Ref<number>

  // --- 预览派生状态 ---
  readonly previewConfig: ShallowRef<PreviewConfig | null>
  readonly previewEpoch: Ref<number>
  readonly previewBusy: Ref<boolean>
  readonly previewError: Ref<string | null>

  // --- 文件元数据 ---
  readonly workspaceMode: Ref<WorkbenchWorkspaceMode>
  readonly localFileName: Ref<string | null>

  // --- Setters ---
  setPreviewWorldFrameIndex(index: number): void
  setWorkspaceMode(mode: WorkbenchWorkspaceMode): void
  markDirty(): void
  markClean(): void

  // --- 副作用方法 ---
  /** @side-effect 以 scene 为源重建 PreviewConfig，bump previewEpoch */
  syncPreview(): Promise<void>
  /** @side-effect 从外部数据加载场景（SDE 路径用），bump sceneLoadEpoch */
  loadFromData(doc: unknown, opts?: { mode?: WorkbenchWorkspaceMode; fileName?: string }): Promise<void>
  /** @side-effect 从 File 对象读取 JSON 并加载场景 */
  loadSceneFromFile(file: File, opts?: { saveHandle?: FileSystemFileHandle | null }): Promise<void>
  /** @side-effect 保存 scene 到本地文件/触发浏览器下载 */
  saveToFile(): Promise<void>
  /** @side-effect 加载内置示例场景 */
  loadBuiltinScene(sceneId?: string): Promise<void>
  /** @side-effect 重置所有会话状态 */
  resetSession(): void
  /** @side-effect 新建空场景 */
  newScene(): Promise<void>
}

export const sceneContextKey: InjectionKey<SceneContext> = Symbol('sceneContext')

type FileSystemFileHandleWritable = FileSystemFileHandle & {
  queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
}

async function ensureFileWritePermission(handle: FileSystemFileHandle): Promise<void> {
  const h = handle as FileSystemFileHandleWritable
  const opts = { mode: 'readwrite' as const }
  if ((await h.queryPermission(opts)) === 'granted') return
  if ((await h.requestPermission(opts)) === 'granted') return
  throw new Error('未授予文件写入权限')
}

export function provideSceneContext(): SceneContext {
  const initial = parseWorkbenchQuery()

  // 场景状态
  const scene = ref<WorkbenchScene | null>(null)
  const dirty = ref(false)
  const sceneLoadEpoch = ref(0)
  const previewWorldFrameIndex = ref(0)

  // 预览派生状态
  const previewConfig = shallowRef<PreviewConfig | null>(null)
  const previewEpoch = ref(0)
  const previewBusy = ref(false)
  const previewError = ref<string | null>(null)

  // 文件元数据
  const workspaceMode = ref<WorkbenchWorkspaceMode>(initial.apiBase ? 'sde' : 'local-file')
  const localFileName = ref<string | null>(null)
  const fileSaveHandle: ShallowRef<FileSystemFileHandle | null> = shallowRef(null)

  function resetSession(): void {
    scene.value = null
    dirty.value = false
    previewConfig.value = null
    previewEpoch.value = 0
    sceneLoadEpoch.value = 0
    previewWorldFrameIndex.value = 0
    previewError.value = null
    localFileName.value = null
    fileSaveHandle.value = null
  }

  const EMPTY_SCENE = {
    format_version: '2.0',
    meta: {
      name: '未命名',
      author: '',
      created_at_ms: Date.now(),
      description: '',
      tags: [] as string[],
      origin: { x: 0, y: 0, z: 0 },
    },
    frames: [{ label: 'Frame 0', index: 0, blocks: [], entities: [] }],
    block_palette: {} as Record<string, { name: string; properties: Record<string, string> }>,
    materials: { entries: [] },
  }

  async function newScene(): Promise<void> {
    await loadSceneDocument(EMPTY_SCENE, { mode: 'local-file', fileName: '未命名' })
    dirty.value = false
  }

  async function syncPreview(): Promise<void> {
    if (previewBusy.value) return
    previewBusy.value = true
    previewError.value = null
    try {
      const doc = scene.value
      if (!doc) {
        previewError.value = '无场景数据'
        previewConfig.value = null
        previewEpoch.value = 0
        return
      }
      if (!documentLooksPreviewable(doc)) {
        previewError.value =
          '当前文档缺少 textureBlobs 或非 geometryPhase=baked，无法内嵌预览（可继续编辑元数据并导出）。'
        return
      }
      const snapshot = { ...doc }
      const cfg = await previewConfigFromDocument(snapshot)
      previewConfig.value = cfg
      previewEpoch.value += 1
    } catch (e) {
      previewError.value = formatSdeError(e)
    } finally {
      previewBusy.value = false
    }
  }

  async function loadSceneDocument(
    doc: unknown,
    opts?: { mode?: WorkbenchWorkspaceMode; fileName?: string },
  ): Promise<void> {
    let raw: unknown = doc
    if (raw && isEnvelopeDocument(raw)) {
      raw = await normalizeEnvelopeToPlain(raw)
    } else if (raw && typeof raw === 'object') {
      raw = cloneDocument(raw)
    }

    // 格式分发：全部转为 V2Plain
    const result = raw ? formatDispatcher.normalize(raw) : { document: null, handler: null, error: '空文档' }
    scene.value = result.document as WorkbenchScene | null

    if (result.document) {
      previewWorldFrameIndex.value = 0
      sceneLoadEpoch.value += 1
      const frames = result.document.frames
      const totalBlocks = frames.reduce((sum: number, f) => sum + (f.blocks?.length ?? 0), 0)
      const fileName = opts?.fileName ?? localFileName.value ?? 'unknown'

      if (result.handler?.formatName !== 'V2Plain') {
        logCenter.info('场景加载', `从 ${result.handler?.formatName} 转换为 V2Plain 格式`, {
          fileName,
          sourceFormat: result.handler?.formatName,
          targetFormat: 'V2Plain',
          frames: frames.length,
          blocks: totalBlocks,
        })
      } else {
        logCenter.info('场景加载', `${fileName}`, {
          fileName,
          frames: frames.length,
          blocks: totalBlocks,
        })
      }
    } else {
      logCenter.error('场景加载', result.error ?? '未知错误', {
        fileName: opts?.fileName ?? 'unknown',
        error: result.error,
      })
    }

    if (opts?.mode) {
      workspaceMode.value = opts.mode
    }
    if (opts?.fileName !== undefined) {
      localFileName.value = opts.fileName
    }
    dirty.value = false
    await syncPreview()
  }

  async function loadSceneFromFile(
    file: File,
    opts?: { saveHandle?: FileSystemFileHandle | null },
  ): Promise<void> {
    const text = await file.text()
    let data: unknown
    try {
      data = JSON.parse(text) as unknown
    } catch (e) {
      throw new Error(`JSON 解析失败：${formatSdeError(e)}`)
    }
    const parsed = cloneDocument(data)
    if (!parsed) {
      throw new Error('JSON 根须为对象')
    }
    fileSaveHandle.value = opts?.saveHandle ?? null
    await loadSceneDocument(parsed, { mode: 'local-file', fileName: file.name })
  }

  async function saveToFile(): Promise<void> {
    const doc = scene.value
    if (!doc) return
    const text = `${JSON.stringify(doc, null, 2)}\n`
    const baseName = suggestedJsonBaseName(localFileName.value, 'structure-export')
    const suggestedName = `${baseName}.json`

    let handle = fileSaveHandle.value
    const showSavePicker = getShowSaveFilePicker()

    if (!handle && showSavePicker) {
      try {
        const newHandle = await showSavePicker({
          suggestedName,
          types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
        })
        fileSaveHandle.value = newHandle
        localFileName.value = newHandle.name
        handle = newHandle
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return
        console.warn('[SceneContext] showSaveFilePicker 失败，将尝试下载 JSON', e)
        handle = null
      }
    }

    if (handle) {
      try {
        await ensureFileWritePermission(handle)
        const writable = await handle.createWritable()
        await writable.write(text)
        await writable.close()
        dirty.value = false
        return
      } catch (e) {
        console.warn('[SceneContext] 写入本地文件失败，将尝试下载 JSON', e)
        fileSaveHandle.value = null
      }
    }

    downloadJson(baseName, doc, true)
    dirty.value = false
  }

  async function loadBuiltinScene(sceneId?: string): Promise<void> {
    const id = sceneId && sceneId.length > 0 ? sceneId : DEFAULT_PREVIEW_SCENE_ID
    const raw = getDevSceneDocument(id)
    const next = cloneDocument(raw)
    await loadSceneDocument(next, { mode: 'local-bundle', fileName: `示例 · ${id}.json` })
  }

  function setPreviewWorldFrameIndex(index: number): void {
    const i = Math.floor(index)
    previewWorldFrameIndex.value = Number.isFinite(i) && i >= 0 ? i : 0
  }

  function setWorkspaceMode(mode: WorkbenchWorkspaceMode): void {
    if (workspaceMode.value === mode) return
    resetSession()
    workspaceMode.value = mode
  }

  function markDirty(): void {
    dirty.value = true
  }

  function markClean(): void {
    dirty.value = false
  }

  const ctx: SceneContext = {
    scene: scene as unknown as Ref<WorkbenchScene | null>,
    dirty: dirty as unknown as Ref<boolean>,
    sceneLoadEpoch: sceneLoadEpoch as unknown as Ref<number>,
    previewWorldFrameIndex: previewWorldFrameIndex as unknown as Ref<number>,
    previewConfig: previewConfig as unknown as ShallowRef<PreviewConfig | null>,
    previewEpoch: previewEpoch as unknown as Ref<number>,
    previewBusy: previewBusy as unknown as Ref<boolean>,
    previewError: previewError as unknown as Ref<string | null>,
    workspaceMode: workspaceMode as unknown as Ref<WorkbenchWorkspaceMode>,
    localFileName: localFileName as unknown as Ref<string | null>,
    setPreviewWorldFrameIndex,
    setWorkspaceMode,
    markDirty,
    markClean,
    syncPreview,
    loadFromData: loadSceneDocument,
    loadSceneFromFile,
    saveToFile,
    loadBuiltinScene,
    resetSession,
    newScene,
  }

  provide(sceneContextKey, ctx)
  return ctx
}

export function useSceneContext(): SceneContext {
  const ctx = inject(sceneContextKey)
  if (!ctx) throw new Error('useSceneContext() 须在 WorkbenchRoot 子树内调用')
  return ctx
}
