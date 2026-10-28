import type { Context, DocumentSaveOutcome, DocumentSaveTicket } from '@/runtime/context'
import type { WorkbenchWorkspaceMode } from '@/runtime/types'
import type { DocumentBindingRef, DocumentLoadResult, DocumentSourceId } from './types'
import { applyDocumentBinding, clearPendingSaveSummary, resetDocumentBinding } from './binding'
import { CAPABILITY } from '@/composition/modules'
import { pushRecentStructure } from '@/wiki/wikiRecentStructures'
import { hydrateMainEmbedInitialViewFromDoc } from '@/context/embedInitialView'
// **装配进内核**是本函数的一部分，不再是文件选择器路径的专属步骤。
// 见 `composition/documentLoad` 的文件头：本路径（wiki-data / SDE / 本地抽屉）
// 此前**从不**装配内核 ⇒ 内核文档只在文件选择器路径被填充，
// 而 wiki-data 恰是最高价值路径。任何"改读内核"的迁移都会在这里静默读到空文档。
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { plainRootOf } from '@/adapters/plainRoot'
import { wikiRemoteDirtyOf } from '@/wiki/wikiRemoteDirty'

/** 本地接管可以写入的**非 Wiki** 来源（`empty` 只出现在清空路径）。 */
export type TakeoverDocumentSourceId = Extract<DocumentSourceId, 'local-file' | 'builtin' | 'sde-export'>

/**
 * 一次非 Wiki 文档接管的绑定结算输入。
 *
 * - `no-document`：当前**没有**可归属的外部文档（新建空场景、卸载、装载失败清空）
 *   ⇒ 绑定整体清空（locator/baseline/revision 都为 null/空串）；
 * - `document`：文档有明确的来源与 locator ⇒ 用这一份来源重建绑定，并把保存基线
 *   钉到当前产物（"刚打开 = 干净"，与 `documentLoadPipeline` 同一语义）。
 */
export type DocumentTakeoverBinding =
  | { readonly kind: 'no-document' }
  | { readonly kind: 'document'; readonly sourceId: TakeoverDocumentSourceId; readonly locator: string }

/**
 * **非 Wiki 文档接管的唯一绑定结算点**（本地文件 / 新建 / 工程 / 内置样例 / SDE / 嵌入）。
 *
 * ## 它解决什么
 *
 * 文档绑定（`sourceId` / `locator` / `remoteRevisionId` / `saveBaseline`）描述的是
 * "**当前这份内容来自哪个外部文档**"。正式 Wiki 装载经 `documentLoadPipeline` 建立绑定，
 * 之后的保存结算（`completeDocumentSave`）与另存为只推进/替换同一份绑定的字段。
 * 但本地文件、新建场景、工程、内置样例、SDE、嵌入这些入口替换了**文档内容**却从不写绑定：
 * 旧 Wiki 页的 locator 与 revision 会留在当前会话里，"保存到 Wiki"仍以旧页为 base，
 * 本地保存还会把旧 Wiki 基线推进成非 Wiki 内容（指向错误页面的数据风险）。
 *
 * ⇒ 凡"替换当前文档且**不**经 Wiki 装载管线"的入口，成功后都必须调用本函数：
 * 要么重建成本地来源的绑定，要么在无文档时整体清空。它只写**同一个** `DocumentBinding`
 * （不新增文档身份权威，也不拿 `localFileName`/`workspaceMode` 冒充绑定）。
 *
 * ## 谁**不**调用它（同样重要）
 *
 * | 路径 | 为什么 |
 * |---|---|
 * | `Context#setDocument`（含 `content-sync`） | undo/redo、内容投影、注解/元数据替换都走它 —— **同一份文档**的载体变化不是文档接管 |
 * | `documentLoadPipeline` | Wiki 装载自己写绑定（`sourceId: 'wiki-data'` + 远端 revision） |
 * | `completeDocumentSave` / `WikiSaveAsOperator` | 正常保存/另存为是对**现有**绑定的字段推进，不能清 |
 * | `recoveryHost#installRestored` | 恢复副本不携带源 locator，已在自己的采纳序列里整体清空 |
 *
 * ## 为什么成功路径用"重建"而不是"清空"
 *
 * 清空只能表达"没有外部身份"；本地文件/工程/内置样例/SDE 都**有**明确的来源与名字。
 * 重建让 `sourceId` 如实说出"这是什么"，同时 `plainForSave().plain` 把基线钉到
 * 刚打开的产物（与 Wiki 装载同一条"刚打开 = 干净"语义）。因为 `sourceId` 不是
 * `wiki-data`，Wiki 保存闸门仍按 `NOT_WIKI_DATA_DOCUMENT` 关闭 —— 这正是期望。
 *
 * ## 嵌入文档为什么是 `no-document`
 *
 * `OPERATOR_LOAD_EMBED_DOCUMENT` 的内容由宿主页提供，没有文件 locator，也没有
 * 对应的 `DocumentSourceId`。把它记成 `local-file` 会谎报"来自某个本地文件"；
 * 它确实**不属于任何外部文档** ⇒ 清空是唯一如实的绑定。
 *
 * ## SDE 为什么也走这里
 *
 * SDE 是远端来源、不是本地文件，但同样**不是 Wiki**；`DocumentSourceId` 已有
 * `sde-export` 这一项。绑定必须从旧 Wiki 换成 SDE 自己的来源，否则同一条
 * "保存到 Wiki 指向旧页"的风险原样成立。
 */
