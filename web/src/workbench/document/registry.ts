import type { Context } from '@/runtime/context'
import type { DocumentSource, DocumentSourceId } from './types'
import { wikiDataPageSource } from './sources/wikiDataPageSource'
import { localFileSource } from './sources/localFileSource'
import { getHostProfile } from '@/runtime/hostProfile'

const ALL_SOURCES: DocumentSource[] = [wikiDataPageSource, localFileSource]

export class DocumentSourceRegistry {
  private readonly byId = new Map<DocumentSourceId, DocumentSource>()

  constructor(sources: DocumentSource[]) {
    for (const s of sources) {
      this.byId.set(s.id, s)
    }
  }

  get(id: DocumentSourceId): DocumentSource | undefined {
    return this.byId.get(id)
  }

  listForProfile(): DocumentSource[] {
    const profile = getHostProfile()
    if (profile === 'wiki') {
      return ALL_SOURCES.filter(s => s.id === 'wiki-data')
    }
    return ALL_SOURCES.filter(s => s.id !== 'wiki-data' || s.poll({} as Context))
  }
}

let globalRegistry: DocumentSourceRegistry | null = null

export function getDocumentSourceRegistry(): DocumentSourceRegistry {
  if (!globalRegistry) {
    globalRegistry = new DocumentSourceRegistry(ALL_SOURCES)
  }
  return globalRegistry
}
