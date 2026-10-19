/**
 * **M6-4 · 导出诊断接线（SPEC 9：无法表达的语义必须诊断，不静默丢弃）**。
 *
 * ## 本文件证什么（真实浏览器 + 真实命令 + 真实下载）
 *
 * 在 M6-4 之前，导出的失败与损失只有两条出路：ctx.log.warn 自由文本与卡片红字；
 * "OBJ 把两帧竖条贴图压成首帧"这类事实连文案都没有（只写在产物注释行里）。
 *
 * 本 spec 跑**生产命令**（OPERATOR_EXPORT_OBJ / OPERATOR_EXPORT_ISO_PNG），
 * 然后读 ctx.getDiagnostics() 的 export 通道（只读读面，e2e 可取证）：
 *
 * | 判据 | 断言 |
 * |---|---|
 * | 命令被接收/完成 | export.requested + export.completed，后者带 delivery: 'panel' |
 * | OBJ 首帧纹理 | 两帧竖条贴图 ⇒ export.firstFrameOnly 且 frameCount === 2 |
 * | 零噪声 | 干净文档的 PNG 导出**没有** export.capabilityUnsupported |
 * | 失败结构化 | 坏纹理 ⇒ export.failed 且参数里带稳定 reason（不是 UI 文案） |
 */

import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { gotoWorkbench, injectSceneDocumentOk, waitForViewportMounted } from './helpers/multiblock'
import { deriveAnimatedDocument } from './helpers/export/animatedFixture'

/**
 * 读夹具（与 `export-iso-time` 同一手法：直接读 `e2e/fixtures`，不经 multiblock 的
 * 信封夹具目录 —— 那是另一套夹具形态）。
 */
function minimalBase(): Record<string, unknown> {
  const p = path.join(import.meta.dirname, 'fixtures', 'minimal-v2.json')
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
}

interface ExportRecord {
  readonly code: string
  readonly params: Record<string, string | number | boolean>
}

/** 读导出通道（只读读面；不必清空 —— 每条断言都按 format 过滤本用例自己的命令）。 */
async function exportDiagnostics(page: Page): Promise<readonly ExportRecord[]> {
  return (await page.evaluate(() => {
    const vm = (window as unknown as { __vm__: { getDiagnostics(): { byChannel(c: string): readonly { code: string; params: Record<string, string | number | boolean> }[] } } }).__vm__
    return vm.getDiagnostics().byChannel('export').map((r) => ({ code: r.code, params: r.params }))
  })) as readonly ExportRecord[]
}

