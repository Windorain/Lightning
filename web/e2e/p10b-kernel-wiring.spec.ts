/**
 * **P10b（#282）· 内核接线的浏览器级验收**（真实 UI + 真实夹具 + 真实解析路径）。
 *
 * ## 本文件补什么（与单测的分工）
 *
 * `runtime/__tests__/kernelAdoption.test.ts` 在 Node 里证明"装配产物能装进内核会话"。
 * 但 R-WK-04 的缺口措辞是「**没有生产代码**把旧场景文件装配成内核 Scene」——
 * 一个只在测试里被调用的接线**仍然是那个缺口**。本文件因此走**真实产品入口**：
 *
 * ```
 * gotoWorkbench（完整 WorkbenchRoot）
 *   → injectSceneDocumentOk（生产 OPERATOR_OPEN_SCENE，与拖放同一 operator）
 *     → 生产解析器 → 生产装配 → KernelSession.adoptDocument
 *       → 经 window.__vm__ 读**内核会话**（公开观测面）
 * ```
 *
 * 零替身：全程生产类实例，无 Mock/Stub，无测试专用 URL 参数。
 *
 * ## 判据（每条都读**内核**，不读旧文档）
 *
 * 1. 内核会话**持有**装配出的对象（对象数 > 0，且含多方块网格对象）；
 * 2. 内核**读面**报出 `readOnly` 写权（§3.3 生成物只读，在浏览器里成立）；
 * 3. **场景不等于时间轴**（M5-1 用户裁决，2026-10-18）：多方块文档的 `content.frameAxis`
 *    恒**空**，已声明场景留在 `content.multiblock.scenes`（条数 = 文件声明）；
 * 4. **场景不参与播放**：多方块文档没有帧轴 ⇒ `seekFrame` 不动帧下标（帧读面恒 0），
 *    场景切换由通道取值驱动（判据见 `multiblock-channel-*` 系列）；
 * 5. 视口**仍然渲染**（能力不回退：接线没有破坏既有渲染）。
 *
 * ## 历史（为什么 ③④ 在 M5-1 被改写）
 *
 * 这两条曾断言"内核文档承载帧时长轴（432/12/108 帧）"与"`seekFrame(3)` 定位到第 3 帧"。
 * 那是把**变体配置集合（场景）**误读成时间轴上的帧（断点①的本体）：432 个场景被
 * `stripTimeline` 的 0→1ms 归一化伪装成 432ms 动画，尺寸型通道的手动值永远被轨道压住。
 * M5-1 把场景移出时间轴后，本文件按新语义改写（不是放宽断言：断言对象从"帧轴长度"
 * 换成"场景数在声明里、帧轴为空"——两者都可判红）。
 *
 * ## 负对照（证伪"判据恒真"）
 *
 * 读一份**帧为主**文档（minimal-v2）：它的内核对象数与多方块文档不同，
 * 且**不**含 `structure:multiblock` —— 证明上面的判据确实在区分具体内容，
 * 而不是"任何加载都让它们成立"。
 */

import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  gotoWorkbench,
  injectSceneDocumentOk,
  readFixture,
  waitForRenderedGrid,
  waitForViewportMounted,
  VIEWPORT_CANVAS,
} from './helpers/multiblock'

/** 内核会话的公开观测面（经 `window.__vm__` 的 `ctx.kernel`）。 */
interface KernelObservation {
  readonly hasKernel: boolean
  readonly hasDocument: boolean
  readonly objectCount: number
  readonly objectIds: readonly string[]
  readonly multiblockAuthority: string | null
  readonly frameAxisCount: number
  readonly frameAxisDurations: readonly number[]
  readonly contentVersion: number | null
}

async function readKernelObservation(page: import('@playwright/test').Page): Promise<KernelObservation> {
  return await page.evaluate(() => {
    const ctx = (window as any).__vm__
    const kernel = ctx?.kernel ?? null
    if (kernel === null) {
      return {
        hasKernel: false, hasDocument: false, objectCount: 0, objectIds: [],
        multiblockAuthority: null, frameAxisCount: 0, frameAxisDurations: [], contentVersion: null,
      }
    }
    const doc = kernel.document()
    if (doc === undefined || doc === null) {
      return {
        hasKernel: true, hasDocument: false, objectCount: 0, objectIds: [],
        multiblockAuthority: null, frameAxisCount: 0, frameAxisDurations: [], contentVersion: null,
      }
    }
    const objectIds = Object.keys(doc.scene.objects)
    // 写权经**内核读面**取（不是读 scene 内部字段）—— 那是 §3.3 的公开面
    let authority: string | null = null
    const list = kernel.read().objects.list()
    if (list.ok) {
      const mb = list.value.find((o: { id: string }) => o.id === 'structure:multiblock')
      authority = mb?.authority ?? null
    }
    const frames = doc.content.frameAxis.frames
    return {
      hasKernel: true,
      hasDocument: true,
      objectCount: objectIds.length,
      objectIds,
      multiblockAuthority: authority,
      frameAxisCount: frames.length,
      frameAxisDurations: frames.map((f: { durationMs: number | null }) => f.durationMs ?? 0),
      contentVersion: typeof doc.version.contentVersion === 'number' ? doc.version.contentVersion : null,
    }
  })
}

