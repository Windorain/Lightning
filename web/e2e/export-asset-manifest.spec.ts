/**
 * **R3-2 ③ · 资源清单随产物同行 —— 浏览器内真实作业 + Playwright 下载事件**。
 *
 * ## 本文件证什么（逐条对应任务书 ③）
 *
 * | 判据 | 落点 |
 * |---|---|
 * | 产物内 `assetId@contentVersion:req|opt` 排序串摘要 == `assetManifestDigest(assets)` | 「正对照」 |
 * | **负对照**：删一条 `required` ⇒ 摘要改变 **且** 预检返回 `ExportAssetNotReady` | 「负对照」 |
 * | 真实产物真的能被**下载**（清单随产物同行可机械对账） | 两个用例的 `download` 事件断言 |
 *
 * ## 为什么不登记进 `REAL_ARTIFACT_SPECS`
 *
 * `e2e/real-artifact-gate.ts:73-102` 那 4 份 spec 要的是**游戏内导出产物**
 * （`npm run acceptance:parts` / `npm run multiblock:export`）。本 spec 的产物由
 * **浏览器内作业**当场产出（真实 GL + 真实编码器），与那 4 份是不同的产物来源
 * ⇒ 按 R3-① 裁决**不**登记，靠本文件的 Playwright `download` 事件把守。
 *
 * ## 真实性与负对照
 *
 * 全程生产实现（见 `helpers/r3-2/assetManifestProbe.ts` 文件头）。负对照**不是**
 * "让测试自己抛错"：它是把**同一份**清单删掉一条必需资源后，让**生产预检**判它
 * —— 判红必须由被测实现给出（`ExportAssetNotReady`），而不是由测试断言手工构造。
 *
 * 夹具用仓库既有 `multiblock-tier-only.json`（`test-results` 之外无外部依赖）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { gotoWorkbench, injectSceneDocumentOk, readFixture, waitForViewportMounted } from './helpers/multiblock'

/** 证据落点（走既有 gitignore 的 `web/e2e/screenshots/`；上传 Gitea 后即持久）。 */
const OUT_DIR = path.join(import.meta.dirname, 'screenshots', 'r3-2-asset-manifest')

interface ProbeResult {
  note: string
  status: string
  derivationStatus: string
  carrier: string
  manifestLocation: string
  carrierFallbackReason: string | null
  assembled: boolean
  manifestReason: string | null
  entryCount: number
  digest: number
  canonical: string
  manifestJson: string
  digestMatchesEntries: boolean
  canonicalMatchesEntries: boolean
  bytesLength: number
  pngMagic: boolean
  framesRendered: number
  releasedFor: number
  negative: {
    removedAssetId: string | null
    digestChanged: boolean
    preflightStatus: string
    assetNotReadyIds: readonly string[]
  }
  errorReason: string | null
  cameraSource: 'content-bounds' | 'fallback'
}

async function runProbe(page: Page, options: { width?: number; height?: number }): Promise<ProbeResult> {
  return (await page.evaluate(async (opts) => {
    const mod = (await import('/e2e/helpers/r3-2/assetManifestProbe.ts')) as {
      runAssetManifestProbe: (o: typeof opts) => Promise<unknown>
    }
    return await mod.runAssetManifestProbe(opts)
  }, options)) as ProbeResult
}