export function settleDocumentTakeover(ctx: Context, binding: DocumentTakeoverBinding): void {
  // 嵌入外壳**没有工作台会话**，因此也没有 DocumentBinding（`getDocumentBinding()`
  // 会按装配事实抛错）。嵌入的文档由宿主页提供，本来就不存在可结算的外部绑定
  // ⇒ 这里只回答"没有可结算的绑定"，不是静默吞掉一次清空。
  if (!ctx.hasCapability(CAPABILITY.SHELL_WORKBENCH)) return
  const ref = ctx.getDocumentBinding()
  if (binding.kind === 'no-document') {
    resetDocumentBinding(ref)
    return
  }
  applyDocumentBinding(ref, {
    sourceId: binding.sourceId,
    locator: binding.locator,
    remoteRevisionId: null,
    saveBaseline: ctx.plainForSave().plain,
  })
  // `pendingSaveSummary` 是**上一份外部文档**的确认模态草稿（用户可能在
  // "保存到 Wiki"的文本框里写了摘要但还没点确认）。文档已经换手，这段草稿
  // 不再属于任何可保存目标 ⇒ 显式删掉，不能留给下一份文档的保存确认。
  clearPendingSaveSummary(ref)
}

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

/**
 * 装载/重载前的**丢弃确认**（DOCUMENT_LOAD / Wiki Reload / Wiki picker 共用）。
 *
 * ## 判定面 = 内核保存基线 **或** Wiki 远端
 *
 * 只看 `kernelDirty()` 会漏掉一类合法状态：Wiki 文档做过一次本地 SAVE_FILE/SAVE_PROJECT
 * 之后，内核保存基线已推进（内容写进了本地文件），但 Wiki 页**没有写** —— 本地保存的
 * 结算刻意不投影 Wiki 基线（见 `completeDocumentSave` 的 destination）。此时只改过
 * `cellGrid` 的话，摘要草稿也可能为 `null`（摘要字段表不含它）。
 *
 * ⇒ 丢弃确认必须同时问"Wiki 远端是否落后于当前完整产物"
 * （`wiki/wikiRemoteDirty#hasWikiRemoteChanges`，全量 canonical 比较）。
 * 这两件事任一为真，重新装载都会丢掉用户尚未写回 Wiki 的内容。
 */
export async function confirmDiscardDirtyIfNeeded(ctx: Context): Promise<boolean> {
  if (!(ctx.kernelDirty() ?? false) && !wikiRemoteDirtyOf(ctx)) return true
  const confirmFn = ctx.getToolSettings().confirmDirty ?? window.confirm
  if (!confirmFn('当前场景有未保存的修改，是否继续？')) return false
  return true
}

