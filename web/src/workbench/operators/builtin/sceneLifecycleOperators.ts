import type { OperatorType } from '@/workbench/operators/operatorType'
import { RuntimeDocument } from '@/workbench/context/runtimeDocument'
import { parserRegistry } from '@/workbench/context/parserRegistry'
import { getDevSceneDocument } from '@/dev/devScenes'
import { downloadJson } from '@/util/browser'
import { suggestedJsonBaseName } from '@/workbench/utils/sceneHelpers'
import { logCenter } from '@/workbench/logging/LogCenter'
import { DEFAULT_PREVIEW_SCENE_ID } from '@/preview/previewSession'
import { buildMaterialLibrary } from './materialLibraryHelper'

function pickFile(): Promise<File | undefined> {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = () => {
      cleanup()
      resolve(input.files?.[0])
    }
    const onFocus = () => {
      setTimeout(() => {
        if (!input.files?.length) {
          cleanup()
          resolve(undefined)
        }
      }, 300)
    }
    const cleanup = () => window.removeEventListener('focus', onFocus)
    window.addEventListener('focus', onFocus)
    input.click()
  })
}

export const NewSceneOperator: OperatorType = {
  id: 'OPERATOR_NEW_SCENE',
  label: '新建场景',
  description: '创建空白新场景',

  poll(_bctx) {
    return true
  },

  async exec(bctx, _props) {
    if (bctx.dirty.value) {
      const confirmFn = bctx.settings.confirmDirty ?? window.confirm
      if (!confirmFn('当前场景有未保存的修改，是否保存？')) return
      await bctx.operators.exec('OPERATOR_SAVE_FILE')
    }
    bctx.selection.clear()
    bctx.editHistory.clear()
    const doc = RuntimeDocument.empty()
    bctx.doc.value = doc
    void buildMaterialLibrary(doc).then(lib => { if (lib) bctx.materialLibrary.value = lib })
    bctx.dirty.value = false
    bctx.structEpoch.value += 1
  },
}

export const OpenSceneOperator: OperatorType = {
  id: 'OPERATOR_OPEN_SCENE',
  label: '打开场景',
  description: '从文件加载场景',

  poll(_bctx) {
    return true
  },

  async exec(bctx, _props) {
    let file = _props.file as File | undefined
    if (!file) {
      file = await pickFile()
      if (!file) return
    }
    if (bctx.dirty.value) {
      const confirmFn = bctx.settings.confirmDirty ?? window.confirm
      if (!confirmFn('当前场景有未保存的修改，是否保存？')) return
      await bctx.operators.exec('OPERATOR_SAVE_FILE')
    }
    bctx.selection.clear()
    bctx.editHistory.clear()
    const text = await file.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch (e) {
      throw new Error(`JSON 解析失败：${e}`)
    }
    const result = await parserRegistry.detectAndParse(data)
    bctx.doc.value = result.document ?? null
    if (result.document) {
      bctx.currentWorldFrameIndex.value = 0
      bctx.structEpoch.value += 1
      void buildMaterialLibrary(result.document).then(lib => { if (lib) bctx.materialLibrary.value = lib })
      const totalBlocks = result.document.frames.reduce((sum, f) => sum + (f.grid?.count() ?? 0), 0)
      logCenter.info('场景加载', file.name, { fileName: file.name, frames: result.document.frameCount, blocks: totalBlocks })
    } else {
      logCenter.error('场景加载', result.error ?? '未知错误', { fileName: file.name, error: result.error })
    }
    bctx.localFileName.value = file.name
    bctx.workspaceMode.value = 'local-file'
    bctx.dirty.value = false
  },
}

export const SaveFileOperator: OperatorType = {
  id: 'OPERATOR_SAVE_FILE',
  label: '保存到文件',
  description: '将当前场景保存到本地文件',

  poll(bctx) {
    return bctx.doc.value !== null
  },

  exec(bctx, _props) {
    const doc = bctx.doc.value?.toRaw()
    if (!doc) return
    const baseName = suggestedJsonBaseName(bctx.localFileName.value, 'structure-export')
    downloadJson(baseName, doc, true)
    bctx.dirty.value = false
  },
}

export const LoadBuiltinSceneOperator: OperatorType = {
  id: 'OPERATOR_LOAD_BUILTIN',
  label: '加载内置示例',
  description: '加载内置示例场景',

  poll(_bctx) {
    return true
  },

  async exec(bctx, _props) {
    const sceneId = _props.sceneId as string | undefined
    const id = sceneId && sceneId.length > 0 ? sceneId : DEFAULT_PREVIEW_SCENE_ID
    const raw = getDevSceneDocument(id)
    bctx.selection.clear()
    bctx.editHistory.clear()
    const result = await parserRegistry.detectAndParse(raw)
    bctx.doc.value = result.document ?? null
    if (result.document) {
      bctx.currentWorldFrameIndex.value = 0
      bctx.structEpoch.value += 1
      void buildMaterialLibrary(result.document).then(lib => { if (lib) bctx.materialLibrary.value = lib })
      const totalBlocks = result.document.frames.reduce((sum, f) => sum + (f.grid?.count() ?? 0), 0)
      logCenter.info('场景加载', `示例 · ${id}.json`, { fileName: `示例 · ${id}.json`, frames: result.document.frameCount, blocks: totalBlocks })
    } else {
      logCenter.error('场景加载', result.error ?? '未知错误', { fileName: `示例 · ${id}.json`, error: result.error })
    }
    bctx.workspaceMode.value = 'local-bundle'
    bctx.localFileName.value = `示例 · ${id}.json`
    bctx.dirty.value = false
  },
}
