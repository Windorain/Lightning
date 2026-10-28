/**
 * 灰机 Wiki `mw.Api` 唯一 TypeScript 入口；其它模块禁止直接引用 mw。
 */
import {
  cleanupTitlesForOverwrite,
  indexTitle,
  isMultipartIndex,
  mergeMultipartIndex,
  normalizeBase,
  partTitlesFromIndex,
  planUpload,
  probeLegacyPartTitles,
  type UploadPlan,
} from '@/util/wikiStructureData'
import type { MwApi, MwApiRequestResult, MwGlobal } from './mwApiTypes'
import { getMwGlobal, hasMwApiClient } from './mwApiTypes'
import { structureDisplayNameFromTitle } from '@/util/wikiStructureData/titles'
import { WIKI_DEFAULT_EDIT_SUMMARY } from '@/wiki/wikiEditSummary'

export class WikiApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'WikiApiError'
  }
}

/** 从 mw.user / wgUserName 解析当前登录用户名（灰机 cockpit 常仅有后者） */
export function getWikiUsername(): string | null {
  const mw = getMwGlobal()
  if (!mw) return null
  try {
    const fromUser = mw.user?.getName?.()
    if (typeof fromUser === 'string' && fromUser.trim()) return fromUser.trim()
  } catch {
    /* mw.user 未就绪 */
  }
  const fromConfig = mw.config?.get('wgUserName')
  if (typeof fromConfig === 'string' && fromConfig.trim()) return fromConfig.trim()
  return null
}

export function isWikiApiAvailable(): boolean {
  return hasMwApiClient() && getWikiUsername() != null
}

export function createWikiApi(): MwApi {
  const mw = getMwGlobal()
  if (!mw?.Api) throw new WikiApiError('请在已登录的灰机 Wiki 页面中使用')
  return new mw.Api()
}

function promisifyGet(api: MwApi, params: Record<string, unknown>): Promise<MwApiRequestResult> {
  return new Promise((resolve, reject) => {
    api
      .get(params)
      .done(resolve)
      .fail(err => reject(new WikiApiError(String(err))))
  })
}

function promisifyPost(
  api: MwApi,
  params: Record<string, unknown>,
): Promise<MwApiRequestResult> {
  return new Promise((resolve, reject) => {
    api
      .postWithToken('csrf', params)
      .done(resolve)
      .fail(err => reject(new WikiApiError(String(err))))
  })
}

/** GTNH 灰机 Data 命名空间（`wgNamespaceIds` 不可用时的最后兜底） */
const GTNH_FALLBACK_DATA_NS = 3500

let cachedDataNamespaceId: number | null = null

function dataNamespaceIdFromConfig(mw: MwGlobal): number | null {
  const ids = mw.config?.get('wgNamespaceIds') as Record<string, number> | undefined
  if (!ids) return null
  if (typeof ids.Data === 'number') return ids.Data
  for (const [name, id] of Object.entries(ids)) {
    if (name.toLowerCase() === 'data' && typeof id === 'number') return id
  }
  return null
}

async function resolveDataNamespaceId(mw: MwGlobal, api: MwApi): Promise<number> {
  if (cachedDataNamespaceId != null) return cachedDataNamespaceId
  const fromConfig = dataNamespaceIdFromConfig(mw)
  if (fromConfig != null) {
    cachedDataNamespaceId = fromConfig
    return fromConfig
  }
  try {
    const data = await promisifyGet(api, {
      action: 'query',
      meta: 'siteinfo',
      siprop: 'namespaces',
      format: 'json',
    })
    const namespaces = data.query?.namespaces
    if (namespaces) {
      for (const [nsId, entry] of Object.entries(namespaces)) {
        if (entry['*'] === 'Data') {
          const n = parseInt(nsId, 10)
          if (!Number.isNaN(n)) {
            cachedDataNamespaceId = n
            return n
          }
        }
      }
    }
  } catch {
    /* siteinfo 失败时用站点已知兜底 */
  }
  cachedDataNamespaceId = GTNH_FALLBACK_DATA_NS
  return GTNH_FALLBACK_DATA_NS
}

