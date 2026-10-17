/**
 * **M4-2 · 双区编辑同步判据**（真实双 3D Area 上的一次编辑，另一区必须看得见）。
 *
 * ## 本文件补的缺口（S0 域 1 缺口 ⑤ + M4-1 的遗留建议）
 *
 * M4-1（'kernel-dual-area.spec.ts'）证的是**归属**：悬停描边、activeAreaId、工具与 gizmo
 * 各归各区。它没有证**同步**：S0 域 1 的缺口 ⑤ 原文是「无『A 编辑 B 画面变』断言
 * （A05 是同页两次 read() 非两真实视口）」，p10b-a05a17 的判据也确实是同一个页面里
 * 连调两次 'kernel.read()' —— 那证明的是"读面没有视口参数"，不是"两个真视口看到同一份内容"。
 *
 * 本文件在**两个真实 3D Area** 上跑六条判据（DE-1..6）。
 *
 * ## 观测面（零替身，全部生产读面）
 *
 * - 选择：**真实左键**（page.mouse.click）打在经该区相机投影出的格点上；
 * - 编辑：右栏生成式 Inspector 的 [data-property="lightning.block.tooltip"] 输入框；
 * - 内容：'plainForSave().plain'（生产保存读面，与 P2/P3 同一口径）；
 * - **B 区读面**：'viewports.get(rid).definition'（'ViewportSlot#definition' —— 该视口
 *   渲染与拾取吃的那份定义；M4-1 之后每区各有一份，见 'WorkbenchViewport.vue'
 *   的 'watch(structureDefinition)'）。它的 'cellTooltipGrid' 是**下标网格**，文本要用
 *   同一份内容上的调色板解出：优先用定义自带的 'tooltipPalette'（旧格式路径会挂），
 *   否则用 'kernelRenderSourceFace().definitionAt(i)' 的池 —— 那正是 DRW 给本视口
 *   'structureDefinition' 的**同一个**产者（'composition/kernelPresentationInputs'），
 *   故下标与文本必然配对（不是第二套编码）。
 *   **为什么不读底栏/检查器**：M3-shell B1 已把悬浮 ToolTipBox 从编辑器视口撤除，
 *   且检查器的目标解析只认选中集（B1 ④ 实测），故"B 区悬停后底栏读数"只能证明
 *   B 区的**拾取**活着，证明不了该格**内容**是新的。这点在每条断言里都如实标注。
 * - 历史/脏：'kernelUndoState()' / 'kernelDirty()'（生产读面，见 saveReopen helper）；
 * - 机位：'main.ensureCamera(region)'（权威逻辑机位）+ 'viewports.get(region).camera'
 *   （真实 THREE 相机；只比取景三要素，不整体 stringify —— 见 kernel-viewport-camera）。
 *
 * ## 为什么单独开一个 spec 文件（而不是并入 kernel-dual-area.spec.ts）
 *
 * ① 交付轴不同：那份是"归属"（谁拥有悬停/工具），本份是"同步"（一次编辑在两区的可观测面）；
 * ② 定向复跑的粒度：M4-1 已验收的 DA-1..3 不该因本包改动而被拖着重跑；
 * ③ 该文件已 17 KB，再塞六条用例会让"一条失败看哪一段"变难。
 */

import { expect, test, type Page } from '@playwright/test'
import { gotoWorkbench, injectSceneDocumentOk, VIEWPORT_CANVAS, waitForViewportMounted } from './helpers/multiblock'
import { projectCellLocal, readWikiHover, type WikiHoverObservation } from './helpers/parts/hover'
import {
  fieldOf,
  fixturePath,
  innerDocOf,
  isDirty,
  readJson,
  selectedPos,
  TOOLTIP_FIELD,
  undoState,
  writeField,
  type InnerDoc,
} from './helpers/saveReopen'

const FIXTURE = 'structuredata-exported-envelope.json'
const ROOT_REGION = 'r-viewport'

/** 夹具里**既有方块又有逐格说明**的格（独立来源：文件原件，不在断言里回算被测解析链）。 */
interface Candidate {
  z: number
  row: number
  col: number
  /** 夹具里该格的逐格说明（面板显示的期望文本）。 */
  text: string
}

function annotatedCandidates(doc: InnerDoc): Candidate[] {
  const out: Candidate[] = []
  const tooltips = doc.tooltipPalette
  for (let z = 0; z < doc.cellTooltipGrid.length; z++) {
    const slice = doc.cellTooltipGrid[z]!
    for (let row = 0; row < slice.length; row++) {
      const line = slice[row]!
      for (let col = 0; col < line.length; col++) {
        const idx = line[col]!
        if (idx < 0) continue
        const text = tooltips[idx]
        if (typeof text !== 'string' || text.length === 0) continue
        const slot = doc.cellGrid[z]?.[row]?.[col]
        if (slot === undefined || slot === 0) continue
        out.push({ z, row, col, text })
      }
    }
  }
  return out.sort((a, b) => a.z - b.z || a.row - b.row || a.col - b.col)
}