test.describe('M6-4 · 导出诊断接线', () => {
  test('OBJ：两帧竖条贴图 ⇒ export.firstFrameOnly（不再只写注释行）', async ({ page }) => {
    await gotoWorkbench(page)
    const fx = deriveAnimatedDocument(minimalBase())
    await injectSceneDocumentOk(page, fx, 'm6-4-obj-diagnostics.v2.json')
    await waitForViewportMounted(page)
    await page.click('.wt-tab:has-text("导出")')
    await page.waitForSelector('.ew-root', { timeout: 20_000 })

    // 真命令 + 真下载（诊断由命令写，不是探针手工构造）。
    await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.evaluate(() => (window as any).__vm__.getOperators().exec('OPERATOR_EXPORT_OBJ', { mode: 'block' })),
    ])

    const records = await exportDiagnostics(page)
    const requested = records.find((r) => r.code === 'export.requested' && r.params.format === 'obj')
    expect(requested, 'OBJ 命令必须记录 export.requested').toBeDefined()
    expect(requested!.params.mode).toBe('block')

    const firstFrame = records.filter((r) => r.code === 'export.firstFrameOnly')
    expect(firstFrame.length, '两帧竖条贴图必须产出 export.firstFrameOnly').toBeGreaterThan(0)
    expect(firstFrame[0]!.params.frameCount, '必须报出真实格数（2 帧），不是布尔').toBe(2)

    // 跳过体素若出现，必须带计数（本夹具没有不可表达方块 ⇒ 不要求出现）。
    for (const r of records.filter((x) => x.code === 'export.geometrySkipped')) {
      expect(Number(r.params.voxelCount), '跳过体素必须带计数').toBeGreaterThan(0)
    }
  })

  test('PNG：完成事实带 delivery: panel，且干净文档无能力损失噪声', async ({ page }) => {
    await gotoWorkbench(page)
    const fx = deriveAnimatedDocument(minimalBase())
    await injectSceneDocumentOk(page, fx, 'm6-4-png-diagnostics.v2.json')
    await waitForViewportMounted(page)
    await page.click('.wt-tab:has-text("导出")')
    await page.waitForSelector('.ew-root', { timeout: 20_000 })

    await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.evaluate(() => (window as any).__vm__.getOperators().exec('OPERATOR_EXPORT_ISO_PNG', { direction: 0, seconds: 0 })),
    ])

    const records = await exportDiagnostics(page)
    const completed = records.filter((r) => r.code === 'export.completed' && r.params.format === 'png')
    expect(completed.length, 'PNG 命令必须记录 export.completed').toBeGreaterThan(0)
    const last = completed[completed.length - 1]!
    expect(last.params.delivery, 'Q8：清单交付在面板').toBe('panel')
    expect(Number(last.params.manifestEntries), '完成事实必须带清单条数').toBeGreaterThan(0)

    // 干净文档（整格方块，无注解/形变/轨道）⇒ 不得刷能力损失诊断。
    const capability = records.filter((r) => r.code === 'export.capabilityUnsupported')
    expect(capability, '干净文档不得出现 export.capabilityUnsupported：' + JSON.stringify(capability)).toHaveLength(0)
  })

  test('失败结构化：坏纹理 ⇒ export.failed 带稳定码（不是 UI 文案）', async ({ page }) => {
    await gotoWorkbench(page)
    const broken = deriveAnimatedDocument(minimalBase())
    ;(broken.materialPalette as Record<string, unknown>[])[0]!.textureBlobIndex = 5
    await injectSceneDocumentOk(page, broken, 'm6-4-bad-texture.v2.json')
    await waitForViewportMounted(page)
    await page.click('.wt-tab:has-text("导出")')
    await page.waitForSelector('.ew-root', { timeout: 20_000 })

    const downloads: string[] = []
    const onDownload = (): void => { downloads.push('x') }
    page.on('download', onDownload)
    try {
      await page.evaluate(() => (window as any).__vm__.getOperators().exec('OPERATOR_EXPORT_ISO_PNG', { direction: 0, seconds: 0 }))
        .catch(() => undefined)
      await page.waitForTimeout(1500)
      expect(downloads, '预检 blocked ⇒ 不得产出下载').toHaveLength(0)
    } finally {
      page.off('download', onDownload)
    }

    const records = await exportDiagnostics(page)
    const failed = records.filter((r) => r.code === 'export.failed')
    expect(failed.length, '失败必须写 export.failed（不是只有 log.warn）').toBeGreaterThan(0)
    const last = failed[failed.length - 1]!
    // 结构化 = 领域错误码 + 稳定 reason（不是一句 UI 文案）。
    // 注意：`assetState` 的 `detail` 是领域层的人读说明（如"仅有占位（loading）"），
    // 它**不是** UI 翻译文案 —— 判据只要求"码与 reason 在场且可断言"。
    expect(String(last.params.code ?? ''), '失败事实必须带领域错误码').not.toBe('')
    expect(
      ['MissingTarget', 'UnsupportedOperation', 'InvalidValue', 'WouldBlock'],
      `失败码必须是契约里的八码之一（实得 ${String(last.params.code)}）`,
    ).toContain(String(last.params.code))
    expect(String(last.params.reason ?? ''), '失败事实必须带稳定 reason').not.toBe('')
    expect(String(last.params.reason), 'reason 必须是 ASCII 稳定码').toMatch(/^[A-Za-z][A-Za-z0-9]*$/)
  })
})
