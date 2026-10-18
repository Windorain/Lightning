/**
 * M8-1 · **S2：设备丢失 → 恢复，四面保留 + 画面回来**（对**产品画布**注入真实上下文丢失）
 *
 * ## 判据要钉的语义（SPEC §7.5:264 + §8:287）
 *
 * 「设备恢复保留内容、选择、时间和机位，并从当前有效状态重建受影响的呈现资源；
 *  不把重新打开文件作为正常设备恢复机制」；「设备丢失/恢复只改受影响的图形资源与
 * 显示状态，不得改文档内容、保存基线、编辑上下文」。
 *
 * ⇒ 四条：① 画面必须回来（不是永久空白）；② 内容/选择/时间/机位四项**逐字段**不变；
 * ③ 现场未被扰动（画布是**同一个元素**、宿主未重挂、文档身份不变）；
 * ④ 不得以"重开文件"充当恢复（文档身份/装载未被换掉）。
 *
 * ## 注入面（S0-A §4.4 判定的实测化；src/ 一行不改）
 *
 * 产品画布 = ctx.viewports.get('r-viewport').domElement.value（attachViewport 写进去的就是它）。
 * 对它取**已存在**的 GL 上下文 → 取 WEBGL_lose_context → loseContext()/restoreContext()。
 * 这是浏览器规范的设备丢失路径，与 GPU 掉电/驱动重置同一条派发链；
 * 不是产品钩子（产品没有任何注入钩子，S0-B §5.1 实测 0 命中）。
 *
 * ## 先红预期（S0-A D1/D2）
 *
 * 「丢失 → 呈现会话 handleContextLost() 被调用」这条接线**生产零调用方**
 * （src/ 只有定义处 2 文件 + 会话内部转调 1 处；canvas 监听只 preventDefault + onResize）。
 * 于是"处置"完全依赖 three 自己的丢失/恢复处理。**four faces 因此是"偶然保住"**，
 * 而"画面是否回来"取决于 three 惰性重传是否完整 —— 这一条 S0-A 明确标注**未实测**。
 * 本用例的价值就在于把它变成实测读数：绿要给出机制解释，红就是 D1/D2 的直接证据。
 *
 * ## 反假绿（四条，缺一条判据就可疑）
 *
 * 1. **挪离默认值**：机位/时间/选择/内容四项都必须先离开默认值，否则"不变"可能只是
 *    "本来就是默认值"（机位用 main.ensureCamera 写权威；时间用真播放推进；选择用生产
 *    API 选一格带注解的方块；内容用右栏真实输入改一格说明）。
 * 2. **丢失真的发生了**：webglcontextlost 事件计数 > 0 **且** gl.isContextLost() === true
 *    （只信事件不够：A30 已记过"恢复半程在仍 lost 时执行"的教训）。
 * 3. **画面读面有区分力**：丢失期的帧必须是**空白**（否则"恢复后非空白"可能恒真）。
 * 4. **同一元素**：恢复后画布必须还是被标记过的那个 canvas 元素（数量相等不算证据）。
 */

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

import { gotoWorkbench, injectSceneDocumentOk, waitForViewportMounted } from './helpers/multiblock/harness'
import { TOOLTIP_FIELD, fixturePath, firstAnnotatedCell, innerDocOf, selectCell, writeField } from './helpers/saveReopen'
import { sampleViewport, STATUS_BAR, waitTextureState, TERMINAL_TEXTURE_STATES, type ViewportSample } from './helpers/viewportPixels'
import { blankViolations } from './helpers/multiblock/pixels'
import { signatureDiff } from './helpers/multiblock/pixels'
import {
  advanceSceneTimeOffDefault,
  installLossHooks,
  loseProductContext,
  m8CaseDir,
  POSE_A,
  readViewportFacts,
  restoreProductContext,
  selectFirstAnnotatedCell,
  setCameraPose,
  VIEWPORT_REGION,
  type ViewportFacts,
} from './helpers/m8/faults'

const FIXTURE = 'structuredata-exported-envelope.json'

/** 反复采样直到非空白（或超时）；返回最后一次读数与失败时的全部违规项。 */
async function sampleUntilNotBlank(
  page: Page,
  rid: string,
  label: string,
  timeout = 45_000,
): Promise<{ sample: ViewportSample | null; violations: string[]; attempts: number }> {
  const deadline = Date.now() + timeout
  let attempts = 0
  let last: ViewportSample | null = null
  let violations: string[] = ['（一次都没采到）']
  for (;;) {
    attempts += 1
    try {
      last = await sampleViewport(page, rid, ['ready'], label + '（第 ' + attempts + ' 次）')
      violations = blankViolations(last.stats)
      if (violations.length === 0) return { sample: last, violations, attempts }
    } catch (e) {
      violations = ['采样被拒：' + (e as Error).message.split('\n')[0]!]
    }
    if (Date.now() > deadline) return { sample: last, violations, attempts }
    await page.waitForTimeout(250)
  }
}

