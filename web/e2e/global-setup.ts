/**
 * Playwright `globalSetup` —— **服务身份强制核验**（消除「连错树的假绿」）。
 *
 * 判据与实现说明见 `e2e/tree-identity.ts`。这里只负责：读端口上服务的身份 → 断言是本树 →
 * 落一份机器可读凭据到 `web/test-results/tree-identity-<port>.json`。
 *
 * ## 时序依据（已核对 Playwright 1.60 实现）
 *
 * `webServer` 在 Playwright 内部是**插件**（`webServerPluginsForConfig`），它的 `setup()`
 * 在 `plugin setup` 任务里跑；而 `createGlobalSetupTasks()` 的任务顺序是
 * `plugin setup` → `global teardown` → `global setup`。
 * ⇒ 本文件运行时 webServer **必然已就绪**（无论它是本次拉起的，还是被 `reuseExistingServer`
 * 复用的），可以放心对端口发请求。这正是"复用"也能被抓住的原因。
 *
 * ## 覆盖面（诚实说明）
 *
 * 只有**经 Playwright 启动**的运行（`npm run test:e2e` / `test:e2e:tree`）受此强制。
 * 手工直接 `curl` 或绕开 playwright 的脚本不会被拦（它们也不产出 e2e 结论）。
 */

import {
  MAIN_PROFILE_EXPECTATIONS,
  TREE_NONCE_ENV,
  TREE_WEB_ROOT,
  WIKI_PROFILE_EXPECTATIONS,
  assertTreeIdentity,
  readTreeIdentity,
  resolveBaseURL,
  resolvePort,
  resolveWikiBaseURL,
  resolveWikiPort,
  wikiNonceOf,
  writeIdentityEvidence,
} from './tree-identity'
import { excludedSpecs, exclusionBanner, writeExclusionRecord } from './real-artifact-gate'

/**
 * 等待并核验**一个**服务：身份可达 → 是本树 → 是本次运行拉起的 → 是要求的 profile。
 * 返回落盘的凭据路径。
 */
async function verifyService(
  baseURL: string,
  expectedNonce: string | null,
  expectedProfiles: readonly (string | null)[],
  port: number,
): Promise<{ identity: NonNullable<Awaited<ReturnType<typeof readTreeIdentity>>>; evidence: string }> {
  // 重试等待：正常情况下 webServer 已就绪；留一点余量以防 URL 健康检查与插件握手之间的缝隙。
  let identity = null
  for (let attempt = 0; attempt < 10 && identity === null; attempt++) {
    identity = await readTreeIdentity(baseURL, 5_000)
    if (identity === null) await new Promise((r) => setTimeout(r, 500))
  }
  assertTreeIdentity(identity, baseURL, expectedNonce, expectedProfiles)
  return { identity: identity!, evidence: writeIdentityEvidence(baseURL, identity!, expectedNonce, port, expectedProfiles) }
}

export default async function globalSetup(): Promise<void> {
  const port = resolvePort()
  const baseURL = resolveBaseURL(port)
  const expectedNonce = process.env[TREE_NONCE_ENV] ?? null
  const wikiPort = resolveWikiPort(port)
  const wikiBaseURL = resolveWikiBaseURL(wikiPort)

  // 真实产物 spec 的排除记录在**这里**落盘（而不是 config 里）。
  // 时序依据：Playwright 在运行开始时**清空 `test-results/`**，配置加载期写的文件会被删掉 ——
  // 而 globalSetup 在该清理**之后**运行（实测：落在 config 里的记录跑完就找不到了）。
  const excluded = excludedSpecs()
  if (excluded.length > 0) {
    const file = writeExclusionRecord(TREE_WEB_ROOT, excluded)
    console.log(exclusionBanner(excluded))
    console.log(`[e2e 分层] 排除记录已落盘：${file}`)
  } else {
    console.log(exclusionBanner([]))
  }

  const main = await verifyService(baseURL, expectedNonce, MAIN_PROFILE_EXPECTATIONS, port)
  // 直接写 stdout：无论 reporter 如何配置，这行都会出现在原始输出里，便于取证。
  console.log(
    `[e2e 端口隔离] 服务身份核验通过：port=${port} profile=${main.identity.profile ?? '(workbench 缺省)'} ` +
      `served.root=${main.identity.root} served.nonce=${main.identity.nonce ?? '(none)'} pid=${main.identity.pid} → ${main.evidence}`,
  )

  // ── wiki-profile 服务的身份 + **profile** 核验（同一条链，第二个服务）──
  const wiki = await verifyService(wikiBaseURL, wikiNonceOf(expectedNonce), WIKI_PROFILE_EXPECTATIONS, wikiPort)
  console.log(
    `[e2e 端口隔离] wiki-profile 服务核验通过：port=${wikiPort} profile=${wiki.identity.profile} ` +
      `served.root=${wiki.identity.root} pid=${wiki.identity.pid} → ${wiki.evidence}`,
  )
}
