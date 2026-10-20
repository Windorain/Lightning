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
   * **正式保存基线在外部绑定上的投影**（M8-2 收口）。
   *
   * ## 类型为什么是"产物 plain"而不是 `RuntimeDocument`
   *
   * 它唯一的用途是与"**将要写出去的那份产物**"（`Context#plainForSave().plain`）
   * 做差异比较（`wiki/wikiEditSummary#buildWikiEditSummaryDraft`：编辑摘要、
   * `poll` 的变更判定、状态栏的「· 未保存」）。旧类型是解析器的 `RuntimeDocument`，
   * 比较时先 `.serialize()` —— 而内核投影会按"首次使用"重排 tooltip 池
   * （同集合、不同顺序）⇒ **刚装载就判成"有未保存变更"**（M8-2 实测）。
   * 两边改成同一个投影空间后，"基线 = 已保存内容的产物"在类型上就是事实。
   *
   * ## 它不是第二本账
   *
   * 谁推进它由一个开关决定：只有 `workbench/document/pipeline#completeDocumentSave`
   * 在**内核结算 `applied` 之后**写它（B1 = `Document.saveBaseline` 是唯一权威，
   * 本字段是它的投影）。装载时由 `documentLoadPipeline` 钉到"刚打开 = 与基线相同"。
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
