/**
 * **回归判据：首次内容编辑不得重建视口宿主与 canvas**（真实工作台入口）。
 *
 * ## 缺陷形态（实测）
 *
 * 第一次内容投影（Tooltip 提交）后，视口 canvas 的 **DOM 节点被换掉**，并出现
 * 「\`.vc-viewport\` 与 canvas 同时不存在」的帧（单据读数：2 帧、重建空窗 512 ms）。
 *
 * 机制（本次核验，file:line）：编辑 ⇒ \`contentRefreshTick\` 自增 ⇒
 * \`runtime/drwMeshPipeline#applyContentRefresh\` 首次 \`republish\`（无内容身份基线 ⇒
 * \`documentChanged\`）⇒ \`plan.reloadResources\` ⇒ \`textureCache.value = null\` ⇒
 * 两个宿主的 \`v-if\` 曾含 \`materialLibrary\` ⇒ \`RenderEngineHost\` 卸载重挂 ⇒ 新 canvas。
 *
 * ## 判据（三条，全部是用户可感知面）
 *
 * 1. **元素句柄同一性**：编辑前取到的 canvas 元素句柄，编辑后必须仍是 DOM 里那一个
 *    （不是"数量还是 1"，也不是"又出现了一个 canvas"——那正是缺陷形态）；
 * 2. **没有宿主缺席帧**：安装 rAF 逐帧采样 + MutationObserver；观察窗内不得出现
 *    「\`.vc-viewport\` 与 canvas 同时缺席」的帧、不得出现宿主/canvas 的移除或新增，
 *    也不得出现工作台的 "No scene loaded" 占位（那是 \`v-else\` 分支被切过去）；
 * 3. **现场未被扰动**：编辑前把机位挪到**显著非默认**位置，编辑后逻辑机位与引擎相机
 *    取景逐字段不变（与 \`kernel-viewport-camera.spec.ts\` 同口径）。
 *
 * ## 为什么必须这样测（防假绿）
 *
 * - 只断言"canvas 数量 = 1"会漏掉"旧节点被替换成新节点"（缺陷后数量仍是 1）；
 * - 只读编辑后的状态会漏掉"中途缺席"（重建很快，终态看起来正常）；
 * - 不挪机位就无从观测"复位"（默认值恰好相同 ⇒ 恒绿）；
 * - 探针带自检（安装时真的取到 canvas 并打标记、采样帧数 > 30），否则"零缺席帧"是空转。
 *
 * 判据的**负对照是实测**（修复前同一文件跑出的读数）：\`bothAbsentFrames=2\`、
 * \`viewportRemovals=1\`、\`canvasRemovals=1\`、\`currentIsSame=false\` ⇒ 本用例必红。
 *
 * 入口：生产 \`OPERATOR_OPEN_SCENE\` + \`File\`（\`injectSceneDocumentOk\`），
 * 选择走生产选择 API（\`ctx.getSelection().select\`），编辑走右栏生成式 Inspector 的
 * Tooltip 输入框（\`data-property="lightning.block.tooltip"\`）。
 */
import { expect, test, type Page } from '@playwright/test'
import { gotoWorkbench, injectSceneDocumentOk, VIEWPORT_CANVAS, waitForViewportMounted } from './helpers/multiblock/harness'
import { firstAnnotatedCell, fixturePath as resolveFixturePath, innerDocOf, readJson } from './helpers/saveReopen'

const FIXTURE = 'structuredata-exported-envelope.json'
const TOOLTIP_FIELD = 'lightning.block.tooltip'
const REGION = 'r-viewport'

// ─── 相机观测（与 kernel-viewport-camera.spec.ts 同口径：只取稳定取景字段） ───
interface EnginePose { m: number[] | null; zoom: number | null; frustum: (number | null)[] }
interface CameraReading { logical: unknown; engine: EnginePose; canvasCount: number }