/** 四面的可比较签名（只取判据关心的字段；引擎矩阵单独按容差比）。 */
function faceSignature(f: ViewportFacts): Record<string, unknown> {
  return {
    contentDigest: f.content.digest,
    documentId: f.content.documentId,
    annotations: f.content.annotations,
    selectionItems: f.selection.items,
    selectionActive: f.selection.active,
    selectionMode: f.selection.mode,
    cameraLogical: f.camera.logical,
    // 时间面用**时间签名**（frame + fps）：fps 无效时 seconds 恒 0，会把"时间真的动了"误读成"没动"
    timeSignature: 'frame=' + String(f.time.frame) + ';fps=' + JSON.stringify(f.time.fps),
    timeSeconds: f.time.seconds,
  }
}

function expectEngineClose(actual: ViewportFacts, expected: ViewportFacts, label: string): void {
  expect(actual.camera.engine.m, label + '：引擎相机必须存在').not.toBeNull()
  expect(expected.camera.engine.m, label + '：基线引擎相机必须存在').not.toBeNull()
  expect(actual.camera.engine.m!.length, label + '：矩阵长度').toBe(expected.camera.engine.m!.length)
  for (let i = 0; i < expected.camera.engine.m!.length; i++) {
    expect(
      Math.abs(actual.camera.engine.m![i]! - expected.camera.engine.m![i]!),
      label + '：matrixWorld[' + i + '] ' + actual.camera.engine.m![i] + ' vs ' + expected.camera.engine.m![i],
    ).toBeLessThan(1e-3)
  }
  expect(actual.camera.engine.zoom, label + '：zoom').toBeCloseTo(expected.camera.engine.zoom ?? NaN, 4)
  expect(actual.camera.engine.frustum, label + '：正交取景框').toEqual(expected.camera.engine.frustum)
}

