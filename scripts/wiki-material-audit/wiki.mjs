/**
 * wiki.mjs —— 只读 MediaWiki API 客户端（零依赖，内置 fetch）
 * ============================================================================
 *
 * 站点 gtnh.huijiwiki.com 由 Cloudflare 托管，**匿名且不带 X-authkey 的请求会被
 * 交互式挑战拦下（HTTP 403 + cf-mitigated: challenge）**。实测带上团队共享的
 * X-authkey 后 API 正常返回 200，因此本工具只支持「从环境变量取 key」这一条路：
 *
 *     $env:HUIJI_AUTHKEY = "..."     # 团队共享 key，向 Wiki 维护者索取；禁止入库
 *
 * 纪律：
 *   - 只发 GET / query / parse 这类读请求，从不 POST，从不写；
 *   - 相邻请求最小间隔默认 1000ms（可 --min-interval 调大，不允许调小到 0）；
 *   - 分页用 API 的 continue 游标，不猜页码；
 *   - 失败重试 3 次、指数退让；429/5xx/网络错误才重试，4xx 业务错误直接抛出。
 */

const DEFAULT_API = 'https://gtnh.huijiwiki.com/api.php'
const USER_AGENT = 'Lightning-wiki-material-audit/1.0 (read-only audit; contact: Lightning repo)'

export class WikiError extends Error {
  constructor(message, code, detail) {
    super(message)
    this.name = 'WikiError'
    this.code = code || 'WIKI'
    this.detail = detail
  }
}

export class WikiClient {
  constructor(options = {}) {
    this.base = options.base || DEFAULT_API
    this.authkey = options.authkey || ''
    this.minInterval = Math.max(0, Number(options.minInterval == null ? 1000 : options.minInterval))
    this.maxRetries = options.maxRetries == null ? 3 : options.maxRetries
    this.log = options.log || (() => {})
    this.requestCount = 0
    this._nextAllowed = 0
  }

  async _throttle() {
    const wait = this._nextAllowed - Date.now()
    if (wait > 0) await sleep(wait)
  }