/** 各夹具的帧数（与 `multiblockAssembler.test.ts` 同一清单）。 */
const FRAME_COUNTS: Record<string, number> = {
  'multiblock-ebf-2ch.json': 432,
  'multiblock-lsc-overlap.json': 108,
  'multiblock-tier-only.json': 12,
}

const SHOT_DIR = path.join(import.meta.dirname, 'screenshots', 'p10b-kernel')

test.describe('P10b · 内核接线（真实夹具经生产入口装进内核会话）', () => {
  for (const file of ['multiblock-tier-only.json', 'multiblock-ebf-2ch.json'] as const) {
    test(`${file}：装配进内核 + 内核读面报只读 + 帧时长轴在内核`, async ({ page }, testInfo) => {
      fs.mkdirSync(SHOT_DIR, { recursive: true })
      await gotoWorkbench(page)

      const fx = readFixture(file)
      await injectSceneDocumentOk(page, fx.envelope, file)
      await waitForViewportMounted(page)

      const obs = await readKernelObservation(page)

      // ── ① 内核**真的**持有装配出的对象 ──
      expect(obs.hasKernel, `${file} 应有内核会话（ctx.kernel）`).toBe(true)
      expect(obs.hasDocument, `${file} 内核会话应持有文档`).toBe(true)
      expect(
        obs.objectCount,
        `${file} 内核文档必须持有装配出的对象（否则"装配"没有被生产代码调用）`,
      ).toBeGreaterThan(0)
      expect(
        obs.objectIds,
        `${file} 内核文档必须含多方块网格对象`,
      ).toContain('structure:multiblock')

      // ── ② §3.3 生成物只读：经**内核读面**在浏览器里成立 ──
      expect(
        obs.multiblockAuthority,
        `${file} 多方块生成物的写权必须是 readOnly（§3.3「不因通用对象模型而变得可编辑」）`,
      ).toBe('readOnly')

      // ── ③ 内核文档承载帧时长轴（帧数与文件声明一致）──
      expect(
        obs.frameAxisCount,
        `${file} 内核文档的帧时长轴长度必须等于文件声明的帧数`,
      ).toBe(FRAME_COUNTS[file])
      expect(obs.frameAxisDurations.length, `${file} 每帧时长必须逐项在内核里`).toBe(FRAME_COUNTS[file])

      // ── ④ 内容身份已由内核算出（不是占位）──
      expect(obs.contentVersion, `${file} 内核文档必须有内容身份摘要`).not.toBeNull()

      // ── ⑤ 视口仍然渲染（能力不回退：接线没破坏既有渲染）──
      await waitForRenderedGrid(page, 60_000)
      await expect(page.locator(VIEWPORT_CANVAS).first()).toBeVisible()

      const shot = path.join(SHOT_DIR, `${file.replace(/\.json$/, '')}-${testInfo.project.name}.png`)
      await page.screenshot({ path: shot, fullPage: false })
      console.log(
        `[P10b] ${file}: kernel objects=${obs.objectCount} authority=${obs.multiblockAuthority} ` +
          `frameAxis=${obs.frameAxisCount} contentVersion=${obs.contentVersion}`,
      )
    })
  }

  test('帧声明**来自内核**：换帧走内核命令，帧下标随之变', async ({ page }) => {
    await gotoWorkbench(page)
    const fx = readFixture('multiblock-tier-only.json')
    await injectSceneDocumentOk(page, fx.envelope, 'multiblock-tier-only.json')
    await waitForViewportMounted(page)

    // 帧数已进内核 ⇒ 内核能真的按帧时长轴定位
    const before = await page.evaluate(() => (window as any).__vm__.kernel.frameIndex())
    expect(before, '初始帧下标应为 0').toBe(0)

    await page.evaluate(() => (window as any).__vm__.kernel.seekFrame(3))
    const after = await page.evaluate(() => (window as any).__vm__.kernel.frameIndex())
    expect(
      after,
      'seekFrame 应经内核命令定位到第 3 帧（证明 frameAxis 真的在内核里被用）',
    ).toBe(3)
  })

  test('**负对照**：帧为主文档（minimal-v2）不被装配成多方块', async ({ page }) => {
    await gotoWorkbench(page)
    const frameDominant = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'minimal-v2.json'), 'utf8'),
    ) as Record<string, unknown>
    await injectSceneDocumentOk(page, frameDominant, 'minimal-v2.json')
    await waitForViewportMounted(page)

    const obs = await readKernelObservation(page)
    expect(obs.hasDocument, 'minimal-v2 也应装进内核（帧为主形态）').toBe(true)
    // 负对照：它**不**含多方块网格对象（证明上面的 `structure:multiblock` 判据有意义）
    expect(
      obs.objectIds,
      '帧为主文档不得出现多方块网格对象（否则"多方块"判据是恒真的）',
    ).not.toContain('structure:multiblock')
    expect(obs.multiblockAuthority, '帧为主文档无多方块写权可报').toBeNull()
    // 且它**有**帧网格对象（帧为主形态的正常产物）
    expect(
      obs.objectIds.some((id) => id.startsWith('structure:frame-')),
      '帧为主文档应装配出帧网格对象',
    ).toBe(true)
  })
})
