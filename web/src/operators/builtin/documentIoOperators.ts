import type { OperatorType } from '@/operators/operatorType'
import { getDocumentSourceRegistry } from '@/workbench/document/registry'
import {
  beginDocumentSave,
  clearEditingState,
  completeDocumentSave,
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
    // #301 P10f D3（R3）：产物 plain 的唯一入口。
    const draft = buildWikiEditSummaryDraft(b.saveBaseline, ctx.plainForSave().plain)
    return hasWikiAuditableChanges(draft) || (ctx.kernelDirty() ?? false)
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
    // ── M8-2：保存**发起时**捕获 S0（B1 在途 + B2 产物投影），完成时只交结局 ──
    const ticket = beginDocumentSave(ctx)
    if (ticket === null) {
      // 串行化：已有在途保存（或内核不可保存）⇒ 如实拒绝，不并发、不排队
      ctx.log.warn('Wiki 保存', '已有保存在途或当前无保存权威，本次未提交')
      return
    }
    try {
      const result = await source.save(ctx, { summary })
      completeDocumentSave(ctx, ticket, { kind: 'committed', revisionId: result.revisionId })
      ctx.log.info('Wiki 保存', binding.locator, { revisionId: result.revisionId })
    } catch (err) {
      // 失败**不推进**基线（SPEC §9:293；domain/document#completeSave 只认 committed）
      completeDocumentSave(ctx, ticket, {
        kind: 'failed',
        code: (err as { code?: string }).code ?? 'wiki-save-failed',
      })
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
