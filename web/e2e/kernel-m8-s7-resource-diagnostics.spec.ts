/**
 * M8-1 · S7：屏上**资源失败**必须产 resource.* 结构化诊断（码 + assetId）
 *
 * ## 判据要钉的语义（SPEC §7.4:256 + :252 + §10.7:309）
 *
 * 「失败不能一直显示为加载中」；「资源状态由实际请求与绑定事实推导」；
 * 「失败必须保留原有效状态或明确说明实际后果」。资源失败必须留下**可定位**的结构化
 * 记录：稳定码 + 是哪一项资源（assetId / locator），而不是一句自由文本。
 *
 * ## 本判据**不钉画面形态**（用户 Q1 未裁决）
 *
 * 坏图时"整幅不挂载"还是"保留画面 + 占位"是产品裁决项（计划 §5 M8-5 的 Q1）。
 * 因此本文件只钉**诊断发射**，并把当前画面形态（mounted 数）作为**观测登记**打印，
 * 不写进断言 —— 否则等于替用户把 Q1 定了。
 *
 * ## 当前预期的红（S0-B §3.4 / D2 + D7）
 *
 * 装载期材质库走 legacy 整库（buildMaterialLibrary 的 Promise.all + 逐项 throw）⇒
 * 坏一张贴图时 loadStatus='error'，**只留一句 console.error**
 * （runtime/drwMeshPipeline.ts:500-505/526-531）。生产 record(...) 发射点共 10 处，
 * 没有一处在资源装载失败路径上；resource.* 三码（acquired/released/leaked）
 * 生产发射 0。⇒ 本判据先红。
 *
 * ## 输入走生产路径（PX-2 先例）
 *
 * 坏 blob 由 saveReopen#brokenFirstBlobEnvelope 构造（把第一项 textureBlobs 换成非法
 * base64，改的是内存副本，夹具原件不动），装载走生产算子 OPERATOR_OPEN_SCENE + File
 * —— 与 kernel-texture-pixels.spec.ts:215-254 的 PX-2 同一份损坏构造与同一条入口。
 */

import { expect, test } from '@playwright/test'

import { gotoWorkbench, injectSceneDocumentOk } from './helpers/multiblock/harness'
import { brokenFirstBlobEnvelope, fixturePath, firstMaterialLocator, readJson } from './helpers/saveReopen'
import { STATUS_BAR, TERMINAL_TEXTURE_STATES, waitTextureState } from './helpers/viewportPixels'
import { readDiagnostics, type DiagnosticFacts } from './helpers/m8/faults'

const FIXTURE = 'structuredata-exported-envelope.json'

/** 资源失败可能出现的码族/通道（M8-5 应落地；此处按族与通道匹配）。 */
const RESOURCE_CODE_PREFIX = 'resource.'
const RESOURCE_CHANNELS = ['resource', 'presentation']

function resourceRecords(records: readonly DiagnosticFacts[]): DiagnosticFacts[] {
  return records.filter((r) => r.code.startsWith(RESOURCE_CODE_PREFIX) || RESOURCE_CHANNELS.includes(r.channel))
}

/** 记录里是否点名了某个资源（assetId / locator / asset 参数中含该串）。 */
function namesAsset(r: DiagnosticFacts, hint: string): boolean {
  const blob = JSON.stringify(r.params) + JSON.stringify(r.correlation)
  return blob.includes(hint)
}

