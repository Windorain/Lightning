/**
 * M1 定向回归 · **视口机位必须跨内容投影存活**（真实工作台入口）。
 *
 * ## 为什么必须有这条判据（本批修复的窟窿）
 *
 * P2/P3 的 e2e 读过值、字段、内核内容、截图 sha，**没有任何一条读过视口相机**
 * ⇒ 用户实测的"第一次编辑导致视口复位"在整轮自动检查里**完全不可见**。
 * 本文件把"相机"这一读面补上，并钉住用户报告的**确切形态**：
 *
 * ```
 * 装载（自动框选 fit）→ 用户把机位挪到别处 → 编辑一格说明 / 移动方块
 *   ⇒ 机位必须**逐字段不变**（不得回到 fit 机位）
 * ```
 *
 * ## 判据为什么这样写（三个防假绿要点）
 *
 * 1. **先把机位挪到显著不同的非默认机位**，并断言"挪动**真的**在逻辑机位与引擎
 *    相机两侧都生效"且与 fit 机位不同 —— 否则"复位到默认"无从观测，判据恒绿
 *    （本批第一次探针正是这样白测了一轮）。
 * 2. **只比稳定字段**：逻辑机位是纯对象（`ViewportCameraState`）可直接比；
 *    引擎侧读 `matrixWorld` / `projectionMatrix` / `zoom` —— **不**整体
 *    `JSON.stringify` THREE 相机（它带每次不同的 `uuid`，比整体会**恒判"变了"**）。
 * 3. **读相机前先等**：实测缺陷发生在编辑提交后约 40–90 ms（内容信号 → 资源缓存
 *    瞬时为空 → 宿主重挂 → 重新 fit），故提交后等到内核值落地**再多等 2 s**，
 *    并连读两次确认基线稳定 —— 读太早会把缺陷读成"没变"。
 *
 * ## 入口与观测面（零替身）
 *
 * - 装载：`injectSceneDocumentOk`（生产 `OPERATOR_OPEN_SCENE` + `File`，与拖放同一入口）；
 * - 选择：生产选择 API（`ctx.getSelection().select`，与 `selectOperator` 同路）；
 * - 编辑：右栏生成式 Inspector 的 `[data-property="lightning.block.tooltip"]` 输入框；
 * - 移动：真实按键 `g` + 真实 pointer 拖动（与 P2-4 同一写法）；
 * - 相机：`ctx.main.cameras['r-viewport']`（权威逻辑机位）+
 *   `ctx.viewports.get('r-viewport').camera.value`（真实 THREE 相机）；
 * - 编辑生效：面板值 + 内核回读（`plainForSave().plain`）双证据。
 *
 * 期望值来自**真实夹具**（`e2e/fixtures/structuredata-exported-envelope.json`，
 * 游戏内导出信封）：文件 `cellTooltipGrid` 是 `[z][row][col]` 且 `row 0 = 顶部`
 * ⇒ `row = sizeRow - 1 - y`。喂手工构造的"已正确"载荷无法证明生产装配。
 */

import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { gotoWorkbench, injectSceneDocumentOk, VIEWPORT_CANVAS, waitForViewportMounted } from './helpers/multiblock/harness'

const FIXTURE = 'structuredata-exported-envelope.json'
const TOOLTIP_FIELD = 'lightning.block.tooltip'
const REGION = 'r-viewport'

interface InnerDoc {
  cellGrid: number[][][]
  cellTooltipGrid: number[][][]
  tooltipPalette: string[]
}

/** 解开信封（gzip+base64）拿内层文档；非信封则原样当文档。 */
function innerDocOf(fixturePath: string): InnerDoc {
  const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Record<string, unknown>
  let doc = raw
  if (typeof raw.payload === 'string') {
    doc = JSON.parse(zlib.gunzipSync(Buffer.from(raw.payload, 'base64')).toString('utf8')) as Record<string, unknown>
  }
  return {
    cellGrid: doc.cellGrid as number[][][],
    cellTooltipGrid: doc.cellTooltipGrid as number[][][],
    tooltipPalette: doc.tooltipPalette as string[],
  }
}

/** 夹具里第一个**自带注解**的格：文件索引 `[z][row][col]` → 内核世界坐标 + 期望文本。 */
function firstAnnotatedCell(doc: InnerDoc): {
  kernel: [number, number, number]
  fileIdx: [number, number, number]
  expected: string
} {
  const sizeRow = doc.cellGrid[0]!.length
  for (let z = 0; z < doc.cellTooltipGrid.length; z++) {
    const slice = doc.cellTooltipGrid[z]!
    for (let row = 0; row < slice.length; row++) {
      const line = slice[row]!
      for (let col = 0; col < line.length; col++) {
        const idx = line[col]!
        if (idx < 0) continue
        const text = doc.tooltipPalette[idx]
        if (typeof text !== 'string' || text.length === 0) continue
        return { kernel: [col, sizeRow - 1 - row, z], fileIdx: [z, row, col], expected: text }
      }
    }
  }
  throw new Error('夹具里没有任何逐格注解 —— 本用例无法建立判据（不是"断言失败"）')
}

