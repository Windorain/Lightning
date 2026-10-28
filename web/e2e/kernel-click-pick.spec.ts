/**
 * **真实左键拾取判据：在视口里点中一格 ⇒ 选择读面反映被点的那一格**
 * （缺口 2；M1 复核 §3.2 #2）。
 *
 * ## 缺陷形态（M1 复核 §3.2 #2）
 *
 * 所有 kernel spec 都用内核 API `getSelection().select(...)` 选格；全仓 `e2e/`
 * **没有一次**对画布的 `mouse.click` 选格（`input-routing` 只按中键测捕获路由）。
 * ⇒ 手测卡步骤 2 里用户真正做的事（在视口里点中 `9,2,5`）没有自动判据。
 *
 * ## 判据（B 级：真实入口 + 负对照）
 *
 * 1. 输入：生产 `OPERATOR_OPEN_SCENE` + `File`（真实信封原件），视口/相机就绪；
 * 2. 坐标：**不硬编码**。候选格从夹具 `cellGrid` 解出（非空格），每格再取格内
 *    局部采样点，经**视口当前相机**投影到 client 坐标（`projectCellLocal`，
 *    与生产悬停注入同一套数学）；
 * 3. 命中判据以**拾取实际返回**为准：先 `page.mouse.move`（真鼠标事件）→ 读内核
 *    悬停态；只有当 hover 返回的 voxel **等于候选格**时才算"这一点真的打在这格上"，
 *    否则试下一个采样点/下一格（射线可能先打到更靠前的方块）；
 * 4. 主断言：`page.mouse.click`（真实左键，非注入事件）之后
 *    - 内核选择读面（`getSelection().items`）**恰好**是那一格；
 *    - 右栏生产 UI（`lightning.block.pos` 的只读值）显示**同一坐标**；
 *    - 选中项的 block 身份与夹具里该格的一致（把"坐标对上"升级成"内容对上"）；
 * 5. 负对照：点在**空白处**（悬停无 voxel 的画布点）⇒ 选择被清空，
 *    且不得仍选着刚才那一格。这条同时证明主断言不是"点了就恒有选择"。
 */
import { expect, test, type Page } from '@playwright/test'
import { gotoWorkbench, injectSceneDocumentOk } from './helpers/multiblock/harness'
import { clearWikiHover, readWikiHover, projectCellLocal, type WikiHoverObservation } from './helpers/parts/hover'
import { fixturePath, innerDocOf, readJson, selectedPos, type InnerDoc } from './helpers/saveReopen'
import { waitCameraStable, waitViewportLive } from './helpers/viewportPixels'

const FIXTURE = 'structuredata-exported-envelope.json'
const REGION = 'r-viewport'

interface Candidate {
  z: number
  row: number
  col: number
  /** 该格方块在生产读面上的身份（`registryId:meta`，来自夹具原件 + 生产 plain）。 */
  registryId: string
  meta: number
}

/** 夹具里**全部非空**的格（独立来源：文件原件，不在断言里回算被测解析链）。 */
function solidCandidates(doc: InnerDoc): Candidate[] {
  const blocks = doc.blockPalette as ReadonlyArray<{ registryId?: string; meta?: number }>
  const out: Candidate[] = []
  for (let z = 0; z < doc.cellGrid.length; z++) {
    const slice = doc.cellGrid[z]!
    for (let row = 0; row < slice.length; row++) {
      const line = slice[row]!
      for (let col = 0; col < line.length; col++) {
        const slot = line[col]!
        if (slot === 0) continue
        const entry = blocks[slot]
        if (!entry?.registryId) continue
        out.push({ z, row, col, registryId: entry.registryId, meta: entry.meta ?? 0 })
      }
    }
  }
  // 相机 init 机位在 (-x, +y, -z) 象限：先试低 z / 小行号（高世界 Y）/ 低列，命中概率高。
  return out.sort((a, b) => a.z - b.z || a.row - b.row || a.col - b.col)
}

/** 格内局部采样点：中心优先，再试六个面心（同一格的可见面可能只有一个）。 */
const LOCAL_POINTS: ReadonlyArray<{ lx: number; ly: number; lz: number }> = [
  { lx: 0.5, ly: 0.5, lz: 0.5 },
  { lx: 0.5, ly: 0.9, lz: 0.5 },
  { lx: 0.5, ly: 0.5, lz: 0.9 },
  { lx: 0.9, ly: 0.5, lz: 0.5 },
  { lx: 0.1, ly: 0.5, lz: 0.5 },
  { lx: 0.5, ly: 0.1, lz: 0.5 },
  { lx: 0.5, ly: 0.5, lz: 0.1 },
]

