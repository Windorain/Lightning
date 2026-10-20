/**
 * M8-1 · S3：恢复后旧代次不服役（设备代次是新旧资源的新旧判据）
 *
 * ## 判据要钉的语义（SPEC §7.5:262 + §6:206/208）
 *
 * 「设备资源从在有效设备上创建开始，到释放或设备失效结束。设备恢复创建新的有效设备资源，
 *  不能继续使用旧代次句柄」；「设备代次：句柄属于哪一次有效设备生命周期？」是 §6 的七个
 * 身份维度之一，且「这些维度不能互相代替」（:208）。
 *
 * 三条可判定事实：
 *  a. 丢失时旧代次份额必须被放弃（不是"留在账上继续算活跃"）；
 *  b. 恢复后必须出现新的设备代次号，且它不是结构世代（CompileGeneration）；
 *  c. 记账按 M8 调度者裁决②：balanced = acquired === released + abandoned
 *     （abandonAll 必须记账，否则丢失后 balanced 永久 false —— S0-A D8 的冲突）。
 *
 * ## 当前预期的红（S0-A D4/D7 + 裁决② 尚未落地）
 *
 * - 没有设备代次令牌：全树没有"设备代次计数器/令牌"这种东西；DeviceStateMachine 的
 *   heldGeneration 类型是 CompileGeneration（presentation/deviceState.ts:33）——
 *   用结构世代冒充设备代次（维度混用）。
 * - abandonAll 不记账：ownership.ts:205-212 不加 releaseTotal、ledger() 没有
 *   abandoned 字段（:177-196），只有 ownership.abandoned getter（:214-216）且无转发。
 * - 生产零接线：presenter.handleContextLost() 无人调用 ⇒ 旧份额根本没被放弃。
 *
 * ## 读面缺失时的表达口径（任务书要求）
 *
 * 设备代次读面当前不存在。故本文件：
 *  1. 对 (a) 用可观测代理表达：丢失后归属账的 activeCount 必须为 0
 *     且 abandoned 单列 > 0（"旧纹理/旧缓冲句柄不再被引用"的账面形态）；
 *  2. 对 (b) 直接读 deviceGeneration —— 读面不存在时如实读作 null 并判红，
 *     在失败消息里写明"设备代次读面是 M8-3 的前置"；
 *  3. 显式钉住"代次不等于结构世代"：恢复后结构世代必须回到同一个值（A30 的正确行为），
 *     而设备代次必须是另一个、更大的数。
 */

import { expect, test, type Page } from '@playwright/test'
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
  readViewportFacts,
  restoreProductContext,
  setCameraPose,
  VIEWPORT_REGION,
  type ViewportFacts,
} from './helpers/m8/faults'

const FIXTURE = 'structuredata-exported-envelope.json'

async function openReady(page: Page, inputCopy: string): Promise<void> {
  await gotoWorkbench(page)
  await page.waitForFunction(() => typeof (window as any).__p7_input__?.counters === 'function', undefined, {
    timeout: 30_000,
  })
  await injectSceneDocumentOk(page, JSON.parse(fs.readFileSync(inputCopy, 'utf8')), FIXTURE)
  await waitForViewportMounted(page)
  await expect(page.locator(STATUS_BAR)).toBeVisible()
  expect(await waitTextureState(page, TERMINAL_TEXTURE_STATES, 'S3 装载终态', 180_000)).toBe('ready')
}

function ledgerOf(f: ViewportFacts): NonNullable<ViewportFacts['presenter']['ledger']> {
  expect(f.presenter.ledger, '归属账读面必须可达（presenterSurface.ledger()）').not.toBeNull()
  return f.presenter.ledger!
}

