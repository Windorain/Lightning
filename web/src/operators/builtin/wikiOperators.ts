import type { OperatorType } from '@/operators/operatorType'
import { OP_RESULT } from '@/operators/operatorType'
import { buildEnvelopePackage } from '@/pure/envelope'
import { isWikiApiAvailable, previewUploadPlan } from '@/wiki/mwApiAdapter'
import { CAPABILITY } from '@/composition/modules'
import { POLL_REASON } from '@/operators/availability'
import {
  buildWikiEditSummaryDraft,
  WIKI_DEFAULT_EDIT_SUMMARY,
  WIKI_GENERIC_CONTENT_EDIT_SUMMARY,
} from '@/wiki/wikiEditSummary'
import { hasWikiRemoteChanges, wikiRemoteDirtyOf } from '@/wiki/wikiRemoteDirty'
import { buildWikiEmbedWikitext } from '@/wiki/wikiEmbedTemplate'
import { wikiDataPageSource, wikiLocatorForBase } from '@/workbench/document/sources/wikiDataPageSource'
import { normalizeBase } from '@/util/wikiStructureData'
import { displayNameFromLocator as locDisplay } from '@/wiki/wikiUrls'
import { beginDocumentSave, completeDocumentSave } from '@/workbench/document/pipeline'
import { applyDocumentBinding } from '@/workbench/document/binding'
import { pushRecentStructure } from '@/wiki/wikiRecentStructures'
export const WikiPickAndLoadOperator: OperatorType = {
  id: 'OPERATOR_WIKI_PICK_AND_LOAD',
  label: '从 Wiki 加载',
  description: '搜索并载入 Data:Structures 结构',

    // 旧实现是 `isWikiHostProfile() && ...`（模块级宿主反查）。
  // 现在问的是**能力**：只有装配了 `wiki.upload` 的外壳才具备 Wiki 上传面。
    // 能力由 `requires` **声明**（不再在 poll 里再判一次）—— 于是"缺能力"的结论只有
  // 一条来源（`operators/availability`），菜单/快捷键/脚本拿到同一句原因。
  requires: [CAPABILITY.WIKI_UPLOAD],
  poll() {
    return isWikiApiAvailable()
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
  requires: [CAPABILITY.WIKI_UPLOAD],
  poll(ctx) {
    if (ctx.getDocumentBinding().value.sourceId !== 'wiki-data') return false
    // 没有文档就没有"当前产物"可写；缺失 current **不是**"远端干净"，
    // 但保存门此时也不该放行（null 语义见 hasWikiRemoteChanges）。
    if (!ctx.hasLoadedDocument()) return false
    // **Wiki 远端是否陈旧**的唯一判据：完整产物 vs 远端基线（全量 canonical 比较）。
    // 摘要草稿只回答"写什么摘要"，不回答"远端是否落后"（cellGrid 等字段不在其中）。
    // ⚠️ 本条有**真实开销**（整份 plain 的规范化）；调用者只有执行前（最终防线）与
    // **菜单打开/items 变化**时各求一次（`workbench/ux/UIMenu.vue` 的缓存），
    // 渲染循环里不得再求值。
    return wikiRemoteDirtyOf(ctx)
  },
  /**
   * **两类不可用的下一步不同**，所以这条原因必须说出来（菜单灰显的 title/aria
   * 与 Ctrl+S 的底栏拒绝共用同一句 —— 见 `operators/availability`）。
   *
   * ⚠️ 本方法**不重算**`plainForSave()` 的差集：它只在 poll 已经为 false 时被调用，
   * 此时"是哪种不可用"由绑定与文档形态唯一决定（能走到这里 ⇒ 有 wiki 绑定 ⇒
   * 剩下的原因只有一个）。
   */
  pollReason(ctx) {
    if (ctx.getDocumentBinding().value.sourceId !== 'wiki-data') return POLL_REASON.NOT_WIKI_DATA_DOCUMENT
    return POLL_REASON.NO_AUDITABLE_CHANGES
  },

  invoke(ctx) {
    const binding = ctx.getDocumentBinding().value
    // 一次取产物：全量差集与摘要 / envelope 共用同一份快照（不重复求 `plainForSave`）。
    const plain = ctx.plainForSave().plain
    if (!hasWikiRemoteChanges(binding.saveBaseline, plain)) {
      ctx.log.warn('Wiki 保存', '没有可保存的变更')
      return OP_RESULT.CANCELLED
    }
    // 摘要只覆盖可摘要字段：cellGrid-only 等差异时 draft 为 null，但保存必须照常
    // 打开确认并给出**通用**摘要（不能 poll 放行、invoke 又拒绝）。
    const draft = buildWikiEditSummaryDraft(binding.saveBaseline, plain)
      // 存在性走内核读面；产物 plain 只有一条路（`plainForSave`）——
    // 旧行的 `?? doc.serialize()` 兜底**本来就被该读面内含**（它就是那条回落），
    // 故删掉重复的第二份回落（不是能力回退）。
    if (!ctx.hasLoadedDocument()) return OP_RESULT.CANCELLED
    const base = locDisplay(binding.locator)
      // 产物改由**内核投影**给出。
    const envelope = buildEnvelopePackage((plain ?? {}) as never)
    const plan = previewUploadPlan(base, envelope)
    const ui = ctx.wm.chrome.wikiUi
    if (ui) {
      ui.saveConfirm.value = {
        defaultSummary: draft?.defaultSummary ?? WIKI_GENERIC_CONTENT_EDIT_SUMMARY,
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
  requires: [CAPABILITY.WIKI_UPLOAD],
  poll(ctx) {
    return ctx.hasLoadedDocument() && isWikiApiAvailable()
  },

  invoke(ctx) {
    const ui = ctx.wm.chrome.wikiUi
    if (ui) ui.modal.value = 'save-as'
    return OP_RESULT.FINISHED
  },

  async exec(ctx, props) {
    const name = normalizeBase(String(props.baseName ?? ''))
    if (!name) throw new Error('请填写结构名称')
      // ── **另存为也是保存** ⇒ 同一条结算（内核保存基线唯一权威，外部绑定投影只是投影）──
    const ticket = beginDocumentSave(ctx)
    if (ticket === null) {
      ctx.log.warn('Wiki 另存为', '已有保存在途或当前无保存权威，本次未提交')
      return
    }
    const summary = String(props.summary ?? WIKI_DEFAULT_EDIT_SUMMARY)
    let result: Awaited<ReturnType<typeof wikiDataPageSource.save>>
    try {
      result = await wikiDataPageSource.save(ctx, { saveAsBase: name, summary })
    } catch (err) {
      completeDocumentSave(ctx, ticket, {
        kind: 'failed',
        code: (err as { code?: string }).code ?? 'wiki-save-as-failed',
      }, 'wiki')
      throw err
    }
    completeDocumentSave(ctx, ticket, { kind: 'committed', revisionId: result.revisionId }, 'wiki')
    applyDocumentBinding(ctx.getDocumentBinding(), {
      sourceId: 'wiki-data',
      locator: wikiLocatorForBase(name),
      remoteRevisionId: result.revisionId ?? null,
    })
    ctx.getLocalFileName().value = name
    pushRecentStructure(name, ctx.instanceId)
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