/** 内核选择读面：选中的方块（世界坐标 + 身份）。 */
async function selectedBlocks(page: Page): Promise<{ x: number; y: number; z: number; blockId: string }[]> {
  return (await page.evaluate(() => {
    const sel = (window as any).__vm__.getSelection()
    return [...sel.items.value]
      .filter((e: any) => e.kind === 'block')
      .map((e: any) => ({
        x: e.ref.pos.x,
        y: e.ref.pos.y,
        z: e.ref.pos.z,
        blockId: String(e.ref.block_state_id ?? ''),
      }))
  })) as { x: number; y: number; z: number; blockId: string }[]
}

/**
 * 生产读面上该格的方块身份（`plainForSave().plain` → `blockPalette[cellGrid[z][row][col]]`）。
 *
 * 为什么用它当期望值：选择读面的 `block_state_id` 来自**同一份内核内容**，
 * 判据要证的是"点中的是内容里的这一格"，而不是"名字串恰好等于夹具原文"——
 * 后者会被已登记的**命名空间显示差异**（M1 复核 §2.1：`tectech:`/`gregtech:`
 * 在产物里显示为 `minecraft:`）干扰。夹具的 `meta` 不受该差异影响，
 * 下面另外用 meta 做一条独立的交叉核对。
 */
async function productionBlock(
  page: Page,
  cell: { z: number; row: number; col: number },
): Promise<{ registryId: string; meta: number }> {
  return (await page.evaluate((c) => {
    const p = (window as any).__vm__.plainForSave().plain
    const slot = Number(p.cellGrid?.[c.z]?.[c.row]?.[c.col] ?? 0)
    const entry = p.blockPalette?.[slot]
    return entry ? { registryId: String(entry.registryId ?? ''), meta: Number(entry.meta ?? 0) } : { registryId: '', meta: -1 }
  }, cell)) as { registryId: string; meta: number }
}

/** 读 hover，最多等 `timeout`（拾取是 rAF 合并的；未命中 ⇒ null，不抛错）。 */
async function readHoverWithin(page: Page, timeout = 1500): Promise<WikiHoverObservation | null> {
  const deadline = Date.now() + timeout
  for (;;) {
    const h = await readWikiHover(page, REGION)
    if (h) return h
    if (Date.now() > deadline) return null
    await page.waitForTimeout(30)
  }
}

interface Hit {
  candidate: Candidate
  local: { lx: number; ly: number; lz: number }
  client: { x: number; y: number }
}

/**
 * 用**真鼠标移动**扫描候选，返回第一个"hover 返回的 voxel = 该候选格"的落点。
 * 失败时把全部尝试打印出来（不假绿）。
 */
async function findHitPoint(page: Page, candidates: readonly Candidate[]): Promise<Hit> {
  const tried: string[] = []
  for (const candidate of candidates) {
    for (const local of LOCAL_POINTS) {
      const pt = await projectCellLocal(page, { ...candidate, ...local }, REGION)
      await page.mouse.move(pt.clientX, pt.clientY)
      const hover = await readHoverWithin(page, 800)
      const v = hover?.voxel
      const where = `${candidate.z}/${candidate.row}/${candidate.col}@${local.lx},${local.ly},${local.lz} → (${pt.clientX.toFixed(1)},${pt.clientY.toFixed(1)})`
      if (!v) {
        tried.push(where + ' 未命中')
        continue
      }
      if (v.column === candidate.col && v.row === candidate.row && v.zSlice === candidate.z) {
        return { candidate, local, client: { x: pt.clientX, y: pt.clientY } }
      }
      tried.push(where + ` 命中 voxel ${v.zSlice}/${v.row}/${v.column}`)
    }
  }
  throw new Error(
    `真鼠标移动未命中任何非空格（共 ${candidates.length} 个候选）。已试：\n` + tried.join('\n'),
  )
}

/** 生产入口：打开工作台 → 真实信封 → 视口活着 + 相机稳定。 */
async function openFixture(page: Page): Promise<void> {
  await gotoWorkbench(page)
  await injectSceneDocumentOk(page, readJson(fixturePath()), FIXTURE)
  await waitViewportLive(page, REGION)
  await waitCameraStable(page, REGION)
}

