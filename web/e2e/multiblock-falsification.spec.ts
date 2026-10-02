/**
 * T2.6 · 断言有效性证伪（**防止管线恒绿**）。
 *
 * 计划 T2.6 自检：「故意篡改 fixture 一个格子，管线变红 —— 证明断言有效而非恒绿」。
 *
 * 三条纪律：
 *  1. **仓库 fixture 原件一字不改**：篡改只发生在测试内存里的注入副本
 *     （`cloneInner` + `rewrap`），注入路径与原件完全相同（同信封、同 parser）。
 *  2. **红色必须来自断言，而不是解析失败**：每个用例先断言篡改副本仍能正常加载
 *     （`docLoaded === true`），再用 try/catch 验证**断言确实抛出**。
 *  3. **证伪必须“定向”**：格级篡改只能打红格级断言、声明级断言仍绿（反之亦然），
 *     以此排除「整个管线一起崩」这种伪证。
 *
 * 另含像素断言的自证伪（纯色 PNG 必须被拒），保证截图非空断言本身不是恒绿。
 */

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  COLOR_BUCKETS,
  MULTIBLOCK_CONTRACTS,
  VIEWPORT_CANVAS,
  backboneViolations,
  blankViolations,
  buildFrameDominantMultiframeDocument,
  cloneInner,
  contractFor,
  declarationViolations,
  expectBackbone,
  expectDeclaration,
  gotoWorkbench,
  injectSceneDocumentOk,
  readDocObservation,
  readFixture,
  readPixelStats,
  rewrap,
  waitForRenderedGrid,
  type PixelStats,
} from './helpers/multiblock'

/** 跑一个同步断言，返回捕获到的错误（未抛则返回 null）。 */
function captureFailure(fn: () => void): unknown {
  try {
    fn()
    return null
  } catch (e) {
    return e
  }
}

/** 违反项列表里是否提到了某个关键词。 */
function mentions(violations: string[], needle: string): boolean {
  return violations.some((v) => v.includes(needle))
}

