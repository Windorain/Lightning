/**
 * M2-2 · **#398 回归判据：工作台主视口悬停方块必须显示 ToolTipBox**（真实入口）。
 *
 * ## 缺陷形态（#398）
 *
 * 工作台 3D Area 渲染的是 `WorkbenchViewport`，它的内核悬停 `viewportBlock` 一直有值
 * （拾取正常），但页面上 **`.wm-tooltip-box` 计数恒为 0 —— 显示消费方缺失**。
 * `9390643c`（2026-05-20「remove old ToolTip」）把整条 tooltip 链从工作台视口删除后
 * 从未恢复；`EmbedViewport` 里的 tooltip 层只服务 Wiki 工作区，不在这条路径上。
 *
 * ## 修法落点（本判据要证明的事实）
 *
 * - 模块：`shared/viewport/ToolTipBox.vue` + `shared/viewport/useEmbedTooltip.ts`
 *   （工作台与嵌入预览器共用；#398 前置提交把它从 `embed/` 归位）；
 * - 接线：`WorkbenchViewport.vue` 从**本 region** 的 `state.hover` 经
 *   `embedHoverFromState` 取 `viewportBlock`，喂给同一条解析链；
 * - 不改内核 hover 态：`hover.annotation` 是互斥的「3D 注解对象命中」通道，
 *   不能承载逐格说明（SPEC §3.5「注解与逐格说明是不同对象」）。
 *
 * ## 判据（B 级：真实入口 + 最小负对照）
 *
 * 1. 生产入口：`gotoWorkbench` → 生产 `OPERATOR_OPEN_SCENE` + `File`
 *    （`injectSceneDocumentOk`，夹具 `structuredata-exported-envelope.json`）→
 *    `r-viewport` 视口/相机就绪；
 * 2. 真实 `pointermove`（`injectHoverAtCellLocal(..., 'r-viewport')`，与生产
 *    `viewportBinder` 监听同一路径）命中**带逐格说明的格**：候选从夹具
 *    `cellTooltipGrid`/`tooltipPalette` 解出（独立来源），再以 **hover 实际返回的
 *    voxel** 为准核对 —— 不硬编码单据里那个在原始 `cellGrid` 是 air 的示例坐标；
 * 3. 前提：`region('r-viewport').state.hover.viewportBlock` 非空（拾取真的发生）；
 * 4. 主断言：`.wm-tooltip-box[role="tooltip"]` 可见，且文本同时含
 *    该格逐格说明（夹具 `tooltipPalette`）与方块 NEI 名（夹具 `blockPalette` 首行）；
 * 5. 负对照：`showHoverTooltip:false` ⇒ 计数 0（既有偏好门禁不变）；
 * 6. 生命周期：`pointerleave` ⇒ tooltip 消失。
 *
 * 选择器用 `.wm-tooltip-box`（`ToolTipBox` 的 `role="tooltip"`），**不是**
 * `.tip-preview`（后者是面板内嵌的死组件，无定位/Teleport）。
 *
 * 文本比对做 CRLF/空白归一 + MC 颜色码剥离：`ToolTipBox` 经受控呈现边界
 * （`ContentText` → `domain/textContent`）渲染，`§x` 变为颜色节点后不再出现在 DOM 文本里。
 */
import { expect, test, type Page } from '@playwright/test'
import {
  gotoWorkbench,
  injectSceneDocumentOk,
  waitForViewportMounted,
} from './helpers/multiblock/harness'
import {
  clearWikiHover,
  injectHoverAtCellLocal,
  readTooltipText,
  readWikiHover,
  TOOLTIP_BOX,
  type WikiHoverObservation,
} from './helpers/parts/hover'
import { fixturePath, innerDocOf, readJson, type InnerDoc } from './helpers/saveReopen'

const REGION = 'r-viewport'
const FIXTURE = 'structuredata-exported-envelope.json'
const PREF_KEY = 'lightning.prefs.viewport'

/** 夹具里的一个「带逐格说明的格」候选（文件索引 = hover voxel 下标）。 */
interface Candidate {
  z: number
  row: number
  col: number
  /** 逐格说明文本（夹具 `tooltipPalette`，独立来源）。 */
  cellText: string
  /** 该格方块的 NEI 首行（夹具 `blockPalette[slot].tooltip[0]`）。 */
  blockName: string
}