async function readCamera(page: Page): Promise<CameraReading> {
  return (await page.evaluate((region) => {
    const vm = (window as any).__vm__
    const ref = vm.main.cameras[region]
    const logical = ref?.value ? JSON.parse(JSON.stringify(ref.value)) : null
    const cam = vm.viewports.get(region)?.camera?.value ?? null
    return {
      logical,
      engine: {
        m: cam?.matrixWorld?.elements ? Array.from(cam.matrixWorld.elements as number[]) : null,
        zoom: typeof cam?.zoom === 'number' ? cam.zoom : null,
        frustum: [cam?.left ?? null, cam?.right ?? null, cam?.top ?? null, cam?.bottom ?? null],
      },
      canvasCount: document.querySelectorAll('.vc-viewport canvas').length,
    }
  }, REGION)) as CameraReading
}

/** 把机位挪到**显著不同的非默认机位**（缺陷判据的前提）。 */
async function moveCameraAway(page: Page): Promise<void> {
  await page.evaluate((region) => {
    const vm = (window as any).__vm__
    vm.main.ensureCamera(region).value = {
      target: { x: 9, y: 1, z: 5 }, yawDeg: 35, elevationDeg: 20, distance: 6, zoom: 2.4,
    }
  }, REGION)
  await page.waitForTimeout(1500)
}

// ─── 宿主/画布探针（rAF 逐帧 + MutationObserver） ───
interface HostProbe {
  /** 安装时真的取到了 canvas 并打上标记。 */
  marked: boolean
  /** 安装时 .vc-viewport 在 DOM 里。 */
  hostAtInstall: boolean
  /** rAF 实际采样帧数（判据不是空转）。 */
  frames: number
  /** 「.vc-viewport 与 canvas 同时缺席」的帧数（缺陷形态）。 */
  bothAbsentFrames: number
  /** 宿主整体缺席的帧数（.vc-viewport 不在）。 */
  hostAbsentFrames: number
  /** 存在 canvas 但不是**安装时那一个**的帧数（节点被替换）。 */
  identityBrokenFrames: number
  /** 工作台占位（"No scene loaded"）出现的帧数（v-else 分支被切过去）。 */
  placeholderFrames: number
  /** MutationObserver：.vc-viewport 的移除/新增次数。 */
  viewportRemovals: number
  viewportAdditions: number
  /** MutationObserver：canvas 的移除/新增次数。 */
  canvasRemovals: number
  canvasAdditions: number
  /** 观察结束时的状态。 */
  currentIsSame: boolean
  currentHasMark: boolean
  viewportCount: number
  canvasCount: number
  firstAbsentMs: number | null
}

async function installHostProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sel = '.vc-viewport'
    const canvasSel = '.vc-viewport canvas'
    const el = document.querySelector(canvasSel) as HTMLCanvasElement | null
    if (el) el.setAttribute('data-wk-probe', 'A')
    const st = {
      marked: el !== null,
      hostAtInstall: !!document.querySelector(sel),
      frames: 0,
      bothAbsentFrames: 0,
      hostAbsentFrames: 0,
      identityBrokenFrames: 0,
      placeholderFrames: 0,
      viewportRemovals: 0,
      viewportAdditions: 0,
      canvasRemovals: 0,
      canvasAdditions: 0,
      firstAbsentMs: null as number | null,
    }
    const isVp = (n: Element): boolean => n.matches(sel) || n.querySelector(sel) !== null
    const hasCanvas = (n: Element): boolean => n.tagName === 'CANVAS' || n.querySelector('canvas') !== null
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of Array.from(r.removedNodes)) {
          if (!(n instanceof Element)) continue
          if (isVp(n)) st.viewportRemovals += 1
          if (hasCanvas(n)) st.canvasRemovals += 1
        }
        for (const n of Array.from(r.addedNodes)) {
          if (!(n instanceof Element)) continue
          if (isVp(n)) st.viewportAdditions += 1
          if (hasCanvas(n)) st.canvasAdditions += 1
        }
      }
    })
    mo.observe(document.body, { childList: true, subtree: true })
    const t0 = performance.now()
    let running = true
    const tick = (): void => {
      if (!running) return
      st.frames += 1
      const vp = document.querySelector(sel)
      const cv = document.querySelector(canvasSel)
      if (!vp) st.hostAbsentFrames += 1
      if (!vp && !cv) {
        st.bothAbsentFrames += 1
        if (st.firstAbsentMs === null) st.firstAbsentMs = Math.round(performance.now() - t0)
      }
      if (cv && cv !== el) st.identityBrokenFrames += 1
      if (document.querySelector('.wv-placeholder') !== null) st.placeholderFrames += 1
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    ;(window as any).__hostProbeStop__ = () => {
      running = false
      mo.disconnect()
      const cv = document.querySelector(canvasSel)
      return {
        ...st,
        currentIsSame: cv !== null && cv === el,
        currentHasMark: cv !== null && cv.getAttribute('data-wk-probe') === 'A',
        viewportCount: document.querySelectorAll(sel).length,
        canvasCount: document.querySelectorAll(canvasSel).length,
      }
    }
  })
}

