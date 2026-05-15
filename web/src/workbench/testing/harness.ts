/**
 * Test harness — Playwright 黑盒测试入口。
 *
 * 入口挂载：Vite serve workbench → Chromium → WorkbenchRoot 自己跑。
 * 事件注入：Playwright mouse/keyboard → 真实 PointerEvent → canvas capture。
 * 观测：page.evaluate() 读 window.__vm__。
 */

import type { Page } from 'playwright'
import { chromium } from 'playwright'
import type { ViteDevServer } from 'vite'
import { createServer } from 'vite'

// ---------------------------------------------------------------------------
// IO 拦截脚本（注入到浏览器，劫持 <input type="file"> click）
// ---------------------------------------------------------------------------
const IO_INTERCEPT_SCRIPT = `
window.__test_file__ = null
const _origClick = HTMLInputElement.prototype.click
HTMLInputElement.prototype.click = function () {
  if (this.type === 'file' && window.__test_file__) {
    const f = window.__test_file__
    const blob = new Blob([f.content], { type: 'application/json' })
    const file = new File([blob], f.name, { type: 'application/json' })
    const list = [file]
    Object.defineProperty(list, 'item', { value: (i) => i === 0 ? file : null })
    Object.defineProperty(this, 'files', { value: list, configurable: true })
    this.dispatchEvent(new Event('change', { bubbles: true }))
    window.__test_file__ = null
    return
  }
  return _origClick.call(this)
}
`

// ---------------------------------------------------------------------------
// Browser + server
// ---------------------------------------------------------------------------
let _page: Page | null = null
let _server: ViteDevServer | null = null

export async function shutdown(): Promise<void> {
  if (_page) { await _page.close(); _page = null }
  if (_server) { await _server.close(); _server = null }
}

async function getPage(): Promise<Page> {
  if (_page) return _page

  _server = await createServer({
    configFile: 'vite.workbench.config.ts',
    server: { port: 5199, strictPort: false },
  })
  await _server.listen()
  const origin = _server.resolvedUrls?.local?.[0] ?? 'http://localhost:5199'

  const browser = await chromium.launch({ headless: true })
  _page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  _page.on('close', () => { _page = null })

  await _page.goto(origin, { waitUntil: 'networkidle' })
  await _page.waitForFunction(() => (window as any).__vm_ready__ === true, { timeout: 15000 })

  // Inject IO interception AFTER page loads
  await _page.evaluate(IO_INTERCEPT_SCRIPT)

  return _page
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** page.evaluate with typed args */
function $<R>(page: Page, fn: () => R): Promise<R>
function $<A, R>(page: Page, fn: (a: A) => R, arg: A): Promise<R>
function $(page: Page, fn: (...args: any[]) => any, arg?: any): Promise<any> {
  if (arguments.length === 2) return page.evaluate(fn as any)
  return page.evaluate(fn as any, arg)
}

// ---------------------------------------------------------------------------
// TestHarness — 只保留最基本的 Playwright 事件注入
// ---------------------------------------------------------------------------

export interface TestHarness {
  page: Page

  // L0: raw DOM events
  pointerDown(x: number, y: number): Promise<void>
  pointerMove(x: number, y: number): Promise<void>
  pointerUp(x: number, y: number): Promise<void>
  keyDown(key: string): Promise<void>

  // L1: composite gestures
  click(x: number, y: number): Promise<void>
  drag(fromX: number, fromY: number, toX: number, toY: number, steps?: number): Promise<void>

  // IO
  provideFile(name: string, content: string): Promise<void>
}

export async function createTestHarness(): Promise<TestHarness> {
  const page = await getPage()

  const h: TestHarness = {
    page,

    // ---- L0 ----
    async pointerDown(x, y) { await page.mouse.move(x, y); await page.mouse.down({ button: 'left' }) },
    async pointerMove(x, y) { await page.mouse.move(x, y) },
    async pointerUp(x, y)   { await page.mouse.move(x, y); await page.mouse.up({ button: 'left' }) },
    async keyDown(key)      { await page.keyboard.press(key) },

    // ---- L1 ----
    async click(x, y) { await page.mouse.click(x, y) },
    async drag(x1, y1, x2, y2, steps = 5) {
      await page.mouse.move(x1, y1)
      await page.mouse.down({ button: 'left' })
      for (let i = 1; i < steps; i++) {
        const t = i / steps
        await page.mouse.move(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)
      }
      await page.mouse.move(x2, y2)
      await page.mouse.up({ button: 'left' })
    },

    // ---- IO ----
    async provideFile(name, content) {
      await $(page, (f: { name: string; content: string }) => {
        (window as any).__test_file__ = f
      }, { name, content })
    },
  }

  return h
}
