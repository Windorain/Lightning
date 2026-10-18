import type { OperatorType } from '@/operators/operatorType'
import { OP_RESULT } from '@/operators/operatorType'
import { buildEnvelopePackage } from '@/pure/envelope'
import { isWikiApiAvailable, previewUploadPlan } from '@/wiki/mwApiAdapter'
import { CAPABILITY } from '@/composition/modules'
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

  poll(ctx) {
    // B5 #7：旧实现是 `isWikiHostProfile() && ...`（模块级宿主反查）。
    // 现在问的是**能力**：只有装配了 `wiki.upload` 的外壳才具备 Wiki 上传面。
    return ctx.hasCapability(CAPABILITY.WIKI_UPLOAD) && isWikiApiAvailable()
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
    if (!ctx.hasCapability(CAPABILITY.WIKI_UPLOAD)) return false
    if (ctx.getDocumentBinding().value.sourceId !== 'wiki-data') return false
    // #301 P10f D3（R3）：差集比较要的是**产物 plain**（`plainForSave` 的唯一分流点）。
    const draft = buildWikiEditSummaryDraft(
      ctx.getDocumentBinding().value.saveBaseline,
      ctx.plainForSave().plain,
    )
    return hasWikiAuditableChanges(draft) || (ctx.kernelDirty() ?? false)
  },

  invoke(ctx) {
    const binding = ctx.getDocumentBinding().value
    const draft = buildWikiEditSummaryDraft(binding.saveBaseline, ctx.plainForSave().plain)
    if (!hasWikiAuditableChanges(draft) && !(ctx.kernelDirty() ?? false)) {
      ctx.log.warn('Wiki 保存', '没有可保存的变更')
      return OP_RESULT.CANCELLED
    }
    // #301 P10f D3：存在性走 GF-15；产物 plain 只有一条路（`plainForSave`）——
    // 旧行的 `?? doc.serialize()` 兜底**本来就被该读面内含**（它就是那条回落），
    // 故删掉重复的第二份回落（不是能力回退）。
    if (!ctx.hasLoadedDocument()) return OP_RESULT.CANCELLED
    const base = locDisplay(binding.locator)
    // #301 P10f D2：产物改由**内核投影**给出。
    const envelope = buildEnvelopePackage((ctx.plainForSave().plain ?? {}) as never)
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
    return ctx.hasCapability(CAPABILITY.WIKI_UPLOAD) && ctx.hasLoadedDocument() && isWikiApiAvailable()
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
      // #301 P10f D3（R8 的第二种用途）：保存基线是**外部格式边界**的值
      //（`DocumentBinding.saveBaseline: RuntimeDocument | null`）⇒ 走冻结副本取值口。
      saveBaseline: ctx.frozenDocumentValue(),
    })
    ctx.getLocalFileName().value = name
    pushRecentStructure(name, ctx.instanceId)
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