function tryAddStructureSearchHit(
  title: string,
  q: string,
  hits: StructureSearchHit[],
  limit: number,
): boolean {
  if (!/^Data:Structures\//i.test(title)) return false
  if (/_\d+\.json$/i.test(title)) return false
  const displayName = structureDisplayNameFromTitle(title)
  if (q && !displayName.toLowerCase().includes(q)) return false
  if (hits.some(h => h.title === title)) return hits.length >= limit
  hits.push({ title, displayName })
  return hits.length >= limit
}

function parsePageJson(data: MwApiRequestResult): unknown | null {
  const pages = data.query?.pages
  if (!pages) return null
  const page = pages[Object.keys(pages)[0]]
  if (!page || page.missing) return null
  const rev = page.revisions?.[0]
  const content = rev?.slots?.main?.['*']
  if (!content) return null
  try {
    return JSON.parse(content)
  } catch {
    return null
  }
}

function pageRevisionId(data: MwApiRequestResult): number | null {
  const pages = data.query?.pages
  if (!pages) return null
  const page = pages[Object.keys(pages)[0]]
  return page?.revisions?.[0]?.revid ?? null
}

export async function fetchPageJson(api: MwApi, title: string): Promise<{
  doc: unknown | null
  revisionId: number | null
}> {
  const data = await promisifyGet(api, {
    action: 'query',
    titles: title,
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
    format: 'json',
  })
  return {
    doc: parsePageJson(data),
    revisionId: pageRevisionId(data),
  }
}

export async function probeExistingPartCount(api: MwApi, base: string): Promise<number> {
  const titles = probeLegacyPartTitles(base, 32)
  const data = await promisifyGet(api, {
    action: 'query',
    titles: titles.join('|'),
    format: 'json',
  })
  const pages = data.query?.pages
  if (!pages) return 0
  let max = 0
  for (const id of Object.keys(pages)) {
    const p = pages[id]
    if (!p?.missing && p.title) {
      const m = /_(\d+)\.json$/i.exec(p.title)
      if (m) max = Math.max(max, parseInt(m[1], 10))
    }
  }
  return max
}

export interface WikiLoadedRaw {
  raw: unknown
  locator: string
  revisionId: number | null
  base: string
}

/** 载入 Data:Structures 结构（单页或分片合并） */
export async function loadStructureData(
  api: MwApi,
  titleOrBase: string,
): Promise<WikiLoadedRaw> {
  const base = normalizeBase(titleOrBase)
  const locator = indexTitle(base)
  const { doc: indexDoc, revisionId } = await fetchPageJson(api, locator)
  if (!indexDoc) {
    throw new WikiApiError(`未找到 ${locator}`)
  }
  if (isMultipartIndex(indexDoc)) {
    const partTitles = partTitlesFromIndex(indexDoc, base)
    if (!partTitles?.length) {
      throw new WikiApiError('分片索引无效')
    }
    const data = await promisifyGet(api, {
      action: 'query',
      titles: partTitles.join('|'),
      prop: 'revisions',
      rvprop: 'content',
      rvslots: 'main',
      format: 'json',
    })
    const pages = data.query?.pages ?? {}
    const parts: Array<{ part: number; payload?: string }> = []
    for (const id of Object.keys(pages)) {
      const p = pages[id]
      if (p?.missing) continue
      const rev = p.revisions?.[0]
      const content = rev?.slots?.main?.['*']
      if (!content) continue
      try {
        const partDoc = JSON.parse(content) as { part: number; payload?: string }
        parts.push(partDoc)
      } catch {
        throw new WikiApiError('分片 JSON 解析失败')
      }
    }
    const raw = mergeMultipartIndex(indexDoc, parts)
    return { raw, locator, revisionId, base }
  }
  return { raw: indexDoc, locator, revisionId, base }
}

export interface StructureSearchHit {
  title: string
  displayName: string
}

export async function searchStructureDataPages(
  query: string,
  limit = 30,
): Promise<StructureSearchHit[]> {
  const mw = getMwGlobal()
  if (!mw) return []
  const api = createWikiApi()
  const q = query.trim().toLowerCase()
  if (!q) return []
  const dataNs = await resolveDataNamespaceId(mw, api)
  const hits: StructureSearchHit[] = []

  const searchData = await promisifyGet(api, {
    action: 'query',
    list: 'search',
    srsearch: query.trim(),
    srnamespace: dataNs,
    srlimit: Math.min(limit * 2, 50),
    format: 'json',
  })
  for (const item of searchData.query?.search ?? []) {
    if (tryAddStructureSearchHit(item.title ?? '', q, hits, limit)) return hits
  }
  if (hits.length >= limit) return hits

  let apcontinue: string | undefined
  do {
    const params: Record<string, unknown> = {
      action: 'query',
      list: 'allpages',
      apnamespace: dataNs,
      apprefix: 'Structures/',
      aplimit: Math.min(limit * 3, 500),
      format: 'json',
    }
    if (apcontinue) params.apcontinue = apcontinue
    const data = await promisifyGet(api, params)
    for (const p of data.query?.allpages ?? []) {
      if (tryAddStructureSearchHit(p.title ?? '', q, hits, limit)) return hits
    }
    apcontinue = data.continue?.apcontinue
  } while (apcontinue && hits.length < limit)

  return hits
}

async function editPage(
  api: MwApi,
  title: string,
  text: string,
  summary: string,
  baserevid?: number | null,
): Promise<number | null> {
  const params: Record<string, unknown> = {
    action: 'edit',
    title,
    text,
    summary,
    format: 'json',
  }
  if (baserevid != null) params.baserevid = baserevid
  const data = await promisifyPost(api, params)
  if (data.error) {
    const code = data.error.code ?? ''
    throw new WikiApiError(data.error.info ?? code, code)
  }
  if (data.edit?.result === 'Success') {
    return data.edit.newrevid ?? null
  }
  throw new WikiApiError(`编辑失败: ${data.edit?.result ?? 'unknown'}`)
}

async function deletePage(api: MwApi, title: string, reason: string): Promise<void> {
  await promisifyPost(api, {
    action: 'delete',
    title,
    reason,
  })
}

export interface ApplyUploadOptions {
  summary?: string
  baserevid?: number | null
  onProgress?: (msg: string) => void
}

/** 顺序执行 planUpload 结果（与 StructureRenderUpload 一致） */
export async function applyUploadPlan(
  api: MwApi,
  plan: UploadPlan,
  options: ApplyUploadOptions = {},
): Promise<{ lastRevisionId: number | null }> {
  const summary = options.summary ?? WIKI_DEFAULT_EDIT_SUMMARY
  const base = plan.base
  const { doc: existingIndex } = await fetchPageJson(api, indexTitle(base))
  let knownOldParts = 0
  if (existingIndex && isMultipartIndex(existingIndex)) {
    knownOldParts = (existingIndex as Record<string, unknown>).partCount as number
  } else {
    knownOldParts = await probeExistingPartCount(api, base)
  }
  const toDelete = cleanupTitlesForOverwrite(existingIndex, plan, knownOldParts)
  for (const delTitle of toDelete) {
    options.onProgress?.(`删除 ${delTitle}`)
    await deletePage(api, delTitle, 'Lightning：移除过时分片')
  }
  let lastRev: number | null = null
  for (let i = 0; i < plan.pages.length; i++) {
    const page = plan.pages[i]
    options.onProgress?.(`保存 ${i + 1}/${plan.pages.length}`)
    const isIndex = i === 0
    lastRev = await editPage(
      api,
      page.title,
      page.text,
      plan.mode === 'single'
        ? summary
        : `${summary}（${i + 1}/${plan.pages.length}）`,
      isIndex ? options.baserevid : null,
    )
  }
  return { lastRevisionId: lastRev }
}

export function previewUploadPlan(base: string, envelopeDoc: unknown): UploadPlan {
  return planUpload(base, envelopeDoc)
}

export function isEditConflictError(err: unknown): boolean {
  return err instanceof WikiApiError && (err.code === 'editconflict' || /editconflict/i.test(err.message))
}
