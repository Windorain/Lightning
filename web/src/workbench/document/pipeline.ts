import type { Context } from '@/runtime/context'
import type { WorkbenchWorkspaceMode } from '@/runtime/types'
import type { DocumentBindingRef, DocumentLoadResult, DocumentSourceId } from './types'
import { applyDocumentBinding } from './binding'
import { pushRecentStructure } from '@/wiki/wikiRecentStructures'
import { hydrateMainEmbedInitialViewFromDoc } from '@/context/embedInitialView'

function workspaceModeForSource(sourceId: DocumentSourceId): WorkbenchWorkspaceMode {
  switch (sourceId) {
    case 'wiki-data':
      return 'wiki-data'
    case 'sde-export':
      return 'sde'
    case 'builtin':
      return 'local-bundle'
    case 'local-file':
    default:
      return 'local-file'
  }
}

export async function confirmDiscardDirtyIfNeeded(ctx: Context): Promise<boolean> {
  if (!ctx.getEditHistory().canUndo.value) return true
  const confirmFn = ctx.getToolSettings().confirmDirty ?? window.confirm
  if (!confirmFn('当前场景有未保存的修改，是否继续？')) return false
  return true
}

export function clearEditingState(ctx: Context): void {
  ctx.getSelection().clear()
  ctx.getEditHistory().clear()
}

export async function documentLoadPipeline(
  ctx: Context,
  bindingRef: DocumentBindingRef,
  sourceId: DocumentSourceId,
  loadResult: DocumentLoadResult,
): Promise<void> {
  const result = await ctx.main.registries.parsers.detectAndParse(loadResult.raw)
  if (result.document) {
    ctx.main.replaceDoc(result.document)
    ctx.viewports.resetAllViewportCameras(ctx.main.cameras)
    hydrateMainEmbedInitialViewFromDoc(ctx.main)
    ctx.getCurrentFrameIndex().value = 0
    const totalBlocks = result.document.frames.reduce(
      (sum, f) => sum + (f.grid?.count() ?? 0),
      0,
    )
    ctx.log.info('场景加载', loadResult.locator, {
      locator: loadResult.locator,
      frames: result.document.frameCount,
      blocks: totalBlocks,
    })
    applyDocumentBinding(bindingRef, {
      sourceId,
      locator: loadResult.locator,
      remoteRevisionId: loadResult.revisionId ?? null,
      saveBaseline: result.document.clone(),
    })
    if (sourceId === 'wiki-data') {
      pushRecentStructure(loadResult.displayName ?? loadResult.locator)
      ctx.getLocalFileName().value = loadResult.displayName ?? loadResult.locator
    }
  } else {
    ctx.main.replaceDoc(null)
    ctx.main.embedInitialView.value = null
    ctx.viewports.resetAllViewportCameras(ctx.main.cameras)
    ctx.log.error('场景加载', result.error ?? '未知错误', {
      locator: loadResult.locator,
      error: result.error,
    })
    applyDocumentBinding(bindingRef, {
      sourceId: 'empty',
      locator: '',
      remoteRevisionId: null,
      saveBaseline: null,
    })
  }
  const mode = workspaceModeForSource(sourceId)
  if (ctx.getWorkspaceMode().value !== mode) {
    ctx.getWorkspaceMode().value = mode
  }
}

/** 保存成功后对齐 baseline 并清空 undo 栈 */
export function afterDocumentSave(
  ctx: Context,
  bindingRef: DocumentBindingRef,
  revisionId: number | null | undefined,
): void {
  const doc = ctx.getDoc().value
  const b = bindingRef.value
  bindingRef.value = {
    ...b,
    saveBaseline: doc?.clone() ?? null,
    remoteRevisionId: revisionId ?? b.remoteRevisionId,
  }
  ctx.getEditHistory().clear()
}
