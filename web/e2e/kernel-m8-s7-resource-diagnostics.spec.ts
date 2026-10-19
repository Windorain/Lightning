/**
 * M8-1 · S7：屏上**资源失败**必须产 resource.* 结构化诊断（码 + assetId）
 *
 * ## 判据要钉的语义（SPEC §7.4:256 + :252 + §10.7:309）
 *
 * 「失败不能一直显示为加载中」；「资源状态由实际请求与绑定事实推导」；
 * 「失败必须保留原有效状态或明确说明实际后果」。资源失败必须留下**可定位**的结构化
 * 记录：稳定码 + 是哪一项资源（assetId / locator），而不是一句自由文本。
 *
 * ## 画面形态（Q1 定稿；M8-5 按裁决定稿后**加断言**）
 *
 * M8-1 当时只把"坏图时整幅不挂载"作为**观测登记**打印，因为 Q1 未裁决。
 * 调度者裁决（Q1 暂定默认）后，本包把形态钉成判据：
 *
 * | 判据 | 语义 | 依据 |
 * |---|---|---|
 * | 视口**仍挂载**（`.vc-viewport` ≥ 1 且呈现会话有挂载批次） | 资源失败不夺视口 | SPEC §8:284「资源到达/失败…不得改变…正常视口寿命」 |
 * | **占位可观测**：挂载材质里"无 map"的条数 > 0 且"有 map"的条数 > 0 | 受影响图元降级、其余照常 | §7.4:256「可以按显示策略保留已有画面或显示占位，但状态与缺失范围必须可辨认」 |
 * | **点名**：底栏文案含该资源配置 locator 的前缀 | 缺失范围可辨认 | 同 §7.4:256 + S0-B D7 |
 *
 * ⚠️ 这三条**不是**把旧行为"改成绿"：旧形态在坏一张时 `mounted === 0`
 * （PX-2 实测），任何一条都会当场红（负对照见交付报告 §负对照）。
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

/**
 * Q1 画面形态读数（一次 evaluate 取齐；全是生产读面）。
 *
 * - `mounted`：`.vc-viewport` 数量（宿主是否还在）—— 旧形态坏一张时是 0；
 * - `batches`：呈现会话挂载的批次对象数（`statsSnapshot().batches`）；
 * - `mappedMaterials` / `degradedMaterials`：挂载网格的材质里"有 map"/"无 map"的条数
 *   —— 降级（占位）与正常显示在同一张画面上同时存在，才叫"受影响图元降级"；
 * - `statusText`：底栏实时状态文案（点名的落点）。
 */
