/**
 * **M6-4 / Q8 · 资源清单在导出卡片上展示**（一次下载只有产物本身，不下第二个文件）。
 *
 * ## 判据（逐条对设计 §10.4）
 *
 * | 判据 | 断言 |
 * |---|---|
 * | 一次下载 | 点"下载 PNG"后**只**收到 1 个 download，且文件名是产物（无 `.json`） |
 * | A 块对账 | `[data-manifest-canonical]` == 生产捕获重算的 `assetManifestCanonicalText`；digest == `assetManifestDigest` |
 * | 篡改判红 | 注入一行假条目后，面板文本 ≠ 重算值（面板不是装饰） |
 * | B 块逐字段 | `[data-manifest-fact]` 的材质/纹理/采样/序列 == 捕获明细（同一份绑定事实） |
 * | 负对照 | 必需纹理不可用 ⇒ 预检 blocked：**零下载 + 无面板** |
 *
 * ## 为什么 A/B 要分开断言
 *
 * A 块进 digest（对账权威），B 块**不进** digest（采样/序列）。若 B 混进清单，
 * `digest` 会随采样参数变化 —— 那等于改掉"产物字节面不变"的契约。故本 spec
 * 同时断言"B 有内容"与"canonical 里没有 B 的字段"。
 */

import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Download, Page } from '@playwright/test'
import { gotoWorkbench, injectSceneDocumentOk, waitForViewportMounted } from './helpers/multiblock'
import { deriveAnimatedDocument } from './helpers/export/animatedFixture'

const OUT_DIR = path.join(import.meta.dirname, 'screenshots', 'm6-4-manifest-panel')

function minimalBase(): Record<string, unknown> {
  const p = path.join(import.meta.dirname, 'fixtures', 'minimal-v2.json')
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
}

async function openExportTab(page: Page, doc: Record<string, unknown>): Promise<void> {
  await gotoWorkbench(page)
  await injectSceneDocumentOk(page, doc, 'm6-4-manifest-panel.v2.json')
  await waitForViewportMounted(page)
  await page.click('.wt-tab:has-text("导出")')
  await page.waitForSelector('.ew-root', { timeout: 20_000 })
}

interface PanelProbeResult {
  readonly ok: boolean
  readonly reason: string | null
  readonly canonical: string
  readonly digest: number
  readonly facts: {
    readonly textures: readonly {
      readonly materialId: string
      readonly materialVersion: string
      readonly textureId: string
      readonly textureVersion: string
      readonly sampling: { readonly filter: string; readonly wrap: string; readonly flipY: boolean; readonly mipmaps: boolean; readonly anisotropy: number }
      readonly sequence: { readonly frameCount: number; readonly durationsMs: readonly number[] } | null
    }[]
  } | null
}

async function probe(page: Page): Promise<PanelProbeResult> {
  return (await page.evaluate(async () => {
    const mod = (await import('/e2e/helpers/m6-4/exportPanelProbe.ts')) as {
      runExportPanelProbe: (o: { seconds?: number }) => Promise<unknown>
    }
    return await mod.runExportPanelProbe({ seconds: 0 })
  })) as PanelProbeResult
}

interface SamplingLike {
  readonly filter: string
  readonly wrap: string
  readonly flipY: boolean
  readonly mipmaps: boolean
  readonly anisotropy: number
}

function samplingText(s: SamplingLike): string {
  return `filter=${s.filter};wrap=${s.wrap};flipY=${String(s.flipY)};mipmaps=${String(s.mipmaps)};anisotropy=${s.anisotropy}`
}

