/**
 * Playwright 配置 —— **按树隔离的 e2e 端口 + 服务身份强制核验**。
 *
 * ## 端口从哪来（向后兼容）
 *
 * 端口由环境变量 `PLAYWRIGHT_PORT` 注入，**缺省仍是 5199**：
 * `baseURL` / `webServer.command` / `webServer.url` 三处共用同一个 `PORT` 常量，
 * 杜绝"改了一处漏一处"。不设该变量时行为与改动前完全一致，
 * 既有手册、脚本与其它工作树不受影响。
 *
 *   ```powershell
 *   $env:PLAYWRIGHT_PORT=5209; npm run test:e2e:tree   # 换到本树登记的 slot
 *   npm run test:e2e                                   # 不设 ⇒ 仍是 5199
 *   ```
 *
 * ## 每棵树用自己的 test slot（工作区约定）
 *
 * 多棵工作树并行跑 e2e 时，**每棵树必须登记并使用自己的 slot**，
 * 约定登记在工作区根 `.workspace/ports.json`（`service` 给 dev server、`test` 给 e2e）。
 * 本文件**不读**那个文件 —— 它由工作区调度者维护，e2e 只消费已注入的环境变量。
 * 本树（`web-kernel/p00-baseline`）的 slot：service 5183 / test 5209。
 *
 * ## 为什么还要"服务身份核验"（不只靠人记得换端口）
 *
 * `reuseExistingServer: true` 会把「端口上已经有东西」当成「我的服务已就绪」。
 * 若端口上是**另一棵树**的 vite，本树的测试就对着别人的代码跑，并**把别人的绿当自己的证据**。
 * 所以这里把"跑的是不是本树的服务"变成**机器判据**：
 *  1. 本文件生成本次运行独有的 `TREE_NONCE`，经 `webServer.env` 交给 vite；
 *  2. `vite.config.ts` 暴露 `GET /__tree__` → `{ root, nonce, pid }`（仅 dev server，`apply: 'serve'`）；
 *  3. `e2e/global-setup.ts` 在跑任何用例**之前**拉取该端点，断言 `root` == 本树 `web/`
 *     且 `nonce` == 本次运行的值；不一致 ⇒ 抛错，整次运行失败。
 *
 * 时序依据（Playwright 1.60 实现，已核对）：`webServer` 内部是插件，`plugin setup` 任务
 * 先于 `global setup`（见 `createGlobalSetupTasks()` 的任务顺序），故 globalSetup 运行时
 * 服务必然已就绪 —— **包括被复用的那一个**，这正是"连错树"能被抓住的原因。
 *
 * 完整判据与实现见 `e2e/tree-identity.ts` 与 `e2e/global-setup.ts`。
 *
 * ## 来源
 *
 * 机制沿用 `integration/edit-arch` 的 PR #243（提交 b4e5649，Gitea #171 / #173），
 * 按本树 `dbeb8c8` 基线适配（本树此前无 `globalSetup`、`e2e/tree-identity.ts`、`web/scripts/`）。
 */

import crypto from 'node:crypto'
import { defineConfig, devices } from '@playwright/test'
import {
  SHELL_PROFILE_ENV,
  TREE_NONCE_ENV,
  TREE_NONCE_INJECTED_ENV,
  resolveBaseURL,
  resolvePort,
  resolveWikiBaseURL,
  resolveWikiPort,
  wikiNonceOf,
} from './e2e/tree-identity'
import { testIgnoreGlobs } from './e2e/real-artifact-gate'

// ── 端口（唯一真源）──
const PORT = resolvePort()
const BASE_URL = resolveBaseURL(PORT)
// ── M8-2：第二个服务 = **wiki-profile** 入口（同树、同一次运行、同一条身份核验链）──
// 为什么要两个服务而不是一个可切换的：S1 的三条生产保存路径分属两个 profile
// （「保存到文件」只在 workbench 菜单、「保存到 Wiki」只在 wiki 菜单），一条 spec
// 要同时判两族就必须两个服务并存；否则只能"跳过"，而静默跳过是明令禁止的假绿。
const WIKI_PORT = resolveWikiPort(PORT)
const WIKI_BASE_URL = resolveWikiBaseURL(WIKI_PORT)

/**
 * #332 · **真实产物 spec 的产物门控排除**（详见 `e2e/real-artifact-gate.ts`）。
 *
 * 干净检出上没有游戏内导出的真实产物，其中两份 spec 会在 **import 期**抛错 ⇒
 * Playwright 把整次 collection 判失败（实测 8.3s 结束、`expected: 0`、一个用例都没跑）。
 * 这里按**产物是否就绪**排除：缺 ⇒ `testIgnore` 掉（横幅与
 * `test-results/e2e-exclusions.json` 由 `e2e/global-setup.ts` 落一次）；
 * 就绪 ⇒ `testIgnore` 为空，这些 spec 自动纳入并必须通过（**没有静默跳过**）。
 *
 * 注：**不在这里**打印横幅/落盘 —— 本文件会在每个 worker 进程里重新加载，且 config 加载期
 * 写的文件会被 Playwright 启动时清空 `test-results/` 删掉（两条都实测踩过）。
 */
const TEST_IGNORE = testIgnoreGlobs()