export function clearEditingState(ctx: Context): void {
  ctx.getSelection().clear()
  // 原 ctx.getEditHistory().clear() 删除（不是遗漏）—— 内核撤销历史随
  // Document 存续，紧随其后的 documentLoadPipeline 会经 setDocument 换成
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
    // 经唯一写入口（存在性镜像），随后 `adoptLoadedDocument` 装配内容。
    ctx.setDocument(result.document)
    ctx.viewports.resetAllViewportCameras(ctx.main.cameras)
    hydrateMainEmbedInitialViewFromDoc(ctx.main)
    ctx.requireKernelSession().seekFrame(0)
    // ── 装配进内核 ──
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
      // 基线是**产物投影**（`plainForSave` —— 与真正写出去的那份同一来源），
      // 不是解析器的 RuntimeDocument。理由见 `DocumentBinding.saveBaseline` 的说明：
      // 旧值经 `.serialize()` 与投影产物比较，而投影会按"首次使用"重排 tooltip 池
      // ⇒ 刚装载就报「有未保存变更」（实测：palette 同集合不同顺序）。
      saveBaseline: ctx.plainForSave().plain,
    })
    // 成功装载 = 当前绑定已指向**另一份**外部文档（Wiki Reload/换页或本地来源）。
    // 上一页的确认草稿不能跟过来；失败路径在上面提前 return，草稿随当前绑定保留。
    clearPendingSaveSummary(bindingRef)
    if (sourceId === 'wiki-data') {
      pushRecentStructure(loadResult.displayName ?? loadResult.locator, ctx.instanceId)
      ctx.getLocalFileName().value = loadResult.displayName ?? loadResult.locator
    }
  } else {
    // ── 装载失败**不换掉**当前有效文档 ──────────────────────────────
    //
    // 旧形态是三件事一起做：`setDocument(null)`、清 `embedInitialView`、把绑定置成
    // `empty/null`。后果是具体的：用户正在编辑的内容（含未保存修改）与选择被一次
    // **失败的打开**清空，且没有任何回退路径。这正是契约
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
// 生产保存的结算：**唯一**推进正式保存基线的入口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一次生产保存的**凭据**（`DocumentSaveTicket`）与结局（`DocumentSaveOutcome`）
 * 的**类型定义在 `runtime/context`** —— 它们描述的是"内核在途请求 + 捕获的产物投影"
 * 这一对事实，`Context#beginKernelSave` 与这里共用同一份词汇。
 *
 * 两者都在**发起**时捕获，且都必须原样递回 {@link completeDocumentSave} ——
 * 「基线取请求捕获的起点快照」因此在结构上不可能被"完成时读当前版本"偷偷改掉。
 */

/**
 * 发起一次生产保存结算：捕获起点快照（内核保存基线的请求 + 外部绑定投影的产物）。
 *
 * @returns `null` = 无内核会话/未装配/**已有在途保存** ⇒ 调用方如实失败（不并发）。
 *          **不是**"保存已经成功了"。
 */
export function beginDocumentSave(ctx: Context): DocumentSaveTicket | null {
  // 顺序固定：先取产物投影（同步），再登记内核在途（同步）——
    // 两者之间没有 await，故不存在"捕获到半份起点快照"的窗口。
  const baseline = ctx.plainForSave().plain
  const request = ctx.beginKernelSave()
  if (request === null) return null
  return Object.freeze({ request, baseline })
}

/** 一次保存**写向哪里**：决定它能否投影到当前绑定的基线。 */
export type DocumentSaveDestination = 'wiki' | 'local'

/**
 * 结算一次生产保存：**内核保存基线是唯一权威**，外部绑定投影只是它在外部绑定上的镜像。
 *
 * 语义全部由内核判定（`application/commands#reduceSaveCompleted` →
 * `domain/document#completeSave`）：序号相符、绑定代数相符、只有 `committed` 才推进，
 * 且推进到**该请求捕获的起点快照**。因此：
 //  - 保存期间的**新编辑仍脏**（`commands.ts:2336`）；
 *  - 失败/过期**不动**基线；
 *  - 外部绑定投影只在保存真的推进（`applied`）时才跟着换，**不存在两条各自推进的路径**
   //    （旧 `afterDocumentSave` 无条件写外部绑定投影，正是第二条写权威 —— 已删除）。
 *
 * @returns 是否真的推进了正式保存基线
 */
export function completeDocumentSave(
  ctx: Context,
  ticket: DocumentSaveTicket,
  outcome: DocumentSaveOutcome,
  /**
   * 这次保存**写向哪里**（**必填**，由保存目标显式传入）。
   *
   * 故意不给缺省值：保存目标决定外部绑定投影是否推进，而"漏传默认成 wiki"
   * 会让未来某个本地保存调用静默把旧 Wiki 基线标成已保存 —— 那是数据安全风险，
   * 必须由调用点显式回答。`SAVE_FILE`/`SAVE_PROJECT` 传 `'local'`；
   * Wiki 保存/另存为传 `'wiki'`。
   *
   * ⚠️ 它不改变内核保存基线：该基线由 `completeKernelSave` 按 committed 推进（"内容已落地"
   * 对本地保存同样成立）。它只决定**外部绑定投影**是否推进：
   * 本地保存写的是浏览器下载，**没有写 Wiki 页**；若把它的起点快照投影成 Wiki 基线，
   * "保存到 Wiki"会把从未写出的内容判成干净。
   */
  destination: DocumentSaveDestination,
): boolean {
  const kernelOutcome =
    outcome.kind === 'committed'
      ? Object.freeze({ kind: 'committed' as const })
      : Object.freeze({ kind: 'failed' as const, code: outcome.code })
  if (!ctx.completeKernelSave(ticket.request, kernelOutcome)) return false
  const binding = ctx.getDocumentBinding()
    // 唯一的**不投影**组合：对 Wiki 绑定做本地保存。写盘没有写 Wiki 页，若把起点快照
  // 投影成 Wiki 基线，"保存到 Wiki"就会把从未写出的内容判成干净（数据安全风险）。
  //
  // 其余组合都投影（含"另存为 Wiki 结构"从本地文档出发：那次写入的确实是当前
    // 内容，外部绑定投影必须钉成起点快照，随后才换 locator；否则新页刚写完就被判成脏）。
    // 不同步时内核保存基线已按 committed 推进（内容确实被保存到某处），外部绑定投影原样保留。
  if (destination === 'local' && binding.value.sourceId === 'wiki-data') return true
  // 绑定身份（sourceId/locator）描述的是"当前文档来自哪"，保存只推进**基线**；
  // 远端 revision 只有这次保存真的带回来时才推进（本地保存不带 revision，
  // 不能把 Wiki 绑定上已有的 revision "清成 null"——那不是一次 Wiki 保存）。
  const patch = {
    sourceId: binding.value.sourceId,
    locator: binding.value.locator,
    saveBaseline: ticket.baseline,
  }
  applyDocumentBinding(
    binding,
    outcome.kind === 'committed' && outcome.revisionId != null
      ? { ...patch, remoteRevisionId: outcome.revisionId }
      : patch,
  )
  return true
}
