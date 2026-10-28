#!/usr/bin/env node
/**
 * 按树运行 e2e —— `npm run test:e2e:tree`
 *
 * ## 为什么不是一条 `playwright test` 别名
 *
 * 别名和 `npm run test:e2e` 完全等价，等于没有强制：谁忘了设端口，它就静默跑 5199，
 * 两棵树又撞在一起。**本包装的作用是把"每棵树用自己的 slot"变成入口处的硬性判据**：
 * 没设 `PLAYWRIGHT_PORT` 就不启动，并打印该怎么设。
 *
 * ## 用法（PowerShell）
 *
 *   ```powershell
 *   $env:PLAYWRIGHT_PORT=<本树分配的 test 端口>
 *   npm run test:e2e:tree -- e2e/edit-arch-50-layout-switch.spec.ts --project=desktop-chrome
 *   ```
 *
 * 缺省路径（不设该变量、用 config 的缺省端口）保留在 `npm run test:e2e`。
 *
 * ## 为什么不引 `cross-env`
 *
 * 本脚本只用 Node 内建模块，跨平台、零新依赖。跑完后 playwright 的退出码原样透传。
 *
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 根 .env 必须在**启动 playwright 之前**加载：产物门控的 ready() 与
// /e2e/fixtures/ 中间件都依赖 LIGHTNING_REAL_FIXTURES_DIR。playwright.config 里
// 也会加载一次（幂等），但这里是子进程环境的第一道入口，缺了它就会把
// "本机已配置" 误判成 "干净检出"。
import { loadRootEnv } from '../e2e/load-env.mjs'

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rootEnv = loadRootEnv()
if (rootEnv.reason === 'loaded') {
  console.log(`[真实夹具] 已加载仓库根 .env：${rootEnv.path}`)
}
const raw = process.env.PLAYWRIGHT_PORT

if (raw === undefined || raw.trim() === '') {
  console.error(
    [
      '',
      '[e2e 端口隔离] `test:e2e:tree` 需要显式指定本树的 test slot —— 未设置 PLAYWRIGHT_PORT，已中止。',
      '',
      '  多棵工作树并行跑 e2e 时，若共用端口，后起的一棵会复用先起那棵的 vite，',
      '  结果就是「拿别人的绿当自己的证据」。每棵树必须用自己的 slot：',
      '',
      '      $env:PLAYWRIGHT_PORT=<本树分配的 test 端口>',
      '      npm run test:e2e:tree -- <spec 文件> --project=desktop-chrome',
      '',
      '  端口由工作区调度分配；本脚本不读任何端口清单。',
      '  若确实要跑 config 的缺省端口，请用 `npm run test:e2e`。',
      '',
    ].join('\n'),
  )
  process.exit(2)
}

const port = Number(raw)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[e2e 端口隔离] PLAYWRIGHT_PORT 非法：${JSON.stringify(raw)}（应为 1..65535 的整数）`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// wiki-profile 入口的端口（**同一次运行、同一条身份核验链**）
// ---------------------------------------------------------------------------
// 主槽给 workbench profile；wiki-profile 服务用相邻槽（缺省 +1，可用
// PLAYWRIGHT_WIKI_PORT 覆盖）。两者都被 e2e/global-setup.ts 用
// root + nonce + profile 三项核验 ⇒ 这里只负责把"本次运行占了哪两个端口"打出来，
// 让日志本身能证明"没有悄悄只跑了一个 profile"。
const wikiRaw = process.env.PLAYWRIGHT_WIKI_PORT
const wikiPort =
  wikiRaw === undefined || wikiRaw.trim() === '' ? port + 1 : Number(wikiRaw)
if (!Number.isInteger(wikiPort) || wikiPort < 1 || wikiPort > 65535 || wikiPort === port) {
  console.error(
    `[e2e 端口隔离] wiki-profile 端口非法：${JSON.stringify(wikiPort)}（应为 1..65535 且与主槽不同）`,
  )
  process.exit(2)
}
console.log(
  `[e2e 端口隔离] 本次运行两个服务：workbench=${port}（主槽） / wiki=${wikiPort}（wiki-profile 入口）`,
)

// ---------------------------------------------------------------------------
// 时间预算（本包装自己的参数；其余原样透传给 playwright）
// ---------------------------------------------------------------------------
//   --budget-ms <毫秒>   本次运行的墙钟预算
//   --budget-soft        超预算只告警、不改变退出码（L3 full 用；避免负载抖动误伤）
//   --budget-label <名>  预算线名称（日志/登记用，例如 "L2 e2e smoke"）
// 缺省（不给 --budget-ms）= 与改动前完全一致，只多打印一行实测墙钟。
const argv = process.argv.slice(2)
let budgetMs = null
let budgetSoft = false
let budgetLabel = 'e2e'
const forwarded = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--budget-ms') {
    budgetMs = Number(argv[++i])
    continue
  }
  if (a === '--budget-soft') {
    budgetSoft = true
    continue
  }
  if (a === '--budget-label') {
    budgetLabel = String(argv[++i])
    continue
  }
  forwarded.push(a)
}
if (budgetMs !== null && (!Number.isFinite(budgetMs) || budgetMs <= 0)) {
  console.error(`[时间预算] --budget-ms 非法：${JSON.stringify(budgetMs)}（应为正毫秒数）`)
  process.exit(2)
}

const fmtMs = (ms) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(2)} min` : `${(ms / 1000).toFixed(1)} s`)

// 走本地 playwright 入口，不经 shell —— 参数（含 spec 路径）原样传递，无引号转义问题。
const cli = path.join(WEB_DIR, 'node_modules', '@playwright', 'test', 'cli.js')
const startedAt = Date.now()
const child = spawn(process.execPath, [cli, 'test', ...forwarded], {
  cwd: WEB_DIR,
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code) => {
  const elapsed = Date.now() - startedAt
  console.log(`[时间预算] ${budgetLabel} 实测墙钟 ${fmtMs(elapsed)}（${elapsed} ms）`)
  if (budgetMs !== null && elapsed > budgetMs) {
    const detail =
      `[时间预算] ${budgetLabel} **超预算**：实测 ${fmtMs(elapsed)} > 预算 ${fmtMs(budgetMs)}` +
      `（×${(elapsed / budgetMs).toFixed(2)}）`
    if (budgetSoft) {
      console.error(`${detail} —— 软预算：只告警，不改变退出码。`)
    } else {
      console.error(`${detail} —— **硬预算：判红**。`)
      process.exit(code === 0 || code === undefined ? 3 : code)
    }
  }
  process.exit(code ?? 1)
})
child.on('error', (err) => {
  console.error(`[e2e 端口隔离] 无法启动 playwright：${err.message}`)
  process.exit(1)
})
