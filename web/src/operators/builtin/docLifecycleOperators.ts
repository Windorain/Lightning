import type { OperatorType } from '@/operators/operatorType'
import { RuntimeDocument } from '@/context/runtimeDocument'
import { getDevSceneDocument } from '@/dev/devScenes'
import { downloadJson } from '@/util/browser'
import { suggestedJsonBaseName } from '@/workbench/utils/fileNaming'
import { DEFAULT_PREVIEW_SCENE_ID } from '@/preview/previewSession'
import { replaceDoc } from '@/context/replaceDoc'

/**
 * Open a native file picker for .json files.
 *
 * NOTE: The window focus + setTimeout(300) hack below is needed because
 * there is no standard callback for "user cancelled the file picker".
 * The 'focus' event fires when the user closes the picker without
 * selecting a file (tab returns to the window). A short delay lets
 * the browser populate input.files before we check it.
 */
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

  poll(_ctx) {
    return true
  },

  async exec(ctx, _props) {
    if (ctx.editHistory.canUndo.value) {
      const confirmFn = ctx.settings.confirmDirty ?? window.confirm
      if (!confirmFn('当前场景有未保存的修改，是否保存？')) return
      await ctx.operators.exec('OPERATOR_SAVE_FILE')
    }
    ctx.selection.clear()
    ctx.editHistory.clear()
    const doc = RuntimeDocument.empty()
    replaceDoc(ctx, doc)
  },
}

export const OpenSceneOperator: OperatorType = {
  id: 'OPERATOR_OPEN_SCENE',
  label: '打开场景',
  description: '从文件加载场景',

  poll(_ctx) {
    return true
  },

  async exec(ctx, _props) {
    let file = _props.file as File | undefined
    if (!file) {
      file = await pickFile()
      if (!file) return
    }
    if (ctx.editHistory.canUndo.value) {
      const confirmFn = ctx.settings.confirmDirty ?? window.confirm
      if (!confirmFn('当前场景有未保存的修改，是否保存？')) return
      await ctx.operators.exec('OPERATOR_SAVE_FILE')
    }
    ctx.selection.clear()
    ctx.editHistory.clear()
    const text = await file.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch (e) {
      throw new Error(`JSON 解析失败：${e}`)
    }
    const result = await ctx.main.registries.parsers.detectAndParse(data)
    if (result.document) {
      replaceDoc(ctx, result.document)
      ctx.currentFrameIndex.value = 0
      const totalBlocks = result.document.frames.reduce((sum, f) => sum + (f.grid?.count() ?? 0), 0)
      ctx.log.info('场景加载', file.name, { fileName: file.name, frames: result.document.frameCount, blocks: totalBlocks })
    } else {
      replaceDoc(ctx, null)
      ctx.log.error('场景加载', result.error ?? '未知错误', { fileName: file.name, error: result.error })
    }
    ctx.localFileName.value = file.name
    await ctx.operators.exec('OPERATOR_SET_WORKSPACE_MODE', { mode: 'local-file' })
  },
}

export const SaveFileOperator: OperatorType = {
  id: 'OPERATOR_SAVE_FILE',
  label: '保存到文件',
  description: '将当前场景保存到本地文件',

  poll(ctx) {
    return ctx.doc.value !== null
  },

  exec(ctx, _props) {
    const doc = ctx.doc.value?.serialize()
    if (!doc) return
    const baseName = suggestedJsonBaseName(ctx.localFileName.value, 'structure-export')
    downloadJson(baseName, doc, true)
  },
}

export const LoadBuiltinSceneOperator: OperatorType = {
  id: 'OPERATOR_LOAD_BUILTIN',
  label: '加载内置示例',
  description: '加载内置示例场景',

  poll(_ctx) {
    return true
  },

  async exec(ctx, _props) {
    const sceneId = _props.sceneId as string | undefined
    const id = sceneId && sceneId.length > 0 ? sceneId : DEFAULT_PREVIEW_SCENE_ID
    const raw = getDevSceneDocument(id)
    ctx.selection.clear()
    ctx.editHistory.clear()
    const result = await ctx.main.registries.parsers.detectAndParse(raw)
    if (result.document) {
      replaceDoc(ctx, result.document)
      ctx.currentFrameIndex.value = 0
      const totalBlocks = result.document.frames.reduce((sum, f) => sum + (f.grid?.count() ?? 0), 0)
      ctx.log.info('场景加载', `示例 · ${id}.json`, { fileName: `示例 · ${id}.json`, frames: result.document.frameCount, blocks: totalBlocks })
    } else {
      replaceDoc(ctx, null)
      ctx.log.error('场景加载', result.error ?? '未知错误', { fileName: `示例 · ${id}.json`, error: result.error })
    }
    await ctx.operators.exec('OPERATOR_SET_WORKSPACE_MODE', { mode: 'local-bundle' })
    ctx.localFileName.value = `示例 · ${id}.json`
  },
}

export const LoadEmbedDocumentOperator: OperatorType = {
  id: 'OPERATOR_LOAD_EMBED_DOCUMENT',
  label: '加载嵌入文档',
  poll: () => true,
  async exec(ctx, props) {
    const raw = props.document
    const result = await ctx.main.registries.parsers.detectAndParse(raw)
    if (!result.document) throw new Error(result.error ?? 'parse failed')
    replaceDoc(ctx, result.document)
  },
}