test.describe('真实左键拾取（真实工作台入口）', () => {
  test('CP-1 画布上真实左键点击一格 ⇒ 选择读面与右栏都反映被点的那一格；空白处点击 ⇒ 无该选择', async ({ page }) => {
    test.setTimeout(300_000)
    const candidates = solidCandidates(innerDocOf(fixturePath()))
    expect(candidates.length, '前提：夹具必须真有非空格（否则本用例空转）').toBeGreaterThan(0)

    await openFixture(page)

    // 前置：开始前没有选择（否则"选中了"可能来自旧状态）
    await clearWikiHover(page, REGION)
    expect(await selectedBlocks(page), '前提：装载后不得已有选择').toEqual([])

    // ── ① 找到"真鼠标打得到"的格 ──
    const hit = await findHitPoint(page, candidates)
    console.log(
      `[CP-1] 命中格 z/row/col=${hit.candidate.z}/${hit.candidate.row}/${hit.candidate.col}` +
        ` local=${JSON.stringify(hit.local)} client=${JSON.stringify(hit.client)} block=${hit.candidate.registryId}:${hit.candidate.meta}`,
    )

    // ── ② 真实左键点击（不是注入事件）──
    await page.mouse.click(hit.client.x, hit.client.y)

    // ── ③ 主断言：选择读面恰好是那一格 ──
    // 文件索引 → 世界坐标：Y = 高度 - 1 - 行号（结构网格口径，与 `kernelAnnotations` 同一换算）
    const gridHeight = innerDocOf(fixturePath()).cellGrid[0]!.length
    const expectedPos = {
      x: hit.candidate.col,
      y: gridHeight - 1 - hit.candidate.row,
      z: hit.candidate.z,
    }
    await expect
      .poll(async () => await selectedBlocks(page), { message: '真实左键点击必须让选择读面落地', timeout: 10_000 })
      .toEqual([{ ...expectedPos, blockId: expect.any(String) }])
    const selected = (await selectedBlocks(page))[0]!
    // 身份对照走**生产内容**（不是夹具原文）：命名空间显示差异已在 M1 复核 §2.1 登记。
    const production = await productionBlock(page, hit.candidate)
    expect(production.registryId, '前提：生产读面上该格必须有方块身份').not.toBe('')
    expect(selected.blockId, '① 选中项必须是该格的方块身份（与生产内容逐字一致，不是空气/邻格）').toBe(
      production.registryId,
    )
    expect(production.meta, '① 生产内容里该格的 meta 必须与夹具一致（meta 不受命名空间显示差异影响）').toBe(
      hit.candidate.meta,
    )
    expect(
      selected.blockId.includes(hit.candidate.registryId.split(':')[1] ?? ''),
      '① 方块路径部分必须与夹具该格一致（只允许命名空间不同）',
    ).toBe(true)
    console.log(
      `[CP-1] 夹具身份=${hit.candidate.registryId}:${hit.candidate.meta} 生产身份=${production.registryId}:${production.meta} 选择身份=${selected.blockId}`,
    )

    // ── ④ 生产 UI 读面复核（右栏生成式 Inspector 的只读坐标）──
    await expect
      .poll(async () => await selectedPos(page), { message: '右栏必须显示选中坐标（面板拿到目标）', timeout: 10_000 })
      .toEqual([expectedPos.x, expectedPos.y, expectedPos.z])
    expect(await selectedPos(page), '④ 右栏坐标必须与选择读面一致').toEqual([expectedPos.x, expectedPos.y, expectedPos.z])

    // ── ⑤ 负对照：点空白处 ⇒ 选择被清空（不得仍选着刚才那一格）──
    const canvasBox = await page.evaluate((rid) => {
      const el = (window as any).__vm__.viewports.get(rid).domElement.value as HTMLElement
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }, REGION)
    // 候选点必须**真的落在视口 canvas 上**（实测：画布矩形四角被 `wb-toolshelf` /
    // `wb-divider` 覆盖，点上去命中的是 DOM 覆盖层而不是画布 —— 那样的点击
    // 既不会触发拾取也不会清空选择，用它当负对照会得出错误结论）。
    const probes = await page.evaluate((rid) => {
      const el = (window as any).__vm__.viewports.get(rid).domElement.value as HTMLElement
      const r = el.getBoundingClientRect()
      const raw = [
        { x: r.x + r.width / 2, y: r.y + 6 },
        { x: r.x + 6, y: r.y + r.height / 2 },
        { x: r.x + 6, y: r.bottom - 6 },
        { x: r.right - 6, y: r.bottom - 6 },
      ]
      return raw.filter((p) => document.elementFromPoint(p.x, p.y) === el)
    }, REGION)
    expect(probes.length, '负对照前提：画布上必须有未被覆盖层的点').toBeGreaterThan(0)
    let emptyPoint: { x: number; y: number } | null = null
    for (const p of probes) {
      await page.mouse.move(p.x, p.y)
      if ((await readHoverWithin(page, 600)) === null) {
        emptyPoint = p
        break
      }
    }
    expect(emptyPoint, '负对照前提：画布上必须存在悬停无 voxel 的空白点').not.toBeNull()
    await page.mouse.click(emptyPoint!.x, emptyPoint!.y)
    await expect
      .poll(async () => await selectedBlocks(page), { message: '负对照：空白处点击必须清空选择', timeout: 10_000 })
      .toEqual([])
    expect(
      await page.evaluate(
        () => document.querySelector('[data-property="lightning.block.pos"] .ux-field-readonly')?.textContent?.trim() ?? null,
      ),
      '负对照：空白处点击后右栏不得仍显示坐标',
    ).toBeNull()
  })
})