/** 格内局部采样点：中心优先，再试五个面心（同一格可见面可能只有一个）。 */
const LOCAL_POINTS = [
  { lx: 0.5, ly: 0.5, lz: 0.5 },
  { lx: 0.5, ly: 0.9, lz: 0.5 },
  { lx: 0.5, ly: 0.5, lz: 0.9 },
  { lx: 0.9, ly: 0.5, lz: 0.5 },
  { lx: 0.5, ly: 0.1, lz: 0.5 },
] as const

/** 经真实命令路径分割（OPERATOR_AREA_SPLIT，与 p10b-area-wiring / M4-1 同一条路）。 */
async function splitArea(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (window as any).__vm__.getOperators().exec('OPERATOR_AREA_SPLIT', { direction: 'horizontal' })
  })
}

interface DualArea {
  readonly areas: ReadonlyArray<{ areaId: string; region: string }>
}

async function readDualArea(page: Page): Promise<DualArea> {
  return await page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll('.area-node--leaf[data-area-id]') as NodeListOf<HTMLElement>)
    return { areas: cells.map((c) => ({ areaId: c.dataset.areaId ?? '', region: c.dataset.wmRegion ?? '' })) }
  })
}

interface AreaRef {
  areaId: string
  region: string
}

/** 打开工作台 → 注入真实信封 → 分割 → 等两个叶子/两个视口槽位都活着。 */
async function openDualArea(page: Page): Promise<{ a: AreaRef; b: AreaRef }> {
  await gotoWorkbench(page)
  await injectSceneDocumentOk(page, readJson(fixturePath()), FIXTURE)
  await waitForViewportMounted(page)
  await splitArea(page)
  await expect.poll(async () => (await readDualArea(page)).areas.length, { timeout: 30_000 }).toBe(2)
  const { areas } = await readDualArea(page)
  await expect
    .poll(async () => (await page.locator(VIEWPORT_CANVAS + ' canvas').count()), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2)
  await page.waitForFunction(
    (ids) => {
      const vm = (window as any).__vm__
      return ids.every((id) => {
        const slot = vm?.viewports?.get(id)
        return !!slot?.camera?.value && !!slot?.definition?.value && !!slot?.domElement?.value
      })
    },
    areas.map((x) => x.region),
    { timeout: 60_000 },
  )
  expect(areas[0]!.region, '前提：第一个叶子仍是根区（DOM 顺序 = 布局顺序）').toBe(ROOT_REGION)
  return { a: areas[0]!, b: areas[1]! }
}

// ─────────────────────────────────────────────────────────────────────────────
// 真实指针：投影 → 鼠标移动 → 拾取核对 → 左键
// ─────────────────────────────────────────────────────────────────────────────

interface Hit {
  candidate: Candidate
  local: { lx: number; ly: number; lz: number }
  client: { x: number; y: number }
}

/** 读某 region 的悬停态，最多等 timeout（拾取是 rAF 合并的；未命中 ⇒ null，不抛错）。 */
async function readHoverWithin(page: Page, rid: string, timeout = 900): Promise<WikiHoverObservation | null> {
  const deadline = Date.now() + timeout
  for (;;) {
    const h = await readWikiHover(page, rid)
    if (h) return h
    if (Date.now() > deadline) return null
    await page.waitForTimeout(30)
  }
}

/**
 * 用**真鼠标移动**在指定 region 上扫候选格，返回"悬停返回的 voxel = 该候选格"的落点。
 *
 * 坐标不硬编码：由该区**当前相机**把格内局部点投影到 client（projectCellLocal，
 * 与生产悬停注入同一套数学）；命中与否以拾取实际返回为准（射线可能先打到更靠前的方块）。
 */
async function findHitPoint(page: Page, rid: string, candidates: readonly Candidate[]): Promise<Hit> {
  const tried: string[] = []
  for (const candidate of candidates) {
    for (const local of LOCAL_POINTS) {
      const pt = await projectCellLocal(page, { ...candidate, ...local }, rid)
      await page.mouse.move(pt.clientX, pt.clientY)
      const hover = await readHoverWithin(page, rid)
      const v = hover?.voxel
      if (!v) {
        tried.push(candidate.z + '/' + candidate.row + '/' + candidate.col + '@' + local.lx + ',' + local.ly + ',' + local.lz + ' → 未命中')
        continue
      }
      if (v.column === candidate.col && v.row === candidate.row && v.zSlice === candidate.z) {
        return { candidate, local, client: { x: pt.clientX, y: pt.clientY } }
      }
      tried.push(
        candidate.z + '/' + candidate.row + '/' + candidate.col + ' → 命中 voxel ' + v.zSlice + '/' + v.row + '/' + v.column,
      )
    }
  }
  throw new Error(
    'M4-2：region ' + rid + ' 上真鼠标移动未命中任何带逐格说明的格（候选 ' + candidates.length + ' 个）。已试：\n' +
      tried.join('\n'),
  )
}

