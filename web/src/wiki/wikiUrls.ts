import { normalizeBase } from '@/util/wikiStructureData'

const WIKI_ORIGIN =
  typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : 'https://wiki.gtnewhorizons.com'

export const WIKI_UPLOAD_PROJECT_PATH =
  '/wiki/Project:GTNH%E5%9C%A8%E7%BA%BF%E7%BB%93%E6%9E%84%E6%B8%B2%E6%9F%93%E5%99%A8%E7%BB%93%E6%9E%84%E6%95%B0%E6%8D%AE%E4%B8%8A%E4%BC%A0'

export function buildWikiDataPageUrl(title: string): string {
  const enc = encodeURIComponent(title.replace(/ /g, '_'))
  return `${WIKI_ORIGIN}/wiki/${enc}`
}

export function buildWikiUploadPageUrl(): string {
  return `${WIKI_ORIGIN}${WIKI_UPLOAD_PROJECT_PATH}`
}

export function locatorFromBase(base: string): string {
  const b = normalizeBase(base)
  return `Data:Structures/${b}.json`
}

export function displayNameFromLocator(locator: string): string {
  return normalizeBase(locator.replace(/^Data:Structures\//i, ''))
}