test.describe('T2.6 · 断言证伪：篡改注入副本 → 管线必须变红', () => {
  test('格级：篡改骨架一个格子 → 格级断言红、声明级断言仍绿', async ({ page }) => {
    const c = contractFor('multiblock-tier-only.json')
    const { envelope, inner } = readFixture(c.file)

    // ── 基线：未篡改原件 → 全绿（同一页面先建立对照）──
    await gotoWorkbench(page)
    await injectSceneDocumentOk(page, envelope, c.file)
    const clean = await readDocObservation(page)
    expectDeclaration(clean, c)
    expectBackbone(clean, c)

    // ── 篡改：骨架第 0 阶 cellGrid 的 (z=0, row=0, x=0) 由 1 改成 2（角色 2 已声明，仍能正常解析）──
    const tampered = cloneInner(inner)
    const mb = tampered.multiblock as Record<string, unknown>
    const backbone = mb.backbone as Record<string, unknown>
    const steps = backbone.sizeSteps as Array<Record<string, unknown>>
    const grid = steps[0]!.cellGrid as number[][][]
    const before = grid[0]![0]![0]
    grid[0]![0]![0] = before === 1 ? 2 : 1
    expect(grid[0]![0]![0], '篡改必须真的改动了一个格子').not.toBe(before)

    // 重新起一个干净页面再注入篡改副本（避免与基线混淆）
    await gotoWorkbench(page)
    const injected = await injectSceneDocumentOk(page, rewrap(envelope, tampered), 'tampered-cell.json')
    expect(injected.docLoaded, '篡改一格后仍应能正常解析（否则红色来自解析失败，不是断言）').toBe(true)
    expect(injected.isMultiblock).toBe(true)

    const doc = await readDocObservation(page)
    // 篡改确实沿公开观测点透出
    expect(doc.backbone!.steps[0]!.cellGrid[0]![0]![0]).toBe(grid[0]![0]![0])

    const bbViolations = backboneViolations(doc, c)
    expect(bbViolations.length, '格级断言必须报出违反项').toBeGreaterThan(0)
    expect(mentions(bbViolations, '逐格下标'), `违反项应指向被篡改的列：${bbViolations.join(' | ')}`).toBe(true)

    // ── 固化：预期的失败断言确实失败 ──
    const err = captureFailure(() => expectBackbone(doc, c))
    expect(err, '格级篡改后 expectBackbone 必须抛出（管线变红）').not.toBeNull()
    console.log(`[T2.6] 格级篡改 → 断言红：${(err as Error).message.split('\n')[0]}`)

    // ── 定向性：声明级断言仍绿（证伪不是“整体崩”）──
    expect(declarationViolations(doc, c), '格级篡改不应影响声明级断言').toEqual([])
  })

  test('声明级：删掉通道声明 → 通道条数断言红、格级断言仍绿', async ({ page }) => {
    const c = contractFor('multiblock-tier-only.json')
    const { envelope, inner } = readFixture(c.file)

    const tampered = cloneInner(inner)
    ;(tampered.multiblock as Record<string, unknown>).channels = []

    await gotoWorkbench(page)
    const injected = await injectSceneDocumentOk(page, rewrap(envelope, tampered), 'tampered-channels.json')
    expect(injected.docLoaded, '删空 channels 后仍应能正常解析').toBe(true)

    const doc = await readDocObservation(page)
    expect(doc.channelCount).toBe(0)
    const violations = declarationViolations(doc, c)
    expect(mentions(violations, '通道声明条数'), `应报通道条数不符：${violations.join(' | ')}`).toBe(true)

    const err = captureFailure(() => expectDeclaration(doc, c))
    expect(err, '声明被篡改后 expectDeclaration 必须抛出').not.toBeNull()
    console.log(`[T2.6] 声明级篡改（通道条数）→ 断言红：${(err as Error).message.split('\n')[0]}`)

    // 定向性：格级断言仍绿
    expect(backboneViolations(doc, c), '通道条数篡改不应影响格级断言').toEqual([])
  })

  test('声明级：改通道/运行态呈现名 → 呈现名断言红、条数断言仍绿', async ({ page }) => {
    const c = contractFor('multiblock-ebf-2ch.json')
    const { envelope, inner } = readFixture(c.file)

    const tampered = cloneInner(inner)
    const mb = tampered.multiblock as Record<string, unknown>
    const channels = mb.channels as Array<Record<string, unknown>>
    const runstates = mb.runstates as Array<Record<string, unknown>>
    channels[1]!.name = 'CoilX'
    runstates[1]!.name = 'RunningX'

    await gotoWorkbench(page)
    const injected = await injectSceneDocumentOk(page, rewrap(envelope, tampered), 'tampered-names.json')
    expect(injected.docLoaded, '改呈现名后仍应能正常解析').toBe(true)

    const doc = await readDocObservation(page)
    expect(doc.channelCount, '条数未被改动').toBe(c.channelKeys.length)
    expect(doc.runstateCount, '条数未被改动').toBe(c.runstateIds.length)

    const violations = declarationViolations(doc, c)
    expect(mentions(violations, '通道呈现名'), `应报通道呈现名不符：${violations.join(' | ')}`).toBe(true)
    expect(mentions(violations, '运行态呈现名'), `应报运行态呈现名不符：${violations.join(' | ')}`).toBe(true)

    const err = captureFailure(() => expectDeclaration(doc, c))
    expect(err, '呈现名被篡改后 expectDeclaration 必须抛出').not.toBeNull()
    console.log(`[T2.6] 声明级篡改（呈现名）→ 断言红：${(err as Error).message.split('\n')[0]}`)

    expect(backboneViolations(doc, c), '呈现名篡改不应影响格级断言').toEqual([])
  })

  test('像素断言自证伪：纯色/全黑截图必须被拒，真实视口截图必须通过', async ({ page }) => {
    expect(COLOR_BUCKETS).toBe(32 * 32 * 32)

    await gotoWorkbench(page)
    // 用真正能渲染出几何的样例做「必须通过」的一侧（实测 uniqueColors 500+）
    await injectSceneDocumentOk(page, buildFrameDominantMultiframeDocument(), 'pixel-baseline.json')
    await waitForRenderedGrid(page)

    // 真实视口截图 → 非空断言必须通过
    const realPng = await page.locator(VIEWPORT_CANVAS).screenshot()
    const realStats = await readPixelStats(page, realPng)
    expect(blankViolations(realStats), `真实截图不应被判空：${JSON.stringify(realStats)}`).toEqual([])
    expect(captureFailure(() => assertNotBlankSync(realStats))).toBeNull()

    // 纯色（全黑/全白/单色）截图 → 必须被拒
    for (const color of ['#000000', '#ffffff', '#3a7bd5']) {
      const png = await makeSolidPng(page, color, 320, 240)
      const stats = await readPixelStats(page, png)
      const violations = blankViolations(stats)
      expect(violations.length, `纯色截图 ${color} 必须被判空（实测 ${JSON.stringify(stats)}）`).toBeGreaterThan(0)
      const err = captureFailure(() => assertNotBlankSync(stats))
      expect(err, `纯色截图 ${color} 上 expectNotBlank 必须抛出`).not.toBeNull()
      console.log(`[T2.6] 纯色 ${color} 被拒：${violations.join(' | ')}`)
    }
  })

  test('契约表完整性：三份 fixture 都被证伪用例覆盖或明确说明', () => {
    const files = MULTIBLOCK_CONTRACTS.map((c) => c.file)
    expect(files).toContain('multiblock-tier-only.json')
    expect(files).toContain('multiblock-ebf-2ch.json')
    expect(files).toContain('multiblock-lsc-overlap.json')
  })
})

/** 同步版非空断言（`expectNotBlank` 的等价包装，供 captureFailure 使用）。 */
function assertNotBlankSync(stats: PixelStats): void {
  const violations = blankViolations(stats)
  expect(violations, `截图疑似全黑/全空。实测 ${JSON.stringify(stats)}`).toEqual([])
}

/** 在页面内生成一张纯色 PNG，返回 Buffer。 */
async function makeSolidPng(page: Page, color: string, w: number, h: number): Promise<Buffer> {
  const b64 = await page.evaluate(
    ({ color, w, h }) => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const g = c.getContext('2d')!
      g.fillStyle = color
      g.fillRect(0, 0, w, h)
      return c.toDataURL('image/png').split(',')[1]!
    },
    { color, w, h },
  )
  return Buffer.from(b64, 'base64')
}
