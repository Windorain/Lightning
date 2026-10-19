import type { Context } from '@/runtime/context'
import type { DocumentSource, DocumentSourceId } from './types'
import { wikiDataPageSource } from './sources/wikiDataPageSource'
import { localFileSource } from './sources/localFileSource'
import { CAPABILITY } from '@/composition/modules'

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

  /**
   * 按**能力**列出可用文档来源（B5 #7）。
   *
   * 旧实现是 `getHostProfile()` 的模块级反查 —— 于是"当前能打开哪些来源"
   * 取决于某个全局变量最后被谁写过。现在它取决于**是否具备 Wiki 上传能力**：
   *  - 有 ⇒ 只列 wiki-data（Wiki 工作台的文档来源就是 Wiki）；
   *  - 无 ⇒ 列本地文件，以及任何 `poll` 通过的非 wiki 来源。
   */
  listForProfile(ctx?: Context): DocumentSource[] {
    const wikiHost = ctx?.hasCapability(CAPABILITY.WIKI_UPLOAD) ?? false
    if (wikiHost) {
      return ALL_SOURCES.filter((s) => s.id === 'wiki-data')
    }
    return ALL_SOURCES.filter((s) => s.id !== 'wiki-data' || s.poll({} as Context))
  }
}

let globalRegistry: DocumentSourceRegistry | null = null

export function getDocumentSourceRegistry(): DocumentSourceRegistry {
  if (!globalRegistry) {
    globalRegistry = new DocumentSourceRegistry(ALL_SOURCES)
  }
  return globalRegistry
}
