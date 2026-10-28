/**
 * **保存工程 → 刷新 → 重开** 的真实入口原语。
 *
 * ## 为什么必须是真入口（不许"注入 `{file}` 参数"或直调算子）
 *
 * 调用方给的路径是用户能走的路径，而 `pickFile()`
 * （`operators/builtin/docLifecycleOperators.ts:85-106`）用的是**隐藏 `<input type=file>`**
 * ⇒ 可以用 `page.waitForEvent('filechooser')` + `fileChooser.setFiles(磁盘路径)` 走它。
 * 这与"给算子塞一个 `{file}` 属性"不是一回事：后者绕过了菜单接线与文件选择器，
 * 于是"打开工程这条菜单项真的通"就没人证。
 *
 * 保存同理：`SaveProjectOperator` 走 `downloadJson`（浏览器下载）⇒
 * `page.waitForEvent('download')` + `download.saveAs(磁盘路径)`，
 * 落盘位置由调用方给（一律落系统临时目录，**不落仓库树**）。
 *
 * ## 观测面（零替身）
 *
 * 全部是生产读面：`window.__vm__`（`WorkbenchRoot.vue:369` 公开观测面）
 * 的 `plainForSave()` / `kernelGrid()` / `kernelDirty()` / `kernelUndoState()` /
 * `getLocalFileName()` / `getSelection()`，加上右栏真实 DOM 字段与真实按键。
 */

import { expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { realFixturePath } from '../real-fixtures.mjs'

/** 真实游戏内导出信封（`StructureDataExporter scan`）。 */
export const ENVELOPE_FIXTURE = 'structuredata-exported-envelope.json'
/** 仓外夹具键（`web/e2e/real-fixtures.mjs` 的固定映射）。 */
export const ENVELOPE_FIXTURE_KEY = 'structureDataExportedEnvelope'
/** 右栏「Tooltip」字段（逐格说明的写入面；`lightning.block.tooltip` ⇒ `setCellTooltip`）。 */
export const TOOLTIP_FIELD = 'lightning.block.tooltip'

/**
 * 真实信封的绝对路径：**仓外**解析（`LIGHTNING_REAL_FIXTURES_DIR/structuredata/...`）。
 *
 * 惰性：只在调用时解析，模块 import 期既不读 env 也不读文件 ——
 * barrel（`helpers/multiblock/index.ts`）被数十个 spec import，顶层抛错会变成
 * Playwright 的 collection 失败（整次运行零用例）。缺件时由 `realFixturePath()`
 * 抛出带 key / 期望相对路径 / 候选的诊断，入口产物门控负责整份排除依赖 spec。
 */
export function fixturePath(): string {
  return realFixturePath(ENVELOPE_FIXTURE_KEY)
}

/**
 * 读真实信封文本并**归一化 CRLF → LF**（工作区铁律 6）。
 *
 * 外置件按 LF 定义基线；若本机复制时带了 CRLF，直接拿原文做文本断言/页面正文
 * 会让"逐字节/逐字"判据随换行形态漂移。JSON 解析本身不敏感，但同一份文本还会被
 * 当作 Wiki 页面正文、工程输入副本使用，故统一在这里归一化。
 */
export function readFixtureText(filePath: string = fixturePath()): string {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n')
}

/** 把真实信封按 LF 文本复制到 `dest`（供真实文件选择器读取；不落仓库树）。 */
export function copyFixtureTo(dest: string, sourceFile: string = fixturePath()): void {
  fs.writeFileSync(dest, readFixtureText(sourceFile), 'utf8')
}

/**
 * 产物目录（下载件 / 输入副本 / 程序化改造的样本）。
 *
 * 默认落系统临时目录；可用 `P3_OUT_DIR` 指到别处（仓库树零未跟踪文件）。
 */
export function outDir(): string {
  const dir = process.env.P3_OUT_DIR ?? path.join(os.tmpdir(), 'lightning-save-reopen')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * **按用例 × project 隔离**的产物目录。
 *
 * ⚠️ 必须隔离（实测踩过）：同一个 spec 文件会在 `desktop-chrome` 与
 * `mobile-chrome` 两个 project 上各跑一遍，两者可**并行**在同一个 worker 池里。
 * 若两条用例写同一个 `*-input-copy.json`，另一条就可能读到**写到一半**的文件
 * （实测报 `SyntaxError: Unterminated string in JSON at position 188416`，
 * 重试偶然通过 —— 典型的竞态，不是产品缺陷）。
 */
export function caseDir(caseId: string, projectName: string): string {
  const dir = path.join(outDir(), `${caseId}-${projectName}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ─────────────────────────────────────────────────────────────────────────────
// 夹具读写（期望值的**独立**来源：文件原件，不是页面状态）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 信封内层文档。
 *
 * ⚠️ **必须保留全部键**：改写副本（如"清掉最高行的注解"）后要把整份内层文档
 * 重新封回信封，只带这三项会得到一份**没有 `blockPalette`/`textureBlobs`/`frames`**
 * 的文档 —— 解析器当场抛错、装载失败（实测：探针里只带三项时 `打开场景`
 * 既不设 `localFileName` 也不报可读错误）。
 */
export interface InnerDoc {
  cellGrid: number[][][]
  cellTooltipGrid: number[][][]
  tooltipPalette: string[]
  readonly [key: string]: unknown
}

export function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFixtureText(filePath)) as Record<string, unknown>
}

/** 解开信封（`gzip+base64`）拿内层文档；非信封则原样当文档。 */
export function innerDocOf(fixtureFile: string): InnerDoc {
  return innerDocOfJson(readJson(fixtureFile))
}

/**
 * 同上，但输入是**信封的 JSON 文本**（Wiki 保存写出去的页面正文就是它）。
 *
 * 为什么必须有它：判据要证明"远端收到的是**含本次编辑**的内容"，而信封的载荷是
 * `gzip+base64` ⇒ 直接 `toContain(编辑文本)` 永远为假。这里解到内层再比对，
 * 与装载路径（`innerDocOf`）同一份解包判据，不另写一套。
 */
export function innerDocOfText(text: string): InnerDoc {
  return innerDocOfJson(JSON.parse(text) as Record<string, unknown>)
}

function innerDocOfJson(parsed: Record<string, unknown>): InnerDoc {
  const raw = parsed
  let doc: Record<string, unknown> = raw
  if (typeof raw.payload === 'string') {
    doc = JSON.parse(zlib.gunzipSync(Buffer.from(raw.payload, 'base64')).toString('utf8')) as Record<string, unknown>
  }
  const grid = doc.cellGrid as number[][][] | undefined
  const tips = doc.cellTooltipGrid as number[][][] | undefined
  const palette = doc.tooltipPalette as string[] | undefined
  if (!Array.isArray(grid) || !Array.isArray(tips) || !Array.isArray(palette)) {
    throw new Error('文档缺少逐格说明三项（cellGrid/cellTooltipGrid/tooltipPalette）')
  }
  return doc as unknown as InnerDoc
}

/** 把内层文档重新封成与原件同形态的信封（写盘供**真实文件选择器**读取）。 */
export function writeEnvelopeLike(sourceEnvelopeFile: string, inner: InnerDoc, dest: string): void {
  const raw = readJson(sourceEnvelopeFile)
  const payload = zlib.gzipSync(Buffer.from(JSON.stringify(inner), 'utf8')).toString('base64')
  fs.writeFileSync(dest, JSON.stringify({ ...raw, payload }))
}

export interface AnnotatedCell {
  /** 内核世界坐标（面板/`undoLabel` 的口径）。 */
  kernel: [number, number, number]
  /** 文件索引 `[z][row][col]`。 */
  fileIdx: [number, number, number]
  expected: string
}

/** 夹具里**全部**自带注解的格（文件索引 → 世界坐标 + 期望文本）。 */
export function annotatedCells(doc: InnerDoc): AnnotatedCell[] {
  const sizeRow = doc.cellGrid[0]!.length
  const out: AnnotatedCell[] = []
  for (let z = 0; z < doc.cellTooltipGrid.length; z++) {
    const slice = doc.cellTooltipGrid[z]!
    for (let row = 0; row < slice.length; row++) {
      const line = slice[row]!
      for (let col = 0; col < line.length; col++) {
        const idx = line[col]!
        if (idx < 0) continue
        const text = doc.tooltipPalette[idx]
        if (typeof text !== 'string' || text.length === 0) continue
        out.push({ kernel: [col, sizeRow - 1 - row, z], fileIdx: [z, row, col], expected: text })
      }
    }
  }
  return out
}

/** 夹具里第一个**自带注解**的格（P2 的 `firstAnnotatedCell` 同一条换算）。 */
export function firstAnnotatedCell(doc: InnerDoc): AnnotatedCell {
  const cells = annotatedCells(doc)
  if (cells.length === 0) throw new Error('夹具里没有任何逐格注解 —— 本用例无法建立判据（不是"断言失败"）')
  return cells[0]!
}

/**
 * 造一份"**注解不铺满最高行**"的副本（P2 §8 #3 定向判据的输入）。
 *
 * 本样本的注解恰好铺满 `row 0..5`（最高行有说明），故 #3 的"高度权威不一致"
 * 被**掩盖**。清掉 `row 0` 的全部注解后，说明格包围盒高度 < 声明高度 ⇒
 * "按包围盒推形状"的实现会产出比声明矮的 `cellTooltipGrid`，重开即搬行。
 */
export function withoutTopRowAnnotations(doc: InnerDoc): { doc: InnerDoc; cleared: number } {
  const tips = doc.cellTooltipGrid.map((slice) => slice.map((row) => [...row]))
  let cleared = 0
  for (let z = 0; z < tips.length; z++) {
    for (let col = 0; col < tips[z]![0]!.length; col++) {
      if (tips[z]![0]![col]! >= 0) {
        cleared += 1
        tips[z]![0]![col] = -1
      }
    }
  }
  // 展开**整份**内层文档（只换 `cellTooltipGrid`；其余键 —— `blockPalette`/`textureBlobs`/… —— 原样保留）
  return { doc: { ...doc, cellTooltipGrid: tips }, cleared }
}

/**
 * 半损坏信封：把**第一项** `textureBlobs` 换成非法 base64，其余键原样封回
 * （改的是内存副本，夹具原件不动）。
 *
 * 为什么坏第一项：它被 `materialPalette[0]` 引用 ⇒ 绑定层会把它算成
 * "必需且未就绪"，于是判据能同时证「坏一张只坏一张」与「缺失范围可辨认」。
 * 该函数从 `kernel-texture-progress.spec.ts` 上移到 helper —— 像素判据与
 * 状态栏判据必须吃**同一份**损坏输入，否则两条判据可能在描述不同场景。
 */
export function brokenFirstBlobEnvelope(sourceFile: string = fixturePath()): Record<string, unknown> {
  const raw = readJson(sourceFile)
  const inner = innerDocOf(sourceFile) as unknown as { textureBlobs: string[] } & Record<string, unknown>
  const blobs = inner.textureBlobs
  expect(Array.isArray(blobs) && blobs.length > 0, '前提：夹具必须有 textureBlobs').toBe(true)
  const payload = zlib
    .gzipSync(Buffer.from(JSON.stringify({ ...inner, textureBlobs: ['!!!not-base64!!!', ...blobs.slice(1)] }), 'utf8'))
    .toString('base64')
  return { ...raw, payload }
}

/** 夹具里 `materialPalette[0]` 的 locator（损坏的正是它引用的那张贴图）。 */
export function firstMaterialLocator(sourceFile: string = fixturePath()): string {
  const inner = innerDocOf(sourceFile) as unknown as { materialPalette: { locator?: string }[] }
  const locator = inner.materialPalette[0]?.locator
  expect(typeof locator === 'string' && locator.length > 0, '前提：materialPalette[0] 必须有 locator').toBe(true)
  return locator as string
}

// ─────────────────────────────────────────────────────────────────────────────
// 真实菜单 + 文件选择器 / 下载
// ─────────────────────────────────────────────────────────────────────────────

/** 「文件」菜单按钮（`workbench/ux/UIMenu.vue` 的 `.ux-menu-btn`）。 */
function fileMenuButton(page: Page) {
  return page.locator('.wb-menubar .ux-menu-btn', { hasText: '文件' }).first()
}

/** 菜单项（`.ux-menu-item`），按可见文案定位（`menuBar.ts` 的中文标签）。 */
function menuItem(page: Page, label: string) {
  return page.locator('.ux-menu-item', { hasText: label }).first()
}

/**
 * **File 菜单 → `<打开项>` → 给隐藏 `<input type=file>` 送磁盘文件**。
 *
 * 判据是"文件真的被换上"：等 `getLocalFileName().value === basename(路径)`
 * （两个打开算子末尾都写它）—— 只等 `hasLoadedDocument()` 会**在旧文档上**立即返回
 * （实测踩过：第二次装载的断言恒真，读到的还是上一份文档）。
 */
export async function openViaFileMenu(page: Page, itemLabel: '打开场景' | '打开工程', filePath: string): Promise<void> {
  const base = path.basename(filePath)
  await fileMenuButton(page).click()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 20_000 }),
    menuItem(page, itemLabel).click(),
  ])
  await chooser.setFiles(filePath)
  await page.waitForFunction(
    (b) => {
      const vm = (window as any).__vm__
      return vm?.hasLoadedDocument() === true && vm.getLocalFileName().value === b
    },
    base,
    { timeout: 60_000 },
  )
  await page.waitForTimeout(800)
}

/** **File 菜单 → `<保存项>` → 浏览器下载落盘**（返回落盘路径与建议文件名）。 */
export async function saveViaFileMenu(
  page: Page,
  itemLabel: '保存工程' | '保存到文件',
  destPath: string,
): Promise<{ path: string; suggested: string; bytes: number }> {
  await fileMenuButton(page).click()
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    menuItem(page, itemLabel).click(),
  ])
  await download.saveAs(destPath)
  await page.waitForTimeout(300)
  expect(fs.existsSync(destPath), `下载必须落盘到 ${destPath}`).toBe(true)
  return { path: destPath, suggested: download.suggestedFilename(), bytes: fs.statSync(destPath).size }
}

/**
 * **File 菜单 → 保存到 Wiki → 确认保存**（只对 **wiki-profile** 服务有效）。
 *
 * 与 `saveViaFileMenu` 的差别：这条路没有浏览器下载，写入是 `mw.Api` 的编辑请求
 * （e2e 里由 `helpers/wiki/wikiSandbox` 扮演远端并记录正文）。
 *
 * ⚠️ 返回时保存**可能仍在途**（确认按钮先关模态、再 await 算子）——
 * 这正是 S1-e 需要的时序：调用方可以在这之后立刻插入一次真实编辑。
 */
export async function saveViaWikiMenu(page: Page): Promise<void> {
  await fileMenuButton(page).click()
  await menuItem(page, '保存到 Wiki').click()
  const confirm = page.locator('.wiki-modal__primary', { hasText: '确认保存' })
  await expect(confirm, '「保存到 Wiki」必须打开确认模态（否则没走生产入口）').toBeVisible({ timeout: 20_000 })
  await confirm.click()
}

// ─────────────────────────────────────────────────────────────────────────────
// 生产读面
// ─────────────────────────────────────────────────────────────────────────────

/** 右栏字段（生成式 Inspector）：值 + 权威显示值（`data-input-display`）。 */
export async function fieldOf(page: Page, property: string): Promise<{ value: string; display: string } | null> {
  return await page.evaluate((prop) => {
    const el = document.querySelector(`[data-property="${prop}"] input`) as HTMLInputElement | null
    if (el === null) return null
    return { value: el.value, display: el.dataset.inputDisplay ?? '' }
  }, property)
}

/** 面板显示的选中坐标（内核世界坐标）。 */
export async function selectedPos(page: Page): Promise<[number, number, number] | null> {
  const text = await page.evaluate(
    () => document.querySelector('[data-property="lightning.block.pos"] .ux-field-readonly')?.textContent?.trim() ?? null,
  )
  if (text === null) return null
  const parts = text.split(',').map((s) => Number(s.trim()))
  if (parts.length !== 3 || !parts.every((n) => Number.isFinite(n))) return null
  return [parts[0]!, parts[1]!, parts[2]!]
}

/** 生产选择入口（`operators/builtin/selectOperator` 同一条路径）。 */
export async function selectCell(page: Page, kernel: [number, number, number], fileIdx: [number, number, number]): Promise<void> {
  await page.evaluate(
    (cell: { x: number; y: number; z: number; fileIdx: [number, number, number] }) => {
      const vm = (window as any).__vm__
      const p = vm.plainForSave().plain
      const [fz, frow, fcol] = cell.fileIdx
      const entry = p.blockPalette[Number(p.cellGrid[fz]?.[frow]?.[fcol] ?? 0)]
      vm.getSelection().select({ pos: { x: cell.x, y: cell.y, z: cell.z }, block_state_id: String(entry?.registryId ?? '') })
    },
    { x: kernel[0], y: kernel[1], z: kernel[2], fileIdx },
  )
  await expect
    .poll(async () => await selectedPos(page), { message: '生产选择 API 必须让右栏显示坐标（否则面板无目标）' })
    .not.toBeNull()
  expect(await selectedPos(page), '选中的必须正是目标格').toEqual(kernel)
}

export interface UndoState {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
}

export async function undoState(page: Page): Promise<UndoState> {
  return (await page.evaluate(() => (window as any).__vm__.kernelUndoState())) as UndoState
}

/** 生产脏状态读面（`Context#kernelDirty`，判据 = 内容身份 vs 保存基线）。 */
export async function isDirty(page: Page): Promise<boolean | null> {
  return (await page.evaluate(() => (window as any).__vm__.kernelDirty())) as boolean | null
}

/** 内核**世界坐标**读面上的逐格注解（`kernelGrid(i).tooltipAt`；不做行翻转）。 */
export async function kernelAnnotations(page: Page): Promise<{ dims: [number, number, number]; cells: Record<string, string> }> {
  return await page.evaluate(() => {
    const vm = (window as any).__vm__
    const g = vm.kernelGrid(0)
    const cells: Record<string, string> = {}
    if (!g) return { dims: [0, 0, 0] as [number, number, number], cells }
    for (let z = 0; z < g.depth; z++) {
      for (let y = 0; y < g.height; y++) {
        for (let x = 0; x < g.width; x++) {
          const t = g.tooltipAt({ x, y, z })
          if (typeof t === 'string' && t.length > 0) cells[`${x},${y},${z}`] = t
        }
      }
    }
    return { dims: [g.depth, g.height, g.width] as [number, number, number], cells }
  })
}

/** 结构 + 纹理的**机械**快照（逐格 / 逐条 / blob 逐字节）。 */
export async function structureSnapshot(page: Page): Promise<{
  cellGrid: string
  blockPalette: string[]
  materialCount: number
  textureBlobs: string
  tooltipShape: [number, number, number]
  gridShape: [number, number, number]
}> {
  return await page.evaluate(() => {
    const p = (window as any).__vm__.plainForSave().plain
    const tb = p.textureBlobs
    const blobs: string[] = Array.isArray(tb) ? tb : Object.keys(tb ?? {}).sort((a, b) => Number(a) - Number(b)).map((k) => tb[k])
    const dims = (g: unknown): [number, number, number] => {
      const a = g as number[][][] | undefined
      return [a?.length ?? 0, a?.[0]?.length ?? 0, a?.[0]?.[0]?.length ?? 0]
    }
    return {
      cellGrid: JSON.stringify(p.cellGrid),
      blockPalette: (p.blockPalette ?? []).map((e: any) => `${e.registryId}@${e.meta}`),
      materialCount: (p.materialPalette ?? []).length,
      textureBlobs: blobs.join('|'),
      tooltipShape: dims(p.cellTooltipGrid),
      gridShape: dims(p.cellGrid),
    }
  })
}

/** 交草稿并**脱开文本控件**（焦点在文本控件里时 Ctrl+Z 作用于草稿，不是文档历史）。 */
export async function commitAndBlur(page: Page, property: string): Promise<void> {
  const loc = page.locator(`[data-property="${property}"] input`)
  await loc.press('Tab')
  await page.waitForTimeout(500)
  await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    el?.blur?.()
  })
  await page.waitForTimeout(700)
  const focus = await page.evaluate(() => (window as any).__p7_input__?.textFocus()?.controlId ?? null)
  expect(focus, 'Ctrl+Z 之前必须没有活动文本控件（否则撤销作用于草稿，不是文档历史）').toBeNull()
}

export async function writeField(page: Page, property: string, value: string): Promise<void> {
  const loc = page.locator(`[data-property="${property}"] input`)
  await loc.click()
  await loc.fill(value)
  await commitAndBlur(page, property)
}

export interface TraceEntry {
  token: number
  source: string
  kind: string
  commandId: string | null
  reason: string
  dispatched?: boolean
}

/** 真实按键 Ctrl+Z，返回该次按键新产生的轨迹增量。 */
export async function pressUndo(page: Page): Promise<TraceEntry[]> {
  const n = await page.evaluate(() => (window as any).__p7_input__!.trace().length)
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(1200)
  return (await page.evaluate((k: number) => (window as any).__p7_input__!.trace().slice(k), n)) as TraceEntry[]
}