  async api(params) {
    const url = new URL(this.base)
    url.searchParams.set('format', 'json')
    url.searchParams.set('formatversion', '2')
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, String(value))
    }
    const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' }
    if (this.authkey) headers['X-authkey'] = this.authkey

    let lastError = null
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this._throttle()
      let response
      try {
        response = await fetch(url, { headers })
      } catch (error) {
        lastError = new WikiError('网络请求失败：' + error.message, 'NETWORK')
        this._noteFailure(attempt)
        continue
      }
      this.requestCount++
      this._nextAllowed = Date.now() + this.minInterval
      const text = await response.text()
      if (response.ok) {
        let json
        try {
          json = JSON.parse(text)
        } catch (error) {
          lastError = new WikiError('响应不是 JSON（可能被 Cloudflare 挑战页拦截）', 'NOT-JSON', text.slice(0, 200))
          this._noteFailure(attempt)
          continue
        }
        if (json && json.error) {
          throw new WikiError('MediaWiki API 错误：' + json.error.code + ' ' + (json.error.info || ''), 'API', json.error)
        }
        return json
      }

      const retryable = response.status === 429 || response.status >= 500
      lastError = new WikiError(
        'HTTP ' + response.status + (response.headers.get('cf-mitigated') ? '（Cloudflare 挑战：需要 HUIJI_AUTHKEY）' : ''),
        'HTTP-' + response.status,
        text.slice(0, 200),
      )
      if (!retryable) throw lastError
      const retryAfter = Number(response.headers.get('retry-after'))
      this._noteFailure(attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0)
    }
    throw lastError
  }

  _noteFailure(attempt, retryAfterMs) {
    if (attempt >= this.maxRetries) return
    const backoff = Math.max(this.minInterval * Math.pow(2, attempt + 1), 1500)
    const wait = retryAfterMs || backoff
    this.log('  ! 请求失败，' + Math.round(wait / 1000) + 's 后重试（第 ' + (attempt + 1) + '/' + this.maxRetries + ' 次）')
    this._nextAllowed = Date.now() + wait
  }

  async siteinfo() {
    const json = await this.api({ action: 'query', meta: 'siteinfo', siprop: 'namespaces|general|statistics' })
    return json.query
  }

  /** 分页列出命名空间里的页面。 */
  async listAllPages(namespace, prefix) {
    const out = []
    let cont = null
    do {
      const params = {
        action: 'query',
        list: 'allpages',
        apnamespace: String(namespace),
        aplimit: '500',
      }
      if (prefix) params.apprefix = prefix
      if (cont) params.apcontinue = cont
      const json = await this.api(params)
      out.push(...(json.query.allpages || []))
      cont = json.continue ? json.continue.apcontinue : null
    } while (cont)
    return out
  }

  /** 列出嵌入（transclude）某页面的所有页面，含所有命名空间。 */
  async listEmbeddedIn(title) {
    const out = []
    let cont = null
    do {
      const params = { action: 'query', list: 'embeddedin', eititle: title, eilimit: '500' }
      if (cont) params.eicontinue = cont
      const json = await this.api(params)
      out.push(...(json.query.embeddedin || []))
      cont = json.continue ? json.continue.eicontinue : null
    } while (cont)
    return out
  }

  /** 全站搜索（用于补漏直接写 data-wsr-structure 的页面）。 */
  async search(query, limit) {
    const out = []
    let offset = 0
    const cap = limit == null ? Infinity : limit
    do {
      const params = {
        action: 'query',
        list: 'search',
        srsearch: query,
        srlimit: '50',
        sroffset: String(offset),
        srprop: 'snippet',
      }
      const json = await this.api(params)
      out.push(...(json.query.search || []))
      offset = json.continue ? json.continue.sroffset : null
    } while (offset != null && out.length < cap)
    return out.slice(0, cap)
  }

  /** 批量取页面正文（每批最多 20 个标题）。 */
  async getPages(titles) {
    const result = new Map()
    const missing = []
    for (let i = 0; i < titles.length; i += 20) {
      const batch = titles.slice(i, i + 20)
      const json = await this.api({
        action: 'query',
        prop: 'revisions',
        rvprop: 'content|size|timestamp|contentmodel',
        rvslots: 'main',
        titles: batch.join('|'),
        redirects: '1',
      })
      const pages = json.query.pages || []
      const normalized = normalizedTitleMap(json.query)
      for (const page of pages) {
        if (page.missing) {
          missing.push(page.title)
          continue
        }
        const revision = page.revisions && page.revisions[0]
        const content = revision && revision.slots && revision.slots.main && revision.slots.main.content
        if (content == null) {
          missing.push(page.title)
          continue
        }
        result.set(page.title, {
          title: page.title,
          ns: page.ns,
          size: revision.size,
          timestamp: revision.timestamp,
          contentModel: revision.slots && revision.slots.main && revision.slots.main.contentmodel,
          text: content,
        })
      }
      // 请求的标题可能被重定向/规范化，按规范化结果回填一份，便于调用方按原名查。
      for (const [from, to] of normalized) {
        if (result.has(to) && !result.has(from)) result.set(from, result.get(to))
      }
    }
    return { pages: result, missing }
  }

  /** 流式扫描某命名空间全部页面正文（generator=allpages + revisions）。 */
  async *sweepNamespace(namespace, pageSize = 20) {
    let cont = null
    do {
      const params = {
        action: 'query',
        generator: 'allpages',
        gapnamespace: String(namespace),
        gaplimit: String(pageSize),
        gapfilterredir: 'nonredirects',
        prop: 'revisions',
        rvprop: 'content|size|contentmodel',
        rvslots: 'main',
      }
      if (cont) params.gapcontinue = cont
      const json = await this.api(params)
      for (const page of json.query.pages || []) {
        if (page.missing) continue
        const revision = page.revisions && page.revisions[0]
        const text = revision && revision.slots && revision.slots.main && revision.slots.main.content
        if (text == null) continue
        yield {
          title: page.title,
          ns: page.ns,
          size: revision.size,
          contentModel: revision.slots && revision.slots.main && revision.slots.main.contentmodel,
          text,
        }
      }
      cont = json.continue ? json.continue.gapcontinue : null
    } while (cont)
  }
}

function normalizedTitleMap(query) {
  const map = new Map()
  for (const entry of (query && query.normalized) || []) map.set(entry.from, entry.to)
  for (const entry of (query && query.redirects) || []) map.set(entry.from, entry.to)
  return map
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