test.describe('M8-1 · S3 恢复后旧代次不服役', () => {
  test('S3-a 丢失时旧代次份额必须被放弃（activeCount=0 且 abandoned 单列 > 0）', async ({ page }) => {
    test.setTimeout(420_000)
    const out = m8CaseDir('s3-a', test.info().project.name)
    const inputCopy = path.join(out, 'input-copy.json')
    fs.copyFileSync(fixturePath(), inputCopy)

    await openReady(page, inputCopy)
    await setCameraPose(page, VIEWPORT_REGION, POSE_A)
    // 前提：丢失前份额确实活跃（否则"丢失后为 0"可能只是账本来就空）
    const before = await readViewportFacts(page, VIEWPORT_REGION)
    const ledBefore = ledgerOf(before)
    console.log('[S3-a] before=' + JSON.stringify(ledBefore))
    expect(
      ledBefore.activeCount,
      '前提：装载后必须真的有活跃 GPU 份额（材质/几何各 acquire）。实测 ' + JSON.stringify(ledBefore),
    ).toBeGreaterThan(0)
    // 观测登记（不作前提断言）：未发生丢失时 abandonedTotal 应为 0；当前 ledger() 没有该字段
    // ⇒ 读作 null。它是 D7 的一部分，由下面"丢失后必须单列记账"那条主判据承担判红。
    console.log('[S3-a] before.abandonedTotal=' + String(ledBefore.abandonedTotal))

    const hook = await installLossHooks(page, VIEWPORT_REGION)
    expect(hook.ok, '注入面必须可用：reason=' + String(hook.reason)).toBe(true)
    await loseProductContext(page)
    await page.waitForTimeout(1200)

    const during = await readViewportFacts(page, VIEWPORT_REGION)
    const ledLost = ledgerOf(during)
    console.log('[S3-a] lost=' + JSON.stringify(ledLost))
    expect(
      ledLost.activeCount,
      '⚠️ S3/D7：丢失后旧代次的 GPU 份额必须全部放弃（activeCount 必须为 0）。实测 ' + JSON.stringify(ledLost),
    ).toBe(0)
    expect(
      ledLost.abandonedTotal,
      '⚠️ S3/裁决②：放弃必须单列记账（ledger() 必须有 abandonedTotal；当前无该字段 ⇒ 读作 null）',
    ).toBeGreaterThan(0)
    expect(ledLost.lastAbandonReason, '⚠️ S3/D7：放弃原因必须可读（不得只有一次性返回值）').toBeTruthy()
  })

  test('S3-b 恢复后必须出现新的设备代次，且它不等于结构世代', async ({ page }) => {
    test.setTimeout(420_000)
    const out = m8CaseDir('s3-b', test.info().project.name)
    const inputCopy = path.join(out, 'input-copy.json')
    fs.copyFileSync(fixturePath(), inputCopy)

    await openReady(page, inputCopy)
    await setCameraPose(page, VIEWPORT_REGION, POSE_A)
    const before = await readViewportFacts(page, VIEWPORT_REGION)
    const genBefore = before.presenter.generation
    const devBefore = before.presenter.deviceGeneration
    console.log('[S3-b] before gen=' + String(genBefore) + ' dev=' + String(devBefore))
    expect(
      genBefore,
      '前提：装载后必须有结构世代（presenterSurface.generation 非空；否则"同一个结构世代"无从谈起）',
    ).toBeTruthy()
    // 观测登记：设备代次的**基线**读数（当前不存在该读面 ⇒ null）
    console.log('[S3-b] baseline deviceGeneration=' + String(devBefore))

    const hook = await installLossHooks(page, VIEWPORT_REGION)
    expect(hook.ok, '注入面必须可用：reason=' + String(hook.reason)).toBe(true)
    await loseProductContext(page)
    await page.waitForTimeout(800)
    await restoreProductContext(page)
    await page.waitForTimeout(2500)

    const after = await readViewportFacts(page, VIEWPORT_REGION)
    const genAfter = after.presenter.generation
    const devAfter = after.presenter.deviceGeneration
    console.log('[S3-b] after gen=' + String(genAfter) + ' dev=' + String(devAfter))

    expect(
      typeof devAfter,
      '⚠️ S3/D4：**恢复后必须能读到新的设备代次**（"旧代次不服役"在结构上无法判定，' +
        '除非系统能标识"句柄属于哪一次设备生命周期"）。当前 presenterSurface 与 ledger 都没有该字段 ' +
        '⇒ 读作 null —— 这是 M8-3 的前置。实测 devBefore=' + String(devBefore) + ' devAfter=' + String(devAfter) +
        '（typeof=' + typeof devAfter + '）',
    ).toBe('number')
    expect(devAfter, '⚠️ S3：设备代次必须严格推进（新代次 > 旧代次）').toBeGreaterThan(devBefore as number)
    expect(genAfter, '恢复后结构世代必须回到同一个值（内容没变 ⇒ 同世代；A30 既有判据）').toBe(genBefore)
    expect(
      String(devAfter),
      '⚠️ S3 §6:208：设备代次不得用结构世代冒充（维度不能互相代替）',
    ).not.toBe(String(genAfter))
  })

  test('S3-c 恢复后新代次真的服役 + 记账按裁决②守恒（acquired = released + abandoned）', async ({ page }) => {
    test.setTimeout(420_000)
    const out = m8CaseDir('s3-c', test.info().project.name)
    const inputCopy = path.join(out, 'input-copy.json')
    fs.copyFileSync(fixturePath(), inputCopy)

    await openReady(page, inputCopy)
    await setCameraPose(page, VIEWPORT_REGION, POSE_A)
    const hook = await installLossHooks(page, VIEWPORT_REGION)
    expect(hook.ok, '注入面必须可用：reason=' + String(hook.reason)).toBe(true)
    await loseProductContext(page)
    await page.waitForTimeout(800)
    await restoreProductContext(page)
    await page.waitForTimeout(2500)

    const after = await readViewportFacts(page, VIEWPORT_REGION)
    const led = ledgerOf(after)
    console.log('[S3-c] after=' + JSON.stringify(led))

    // 新代次必须真的接手：恢复后重新 acquire 了 GPU 份额
    expect(
      led.activeCount,
      '⚠️ S3：恢复后新代次的份额必须重新建立（activeCount > 0）。实测 ' + JSON.stringify(led),
    ).toBeGreaterThan(0)
    // 裁决②：abandonAll 必须记账，否则丢失后 balanced 永久 false（S0-A D8）
    expect(
      typeof led.abandonedTotal,
      '⚠️ 裁决②：ledger() 必须给出 abandonedTotal（单列，不与 release 混）。实测 ' + JSON.stringify(led),
    ).toBe('number')
    expect(
      led.balanced,
      '⚠️ 裁决②/D8：丢失一个周期后账必须守恒（acquired === released + abandoned）。实测 ' + JSON.stringify(led),
    ).toBe(true)
  })
})