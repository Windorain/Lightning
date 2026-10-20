/**
 * #87 指定正交机位出图 e2e —— **端口必须 env 驱动**，禁止写死。
 *
 * 与 `playwright.config.ts` 的唯一实质差异（另加 `reuseExistingServer: false`）：
 * 端口从 `LIGHTNING_SHOT_E2E_PORT` 读，slot 取本工作树在 `.workspace/ports.json` 的 `test` 值
 * （`branches/fix/purple-black-family` → 5212）。缺 env 直接抛错，**不回落默认端口**——
 * 回落就是旧口径（写死 5199 + `reuseExistingServer: true`），会让第二棵树连上别人 server 造成假绿
 * （见根 `AGENTS.md`「并行资源」警告）。
 *
 * 运行：
 *   cd web
 *   $env:LIGHTNING_SHOT_E2E_PORT='5212'
 *   npx playwright test shot-ortho --config=playwright.shot.config.ts
 */
import { defineConfig } from '@playwright/test'

const port = Number(process.env.LIGHTNING_SHOT_E2E_PORT)
if (!port) {
  throw new Error(
    'LIGHTNING_SHOT_E2E_PORT 未设置（取本树 .workspace/ports.json 的 test slot，禁止写死端口）',
  )
}

const baseURL = `http://localhost:${port}`

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
    command: `npx vite --port ${port} --strictPort`,
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
