import { buildEnvelopePackage } from '@/pure/envelope'
import {
  applyUploadPlan,
  createWikiApi,
  isEditConflictError,
  isWikiApiAvailable,
  loadStructureData,
  previewUploadPlan,
} from '@/wiki/mwApiAdapter'
import { WIKI_DEFAULT_EDIT_SUMMARY } from '@/wiki/wikiEditSummary'
import { displayNameFromLocator } from '@/wiki/wikiUrls'
import { indexTitle, normalizeBase } from '@/util/wikiStructureData'
import type { DocumentLoadResult, DocumentSaveResult, DocumentSource } from '../types'

export const wikiDataPageSource: DocumentSource = {
  id: 'wiki-data',
  label: 'Wiki Data',

  poll(_ctx) {
    return isWikiApiAvailable()
  },

  async load(_ctx, props): Promise<DocumentLoadResult> {
    const title = String(props.title ?? props.locator ?? '')
    const api = createWikiApi()
    const loaded = await loadStructureData(api, title)
    return {
      raw: loaded.raw,
      locator: loaded.locator,
      revisionId: loaded.revisionId,
      displayName: loaded.base,
    }
  },

  async save(ctx, props): Promise<DocumentSaveResult> {
    const binding = ctx.getDocumentBinding().value
    const base =
      props.saveAsBase != null
        ? normalizeBase(String(props.saveAsBase))
        : displayNameFromLocator(binding.locator)
    const plain = ctx.getDoc().value?.serialize()
    if (!plain) throw new Error('无场景可保存')
    const envelope = buildEnvelopePackage(plain)
    const plan = previewUploadPlan(base, envelope)
    if (props.dryRun) {
      return { plan }
    }
    const api = createWikiApi()
    const baserevid =
      props.saveAsBase != null ? null : binding.remoteRevisionId
    try {
      const { lastRevisionId } = await applyUploadPlan(api, plan, {
        summary: props.summary ?? binding.pendingSaveSummary ?? WIKI_DEFAULT_EDIT_SUMMARY,
        baserevid,
        onProgress: msg => {
          ctx.log.setStatus(msg)
        },
      })
      return { revisionId: lastRevisionId, plan }
    } catch (err) {
      if (isEditConflictError(err)) {
        throw Object.assign(new Error('页面已被他人修改，请重新载入后再保存。'), {
          code: 'wiki-editconflict',
        })
      }
      throw err
    }
  },
}

export function wikiLocatorForBase(base: string): string {
  return indexTitle(normalizeBase(base))
}

export function wikiBaseFromBinding(locator: string): string {
  return displayNameFromLocator(locator)
}
