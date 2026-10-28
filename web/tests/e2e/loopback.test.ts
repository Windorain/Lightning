/**
 * e2e loopback 单一族的**配置级**判据（动态 import 真实配置，不扫源码）。
 *
 * 为什么不是只测 helper：helper 正确、而某个入口仍手拼 URL 或漏 `--host` 时，
 * 只测 helper 会全绿 —— 事故形态正是"配置入口与监听族分叉"。这里直接加载真实配置，
 * 断言它们**实际产出**的 webServer 与 baseURL：
 *  - 主配置：两个 webServer 的 command/url + `use.baseURL` 同源；
 *  - shot / perf：各自的 command/url/baseURL。
 *
 * 不启动任何服务：只 import 配置对象（不执行 globalSetup/webServer），端口用测试专用值，
 * 每个用例前隔离 env 并重置模块缓存。绝对锚点（`127.0.0.1`、端口、`--strictPort`）
 * 直接写在断言里 —— 即使 helper 本身被改成 `localhost`，这里也必须变红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveBaseURL, resolveWikiBaseURL, viteDevCommand } from '../../e2e/tree-identity'

/**
 * 主配置顶层会解析"真实产物是否就绪"（与 loopback 判据无关，且会拉起一批依赖 app alias
 * 的 helper）。这里把它 mock 成空集合：本文件只断言**配置产出的地址/命令**，
 * 不验证产物门控；mock 也让用例保持"零服务、零产物依赖"。
 */
vi.mock('../../e2e/real-artifact-gate', () => ({ testIgnoreGlobs: () => [] }))

const MAIN_PORT = 5228
const WIKI_PORT = 5229
const SHOT_PORT = 5230
const EXPECTED_HOST = '127.0.0.1'

interface ServerConfig {
  command?: string
  url?: string
}

interface PlaywrightConfigLike {
  use?: { baseURL?: string }
  webServer?: ServerConfig | ServerConfig[]
}

const savedEnv = { ...process.env }
const ISOLATED_ENV = ['PLAYWRIGHT_PORT', 'PLAYWRIGHT_WIKI_PORT', 'LIGHTNING_SHOT_E2E_PORT', 'PLAYWRIGHT_TREE_NONCE'] as const

beforeEach(() => {
  vi.resetModules()
  process.env.PLAYWRIGHT_PORT = String(MAIN_PORT)
  process.env.PLAYWRIGHT_WIKI_PORT = String(WIKI_PORT)
  delete process.env.LIGHTNING_SHOT_E2E_PORT
})

afterEach(() => {
  vi.resetModules()
  for (const key of ISOLATED_ENV) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** URL 必须逐字是 127.0.0.1:<port>（手动解析再核一次 host/port，防字符串形态绕过）。 */
function assertLoopbackUrl(url: string | undefined, port: number): void {
  expect(url, `url 应存在（port=${port}）`).toBe(`http://${EXPECTED_HOST}:${port}`)
  const parsed = new URL(url!)
  expect(parsed.hostname).toBe(EXPECTED_HOST)
  expect(parsed.port).toBe(String(port))
}

/** 命令必须由 helper 生成，且确实带显式 host / 端口 / strictPort（绝对锚点）。 */
function assertViteCommand(command: string | undefined, port: number): void {
  expect(command, `webServer.command 应存在（port=${port}）`).toBe(viteDevCommand(port))
  expect(command).toContain(`--host ${EXPECTED_HOST}`)
  expect(command).toContain(`--port ${port}`)
  expect(command).toContain('--strictPort')
}

describe('主配置（playwright.config.ts）', () => {
  it('workbench/wiki 两个 webServer 与 use.baseURL 同族同端口', async () => {
    const config = (await import('../../playwright.config')).default as PlaywrightConfigLike
    const servers = Array.isArray(config.webServer) ? config.webServer : [config.webServer]
    expect(servers).toHaveLength(2)

    assertViteCommand(servers[0]?.command, MAIN_PORT)
    assertLoopbackUrl(servers[0]?.url, MAIN_PORT)
    assertViteCommand(servers[1]?.command, WIKI_PORT)
    assertLoopbackUrl(servers[1]?.url, WIKI_PORT)
    expect(servers[1]?.url).toBe(resolveWikiBaseURL(WIKI_PORT))

    expect(config.use?.baseURL).toBe(resolveBaseURL(MAIN_PORT))
    assertLoopbackUrl(config.use?.baseURL, MAIN_PORT)
    expect(new URL(config.use!.baseURL!).origin).toBe(new URL(servers[0]!.url!).origin)
  })
})

describe('其他真实 e2e 入口', () => {
  it('shot 配置（playwright.shot.config.ts）', async () => {
    process.env.LIGHTNING_SHOT_E2E_PORT = String(SHOT_PORT)
    const config = (await import('../../playwright.shot.config')).default as PlaywrightConfigLike
    const server = config.webServer as ServerConfig

    assertViteCommand(server.command, SHOT_PORT)
    assertLoopbackUrl(server.url, SHOT_PORT)
    expect(config.use?.baseURL).toBe(resolveBaseURL(SHOT_PORT))
    assertLoopbackUrl(config.use?.baseURL, SHOT_PORT)
  })

  it('perf 配置（tests/perf/e2e/playwright.perf.config.ts）', async () => {
    const config = (await import('../../tests/perf/e2e/playwright.perf.config')).default as PlaywrightConfigLike
    const server = config.webServer as ServerConfig

    assertViteCommand(server.command, MAIN_PORT)
    assertLoopbackUrl(server.url, MAIN_PORT)
    expect(config.use?.baseURL).toBe(resolveBaseURL(MAIN_PORT))
    assertLoopbackUrl(config.use?.baseURL, MAIN_PORT)
  })
})
