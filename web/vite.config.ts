import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 开发服务器「本树身份」端点（**仅 dev server**，不进构建产物）。
 *
 * `GET /__tree__` → `{ root, nonce, pid }`
 *
 * 存在理由：`web/playwright.config.ts` 的 `webServer.reuseExistingServer: true` 允许
 * 复用**已经占用该端口**的服务 —— 如果不是本树起的，测试就会对着别棵树的产物跑并拿它的
 * 绿当自己的证据（假绿）。服务端只有它自己知道"我是哪棵树"，所以由它给出身份，
 * 由 `web/e2e/global-setup.ts` 在跑用例前断言一致，不一致直接失败。
 *
 * `apply: 'serve'` ⇒ 该插件对 `vite build` 完全惰性，不改变任何产物。
 *
 * 来源：机制沿用 `integration/edit-arch` 的 PR #243（提交 b4e5649，Gitea #171/#173）。
 */
function treeIdentityPlugin(): Plugin {
  return {
    name: 'lightning-tree-identity',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__tree__', (_req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(
          JSON.stringify({
            // vite 的规范化项目根 = 本工作树的 `web/` 绝对路径（每棵树互不相同）
            root: server.config.root,
            // 可选第二因子：由 PLAYWRIGHT_TREE_NONCE → webServer.env → VITE_TREE_NONCE 注入
            nonce: process.env.VITE_TREE_NONCE ?? null,
            pid: process.pid,
          }),
        )
      })
    },
  }
}

export default defineConfig({
  plugins: [vue(), treeIdentityPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
