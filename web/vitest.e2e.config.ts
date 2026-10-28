import { defineConfig } from 'vitest/config'

/**
 * #438 · e2e **helper 纯函数**的单测配置（零浏览器、零 dev server）。
 *
 * 为什么不塞进 `vitest.config.ts`（产品单测）或 `vitest.architecture.config.ts`：
 * 那两套的用例数都有既定的对账口径（trunk 基线 / 架构边界设施）。e2e helper 的
 * 预算策略是**测试基础设施**，单列一套配置后可以单独跑、数字也可单独复现：
 *
 * ```text
 * npm run test:e2e:unit
 * ```
 */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 10_000,
  },
})
