/**
 * M8-1 · S4：丢失/恢复必须产出**结构化** device.* 诊断（含视口/代次关联字段）
 *
 * ## 判据要钉的语义（SPEC §10.7:309 + §19.9「诊断事件可观察」+ §8:287）
 *
 * 「失败必须保留原有效状态或明确说明实际后果；不可编辑不能表现为静默成功」——
 * 设备丢失/恢复这类"显示状态变化"必须留下**可机检**的记录：稳定码 + 关联字段。
 * 今天丢失/恢复路径上唯一的"诊断"是 three 自己两行英文 console.log
 * （node_modules/three/src/renderers/WebGLRenderer.js:671,679）—— 那是自由文本，
 * 不是 §19.7 要求的稳定码（"错误用稳定错误码与参数表达"）。
 *
 * ## 当前预期的红（S0-A D3）
 *
 * - 43 个稳定码里**没有任何 device.* 码**（application/diagnostics.ts:42-104，全文
 *   device 关键字命中 0）；
 * - presentation / resource 两个通道的**生产发射 = 0**（诊断记录器容量 512，
 *   生产只写 export / command / effect / content 四个通道）；
 * - DiagnosticCorrelation 只有 commandId/jobId/objectId/documentVersion/
 *   actual+targetPresentationVersion（diagnostics.ts:113-122）——**没有视口/代次字段**，
 *   多 Area 场景无法定位"是哪个视口丢了设备"。
 *
 * ⇒ 本用例先红。它钉的是**读面形状**，不是实现细节：
 *   ① 丢失 → 至少一条 device.* 记录；② 恢复 → 至少一条 device.* 记录；
 *   ③ 记录的关联字段必须能定位到视口；④ 通道必须是 device/presentation/resource 之一
 *   （不得借 effect 通道冒充）。
 *
 * ## 反假绿
 *
 * - 基线：注入**之前**读一次诊断，device.* 命中必须为 0（否则"注入后有一条"可能来自别处）；
 * - 强断言：记录的 params 必须非空（至少带实际原因），不许用"只更新计数器的空记录"过关；
 * - 通道断言：不得用 effect 通道的既有失败码冒充设备事件（那是 S0-B D7 的过渡口径）。
 */

import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

import { gotoWorkbench, injectSceneDocumentOk, waitForViewportMounted } from './helpers/multiblock/harness'
import { fixturePath } from './helpers/saveReopen'
import { STATUS_BAR, TERMINAL_TEXTURE_STATES, waitTextureState } from './helpers/viewportPixels'
import {
  installLossHooks,
  loseProductContext,
  m8CaseDir,
  POSE_A,
  readDiagnostics,
  restoreProductContext,
  setCameraPose,
  VIEWPORT_REGION,
  type DiagnosticFacts,
} from './helpers/m8/faults'

const FIXTURE = 'structuredata-exported-envelope.json'

/** 设备事件的稳定码族（M8-3 应落地的码；按族匹配，不钉具体拼写之外的东西）。 */
const DEVICE_CODE_PREFIX = 'device.'
/** 设备事件允许出现的通道（借 effect 通道不算；见 S0-B D7 的过渡口径）。 */
const DEVICE_CHANNELS = ['device', 'presentation', 'resource']

function deviceRecords(records: readonly DiagnosticFacts[]): DiagnosticFacts[] {
  return records.filter((r) => r.code.startsWith(DEVICE_CODE_PREFIX))
}

function correlationKeys(r: DiagnosticFacts): string[] {
  return Object.keys(r.correlation)
}

/** 关联字段是否能把事件定位到**视口**（字段名可以是 viewportId/regionId/region/viewport）。 */
function locatesViewport(r: DiagnosticFacts, rid: string): boolean {
  const keys = correlationKeys(r).concat(Object.keys(r.params))
  for (const k of keys) {
    if (!/viewport|region/i.test(k)) continue
    const v = String((r.correlation as Record<string, unknown>)[k] ?? r.params[k] ?? '')
    if (v === rid || v.includes(rid)) return true
  }
  return false
}

