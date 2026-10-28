// 真实夹具试点：在任何测试收集前加载仓库根 .env（缺文件则无副作用）。
import './e2e/load-env.mjs'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  test: {
    include: ['src/**/*.test.ts', 'tests/system/**/*.test.ts'],
    // 真实夹具门控证据：缺 GG 时写 test-results/real-fixture-exclusions.json 并打横幅；
    // 不整文件 exclude（消费方只 skip 依赖真实件的 3 条判据）。
    globalSetup: ['./e2e/real-fixture-global-setup.mjs'],
    testTimeout: 30000,
  },
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
})
