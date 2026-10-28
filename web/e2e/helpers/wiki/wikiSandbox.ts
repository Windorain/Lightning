/**
 * **wiki-profile e2e 入口的页内沙箱**（灰机 `mw.Api` 的替身 + 生产路径装载/保存原语）。
 *
 * ## 为什么需要它
 *
 * 「Wiki 保存」这条生产路径的前置是 `isWikiApiAvailable()`（`wiki/mwApiAdapter`）：
 * 它要求页面里有 `mw.Api` 且能解析出登录用户名。灰机工作台真实运行时由站点注入
 * `mediawiki` 的 `mw` 全局；e2e 的 dev server 没有站点 ⇒ 不造这一层就无法进入
 * 「保存到 Wiki」这条路（因此曾把 Wiki 半边登记为**不可达**）。
 *
 * ## 它替的是什么、不替什么
 *
 * | 替身 | 位置 | 边界 |
 * |---|---|---|
 * | `window.mw`（`Api`/`config`/`user`） | 页内 `addInitScript`，**先于应用启动** | 只实现 `wiki/mwApiAdapter` 真正调用的两件事（`get` / `postWithToken`（csrf）），返回值走 `fetch` 回到测试进程 |
 * | 远端页面内容 | 测试进程的 `page.route`（`/__e2e_wiki__/…`） | 索引页内容 = 真实夹具信封（`structuredata-exported-envelope.json`），不是手搓结构 |
 *
 * **不替**：装载/保存的调用链、装配、保存结算、产物编码全部是生产代码（本次判据的
 * 被测对象）。测试进程只扮演"远端 MediaWiki"，并且**记录**每次 edit 的标题/正文/摘要
 * ——于是"保存真的把 S0 内容写出去了"是跨进程可核对的事实，而不是页面自说自话。
 *
 * ## 为什么用 `page.route` 而不是把夹具塞进 `addInitScript`
 *
 * 夹具 200 KB；经 `addInitScript` 注入会把它塞进每个页面的启动脚本（还会出现在
 * 失败 trace 里）。用一条 HTTP 路由把它当"远端页面"提供，既贴近真实（页面字节
 * 本来就是经网络来的），又让测试进程能读到**被写出去的正文**。
 */

import { expect, type Page } from '@playwright/test'
import { resolveWikiBaseURL } from '../../tree-identity'

/** 页内与测试进程共用的路由前缀（不是产品路径，应用本身从不请求它）。 */
export const WIKI_SANDBOX_PREFIX = '/__e2e_wiki__/'

/** 一次 `action=edit` 请求的记录（测试进程侧）。 */
export interface WikiEditRequest {
  readonly title: string
  readonly text: string
  readonly summary: string
  readonly baserevid: number | null
}

export interface WikiSandbox {
  /** 已收到的 edit 请求（按到达顺序）。 */
  readonly edits: WikiEditRequest[]
  /** 装载用的索引页修订号（保存时 `baserevid` 应当等于它）。 */
  readonly loadRevisionId: number
  /** 收到的全部请求（get/post）次数——用于"保存期间"这类时序判据。 */
  requests(): number
}

export interface WikiSandboxOptions {
  /** 索引页标题（`Data:Structures/<base>.json`）；保存时也按它比对。 */
  readonly indexTitle: string
  /** 索引页正文（真实夹具信封的原文）。 */
  readonly indexContent: string
  /**
   * `action=edit` 的响应延迟（毫秒）。
   *
   * 用来把"保存**期间**用户又编辑了"这一竞态变成可判定的时序：请求到达后
   * 测试进程先拿到通知，再做一次真实编辑，然后才让远端返回成功。
   */
  readonly editDelayMs?: number
}

/**
 * 安装页内 `mw` 替身 + 远端页面路由。**必须在 `page.goto` 之前调用**。
 */