/** 内核世界坐标（面板口径）：文件 [z][row][col] → (col, sizeRow-1-row, z)。 */
function kernelPosOf(candidate: Candidate, sizeRow: number): [number, number, number] {
  return [candidate.col, sizeRow - 1 - candidate.row, candidate.z]
}

/** 文件索引三元组（cellTooltipGrid / cellGrid 的下标）。 */
function fileIdxOf(candidate: Candidate): [number, number, number] {
  return [candidate.z, candidate.row, candidate.col]
}

// ─────────────────────────────────────────────────────────────────────────────
// 生产读面
// ─────────────────────────────────────────────────────────────────────────────

/** 内核内容里该格的逐格说明（plainForSave().plain）。 */
async function kernelTooltipAt(page: Page, idx: [number, number, number]): Promise<string | null> {
  return await page.evaluate((i) => {
    const p = (window as any).__vm__.plainForSave().plain
    const z = i[0]
    const row = i[1]
    const col = i[2]
    const slot = p.cellTooltipGrid?.[z]?.[row]?.[col]
    if (typeof slot !== 'number' || slot < 0) return null
    return p.tooltipPalette?.[slot] ?? null
  }, idx)
}

interface DefinitionTooltip {
  text: string | null
  slot: number | null
  /**
   * 该区**当前 definition 对象的身份令牌**（页内 WeakMap 发放）。
   *
   * 为什么必须读它：文本本身**不足以**证明"这个区刷新了自己的定义"——把**陈旧的**
   * 说明下标网格与**当前的**说明池配对，也可能解出新文本（本包实测：把 DRW 的内容
   * 重解分支短路后，文本断言仍然绿）。令牌变了才说明本区的 DRW 在编辑后**重新解析
   * 过**自己的定义（`definitionOfPayload` 每次调用都产新对象）。
   */
  token: number | null
}

/**
 * **某区自己的呈现读面**里该格的逐格说明（ViewportSlot#definition）。
 *
 * 这是该视口渲染/拾取吃的那份网格定义（M4-1 后每区各一份）：cellTooltipGrid 给出下标，
 * 文本用同一份内容上的调色板解出（定义自带的优先，否则用内核渲染源面的池 —— 同一个产者）。
 * 同时回 slot：让调用方能跨区比"是不是同一个下标"（内容去重后同文本应同下标）。
 */
async function definitionTooltipAt(
  page: Page,
  rid: string,
  idx: [number, number, number],
): Promise<DefinitionTooltip> {
  return await page.evaluate(
    (arg: { rid: string; i: number[] }) => {
      const vm = (window as any).__vm__
      const def = vm?.viewports?.get(arg.rid)?.definition?.value ?? null
      if (!def) return { text: null, slot: null, token: null }
      const w = window as any
      w.__defTokens__ = w.__defTokens__ ?? { map: new WeakMap(), next: 1 }
      const tokens = w.__defTokens__
      let token = tokens.map.get(def)
      if (token === undefined) {
        token = tokens.next++
        tokens.map.set(def, token)
      }
      const slot = def.cellTooltipGrid?.[arg.i[0]]?.[arg.i[1]]?.[arg.i[2]]
      if (typeof slot !== 'number' || slot < 0) {
        return { text: null, slot: typeof slot === 'number' ? slot : null, token }
      }
      const own = Array.isArray(def.tooltipPalette) ? (def.tooltipPalette as string[]) : null
      const face = typeof vm.kernelRenderSourceFace === 'function' ? vm.kernelRenderSourceFace() : null
      const pair = face ? face.definitionAt(vm.getFrameIndex()) : null
      const palette = own ?? ((pair ? pair.tooltipPalette : []) as string[])
      return { text: palette[slot] ?? null, slot, token }
    },
    { rid, i: idx },
  )
}

/**
 * 两区的呈现读面是否是**两个不同对象**（不是共用一个）。
 *
 * 这条是判据的**反恒真锚点**：若将来两区共用同一份 definition，那么"B 区读面是新值"
 * 与"A 区读面是新值"会变成同一句话，本文件的同步判据就退化为恒绿。
 */
async function definitionsAreDistinct(page: Page, ridA: string, ridB: string): Promise<boolean> {
  return await page.evaluate(
    (arg: { a: string; b: string }) => {
      const vm = (window as any).__vm__
      const da = vm?.viewports?.get(arg.a)?.definition?.value ?? null
      const db = vm?.viewports?.get(arg.b)?.definition?.value ?? null
      return da !== null && db !== null && da !== db
    },
    { a: ridA, b: ridB },
  )
}

