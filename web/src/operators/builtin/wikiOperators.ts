import type { OperatorType } from '@/operators/operatorType'
import { OP_RESULT } from '@/operators/operatorType'
import { buildEnvelopePackage } from '@/pure/envelope'
import { isWikiApiAvailable, previewUploadPlan } from '@/wiki/mwApiAdapter'
import { isWikiHostProfile } from '@/runtime/hostProfile'
import {
  buildWikiEditSummaryDraft,
  hasWikiAuditableChanges,
  WIKI_DEFAULT_EDIT_SUMMARY,
} from '@/wiki/wikiEditSummary'
import { buildWikiEmbedWikitext } from '@/wiki/wikiEmbedTemplate'
import { wikiDataPageSource, wikiLocatorForBase } from '@/workbench/document/sources/wikiDataPageSource'
import { normalizeBase } from '@/util/wikiStructureData'
import { displayNameFromLocator as locDisplay } from '@/wiki/wikiUrls'
import { afterDocumentSave } from '@/workbench/document/pipeline'
import { applyDocumentBinding } from '@/workbench/document/binding'
import { pushRecentStructure } from '@/wiki/wikiRecentStructures'
export const WikiPickAndLoadOperator: OperatorType = {
  id: 'OPERATOR_WIKI_PICK_AND_LOAD',
  label: '从 Wiki 加载',
  description: '搜索并载入 Data:Structures 结构',

  poll() {
    return isWikiHostProfile() && isWikiApiAvailable()
  },

  invoke(ctx) {
    const ui = ctx.wm.chrome.wikiUi
    if (ui) ui.modal.value = 'picker'
    return OP_RESULT.FINISHED
  },
}

export const WikiSaveConfirmOperator: OperatorType = {
  id: 'OPERATOR_WIKI_SAVE_CONFIRM',
  label: '保存到 Wiki（确认）',
  poll(ctx) {
    if (!isWikiHostProfile()) return false
    if (ctx.getDocumentBinding().value.sourceId !== 'wiki-data') return false
    const draft = buildWikiEditSummaryDraft(
      ctx.getDocumentBinding().value.saveBaseline,
      ctx.getDoc().value,
    )
    return hasWikiAuditableChanges(draft) || ctx.getEditHistory().canUndo.value
  },

  invoke(ctx) {
    const binding = ctx.getDocumentBinding().value
    const draft = buildWikiEditSummaryDraft(binding.saveBaseline, ctx.getDoc().value)
    if (!hasWikiAuditableChanges(draft) && !ctx.getEditHistory().canUndo.value) {
      ctx.log.warn('Wiki 保存', '没有可保存的变更')
      return OP_RESULT.CANCELLED
    }
    const doc = ctx.getDoc().value
    if (!doc) return OP_RESULT.CANCELLED
    const base = locDisplay(binding.locator)
    const envelope = buildEnvelopePackage(doc.serialize())
    const plan = previewUploadPlan(base, envelope)
    const ui = ctx.wm.chrome.wikiUi
    if (ui) {
      ui.saveConfirm.value = {
        defaultSummary: draft?.defaultSummary ?? WIKI_DEFAULT_EDIT_SUMMARY,
        planPartCount: plan.partCount,
        planMode: plan.mode,
      }
      ui.modal.value = 'save-confirm'
    }
    return OP_RESULT.FINISHED
  },
}

export const WikiSaveAsOperator: OperatorType = {
  id: 'OPERATOR_WIKI_SAVE_AS',
  label: '另存为 Wiki 结构',
  poll(ctx) {
    return isWikiHostProfile() && ctx.getDoc().value != null && isWikiApiAvailable()
  },

  invoke(ctx) {
    const ui = ctx.wm.chrome.wikiUi
    if (ui) ui.modal.value = 'save-as'
    return OP_RESULT.FINISHED
  },

  async exec(ctx, props) {
    const name = normalizeBase(String(props.baseName ?? ''))
    if (!name) throw new Error('请填写结构名称')
    const summary = String(props.summary ?? WIKI_DEFAULT_EDIT_SUMMARY)
    const result = await wikiDataPageSource.save(ctx, { saveAsBase: name, summary })
    applyDocumentBinding(ctx.getDocumentBinding(), {
      sourceId: 'wiki-data',
      locator: wikiLocatorForBase(name),
      remoteRevisionId: result.revisionId ?? null,
      saveBaseline: ctx.getDoc().value?.clone() ?? null,
    })
    ctx.getLocalFileName().value = name
    pushRecentStructure(name)
    afterDocumentSave(ctx, ctx.getDocumentBinding(), result.revisionId)
    ctx.log.info('Wiki 另存为', name)
  },
}

export const CopyWikiEmbedOperator: OperatorType = {
  id: 'OPERATOR_COPY_WIKI_EMBED',
  label: '复制渲染器模板',
  poll(ctx) {
    return ctx.getDocumentBinding().value.sourceId === 'wiki-data'
  },

  async exec(ctx) {
    const text = buildWikiEmbedWikitext(ctx)
    try {
      await navigator.clipboard.writeText(text)
      ctx.log.info('已复制', '{{渲染器}} 模板')
    } catch {
      ctx.log.error('复制失败', '无法写入剪贴板')
    }
  },
}
