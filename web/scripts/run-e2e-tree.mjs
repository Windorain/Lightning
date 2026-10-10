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
 *   $env:PLAYWRIGHT_PORT=5209        # 本树登记的 test slot（约定见 .workspace/ports.json）
 *   npm run test:e2e:tree -- e2e/edit-arch-50-layout-switch.spec.ts --project=desktop-chrome
 *   ```
 *
 * 缺省路径（不设该变量、仍连 5199）保留在 `npm run test:e2e`，行为与改动前一致。
 *
 * ## 为什么不引 `cross-env`
 *
 * 本脚本只用 Node 内建模块，跨平台、零新依赖。跑完后 playwright 的退出码原样透传。
 *
 * 来源：机制沿用 `integration/edit-arch` 的 PR #243（提交 b4e5649，Gitea #171/#173）。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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
      '      $env:PLAYWRIGHT_PORT=5209      # web-kernel/p00-baseline 登记的 test slot',
      '      npm run test:e2e:tree -- <spec 文件> --project=desktop-chrome',
      '',
      '  slot 约定登记在工作区根的 .workspace/ports.json（本脚本不读它）。',
      '  若确实要跑缺省的 5199（例如复现既有手册），请用 `npm run test:e2e`。',
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

// 走本地 playwright 入口，不经 shell —— 参数（含 spec 路径）原样传递，无引号转义问题。
const cli = path.join(WEB_DIR, 'node_modules', '@playwright', 'test', 'cli.js')
const child = spawn(process.execPath, [cli, 'test', ...process.argv.slice(2)], {
  cwd: WEB_DIR,
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code) => process.exit(code ?? 1))
child.on('error', (err) => {
  console.error(`[e2e 端口隔离] 无法启动 playwright：${err.message}`)
  process.exit(1)
})
