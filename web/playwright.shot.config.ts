/**
 * 指定正交机位出图 e2e —— **端口必须由环境变量注入**，禁止写死。
 *
 * 与 `playwright.config.ts` 的实质差异：端口从 `LIGHTNING_SHOT_E2E_PORT` 读取，
 * 且 `reuseExistingServer: false`。缺 env 直接抛错，**不回落默认端口**——
 * 回落会让另一棵树连上别人已占用的 server，把别人的绿当成自己的证据（假绿）。
 *
 * 端口由调用方为每次运行分配独占值；本文件不预设具体端口。
 *
 * 运行（示例端口 5333）：
 *   cd web
 *   $env:LIGHTNING_SHOT_E2E_PORT='5333'
 *   npx playwright test shot-ortho --config=playwright.shot.config.ts
 */
import { defineConfig } from '@playwright/test'

import { resolveBaseURL, viteDevCommand } from './e2e/tree-identity'

const port = Number(process.env.LIGHTNING_SHOT_E2E_PORT)
if (!port) {
  throw new Error(
    'LIGHTNING_SHOT_E2E_PORT 未设置（取本次运行分配的独占端口，禁止写死端口）',
  )
}

// 与主配置复用**同一个** URL 构造函数：地址逻辑只有一处，不在本文件手拼。
const baseURL = resolveBaseURL(port)

export default defineConfig({
  testDir: './e2e',
  /**
   * 6 台机位 = **6 次独立捕获**（合入内核重建后每台都走一次完整捕获/作业：
   * 编译场景 + 解码全部纹理 + 离屏渲染 + 读回编码）。单台实测数秒到十几秒，
   * 180s 对真产品（几十张纹理）不够 ⇒ 放到 10 分钟。这是**器具**配置，不是产品超时政策。
   */
  timeout: 600_000,
  expect: { timeout: 25_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  webServer: {
    command: viteDevCommand(port),
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'desktop-chrome',
      use: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
    },
  ],
})
