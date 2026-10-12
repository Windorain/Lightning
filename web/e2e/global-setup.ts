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
  TREE_NONCE_ENV,
  TREE_WEB_ROOT,
  assertTreeIdentity,
  readTreeIdentity,
  resolveBaseURL,
  resolvePort,
  writeIdentityEvidence,
} from './tree-identity'
import { excludedSpecs, exclusionBanner, writeExclusionRecord } from './real-artifact-gate'

export default async function globalSetup(): Promise<void> {
  const port = resolvePort()
  const baseURL = resolveBaseURL(port)
  const expectedNonce = process.env[TREE_NONCE_ENV] ?? null

  // #332：真实产物 spec 的排除记录在**这里**落盘（而不是 config 里）。
  // 时序依据：Playwright 在运行开始时**清空 `test-results/`**，配置加载期写的文件会被删掉 ——
  // 而 globalSetup 在该清理**之后**运行（实测：落在 config 里的记录跑完就找不到了）。
  const excluded = excludedSpecs()
  if (excluded.length > 0) {
    const file = writeExclusionRecord(TREE_WEB_ROOT, excluded)
    console.log(exclusionBanner(excluded))
    console.log(`[#332 e2e 分层] 排除记录已落盘：${file}`)
  } else {
    console.log(exclusionBanner([]))
  }

  // 重试等待：正常情况下 webServer 已就绪；留一点余量以防 URL 健康检查与插件握手之间的缝隙。
  let identity = null
  for (let attempt = 0; attempt < 10 && identity === null; attempt++) {
    identity = await readTreeIdentity(baseURL, 5_000)
    if (identity === null) await new Promise((r) => setTimeout(r, 500))
  }

  assertTreeIdentity(identity, baseURL, expectedNonce)

  const evidence = writeIdentityEvidence(baseURL, identity!, expectedNonce, port)
  // 直接写 stdout：无论 reporter 如何配置，这行都会出现在原始输出里，便于取证。
  console.log(
    `[e2e 端口隔离] 服务身份核验通过：port=${port} served.root=${identity!.root} ` +
      `served.nonce=${identity!.nonce ?? '(none)'} pid=${identity!.pid} → ${evidence}`,
  )
}
