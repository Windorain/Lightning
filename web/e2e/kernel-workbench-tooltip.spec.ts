/**
 * M3-shell B1 · 编辑器视口的悬停信息落在**固定位**（原 #398 判据的改写）。
 *
 * ## 本次改写为什么发生
 *
 * 旧判据（M2-2 #398）要求工作台主视口悬停方块时出现 .wm-tooltip-box。M3-shell B1
 * 按用户裁决把悬浮 ToolTipBox **从编辑器视口撤除**：跟随指针的提示框在编辑时挡住
 * 正在编辑的格子，而悬停信息本来就有两条更好的固定位：
 *
 *  - 底栏 StatusBar 的悬停格读数（data-hovered-cell）；
 *  - （设计 C5① 还想要右栏回落，但实测面板目标解析只认选中集/悬停注解 ——
 *    见 H1 ④ 的如实记录，补齐需改 editors 层，B1 护栏外，列 B2 候选。）
 *
 * 嵌入预览器（EmbedViewport，region r-wiki-preview）仍是渲染器视口，ToolTipBox
 * 原样保留 —— 本文件用**同一套真实悬停注入**分别打两个 region，证明这是
 * 「呈现位置的选择」而不是「能力的丢失」。
 *
 * ## 判据（真实入口 + 双向对照）
 *
 * H1（编辑器侧）：
 *  1. 生产入口打开夹具（OPERATOR_OPEN_SCENE + File），真实 pointermove 命中带逐格
 *     说明的格（候选自夹具原件解出，不硬编码坐标）；
 *  2. **负对照**：编辑器视口命中后 .wm-tooltip-box 计数为 0；
 *  3. **正对照**：底栏 data-hovered-cell 显示悬停格的内核世界坐标 —— 走生产装配的
 *     getHoveredBlock() 读面（不是手工塞进 DOM 的载荷）；
 *  4. pointerleave ⇒ 悬停读数消失、viewportBlock 清空。
 *
 * H2（嵌入侧，region 区分）：
 *  5. 切到 Wiki 工作区、在 r-wiki-preview 上真实悬停 ⇒ .wm-tooltip-box 出现且文本
 *     含该格逐格说明与方块 NEI 名（旧链路未回退）；
 *  6. 偏好 showHoverTooltip:false（`lk-ui.v1.workbench.viewer.r-wiki-preview`；M7-6 起键带实例段）⇒ 拾取仍在、
 *     tooltip 计数 0（偏好门禁在**仍然存在**的那条呈现上照旧生效）。
 */
import { expect, test, type Page } from '@playwright/test'
import { gotoWorkbench, injectSceneDocumentOk } from './helpers/multiblock/harness'
import {
  clearWikiHover,
  injectHoverAtCellLocal,
  readTooltipText,
  readWikiHover,
  TOOLTIP_BOX,
  WIKI_REGION,
  WIKI_TAB_TEXT,
  waitWikiViewportReady,
  type WikiHoverObservation,
} from './helpers/parts/hover'
import { fixturePath, innerDocOf, readJson, type InnerDoc } from './helpers/saveReopen'

const REGION = 'r-viewport'
const FIXTURE = 'structuredata-exported-envelope.json'
/**
 * Wiki 预览 region 的 viewer 偏好键（M7-6 起**带实例段**）：
 * `runtime/instanceStorage#instanceUiKey('workbench', 'viewer.r-wiki-preview')`。
 * 旧键 `lightning.prefs.wiki-preview` 已作废（不迁移）。
 */
const WIKI_PREF_KEY = 'lk-ui.v1.workbench.viewer.r-wiki-preview'

/** 夹具里的一个「带逐格说明的格」候选（文件索引 = hover voxel 下标）。 */
interface Candidate {
  z: number
  row: number
  col: number
  /** 逐格说明文本（夹具 tooltipPalette，独立来源）。 */
  cellText: string
  /** 该格方块的 NEI 首行（夹具 blockPalette[slot].tooltip[0]）。 */
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
        if (slot === undefined || slot === 0) continue // 0 = air
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
  return s.replace(/§./g, '').replace(/\s+/g, '')
}