test.describe('M6-4 · 导出卡片资源清单面板（Q8）', () => {
  test('A/B 两块、一次下载、篡改判红', { tag: '@smoke' }, async ({ page }, testInfo) => {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    await openExportTab(page, deriveAnimatedDocument(minimalBase()))
    const panel = page.locator('[data-export-manifest-panel][data-manifest-format="iso-png"]')
    await expect(panel, '预览成功后面板必须出现（失败不留面板）').toBeVisible({ timeout: 60_000 })
    await expect(panel.locator('[data-manifest-delivery="panel"]')).toHaveText(/面板交付/)

    // ── A 块：canonical + digest 与生产捕获重算逐字一致 ─────────────────────
    const canonical = ((await panel.locator('[data-manifest-canonical]').textContent()) ?? '').trim()
    const digestText = ((await panel.locator('[data-manifest-digest]').textContent()) ?? '').trim()
    const expected = await probe(page)
    expect(expected.ok, `探针捕获必须成功：${expected.reason ?? ''}`).toBe(true)
    expect(canonical, 'A 块 canonical 必须等于页面内生产捕获的重算值').toBe(expected.canonical)
    expect(Number(digestText), 'digest 必须等于 assetManifestDigest(entries)').toBe(expected.digest)
    expect(canonical.split('\n').filter((l) => l !== '').length, '每个资源一行').toBeGreaterThan(0)

    // ── B 块：逐字段 == 绑定事实 ───────────────────────────────────────────
    const facts = expected.facts
    expect(facts, '捕获面必须提供 B 块明细').not.toBeNull()
    const rows = panel.locator('[data-manifest-fact]')
    await expect(rows, 'B 块行数必须等于有贴图的材质数').toHaveCount(facts!.textures.length)
    for (let i = 0; i < facts!.textures.length; i += 1) {
      const t = facts!.textures[i]!
      const row = rows.nth(i)
      await expect(row.locator('[data-manifest-field="material"]')).toHaveText(`${t.materialId}@${t.materialVersion}`)
      await expect(row.locator('[data-manifest-field="texture"]')).toHaveText(`${t.textureId}@${t.textureVersion}`)
      await expect(row.locator('[data-manifest-field="sampling"]')).toHaveText(samplingText(t.sampling))
      await expect(row.locator('[data-manifest-field="sequence"]')).toHaveText(
        t.sequence === null ? 'static' : `frames=${t.sequence.frameCount};durationsMs=${t.sequence.durationsMs.join(',')}`,
      )
    }
    // digest 边界：B 块的事实不得出现在 A 块文本里（否则摘要会随采样参数变化）。
    expect(canonical).not.toContain('anisotropy')
    expect(canonical).not.toContain('frames=')

    // ── 一次下载：只有产物本身（没有第二个 .json） ──────────────────────────
    const downloads: Download[] = []
    const onDownload = (d: Download): void => { downloads.push(d) }
    page.on('download', onDownload)
    try {
      await page.locator('[data-download-iso]').click()
      await expect.poll(() => downloads.length, { timeout: 60_000 }).toBe(1)
      // 再等一小段：若实现偷偷下了第二个文件（清单 sidecar），这里会变成 2。
      await page.waitForTimeout(800)
      expect(downloads, '一次导出只能产生一个下载（产物本身）').toHaveLength(1)
      expect(downloads[0]!.suggestedFilename(), '下载文件名必须是产物，不是清单').toBe('iso-0.png')

      const stream = await downloads[0]!.createReadStream()
      const chunks: Buffer[] = []
      for await (const c of stream) chunks.push(c as Buffer)
      const bytes = Buffer.concat(chunks)
      expect(bytes.subarray(0, 8).toString('hex'), '产物仍必须是真 PNG（面板没有改字节）').toBe('89504e470d0a1a0a')
      fs.writeFileSync(path.join(OUT_DIR, `panel-iso-${testInfo.workerIndex}.png`), bytes)
    } finally {
      page.off('download', onDownload)
    }

    // ── 篡改判红：面板文本不是装饰 ─────────────────────────────────────────
    const before = await panel.locator('[data-manifest-canonical]').textContent()
    expect(before, '基线：篡改前面板 == 重算').toBe(expected.canonical)
    await page.evaluate(() => {
      const el = document.querySelector('[data-export-manifest-panel][data-manifest-format="iso-png"] [data-manifest-canonical]')
      if (el) el.textContent = 'tampered@0:req'
    })
    const after = await panel.locator('[data-manifest-canonical]').textContent()
    expect(after, '注入假条目后面板文本必须与重算值不同（对账因此判红）').not.toBe(expected.canonical)
    // digest 未被改：这正好证明"文本 != 重算"是可被抓到的（不是两边一起变）。
    await expect(panel.locator('[data-manifest-digest]')).toHaveText(String(expected.digest))
  })

  test('负对照：必需纹理不可用 ⇒ 零下载 + 无面板', { tag: '@smoke' }, async ({ page }) => {
    const broken = deriveAnimatedDocument(minimalBase())
    /**
     * 让**必需纹理**指向不存在的槽位（与 `export-iso-time` C5 同一手法）：
     * 文档照常加载，但装配期拿不到这份纹理 ⇒ 捕获/预检必须显式失败。
     * 不用"坏字节"：那会让页面在文档加载阶段就失败，测不到导出路径。
     */
    ;(broken.materialPalette as Record<string, unknown>[])[0]!.textureBlobIndex = 5
    await openExportTab(page, broken)
    const isoCard = page.locator('.ew-card', { has: page.locator('[data-iso-seconds]') })

    // 预览先失败（同一错误位），且**没有**面板。
    await expect(isoCard.locator('.ew-fb--err').first(), '坏纹理必须显式失败').toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-export-manifest-panel]'), '失败时不得残留面板').toHaveCount(0)

    const downloads: Download[] = []
    const onDownload = (d: Download): void => { downloads.push(d) }
    page.on('download', onDownload)
    try {
      await page.locator('[data-download-iso]').click()
      await page.waitForTimeout(1500)
      expect(downloads, '预检 blocked ⇒ 不得产出任何下载').toHaveLength(0)
    } finally {
      page.off('download', onDownload)
    }
    await expect(page.locator('[data-iso-dl-err]'), '失败必须在卡片里可见').toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-export-manifest-panel]'), '失败不得出现面板（也不得出现"零资源"的假面板）').toHaveCount(0)
  })
})
