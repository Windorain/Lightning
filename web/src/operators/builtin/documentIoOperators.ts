import type { OperatorType } from '@/operators/operatorType'
import { getDocumentSourceRegistry } from '@/workbench/document/registry'
import {
  afterDocumentSave,
  clearEditingState,
  confirmDiscardDirtyIfNeeded,
  documentLoadPipeline,
} from '@/workbench/document/pipeline'
import type { DocumentSourceId } from '@/workbench/document/types'
import { buildWikiEditSummaryDraft, hasWikiAuditableChanges } from '@/wiki/wikiEditSummary'
import { wikiDataPageSource } from '@/workbench/document/sources/wikiDataPageSource'
import { isEditConflictError } from '@/wiki/mwApiAdapter'

export const DocumentLoadOperator: OperatorType = {
  id: 'OPERATOR_DOCUMENT_LOAD',
  label: '加载文档',
  description: '从 Document Source 加载',

  poll() {
    return true
  },

  async exec(ctx, props) {
    const sourceId = props.sourceId as DocumentSourceId
    const registry = getDocumentSourceRegistry()
    const source = registry.get(sourceId)
    if (!source?.poll(ctx)) {
      throw new Error(`数据源不可用: ${sourceId}`)
    }
    if (!(await confirmDiscardDirtyIfNeeded(ctx))) return
    clearEditingState(ctx)
    const loadResult = await source.load(ctx, props)
    await documentLoadPipeline(
      ctx,
      ctx.getDocumentBinding(),
      sourceId,
      loadResult,
    )
  },
}

export const DocumentSaveOperator: OperatorType = {
  id: 'OPERATOR_DOCUMENT_SAVE',
  label: '保存文档',
  description: '保存到当前 Document 绑定',

  poll(ctx) {
    const b = ctx.getDocumentBinding().value
    if (b.sourceId !== 'wiki-data') return false
    const draft = buildWikiEditSummaryDraft(b.saveBaseline, ctx.getDoc().value)
    return hasWikiAuditableChanges(draft) || ctx.getEditHistory().canUndo.value
  },

  async exec(ctx, props) {
    const binding = ctx.getDocumentBinding().value
    if (binding.sourceId !== 'wiki-data') {
      throw new Error('当前未绑定 Wiki 结构数据')
    }
    const source = wikiDataPageSource
    if (props.dryRun) {
      const result = await source.save(ctx, { dryRun: true })
      const plan = result.plan!
      const msg =
        plan.mode === 'single'
          ? '将写入 1 页（单文件）'
          : `将写入 ${plan.pages.length} 页（索引 + ${plan.partCount} 分片）`
      const ui = ctx.wm.chrome.wikiUi
      if (ui) {
        ui.savePreviewMessage.value = msg
        ui.modal.value = 'save-preview'
      }
      return
    }
    const summary = String(props.summary ?? binding.pendingSaveSummary ?? '')
    try {
      const result = await source.save(ctx, { summary })
      afterDocumentSave(ctx, ctx.getDocumentBinding(), result.revisionId)
      ctx.log.info('Wiki 保存', binding.locator, { revisionId: result.revisionId })
    } catch (err) {
      if (isEditConflictError(err)) {
        const ui = ctx.wm.chrome.wikiUi
        const msg = err instanceof Error ? err.message : String(err)
        if (ui) ui.conflictMessage.value = msg
        const e = new Error(msg) as Error & { code: string }
        e.code = 'wiki-editconflict'
        throw e
      }
      throw err
    }
  },
}

export const WikiReloadOperator: OperatorType = {
  id: 'OPERATOR_WIKI_RELOAD',
  label: '重新载入 Wiki 数据',
  poll(ctx) {
    return ctx.getDocumentBinding().value.sourceId === 'wiki-data'
  },
  async exec(ctx) {
    const locator = ctx.getDocumentBinding().value.locator
    if (!locator) return
    await ctx.getOperators().exec('OPERATOR_DOCUMENT_LOAD', {
      sourceId: 'wiki-data',
      title: locator,
    })
  },
}

export const WikiPreviewSaveOperator: OperatorType = {
  id: 'OPERATOR_WIKI_PREVIEW_SAVE',
  label: '保存预检',
  poll(ctx) {
    return DocumentSaveOperator.poll!(ctx)
  },
  async exec(ctx) {
    await ctx.getOperators().exec('OPERATOR_DOCUMENT_SAVE', { dryRun: true })
  },
}