// ─────────────────────────────────────────────────────────────────────────────
// 观测面
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 引擎侧机位签名：**只取决定取景的稳定字段**。
 *
 * - `m`：`matrixWorld`（位置 + 朝向）；
 * - `zoom`：正交缩放；
 * - `frustum`：`[left, right, top, bottom]`（正交取景框）。
 *
 * ⚠️ **不读**`projectionMatrix` 整体：它的近/远裁剪面由 `fitCameraToGroup` 按包围盒
 * 夹过，而逻辑机位（`ViewportCameraState`）**不含**近/远 —— 宿主重挂后新建的相机
 * 用渲染器默认裁剪面（实测 0.1/500，是更宽的范围 ⇒ 不会裁掉任何内容）。
 * 判它会把"取景没变、裁剪范围变宽"误报成"画面被重新框选"（假阳性）。
 * 也**不**整体 `JSON.stringify` THREE 相机：`uuid`/`name` 每次读都不同 ⇒ 恒判"变了"。
 */
interface EnginePose {
  m: number[] | null
  zoom: number | null
  frustum: (number | null)[]
}

interface CameraReading {
  /** 权威逻辑机位（`ViewportCameraState`：target/yawDeg/elevationDeg/distance/zoom）。 */
  logical: unknown
  /** 真实 THREE 相机姿态（取景三要素：世界矩阵 + zoom + 正交取景框）。 */
  engine: EnginePose
  canvasCount: number
  canvasDims: string[]
}

async function readCamera(page: Page): Promise<CameraReading> {
  return (await page.evaluate((region) => {
    const vm = (window as any).__vm__
    const ref = vm.main.cameras[region]
    const logical = ref?.value ? JSON.parse(JSON.stringify(ref.value)) : null
    const cam = vm.viewports.get(region)?.camera?.value ?? null
    const canvases = Array.from(document.querySelectorAll('canvas')) as HTMLCanvasElement[]
    return {
      logical,
      engine: {
        m: cam?.matrixWorld?.elements ? Array.from(cam.matrixWorld.elements as number[]) : null,
        zoom: typeof cam?.zoom === 'number' ? cam.zoom : null,
        frustum: [cam?.left ?? null, cam?.right ?? null, cam?.top ?? null, cam?.bottom ?? null],
      },
      canvasCount: canvases.length,
      canvasDims: canvases.map((c) => `${c.width}x${c.height}`),
    }
  }, REGION)) as CameraReading
}

/** 把机位挪到**显著不同的非默认机位**（缺陷判据的前提）。 */
async function moveCameraAway(page: Page, pose: { target: [number, number, number]; yawDeg: number; elevationDeg: number; distance: number; zoom: number }): Promise<void> {
  await page.evaluate((p) => {
    const vm = (window as any).__vm__
    const ref = vm.main.ensureCamera(p.region)
    ref.value = {
      target: { x: p.target[0], y: p.target[1], z: p.target[2] },
      yawDeg: p.yawDeg,
      elevationDeg: p.elevationDeg,
      distance: p.distance,
      zoom: p.zoom,
    }
  }, { region: REGION, ...pose })
  await page.waitForTimeout(1500)
}

/** 面板字段值（生成式 Inspector 的输入框）。 */
async function fieldValue(page: Page, property: string): Promise<string | null> {
  return await page.evaluate((prop) => {
    const el = document.querySelector(`[data-property="${prop}"] input`) as HTMLInputElement | null
    return el?.value ?? null
  }, property)
}

/** 内核回读：某一格的逐格说明文本（`[z][row][col]` → 调色板）。 */
async function kernelTooltipAt(page: Page, fileIdx: [number, number, number]): Promise<string | null> {
  return await page.evaluate((idx) => {
    const p = (window as any).__vm__.plainForSave().plain
    const [z, row, col] = idx
    const slot = p.cellTooltipGrid?.[z]?.[row]?.[col]
    if (slot === undefined || slot < 0) return null
    return p.tooltipPalette?.[slot] ?? null
  }, fileIdx)
}