test.describe('M8-1 · S4 设备事件产结构化 device.* 诊断', () => {
  test('S4-a 丢失与恢复各产至少一条 device.* 记录，且能定位到视口', async ({ page }) => {
    test.setTimeout(420_000)
    const out = m8CaseDir('s4-a', test.info().project.name)
    const inputCopy = path.join(out, 'input-copy.json')
    fs.copyFileSync(fixturePath(), inputCopy)

    await gotoWorkbench(page)
    await page.waitForFunction(() => typeof (window as any).__p7_input__?.counters === 'function', undefined, {
      timeout: 30_000,
    })
    await injectSceneDocumentOk(page, JSON.parse(fs.readFileSync(inputCopy, 'utf8')), FIXTURE)
    await waitForViewportMounted(page)
    await expect(page.locator(STATUS_BAR)).toBeVisible()
    expect(await waitTextureState(page, TERMINAL_TEXTURE_STATES, 'S4 装载终态', 180_000)).toBe('ready')
    await setCameraPose(page, VIEWPORT_REGION, POSE_A)

    // ── ① 基线：注入前 device.* 必须为零（否则"注入后有一条"可能来自别处）──
    const baseline = await readDiagnostics(page)
    const before = deviceRecords(baseline)
    console.log(
      '[S4] baseline=' + JSON.stringify({
        total: baseline.length,
        device: before.length,
        codes: [...new Set(baseline.map((r) => r.code))],
      }),
    )
    expect(before.length, '基线：注入前不得有任何 device.* 记录（判据的分辨力前提）').toBe(0)

    // ── ② 真实丢失 → 读诊断 ──
    const hook = await installLossHooks(page, VIEWPORT_REGION)
    expect(hook.ok, '注入面必须可用：reason=' + String(hook.reason)).toBe(true)
    await loseProductContext(page)
    await page.waitForTimeout(1500)
    const seqAtLoss = baseline.at(-1)?.seq ?? 0
    const afterLoss = deviceRecords(await readDiagnostics(page)).filter((r) => r.seq > seqAtLoss)
    console.log('[S4] afterLoss=' + JSON.stringify(afterLoss))
    expect(
      afterLoss.length,
      '⚠️ S4/D3：真实上下文丢失必须产出至少一条 device.* 结构化诊断（当前码表没有任何 device.* 码，' +
        '生产丢失路径上只有 three 的两行英文 console.log）',
    ).toBeGreaterThan(0)
    for (const r of afterLoss) {
      expect(DEVICE_CHANNELS, '通道必须是 device/presentation/resource 之一（不得借 effect 通道冒充）').toContain(r.channel)
      expect(Object.keys(r.params).length, '记录必须带结构化参数（不许用空 params 过关）：' + JSON.stringify(r)).toBeGreaterThan(0)
      expect(
        locatesViewport(r, VIEWPORT_REGION) || correlationKeys(r).some((k) => /device|generation/i.test(k)),
        '⚠️ S4/D3：记录必须能定位到视口或设备代次（当前 DiagnosticCorrelation 没有这两个维度）：' + JSON.stringify(r),
      ).toBe(true)
    }

    // ── ③ 真实恢复 → 读诊断 ──
    const seqAtRecovery = (await readDiagnostics(page)).at(-1)?.seq ?? 0
    await restoreProductContext(page)
    await page.waitForTimeout(2500)
    const afterRestore = deviceRecords(await readDiagnostics(page)).filter((r) => r.seq > seqAtRecovery)
    console.log('[S4] afterRestore=' + JSON.stringify(afterRestore))
    expect(
      afterRestore.length,
      '⚠️ S4/D3：真实上下文恢复必须产出至少一条 device.* 结构化诊断（恢复完成/重建完成）',
    ).toBeGreaterThan(0)
    for (const r of afterRestore) {
      expect(DEVICE_CHANNELS, '通道必须是 device/presentation/resource 之一').toContain(r.channel)
      expect(Object.keys(r.params).length, '记录必须带结构化参数：' + JSON.stringify(r)).toBeGreaterThan(0)
    }
    // 丢失与恢复必须是**不同**的事件（否则一个码冒充两件事，判不出"恢复失败"）
    expect(
      new Set(afterLoss.concat(afterRestore).map((r) => r.code)).size,
      '丢失与恢复必须用可区分的码（一个码不得同时表示两件事）',
    ).toBeGreaterThan(1)
  })

  test('S4-b 负对照：不注入设备事件时 device.* 恒为零（码不是每帧刷屏的噪声）', async ({ page }) => {
    test.setTimeout(300_000)
    const out = m8CaseDir('s4-b', test.info().project.name)
    const inputCopy = path.join(out, 'input-copy.json')
    fs.copyFileSync(fixturePath(), inputCopy)

    await gotoWorkbench(page)
    await page.waitForFunction(() => typeof (window as any).__p7_input__?.counters === 'function', undefined, {
      timeout: 30_000,
    })
    await injectSceneDocumentOk(page, JSON.parse(fs.readFileSync(inputCopy, 'utf8')), FIXTURE)
    await waitForViewportMounted(page)
    expect(await waitTextureState(page, TERMINAL_TEXTURE_STATES, 'S4-b 装载终态', 180_000)).toBe('ready')
    await setCameraPose(page, VIEWPORT_REGION, POSE_A)
    await page.waitForTimeout(2000)

    const records = await readDiagnostics(page)
    const device = deviceRecords(records)
    console.log('[S4-b] total=' + records.length + ' device=' + device.length)
    expect(
      device.length,
      '负对照：没有设备事件时不得有 device.* 记录（否则 S4-a 的"注入后有一条"没有分辨率）。实测 ' +
        JSON.stringify(device),
    ).toBe(0)
  })
})