test.describe('R3-2 · 资源清单随产物同行（浏览器内真实作业）', () => {
  test('真实产物 + 清单同行 + 摘要机械对账；下载事件证明清单真的随产物出来', { tag: '@smoke' }, async ({ page }, testInfo) => {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    await gotoWorkbench(page)
    const fx = readFixture('multiblock-tier-only.json')
    await injectSceneDocumentOk(page, fx.envelope, 'multiblock-tier-only.json')
    await waitForViewportMounted(page)
    await page.waitForTimeout(1500)

    const result = await runProbe(page, { width: 48, height: 48 })
    console.log('[R3-2·manifest] live =', JSON.stringify(result))

    // ① 作业真的完成，且需求是**由已装配图元反推**出来的（不是未装配的空清单）
    expect(result.status, `作业必须完成（note=${result.note} reason=${result.errorReason}）`).toBe('completed')
    expect(result.derivationStatus, '清单必须来自**已装配**的图元反推').toBe('derived')
    expect(result.entryCount, '反推出真实资源需求（本夹具带材质调色板 ⇒ 非空）').toBeGreaterThan(0)

    // ② 清单**随产物同行**：单文件产物字节不变 ⇒ sidecar 载体
    expect(result.carrier).toBe('sidecar')
    expect(result.manifestLocation).toBe('asset-manifest.json')
    expect(result.carrierFallbackReason).toBeNull()
    expect(result.assembled, '清单必须自报已装配').toBe(true)
    expect(result.manifestReason).toBeNull()

    // ③ 摘要口径：产物内规范串 == 排序后的 `assetId@contentVersion:req|opt`
    expect(result.digestMatchesEntries, '`assetManifestDigest(entries)` 必须等于清单摘要').toBe(true)
    expect(result.canonicalMatchesEntries, '规范串必须是排序行的 `\\n` 连接').toBe(true)
    expect(result.canonical.split('\n').filter((l) => l !== '').length).toBe(result.entryCount)
    for (const line of result.canonical.split('\n')) {
      expect(line, '每一行必须是 `assetId@contentVersion:req|opt`').toMatch(/^.+@.+:(req|opt)$/)
    }

    // 产物仍是**真 PNG**（载体不得损坏单文件产物）
    expect(result.pngMagic, '单文件产物必须仍是 PNG（字节不变）').toBe(true)
    expect(result.bytesLength).toBeGreaterThan(100)
    expect(result.framesRendered).toBe(1)
    expect(result.releasedFor).toBeGreaterThan(0)

    // **下载事件**：清单随产物同行 ⇒ 产物与清单都能被真的下载下来
    const manifestName = 'asset-manifest.json'
    const [manifestDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(
        async (args: { name: string; text: string }) => {
          const mod = (await import('/e2e/helpers/r3-2/assetManifestProbe.ts')) as {
            downloadText: (n: string, t: string) => void
          }
          mod.downloadText(args.name, args.text)
        },
        { name: manifestName, text: result.manifestJson },
      ),
    ])
    expect(manifestDownload.suggestedFilename()).toBe(manifestName)

    // 下载下来的内容与产物内清单**逐字节一致**，且摘要能机械对上。
    //
    // 读法用 `createReadStream` 而不是 `saveAs`：blob URL 的下载在 `saveAs` 上会
    // **偶发** `canceled`（实测两个 project 各 flaky 一次），而流式读取稳定，
    // 且内容判据一模一样（都是那份字节）。
    const manifestPath = path.join(OUT_DIR, `r3-2-manifest-${testInfo.workerIndex}.json`)
    const stream = await manifestDownload.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    const saved = Buffer.concat(chunks).toString('utf8')
    fs.writeFileSync(manifestPath, saved, 'utf8')
    expect(saved, '下载到的清单必须与产物内清单逐字节一致').toBe(result.manifestJson)
    const parsed = JSON.parse(saved) as { manifestVersion: string; digest: number; canonical: string; entries: readonly unknown[] }
    expect(parsed.manifestVersion).toBe('export-asset-manifest/1')
    expect(parsed.digest).toBe(result.digest)
    expect(parsed.canonical).toBe(result.canonical)
    expect(parsed.entries.length).toBe(result.entryCount)

    fs.writeFileSync(
      path.join(OUT_DIR, `r3-2-probe-${testInfo.workerIndex}.json`),
      JSON.stringify({ ...result, manifestJson: undefined, savedManifestSha: manifestPath.length }, null, 2),
      'utf8',
    )
  })

  test('**负对照**：删一条 `required` ⇒ 摘要改变 **且** 生产预检返回 `ExportAssetNotReady`', { tag: '@smoke' }, async ({ page }) => {
    await gotoWorkbench(page)
    const fx = readFixture('multiblock-tier-only.json')
    await injectSceneDocumentOk(page, fx.envelope, 'multiblock-tier-only.json')
    await waitForViewportMounted(page)
    await page.waitForTimeout(1500)

    const result = await runProbe(page, { width: 32, height: 32 })
    console.log('[R3-2·manifest] negative =', JSON.stringify(result.negative))

    expect(result.status, '负对照以正对照链路先跑通为前提').toBe('completed')
    expect(result.negative.removedAssetId, '必须真的删掉了一条资源').not.toBeNull()

    // (a) 对账当场发现差异（摘要具有区分力）
    expect(result.negative.digestChanged, '删一条必需资源必须改变清单摘要').toBe(true)

    // (b) 且判红由**生产预检**给出（不是测试手工构造的结论）：原始请求（含该必需资源）
    //     撞上一份缺了它的资源状态面 ⇒ 必须 blocked 且指名它。
    //     为什么请求侧不一起删：两边同时少同一条 ⇒ 对得上、恒 ready，判据就恒真了
    //     （探针第一版正是这么错的，实测 preflightStatus='ready'，此处即其回归防线）。
    expect(result.negative.preflightStatus, '少一条必需资源必须被生产预检判 blocked').toBe('blocked')
    expect(result.negative.assetNotReadyIds.length, '必须给出 `ExportAssetNotReady`').toBeGreaterThan(0)
    expect(result.negative.assetNotReadyIds).toContain(result.negative.removedAssetId as string)
  })
})