/** 某区视口定义里的逐格内容（世界坐标 → 方块身份；判"另一区是否看到移动后的内容"）。 */
async function definitionCells(page: Page, rid: string): Promise<Record<string, string>> {
  return (await page.evaluate((id: string) => {
    const vm = (window as any).__vm__
    const def = vm?.viewports?.get(id)?.definition?.value ?? null
    if (!def) return {}
    const grid = def.cellGrid as number[][][]
    const palette = (def.blockPalette ?? []) as { registryId?: string; meta?: number }[]
    const h = grid[0]?.length ?? 0
    const out: Record<string, string> = {}
    for (let z = 0; z < grid.length; z++) {
      for (let row = 0; row < grid[z]!.length; row++) {
        for (let col = 0; col < grid[z]![row]!.length; col++) {
          const slot = Number(grid[z]![row]![col])
          if (slot === 0) continue
          const entry = palette[slot]
          out[col + ',' + (h - 1 - row) + ',' + z] = entry ? entry.registryId + ':' + (entry.meta ?? 0) : 'slot:' + slot
        }
      }
    }
    return out
  }, rid)) as Record<string, string>
}

/** 权威逻辑机位（main.ensureCamera(region)）。 */
async function logicalCamera(page: Page, rid: string): Promise<unknown> {
  return await page.evaluate((id: string) => {
    const vm = (window as any).__vm__
    const ref = vm.main.ensureCamera(id)
    return ref?.value ? JSON.parse(JSON.stringify(ref.value)) : null
  }, rid)
}

/**
 * 引擎侧机位签名：只取决定取景的稳定字段（世界矩阵 / zoom / 正交取景框）。
 * 不整体 stringify THREE 相机（uuid 每次新建都不同 ⇒ 恒判"变了"）。
 */
async function engineCamera(
  page: Page,
  rid: string,
): Promise<{ m: number[] | null; zoom: number | null; frustum: unknown[] }> {
  return await page.evaluate((id: string) => {
    const cam = (window as any).__vm__?.viewports?.get(id)?.camera?.value ?? null
    return {
      m: cam?.matrixWorld?.elements ? Array.from(cam.matrixWorld.elements as number[]) : null,
      zoom: typeof cam?.zoom === 'number' ? cam.zoom : null,
      frustum: [cam?.left ?? null, cam?.right ?? null, cam?.top ?? null, cam?.bottom ?? null],
    }
  }, rid)
}

/** 把某区机位挪到**显著不同的非默认机位**（判"没变"的前提）。 */
async function setCamera(
  page: Page,
  rid: string,
  pose: { target: [number, number, number]; yawDeg: number; elevationDeg: number; distance: number; zoom: number },
): Promise<void> {
  await page.evaluate(
    (arg: { id: string; p: typeof pose }) => {
      const vm = (window as any).__vm__
      vm.main.ensureCamera(arg.id).value = {
        target: { x: arg.p.target[0], y: arg.p.target[1], z: arg.p.target[2] },
        yawDeg: arg.p.yawDeg,
        elevationDeg: arg.p.elevationDeg,
        distance: arg.p.distance,
        zoom: arg.p.zoom,
      }
    },
    { id: rid, p: pose },
  )
  await page.waitForTimeout(900)
}

/** 内核逐格内容（世界坐标 → 方块身份），与 kernel-move-persist 同一口径。 */
async function kernelCells(page: Page): Promise<Record<string, string>> {
  return (await page.evaluate(() => {
    const p = (window as any).__vm__.plainForSave().plain
    const grid = p.cellGrid as number[][][]
    const palette = (p.blockPalette ?? []) as { registryId?: string; meta?: number }[]
    const h = grid[0]?.length ?? 0
    const out: Record<string, string> = {}
    for (let z = 0; z < grid.length; z++) {
      for (let row = 0; row < grid[z]!.length; row++) {
        for (let col = 0; col < grid[z]![row]!.length; col++) {
          const slot = Number(grid[z]![row]![col])
          if (slot === 0) continue
          const entry = palette[slot]
          out[col + ',' + (h - 1 - row) + ',' + z] = entry ? entry.registryId + ':' + (entry.meta ?? 0) : 'slot:' + slot
        }
      }
    }
    return out
  })) as Record<string, string>
}

/** 某区画布上**未被覆盖层遮挡**的点（工具架/分隔条会盖住画布边缘）。 */
async function uncoveredPoints(page: Page, rid: string): Promise<Array<{ x: number; y: number }>> {
  return await page.evaluate((id: string) => {
    const el = (window as any).__vm__.viewports.get(id).domElement.value as HTMLElement
    const r = el.getBoundingClientRect()
    const raw = [
      { x: r.x + r.width / 2, y: r.y + 12 },
      { x: r.x + 12, y: r.y + r.height / 2 },
      { x: r.x + 12, y: r.bottom - 12 },
      { x: r.right - 12, y: r.bottom - 12 },
      { x: r.x + r.width / 2, y: r.bottom - 12 },
    ]
    return raw.filter((pt) => document.elementFromPoint(pt.x, pt.y) === el)
  }, rid)
}

/** 某区画布上一个**悬停无 voxel** 的空白点（移动工具下"按下即自由移动"的起点）。 */
async function findEmptyPoint(page: Page, rid: string): Promise<{ x: number; y: number } | null> {
  for (const pt of await uncoveredPoints(page, rid)) {
    await page.mouse.move(pt.x, pt.y)
    if ((await readHoverWithin(page, rid, 700)) === null) return pt
  }
  return null
}

