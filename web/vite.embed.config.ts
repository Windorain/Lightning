import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL('./src/main.ts', import.meta.url)),
      name: 'LightningEmbed',
      fileName: 'lightning-embed',
      formats: ['iife'],
    },
    rollupOptions: {
      external: ['vue'],
      output: {
        entryFileNames: 'lightning-embed.js',
        globals: {
          vue: 'lightningVue',
        },
      },
    },
  },
})
