#!/usr/bin/env node
/**
 * 真实 test deadline 的**逐 case 证据棘轮**（进程侧）。
 *
 * 为什么不是普通用例：这些用例必须被 test deadline 打断（首败是 `Test timeout`），
 * 放进默认套件会污染绿灯；`test.fail()` 也不接受 `timedOut`（实测）。
 *
 * ## 入口与身份门禁
 *
 * 本脚本**不直接调 Playwright**，而是：
 *  1. 设置 `REAL_DEADLINE_E2E=1`（主 `playwright.config.ts` 据此把 testMatch 收到
 *     `*.deadline.ts`；默认它被 testIgnore 排除）；
 *  2. spawn **现有的** `scripts/run-e2e-tree.mjs`（`npm run test:e2e:tree` 的同一入口），
 *     因此 webServer / globalSetup / `__tree__` nonce+root 身份核验全部原样生效；
 *  3. 断言输出里出现 workbench 与 wiki 两个端口的 `服务身份核验通过`。
 *
 * ## 逐 case 判据
 *
 * spec 每条用例在 stderr 第一行写 `[deadline-case] caseN <title>`；
 * `validateDeadlineEvidence` 按 marker 分块（禁止跨 block/全局匹配），要求每块
 * **恰好 1 条** `[boot-probe:close]`，块内自己的 budget/nav/attribution 顺序为
 * close → budget → nav → attribution；case1 绑 WorkbenchRoot/ERR_FAILED，case2 绑
 * document/ERR_ABORTED + starts=1 commits=0 failures=1；budget 必须带
 * `basis=anchor-estimate` / `remaining-estimate=` / `actual-remaining=unknown`。
 * 合成反例（缺 attribution 由别 case 补 / 重复 close / 缺 case / 顺序错 / close 晚于
 * budget）每次运行都会先自测，任何一个被误判为通过即 FAIL。
 *
 * 用法：`$env:PLAYWRIGHT_PORT=<本树分配的 test 端口>; npm run test:e2e:deadline`
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { REAL_DEADLINE_CASES, syntheticValidatorSelfTest, validateDeadlineEvidence } = await import(
  pathToFileURL(path.join(WEB_DIR, 'e2e', 'helpers', 'realDeadlineEvidence.mjs')).href
)

const port = Number(process.env.PLAYWRIGHT_PORT)
if (!process.env.PLAYWRIGHT_PORT || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('[deadline] 需要显式 PLAYWRIGHT_PORT（本树分配的 test 端口）')
  process.exit(2)
}
const wikiPortRaw = process.env.PLAYWRIGHT_WIKI_PORT
const wikiPort = wikiPortRaw === undefined || wikiPortRaw.trim() === '' ? port + 1 : Number(wikiPortRaw)

const stdoutChunks = []
const stderrChunks = []
const child = spawn(
  process.execPath,
  [
    path.join(WEB_DIR, 'scripts', 'run-e2e-tree.mjs'),
    'e2e/real-deadline.deadline.ts',
    '--retries=0',
    // 证据只跑 desktop：同一链路，避免两个 project 把逐 case 块/超时计数翻倍。
    '--project=desktop-chrome',
  ],
  {
    cwd: WEB_DIR,
    env: { ...process.env, REAL_DEADLINE_E2E: '1' },
  },
)
child.stdout.on('data', (d) => stdoutChunks.push(d.toString()))
child.stderr.on('data', (d) => stderrChunks.push(d.toString()))
child.on('error', (err) => {
  console.error('[deadline] 子进程启动失败：' + err.message)
  process.exit(1)
})
child.on('close', (code) => {
  const stdout = stdoutChunks.join('')
  const stderr = stderrChunks.join('')
  const combined = stdout + '\n' + stderr
  console.log(combined)

  let failed = 0
  const check = (ok, label, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? '：' + detail : ''}`)
    if (!ok) failed += 1
    return ok
  }

  // 0) 合成反例自测：反例必须红、合法 fixture 必须绿。
  const selfTest = syntheticValidatorSelfTest()
  for (const c of selfTest.checks) check(c.ok, `自测 ${c.name}`, c.detail)
  check(selfTest.ok, '合成反例自测整体')

  // 1) 真实 deadline + 入口/身份门禁。
  check(code !== 0, '子进程以失败退出（真实 deadline，不是被包装成通过）', `exit=${code}`)
  check(
    combined.includes(`[e2e 端口隔离] 服务身份核验通过：port=${port} profile=workbench served.root=`),
    `workbench 端口 ${port} 经 __tree__ nonce/root 身份核验`,
  )
  check(
    combined.includes(`[e2e 端口隔离] wiki-profile 服务核验通过：port=${wikiPort} profile=wiki served.root=`),
    `wiki 端口 ${wikiPort} 经 __tree__ nonce/root 身份核验`,
  )
  check(
    combined.includes(`本次运行两个服务：workbench=${port}（主槽） / wiki=${wikiPort}`),
    '复用 test:e2e:tree 的两服务包装',
  )

  // 2) 逐 case 分块校验（marker 在 stderr；若 reporter 把它转去 stdout 也能兜住）。
  const caseText = stderr.includes('[deadline-case] ') ? stderr : stdout
  const verdict = validateDeadlineEvidence({ caseText, reporterText: combined })
  for (const result of verdict.cases) {
    check(result.ok, `case ${result.facts.id}`, result.ok ? 'block-scoped facts OK' : result.errors.join(' | '))
    if (!result.ok) continue
    console.log('  close: ' + result.facts.close)
    console.log('  budget: ' + result.facts.budget)
    console.log('  nav: ' + result.facts.nav)
    console.log('  attribution: ' + result.facts.attribution)
  }
  check(verdict.ok, '逐 case 证据整体', `blocks=${verdict.blocks}/${REAL_DEADLINE_CASES.length}`)

  console.log(failed === 0 ? '[deadline] PASS：逐 case Node 事实 + 身份门禁齐全' : '[deadline] FAIL：证据缺失')
  process.exit(failed === 0 ? 0 : 1)
})
