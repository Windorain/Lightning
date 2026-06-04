/** 灰机 / MediaWiki `mw.Api` 最小类型（仅 adapter 使用） */

export interface MwApiRequestResult {
  error?: { code?: string; info?: string }
  edit?: { result?: string; newrevid?: number }
  delete?: { title?: string }
  query?: {
    pages?: Record<
      string,
      {
        title?: string
        missing?: boolean
        revisions?: Array<{
          revid?: number
          slots?: { main?: { '*'?: string } }
        }>
      }
    >
    allpages?: Array<{ title?: string }>
    search?: Array<{ title?: string }>
    namespaces?: Record<string, { '*'?: string }>
  }
  continue?: { apcontinue?: string }
}

export interface MwApi {
  get(params: Record<string, unknown>): {
    done(cb: (data: MwApiRequestResult) => void): { fail(cb: (err: unknown) => void): void }
  }
  postWithToken(
    tokenType: string,
    params: Record<string, unknown>,
  ): {
    done(cb: (data: MwApiRequestResult) => void): { fail(cb: (err: unknown) => void): void }
  }
}

export interface MwGlobal {
  Api: new (options?: { ajax?: unknown }) => MwApi
  config?: { get: (key: string) => unknown }
  user?: { getName: () => string | null }
}

export function getMwGlobal(): MwGlobal | null {
  if (typeof globalThis === 'undefined') return null
  const g = globalThis as { mw?: MwGlobal }
  return g.mw?.Api ? g.mw : null
}

/** 灰机页内是否已注入 mw.Api（不要求已登录） */
export function hasMwApiClient(): boolean {
  return getMwGlobal() != null
}