test.describe('M8-1 · S7 资源失败产 resource.* 诊断', () => {
  test('S7-a 坏一张必需贴图 ⇒ 屏上侧产 resource.* 记录，且点名该资源', async ({ page }) => {
    test.setTimeout(480_000)
    const locator = firstMaterialLocator(fixturePath())
    console.log('[S7-a] 损坏的资源 locator=' + locator)

    await gotoWorkbench(page)
    await page.waitForFunction(() => typeof (window as any).__p7_input__?.counters === 'function', undefined, {
      timeout: 30_000,
    })
    await expect(page.locator(STATUS_BAR)).toBeVisible()

    // ── ① 基线：装载之前不得已有 resource.* 记录 ──
    const baseline = resourceRecords(await readDiagnostics(page))
    const seqAtBase = (await readDiagnostics(page)).at(-1)?.seq ?? 0
    expect(baseline.length, '基线：装载之前不得已有 resource.* 记录（判据的分辨力前提）').toBe(0)

    // ── ② 生产入口注入**坏一张**（PX-2 的同一份构造）──
    await injectSceneDocumentOk(page, brokenFirstBlobEnvelope(fixturePath()), FIXTURE)

    // ── ③ 终态必须可辨认（今天成立：data-texture-state 落到 missing/failed）──
    const terminal = await waitTextureState(page, TERMINAL_TEXTURE_STATES, 'S7 损坏场景终态', 180_000)
    expect(terminal, '前提：坏图的终态必须是 missing/failed（不得停在 loading，也不得报 ready）').toMatch(
      /^(missing|failed)$/,
    )
    // 观测登记（不钉形态）：Q1 未裁决前不把"整幅不挂载"写进断言
    const mounted = await page.evaluate(() => document.querySelectorAll('.vc-viewport').length)
    console.log('[S7-a] terminal=' + terminal + ' mountedViewports=' + mounted + '（画面形态属 Q1，未裁决前只登记）')

    // ── ④ 主判据：必须有 resource.* 结构化诊断，且点名该资源 ──
    const all = await readDiagnostics(page)
    const records = resourceRecords(all).filter((r) => r.seq > seqAtBase)
    const named = records.filter((r) => namesAsset(r, locator))
    console.log(
      '[S7-a] resourceRecords=' + JSON.stringify(records) +
        ' named=' + JSON.stringify(named) +
        ' allCodes=' + JSON.stringify([...new Set(all.map((r) => r.code))]),
    )
    expect(
      records.length,
      '⚠️ S7/D2：屏上资源失败必须产 resource.* 结构化诊断（当前装载面只 console.error，' +
        'resource.* 三码生产发射 0）',
    ).toBeGreaterThan(0)
    expect(
      named.length,
      '⚠️ S7/D7：诊断必须**点名**失败的那一项资源（assetId / locator 含 "' + locator + '"），' +
        '只有计数不算可定位。实测记录=' + JSON.stringify(records),
    ).toBeGreaterThan(0)
    for (const r of named) {
      expect(Object.keys(r.params).length, '诊断参数不得为空：' + JSON.stringify(r)).toBeGreaterThan(0)
    }
  })

  test('S7-b 负对照：完好场景不产资源失败类记录（这条判据不是恒真）', async ({ page }) => {
    test.setTimeout(420_000)
    await gotoWorkbench(page)
    await page.waitForFunction(() => typeof (window as any).__p7_input__?.counters === 'function', undefined, {
      timeout: 30_000,
    })
    await expect(page.locator(STATUS_BAR)).toBeVisible()
    await injectSceneDocumentOk(page, readJson(fixturePath()), FIXTURE)

    const terminal = await waitTextureState(page, TERMINAL_TEXTURE_STATES, 'S7-b 完好场景终态', 180_000)
    expect(terminal, '前提：完好场景必须到达 ready').toBe('ready')

    const records = resourceRecords(await readDiagnostics(page))
    // 完好装载不得产生"资源失败"记录（成功类记录允许：acquired 等；故只排失败/缺失码）
    const failures = records.filter((r) => /fail|missing|error/i.test(r.code))
    console.log('[S7-b] terminal=' + terminal + ' resourceRecords=' + records.length + ' failures=' + failures.length)
    expect(
      failures,
      '负对照：完好场景不得产"资源失败"类记录（否则 S7-a 的"坏图有记录"没有区分力）。实测 ' +
        JSON.stringify(failures),
    ).toEqual([])
  })
})