/** 单个指定格能否被真实指针命中（能 ⇒ 返回落点）。 */
async function findHitForCell(page: Page, rid: string, candidate: Candidate): Promise<Hit | null> {
  for (const local of LOCAL_POINTS) {
    const pt = await projectCellLocal(page, { ...candidate, ...local }, rid)
    await page.mouse.move(pt.clientX, pt.clientY)
    const hover = await readHoverWithin(page, rid)
    const v = hover?.voxel
    if (v && v.column === candidate.col && v.row === candidate.row && v.zSlice === candidate.z) {
      return { candidate, local, client: { x: pt.clientX, y: pt.clientY } }
    }
  }
  return null
}

/**
 * 可移动的格：统计每个实心格**六面里有多少个空邻居**，按"空邻居多 → 离网格中心近"排序。
 *
 * 空邻居越多，拖动能落到合法位置的方向就越多。本样本是**实心块**，"六面皆空"的格
 * 可能为 0 —— 故不要求 6，只要 ≥2 就有多个方向可选（实测本夹具中心格 free=2~3）。
 * 候选来自**内核读面**（`plainForSave().plain` 的 cellGrid），不是夹具原文 ——
 * 移动判据判的是"当前文档里的这一格"，与读取链无关。
 */
async function movableCells(page: Page): Promise<Array<Candidate & { free: number }>> {
  const data = await page.evaluate(() => {
    const plain = (window as any).__vm__.plainForSave().plain
    const grid = plain.cellGrid as number[][][]
    const h = grid[0]?.length ?? 0
    const w = grid[0]?.[0]?.length ?? 0
    const d = grid.length
    const solid: Array<{ z: number; row: number; col: number; free: number }> = []
    const at = (x: number, y: number, z: number): number => {
      if (z < 0 || z >= d || y < 0 || y >= h || x < 0 || x >= w) return 0
      return Number(grid[z][h - 1 - y]?.[x] ?? 0)
    }
    for (let z = 0; z < d; z++) {
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          if (Number(grid[z][row]?.[col] ?? 0) === 0) continue
          const y = h - 1 - row
          const free = ([
            [1, 0, 0],
            [-1, 0, 0],
            [0, 1, 0],
            [0, -1, 0],
            [0, 0, 1],
            [0, 0, -1],
          ] as const).filter((n) => at(col + n[0], y + n[1], z + n[2]) === 0).length
          if (free >= 2) solid.push({ z, row, col, free })
        }
      }
    }
    const cx = (w - 1) / 2
    const cy = (h - 1) / 2
    const cz = (d - 1) / 2
    return solid
      .map((c) => ({
        z: c.z,
        row: c.row,
        col: c.col,
        free: c.free,
        score: Math.abs(c.col - cx) + Math.abs(c.row - cy) + Math.abs(c.z - cz),
      }))
      .sort((a, b) => b.free - a.free || a.score - b.score)
      .map((c) => ({ z: c.z, row: c.row, col: c.col, free: c.free }))
  })
  return data.map((c) => ({ ...c, text: '' }))
}

/** 真实拖动一次（中键），用于纯读操作（平移/旋转相机）。 */
async function dragMiddle(page: Page, from: { x: number; y: number }, dx: number, dy: number, shift = false): Promise<void> {
  if (shift) await page.keyboard.down('Shift')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 })
  await page.mouse.up({ button: 'middle' })
  if (shift) await page.keyboard.up('Shift')
  await page.waitForTimeout(700)
}

