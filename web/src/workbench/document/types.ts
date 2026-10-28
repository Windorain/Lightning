import type { ShallowRef } from 'vue'
import type { Context } from '@/runtime/context'
import type { UploadPlan } from '@/util/wikiStructureData'

export type DocumentSourceId =
  | 'empty'
  | 'local-file'
  | 'sde-export'
  | 'wiki-data'
  | 'builtin'

export interface DocumentBinding {
  sourceId: DocumentSourceId
  locator: string
  remoteRevisionId: number | null
  /**
   * **正式保存基线在外部绑定上的投影**。
   *
   * ## 类型为什么是"产物 plain"而不是 `RuntimeDocument`
   *
   * 它的用途是回答"**当前完整产物与这个外部文档已保存的内容是否相同**"：
   *  - `wiki/wikiRemoteDirty#hasWikiRemoteChanges` 做全量 canonical 语义比较，
   *    驱动 Wiki 保存门/状态栏「· 未保存」/装载前丢弃确认；
   *  - `wiki/wikiEditSummary#buildWikiEditSummaryDraft` 只从中生成**摘要文本**
   *    （少数字段），不再充当"远端是否陈旧"的完整判据。
   *
   * 旧类型是解析器的 `RuntimeDocument`，比较时先 `.serialize()` —— 而内核投影会按
   * "首次使用"重排 tooltip 池（同集合、不同顺序）⇒ **刚装载就判成"有未保存变更"**
   * （实测）。两边改成同一个投影空间后，"基线 = 已保存内容的产物"在类型上就是事实。
   *
   * ## 它不是第二本账
   *
   * 谁写它由保存/装载边界显式决定（`Document.saveBaseline` 是唯一权威）：
   *  - **Wiki 装载**：`documentLoadPipeline` 钉到"刚打开 = 与基线相同"；
   *  - **非 Wiki 文档接管**：`workbench/document/pipeline#settleDocumentTakeover`
   *    用当前产物重建（本地文件/工程/内置样例/SDE）；无文档时 `resetDocumentBinding` 清空；
   *  - **正式保存（外部绑定投影）**：只有 `completeDocumentSave` 在内核结算 `applied` 之后写，
   *    且**仅当保存目标与绑定所指外部文档一致**（本地保存不投影 Wiki 基线）。
   *
   * 接管时 `pendingSaveSummary`（上一份外部文档的确认草稿）同时被显式清除。
   */
  saveBaseline: Readonly<Record<string, unknown>> | null
  /** 保存摘要草稿（确认模态用） */
  pendingSaveSummary?: string
}

export interface DocumentLoadResult {
  raw: unknown
  locator: string
  revisionId?: number | null
  displayName?: string
}

export interface DocumentSaveProps {
  summary?: string
  /** 干跑：只返回 plan，不写 Wiki */
  dryRun?: boolean
  /** 另存为：覆盖 base */
  saveAsBase?: string
}

export interface DocumentSaveResult {
  plan?: UploadPlan
  revisionId?: number | null
}

export interface DocumentSource {
  id: DocumentSourceId
  label: string
  poll(ctx: Context): boolean
  load(ctx: Context, props: Record<string, unknown>): Promise<DocumentLoadResult>
  save(ctx: Context, props: DocumentSaveProps): Promise<DocumentSaveResult>
}

export type DocumentBindingRef = ShallowRef<DocumentBinding>
