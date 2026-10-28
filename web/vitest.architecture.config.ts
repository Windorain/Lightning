import { defineConfig } from 'vitest/config'

/**
 * 架构测试的独立 vitest 配置 —— `npm run test:arch`。
 *
 * ## 为什么与 `vitest.config.ts` 分开
 *
 * `web/vitest.config.ts` 的 `include` 是 `src/**\/*.test.ts`，服务**产品单测**。
 * 把 `web/tests/` 挂进同一个配置，会让 `npm test` 的用例总数随架构设施变动 ——
 * 于是 trunk 基线（通过/失败/跳过数字）与新增的架构设施再也无法逐项对账。
 *
 * 分两个配置后：
 *  - `npm test`        = 产品单测（trunk 基线，**不改动**其覆盖面）
 *  - `npm run test:arch` = 架构边界设施
 * 两者各自可复现，各自出数字。
 *
 * `web/tests/` 不在 `tsconfig.json` 的 `include` 内（它只含 `src/**`），
 * 故本配置**不做类型检查**，只跑运行时断言；设施自身是 `.mjs` + `.ts` 混合，
 * 由 vitest 的 esbuild 转译。
 */
export default defineConfig({
  test: {
    include: ['tests/architecture/**/*.test.ts'],
    testTimeout: 60_000,
    // 设施会读取本树源码并解析 AST，串行更稳定、输出也可复现
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    },
  },
})