/** 方块格签名（判"移动真的发生了"）。 */
async function cellSignature(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const g = (window as any).__vm__.plainForSave().plain.cellGrid as number[][][]
    const out: string[] = []
    for (let a = 0; a < g.length; a++) for (let b = 0; b < g[a]!.length; b++) for (let c = 0; c < g[a]![b]!.length; c++) {
      const v = Number(g[a]![b]![c])
      if (v !== 0) out.push(`${a},${b},${c}=${v}`)
    }
    return out.join('|')
  })
}

/** 交草稿并**脱开文本控件**（焦点在文本控件里时快捷键不作用于文档）。 */
async function commitAndBlur(page: Page, loc: Locator): Promise<void> {
  await loc.press('Tab')
  await page.waitForTimeout(500)
  await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    el?.blur?.()
  })
  await page.waitForTimeout(700)
}

/** 打开工作台、装载真实信封、用生产选择 API 选中夹具里第一个自带注解的格。 */
async function gotoWithAnnotatedCellSelected(page: Page): Promise<{
  expected: string
  kernel: [number, number, number]
  fileIdx: [number, number, number]
}> {
  const fixturePath = path.join(import.meta.dirname, 'fixtures', FIXTURE)
  const json = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Record<string, unknown>
  const doc = innerDocOf(fixturePath)
  const target = firstAnnotatedCell(doc)

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
    .poll(
      async () => await page.evaluate(() => document.querySelector('[data-property="lightning.block.pos"] .ux-field-readonly')?.textContent?.trim() ?? null),
      { message: '生产选择 API 必须让右栏显示坐标（否则面板无目标）', timeout: 20_000 },
    )
    .not.toBeNull()
  return { expected: target.expected, kernel: target.kernel, fileIdx: target.fileIdx }
}

/**
 * 缺陷判据的公共部分：机位挪到非默认 ⇒ （调用方执行一次内容修改）⇒ 机位必须不变。
 *
 * 断言链（任一条判红即为真缺陷）：
 *  ① 前提：挪动在**逻辑机位**与**引擎相机**两侧都生效，且与 fit 机位不同；
 *  ② fit 机位记录后未被覆盖（防"记录时机写在挪动之后"）；
 *  ③ 内容修改后：逻辑机位逐字段等于挪动值、引擎姿态逐字段等于挪动值；
 *  ④ 明确不是 fit 机位（直接判"没有复位到默认"）。
 */
function expectCameraSurvives(
  ctx: { fit: CameraReading; moved: CameraReading; after: CameraReading; afterSecond: CameraReading; what: string },
): void {
  const { fit, moved, after, afterSecond, what } = ctx
  expect(fit.logical, '装载后必须已有 fit 机位（否则"复位"无从观测）').not.toBeNull()
  expect(
    moved.logical,
    `【前提】挪到非默认机位必须真的生效（逻辑机位）—— 否则${what}后的"复位"判据会恒绿`,
  ).not.toEqual(fit.logical)
  expect(
    moved.engine,
    '【前提】挪到非默认机位必须在**引擎相机**上也生效（矩阵/zoom）—— 否则判据只看逻辑值',
  ).not.toEqual(fit.engine)

  expect(
    after.logical,
    `⚠️ ${what}后**逻辑机位**必须逐字段不变（缺陷形态：被重新 fit 回装载机位）`,
  ).toEqual(moved.logical)
  expect(
    after.engine,
    `⚠️ ${what}后**引擎相机**取景（世界矩阵 / zoom / 正交取景框）必须不变（缺陷形态：画面被重新框选）`,
  ).toEqual(moved.engine)
  expect(after.logical, `⚠️ ${what}后不得回到 fit 机位（这就是用户看到的"视口复位"）`).not.toEqual(fit.logical)
  // 连读两次：确认基线本身稳定（排除"恰好读到一半的重挂"这一类假绿/假红）
  expect(afterSecond.logical, '连读两次机位必须稳定（判据本身不抖）').toEqual(after.logical)
  expect(afterSecond.engine, '连读两次引擎姿态必须稳定').toEqual(after.engine)
}

// ─────────────────────────────────────────────────────────────────────────────
// 用例
// ─────────────────────────────────────────────────────────────────────────────