async function stopHostProbe(page: Page): Promise<HostProbe> {
  return (await page.evaluate(() => (window as any).__hostProbeStop__())) as HostProbe
}

/** 打开工作台、装载真实信封、用生产选择 API 选中夹具里第一个自带注解的格。 */
async function gotoWithAnnotatedCellSelected(page: Page): Promise<{
  expected: string
  kernel: [number, number, number]
  fileIdx: [number, number, number]
}> {
  const fixturePath = resolveFixturePath()
  const json = readJson(fixturePath)
  const target = firstAnnotatedCell(innerDocOf(fixturePath))

  await gotoWorkbench(page)
  await page.waitForFunction(() => typeof (window as any).__p7_input__?.counters === 'function', undefined, { timeout: 30_000 })
  await injectSceneDocumentOk(page, json, FIXTURE)
  await waitForViewportMounted(page)

  await page.evaluate((cell: { x: number; y: number; z: number; fileIdx: [number, number, number] }) => {
    const vm = (window as any).__vm__
    const p = vm.plainForSave().plain
    const [fz, frow, fcol] = cell.fileIdx
    const entry = p.blockPalette[Number(p.cellGrid[fz]?.[frow]?.[fcol] ?? 0)]
    vm.getSelection().select({ pos: { x: cell.x, y: cell.y, z: cell.z }, block_state_id: String(entry?.registryId ?? '') })
  }, { x: target.kernel[0], y: target.kernel[1], z: target.kernel[2], fileIdx: target.fileIdx })

  await expect
    .poll(async () => await page.evaluate(() => document.querySelector('[data-property="lightning.block.pos"] .ux-field-readonly')?.textContent?.trim() ?? null), { timeout: 20_000 })
    .not.toBeNull()
  return { expected: target.expected, kernel: target.kernel, fileIdx: target.fileIdx }
}

