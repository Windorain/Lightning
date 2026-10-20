/**
 * #262 P11-C · **浏览器侧性能标定 spec**（真实 Chromium + 真实 WebGL）。
 *
 * ## 跑法（本树 slot 5216）
 *
 * ```powershell
 * cd web
 * $env:PLAYWRIGHT_PORT='5216'
 * node scripts/run-e2e-tree.mjs --config tests/perf/e2e/playwright.perf.config.ts `
 *   --project=desktop-chrome --reporter=list
 * ```
 *
 * `scripts/run-e2e-tree.mjs` 把 `--config` 原样透传给 playwright ⇒ 端口隔离包装
 * （未设 `PLAYWRIGHT_PORT` 即中止）对本次标定**同样生效**，本 spec 不另开绕行入口。
 * 服务身份仍由 `testDir` 之外的 `e2e/global-setup.ts` 强制核验（见下面 config）。
 *
 * ## 为什么不是 `web/e2e/*.spec.ts`
 *
 * 那样会被 `npm run test:e2e` / `:smoke` / `:full` 收进常规回归面（L2/L3 用例数随之变化），
 * 而标定 spec 是**按需运行的测量设施**、不是回归判据。放在 `web/tests/perf/e2e/` 后
 * `playwright.config.ts` 的 `testDir: './e2e'` 一字不改，常规套件收集面**不受影响**。
 *
 * ## 本 spec 断言什么（以及**不**断言什么）
 *
 * 断言**结构事实**（有对象、有绘制、有帧序列）—— 这些是"读数非空洞"的门槛，
 * 不达标就是测量本身坏了，必须判红。**不**断言任何时间阈值：
 * #249 §14 明文「绝对延迟和内存阈值目前未测量」，本轮的任务是**标定**（收数字 + 提建议），
 * 不是把未获批的数字写成硬门槛（#332 的教训：负载波动会制造假红）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const WEB_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const FIXTURE_DIR = process.env.P11C_PERF_FIXTURE_DIR ?? path.join(WEB_ROOT, 'test-artifacts', 'perf-fixtures')
const OUT_DIR = process.env.P11C_PERF_OUT_DIR ?? path.join(WEB_ROOT, 'test-artifacts', 'perf-calibration')

/** 每点的采样数。浏览器侧单次成本高，但仍取 ≥5 且取奇数以便 P95 有区分力。 */
const SAMPLES = Number(process.env.P11C_PERF_SAMPLES ?? 7)
const FRAMES = Number(process.env.P11C_PERF_FRAMES ?? 90)

type AnyProbe = Record<string, (...args: any[]) => any>

/** 经 vite 转译加载探针（裸说明符只有 dev server 能解析，见探针文件头）。 */
async function loadProbe(page: Page): Promise<void> {
  await page.goto('/')
  await page.evaluate(async () => {
    const mod = (await import('/tests/perf/e2e/probe.ts')) as unknown as AnyProbe
    mod.installPerfHarness!()
  })
}

async function callProbe<T>(page: Page, fn: string, args: unknown[] = []): Promise<T> {
  return (await page.evaluate(
    async ({ fn, args }) => {
      const mod = (await import('/tests/perf/e2e/probe.ts')) as unknown as AnyProbe
      return await mod[fn]!(...args)
    },
    { fn, args },
  )) as T
}

// ── 统计（与纯函数侧测量车同一口径：线性插值百分位）──
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN
  if (sorted.length === 1) return sorted[0]!
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}
function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b)
  return {
    n: s.length,
    min: s[0]!,
    median: percentile(s, 0.5),
    p95: percentile(s, 0.95),
    max: s[s.length - 1]!,
  }
}

/** 落一份标定原始读数（附件用；文件名由上传者加提交短 SHA 前缀）。 */
function writeEvidence(name: string, payload: unknown): string {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const file = path.join(OUT_DIR, name)
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return file
}

function loadScale(scale: string): { envelope: Record<string, unknown>; manifestEntry: Record<string, unknown> } {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8'))
  const entry = manifest.entries[scale]
  if (entry === undefined) throw new Error(`夹具清单里没有档位 ${scale}；先跑 node tests/perf/fixtures/generate.mjs`)
  const envelope = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, entry.envelope.file), 'utf8'))
  return { envelope, manifestEntry: entry }
}

const SCALES = (process.env.P11C_PERF_SCALES ?? 'S,M,L').split(',').map((s) => s.trim().toUpperCase())
const OBJECT_COUNTS: Record<string, number> = { S: 1_000, M: 20_000, L: 120_000 }