test.describe('M8-1 · S2 设备丢失/恢复保留四面', () => {
  test('S2-a 产品画布真实丢失→恢复：画面回来，内容/选择/时间/机位逐字段不变，现场未被扰动', async ({ page }) => {
    test.setTimeout(480_000)
    const out = m8CaseDir('s2-a', test.info().project.name)
    const inputCopy = path.join(out, 'input-copy.json')
    fs.copyFileSync(fixturePath(), inputCopy)
    const target = firstAnnotatedCell(innerDocOf(inputCopy))

    // ── ① 生产入口装载 ──
    await gotoWorkbench(page)
    await page.waitForFunction(() => typeof (window as any).__p7_input__?.counters === 'function', undefined, {
      timeout: 30_000,
    })
    await injectSceneDocumentOk(page, JSON.parse(fs.readFileSync(inputCopy, 'utf8')), FIXTURE)
    await waitForViewportMounted(page)
    await expect(page.locator(STATUS_BAR)).toBeVisible()
    expect(
      await waitTextureState(page, TERMINAL_TEXTURE_STATES, 'S2 装载终态', 180_000),
      '前提：夹具必须到达纹理终态 ready（否则像素读面没有可比基线）',
    ).toBe('ready')

    // ── ② 四面全部挪离默认值（前提；不是观测）──
    await selectCell(page, target.kernel, target.fileIdx)
    const EDIT = 'M8-S2 丢失前的编辑'
    await writeField(page, TOOLTIP_FIELD, EDIT)
    await selectFirstAnnotatedCell(page)
    await setCameraPose(page, VIEWPORT_REGION, POSE_A)
    const timeAfter = await advanceSceneTimeOffDefault(page)
    console.log('[S2] time=' + JSON.stringify(timeAfter))
    expect(
      timeAfter.frame,
      '前提：场景时间必须真的离开默认值（时间面判据才成立）。实测 ' + JSON.stringify(timeAfter),
    ).toBeGreaterThan(0)

    const before = await readViewportFacts(page, VIEWPORT_REGION)
    // 前提自证：四面都确实非默认
    expect(before.camera.logical, '前提：机位读面必须给出用户机位').not.toBeNull()
    expect(before.selection.items.length, '前提：选择必须真的有一项').toBeGreaterThan(0)
    expect(before.time.frame, '前提：权威时间的 frame 必须非 0（时间面判据才成立）').toBeGreaterThan(0)
    expect(before.content.annotations, '前提：夹具必须带注解（内容面的一个可数字段）').toBeGreaterThanOrEqual(0)
    expect(before.canvas.present, '前提：产品画布必须存在').toBe(true)

    // 基线像素（丢失前必须非空白 —— 这也是"空白检测有区分力"的对照端）
    const preLoss = await sampleUntilNotBlank(page, VIEWPORT_REGION, '丢失前基线', 30_000)
    expect(preLoss.violations, '前提：丢失前画面必须非空白。实测 ' + JSON.stringify(preLoss.sample?.stats ?? null)).toEqual([])

    // ── ③ 注入面：对产品画布安装并发起真实丢失 ──
    const hook = await installLossHooks(page, VIEWPORT_REGION)
    console.log('[S2] hook=' + JSON.stringify(hook))
    expect(
      hook.ok,
      '注入面：产品画布必须能拿到 WEBGL_lose_context 扩展（拿不到则本判据无从成立，须停止并回报）' +
        '；实测 reason=' + String(hook.reason) + ' contextType=' + hook.contextType,
    ).toBe(true)

    const lost = await loseProductContext(page)
    expect(lost.lostEvents, '前提：浏览器必须真的派发 webglcontextlost').toBeGreaterThan(0)
    expect(lost.isLost, '前提：gl.isContextLost() 必须为 true（只信事件不够）').toBe(true)

    // ── ④ 丢失期读数：四面不得被设备事件改写（§8:287）──
    await page.waitForTimeout(600)
    const duringLoss = await readViewportFacts(page, VIEWPORT_REGION)
    // 丢失期画面必须是空白 —— 否则"恢复后非空白"这条判据没有区分力
    const lostFrame = await sampleUntilNotBlank(page, VIEWPORT_REGION, '丢失期', 8_000)
    // 观测登记（**不作断言**，只把"这一轮恢复是域层做的还是渲染器自己做的"记下来）：
    // §7.5 的设计要求是"设备事件被域层接收 → 放弃旧代次 → 用当前有效状态重建"。
    // 若 pendingRebuild 恒 false / ledger 活跃份额不减 / 没有设备代次推进，
    // 说明画面回来靠的是渲染器（three）自己的惰性重传，不是 §7.5 的恢复链 ——
    // 那是 S3/S4 的判据面，这里只登记事实，避免把"画面回来了"误读成"§7.5 已合规"。
    console.log(
      '[S2] loss: events=' + lost.lostEvents +
        ' isLost=' + String(lost.isLost) +
        ' lostFrameViolations=' + JSON.stringify(lostFrame.violations) +
        ' stats=' + JSON.stringify(lostFrame.sample?.stats ?? null) +
        ' pendingRebuild=' + String(duringLoss.presenter.pendingRebuild) +
        ' ledger=' + JSON.stringify(duringLoss.presenter.ledger) +
        ' deviceGeneration=' + String(duringLoss.presenter.deviceGeneration) +
        ' generation=' + String(duringLoss.presenter.generation),
    )
    expect(
      lostFrame.violations.length,
      '前提：丢失期这一帧必须是空白（否则"恢复后非空白"恒真、判据无区分力）',
    ).toBeGreaterThan(0)

    // ── ⑤ 恢复 ──
    const restored = await restoreProductContext(page)
    expect(restored.restoredEvents, '前提：浏览器必须真的派发 webglcontextrestored').toBeGreaterThan(0)
    expect(restored.isLost, '前提：恢复后 gl.isContextLost() 必须为 false').toBe(false)

    const afterSample = await sampleUntilNotBlank(page, VIEWPORT_REGION, '恢复后', 60_000)
    const after = await readViewportFacts(page, VIEWPORT_REGION)

    console.log(
      '[S2] after: violations=' + JSON.stringify(afterSample.violations) +
        ' attempts=' + afterSample.attempts +
        ' sha=' + (afterSample.sample?.sha256.slice(0, 12) ?? 'null') +
        ' uniqueColors=' + (afterSample.sample?.stats.uniqueColors ?? -1) +
        ' canvasMarked=' + String(after.canvas.marked) +
        ' dom=' + JSON.stringify(after.dom) +
        ' generation=' + String(after.presenter.generation),
    )
    console.log('[S2] before=' + JSON.stringify(faceSignature(before)))
    console.log('[S2] duringLoss=' + JSON.stringify(faceSignature(duringLoss)))
    console.log('[S2] after=' + JSON.stringify(faceSignature(after)))

    // ── ⑥ 主判据 A：丢失期四面不变（设备事件不得改内容/选择/时间/机位）──
    expect(faceSignature(duringLoss), '⚠️ S2/D1：**丢失期间**内容/选择/时间/机位必须逐字段不变（§8:287）').toEqual(
      faceSignature(before),
    )
    expectEngineClose(duringLoss, before, '⚠️ 丢失期间机位')

    // ── ⑦ 主判据 B：恢复后四面不变 ──
    expect(faceSignature(after), '⚠️ S2/D1：**恢复后**内容/选择/时间/机位必须逐字段不变（§7.5:264）').toEqual(
      faceSignature(before),
    )
    expectEngineClose(after, before, '⚠️ 恢复后机位')

    // ── ⑧ 主判据 C：画面回来了（非空白）──
    expect(
      afterSample.violations,
      '⚠️ S2/D2：恢复后画面必须回到非空白（当前实现零接线：设备事件无人接收，处置完全依赖 three）' +
        '；实测违规=' + JSON.stringify(afterSample.violations),
    ).toEqual([])
    expect(afterSample.sample!.stats.uniqueColors, '恢复后画面必须有丰富颜色（不是纯色/纯黑）').toBeGreaterThanOrEqual(32)

    // ── ⑨ 主判据 D：现场未被扰动（同一画布元素 + 宿主未重挂 + 文档身份不变）──
    expect(after.canvas.marked, '⚠️ 恢复后画布必须还是**同一个** canvas 元素（不许用重挂宿主兜底）').toBe(true)
    expect(after.dom.viewportCount, '视口宿主数量不得变化（设备事件不是关闭区域）').toBe(before.dom.viewportCount)
    expect(after.dom.canvasCount, '画布数量不得变化').toBe(before.dom.canvasCount)
    expect(after.slot.camera, '恢复后视口槽位必须仍活着（camera 非空）').toBe(true)
    expect(after.slot.dom, '恢复后视口槽位必须仍活着（domElement 非空）').toBe(true)
    expect(after.content.documentId, '恢复不得换文档身份（不许以重开文件当恢复手段）').toBe(before.content.documentId)
  })

  test('S2-b 负对照：只丢失不恢复 ⇒ 画面持续空白且四面仍不变（"空白"这一读数有区分力）', async ({ page }) => {
    test.setTimeout(420_000)
    const out = m8CaseDir('s2-b', test.info().project.name)
    const inputCopy = path.join(out, 'input-copy.json')
    fs.copyFileSync(fixturePath(), inputCopy)

    await gotoWorkbench(page)
    await page.waitForFunction(() => typeof (window as any).__p7_input__?.counters === 'function', undefined, {
      timeout: 30_000,
    })
    await injectSceneDocumentOk(page, JSON.parse(fs.readFileSync(inputCopy, 'utf8')), FIXTURE)
    await waitForViewportMounted(page)
    await expect(page.locator(STATUS_BAR)).toBeVisible()
    expect(await waitTextureState(page, TERMINAL_TEXTURE_STATES, 'S2-b 装载终态', 180_000)).toBe('ready')

    await setCameraPose(page, VIEWPORT_REGION, POSE_A)
    const before = await readViewportFacts(page, VIEWPORT_REGION)
    const preLoss = await sampleUntilNotBlank(page, VIEWPORT_REGION, '丢失前基线', 30_000)
    expect(preLoss.violations, '前提：丢失前必须非空白').toEqual([])

    const hook = await installLossHooks(page, VIEWPORT_REGION)
    expect(hook.ok, '注入面必须可用：reason=' + String(hook.reason)).toBe(true)
    await loseProductContext(page)

    // **不恢复**：等足够久（远超一次重建的时延），画面必须仍然是空白。
    await page.waitForTimeout(4000)
    const stuck = await sampleUntilNotBlank(page, VIEWPORT_REGION, '永久丢失期', 10_000)
    const after = await readViewportFacts(page, VIEWPORT_REGION)
    console.log(
      '[S2-b] violations=' + JSON.stringify(stuck.violations) +
        ' isLost=' + String(after.canvas.isLost) +
        ' stats=' + JSON.stringify(stuck.sample?.stats ?? null),
    )
    expect(
      stuck.violations.length,
      '负对照：永久丢失时画面必须持续空白（若这里非空白，说明"空白"读数不可靠，S2-a 的恢复判据就是假绿）',
    ).toBeGreaterThan(0)
    // 而四面仍然不变（丢失本身不是编辑）
    expect(faceSignature(after), '负对照：永久丢失期四面同样必须不变（不是"因为丢了所以读不到"）').toEqual(
      faceSignature(before),
    )
    expect(after.canvas.present, '负对照：画布元素本身必须仍在（"空白"不等于"宿主没了"）').toBe(true)
  })
})