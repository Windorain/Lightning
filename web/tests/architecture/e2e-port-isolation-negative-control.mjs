#!/usr/bin/env node
/**
 * **活体负对照**：证明「连错服务」会被 e2e 端口隔离设施判红，不是只写在文档里的承诺。
 *
 * ## 做法
 *
 * 1. 在 `--port` 上起一个**冒充本树 vite** 的 HTTP 服务：它对 `/__tree__` 返回一个
 *    **别的路径**作为 `root`（默认取系统临时目录下的合成路径），并让 `/` 回 200；
 * 2. 以 `PLAYWRIGHT_PORT=<该端口>` 调用 `playwright test`，跑一条最小 spec；
 * 3. 断言进程**非零退出**，且 stderr/stdout 里出现「连错服务（假绿）」判据文案；
 * 4. 收尾杀掉冒充服务。
 *
 * 若 playwright 反而跑绿了，说明身份核验失效 —— 脚本以退出码 1 报"负对照未被拒绝"。
 *
 * ## 用法
 *
 *   node web/tests/architecture/e2e-port-isolation-negative-control.mjs \
 *     [--port 5209] [--foreign-root <任意不同于本树的 web 根>]
 *
 * ## 为什么不用第二棵真树当冒充者
 *
 * 那需要第二棵树也装好 node_modules（几十秒 + 磁盘），且会真实占用它的端口；
 * 冒充服务能**精确复现**被抓住的那个事实（`root` 指向别处），成本近乎为零、可重复。
 * 默认冒充根因此取临时目录下的合成路径，不依赖任何真实工作树存在。
 */

import { spawn } from 'node:child_process'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

/**
 * 默认冒充者：系统临时目录下的**合成路径**。
 * 只需要是与本树 web 根不同的绝对路径，不要求真实存在。
 */
function defaultForeignRoot() {
  return path.join(os.tmpdir(), 'lightning-e2e-port-isolation', 'foreign-tree', 'web')
}

const PORT = Number(arg('port', '5209'))
const FOREIGN_ROOT = arg('foreign-root', defaultForeignRoot())
const FOREIGN_NONCE = arg('foreign-nonce', 'deadbeefdeadbeef')
/** 冒充服务用的入口页：只要能让 playwright 的 url 健康检查过即可。 */
const HEALTHY_BODY = '<!doctype html><meta charset="utf-8"><title>foreign tree</title>'

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`[负对照] --port 非法：${process.argv.join(' ')}`)
  process.exit(2)
}

const server = http.createServer((req, res) => {
  // 冒充服务实际绑在 127.0.0.1；解析基/日志也用同一族，不写 localhost（它可能解析到另一族）。
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  if (url.pathname === '/__tree__') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ root: FOREIGN_ROOT, nonce: FOREIGN_NONCE, pid: process.pid }))
    return
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(HEALTHY_BODY)
})

function fail(msg) {
  console.error(`\n[负对照] ✗ ${msg}\n`)
  server.close()
  process.exit(1)
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `[负对照] 冒充服务已就位：http://127.0.0.1:${PORT} → root=${FOREIGN_ROOT} nonce=${FOREIGN_NONCE}`,
  )
  console.log('[负对照] 期望：globalSetup 判红（连错服务），playwright 非零退出。')

  const cli = path.join(WEB_DIR, 'node_modules', '@playwright', 'test', 'cli.js')
  // 只用一条最小 spec：应当在 globalSetup 阶段就整体失败，用例根本不会跑。
  const spec = 'e2e/multiblock-fixture-load.spec.ts'
  const child = spawn(
    process.execPath,
    [cli, 'test', spec, '--project=desktop-chrome', '--reporter=list', '--retries=0'],
    {
      cwd: WEB_DIR,
      env: { ...process.env, PLAYWRIGHT_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let out = ''
  child.stdout.on('data', (d) => {
    out += d.toString()
  })
  child.stderr.on('data', (d) => {
    out += d.toString()
  })

  child.on('error', (err) => fail(`无法启动 playwright：${err.message}`))
  child.on('exit', (code) => {
    const rejected = /连错服务（假绿）/.test(out)
    const logFile = path.join(WEB_DIR, 'test-results', `e2e-port-isolation-negative-control-${PORT}.txt`)
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fs.writeFileSync(
      logFile,
      [
        `# e2e 端口隔离 活体负对照`,
        `port=${PORT}`,
        `foreign_root=${FOREIGN_ROOT}`,
        `exit_code=${code}`,
        `判据命中「连错服务（假绿）」=${rejected}`,
        '',
        '── playwright 原始输出 ──',
        out,
      ].join('\n'),
      'utf8',
    )

    if (code === 0) fail(`负对照**未被拒绝**：playwright 退出码 0（设施失效）。日志：${logFile}`)
    if (!rejected) {
      fail(`playwright 确实非零退出（code=${code}），但**失败原因不是身份判据** —— ` +
        `可能被其它错误掩盖，负对照不成立。日志：${logFile}`)
    }
    console.log(
      `[负对照] ✓ 被正确拒绝：exit_code=${code}，判据命中「连错服务（假绿）」。证据：${logFile}`,
    )
    server.close()
    process.exit(0)
  })
})
