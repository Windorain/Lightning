import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
  },
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
})