test.describe('M4-2 · 双区编辑同步（一次编辑，另一区看得见）', () => {
  test('DE-1 A 区真实点选 + 右栏编辑 ⇒ B 区同格呈现读面为新值', async ({ page }) => {
    test.setTimeout(300_000)
    const doc = innerDocOf(fixturePath())
    const candidates = annotatedCandidates(doc)
    expect(candidates.length, '前提：夹具必须真有"有方块且有逐格说明"的格').toBeGreaterThan(0)
    const sizeRow = doc.cellGrid[0]!.length

    const { a, b } = await openDualArea(page)

    // ── ① A 区真实左键点选一格（不是选择 API）──
    const hit = await findHitPoint(page, a.region, candidates)
    await page.mouse.click(hit.client.x, hit.client.y)
    const kernelPos = kernelPosOf(hit.candidate, sizeRow)
    const fileIdx = fileIdxOf(hit.candidate)
    await expect
      .poll(async () => await selectedPos(page), { message: 'A 区真实左键必须让右栏显示被点中的格', timeout: 10_000 })
      .toEqual(kernelPos)

    // ── ② 前提：右栏值与**两区**呈现读面此刻都是夹具原文 ──
    expect((await fieldOf(page, TOOLTIP_FIELD))?.value, '前提：右栏字段值必须来自夹具原件').toBe(hit.candidate.text)
    expect(
      (await definitionTooltipAt(page, a.region, fileIdx)).text,
      '前提：A 区自己的呈现读面此刻必须携带夹具原文（读面活着、且解得出文本）',
    ).toBe(hit.candidate.text)
    expect(
      (await definitionTooltipAt(page, b.region, fileIdx)).text,
      '前提：B 区自己的呈现读面此刻也必须携带夹具原文（否则"B 区可见"无从观测）',
    ).toBe(hit.candidate.text)

    // ── ②b 编辑前的现场身份：B 区读面的令牌 + B 区宿主（画布/DOM）身份 ──
    // 这两样是"B 区自己刷新了"的**确定性**证据：文本可能因"陈旧网格 + 当前池"而偶然
    // 读对新值（本包实测过），令牌不会。宿主身份则用来排除"刷新来自视口被整体重建"。
    const bTokenBefore = (await definitionTooltipAt(page, b.region, fileIdx)).token
    expect(bTokenBefore, '前提：B 区读面必须存在（令牌非空）').not.toBeNull()
    const hostB0 = await page.evaluate((rid: string) => {
      const vm = (window as any).__vm__
      ;(window as any).__deHostB__ = vm.viewports.get(rid).domElement.value
      return document.querySelectorAll('canvas').length
    }, b.region)
    // ── ③ 经右栏改该格的逐格说明（生产提交链）──
    const NEW = 'M4-2 DE-1（e2e）A→B'
    await writeField(page, TOOLTIP_FIELD, NEW)

    await expect
      .poll(async () => await kernelTooltipAt(page, fileIdx), {
        message: '编辑必须落进内核内容（生产提交链）',
        timeout: 15_000,
      })
      .toBe(NEW)

    // ── ④ 主断言：**B 区自己的**呈现读面必须（a）重新解析过、且（b）同格解出新值 ──
    //
    // 两条同时成立才是"B 区看得见"：
    //  - 令牌变化 ⇒ B 的 DRW 在编辑后重解了自己的定义（`definitionAt` → 新对象）；
    //  - 文本 = 新值 ⇒ 该定义里这一格读出的就是新内容。
    // 只断言文本而不断言令牌，会在"B 从不刷新、只是把陈旧下标配上当前说明池"时**假绿**
    // ——本包用源码变异（短路 `applyContentRefresh` 的重解分支）实测过这一点。
    await expect
      .poll(
        async () => {
          const s = await definitionTooltipAt(page, b.region, fileIdx)
          return { refreshed: s.token !== bTokenBefore, text: s.text }
        },
        {
          message: 'A 区编辑后 B 区必须重解自己的定义（令牌变）且同格读出新值',
          timeout: 20_000,
        },
      )
      .toEqual({ refreshed: true, text: NEW })

    // B 区**宿主**不得被重建来伪装"刷新"（M1 V1 同一条口径：canvas 数不得变）
    expect(
      await page.evaluate((rid: string) => {
        const vm = (window as any).__vm__
        return {
          domSame: vm.viewports.get(rid).domElement.value === (window as any).__deHostB__,
          canvasCount: document.querySelectorAll('canvas').length,
        }
      }, b.region),
      'B 区读面的刷新不得靠"重建视口宿主"实现（DOM 元素与 canvas 数必须不变）',
    ).toEqual({ domSame: true, canvasCount: hostB0 })
    expect(
      (await definitionTooltipAt(page, a.region, fileIdx)).text,
      'A 区自己的呈现读面同样应为新值（两区读的是同一份内容的两个视口读面）',
    ).toBe(NEW)
    expect(
      (await definitionTooltipAt(page, a.region, fileIdx)).slot,
      '两区定义里该格必须指向**同一个**说明池下标（内容去重后同文本 ⇒ 同下标）',
    ).toBe((await definitionTooltipAt(page, b.region, fileIdx)).slot)

    // ── ④b 反恒真：两区读面必须是**两个不同对象**，且未改的另一格仍是它自己的原文 ──
    expect(
      await definitionsAreDistinct(page, a.region, b.region),
      '两区的 definition 必须是两个不同对象（否则"B 区是新值"与"A 区是新值"是同一句话）',
    ).toBe(true)
    const other = candidates.find(
      (c) => !(c.z === hit.candidate.z && c.row === hit.candidate.row && c.col === hit.candidate.col),
    )
    expect(other, '前提：夹具必须还有第二个带说明的格（用于"未被改的格不变"的对照）').toBeTruthy()
    expect(
      (await definitionTooltipAt(page, b.region, fileIdxOf(other!))).text,
      'B 区读面不得"把所有格都读成新值"（未被编辑的另一格必须仍是它自己的原文）',
    ).toBe(other!.text)

    // ── ⑤ B 区视口本身必须活着：真实指针在 B 区悬停该格仍命中同一格 ──
    // （区分"B 区的定义被更新了"与"B 区根本不是活视口、定义是陈旧残留"）
    const ptB = await projectCellLocal(page, { ...hit.candidate, ...hit.local }, b.region)
    await page.mouse.move(ptB.clientX, ptB.clientY)
    const hoverB = await readHoverWithin(page, b.region, 5000)
    expect(hoverB?.voxel, 'B 区真实悬停必须命中该格（B 区拾取链活着）').toEqual({
      column: hit.candidate.col,
      row: hit.candidate.row,
      zSlice: hit.candidate.z,
    })

    console.log(
      '[DE-1] regions=' + a.region + '|' + b.region +
        ' 格=' + hit.candidate.z + '/' + hit.candidate.row + '/' + hit.candidate.col +
        ' 原文="' + hit.candidate.text + '" → "' + NEW + '"',
    )
  })

  test('DE-2 B 区真实点选 + 右栏编辑 ⇒ A 区同格呈现读面为新值（反向对称）', async ({ page }) => {
    test.setTimeout(300_000)
    const doc = innerDocOf(fixturePath())
    const candidates = annotatedCandidates(doc)
    expect(candidates.length, '前提：夹具必须真有带逐格说明的格').toBeGreaterThan(0)
    const sizeRow = doc.cellGrid[0]!.length

    const { a, b } = await openDualArea(page)

    // ── ① B 区真实左键点选一格 ──
    const hit = await findHitPoint(page, b.region, candidates)
    await page.mouse.click(hit.client.x, hit.client.y)
    const kernelPos = kernelPosOf(hit.candidate, sizeRow)
    const fileIdx = fileIdxOf(hit.candidate)
    await expect
      .poll(async () => await selectedPos(page), {
        message: 'B 区真实左键必须让右栏显示被点中的那一格（点选按区，不是按根区相机）',
        timeout: 10_000,
      })
      .toEqual(kernelPos)
    expect((await fieldOf(page, TOOLTIP_FIELD))?.value, '前提：右栏字段值必须来自夹具原件').toBe(hit.candidate.text)

    // ── ② 前提：A 区呈现读面此刻携带夹具原文 + 记下它的令牌与宿主身份 ──
    const aBefore = await definitionTooltipAt(page, a.region, fileIdx)
    expect(aBefore.text, '前提：A 区自己的呈现读面此刻必须携带夹具原文').toBe(hit.candidate.text)
    expect(aBefore.token, '前提：A 区读面必须存在（令牌非空）').not.toBeNull()
    const hostA0 = await page.evaluate((rid: string) => {
      const vm = (window as any).__vm__
      ;(window as any).__deHostA__ = vm.viewports.get(rid).domElement.value
      return document.querySelectorAll('canvas').length
    }, a.region)

    // ── ③ 经右栏改该格（同一个生产提交链，只是点选发生在 B 区）──
    const NEW = 'M4-2 DE-2（e2e）B→A'
    await writeField(page, TOOLTIP_FIELD, NEW)
    await expect
      .poll(async () => await kernelTooltipAt(page, fileIdx), { message: '编辑必须落进内核内容', timeout: 15_000 })
      .toBe(NEW)

    // ── ④ 主断言：A 区自己的读面必须（a）重新解析过、且（b）同格解出新值 ──
    // （与 DE-1 同一条口径：只断言文本会在"陈旧网格 + 当前说明池"下假绿）
    await expect
      .poll(
        async () => {
          const s = await definitionTooltipAt(page, a.region, fileIdx)
          return { refreshed: s.token !== aBefore.token, text: s.text }
        },
        { message: 'B 区编辑后 A 区必须重解自己的定义（令牌变）且同格读出新值', timeout: 20_000 },
      )
      .toEqual({ refreshed: true, text: NEW })

    expect(
      await page.evaluate((rid: string) => {
        const vm = (window as any).__vm__
        return {
          domSame: vm.viewports.get(rid).domElement.value === (window as any).__deHostA__,
          canvasCount: document.querySelectorAll('canvas').length,
        }
      }, a.region),
      'A 区读面的刷新不得靠"重建视口宿主"实现（DOM 元素与 canvas 数必须不变）',
    ).toEqual({ domSame: true, canvasCount: hostA0 })
    expect(
      (await definitionTooltipAt(page, b.region, fileIdx)).text,
      'B 区自己的呈现读面同样应为新值',
    ).toBe(NEW)
    expect(
      await definitionsAreDistinct(page, a.region, b.region),
      '两区的 definition 必须是两个不同对象（反恒真锚点）',
    ).toBe(true)
    const other = candidates.find(
      (c) => !(c.z === hit.candidate.z && c.row === hit.candidate.row && c.col === hit.candidate.col),
    )
    expect(other, '前提：夹具必须还有第二个带说明的格').toBeTruthy()
    expect(
      (await definitionTooltipAt(page, a.region, fileIdxOf(other!))).text,
      'A 区读面不得"把所有格都读成新值"（未被编辑的另一格必须仍是它自己的原文）',
    ).toBe(other!.text)

    // ── ⑤ A 区视口还活着：真实悬停该格仍命中 ──
    const ptA = await projectCellLocal(page, { ...hit.candidate, ...hit.local }, a.region)
    await page.mouse.move(ptA.clientX, ptA.clientY)
    const hoverA = await readHoverWithin(page, a.region, 5000)
    expect(hoverA?.voxel, 'A 区真实悬停必须命中该格').toEqual({
      column: hit.candidate.col,
      row: hit.candidate.row,
      zSlice: hit.candidate.z,
    })

    console.log(
      '[DE-2] regions=' + b.region + '→' + a.region +
        ' 格=' + hit.candidate.z + '/' + hit.candidate.row + '/' + hit.candidate.col +
        ' 原文="' + hit.candidate.text + '" → "' + NEW + '"',
    )
  })

  test('DE-3 同一条历史：A 区编辑一次只 +1；焦点在 B 按 Ctrl+Z 照样回退', async ({ page }) => {
    test.setTimeout(300_000)
    const doc = innerDocOf(fixturePath())
    const candidates = annotatedCandidates(doc)
    const sizeRow = doc.cellGrid[0]!.length
    const { a, b } = await openDualArea(page)

    // 前提：装载基线必须干净（否则"一次撤销回基线"无从判定）
    expect(await undoState(page), '前提：刚装载的文档不得已有可撤销/重做的编辑').toEqual({
      canUndo: false,
      canRedo: false,
      undoLabel: null,
      redoLabel: null,
    })

    const hit = await findHitPoint(page, a.region, candidates)
    await page.mouse.click(hit.client.x, hit.client.y)
    const fileIdx = fileIdxOf(hit.candidate)
    await expect.poll(async () => await selectedPos(page)).toEqual(kernelPosOf(hit.candidate, sizeRow))

    const NEW = 'M4-2 DE-3（e2e）'
    await writeField(page, TOOLTIP_FIELD, NEW)
    await expect.poll(async () => await kernelTooltipAt(page, fileIdx)).toBe(NEW)

    // ── ① 一次编辑 = 恰好一条历史：撤销项指向该格 ──
    const afterEdit = await undoState(page)
    expect(afterEdit.canUndo, '编辑必须进内核撤销栈').toBe(true)
    expect(String(afterEdit.undoLabel), '撤销项文案必须指向被改的那一格').toContain('cell tooltip @')

    // ── ② 把焦点挪到 B 区（真实点选 B 区一格）──
    // 活动区必须是 B —— 否则"在 B 按 Ctrl+Z"与"在 A 按"没有区别，判据没有区分力。
    const hitB = await findHitPoint(page, b.region, candidates)
    await page.mouse.click(hitB.client.x, hitB.client.y)
    await expect
      .poll(async () => await page.evaluate(() => (window as any).__areaHost__()?.activeAreaId?.value ?? null), {
        message: '点 B 区之后活动区必须是 B（焦点确实在 B）',
      })
      .toBe(b.areaId)

    // ── ③ 焦点在 B 区按 Ctrl+Z ⇒ 内容回退（撤销不按区分叉）──
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(1200)
    expect(
      await kernelTooltipAt(page, fileIdx),
      '焦点在 B 区时 Ctrl+Z 必须回退文档内容（撤销不按区分叉）',
    ).toBe(hit.candidate.text)
    const afterUndo = await undoState(page)
    expect(
      afterUndo.canUndo,
      '一次撤销必须回到装载基线（栈空）—— 若一次编辑记了多条历史，这里仍会有可撤销项',
    ).toBe(false)
    expect(afterUndo.canRedo, '撤销后必须可重做').toBe(true)
    await expect
      .poll(async () => (await definitionTooltipAt(page, b.region, fileIdx)).text, {
        message: '撤销回退后 B 区呈现读面必须回到原文（回退对两区同样可见）',
        timeout: 20_000,
      })
      .toBe(hit.candidate.text)
    expect((await definitionTooltipAt(page, a.region, fileIdx)).text, 'A 区呈现读面同样回到原文').toBe(
      hit.candidate.text,
    )

    // ── ④ 栈空后再按：不得改内容（不回落旧栈）──
    const emptyState = await undoState(page)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(900)
    expect(await undoState(page), '栈空后 Ctrl+Z 不得改变栈状态（不回落旧栈）').toEqual(emptyState)
    expect(await kernelTooltipAt(page, fileIdx), '栈空后 Ctrl+Z 不得改内容').toBe(hit.candidate.text)

    // ── ⑤ 焦点仍在 B 重做 ⇒ 新值回来，两区都看得见 ──
    await page.keyboard.press('Control+Shift+z')
    await page.waitForTimeout(1200)
    expect(await kernelTooltipAt(page, fileIdx), '重做必须重现新值').toBe(NEW)
    await expect
      .poll(async () => (await definitionTooltipAt(page, b.region, fileIdx)).text, {
        message: '重做后 B 区呈现读面必须重现新值',
        timeout: 20_000,
      })
      .toBe(NEW)

    console.log('[DE-3] 格=' + fileIdx.join('/') + ' 历史项="' + String(afterEdit.undoLabel) + '" 一次撤销即回基线')
  })

})