export async function installWikiSandbox(page: Page, opts: WikiSandboxOptions): Promise<WikiSandbox> {
  const edits: WikiEditRequest[] = []
  let requests = 0
  let revision = 1000
  const loadRevisionId = revision

  await page.addInitScript(
    (prefix: string) => {
      const rpc = (path: string, params: unknown) => {
        let onDone: ((v: unknown) => void) | null = null
        let onFail: ((e: unknown) => void) | null = null
        let started = false
        const start = () => {
          if (started) return
          started = true
          fetch(prefix + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(params),
          })
            .then(async (r) => {
              if (!r.ok) throw new Error('e2e wiki sandbox: HTTP ' + r.status)
              return (await r.json()) as unknown
            })
            .then((v) => {
              if (onDone) onDone(v)
            })
            .catch((e) => {
              if (onFail) onFail(e)
            })
        }
        return {
          done(cb: (v: unknown) => void) {
            onDone = cb
            start()
            return {
              fail(f: (e: unknown) => void) {
                onFail = f
              },
            }
          },
          fail(f: (e: unknown) => void) {
            onFail = f
            start()
          },
        }
      }
      class FakeApi {
        get(params: Record<string, unknown>) {
          return rpc('get', params)
        }
        postWithToken(_tokenType: string, params: Record<string, unknown>) {
          return rpc('post', params)
        }
      }
      const w = window as unknown as { mw?: unknown; __e2e_wiki__?: unknown }
      w.mw = {
        Api: FakeApi,
        // `isWikiApiAvailable()` = 有 mw.Api **且** 解析得出用户名（`wiki/mwApiAdapter`）
        config: { get: (k: string) => (k === 'wgUserName' ? 'E2E-Wiki-Bot' : undefined) },
        user: { getName: () => 'E2E-Wiki-Bot' },
      }
      w.__e2e_wiki__ = { installed: true }
    },
    WIKI_SANDBOX_PREFIX,
  )

  // ⚠️ 模式必须以 `**/` 开头：Playwright 的 glob 是拿**绝对 URL** 匹配的，
  // 写成 `/__e2e_wiki__/**` 永远不命中（请求会落到 vite 的 404）。
  await page.route(`**${WIKI_SANDBOX_PREFIX}**`, async (route) => {
    requests += 1
    const url = new URL(route.request().url())
    const kind = url.pathname.slice(WIKI_SANDBOX_PREFIX.length)
    const params = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>

    if (kind === 'get') {
      await route.fulfill({ json: answerGet(params, opts, revision) })
      return
    }
    if (kind === 'post') {
      if (params.action === 'edit') {
        edits.push({
          title: String(params.title ?? ''),
          text: String(params.text ?? ''),
          summary: String(params.summary ?? ''),
          baserevid: params.baserevid === undefined ? null : Number(params.baserevid),
        })
        if (opts.editDelayMs !== undefined && opts.editDelayMs > 0) {
          await new Promise((r) => setTimeout(r, opts.editDelayMs))
        }
        revision += 1
        await route.fulfill({ json: { edit: { result: 'Success', newrevid: revision } } })
        return
      }
      if (params.action === 'delete') {
        await route.fulfill({ json: { delete: { title: String(params.title ?? '') } } })
        return
      }
      await route.fulfill({ json: {} })
      return
    }
    await route.fulfill({ status: 404, body: 'e2e wiki sandbox: unknown route' })
  })

  return {
    edits,
    loadRevisionId,
    requests: () => requests,
  }
}

/** 远端对 `action=query` 的回答：索引页给夹具内容，其它标题一律 `missing`。 */
function answerGet(
  params: Record<string, unknown>,
  opts: WikiSandboxOptions,
  revision: number,
): Record<string, unknown> {
  if (params.meta === 'siteinfo') {
    return { query: { namespaces: { '3500': { '*': 'Data' } } } }
  }
  const titles = String(params.titles ?? '')
  if (titles === '') return {}
  const pages: Record<string, unknown> = {}
  let id = 1
  for (const title of titles.split('|')) {
    if (title === opts.indexTitle) {
      pages[String(id)] = {
        title,
        revisions: [{ revid: revision, slots: { main: { '*': opts.indexContent } } }],
      }
    } else {
      pages[String(id)] = { title, missing: true }
    }
    id += 1
  }
  return { query: { pages } }
}

/**
 * 打开 **wiki-profile** 的工作台（第二个服务），等 `__vm__` 观测面就绪。
 *
 * 与 `helpers/multiblock/harness#gotoWorkbench` 的差别只有 URL：服务进程的
 * `VITE_SHELL_PROFILE=wiki`（装配结果差异，不是第二条前端入口）。
 *
 * `path` 可指定**真实宿主页**（如 `/index-wiki-workbench.html`）；缺省仍是 Vite 根
 * `index.html`（`#app` 挂载点，现有 spec 的口径）。真实宿主页的挂载点是
 * `#wsr-workbench-app`，且页面里可能有工作台 app **之外**的 DOM（越界判据）。
 */
export async function gotoWikiWorkbench(page: Page, path = ''): Promise<void> {
  page.on('dialog', (d) => {
    void d.accept()
  })
  await page.goto(resolveWikiBaseURL() + path)
  await page.waitForFunction(() => (window as any).__vm_ready__ === true, undefined, { timeout: 90_000 })
  await expect(page.locator('.wb-shell')).toBeVisible({ timeout: 90_000 })
  // 反假绿：wiki-profile 必须真的装上了 wiki.upload（否则本 spec 后面全是空转）
  const hasWiki = await page.evaluate(() => Boolean((window as any).__vm__.hasCapability?.('wiki.upload')))
  expect(hasWiki, 'wiki-profile 服务必须真的具备 wiki.upload 能力（这是本入口的存在理由）').toBe(true)
}
