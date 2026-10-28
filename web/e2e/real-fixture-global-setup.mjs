/**
 * Vitest global setup：在任何测试执行前解析真实夹具，并留下机器可读的门控证据。
 *
 * - 缺任一真实件：打印明确横幅，写 `web/test-results/real-fixture-exclusions.json`
 *   （该目录已 `.gitignore`），逐条记录 key / 期望相对路径 / **全部消费文件及其被门控判据** /
 *   原因 / 候选；
 * - 夹具就绪：同一文件照写，`missing` 为空数组（便于对照与留痕）。
 *
 * 这里**不排除整个测试文件**：门控发生在消费方（`realFixtureAvailable('<key>')`），
 * 其余纯语义判据始终运行（GG 7 条、TESR 2 条）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './load-env.mjs'
import {
  REAL_FIXTURES_DIR_ENV,
  REAL_FIXTURE_KEYS,
  WEB_ROOT,
  realFixtureStatus,
} from './real-fixtures.mjs'

const OUTPUT = path.join(WEB_ROOT, 'test-results', 'real-fixture-exclusions.json')

function printBanner(lines) {
  const rule = '='.repeat(78)
  console.log([rule, ...lines, rule].join('\n'))
}

export async function setup() {
  const statuses = REAL_FIXTURE_KEYS.map((key) => realFixtureStatus(key))
  const missing = statuses.filter((status) => !status.available)

  const report = {
    generatedAt: new Date().toISOString(),
    envKey: REAL_FIXTURES_DIR_ENV,
    rootEnvFile: path.join(REPO_ROOT, '.env'),
    fixturesDir: statuses[0]?.envDir ?? null,
    missing: missing.map((status) => ({
      key: status.key,
      expectedRelativePath: status.expectedRelativePath,
      // 权威：全部消费文件及各自被门控的判据名。
      consumers: status.consumers.map((c) => ({ consumer: c.consumer, gatedTests: c.gatedTests })),
      // 派生字段：保留 GG 试点期的读法。
      consumer: status.consumer,
      gatedTests: status.gatedTests,
      reason: status.reason,
      candidates: status.candidates,
    })),
    checked: statuses.map((status) => ({
      key: status.key,
      available: status.available,
      path: status.path,
      missingKind: status.missingKind,
    })),
  }

  mkdirSync(path.dirname(OUTPUT), { recursive: true })
  writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  if (missing.length === 0) {
    for (const status of statuses) console.log(`[real-fixtures] ${status.key} 就绪：${status.path}`)
    return
  }

  const lines = [
    `[real-fixtures] 真实夹具缺失：${missing.map((status) => status.key).join(', ')}`,
    '依赖真实件的判据将被显式跳过（e2e 侧对应的 spec 由入口产物门控整份排除，不是静默跳过），**不计入通过**（不是整套通过）。',
  ]
  for (const status of missing) {
    lines.push(
      `  key：${status.key}`,
      `  期望相对路径：${status.expectedRelativePath}`,
      `  原因：${status.reason}`,
      '  消费文件与被门控测试：',
      ...status.consumers.flatMap((c) => [
        `    - ${c.consumer}`,
        ...c.gatedTests.map((name) => `        · ${name}`),
      ]),
      '  候选：',
      ...status.candidates.map((candidate) => `    - ${candidate}`),
    )
  }
  lines.push(
    `  处置：在仓库根 .env 写 ${REAL_FIXTURES_DIR_ENV}=<真实夹具根>（布局见 .env.example）`,
    `  记录：${OUTPUT}`,
  )
  printBanner(lines)
}
