import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

import { loadRootEnv } from './e2e/load-env.mjs'
import { REAL_FIXTURES_DIR_ENV, realFixtureStatus } from './e2e/real-fixtures.mjs'

// 根 .env 必须在配置求值时加载（中间件与产物门控共用唯一夹具根键）。
loadRootEnv()

const WEB_ROOT = fileURLToPath(new URL('.', import.meta.url))
/** 现有公开夹具树（本批仍保留；下一批才会移除其中的 structuredata 件）。 */
const PUBLIC_FIXTURES_DIR = path.join(WEB_ROOT, 'e2e', 'fixtures')
const FIXTURE_URL_PREFIX = '/e2e/fixtures/'
/** 唯一允许从仓外兜底的公开 URL 文件名。 */
const STRUCTUREDATA_FIXTURE_FILE = 'structuredata-exported-envelope.json'
const STRUCTUREDATA_FIXTURE_KEY = 'structureDataExportedEnvelope'

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
            // 可选第二因子：由 PLAYWRIGHT_TREE_NONCE 生成后经 webServer.env 注入为 VITE_TREE_NONCE
            nonce: process.env.VITE_TREE_NONCE ?? null,
            // **外壳 profile 实测值**：与客户端 `import.meta.env.VITE_SHELL_PROFILE`
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


/**
 * **仅 dev server** 的真实夹具**外置兜底**（`/e2e/fixtures/`）。
 *
 * 背景：两个浏览器侧入口（`src/e2e/embed-mobile-main.ts` 与 `e2e/pages/embed-dual.ts`）
 * 用 `fetch('/e2e/fixtures/structuredata-exported-envelope.json')` 取真实信封。
 * 该件已外置到 `<LIGHTNING_REAL_FIXTURES_DIR>/structuredata/`，但公开 URL 保持不变。
 *
 * 顺序与边界（缺一不可）：
 *  1. **先查公开目录** `web/e2e/fixtures/`：存在就 `next()`，现有公开夹具行为一字不改；
 *  2. 只有公开目录里**不存在**、且文件名**正好**是 `structuredata-exported-envelope.json` 时，
 *     才经 `realFixtureStatus()` 查仓外真实件；
 *  3. 仓外也缺 ⇒ 404 JSON，正文含 env 键、期望相对路径、原因与候选，便于定位；
 *  4. **禁止目录穿越 / 任意文件服务**：只接受 `/e2e/fixtures/` 前缀下的普通路径段
 *     （拒绝 `..`、`.`、空段、反斜杠、NUL），公开文件必须解析在公开目录内，
 *     仓外只可能返回这一个固定文件。
 *
 * `apply: 'serve'` ⇒ `vite build` 完全惰性，不改变任何构建产物。
 */
function externalStructuredataFixturePlugin(): Plugin {
  return {
    name: 'lightning-e2e-external-structuredata-fixture',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url
        if (typeof rawUrl !== 'string' || (req.method !== 'GET' && req.method !== 'HEAD')) return next()

        let pathname: string
        try {
          pathname = decodeURIComponent(new URL(rawUrl, 'http://127.0.0.1').pathname)
        } catch {
          return sendJson(res, 400, { error: '非法 URL 编码' })
        }
        if (!pathname.startsWith(FIXTURE_URL_PREFIX)) return next()

        const relative = pathname.slice(FIXTURE_URL_PREFIX.length)
        const segments = relative.split('/')
        if (
          relative === '' ||
          relative.includes('\\') ||
          relative.includes('\0') ||
          segments.some((segment) => segment === '' || segment === '.' || segment === '..')
        ) {
          return sendJson(res, 400, {
            error: '非法夹具路径',
            reason: '只允许 /e2e/fixtures/ 下的普通路径段，禁止目录穿越',
          })
        }

        const publicFile = path.resolve(PUBLIC_FIXTURES_DIR, relative)
        if (!isInside(PUBLIC_FIXTURES_DIR, publicFile)) {
          return sendJson(res, 400, { error: '非法夹具路径', reason: '解析结果落在公开夹具目录之外' })
        }
        if (fs.existsSync(publicFile) && fs.statSync(publicFile).isFile()) return next()

        // 只有这一个已知外置件允许从仓外兜底；其余缺失一律交回 Vite（保持既有 404 行为）。
        if (relative !== STRUCTUREDATA_FIXTURE_FILE) return next()

        const status = realFixtureStatus(STRUCTUREDATA_FIXTURE_KEY)
        if (status.path === null) {
          return sendJson(res, 404, {
            error: '真实夹具不可用',
            envKey: REAL_FIXTURES_DIR_ENV,
            expectedRelativePath: status.expectedRelativePath,
            reason: status.reason,
            candidates: status.candidates,
          })
        }

        try {
          const body = fs.readFileSync(status.path)
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Content-Length', String(body.length))
          res.setHeader('Cache-Control', 'no-store')
          if (req.method === 'HEAD') {
            res.end()
            return
          }
          res.end(body)
        } catch (error) {
          return sendJson(res, 500, {
            error: '读取真实夹具失败',
            envKey: REAL_FIXTURES_DIR_ENV,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      })
    },
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}

function sendJson(
  res: import('node:http').ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  const body = Buffer.from(JSON.stringify(payload) + '\n', 'utf8')
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(body.length))
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

export default defineConfig({
  plugins: [vue(), treeIdentityPlugin(), externalStructuredataFixturePlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    /**
     * 让 dev server 的 watcher **不监视**非应用目录与原子写暂存目录。
     *
     * 存在理由（实测事故）：在 e2e 运行期间向 `web/` 写入文件（编辑源码、或写入 `web/tests/**`），
     * vite 的 chokidar watcher 会去 watch 写入过程中的 `<name>.<pid>.<uuid>.tmpdir/<name>.tmp`
     * 暂存条目，在 Windows 上抛 `EBUSY: resource busy or locked, watch ...` —— 该错误**终止 vite 进程**，
     * 于是同一次 e2e 运行的后半段全部 `net::ERR_CONNECTION_REFUSED` 假红
     * （实测曾因此产生多条假红，并掩盖了真红）。
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