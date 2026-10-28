import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function renameIndexHtml(): Plugin {
  return {
    name: 'rename-index-html',
    closeBundle() {
      const oldPath = path.resolve(__dirname, 'dist-workbench/index-workbench.html')
      const newPath = path.resolve(__dirname, 'dist-workbench/index.html')
      if (fs.existsSync(oldPath)) {
        fs.renameSync(oldPath, newPath)
      }
    },
  }
}

export default defineConfig({
  plugins: [vue(), renameIndexHtml()],
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist-workbench',
    assetsDir: 'bundled',
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'index-workbench.html'),
    },
  },
})
