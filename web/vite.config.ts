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
            // **外壳 profile 实测值**（M8-2）：与客户端 `import.meta.env.VITE_SHELL_PROFILE`
            // 是**同一个**进程环境变量 ⇒ 这一项报告的就是"这个服务真的按哪个 profile 装配"。
            // 有了它，"wiki-profile 的 e2e 入口"才不会被一个仍在跑 workbench 的旧服务冒充
            // （身份核验在 e2e/global-setup.ts 逐服务断言，见 e2e/tree-identity.ts）。
            profile: process.env.VITE_SHELL_PROFILE ?? null,
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
  server: {
    /**
     * 让 dev server 的 watcher **不监视**非应用目录与原子写暂存目录。
     *
     * 存在理由（实测事故，2026-10-11 本单 B6 基线首跑 + 二跑）：在 e2e 运行期间
     * 向 `web/` 写入文件（编辑源码、或写入 `web/tests/**`），vite 的 chokidar watcher
     * 会去 watch 写入过程中的 `<name>.<pid>.<uuid>.tmpdir/<name>.tmp` 暂存条目，
     * 在 Windows 上抛 `EBUSY: resource busy or locked, watch ...` —— 该错误**终止 vite 进程**，
     * 于是同一次 e2e 运行的后半段全部 `net::ERR_CONNECTION_REFUSED` 假红
     * （两次实测都因此各产生 8 条假红、4 条被掩盖的真红）。
     *
     * 哪些目录不监视：
     *  - `tests/`、`test-results/`、`e2e/screenshots/`：不是应用源码，不由 dev server 提供、
     *    不参与 HMR，监视它们只有风险没有收益；
     *  - `**\/*.tmpdir\/**`：**任何**工具的原子写暂存目录（编辑器、DSH 文件工具、其它 agent）。
     *    这条是通用的：谁在跑 e2e 时改了 `web/` 下的文件，都不该让服务崩掉。
     */
    watch: {
      ignored: [
        '**/tests/**',
        '**/test-results/**',
        '**/e2e/screenshots/**',
        '**/*.tmpdir/**',
      ],
    },
  },
})
