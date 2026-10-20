/**
 * **M6-3 · 判据 ②（离屏与屏上同样本）+ N22（循环超限显式失败）**。
 *
 * ## 为什么 ② 是**门禁**而不是证据
 *
 * "导出与查看走同一条求值规则"（SPEC `:297`）唯一可**逐字段**断言的形态就是
 * "同一秒 ⇒ 同一组纹理样本"。它在 M6-3 之前**会红**：离屏端口从不 `bindTextures`、
 * 设备纹理域也从不进会话 ⇒ `samples` 是空数组（纯中性色产物）。故这条判据有把守力。
 *
 * | 判据 | 断言 |
 * |---|---|
 * | ② | 同一秒：作业 `outcome.sampling[0].samples` **逐字段**等于屏上 `textureSamples()` |
 * | ② 负对照 A | 视口 seek 到 `t+0.05` ⇒ 帧号**必须不同**（证明不是"读了同一份缓存"） |
 * | ② 负对照 B | 不给 `textureResources` ⇒ 作业样本为空（覆盖 M6-3 之前的真实缺口） |
 * | N22 | 生产入口 + 压低上限 ⇒ `textureLoopTooLong`，**零产物**（不是卡住） |
 *
 * ## 探针也走生产实现
 *
 * `ctx.kernelPresentationSnapshot()`（本批新增的公共读面，与屏上同一个求值点）+
 * `captureExportSnapshot` + `assembleSnapshotExportJob` + 真 `createThreeOffscreenDevice`。零替身。
 *
 * ⚠️ 定位是异步生效的：seek 之后必须**轮询到样本秒数 == 目标秒**再取读数（首跑实测过这个坑：
 * 直接读会拿到上一帧的 `seconds:0`）。
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import path from 'node:path'
import { gotoWorkbench, injectSceneDocumentOk, waitForViewportMounted } from './helpers/multiblock'
import { readJson } from './helpers/saveReopen'
import { TERMINAL_TEXTURE_STATES, waitTextureState } from './helpers/viewportPixels'

const FIXTURE = 'texture-strip-animated.v2.json'
const FIXTURE_PATH = path.join(import.meta.dirname, 'fixtures', FIXTURE)

interface SampleReport {
  readonly assetId: string
  readonly contentVersion: string
  readonly seconds: number
  readonly frame: number
  readonly nextFrame: number
  readonly mix: number
  readonly stripFrameCount: number
  readonly offsetY: number
  readonly repeatY: number
}

async function openFixture(page: Page): Promise<void> {
  await gotoWorkbench(page)
  await injectSceneDocumentOk(page, readJson(FIXTURE_PATH), FIXTURE)
  await waitForViewportMounted(page)
  expect(
    await waitTextureState(page, TERMINAL_TEXTURE_STATES, '动画竖条纹理终态', 180_000),
    '完好夹具的终态必须是 ready',
  ).toBe('ready')
}

/** seek 到某秒并**等视口真的落到那一秒**（返回该秒的样本）。 */
async function seekAndRead(page: Page, seconds: number): Promise<readonly SampleReport[]> {
  let last: readonly SampleReport[] = []
  await expect
    .poll(
      async () => {
        last = (await page.evaluate(async (sec: number) => {
          const mod = (await import('/e2e/helpers/m6-3/samplingParityProbe.ts')) as {
            seekViewport: (s: number) => boolean
            readViewportSamples: () => readonly unknown[]
          }
          mod.seekViewport(sec)
          return JSON.parse(JSON.stringify(mod.readViewportSamples())) as unknown[]
        }, seconds)) as SampleReport[]
        return last.length > 0 && Math.abs((last[0]?.seconds ?? Number.NaN) - seconds) < 1e-9
      },
      { timeout: 30_000, message: '视口样本必须落到 ' + seconds + 's（实测 ' + JSON.stringify(last.map((s) => s.seconds)) + '）' },
    )
    .toBe(true)
  return last
}