async function readQ1Form(page: import('@playwright/test').Page): Promise<{
  mounted: number
  batches: number
  mappedMaterials: number
  degradedMaterials: number
  statusText: string
}> {
  return (await page.evaluate(() => {
    const vm = (window as any).__vm__
    const slot = vm?.viewports?.get?.('r-viewport') ?? null
    const surface = slot?.presenterSurface ?? null
    let batches = 0
    try {
      // 统计面字段是 `batchObjects`（`presentation/presenter#statsSnapshot`）
      batches = Number(surface?.statsSnapshot?.()?.batchObjects ?? 0)
    } catch {
      batches = 0
    }
    let mapped = 0
    let degraded = 0
    try {
      surface?.object3d?.traverse?.((o: any) => {
        if (o?.isMesh !== true && o?.isInstancedMesh !== true) return
        const m = Array.isArray(o.material) ? undefined : o.material
        if (m === undefined || m === null) return
        if (m.map === null || m.map === undefined) degraded += 1
        else mapped += 1
      })
    } catch {
      /* 读面失败按 0 计（会让判据红，不静默变绿） */
    }
    const live = document.querySelector('.sb-root [data-live-status]')
    return {
      mounted: document.querySelectorAll('.vc-viewport').length,
      batches,
      mappedMaterials: mapped,
      degradedMaterials: degraded,
      statusText: (live?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    }
  })) as {
    mounted: number
    batches: number
    mappedMaterials: number
    degradedMaterials: number
    statusText: string
  }
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
    // ── ③' 画面形态（Q1 定稿：不夺视口 + 占位可观测 + 点名）──
    const form = await readQ1Form(page)
    console.log('[S7-a] terminal=' + terminal + ' form=' + JSON.stringify(form))
    expect(form.mounted, '⚠️ Q1：坏一张贴图**不得**夺走视口（旧形态 mounted===0，PX-2 实测）').toBeGreaterThan(0)
    expect(form.batches, '呈现会话必须仍有挂载批次（画面还在，只是受影响图元降级）').toBeGreaterThan(0)
    expect(
      form.degradedMaterials,
      '⚠️ Q1：占位必须可观测 —— 至少一个挂载材质因资源未就绪而没有 map（降级图元）',
    ).toBeGreaterThan(0)
    expect(
      form.mappedMaterials,
      '其余内容必须照常显示 —— 至少一个挂载材质仍然带 map（否则是"全部降级"，不是"受影响图元降级"）',
    ).toBeGreaterThan(0)
    expect(form.statusText, '⚠️ Q1：底栏必须**点名**坏掉的资源（locator 前缀）').toContain(
      locator.split('/')[0]!,
    )
    expect(form.statusText, '底栏必须说明实际后果（视口保留）').toContain('视口保留')

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

  test('S7-c 失败资源可**重试**（D6）：底栏入口 ⇒ 新请求 + 新记录，且视口不因此消失', async ({ page }) => {
    test.setTimeout(480_000)
    const locator = firstMaterialLocator(fixturePath())
    await gotoWorkbench(page)
    await page.waitForFunction(() => typeof (window as any).__p7_input__?.counters === 'function', undefined, {
      timeout: 30_000,
    })
    await expect(page.locator(STATUS_BAR)).toBeVisible()
    await injectSceneDocumentOk(page, brokenFirstBlobEnvelope(fixturePath()), FIXTURE)
    const first = await waitTextureState(page, TERMINAL_TEXTURE_STATES, 'S7-c 首次终态', 180_000)
    expect(first, '前提：坏图必须先落到终态失败（否则无从"重试"）').toMatch(/^(missing|failed)$/)

    const seqAtBase = (await readDiagnostics(page)).at(-1)?.seq ?? 0

    // 底栏入口（Q1 的"点名"旁边就是那个动作）
    const retry = page.locator('[data-lk-resource-retry]')
    await expect(retry, '底栏必须提供**可点击**的重试入口（D6 的消费者）').toBeVisible()
    await retry.click()

    // 新请求必须是**可查询的事实**：resource.retryRequested，且点名失败资源
    await expect
      .poll(async () => (await readDiagnostics(page)).filter((r) => r.code === 'resource.retryRequested').length, {
        timeout: 60_000,
        intervals: [100, 200, 400],
      })
      .toBeGreaterThan(0)
    const all = await readDiagnostics(page)
    const retries = all.filter((r) => r.code === 'resource.retryRequested' && r.seq > seqAtBase)
    const named = retries.filter((r) => namesAsset(r, locator))
    console.log('[S7-c] retries=' + JSON.stringify(retries))
    expect(retries.length, '重试必须发 resource.retryRequested（否则"重试"在账上不可见）').toBeGreaterThan(0)
    expect(named.length, '重试记录必须点名上次失败的资源（assetId 或 locator）').toBeGreaterThan(0)
    expect(
      Number(retries[0]!.params.attempt),
      'attempt 必须 ≥ 1（0 = 首次请求；重试必须是**新**请求，SPEC §7.4:252）',
    ).toBeGreaterThanOrEqual(1)

    // 重试后仍是同一份坏字节 ⇒ 终态仍可辨认；**视口不得因此消失**
    const after = await waitTextureState(page, TERMINAL_TEXTURE_STATES, 'S7-c 重试后终态', 180_000)
    expect(after).toMatch(/^(missing|failed)$/)
    const form = await readQ1Form(page)
    console.log('[S7-c] after=' + after + ' form=' + JSON.stringify(form))
    expect(form.mounted, '重试不得夺走视口（资源生命周期变化不改变正常视口寿命）').toBeGreaterThan(0)
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