test.describe('#262 P11-C 浏览器侧标定（真实 Chromium + 真实 WebGL）', () => {
  test.describe.configure({ mode: 'serial' })

  test('环境事实：GPU 后端 / 浏览器 / 视口（未记录环境的读数不得入标定表）', async ({ page }) => {
    await loadProbe(page)
    const info = await callProbe<Record<string, unknown>>(page, 'gpuInfo')
    const browserVersion = page.context().browser()?.version() ?? 'unknown'
    const record = { ...info, browserVersion, userAgent: await page.evaluate(() => navigator.userAgent) }
    console.log('[P11-C 浏览器环境] ' + JSON.stringify(record, null, 2))
    writeEvidence('browser-environment.json', record)

    // 结构事实断言：真实上下文 + 真实视口（真值来源 = 浏览器自己，不是配置里的常量）
    expect(info.webgl2, '本标定要求 WebGL2 真实上下文').toBe(true)
    expect(Number(info.threeRevision), 'three 版本必须真实可读').toBeGreaterThan(0)
    expect(info.viewport, '视口必须与 B2 §2.2 的 1280×800 一致').toMatchObject({ width: 1280, height: 800 })
    expect(String(info.gpuBackend), '必须标注 GPU 后端').toMatch(/hardware|software/)
  })

  for (const scale of SCALES) {
    const count = OBJECT_COUNTS[scale]!

    test(`[${scale}] 渲染重编 + 拾取（${count} 对象，真实 GPU）`, async ({ page }) => {
      test.setTimeout(600_000)
      await loadProbe(page)
      const env = await callProbe<Record<string, unknown>>(page, 'gpuInfo')
      const r = await callProbe<{
        compileMs: number[]
        applyMs: number[]
        renderMs: number[]
        pickBuildMs: number[]
        pickResolveAllMs: number[]
        objectProof: Record<string, unknown>
      }>(page, 'runRecompile', [count, SAMPLES])

      const summary = {
        scale,
        browser: { version: page.context().browser()?.version() ?? 'unknown', gpuBackend: env.gpuBackend, renderer: env.renderer },
        objectProof: r.objectProof,
        points: {
          'recompile.compileScene(ms)': stats(r.compileMs),
          'render.applyToGPU(ms)': stats(r.applyMs),
          'render.renderFrame(ms)': stats(r.renderMs),
          'pick.buildIndex(ms)': stats(r.pickBuildMs),
          'pick.resolveAll(ms)': stats(r.pickResolveAllMs),
        },
      }
      console.log(`[P11-C ${scale}] ` + JSON.stringify(summary, null, 2))
      writeEvidence(`recompile-pick-${scale}.json`, summary)

      // ── 结构事实（防空洞读数）：有对象、有合批、真画了、拾取真命中 ──
      const p = r.objectProof
      expect(p.objects, '夹具对象数必须真为声明值（否则读数没有对象）').toBe(count)
      expect(Number(p.provenance), '编译产物必须有身份溯源条目').toBeGreaterThan(0)
      expect(Number(p.measuredDrawCalls), '真实 GL 必须确实提交了绘制（否则是空批次）').toBeGreaterThan(0)
      expect(Number(p.measuredTriangles), '真实 GL 必须确实提交了三角形').toBeGreaterThan(0)
      expect(Number(p.pickHits), '拾取必须真命中（否则"拾取很快"是因为什么都没解出来）').toBe(count)
      // 取账时机：持有中看 activeCount（>0 = 真的持有资源），dispose 后看 balanced
      //（持有中 balanced 必然为假 —— 那是"还没释放"，不是泄漏）。
      expect(Number(p.ledgerActiveWhileHeld), '持有资源时活跃计数必须 > 0（否则本点的资源读数无对象）').toBeGreaterThan(0)
      expect(p.ledgerBalancedAfterDispose, 'dispose 后 GPU 资源台账必须平衡（否则本点的资源计数不可信）').toBe(true)
      expect(Number(p.ledgerActiveAfterDispose), 'dispose 后活跃资源必须归零').toBe(0)
    })

    test(`[${scale}] 完整装载脊柱（浏览器内：解码 → 解析 → 装配 → 呈现输入）`, async ({ page }) => {
      test.setTimeout(600_000)
      await loadProbe(page)
      const { envelope } = loadScale(scale)
      const r = await callProbe<{
        decodeMs: number[]
        parseMs: number[]
        assembleMs: number[]
        toInputsMs: number[]
        objectProof: Record<string, unknown>
      }>(page, 'runBrowserLoad', [envelope, Math.max(5, Math.min(SAMPLES, 7))])

      const summary = {
        scale,
        objectProof: r.objectProof,
        points: {
          'load.decodeEnvelope(ms)': stats(r.decodeMs),
          'load.parse(ms)': stats(r.parseMs),
          'load.assembleKernelDocument(ms)': stats(r.assembleMs),
          'load.kernelPresentationInputs(ms)': stats(r.toInputsMs),
          'load.total(ms)': stats(r.decodeMs.map((v, i) => v + r.parseMs[i]! + r.assembleMs[i]! + r.toInputsMs[i]!)),
        },
      }
      console.log(`[P11-C ${scale} 装载] ` + JSON.stringify(summary, null, 2))
      writeEvidence(`browser-load-${scale}.json`, summary)

      const p = r.objectProof
      expect(p.kernelObjects, '内核必须装配出对象').toBeGreaterThan(0)
      expect(Number(p.primitives), '呈现输入必须有 primitive（否则下游读数空洞）').toBeGreaterThan(0)
      expect(Number(p.skipped), '不得有对象被静默跳过').toBe(0)
    })
  }

  test('[帧循环] 真实 RAF 帧间隔（帧循环步进）', async ({ page }) => {
    await loadProbe(page)
    const r = await callProbe<{ gapsMs: number[]; rafTimestamps: number[] }>(page, 'runFrameGaps', [FRAMES])
    // 第一个间隔含 goto 之后的排空，不具代表性 ⇒ 丢弃首帧（与 parts-hover-stats 的原语同口径）
    const gaps = r.gapsMs.slice(1)
    const s = stats(gaps)
    const summary = {
      frames: FRAMES,
      discardedFirstGapMs: r.gapsMs[0] ?? null,
      points: { 'frame.rafGap(ms)': s },
      impliedFps: { median: 1000 / s.median, p95Worst: 1000 / s.p95 },
    }
    console.log('[P11-C 帧循环] ' + JSON.stringify(summary, null, 2))
    writeEvidence('frame-loop.json', summary)

    expect(r.rafTimestamps.length, '必须有真实帧序列').toBe(FRAMES)
    expect(gaps.length, '除首帧外必须有间隔样本').toBeGreaterThanOrEqual(5)
    expect(s.median, '中位帧间隔必须为正（否则读数无效）').toBeGreaterThan(0)
  })

  test('[内存] 显式资源计数 + 与堆统计的对照（辅助，不作唯一判据）', async ({ page }) => {
    await loadProbe(page)
    const before = await callProbe<Record<string, unknown>>(page, 'gpuInfo')
    const env = await callProbe<Record<string, unknown>>(page, 'gpuInfo')
    const r = await callProbe<{ objectProof: Record<string, unknown> }>(page, 'runRecompile', [OBJECT_COUNTS.M, 5])
    const after = await callProbe<Record<string, unknown>>(page, 'gpuInfo')
    const summary = {
      scale: 'M',
      note: '主判据 = 显式资源计数（#249 §14 A19 附注）；堆统计仅辅助、不作唯一判据',
      explicitCounts: {
        ledgerActiveWhileHeld: r.objectProof.ledgerActiveWhileHeld,
        ledgerActiveAfterDispose: r.objectProof.ledgerActiveAfterDispose,
        ledgerBalancedAfterDispose: r.objectProof.ledgerBalancedAfterDispose,
        ledgerAcquireTotal: r.objectProof.ledgerAcquireTotal,
        batchObjects: r.objectProof.batchObjects,
        payloads: r.objectProof.payloads,
      },
      heapUsedBytes: { before: before.jsHeapUsedBytes, after: after.jsHeapUsedBytes },
      heapLimitBytes: env.jsHeapLimitBytes,
    }
    console.log('[P11-C 内存] ' + JSON.stringify(summary, null, 2))
    writeEvidence('memory-counts.json', summary)

    expect(Number(r.objectProof.ledgerActiveWhileHeld), '持有中显式活跃资源数必须 > 0（否则"没泄漏"是因为什么都没建）').toBeGreaterThan(0)
    expect(r.objectProof.ledgerBalancedAfterDispose, 'dispose 后资源台账必须平衡').toBe(true)
    expect(Number(r.objectProof.ledgerActiveAfterDispose), 'dispose 后活跃资源必须归零').toBe(0)
  })
})