/** 从夹具原件解出全部候选（独立于页面状态，不在断言里回算被测解析链）。 */
function annotatedCandidates(doc: InnerDoc): Candidate[] {
  const blocks = doc.blockPalette as ReadonlyArray<{ tooltip?: readonly string[] }>
  const out: Candidate[] = []
  for (let z = 0; z < doc.cellTooltipGrid.length; z++) {
    const slice = doc.cellTooltipGrid[z]!
    for (let row = 0; row < slice.length; row++) {
      const line = slice[row]!
      for (let col = 0; col < line.length; col++) {
        const idx = line[col]!
        if (idx < 0) continue
        const cellText = doc.tooltipPalette[idx]
        if (typeof cellText !== 'string' || cellText.length === 0) continue
        const slot = doc.cellGrid[z]?.[row]?.[col]
        if (slot === undefined || slot === 0) continue // 0 = air（单据示例坐标即此坑）
        const blockName = blocks[slot]?.tooltip?.[0]
        if (typeof blockName !== 'string' || blockName.length === 0) continue
        out.push({ z, row, col, cellText, blockName })
      }
    }
  }
  // 相机 init 机位在 (-x, +y, -z) 象限：先试低 z / 高世界行（row 小）/ 低列，命中概率高。
  return out.sort((a, b) => a.z - b.z || a.row - b.row || a.col - b.col)
}

/** 归一：剥 MC 颜色码 + 去掉全部空白（DOM innerText 与夹具原文的格式差异）。 */
function norm(s: string): string {
  return s.replace(/§./g, '').replace(/s+/g, '')
}

/** 等 `r-viewport` 槽位活着（camera + definition + domElement），并等相机稳定。 */
async function waitViewportLive(page: Page): Promise<void> {
  await waitForViewportMounted(page)
  await page.waitForFunction(
    (rid) => {
      const slot = (window as any).__vm__?.viewports?.get(rid)
      return !!slot?.camera?.value && !!slot?.definition?.value && !!slot?.domElement?.value
    },
    REGION,
    { timeout: 60_000 },
  )
  const readCam = () =>
    page.evaluate((rid) => {
      const cam = (window as any).__vm__?.viewports?.get(rid)?.camera?.value
      return cam ? JSON.stringify([cam.position.toArray(), cam.zoom]) : null
    }, REGION)
  const deadline = Date.now() + 20_000
  let prev = await readCam()
  for (;;) {
    await page.waitForTimeout(250)
    const cur = await readCam()
    if (cur && cur === prev) return
    prev = cur
    if (Date.now() > deadline) throw new Error('#398：r-viewport 相机在 20s 内未稳定')
  }
}

