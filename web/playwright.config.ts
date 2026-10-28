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
 *   $env:PLAYWRIGHT_PORT=5333; npm run test:e2e:tree   # 换到本次运行分配的独占端口
 *   npm run test:e2e                                   # 不设 ⇒ 仍是 5199
 *   ```
 *
 * ## 每棵树用自己的 test slot（工作区约定）
 *
 * 多棵树并行跑 e2e 时，**每棵树必须使用自己独占的端口**；端口由外部调度分配并
 * 通过环境变量注入。本文件**不读任何登记表** —— e2e 只消费已注入的环境变量。
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
 * ## Loopback 只有一族：`127.0.0.1`
 *
 * `localhost` 在本机同时解析到 `::1` 与 `127.0.0.1`，而 dev server 缺省只监听其中一族
 * （实测：不写 `--host` 时 Vite 只监听 `[::1]`，IPv4 拒绝）。若"服务听哪族"与
 * "`baseURL`/健康检查连哪族"各自被解析顺序决定，就会出现"端口上有服务但客户端收到
 * `ECONNREFUSED`"的假红，且失败现场指向的是网络症状而不是配置歧义。
 *
 * 因此 e2e 入口**不依赖解析顺序**：`LOOPBACK_HOST` 是唯一地址真源，
 * `BASE_URL`/`WIKI_BASE_URL` 由它生成，两个 `webServer` 命令也由
 * `viteDevCommand()` 显式带上 `--host 127.0.0.1 --port … --strictPort`。
 * 监听、健康检查、身份核验、浏览器导航因此落在同一族上。
 * `--strictPort` 只保证**同一地址族内**的端口冲突会失败 —— `::1` 与 `127.0.0.1` 可以同时
 * 占用同一个端口号；跨族/跨树的错连由 `/__tree__` 的 root + nonce + profile 核验兜底。
 */

// 根 .env 必须在**任何 gate 求值之前**加载（产物门控的 ready() 会读 LIGHTNING_REAL_FIXTURES_DIR）：
// ES 模块按 import 声明顺序求值，故本行必须排在 real-artifact-gate 之前。
import './e2e/load-env.mjs'
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
  viteDevCommand,
  wikiNonceOf,
} from './e2e/tree-identity'
import { testIgnoreGlobs } from './e2e/real-artifact-gate'

// ── 端口（唯一真源）──
const PORT = resolvePort()
const BASE_URL = resolveBaseURL(PORT)
// ── 第二个服务 = **wiki-profile** 入口（同树、同一次运行、同一条身份核验链）──
// 为什么要两个服务而不是一个可切换的：生产保存路径分属两个 profile
// （「保存到文件」只在 workbench 菜单、「保存到 Wiki」只在 wiki 菜单），一条 spec
// 要同时判两族就必须两个服务并存；否则只能"跳过"，而静默跳过是明令禁止的假绿。
const WIKI_PORT = resolveWikiPort(PORT)
const WIKI_BASE_URL = resolveWikiBaseURL(WIKI_PORT)

/**
 * 真实夹具根（唯一键）**显式**传给两个 vite 子进程。
 *
 * 为什么不能只靠继承：`webServer` 的 env 是 Playwright 交给子进程的**白名单式**环境
 * （实现上以传入的 env 为基底，而不是自动透传父进程全部变量）。不显式传，
 * 子进程里的 `/e2e/fixtures/` 中间件就读不到 `LIGHTNING_REAL_FIXTURES_DIR`，
 * 于是「浏览器能取到外置真实件」这件事会随启动方式不同而时灵时不灵。
 *
 * 空串 = 未配置（`real-fixtures.mjs` 的 `envDirOf()` 按 trim 后为空处理），
 * 让缺省值也走同一条显式路径，而不是靠"变量不存在"的隐式分支。
 */
const REAL_FIXTURES_DIR = process.env.LIGHTNING_REAL_FIXTURES_DIR ?? ''

/**
 * **真实产物 spec 的产物门控排除**（详见 `e2e/real-artifact-gate.ts`）。
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
 * "本次没跑验收"报成"回归判红"—— 红绿语义就错了。
 *
 * ⇒ 隔离成**独立配置** `web/playwright.accept.config.ts`（复用本文件的 webServer/globalSetup/
 * 端口与身份链，只把 testDir 收到 `e2e/accept`）；本文件把请求方显式忽略。
 * runner 用 `--config=playwright.accept.config.ts` 调起。
 * 产物门控的 4 份 spec 仍按 `TEST_IGNORE` 在两边各自生效（同一个函数、同一份判据）。
 */
const ACCEPT_SPEC_GLOB = '**/accept/**/*.spec.ts'

/** 指定机位出图器具（见下条注释）——**不**在普通 e2e 套件里收集。 */
const SHOT_SPEC_GLOB = '**/shot-ortho.spec.ts'

/**
 * **指定机位出图器具**同样不进普通套件。
 *
 * 它的全部输入（`LIGHTNING_SHOT_E2E_PORT` / `MB_SHOT_PRODUCT` / `MB_SHOT_CAMERAS` /
 * `MB_SHOT_CENTER` / `MB_SHOT_DIR`）由调用方注入，缺任一条就在 **import 期**抛错
 * （`shot-ortho.spec.ts` 顶部，那是故意的：没被驱动就跑等于假绿）。它有自己的
 * `playwright.shot.config.ts`（独立端口，`reuseExistingServer: false`），
 * 若留在 `:tree/:smoke/:full` 的收集范围里，一次没给 env 的普通回归就会被
 * 报成"回归判红"——与 accept replay 同一口径。
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
 * **真实 test deadline 的进程侧证据**（`e2e/real-deadline.deadline.ts`）。
 *
 * 这些用例会被 test deadline **故意打断**（首败是 Test timeout），放进普通套件就会污染
 * 绿灯；`test.fail()` 又不接受 `timedOut`（实测仍报 failed）。故默认 `testIgnore` 排除，
 * 只有证据 runner 设置 `REAL_DEADLINE_E2E=1` 时才用 `testMatch` 收进来 ——
 * **仍然走同一份 config / webServer / globalSetup / __tree__ nonce/root 身份门禁**，
 * 不另起裸 Playwright 入口（复核要求）。
 */
const DEADLINE_SPEC_GLOB = '**/*.deadline.ts'
const REAL_DEADLINE_E2E = process.env.REAL_DEADLINE_E2E === '1'

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
  // 真实产物未就绪的 spec 按产物门控排除（产物就绪时为空数组 ⇒ 全部纳入）
  // 另加：验收 replay spec 与出图器具都不在普通套件里收集（见 ACCEPT_SPEC_GLOB / SHOT_SPEC_GLOB）
  testMatch: REAL_DEADLINE_E2E ? DEADLINE_SPEC_GLOB : undefined,
  testIgnore: [
    ...TEST_IGNORE,
    ACCEPT_SPEC_GLOB,
    NODE_TEST_GLOB,
    SHOT_SPEC_GLOB,
    // 默认不收 deadline 证据；证据 runner 用 REAL_DEADLINE_E2E=1 打开（同一份 config）。
    ...(REAL_DEADLINE_E2E ? [] : [DEADLINE_SPEC_GLOB]),
  ],
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
      // host/端口由同一函数生成：监听族必须与 BASE_URL 的族一致（见文件头「Loopback」一节）。
      command: viteDevCommand(PORT),
      url: BASE_URL,
      reuseExistingServer: true,
      timeout: 120_000,
      // 本树身份标记交给 vite 进程；`vite.config.ts` 的 /__tree__ 端点把它回给 globalSetup。
      // `VITE_SHELL_PROFILE` 同时是**客户端**的装配输入（`composition/shell#resolveShellProfile`
      // 的唯一构建期输入）⇒ 显式写死，别让"这台服务到底装的是哪个外壳"靠缺省值猜。
      env: {
        [TREE_NONCE_INJECTED_ENV]: TREE_NONCE,
        [SHELL_PROFILE_ENV]: 'workbench',
        LIGHTNING_REAL_FIXTURES_DIR: REAL_FIXTURES_DIR,
      },
    },
    {
      // wiki-profile 入口：**同一条** vite 配置（同一份树身份插件、同一份插件链），
      // 只把外壳 profile 换成 wiki。于是它天然继承端口隔离 + /__tree__ 身份核验，
      // 不是另起一套入口。
      command: viteDevCommand(WIKI_PORT),
      url: WIKI_BASE_URL,
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        [TREE_NONCE_INJECTED_ENV]: wikiNonceOf(TREE_NONCE)!,
        [SHELL_PROFILE_ENV]: 'wiki',
        LIGHTNING_REAL_FIXTURES_DIR: REAL_FIXTURES_DIR,
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
