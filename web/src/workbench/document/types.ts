import type { ShallowRef } from 'vue'
import type { RuntimeDocument } from '@/context/runtimeDocument'
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
  saveBaseline: RuntimeDocument | null
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