/**
 * 验收流水线的 replay spec **不进普通 e2e 套件**。
 *
 * 它的输入（`ACCEPT_PLAN`/`ACCEPT_DOC`/`ACCEPT_OUT`）由 `e2e/accept/runner/run-accept.mjs`
 * 注入；缺了就在 spec 顶部抛（`replay.spec.ts:22`，那是**故意的**：没被驱动就跑等于假绿）。
 * 但若把它留在 `test:e2e:tree` / `:smoke` / `:full` 的收集范围里，那一条抛错会把
 * "本次没跑验收"报成"PR 回归红"—— 红绿语义就错了。
 *
 * ⇒ 隔离成**独立配置** `web/playwright.accept.config.ts`（复用本文件的 webServer/globalSetup/
 * 端口与身份链，只把 testDir 收到 `e2e/accept`）；本文件把请求方显式忽略。
 * runner 用 `--config=playwright.accept.config.ts` 调起。
 * 产物门控的 4 份 spec 仍按 `TEST_IGNORE` 在两边各自生效（同一个函数、同一份判据）。
 */
const ACCEPT_SPEC_GLOB = '**/accept/**/*.spec.ts'

/** #87 出图器具（见下条注释）——**不**在普通 e2e 套件里收集。 */
const SHOT_SPEC_GLOB = '**/shot-ortho.spec.ts'

/**
 * **#87 指定机位出图器具**同样不进普通套件。
 *
 * 它的全部输入（`LIGHTNING_SHOT_E2E_PORT` / `MB_SHOT_PRODUCT` / `MB_SHOT_CAMERAS` /
 * `MB_SHOT_CENTER` / `MB_SHOT_DIR`）由调用方注入，缺任一条就在 **import 期**抛错
 * （`shot-ortho.spec.ts` 顶部，那是故意的：没被驱动就跑等于假绿）。它有自己的
 * `playwright.shot.config.ts`（独立端口，`reuseExistingServer: false`），
 * 若留在 `:tree/:smoke/:full` 的收集范围里，一次没给 env 的普通回归就会被
 * 报成"PR 回归红"——与 accept replay 同一口径。
 */

/**
 * 验收 runner 的 `*.test.mjs` 是 **node:test** 单测（`node --test e2e/accept/runner/…`），
 * 不是 Playwright 用例。但 Playwright 的缺省 `testMatch` 也收 `*.test.*` ⇒ 它们会在
 * **collection 期被 import**，于是 node:test 当场执行并往日志里打 `✔ …`（L3 实测出现）。
 * 那些文件本身产出 0 条 Playwright 用例，所以计数不差，却让"跑 e2e"里混进了另一套测试的输出，
 * 且其中一条断言若失败会把 collection 打成红。⇒ 两个配置都显式排掉。
 */
const NODE_TEST_GLOB = '**/*.test.mjs'

/**
 * 本次运行的服务身份标记（随机 nonce）。
 *
 * 用 `process.env` 做**进程级单例**：配置文件可能在同一进程里被加载多次，而模块级随机数
 * 每次加载都会重算 —— 但 `webServer.env` 注入的是**第一次**加载的值，于是 globalSetup
 * 会拿后生成的值去比对注入的值，必然误报"nonce 不匹配"。钉在环境变量里，多次加载同值。
 */
const TREE_NONCE =
  process.env[TREE_NONCE_ENV] ?? (process.env[TREE_NONCE_ENV] = crypto.randomBytes(8).toString('hex'))

export default defineConfig({
  testDir: './e2e',
  // #332：真实产物未就绪的 spec 按产物门控排除（产物就绪时为空数组 ⇒ 全部纳入）
  // 另加：验收 replay spec 与 #87 出图器具都不在普通套件里收集（见 ACCEPT_SPEC_GLOB / SHOT_SPEC_GLOB）
  testIgnore: [...TEST_IGNORE, ACCEPT_SPEC_GLOB, NODE_TEST_GLOB, SHOT_SPEC_GLOB],
  // 服务身份核验：在任何用例之前断言"端口上的服务是本树的"
  globalSetup: './e2e/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 25_000 },
  fullyParallel: false,
  retries: 1,
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: `npx vite --port ${PORT} --strictPort`,
      url: BASE_URL,
      reuseExistingServer: true,
      timeout: 120_000,
      // 本树身份标记交给 vite 进程；`vite.config.ts` 的 /__tree__ 端点把它回给 globalSetup。
      // `VITE_SHELL_PROFILE` 同时是**客户端**的装配输入（`composition/shell#resolveShellProfile`
      // 的唯一构建期输入）⇒ 显式写死，别让"这台服务到底装的是哪个外壳"靠缺省值猜。
      env: {
        [TREE_NONCE_INJECTED_ENV]: TREE_NONCE,
        [SHELL_PROFILE_ENV]: 'workbench',
      },
    },
    {
      // wiki-profile 入口：**同一条** vite 配置（同一份树身份插件、同一份插件链），
      // 只把外壳 profile 换成 wiki。于是它天然继承端口隔离 + /__tree__ 身份核验，
      // 不是另起一套入口。
      command: `npx vite --port ${WIKI_PORT} --strictPort`,
      url: WIKI_BASE_URL,
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        [TREE_NONCE_INJECTED_ENV]: wikiNonceOf(TREE_NONCE)!,
        [SHELL_PROFILE_ENV]: 'wiki',
      },
    },
  ],
  projects: [
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'desktop-chrome',
      use: { viewport: { width: 1280, height: 800 } },
    },
  ],
})
