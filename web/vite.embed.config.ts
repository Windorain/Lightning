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
    // 产物文件名与灰机 Wiki 零件页一致：零件:StructureRender.js / StructureRender.css
    lib: {
      entry: fileURLToPath(new URL('./src/main.ts', import.meta.url)),
      name: 'LightningEmbed',
      fileName: 'StructureRender',
      formats: ['iife'],
    },
    rollupOptions: {
      external: ['vue'],
      output: {
        entryFileNames: 'StructureRender.js',
        assetFileNames: 'StructureRender.[ext]',
        globals: {
          vue: 'cockpitVue',
        },
      },
    },
  },
})
