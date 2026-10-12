import type { Context } from '@/runtime/context'
import type { WorkbenchWorkspaceMode } from '@/runtime/types'
import type { DocumentBindingRef, DocumentLoadResult, DocumentSourceId } from './types'
import { applyDocumentBinding } from './binding'
import { pushRecentStructure } from '@/wiki/wikiRecentStructures'
import { hydrateMainEmbedInitialViewFromDoc } from '@/context/embedInitialView'
// #289 P10d（D1）：**装配进内核**是本函数的一部分，不再是文件选择器路径的专属步骤。
// 见 `composition/documentLoad` 的文件头：本路径（wiki-data / SDE / 本地抽屉）
// 此前**从不**装配内核 ⇒ 内核文档只在文件选择器路径被填充，
// 而 wiki-data 恰是最高价值路径。任何"改读内核"的迁移都会在这里静默读到空文档。
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { plainRootOf } from '@/adapters/plainRoot'

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
    // #301 A′：经唯一写入口（存在性镜像），随后 `adoptLoadedDocument` 装配内容。
    ctx.setDocument(result.document)
    ctx.viewports.resetAllViewportCameras(ctx.main.cameras)
    hydrateMainEmbedInitialViewFromDoc(ctx.main)
    ctx.requireKernelSession().seekFrame(0)
    // ── #289 P10d（D1）：装配进内核 ──
    //
    // 与文件选择器路径（`operators/builtin/docLifecycleOperators`）**同一份判据**：
    // 同一个 `plainRootOf`（信封解包 + meta 合并）与同一个 `adoptLoadedDocument`。
    //
    // `plainRoot` 用 `loadResult.raw`（解析器看到的源）而不是
    // `result.document.serialize()` —— 后者是**有损**的（见 `composition/documentLoad`
    // 对 `plainRootOf` 的说明：根级 `label`/`author` 等七个键从 `RuntimeDocument`
    // 出发无法恢复）。
    //
    // 装配失败**不**阻断加载（如实降级 + 日志），与文件选择器路径同一取舍。
    adoptLoadedDocument(ctx, result.document, plainRootOf(loadResult.raw), loadResult.locator)
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
    ctx.setDocument(null)
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
  // #301 P10f D3（R8 的第二种用途）：保存基线是**外部格式边界**的值
  //（`DocumentBinding.saveBaseline: RuntimeDocument | null`）⇒ 走冻结副本取值口。
  const doc = ctx.frozenDocumentValue()
  const b = bindingRef.value
  bindingRef.value = {
    ...b,
    saveBaseline: doc,
    remoteRevisionId: revisionId ?? b.remoteRevisionId,
  }
  ctx.getEditHistory().clear()
}
