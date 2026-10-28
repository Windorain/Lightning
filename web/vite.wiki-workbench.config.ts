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

/**
 * Post-build plugin: replace JSZip signature strings that contain C0 control
 * characters with atob() calls.  These control characters would be replaced by
 * U+FFFD when the bundle is uploaded to MediaWiki, corrupting all ZIP output.
 *
 * Each search pattern includes the enclosing double quotes so the replacement
 * can drop them — `atob('…')` is an expression, not a string literal, so it
 * must not be wrapped in quotes.
 */
function fixJszipSignaturesForWiki(): Plugin {
  // Literal-byte forms: esbuild folded all hex escapes to literal bytes.
  // Search:  "PK<0x03><0x04>"  (with outer quotes)
  // Replace: atob('UEsDBA==')  (expression, no quotes)
  const sigMapLiteral: Record<string, string> = {
    '"PK\x03\x04"': `atob('UEsDBA==')`,   // LOCAL_FILE_HEADER
    '"PK\x01\x02"': `atob('UEsBAg==')`,   // CENTRAL_FILE_HEADER
    '"PK\x05\x06"': `atob('UEsFBg==')`,   // CENTRAL_DIRECTORY_END
    '"PK\x06\x06"': `atob('UEsGBg==')`,   // ZIP64_CENTRAL_DIRECTORY_END
  }
  // Mixed forms: esbuild folded some bytes to literal and left others as text
  // escapes (depends on esbuild version / heuristics).
  // Search:  "PK<0x06>\x07"  (literal 0x06, text \x07)
  // Replace: atob('UEsGBw==')
  const sigMapMixed: Record<string, string> = {
    '"PK\x06\\x07"': `atob('UEsGBw==')`,  // ZIP64_CENTRAL_DIRECTORY_LOCATOR
    '"PK\\x07\\b"':  `atob('UEsHCA==')`,  // DATA_DESCRIPTOR (esbuild emits \b not \x08)
  }

  return {
    name: 'fix-jszip-signatures-for-wiki',
    closeBundle() {
      const bundlePath = path.resolve(__dirname, 'dist-wiki-workbench/bundled/StructureWorkbench.bundle.js')
      if (!fs.existsSync(bundlePath)) return
      let content = fs.readFileSync(bundlePath, 'latin1')
      let count = 0
      for (const [sig, replacement] of Object.entries(sigMapLiteral)) {
        const before = content.length
        content = content.split(sig).join(replacement)
        if (content.length !== before) count++
      }
      for (const [sig, replacement] of Object.entries(sigMapMixed)) {
        const before = content.length
        content = content.split(sig).join(replacement)
        if (content.length !== before) count++
      }
      fs.writeFileSync(bundlePath, content, 'latin1')
      console.log('  [fix-jszip-signatures] patched', count, 'JSZip signature(s) for Wiki compat')
    },
  }
}

export default defineConfig({
  plugins: [vue(), fixJszipSignaturesForWiki(), renameIndexHtml()],
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
