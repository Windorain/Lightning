import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function renameIndexHtml(): Plugin {
  return {
    name: 'rename-wiki-index-html',
    closeBundle() {
      const oldPath = path.resolve(__dirname, 'dist-wiki-workbench/index-wiki-workbench.html')
      const newPath = path.resolve(__dirname, 'dist-wiki-workbench/index.html')
      if (fs.existsSync(oldPath)) {
        fs.renameSync(oldPath, newPath)
      }
    },
  }
}

export default defineConfig({
  plugins: [vue(), renameIndexHtml()],
  base: './',
  define: {
    'import.meta.env.VITE_HOST_PROFILE': JSON.stringify('wiki'),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist-wiki-workbench',
    assetsDir: 'bundled',
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'index-wiki-workbench.html'),
      output: {
        entryFileNames: 'bundled/StructureWorkbench.bundle.js',
        chunkFileNames: 'bundled/[name]-[hash].js',
        assetFileNames: 'bundled/StructureWorkbench.[ext]',
      },
    },
  },
})
