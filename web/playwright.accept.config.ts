/**
 * 验收流水线（`e2e/accept`）**专用** Playwright 配置。
 *
 * ## 为什么不能和普通 e2e 共用一份配置
 *
 * 验收 replay spec 的输入（`ACCEPT_PLAN`/`ACCEPT_DOC`/`ACCEPT_OUT`）由
 * `e2e/accept/runner/run-accept.mjs` 注入，缺了就在 spec 顶部抛（`replay.spec.ts:22`，
 * 故意的：没被驱动就跑等于假绿）。它若留在 `test:e2e:tree|smoke|full` 的收集范围里，
 * 那一条抛错会把"本次没跑验收"报成"PR 回归红" —— 红绿语义就错了。
 *
 * ⇒ 本配置只做三件事：**复用** `playwright.config.ts` 的全部服务/身份/端口设施
 * （`webServer` ×2、`globalSetup`、`baseURL`、`TREE_NONCE` 注入），把 `testDir`
 * 收到 `e2e/accept`，并把普通配置里的那条忽略规则清掉。于是：
 *
 * | 入口 | 收什么 |
 * |---|---|
 * | `test:e2e:tree|smoke|full`（`playwright.config.ts`） | 普通套件；**不含** `e2e/accept/**` |
 * | `runner/run-accept.mjs`（本文件） | **只**含 `e2e/accept/**` |
 *
 * 端口隔离与树身份核验不因换配置而旁路：两者都在被复用的 `webServer.env` 与
 * `globalSetup` 里，与普通套件**同一份**实现。
 */
import { defineConfig } from '@playwright/test'

import base from './playwright.config'

export default defineConfig({
  ...base,
  testDir: './e2e/accept',
  // 覆盖普通配置里"忽略 e2e/accept"的那条；产物门控的 4 份 spec 不在此 testDir 下，天然不收集
  testIgnore: [],
  projects: [
    {
      name: 'accept-replay',
      // 画布尺寸由 spec 自己迭代到 plan.resolution，这里只给一个不撑爆窗口的起点
      use: { viewport: { width: 1600, height: 1000 } },
    },
  ],
})