async function runExport(page: Page, seconds: number, bindTextures: boolean) {
  return (await page.evaluate(async (args: { sec: number; bind: boolean }) => {
    const mod = (await import('/e2e/helpers/m6-3/samplingParityProbe.ts')) as {
      runExportSamplesAt: (s: number, bind: boolean) => Promise<unknown>
    }
    return await mod.runExportSamplesAt(args.sec, args.bind)
  }, { sec: seconds, bind: bindTextures })) as {
    note: string
    status: string
    samples: readonly SampleReport[]
    framesRendered: number
    unboundSampleCount: number
    bytesLength: number
  }
}

test.describe('M6-3 · 导出与屏上**同样本**（判据 ②）', () => {
  test('同一秒 ⇒ 作业样本与屏上样本逐字段相等；两条负对照都必须判红', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '导出判据固定在 desktop-chrome')
    await openFixture(page)

    // ── ① 屏上：定位到 0.12s（该秒 = 帧 1）──
    const viewport = await seekAndRead(page, 0.12)
    expect(viewport.length, '屏上必须有样本（反空洞真）').toBeGreaterThan(0)
    expect(viewport[0]).toMatchObject({ frame: 1, stripFrameCount: 4, offsetY: 0.25, repeatY: 0.25 })

    // ── ② 作业：同一秒跑一次真导出 ──
    const job = await runExport(page, 0.12, true)
    console.log('[M6-3·parity] ' + JSON.stringify({ job: job.status, frames: job.framesRendered, samples: job.samples, bytes: job.bytesLength, viewport }))
    expect(job.status, '作业必须完成（note=' + job.note + '）').toBe('completed')
    expect(job.samples.length, '作业必须有样本（未绑纹理 ⇒ 0 条，判据当场判红）').toBeGreaterThan(0)
    expect(job.bytesLength, '产物必须非空').toBeGreaterThan(100)

    // ── ③ 逐字段相等（判据 ② 的门禁断言）──
    expect(job.samples, '同一秒的样本必须逐字段相等（差异见输出）').toEqual(viewport)
    for (const k of ['assetId', 'contentVersion', 'seconds', 'frame', 'nextFrame', 'mix', 'stripFrameCount', 'offsetY', 'repeatY'] as const) {
      expect(job.samples[0]![k], '字段 ' + k + ' 必须在场（缺席 = 形状漂移）').toBeDefined()
    }

    // ── ④ 负对照 A：视口移到**下一格**（夹具每格 100ms：0.12 在帧 1，0.25 在帧 2）⇒ 帧号必须不同 ──
    const shifted = await seekAndRead(page, 0.25)
    expect(shifted.length).toBeGreaterThan(0)
    expect(
      shifted[0]!.frame,
      '视口移到下一格后帧号必须与导出（t）不同 —— 否则"相等"可能只是读了同一份缓存',
    ).not.toBe(job.samples[0]!.frame)

    // ── ⑤ 负对照 B：不绑纹理 ⇒ 空样本（M6-3 之前的生产形态）──
    const unbound = await runExport(page, 0.12, false)
    expect(unbound.status).toBe('completed')
    expect(unbound.samples.length, '不绑纹理时作业样本必须为空（否则判据覆盖不到真实缺口）').toBe(0)
  })

  test('N22 · 循环超限 ⇒ 生产入口显式失败、零产物（不是卡住）', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '导出判据固定在 desktop-chrome')
    await openFixture(page)
    const r = (await page.evaluate(async () => {
      const mod = (await import('/e2e/helpers/m6-3/samplingParityProbe.ts')) as {
        runGifOverflowProbe: (o: { directionIndex?: number }) => Promise<unknown>
      }
      return await mod.runGifOverflowProbe({ directionIndex: 0 })
    })) as { note: string; ok: boolean; reason: string; frames: number; totalMs: number; producedBytes: number }
    console.log('[M6-3·N22] ' + JSON.stringify(r))

    expect(r.ok, '超限必须**失败**（成功 = 静默截断，那是另一种坏产物）').toBe(false)
    expect(r.reason, '失败原因必须是同一张上限表的码（不是"卡住"/超时）').toBe('textureLoopTooLong')
    expect(r.frames, '读数必须带帧数（可诊断）').toBeGreaterThan(1)
    expect(r.producedBytes, '失败路径**不得**产出任何字节').toBe(0)
  })
})
