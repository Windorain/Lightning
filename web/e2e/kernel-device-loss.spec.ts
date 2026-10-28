/**
 * **设备丢失 → 恢复，四面保留 + 画面回来**（对**产品画布**注入真实上下文丢失）
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
 * ## 注入面（§4.4 判定的实测化；src/ 一行不改）
 *
 * 产品画布 = ctx.viewports.get('r-viewport').domElement.value（attachViewport 写进去的就是它）。
 * 对它取**已存在**的 GL 上下文 → 取 WEBGL_lose_context → loseContext()/restoreContext()。
 * 这是浏览器规范的设备丢失路径，与 GPU 掉电/驱动重置同一条派发链；
 * 不是产品钩子（产品没有任何注入钩子，实测 0 命中）。
 *
 * ## 先红预期（D1/D2）
 *
 * 「丢失 → 呈现会话 handleContextLost() 被调用」这条接线**生产零调用方**
 * （src/ 只有定义处 2 文件 + 会话内部转调 1 处；canvas 监听只 preventDefault + onResize）。
 * 于是"处置"完全依赖 three 自己的丢失/恢复处理。**four faces 因此是"偶然保住"**，
 * 而"画面是否回来"取决于 three 惰性重传是否完整 —— 这一条明确标注**未实测**。
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
import { TOOLTIP_FIELD, fixturePath, firstAnnotatedCell, innerDocOf, selectCell, writeField, copyFixtureTo } from './helpers/saveReopen'
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
  settlePresenter,
  selectFirstAnnotatedCell,
  setCameraPose,
  VIEWPORT_REGION,
  type ViewportFacts,
} from './helpers/recovery/faults'

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

test.describe('设备丢失/恢复保留四面', () => {
  test('产品画布真实丢失→恢复：画面回来，内容/选择/时间/机位逐字段不变，现场未被扰动', async ({ page }) => {
    test.setTimeout(480_000)
    const out = m8CaseDir('s2-a', test.info().project.name)
    const inputCopy = path.join(out, 'input-copy.json')
    copyFixtureTo(inputCopy)
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
    const EDIT = '丢失前的编辑'
    await writeField(page, TOOLTIP_FIELD, EDIT)
    await selectFirstAnnotatedCell(page)
    await setCameraPose(page, VIEWPORT_REGION, POSE_A)
    const timeAfter = await advanceSceneTimeOffDefault(page)
    console.log('[device-loss] time=' + JSON.stringify(timeAfter))
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
    console.log('[device-loss] hook=' + JSON.stringify(hook))
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
    // ── 丢失期的**接线事实**（此处主判据，不再是"观测登记"）──
    //
    // §7.5 的设计要求是"设备事件被域层接收 → 放弃旧代次 → 用当前有效状态重建"。
    // 接线前，画面回来靠的是渲染器（three）自己的惰性重传：pendingRebuild 恒 false、
    // 归属账一份不减、没有设备代次 —— 那是"域层零参与"。
    // 接线后这三条必须同时成立（它们就是"恢复链真的发生了"的中间事实）。
    console.log(
      '[device-loss] loss: events=' + lost.lostEvents +
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

    // ── 接线事实：丢失 ⇒ 会话进入待重建 + 旧代次份额被放弃 + 有设备代次 ──
    expect(
      duringLoss.presenter.pendingRebuild,
      '⚠️ S2/D1：视口收到 webglcontextlost ⇒ 会话必须进入待重建（接线判据；接线前恒 false）',
    ).toBe(true)
    expect(
      duringLoss.presenter.devicePhase,
      '⚠️ S2/D1：丢失期设备相位必须是 lost（不是"没东西可画"）',
    ).toBe('lost')
    expect(
      duringLoss.presenter.deviceReady,
      '⚠️ S2/D1：丢失期不得提交 GPU 工作',
    ).toBe(false)
    expect(
      duringLoss.presenter.ledger?.activeCount,
      '⚠️ S2/D1：旧代次份额必须被全部放弃（接线前是 125 份仍在账上）',
    ).toBe(0)
    expect(
      duringLoss.presenter.ledger?.abandonedTotal,
      '⚠️ S2：放弃必须单列记账（不是悄悄清零）',
    ).toBeGreaterThan(0)
    expect(
      typeof duringLoss.presenter.deviceGeneration,
      '⚠️ S2/D4：丢失期也必须能读到设备代次（number）',
    ).toBe('number')

    // ── ⑤ 恢复 ──
    const restored = await restoreProductContext(page)
    expect(restored.restoredEvents, '前提：浏览器必须真的派发 webglcontextrestored').toBeGreaterThan(0)
    expect(restored.isLost, '前提：恢复后 gl.isContextLost() 必须为 false').toBe(false)

    const afterSample = await sampleUntilNotBlank(page, VIEWPORT_REGION, '恢复后', 60_000)
    const after = await readViewportFacts(page, VIEWPORT_REGION)

    console.log(
      '[device-loss] after: violations=' + JSON.stringify(afterSample.violations) +
        ' attempts=' + afterSample.attempts +
        ' sha=' + (afterSample.sample?.sha256.slice(0, 12) ?? 'null') +
        ' uniqueColors=' + (afterSample.sample?.stats.uniqueColors ?? -1) +
        ' canvasMarked=' + String(after.canvas.marked) +
        ' dom=' + JSON.stringify(after.dom) +
        ' generation=' + String(after.presenter.generation),
    )
    console.log('[device-loss] before=' + JSON.stringify(faceSignature(before)))
    console.log('[device-loss] duringLoss=' + JSON.stringify(faceSignature(duringLoss)))
    console.log('[device-loss] after=' + JSON.stringify(faceSignature(after)))

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

    // ── 接线事实：恢复 ⇒ 待重建复位 + 设备代次推进 + 结构世代回到同一值 ──
    expect(after.presenter.pendingRebuild, '⚠️ S2：恢复后一次成功重建必须让 pendingRebuild 复位').toBe(false)
    expect(
      after.presenter.devicePhase,
      '⚠️ S2：恢复后相位必须回到 ready',
    ).toBe('ready')
    expect(
      after.presenter.deviceGeneration as number,
      '⚠️ S2/D4：恢复后设备代次必须严格递增（旧代次不服役）',
    ).toBeGreaterThan(duringLoss.presenter.deviceGeneration as number)
    // 「内容没变的恢复」必须用**同一份内容**重建（这是 A30 的既有语义；
    // 结构世代本身在同一内容上再编译是否逐字相同由 S3-b 单独钉 —— 两者不同轴）。
    expect(
      after.presenter.appliedContentIdentity,
      '⚠️ S2：恢复后重建必须仍用**同一份内容身份**（内容没变 ⇒ 不得换文档/换内容重建）',
    ).toBe(before.presenter.appliedContentIdentity)
    expect(after.presenter.generation, '⚠️ S2：恢复后必须重新建立结构世代（非空）').not.toBeNull()
    expect(
      String(after.presenter.deviceGeneration),
      '⚠️ S2：设备代次与结构世代不同空间（§6:208）',
    ).not.toBe(String(after.presenter.generation))
    expect(
      after.presenter.ledger?.liveRefs,
      '⚠️ S2：恢复后新代次的份额必须重新建立',
    ).toBeGreaterThan(0)

    // ── ⑨ 主判据 D：现场未被扰动（同一画布元素 + 宿主未重挂 + 文档身份不变）──
    expect(after.canvas.marked, '⚠️ 恢复后画布必须还是**同一个** canvas 元素（不许用重挂宿主兜底）').toBe(true)
    expect(after.dom.viewportCount, '视口宿主数量不得变化（设备事件不是关闭区域）').toBe(before.dom.viewportCount)
    expect(after.dom.canvasCount, '画布数量不得变化').toBe(before.dom.canvasCount)
    expect(after.slot.camera, '恢复后视口槽位必须仍活着（camera 非空）').toBe(true)
    expect(after.slot.dom, '恢复后视口槽位必须仍活着（domElement 非空）').toBe(true)
    expect(after.content.documentId, '恢复不得换文档身份（不许以重开文件当恢复手段）').toBe(before.content.documentId)
  })

  test('负对照：只丢失不恢复 ⇒ 画面持续空白且四面仍不变（"空白"这一读数有区分力）', async ({ page }) => {
    test.setTimeout(420_000)
    const out = m8CaseDir('s2-b', test.info().project.name)
    const inputCopy = path.join(out, 'input-copy.json')
    copyFixtureTo(inputCopy)

    await gotoWorkbench(page)
    await page.waitForFunction(() => typeof (window as any).__p7_input__?.counters === 'function', undefined, {
      timeout: 30_000,
    })
    await injectSceneDocumentOk(page, JSON.parse(fs.readFileSync(inputCopy, 'utf8')), FIXTURE)
    await waitForViewportMounted(page)
    await expect(page.locator(STATUS_BAR)).toBeVisible()
    expect(await waitTextureState(page, TERMINAL_TEXTURE_STATES, 'device-loss-b 装载终态', 180_000)).toBe('ready')

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
      '[device-loss-b] violations=' + JSON.stringify(stuck.violations) +
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
  test('附加判据：丢失期间编辑 ⇒ 恢复后画面体现**新内容**（§7.5:264「从当前有效状态重建」）', async ({ page }) => {
    test.setTimeout(480_000);
    const out = m8CaseDir('s2-c', test.info().project.name);
    const inputCopy = path.join(out, 'input-copy.json');
    copyFixtureTo(inputCopy);

    await gotoWorkbench(page);
    await page.waitForFunction(() => typeof (window as any).__p7_input__?.counters === 'function', undefined, {
      timeout: 30_000,
    });
    await injectSceneDocumentOk(page, JSON.parse(fs.readFileSync(inputCopy, 'utf8')), FIXTURE);
    await waitForViewportMounted(page);
    await expect(page.locator(STATUS_BAR)).toBeVisible();
    expect(await waitTextureState(page, TERMINAL_TEXTURE_STATES, 'device-loss-c 装载终态', 180_000)).toBe('ready');
    await setCameraPose(page, VIEWPORT_REGION, POSE_A);

    const before = await readViewportFacts(page, VIEWPORT_REGION);
    const preLoss = await sampleUntilNotBlank(page, VIEWPORT_REGION, 'S2-c 丢失前基线', 30_000);
    expect(preLoss.violations, '前提：丢失前必须非空白').toEqual([]);

    const hook = await installLossHooks(page, VIEWPORT_REGION);
    expect(hook.ok, '注入面必须可用：reason=' + String(hook.reason)).toBe(true);
    await loseProductContext(page);
    await page.waitForTimeout(600);
    const during = await readViewportFacts(page, VIEWPORT_REGION);
    expect(during.presenter.devicePhase, '前提：确实处于丢失期').toBe('lost');

    // ── 丢失期间**编辑内容 + 改显示状态**（两条都属"当前有效状态"）──
    //
    // ① 内容编辑：右栏真实输入写一格说明（与 S1 同一条生产写路径 —— 真UI、真命令）。
    //    设备丢失只暂停"呈现"，不暂停编辑（§8:287 只允许改图形资源与显示状态）。
    // ② 显示状态：切到第 1 层预览（`lp:` 进内容身份 ⇒ 恢复后必须按新层重建），
    //    它让"恢复后画面"与丢失前**可区分**（回放快照的实现必然得到同一张图）。
    const target = firstAnnotatedCell(innerDocOf(inputCopy));
    await selectCell(page, target.kernel, target.fileIdx);
    await writeField(page, TOOLTIP_FIELD, '丢失期间的编辑');
    await page.evaluate(async () => {
      const vm = (window as any).__vm__;
      await vm.getOperators().exec('OPERATOR_SET_LAYER_Y', { y: 1 });
    });
    await page.waitForTimeout(1200);

    const afterEdit = await readViewportFacts(page, VIEWPORT_REGION);
    expect(
      afterEdit.content.digest,
      '前提：丢失期间的编辑必须真的改了内容（否则"恢复后体现新内容"无从判断）',
    ).not.toBe(before.content.digest);
    expect(
      afterEdit.presenter.appliedContentIdentity,
      '丢失期不得重建：实际应用的内容身份必须**停在**丢失前那一份（否则等于丢着设备还在上传）',
    ).toBe(before.presenter.appliedContentIdentity);

    // 已知的身份变化（从**当前有效状态**重建的可核对形态）
    const editedVersion = Number(
      await page.evaluate(() => (window as any).__vm__?.kernel?.document?.()?.version?.documentVersion ?? 0),
    );
    expect(editedVersion, '前提：内容编辑必须推进文档版本').toBeGreaterThan(1);
    // ── 恢复：重建必须取**当前有效状态**，不是丢失瞬间的快照 ──
    await restoreProductContext(page);
    const afterSample = await sampleUntilNotBlank(page, VIEWPORT_REGION, 'S2-c 恢复后', 60_000);
    const after = await readViewportFacts(page, VIEWPORT_REGION);
    console.log(
      '[device-loss-c] after: violations=' + JSON.stringify(afterSample.violations) +
        ' sha=' + String(afterSample.sample?.sha256 ?? '').slice(0, 12) +
        ' preSha=' + String(preLoss.sample?.sha256 ?? '').slice(0, 12) +
        ' annotations=' + JSON.stringify(after.presenter.overlay) +
        ' applied=' + String(after.presenter.appliedContentIdentity).slice(0, 60) +
        ' dev=' + String(after.presenter.deviceGeneration),
    );

    expect(afterSample.violations, '恢复后画面必须回来（非空白）').toEqual([]);
    expect(
      after.presenter.appliedContentIdentity || '',
      '⚠️ S2/D2：恢复后重建必须用**当前**内容身份（丢失期间的编辑必须进画面）；' +
        '若停在丢失前那一份 ⇒ 回放的是快照，不是"从当前有效状态重建"。实测=' +
        String(after.presenter.appliedContentIdentity),
    ).toContain('k:' + String(editedVersion) + String.fromCharCode(1));
    expect(
      after.presenter.appliedContentIdentity || '',
      '⚠️ S2：丢失期间切的层必须进恢复后的内容身份（lp:y1 —— 显示状态也是"当前有效状态"）',
    ).toContain('lp:y1');
    expect(
      after.presenter.appliedContentIdentity,
      '⚠️ S2：重建后的内容身份必须与丢失前**不同**（证明它真的换了内容，不是恰好相同）',
    ).not.toBe(before.presenter.appliedContentIdentity);
    expect(
      afterSample.sample?.sha256,
      '⚠️ S2：恢复后的画面必须与丢失前**不同**（新内容真的进了像素，而不是把旧帧贴回来）',
    ).not.toBe(preLoss.sample?.sha256);
    // 现场未被扰动：不是"重开文件"兜底出来的新画面
    expect(after.canvas.marked, '恢复后画布必须还是同一个 canvas 元素').toBe(true);
    expect(after.content.documentId, '恢复不得换文档身份（不许以重开文件当恢复手段）').toBe(before.content.documentId);
    expect(after.presenter.deviceGeneration as number, '设备代次必须推进').toBeGreaterThan(
      during.presenter.deviceGeneration as number,
    );
  })
})