/** 生产入口：打开工作台并装载真实信封（`OPERATOR_OPEN_SCENE` + File）。 */
async function openFixture(page: Page): Promise<void> {
  await gotoWorkbench(page)
  await injectSceneDocumentOk(page, readJson(fixturePath()), FIXTURE)
  await waitViewportLive(page)
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

interface Hit {
  candidate: Candidate
  hover: WikiHoverObservation
  local: { lx: number; ly: number; lz: number }
}

/**
 * 真实 pointermove 扫描候选，返回第一个「hover 返回的 voxel = 该候选格」的命中。
 * 射线可能先打到同一视线上更靠前的方块 ⇒ voxel 与候选不符时继续试下一格/下一采样点。
 */
async function findVisibleAnnotatedCell(page: Page, candidates: readonly Candidate[]): Promise<Hit> {
  const tried: string[] = []
  for (const candidate of candidates) {
    for (const local of LOCAL_POINTS) {
      await clearWikiHover(page, REGION)
      await injectHoverAtCellLocal(page, { ...candidate, ...local }, REGION)
      const hover = await readHoverWithin(page, 1200)
      const v = hover?.voxel
      if (!v) {
        tried.push(`${candidate.z}/${candidate.row}/${candidate.col}@${local.lx},${local.ly},${local.lz} → 未命中`)
        continue
      }
      if (v.column === candidate.col && v.row === candidate.row && v.zSlice === candidate.z) {
        return { candidate, hover, local }
      }
      tried.push(
        `${candidate.z}/${candidate.row}/${candidate.col}@${local.lx},${local.ly},${local.lz} → 命中 voxel ${v.zSlice}/${v.row}/${v.column}`,
      )
    }
  }
  throw new Error(
    `#398：真实 pointermove 未命中任何带逐格说明的格（共 ${candidates.length} 个候选）。` +
      `已试：\n${tried.join('\n')}`,
  )
}

test.describe('#398 工作台视口悬停 tooltip（真实入口）', () => {
  test('H1 真实悬停有逐格说明的格 ⇒ ToolTipBox 显示说明与方块标识；偏好关闭/pointerleave ⇒ 不显示', async ({ page }) => {
    test.setTimeout(300_000)
    const doc = innerDocOf(fixturePath())
    const candidates = annotatedCandidates(doc)
    expect(candidates.length, '前提：夹具必须真有带逐格说明的格（否则本用例空转）').toBeGreaterThan(0)

    // ── ① 生产入口 ──
    await openFixture(page)

    // ── ② 真实 pointermove 命中带逐格说明的格 ──
    const hit = await findVisibleAnnotatedCell(page, candidates)
    console.log(
      `[#398] 命中格 z/row/col=${hit.candidate.z}/${hit.candidate.row}/${hit.candidate.col}` +
        ` local=${JSON.stringify(hit.local)} voxel=${JSON.stringify(hit.hover.voxel)}` +
        ` cellText=${JSON.stringify(hit.candidate.cellText)} blockName=${JSON.stringify(hit.candidate.blockName)}`,
    )

    // ── ③ 前提：内核拾取已发生（#398 的"有拾取"部分）──
    expect(hit.hover.voxel, '前提：真实 pointermove 必须被内核拾取（viewportBlock 非空）').toEqual({
      column: hit.candidate.col,
      row: hit.candidate.row,
      zSlice: hit.candidate.z,
    })

    // ── ④ 主断言：显示层出现，文本 = 该格逐格说明 + 方块 NEI 名 ──
    const box = page.locator(`${TOOLTIP_BOX}[role="tooltip"]`)
    await expect(box, '#398：悬停带逐格说明的方块必须出现 ToolTipBox').toHaveCount(1)
    await expect(box).toBeVisible()
    const text = await readTooltipText(page)
    console.log(`[#398] tooltip 文本=${JSON.stringify(text)}`)
    expect(text, 'tooltip 必须有文本').not.toBeNull()
    expect(norm(text!), `tooltip 必须含该格逐格说明「${hit.candidate.cellText}」`).toContain(norm(hit.candidate.cellText))
    expect(norm(text!), `tooltip 必须含方块标识「${hit.candidate.blockName}」`).toContain(norm(hit.candidate.blockName))

    // ── ⑤ 生命周期：生产 pointerleave ⇒ hover 清空、tooltip 消失 ──
    await clearWikiHover(page, REGION)
    await expect(box, 'pointerleave 后 tooltip 必须消失').toHaveCount(0)
    expect(await readWikiHover(page, REGION), 'pointerleave 后 viewportBlock 必须清空').toBeNull()

    // ── ⑥ 负对照：偏好 showHoverTooltip:false ⇒ 拾取仍在、tooltip 计数 0 ──
    await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ showHoverTooltip: false })), PREF_KEY)
    await openFixture(page)
    await injectHoverAtCellLocal(page, { ...hit.candidate, ...hit.local }, REGION)
    const hoverOff = await readHoverWithin(page, 5000)
    expect(hoverOff, '负对照前提：偏好关闭后拾取仍必须发生').not.toBeNull()
    await page.waitForTimeout(500)
    await expect(
      page.locator(`${TOOLTIP_BOX}[role="tooltip"]`),
      '负对照：showHoverTooltip:false 时不得显示 tooltip',
    ).toHaveCount(0)
    await page.evaluate((key) => localStorage.removeItem(key), PREF_KEY)
  })
})
