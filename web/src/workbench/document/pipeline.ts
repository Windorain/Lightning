import type { Context, DocumentSaveOutcome, DocumentSaveTicket } from '@/runtime/context'
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
  if (!(ctx.kernelDirty() ?? false)) return true
  const confirmFn = ctx.getToolSettings().confirmDirty ?? window.confirm
  if (!confirmFn('当前场景有未保存的修改，是否继续？')) return false
  return true
}

export function clearEditingState(ctx: Context): void {
  ctx.getSelection().clear()
  // R1-beta-C2: 原 ctx.getEditHistory().clear() 删除（不是遗漏）—— 内核撤销历史随
  // Document 存续（契约 §6），紧随其后的 documentLoadPipeline 会经 setDocument 换成
  // 另一份文档 ⇒ 新历史天然为空，「清空」是结构上已发生的事。
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
      // M8-2：基线是**产物投影**（`plainForSave` —— 与真正写出去的那份同一来源），
      // 不是解析器的 RuntimeDocument。理由见 `DocumentBinding.saveBaseline` 的说明：
      // 旧值经 `.serialize()` 与投影产物比较，而投影会按"首次使用"重排 tooltip 池
      // ⇒ 刚装载就报「有未保存变更」（M8-2 实测：palette 同集合不同顺序）。
      saveBaseline: ctx.plainForSave().plain,
    })
    if (sourceId === 'wiki-data') {
      pushRecentStructure(loadResult.displayName ?? loadResult.locator, ctx.instanceId)
      ctx.getLocalFileName().value = loadResult.displayName ?? loadResult.locator
    }
  } else {
    // ── M8-5 / D3：装载失败**不换掉**当前有效文档 ──────────────────────────────
    //
    // 旧形态是三件事一起做：`setDocument(null)`、清 `embedInitialView`、把绑定置成
    // `empty/null`。后果是具体的：用户正在编辑的内容（含未保存修改）与选择被一次
    // **失败的打开**清空，且没有任何回退路径（S0-B D3）。这正是 SPEC §9:299
    // 「损坏副本和存储失败不得破坏当前有效内容」的同族语义（输入侧失败不得破坏
    // 当前有效内容），也是 §10.7:309「失败必须保留原有效状态或明确说明实际后果」。
    //
    // ⇒ 失败只在**输入侧**结算：当前文档、画面、选择、绑定原样保留；
    // 用户看到一句**点名原因**的提示（"当前场景保持不变"是实际后果的说明）。
    const reason = result.error ?? '未知错误'
    ctx.log.error(
      '场景加载',
      `打开失败：${reason}（当前场景保持不变）`,
      {
        locator: loadResult.locator,
        error: result.error,
        keptCurrentDocument: ctx.hasLoadedDocument(),
      },
    )
    // 工作区模式也**不**跟着换：它描述的是"当前这份内容来自哪"
    // （换模式会让一个还在编辑的本地场景显示成 wiki 模式）。
    return
  }
  const mode = workspaceModeForSource(sourceId)
  if (ctx.getWorkspaceMode().value !== mode) {
    ctx.getWorkspaceMode().value = mode
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 生产保存的结算（M8-2 / D1）：**唯一**推进正式保存基线的入口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一次生产保存的**凭据**（`DocumentSaveTicket`）与结局（`DocumentSaveOutcome`）
 * 的**类型定义在 `runtime/context`** —— 它们描述的是"内核在途请求 + 捕获的产物投影"
 * 这一对事实，`Context#beginKernelSave` 与这里共用同一份词汇。
 *
 * 两者都在**发起**时捕获，且都必须原样递回 {@link completeDocumentSave} ——
 * 「基线取请求捕获的 S0」因此在结构上不可能被"完成时读当前版本"偷偷改掉。
 */

/**
 * 发起一次生产保存结算：捕获 S0（B1 的内核请求 + B2 的产物投影）。
 *
 * @returns `null` = 无内核会话/未装配/**已有在途保存** ⇒ 调用方如实失败（不并发）。
 *          **不是**"保存已经成功了"。
 */
export function beginDocumentSave(ctx: Context): DocumentSaveTicket | null {
  // 顺序固定：先取产物投影（同步），再登记内核在途（同步）——
  // 两者之间没有 await，故不存在"捕获到半份 S0"的窗口。
  const baseline = ctx.plainForSave().plain
  const request = ctx.beginKernelSave()
  if (request === null) return null
  return Object.freeze({ request, baseline })
}

/**
 * 结算一次生产保存：**B1 是唯一权威**，B2 是它在外部绑定上的投影。
 *
 * 语义全部由内核判定（`application/commands#reduceSaveCompleted` →
 * `domain/document#completeSave`）：序号相符、绑定代数相符、只有 `committed` 才推进，
 * 且推进到**该请求捕获的 S0**。因此：
 *  - 保存期间的**新编辑仍脏**（SPEC §9:293；`commands.ts:2336`）；
 *  - 失败/过期**不动**基线；
 *  - B2 只在 B1 真的推进（`applied`）时才跟着换，**不存在两条各自推进的路径**
 *    （旧 `afterDocumentSave` 无条件写 B2，正是 D1 的第二条写权威 —— 已删除）。
 *
 * @returns 是否真的推进了正式保存基线
 */
export function completeDocumentSave(
  ctx: Context,
  ticket: DocumentSaveTicket,
  outcome: DocumentSaveOutcome,
): boolean {
  const kernelOutcome =
    outcome.kind === 'committed'
      ? Object.freeze({ kind: 'committed' as const })
      : Object.freeze({ kind: 'failed' as const, code: outcome.code })
  if (!ctx.completeKernelSave(ticket.request, kernelOutcome)) return false
  const binding = ctx.getDocumentBinding()
  applyDocumentBinding(binding, {
    sourceId: binding.value.sourceId,
    locator: binding.value.locator,
    saveBaseline: ticket.baseline,
    remoteRevisionId: outcome.kind === 'committed' ? outcome.revisionId ?? undefined : undefined,
  })
  return true
}
