/**
 * **性能标定专用 Playwright 配置**（不改 `web/playwright.config.ts`）。
 *
 * ## 为什么单独一份
 *
 * 标定 spec 不是常规回归判据（性能口径：本次任务是**标定**——收数字 + 提建议，
 * 不是把未获批的阈值写成判据），
 * 若放进 `web/e2e/` 会被 `test:e2e` / `:smoke` / `:full` 收进收集面 ⇒ L2/L3 用例数随之变化。
 * 本配置把 `testDir` 指到 `web/tests/perf/e2e/`，于是：
 *
 *  - 常规套件（`web/playwright.config.ts`，`testDir: './e2e'`）**收集面一字不变**；
 *  - 标定走 `--config tests/perf/e2e/playwright.perf.config.ts` 显式运行。
 *
 * ## 端口隔离与身份核验**一条都不省**
 *
 * `webServer`（`PLAYWRIGHT_PORT` 注入 + `--strictPort`）、`globalSetup`
 * （`GET /__tree__` 身份断言 + nonce 比对）与常规配置**同源**：这里 import 的是
 * 本树 `e2e/tree-identity.ts` 的同一批常量与函数，不是复制品。
 * ⇒ 标定同样跑不出"连错树"的假绿。
 */

import crypto from 'node:crypto'
import path from 'node:path'
import { defineConfig } from '@playwright/test'
import {
  TREE_NONCE_ENV,
  TREE_NONCE_INJECTED_ENV,
  resolveBaseURL,
  resolvePort,
  viteDevCommand,
} from '../../../e2e/tree-identity'

const PORT = resolvePort()
const BASE_URL = resolveBaseURL(PORT)

/** 与常规配置同一手法：nonce 钉在环境变量里做**进程级单例**（config 可能被多次加载）。 */
const TREE_NONCE =
  process.env[TREE_NONCE_ENV] ?? (process.env[TREE_NONCE_ENV] = crypto.randomBytes(8).toString('hex'))

const HERE = import.meta.dirname

/**
 * 额外的 Chromium 启动参数（空格分隔）。
 *
 * ## 为什么留这个口子（B2 §2.2 的"GPU 后端必须标注"）
 *
 * 实测本机 Playwright 缺省 headless 走 **SwiftShader 软件渲染**
 * （`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))`）—— B2 §2.2 明文：
 * 软件渲染下「GPU 上传时间 / 绘制数」两项失真，**该次运行的 GPU 类指标作废**。
 * 故这里允许显式传入参数（如 `--use-angle=d3d11 --ignore-gpu-blocklist`）尝试拿到真实 GPU，
 * 并把实测到的后端**原样记账**（拿到什么就报什么，不假定拿到了硬件）。
 */
const EXTRA_ARGS = (process.env.P11C_PERF_CHROME_ARGS ?? '').split(' ').filter((s) => s.length > 0)

export default defineConfig({
  testDir: HERE,
  // 身份核验：跑任何用例之前断言"端口上的服务是本树的"
  globalSetup: path.resolve(HERE, '..', '..', '..', 'e2e', 'global-setup.ts'),
  timeout: 600_000,
  fullyParallel: false,
  // 标定是**测量**：重试会掩盖不稳定，样本里出现离群值应当被看见而不是被重试掉
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'off',
    launchOptions: EXTRA_ARGS.length > 0 ? { args: EXTRA_ARGS } : {},
  },
  webServer: {
    // 与主配置同一族（见 e2e/tree-identity#LOOPBACK_HOST）：不要退回隐式 --host。
    command: viteDevCommand(PORT),
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
    // **必须显式给 cwd**：Playwright 的 webServer 缺省以**配置文件所在目录**为工作目录，
    // 而本配置在 `web/tests/perf/e2e/` ⇒ 缺省会去那个目录找 `vite`/`vite.config.ts`，
    // 于是既起不来服务、身份核验的 `root` 也不会是本树（实测：120 s 超时，退出码 1）。
    cwd: path.resolve(HERE, '..', '..', '..'),
    env: { [TREE_NONCE_INJECTED_ENV]: TREE_NONCE },
  },
  projects: [{ name: 'desktop-chrome', use: { viewport: { width: 1280, height: 800 } } }],
})