test.describe('视口宿主寿命：首次内容编辑不得替换 canvas', () => {
  test('Tooltip 提交 ⇒ canvas 元素同一、无缺席帧、机位不变', async ({ page }) => {
    test.setTimeout(240_000)
    const cell = await gotoWithAnnotatedCellSelected(page)

    // ① 现场挪离默认：机位到显著非默认位置
    await page.waitForTimeout(1200)
    const fit = await readCamera(page)
    await moveCameraAway(page)
    const moved = await readCamera(page)
    expect(moved.logical, '【前提】挪机位必须在逻辑机位上真的生效').not.toEqual(fit.logical)
    expect(moved.engine, '【前提】挪机位必须在引擎相机上真的生效').not.toEqual(fit.engine)

    // ② 安装探针（此后整个编辑窗都在观察）
    await installHostProbe(page)

    // ③ **第一次内容投影**：真实 Tooltip 提交
    const NEW = '宿主寿命（e2e）'
    const loc = page.locator('[data-property="' + TOOLTIP_FIELD + '"] input')
    await expect(loc, '选中带注解的格后右栏必须有 Tooltip 字段').toBeVisible({ timeout: 15_000 })
    await loc.click()
    await loc.fill(NEW)
    await loc.press('Tab')
    await page.waitForTimeout(500)
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur?.() })

    // ④ 编辑**真的生效**（内核回读）——否则"宿主没变"可能只是编辑没发生
    await expect
      .poll(async () => await page.evaluate((idx) => {
        const p = (window as any).__vm__.plainForSave().plain
        const [z, row, col] = idx
        const slot = p.cellTooltipGrid?.[z]?.[row]?.[col]
        return slot === undefined || slot < 0 ? null : (p.tooltipPalette?.[slot] ?? null)
      }, cell.fileIdx), { timeout: 15_000 })
      .toBe(NEW)

    // ⑤ 缺陷窗口（单据：提交后 2 帧内、~512 ms）之后收探针
    await page.waitForTimeout(2500)
    const probe = await stopHostProbe(page)
    const after = await readCamera(page)
    console.log('[H1] probe=' + JSON.stringify(probe) + ' fit=' + JSON.stringify(fit.logical) + ' after=' + JSON.stringify(after.logical))

    // 探针自检：没跑起来的话"没有缺席帧"是空转
    expect(probe.marked, '探针必须真的取到 canvas 并打上标记（否则判据空转）').toBe(true)
    expect(probe.hostAtInstall, '探针安装时 .vc-viewport 必须在 DOM 里').toBe(true)
    expect(probe.frames, 'rAF 必须真的采样到足够帧数（否则"无缺席帧"无意义）').toBeGreaterThan(30)

    // (a) canvas 元素身份不变
    expect(probe.currentIsSame, '⚠️ 编辑后 canvas 必须仍是编辑前那一个 DOM 节点（缺陷形态：节点被替换）').toBe(true)
    expect(probe.currentHasMark, '⚠️ 编辑前打的标记必须还在（节点被替换会丢标记）').toBe(true)
    expect(probe.identityBrokenFrames, '⚠️ 观察窗内不得出现"有 canvas 但不是原来那个"的帧').toBe(0)
    expect(probe.canvasRemovals, '⚠️ canvas 不得被移除').toBe(0)
    expect(probe.canvasAdditions, '⚠️ 不得新增 canvas（修复不得靠并存第二个画布）').toBe(0)
    expect(probe.canvasCount, '视口 canvas 数量必须保持 1').toBe(1)

    // (b) 无「.vc-viewport 与 canvas 同时缺席」的帧；宿主没有被重挂、占位没有被切出来
    expect(probe.bothAbsentFrames, '⚠️ 观察窗内不得出现「.vc-viewport 与 canvas 同时缺席」的帧').toBe(0)
    expect(probe.hostAbsentFrames, '⚠️ 视口宿主不得整体缺席').toBe(0)
    expect(probe.placeholderFrames, '⚠️ 编辑期间不得切到 "No scene loaded" 占位（宿主被卸载的证据）').toBe(0)
    expect(probe.viewportRemovals, '⚠️ .vc-viewport 不得被移除').toBe(0)
    expect(probe.viewportAdditions, '⚠️ .vc-viewport 不得被重新挂载').toBe(0)
    expect(probe.viewportCount, '.vc-viewport 数量必须保持 1').toBe(1)

    // (c) 机位/取景未被扰动
    expect(after.logical, '⚠️ 编辑后逻辑机位必须逐字段不变').toEqual(moved.logical)
    expect(after.engine, '⚠️ 编辑后引擎相机取景必须不变').toEqual(moved.engine)
    expect(after.logical, '⚠️ 编辑后不得回到 fit 机位').not.toEqual(fit.logical)
    expect(after.canvasCount, 'canvas 数量读取面同样是 1').toBe(1)
    await expect(page.locator(VIEWPORT_CANVAS)).toHaveCount(1)
  })
})