/** 等某个 region 的槽位活着（camera + definition + domElement），并等相机稳定。 */
async function waitViewportLive(page: Page, rid: string): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const slot = (window as any).__vm__?.viewports?.get(id)
      return !!slot?.camera?.value && !!slot?.definition?.value && !!slot?.domElement?.value
    },
    rid,
    { timeout: 60_000 },
  )
  const readCam = () =>
    page.evaluate((id) => {
      const cam = (window as any).__vm__?.viewports?.get(id)?.camera?.value
      return cam ? JSON.stringify([cam.position.toArray(), cam.zoom]) : null
    }, rid)
  const deadline = Date.now() + 20_000
  let prev = await readCam()
  for (;;) {
    await page.waitForTimeout(250)
    const cur = await readCam()
    if (cur && cur === prev) return
    prev = cur
    if (Date.now() > deadline) throw new Error('B1：视口相机在 20s 内未稳定（' + rid + '）')
  }
}

/** 生产入口：打开工作台并装载真实信封（OPERATOR_OPEN_SCENE + File）。 */
async function openWorkbench(page: Page): Promise<void> {
  await gotoWorkbench(page)
  await injectSceneDocumentOk(page, readJson(fixturePath()), FIXTURE)
  await waitViewportLive(page, REGION)
}

/** 生产入口：装载同一夹具，再经 WorkspaceTabs 的 DOM click 进入 Wiki 工作区。 */
async function openWiki(page: Page): Promise<void> {
  await gotoWorkbench(page)
  await injectSceneDocumentOk(page, readJson(fixturePath()), FIXTURE)
  await page.locator('.wt-tab', { hasText: WIKI_TAB_TEXT }).click()
  await waitWikiViewportReady(page)
  await waitViewportLive(page, WIKI_REGION)
}