test.describe('M1 视口机位：内容投影不得重置用户机位（真实工作台入口）', () => {
  test('V1 编辑逐格说明（第一次内容投影）⇒ 机位不变；编辑真的生效', async ({ page }) => {
    test.setTimeout(240_000)
    const cell = await gotoWithAnnotatedCellSelected(page)

    // ① 记录装载后的 fit 机位（"装载后自动框选"的机位就是被复位回的那个）
    await page.waitForTimeout(1200)
    const fit = await readCamera(page)

    // ② 挪到显著不同的非默认机位
    await moveCameraAway(page, { target: [9, 1, 5], yawDeg: 35, elevationDeg: 20, distance: 6, zoom: 2.4 })
    const moved = await readCamera(page)

    // ③ **第一次内容投影**：改该格的逐格说明
    const NEW = 'M1-机位-V1（e2e）'
    const loc = page.locator(`[data-property="${TOOLTIP_FIELD}"] input`)
    await expect(loc, '选中带注解的格后右栏必须有 Tooltip 字段').toBeVisible({ timeout: 15_000 })
    expect(await fieldValue(page, TOOLTIP_FIELD), '编辑前字段值必须来自夹具原件').toBe(cell.expected)
    await loc.click()
    await loc.fill(NEW)
    await commitAndBlur(page, loc)

    // ④ 编辑**真的生效**（面板值 + 内核回读，双证据）
    await expect.poll(async () => await fieldValue(page, TOOLTIP_FIELD), { timeout: 15_000 }).toBe(NEW)
    await expect
      .poll(async () => await kernelTooltipAt(page, cell.fileIdx), {
        message: '编辑必须落进内核内容（否则"机位没变"可能只是编辑根本没发生）',
        timeout: 15_000,
      })
      .toBe(NEW)

    // ⑤ 缺陷窗口（实测发生在提交后约 40–90 ms）之后连读两次机位
    await page.waitForTimeout(2000)
    const after = await readCamera(page)
    await page.waitForTimeout(600)
    const afterSecond = await readCamera(page)

    console.log('[V1] fit=' + JSON.stringify(fit.logical) + ' moved=' + JSON.stringify(moved.logical)
      + ' after=' + JSON.stringify(after.logical) + ' canvas=' + JSON.stringify(after.canvasDims))

    expectCameraSurvives({ fit, moved, after, afterSecond, what: '编辑逐格说明' })

    // 画面侧没有"多出一个 canvas"这类假修法
    expect(after.canvasCount, '视口 canvas 数量必须保持 1（修复不得靠并存第二个画布）').toBe(1)
    expect(after.canvasDims, 'canvas 尺寸不得变化').toEqual(fit.canvasDims)
  })

  test('V2 移动方块（g + 拖动，第一次内容投影）⇒ 机位同样不被重置', async ({ page }) => {
    test.setTimeout(300_000)
    // 与 P2-4 同口径：桌面 project 的鼠标拖动可靠；mobile 模拟下同样的拖动未触发移动
    //（P2 已登记为"未定位"项，不是本用例的结论）。
    test.skip(
      test.info().project.name !== 'desktop-chrome',
      '移动拖动判据固定在 desktop-chrome（mobile 模拟下同样拖动未触发，P2 已登记）',
    )
    await gotoWithAnnotatedCellSelected(page)

    await page.waitForTimeout(1200)
    const fit = await readCamera(page)
    await moveCameraAway(page, { target: [3, 2, 1], yawDeg: 200, elevationDeg: 55, distance: 9, zoom: 1.7 })
    const moved = await readCamera(page)
    const cellsBefore = await cellSignature(page)

    // ── 真实拖动（空白处 pointerdown → 自由移动）──
    const canvas = page.locator(VIEWPORT_CANVAS).first()
    const box = (await canvas.boundingBox())!
    const candidate = [
      { x: box.x + 12, y: box.y + box.height - 12 },
      { x: box.x + 12, y: box.y + 12 },
      { x: box.x + box.width - 12, y: box.y + 12 },
      { x: box.x + 12, y: box.y + box.height / 2 },
    ]
    await page.keyboard.press('g')
    await page.waitForTimeout(900)
    let movedLabel: string | null = null
    for (const p of candidate) {
      await page.mouse.move(p.x, p.y)
      await page.mouse.down()
      await page.mouse.move(p.x + 90, p.y, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(2000)
      const st = await page.evaluate(() => (window as any).__vm__.kernelUndoState()) as { undoLabel: string | null }
      if (typeof st.undoLabel === 'string' && st.undoLabel.startsWith('move cells')) {
        movedLabel = st.undoLabel
        break
      }
    }
    expect(movedLabel, '移动必须作为一条内核事务进撤销栈（撤销项以 `move cells` 开头）').not.toBeNull()
    expect(await cellSignature(page), '移动必须真的改变格分布（否则"机位没变"是空转）').not.toBe(cellsBefore)

    const after = await readCamera(page)
    await page.waitForTimeout(600)
    const afterSecond = await readCamera(page)
    console.log('[V2] fit=' + JSON.stringify(fit.logical) + ' moved=' + JSON.stringify(moved.logical)
      + ' after=' + JSON.stringify(after.logical) + ' label=' + movedLabel)

    expectCameraSurvives({ fit, moved, after, afterSecond, what: '移动方块' })
  })
})