/** 读 hover，最多等 timeout（拾取是 rAF 合并的；未命中 ⇒ null，不抛错）。 */
async function readHoverWithin(page: Page, rid: string, timeout = 1200): Promise<WikiHoverObservation | null> {
  const deadline = Date.now() + timeout
  for (;;) {
    const h = await readWikiHover(page, rid)
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
async function findVisibleAnnotatedCell(
  page: Page,
  candidates: readonly Candidate[],
  rid: string,
): Promise<Hit> {
  const tried: string[] = []
  for (const candidate of candidates) {
    for (const local of LOCAL_POINTS) {
      await clearWikiHover(page, rid)
      await injectHoverAtCellLocal(page, { ...candidate, ...local }, rid)
      const hover = await readHoverWithin(page, rid, 900)
      const v = hover?.voxel
      if (!v) {
        tried.push(candidate.z + '/' + candidate.row + '/' + candidate.col + ' → 未命中')
        continue
      }
      if (v.column === candidate.col && v.row === candidate.row && v.zSlice === candidate.z) {
        return { candidate, hover, local }
      }
      tried.push(
        candidate.z + '/' + candidate.row + '/' + candidate.col + ' → 命中 voxel ' +
          v.zSlice + '/' + v.row + '/' + v.column,
      )
    }
  }
  throw new Error(
    'B1：真实 pointermove 未命中任何带逐格说明的格（候选 ' + candidates.length + ' 个，region ' + rid + '）。' +
      '已试：\n' + tried.join('\n'),
  )
}

test.describe('M3-shell B1 · 编辑器视口悬停（固定位呈现）', () => {
  test('B1-H1 编辑器视口：无悬浮 ToolTipBox；底栏/右栏显示悬停格；离开清空', async ({ page }) => {
    test.setTimeout(300_000)
    const doc = innerDocOf(fixturePath())
    const candidates = annotatedCandidates(doc)
    expect(candidates.length, '前提：夹具必须真有带逐格说明的格（否则本用例空转）').toBeGreaterThan(0)
    const sizeRow = doc.cellGrid[0]!.length

    // ── ① 生产入口 + 真实 pointermove 命中带逐格说明的格 ──
    await openWorkbench(page)
    const hit = await findVisibleAnnotatedCell(page, candidates, REGION)
    expect(hit.hover.voxel, '前提：真实 pointermove 必须被内核拾取（viewportBlock 非空）').toEqual({
      column: hit.candidate.col,
      row: hit.candidate.row,
      zSlice: hit.candidate.z,
    })

    // 内核世界坐标：row（文件，顶部为 0）→ y = sizeRow - 1 - row。
    const worldX = hit.candidate.col
    const worldY = sizeRow - 1 - hit.candidate.row
    const worldZ = hit.candidate.z

    // ── ② 负对照：编辑器视口不再出现悬浮 ToolTipBox ──
    // 留一拍：若呈现件被重新接回，ToolTipBox 会在这段时间内挂载（判据不靠"恰好没渲染"）。
    await page.waitForTimeout(700)
    await expect(
      page.locator(TOOLTIP_BOX),
      'B1：编辑器视口悬停不得再出现悬浮 ToolTipBox（悬停信息落固定位）',
    ).toHaveCount(0)

    // ── ③ 正对照（底栏固定位）：同一读面的悬停格读数 ──
    const readout = page.locator('[data-hovered-cell]')
    await expect(readout, 'B1：底栏必须有悬停格读数').toHaveCount(1)
    const readoutText = (await readout.first().innerText()).replace(/\s+/g, ' ').trim()
    expect(readoutText, '底栏悬停读数必须是悬停格的内核世界坐标').toBe(
      '悬停 ' + worldX + ', ' + worldY + ', ' + worldZ,
    )

    // ── ④ 为什么这里**没有**右栏断言（B1 实测记录，见回报的偏差项）──
    // 设计 C5① 假定「右栏 inspector 无选中时回落悬停方块」已是既有能力
    // （workbench-rna#resolveRefs :200-204）。实测不成立：resolveRefs 只决定
    // "属性的目标引用"，而**面板目标解析**在 editors/workbench-inspector
    // （resolveInspectorTargets）里只看选中集与悬停**注解**——悬停方块不产生 target，
    // 于是无选中时面板恒为「未选择目标」，".ux-field-readonly" 不存在。
    // 补齐它需要改 editors 层的目标解析，超出 B1「只动外壳呈现层」的护栏，
    // 故 B1 的悬停固定位由 ③（底栏）承担；右栏回落列为 B2 候选。
    // 这里只断言「悬停时面板不会被假的字段值污染」：字段缺席而不是显示错格。
    await expect(
      page.locator('[data-property="lightning.block.pos"]'),
      'B1：无选中时面板不得凭空渲染方块字段（回落能力未建成，如实为空）',
    ).toHaveCount(0)

    // ── ⑤ 生命周期：pointerleave ⇒ 读数消失、悬停清空 ──
    await clearWikiHover(page, REGION)
    await expect(page.locator('[data-hovered-cell]'), 'pointerleave 后悬停读数必须消失').toHaveCount(0)
    expect(await readWikiHover(page, REGION), 'pointerleave 后 viewportBlock 必须清空').toBeNull()
  })

  test('B1-H2 嵌入预览视口（r-wiki-preview）仍显示 ToolTipBox；偏好关闭仍生效', async ({ page }) => {
    test.setTimeout(300_000)
    const doc = innerDocOf(fixturePath())
    const candidates = annotatedCandidates(doc)
    expect(candidates.length, '前提：夹具必须真有带逐格说明的格').toBeGreaterThan(0)

    // ── ① 渲染器视口：同一套真实悬停注入，ToolTipBox 必须照旧出现 ──
    await openWiki(page)
    const hit = await findVisibleAnnotatedCell(page, candidates, WIKI_REGION)
    const box = page.locator(TOOLTIP_BOX + '[role="tooltip"]')
    await expect(box, 'B1：渲染器视口（r-wiki-preview）仍必须显示 ToolTipBox').toHaveCount(1)
    await expect(box).toBeVisible()
    const text = await readTooltipText(page)
    expect(text, '嵌入侧 tooltip 必须有文本').not.toBeNull()
    expect(norm(text!), '必须含该格逐格说明「' + hit.candidate.cellText + '」').toContain(
      norm(hit.candidate.cellText),
    )
    expect(norm(text!), '必须含方块标识「' + hit.candidate.blockName + '」').toContain(
      norm(hit.candidate.blockName),
    )

    // ── ② 偏好门禁（既有语义）：关闭 showHoverTooltip ⇒ 拾取仍在、tooltip 不显示 ──
    await page.evaluate(
      (key) => localStorage.setItem(key, JSON.stringify({ showHoverTooltip: false })),
      WIKI_PREF_KEY,
    )
    await openWiki(page)
    await injectHoverAtCellLocal(page, { ...hit.candidate, ...hit.local }, WIKI_REGION)
    const hoverOff = await readHoverWithin(page, WIKI_REGION, 5000)
    expect(hoverOff, '负对照前提：偏好关闭后拾取仍必须发生').not.toBeNull()
    await page.waitForTimeout(500)
    await expect(
      page.locator(TOOLTIP_BOX + '[role="tooltip"]'),
      '负对照：showHoverTooltip:false 时不得显示 tooltip',
    ).toHaveCount(0)
    await page.evaluate((key) => localStorage.removeItem(key), WIKI_PREF_KEY)
  })
})
