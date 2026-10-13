/**
 * **R1-β① C4 判据：工作台输入端口的领域命令真的走内核**（#387）。
 *
 * ## 本文件补的判据空洞（它为什么就是 `inputHotkeys.ts:234` 引用的那个文件）
 *
 * C4 之前，`workbench/inputHotkeys#workbenchCommandSink` 把领域命令经一张
 * 「领域命令 → 旧 operator」**转发表**转发给旧算子，并返回 `<前缀>:<命令名>`
 * 形态的票号；`setProperty` 打到 `PropertyInspector.vue` 用**已挂载组件**维护的
 * 闭包表（`syncCommitSinks`/`registeredSinkIds`）。
 *
 * C4 删掉了那张表、那个票号前缀与那张闭包表，改道**三条已结算入口**：
 *  1. `setProperty` → `editors/workbench-rna#commitDraftControlValue`（边界层解析）
 *     → `submitPropertyWrite`（唯一写路由）；
 *  2. `undo`/`redo` → `Context#submitKernelUndoRedo`（内核撤销唯一权威）；
 *  3. 其余领域命令 → `Context#submitContentEditSettlement`。
 *
 * 而 `inputHotkeys.ts:234` 的注释**当时引用了一个不存在的文件**
 * （`src/workbench/__tests__/inputPortKernelRouting.test.ts`）⇒
 * 「端口真的改道了」这条**没有判据面**。本文件就是那个文件（补上悬空引用）。
 *
 * ## 四条判据
 *
 * | # | 判据 | 机械形态 |
 * |---|---|---|
 * | ① | **生产路径真的改道**（本批最重要） | 一次真实交互的领域写 ⇒ 内核有值 **且** `syncLegacyFromKernel` 投影后**载体**有值（防"只在内核生效、界面无变化"的**假成功**——被删掉的闭包表注释警示的正是这个形态）**且** 恰好**一条**历史条目 |
 * | ② | **撤销经内核** | 经**生产端口**改一格 → 经**生产端口**撤销 → 内容回原状，`Context#kernelDirty()` 从 `true` 回 `false`（用 `kernelDirty()`，**不引入**单调计数代理） |
 * | ③ | **未接通命令显式拒绝** | 对 `Command` 联合**逐条**（`Record<Command['kind'], …>` ⇒ 联合增长时**编译期**报错）+ 非联合形态，断言每一条都返回**具名**拒绝/结算，**没有**静默丢弃 |
 * | ④ | **负对照实测判红** | 注入三种变异体（绕过内核只写 legacy / 只写内核不投影 / 一次交互记两条历史）⇒ **同一个断言器**判红；不注入时判绿（防恒红与恒绿） |
 *
 * ## 输入为什么可信（AGENTS 铁律：判据输入必须来自**生产解析 + 装配**）
 *
 * 文档来自**真实导出信封**（`e2e/fixtures/structuredata-exported-envelope.json`）
 * 经**生产解析器链**（`createParserRegistry` + 四个内建 parser）→
 * **生产装配**（`composition/documentLoad#adoptLoadedDocument`
 * → `assembleKernelDocument` → `KernelSession#adoptDocument`）。
 * **被封装的格子坐标从装配产物的载荷里读出**（`Object.keys(payload.cells)`），
 * 不手搓 `Scene`、不手搓载荷、不手搓 `cellContent`。
 * 唯一"注入"的是**宿主面**（选中集 = 用户点了哪一格），那正是交互的输入。
 *
 * ## 宿主为什么是"真 `Context` + 只注入宿主字段"
 *
 * 与 `p10fPanelTooltipWrite.test.ts` 同一教训（替身复刻被测逻辑 ⇒ 判据空转，
 * 本项目三度实测）。本文件跑的是**生产** `workbenchCommandSink` →
 * **生产** `commitDraftControlValue` → **生产** `submitPropertyWrite` →
 * **生产** `syncLegacyFromKernel`。
 *
 * ## 负对照的注入方式（为什么不改 `src/`）
 *
 * 与 `seams.test.ts` 同一手法：注入**形态**（把变异体的效果在内存里做出来），
 * 再把**同一批断言器**跑在它身上并断言判红。判据的区分力因此可机械复核。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ref, type Ref } from 'vue'
import { ALL_CAPABILITIES, type Command } from '@/application/commands'
import type { CommandOutcomeLike, CommandSink, ControlBinding } from '@/application/inputCommands'
import { EMPTY_DISPATCH_LEDGER, createInputCommandBindings, dispatchIntent } from '@/application/inputCommands'
import type { CommandIntent } from '@/domain/input'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { Context } from '@/runtime/context'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { plainRootOf } from '@/adapters/plainRoot'
import { workbenchCommandSink } from '@/workbench/inputHotkeys'
import { findObject, findObjectData } from '@/domain/scene'
import { cellContentKey } from '@/domain/cellContent'

// ─────────────────────────────────────────────────────────────────────────────
// 生产解析 + 装配（真信封；不做任何"手搓文档"）
// ─────────────────────────────────────────────────────────────────────────────

type Plain = Record<string, unknown>
const NOOP_LOG = { info: () => {}, warn: () => {} }
const ENVELOPE = path.join(process.cwd(), 'e2e', 'fixtures', 'structuredata-exported-envelope.json')

/** 生产解析器链（与 `r1aProjectFormatProduction.test.ts` **同一条**）。 */
function productionParsers() {
  const p = createParserRegistry()
  p.register(V2PlainParser)
  p.register(createEnvelopeParser(p))
  p.register(WorldParser)
  p.register(StructureDataParser)
  return p
}

/**
 * 解析一次、缓存，之后每次测试用 `clone()` 拿**独立副本** ——
 * 反空洞的前提是文档不被上一个测试改过。
 */
let cachedRaw: Plain | null = null
let cachedDoc: RuntimeDocument | null = null

async function productionDocument(): Promise<{ raw: Plain; doc: RuntimeDocument }> {
  if (cachedRaw === null || cachedDoc === null) {
    // CRLF 归一化（本仓 `core.autocrlf=true`；字节级判据同罪 —— 见 AGENTS 铁律 6）。
    const raw = JSON.parse(fs.readFileSync(ENVELOPE, 'utf8').replace(/\r\n/g, '\n')) as Plain
    const parsed = await productionParsers().detectAndParse(raw)
    if (parsed.document === null || parsed.document === undefined) throw new Error('真实信封解析失败')
    cachedRaw = raw
    cachedDoc = parsed.document as RuntimeDocument
  }
  return { raw: cachedRaw, doc: cachedDoc.clone() }
}

interface Cell {
  readonly x: number
  readonly y: number
  readonly z: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 真 Context（只注入宿主面）
// ─────────────────────────────────────────────────────────────────────────────

interface Harness {
  readonly ctx: Context
  readonly session: KernelSession
  readonly port: CommandSink
  /** legacy 载体（渲染链/面板读它；投影写它）。 */
  doc(): RuntimeDocument | null
  /** 内核历史**深度**（`DocumentSummary` 不含长度 ⇒ 直读领域事实）。 */
  historyDepth(): number
  dispose(): void
}

/**
 * 真 `Context`，只注入**宿主面**字段。
 *
 * | 注入项 | 生产链为什么需要它 |
 * |---|---|
 * | `main.doc` / `main.replaceDoc` | `documentStateOf` 读载体；`setDocument`（唯一写入口）写它 |
 * | `main.contentRefreshTick` | `kernelDirty()` 直读它（**不**注入 ⇒ `kernelDirty()` 抛错） |
 * | `kernel` | 内核会话（写权威 + 历史权威） |
 * | `workbench`（非 null） | `isEmbed()` = `workbench === null` ⇒ 非 null 才给写能力 |
 * | `getSelection` | `resolveRefs` 从**选中集**算目标（用户点了哪一格） |
 * | `getShellSettings` / `getToolSettings` | `accessOfContext` / `documentStateOf` 读它们 |
 */
function makeWorkbenchContext(
  docRef: Ref<RuntimeDocument | null>,
  session: KernelSession,
  selection: readonly Cell[],
): Context {
  const ctx = Object.create(Context.prototype) as Context
  Object.assign(ctx as unknown as Record<string, unknown>, {
    main: {
      doc: docRef,
      embedPublish: ref({}),
      contentRefreshTick: ref(0),
      documentRevision: ref(0),
    },
    kernel: session,
    // 非 null ⇒ 具备属性写能力（否则提交会被**能力**拒绝 ⇒ 测的是能力门，不是路由）
    workbench: {},
    getSelection: () => ({
      active: ref(null),
      // 生产 `EntityRef`：方块项带 `ref.pos`（世界坐标）—— `resolveRefs` 按它算 owner id。
      items: ref(new Set(selection.map((c) => ({ kind: 'block' as const, ref: { pos: { ...c } } })))),
    }),
    getHoveredBlock: () => ref(null),
    getHoveredAnnotationId: () => ref(null),
    getContentRefreshTick: () => ref(0),
    getShellSettings: () => ({ lang: ref('zh') }),
    getToolSettings: () => ({
      replaceBrush: ref(''),
      fillBrush: ref(''),
      generateType: ref(''),
      snapEnabled: ref(false),
      dragSensitivity: 1,
    }),
  })
  Object.assign((ctx as unknown as { main: Record<string, unknown> }).main, {
    replaceDoc: (d: RuntimeDocument | null) => {
      docRef.value = d
    },
  })
  return ctx
}

/** 生产装配：真信封 → 内核会话 + 真 `Context`。 */
async function harness(selection: readonly Cell[] = []): Promise<Harness> {
  const { raw, doc } = await productionDocument()
  const session = new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: ALL_CAPABILITIES,
  })
  // ⚠️ 生产装配（不是 `session.adoptDocument(手搓 Scene)`）—— 反空洞的前提。
  const adopted = adoptLoadedDocument({ kernel: session, log: NOOP_LOG }, doc, plainRootOf(raw), 'envelope')
  if (!adopted) throw new Error('真实信封内核装配失败（判据会空转）')
  const docRef = ref(doc) as unknown as Ref<RuntimeDocument | null>
  const ctx = makeWorkbenchContext(docRef, session, selection)
  return {
    ctx,
    session,
    port: workbenchCommandSink(ctx),
    doc: () => docRef.value,
    historyDepth: () => session.document()?.history.past.length ?? -1,
    dispose: () => session.dispose(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 读数（两侧各一个**具名**读面）
// ─────────────────────────────────────────────────────────────────────────────

/** 内核侧：每个 `blockGrid` 对象上该格的说明（命令契约要求**广播到每一帧对象**）。 */
function kernelTooltipsAll(session: KernelSession, cell: Cell): (string | undefined)[] {
  const doc = session.document()
  if (doc === undefined) return []
  const out: (string | undefined)[] = []
  for (const id of doc.scene.order) {
    const obj = findObject(doc.scene, id)
    if (obj === undefined) continue
    const data = findObjectData(doc.scene, obj.dataId)
    if (data === undefined || data.payload.kind !== 'blockGrid') continue
    out.push(data.payload.cellContent?.[cellContentKey(cell.x, cell.y, cell.z)]?.tooltip)
  }
  return out
}

/**
 * legacy 载体侧：按**文件格式**读该格说明。
 *
 * 行序事实（`adapters/tooltipPool` 契约 + `kernelPaletteAssembly:259`）：
 * `cellTooltipGrid[z][row][x]` 且 **row 0 = 顶部** ⇒ `row = height - 1 - y`。
 * `height` 直接取表格自身的行数 —— 它就是投影写进来的那个高度，
 * 因此这里的翻转与投影侧**互为逆**（无需再抄一份高度来源）。
 */
function legacyTooltipAt(doc: RuntimeDocument | null, cell: Cell): string | null {
  const grid = doc?.cellTooltipGrid
  const height = grid?.[0]?.length ?? 0
  if (grid === undefined || height === 0) return null
  const idx = grid[cell.z]?.[height - 1 - cell.y]?.[cell.x]
  if (idx === undefined || idx < 0) return null
  const pool = doc?.tooltipPalette as readonly unknown[] | undefined
  const text = pool?.[idx]
  return typeof text === 'string' ? text : null
}

/** 从**生产装配产物**里挑一个可写的格子（优先没有任何说明的格子）。 */
function pickCell(session: KernelSession): { cell: Cell; before: string | null } {
  const doc = session.document()
  if (doc === undefined) throw new Error('内核无文档')
  const fallback: { cell: Cell; before: string | null }[] = []
  for (const id of doc.scene.order) {
    const obj = findObject(doc.scene, id)
    if (obj === undefined) continue
    const data = findObjectData(doc.scene, obj.dataId)
    if (data === undefined || data.payload.kind !== 'blockGrid') continue
    for (const key of Object.keys(data.payload.cells ?? {})) {
      const parts = key.split(',')
      if (parts.length !== 3) continue
      const [x, y, z] = parts.map((s) => Number(s))
      if (x === undefined || y === undefined || z === undefined) continue
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      const cell: Cell = { x, y, z }
      const current = kernelTooltipsAll(session, cell).find((t) => t !== undefined) ?? null
      if (current === null) return { cell, before: null }
      if (fallback.length === 0) fallback.push({ cell, before: current })
    }
  }
  if (fallback.length === 0) throw new Error('装配产物里没有 blockGrid 格子（判据无法进行）')
  return fallback[0]!
}

// ─────────────────────────────────────────────────────────────────────────────
// 断言器（**正/负对照共用** —— 这是"实测判红"能成立的关键）
// ─────────────────────────────────────────────────────────────────────────────

/** 判据①的断言器：一次领域写必须 ①内核有值 ②**载体**有值 ③恰好一条历史。 */
function judgeRoutedThroughKernel(h: Harness, cell: Cell, text: string, expectedDepth = 1): void {
  const kernelSide = kernelTooltipsAll(h.session, cell)
  expect(kernelSide.length, '前提：装配产物里确有 blockGrid 对象（否则判据空转）').toBeGreaterThan(0)
  expect(
    kernelSide.every((t) => t === text),
    '① 内核必须记下该格说明（**每一个**帧网格对象都要有 —— 命令契约要求广播）',
  ).toBe(true)
  expect(
    legacyTooltipAt(h.doc(), cell),
    '② legacy **载体**必须被投影（`syncLegacyFromKernel`）—— 否则就是"只在内核生效、界面无变化"的假成功',
  ).toBe(text)
  expect(h.historyDepth(), '③ 一次领域写必须**恰好一条**历史条目').toBe(expectedDepth)
}

/** 判据③的断言器：端口结算必须是**显式**形态（三态之一 + 具名原因）。 */
function judgeExplicitOutcome(outcome: CommandOutcomeLike | undefined): void {
  expect(outcome, '端口必须返回结算，**不得**静默丢弃（`undefined` = 丢弃）').toBeTruthy()
  expect(
    ['applied', 'unchanged', 'rejected'],
    `端口结算必须是契约 §3.1 的三态之一（实收 ${String(outcome?.status)}）`,
  ).toContain(outcome?.status)
  if (outcome?.status === 'rejected') {
    const err = outcome.error as unknown as { code?: string; params?: Record<string, unknown> }
    expect(typeof err.code, '拒绝必须带**结构化错误码**（不是布尔、不是裸字符串）').toBe('string')
    expect(err.code, '错误码不得为空').toBeTruthy()
    expect(
      Object.keys(err.params ?? {}).length,
      '拒绝必须带**可归因参数**（`params.reason` 之类）—— "点了没反应"不算判据',
    ).toBeGreaterThan(0)
  }
}

/**
 * **把说明直接写进 legacy 载体**（内核不动）—— 这是 C4 删掉的那条
 * 「legacy 转发」的效果形态，也是"留了旁路"的注入器。
 *
 * 落点按文件格式算：`cellTooltipGrid[z][row][x]`、`row = height - 1 - y`，
 * 故把高度取成 `y + 1` ⇒ `row = 0`，下标就落在目标格上。
 */
function injectLegacyTooltipOnly(doc: RuntimeDocument, cell: Cell, text: string): RuntimeDocument {
  const rows = cell.y + 1
  const cols = cell.x + 1
  const layers: number[][][] = []
  for (let z = 0; z <= cell.z; z++) {
    const layer: number[][] = []
    for (let r = 0; r < rows; r++) layer.push(new Array<number>(cols).fill(-1))
    layers.push(layer)
  }
  layers[cell.z]![0]![cell.x] = 0
  return doc.withCellTooltips([text], layers)
}

/** 判据③-b 的断言器：输入端口**不得**再产出旧转发形态的票号（旧旁路的指纹）。 */
function judgeNoLegacyTicket(cmd: Command, ticket: { readonly ticketId: string; readonly commandId: string }): void {
  expect(ticket.commandId, '票号必须回报命令名').toBe(cmd.kind)
  expect(
    ticket.ticketId.startsWith('unsupported:'),
    `票号必须是**具名**的 \`unsupported:\` 形态（实收 ${ticket.ticketId}）`,
  ).toBe(true)
  expect(
    ticket.ticketId.includes('legacy'),
    '票号**不得**落在已删除的旧转发命名空间（恢复它 = 旧旁路回来了）',
  ).toBe(false)
}

/** 把"判红"变成可断言的读数。 */
function redOf(run: () => void): boolean {
  try {
    run()
    return false
  } catch {
    return true
  }
}

/** 经**生产端口**提交一次面板草稿（`field:<描述符 id>` 是生产控件 id 的形态）。 */
function portCommitControl(port: CommandSink, controlId: string, value: unknown): CommandOutcomeLike {
  // 端口签名是 `ImmediateCommand`，而 `dispatchIntent` 自己按 `queue` 分支后传下来
  // （`inputCommands.ts:459` 的 `as ImmediateCommand`）—— 本调用与它同一形态。
  return port.executeNow({
    kind: 'setProperty',
    contextId: KERNEL_CONTEXT_ID,
    // 生产 `ControlBinding.ref`：面板寻址（`owner` 是壳、`property` 是 `field:<描述符 id>`）。
    refs: [{ owner: { kind: 'document', id: '' }, property: controlId }],
    value,
  } as never)
}

function portUndo(port: CommandSink): CommandOutcomeLike {
  return port.executeNow({ kind: 'undo', contextId: KERNEL_CONTEXT_ID })
}

// ─────────────────────────────────────────────────────────────────────────────
// 前置（反空洞）
// ─────────────────────────────────────────────────────────────────────────────

describe('R1-β① C4 · 前提：真信封经生产解析 + 装配进了内核（否则以下判据全部空转）', () => {
  it('装配成功 ⇒ GF-15/GF-16 都为真，历史为空，文档**不脏**', async () => {
    const h = await harness()
    try {
      expect(h.session.hasAdoptedContent(), 'GF-16：内核承载的**就是**这份装配产物').toBe(true)
      expect(h.ctx.hasLoadedDocument(), 'GF-15：存在性镜像（`Context` 的读面）').toBe(true)
      expect(h.historyDepth(), '刚装配 ⇒ 无历史').toBe(0)
      expect(h.ctx.kernelDirty(), '刚装配 ⇒ 与保存基线相同（`false`，不是 `null`）').toBe(false)
      expect(h.doc(), 'legacy 载体存在（面板/渲染链读它）').not.toBeNull()
    } finally {
      h.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 判据①：生产路径真的改道
// ─────────────────────────────────────────────────────────────────────────────

describe('判据① 生产路径真的改道：领域写进内核 + 投影回载体 + 恰好一条历史', () => {
  it('经生产端口改一格 ⇒ 内核有值、**载体**有值、恰好一条历史（防"假成功"）', async () => {
    // 先装配一次只为挑格子（把"挑格子"与"注入选中集"分成两步，避免手搓坐标）。
    const probe = await harness()
    const { cell, before } = pickCell(probe.session)
    probe.dispose()

    const h = await harness([cell])
    try {
      expect(h.ctx.hasLoadedDocument()).toBe(true)
      expect(before, '前提：挑到的格子**没有**说明（保证写是 `applied` 而非 `unchanged`）').toBeNull()

      const outcome = portCommitControl(h.port, 'field:lightning.block.tooltip', 'C4 端口写的说明')
      expect(outcome.status, '端口提交必须**成功**（`applied`）').toBe('applied')

      judgeRoutedThroughKernel(h, cell, 'C4 端口写的说明')

      // ④ 撤销标签必须描述这次编辑（证明历史条目**是这一条**，不是别的东西）。
      expect(h.session.documentSummary()?.undoLabel, '历史条目必须描述这次编辑').toContain('cell tooltip')

      // ⑤ **读面**也可见（面板/呈现层读 `Context#cellTooltips()`）。
      const face = h.ctx.cellTooltips()
      expect(face, '读面必须给出侧表').not.toBeNull()
      expect(face?.source, '装配成功 ⇒ 读面以内核为权威').toBe('kernel')
      expect(face?.palette, '读面必须能解出刚写的文案').toContain('C4 端口写的说明')

      // ⑥ **保存投影**也一致（"面板看到的 == 存出来的"；防"改了、存出去没有"）。
      const saved = h.ctx.plainForSave()
      expect(saved.source, '装配成功 ⇒ 保存投影以内核为权威').toBe('kernel')
      expect(saved.plain?.cellTooltipGrid, '保存产物的侧表网格必须与载体一致').toEqual(h.doc()?.cellTooltipGrid)
    } finally {
      h.dispose()
    }
  })

  it('逐条负对照的反面：**另一格**不得被写（防"写到镜像的那一格"）', async () => {
    const probe = await harness()
    const picked = pickCell(probe.session)
    const doc = probe.session.document()
    // 再挑一个**不同**的格子（同一个 blockGrid 对象里的另一个键）。
    const other = ((): Cell | null => {
      if (doc === undefined) return null
      for (const id of doc.scene.order) {
        const obj = findObject(doc.scene, id)
        if (obj === undefined) continue
        const data = findObjectData(doc.scene, obj.dataId)
        if (data === undefined || data.payload.kind !== 'blockGrid') continue
        for (const key of Object.keys(data.payload.cells ?? {})) {
          const parts = key.split(',').map(Number)
          if (parts.length !== 3) continue
          const [x, y, z] = parts
          if (x === undefined || y === undefined || z === undefined) continue
          if (x === picked.cell.x && y === picked.cell.y && z === picked.cell.z) continue
          return { x, y, z }
        }
      }
      return null
    })()
    probe.dispose()
    if (other === null) return // 单格文档：本对照不可表达（不静默通过 —— 上面已有整组判据）

    const h = await harness([picked.cell])
    try {
      portCommitControl(h.port, 'field:lightning.block.tooltip', '只写这一格')
      expect(kernelTooltipsAll(h.session, picked.cell).every((t) => t === '只写这一格')).toBe(true)
      expect(kernelTooltipsAll(h.session, other).every((t) => t === undefined), '另一格不得被写').toBe(true)
    } finally {
      h.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 判据②：撤销经内核
// ─────────────────────────────────────────────────────────────────────────────

describe('判据② 撤销经生产入口 + `Context#kernelDirty()` 语义', () => {
  it('改一格 → 撤销 ⇒ 内容回原状、历史清空、`kernelDirty()` 从 true 回 false', async () => {
    const probe = await harness()
    const { cell, before } = pickCell(probe.session)
    probe.dispose()

    const h = await harness([cell])
    try {
      expect(h.ctx.kernelDirty(), '前提：刚装配不脏').toBe(false)
      expect(before).toBeNull()

      const write = portCommitControl(h.port, 'field:lightning.block.tooltip', '要撤销掉的')
      expect(write.status).toBe('applied')
      expect(h.historyDepth(), '一次写 ⇒ 一条历史').toBe(1)
      expect(h.ctx.kernelDirty(), '改过内容 ⇒ **脏**（`kernelDirty()` 直读内核基线比较，不是计数器代理）').toBe(true)

      const undo = portUndo(h.port)
      expect(undo.status, '经生产端口的撤销必须成功').toBe('applied')

      // ① 内容回原状（两侧）
      expect(
        kernelTooltipsAll(h.session, cell).every((t) => t === undefined),
        '撤销后内核侧必须回到"没有说明"',
      ).toBe(true)
      expect(legacyTooltipAt(h.doc(), cell), '撤销后 legacy 载体也必须回到"没有说明"').toBeNull()
      // ② 历史清空 ⇒ 证明**恰好**一条历史（若记了两条，一次撤销后仍可撤销）
      expect(h.historyDepth(), '一次撤销必须清空历史').toBe(0)
      expect(h.session.documentSummary()?.canUndo, '撤销后不得仍可撤销').toBe(false)
      // ③ 脏语义回到基线
      expect(h.ctx.kernelDirty(), '撤销回保存基线 ⇒ 不脏').toBe(false)
    } finally {
      h.dispose()
    }
  })

  it('重做经同一入口 ⇒ 内容回来、再次变脏（撤销/重做都不是"只改内核不投影"）', async () => {
    const probe = await harness()
    const { cell } = pickCell(probe.session)
    probe.dispose()

    const h = await harness([cell])
    try {
      portCommitControl(h.port, 'field:lightning.block.tooltip', 'A')
      portUndo(h.port)
      expect(h.ctx.kernelDirty()).toBe(false)

      const redo = h.port.executeNow({ kind: 'redo', contextId: KERNEL_CONTEXT_ID })
      expect(redo.status).toBe('applied')
      judgeRoutedThroughKernel(h, cell, 'A')
      expect(h.ctx.kernelDirty(), '重做 ⇒ 又脏').toBe(true)
    } finally {
      h.dispose()
    }
  })

  it('未装配时撤销**显式拒绝**（`kernelUndoUnavailable`），不得静默无事发生', async () => {
    // 空会话：内核未采纳内容 ⇒ `submitKernelUndoRedo` 返回 false。
    const session = new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: ALL_CAPABILITIES,
    })
    const docRef = ref(null) as unknown as Ref<RuntimeDocument | null>
    const ctx = makeWorkbenchContext(docRef, session, [])
    try {
      const outcome = workbenchCommandSink(ctx).executeNow({ kind: 'undo', contextId: KERNEL_CONTEXT_ID }) as {
        status: string
        error?: { code?: string; params?: Record<string, unknown> }
      }
      expect(outcome.status, '未装配 ⇒ 撤销**不可用**（不回落旧栈）').toBe('rejected')
      expect(outcome.error?.code).toBe('UnsupportedOperation')
      expect(outcome.error?.params?.reason, '原因必须可归因').toBe('kernelUndoUnavailable')
    } finally {
      session.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 判据③：未接通命令逐条显式拒绝
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## 逐条清单的**耐久性**（这条为什么不是"写死的 29 行"）
 *
 * `PROBE_EXTRA` 的类型是 `Record<Command['kind'], …>` ⇒ `Command` 联合**增加**
 * 一个成员时，本文件**编译期**报错（缺键）。于是"逐条"不会随联合增长而悄悄失效
 * —— 那正是本项目"新命令绕过端口"的漏检形态。
 *
 * 载荷是**最小但形状正确**的：本组断言的是**分类与显式诊断**，不是"每条命令都成功"
 * （各命令的语义由各自的判据文件把守）。唯一的例外是那四条 `QUEUED_ONLY`：
 * 它们在**读载荷之前**就被拒绝，故载荷内容与本判据无关。
 */
const PROBE_EXTRA: Record<Command['kind'], () => Record<string, unknown>> = {
  setProperty: () => ({ refs: [], value: 'x' }),
  setTransform: () => ({ objectId: 'no-such-object', transform: { position: { x: 0, y: 0, z: 0 } } }),
  addObject: () => ({ objectType: 'block' }),
  deleteObject: () => ({ objectId: 'no-such-object' }),
  setCellTooltip: () => ({ cells: [], text: null }),
  setCellContent: () => ({ cells: [], content: null }),
  setCellIdentity: () => ({ cells: [], identity: null }),
  moveCells: () => ({ objectId: 'no-such-object', moves: [] }),
  setDocumentMeta: () => ({ patch: {} }),
  beginInteraction: () => ({ tool: 'move', targets: [] }),
  updateInteraction: () => ({ displacement: { x: 0, y: 0, z: 0 } }),
  commitInteraction: () => ({ label: 'probe' }),
  cancelInteraction: () => ({}),
  select: () => ({ target: null }),
  setTime: () => ({ time: { frame: 0, fps: 20 } }),
  setPlaying: () => ({ playing: true }),
  setPlaybackRate: () => ({ rate: 1 }),
  advancePlayback: () => ({ deltaSeconds: 0 }),
  setChannelValue: () => ({ channel: 'no-such-channel', value: 0 }),
  insertKeyframe: () => ({ target: { owner: { kind: 'document', id: 'document' }, property: 'probe' }, time: { frame: 0, fps: 20 }, value: 0 }),
  removeKeyframe: () => ({ target: { owner: { kind: 'document', id: 'document' }, property: 'probe' }, time: { frame: 0, fps: 20 } }),
  setTrackEnabled: () => ({ target: { owner: { kind: 'document', id: 'document' }, property: 'probe' }, enabled: true }),
  publishDefault: () => ({ target: { owner: { kind: 'document', id: 'document' }, property: 'probe' }, value: 0 }),
  undo: () => ({}),
  redo: () => ({}),
  save: () => ({}),
  saveCompleted: () => ({ documentId: KERNEL_DOCUMENT_ID, sequence: 1, bindingGeneration: 1, outcome: {} }),
  openDocument: () => ({ documentId: 'doc-x' }),
  closeDocument: () => ({ documentId: 'doc-x' }),
}

/** 输入面**不是**它们入口的命令（`application/commands#requiresQueue`）—— 逐条。 */
const QUEUED_ONLY_KINDS = ['save', 'saveCompleted', 'openDocument', 'closeDocument'] as const

/**
 * **非联合**形态的命令 id：C4 之前那张转发表把领域命令交给旧算子；
 * 现在**同类 id 到达端口必须具名拒绝**。下面三个 `OPERATOR_*` 都是**真实存在**的
 * 旧算子 id（出处逐条标注），即"旧转发形态的载荷"。
 */
const LEGACY_OPERATOR_IDS: readonly { readonly id: string; readonly from: string }[] = [
  { id: 'OPERATOR_SELECT_ALL', from: 'workbench/inputHotkeys.ts:129（local.a 的动作本体）' },
  { id: 'OPERATOR_TOGGLE_FRAME_PLAYBACK', from: 'application/commands.ts:538（`setPlaying` 替代的旧算子）' },
  { id: 'OPERATOR_TOOLTIP_EDIT', from: 'editors/workbench-inspector.ts:192（逐格说明的旧编辑算子）' },
]

describe('判据③ 未接通命令逐条显式拒绝（显式拒绝 ≠ 静默丢弃）', () => {
  it('分支④：四条 `QUEUED_ONLY` 逐条 ⇒ `effectfulCommandNotAcceptedByInputPort`', async () => {
    const h = await harness()
    try {
      for (const kind of QUEUED_ONLY_KINDS) {
        const outcome = h.port.executeNow({
          kind,
          contextId: KERNEL_CONTEXT_ID,
          ...PROBE_EXTRA[kind](),
        } as never) as { status: string; error?: { code?: string; params?: Record<string, unknown> } }
        expect(outcome.status, `${kind}：输入面**不是**它的入口 ⇒ 必须显式拒绝`).toBe('rejected')
        expect(outcome.error?.code, `${kind}：拒绝必须具名`).toBe('UnsupportedOperation')
        expect(outcome.error?.params?.reason, `${kind}：原因必须可归因`).toBe('effectfulCommandNotAcceptedByInputPort')
        expect(outcome.error?.params?.command, `${kind}：拒绝必须回报命令名`).toBe(kind)
      }
    } finally {
      h.dispose()
    }
  })

  it('分支⑤：**非联合**的旧算子 id 逐条 ⇒ `commandNotWiredToInputPort`', async () => {
    const h = await harness()
    try {
      for (const { id, from } of LEGACY_OPERATOR_IDS) {
        const outcome = h.port.executeNow({ kind: id, contextId: KERNEL_CONTEXT_ID } as never) as {
          status: string
          error?: { code?: string; params?: Record<string, unknown> }
        }
        expect(outcome.status, `${id}（旧算子 id，出处 ${from}）：必须**显式拒绝**，绝不假装接收`).toBe('rejected')
        expect(outcome.error?.code).toBe('UnsupportedOperation')
        expect(outcome.error?.params?.reason, `${id}：必须落入"未接通"这一条具名原因`).toBe('commandNotWiredToInputPort')
      }
    } finally {
      h.dispose()
    }
  })

  it('旧旁路已移除：`submit()` 的票号**不得**是旧转发命名空间（具名 `unsupported:` 才是"没有排队通道"）', async () => {
    const h = await harness()
    const kinds = Object.keys(PROBE_EXTRA) as (keyof typeof PROBE_EXTRA)[]
    try {
      for (const kind of kinds) {
        const cmd = { kind, contextId: KERNEL_CONTEXT_ID, ...PROBE_EXTRA[kind]() } as unknown as Command
        judgeNoLegacyTicket(cmd, h.port.submit(cmd))
      }
      // 负对照（**实测判红**）：注入 C4 之前那条转发表的票号形态 ⇒ 同一个断言器判红。
      const cmd = { kind: 'setProperty', contextId: KERNEL_CONTEXT_ID } as unknown as Command
      expect(
        redOf(() => judgeNoLegacyTicket(cmd, { ticketId: 'legacy:setProperty', commandId: 'setProperty' })),
        '恢复旧转发票号 ⇒ 本断言器必须判红（否则它证明不了旁路已被移除）',
      ).toBe(true)
      // 反面（防恒红）：现行形态判绿。
      expect(redOf(() => judgeNoLegacyTicket(cmd, { ticketId: 'unsupported:setProperty', commandId: 'setProperty' }))).toBe(false)
    } finally {
      h.dispose()
    }
  })

  it('`setProperty` 的 ref 形状不对 ⇒ 具名拒绝（不是"查不到控件就静默丢弃"）', async () => {
    const h = await harness()
    try {
      const zero = portCommitControl(h.port, 'field:lightning.block.tooltip', 'x')
      // `refs` 为空时端口给的是 `unsupportedPropertyRefShape`（见下一条的逐条断言）。
      expect(zero.status).toBe('rejected')
      const many = h.port.executeNow({
        kind: 'setProperty',
        contextId: KERNEL_CONTEXT_ID,
        refs: [
          { owner: { kind: 'document', id: '' }, property: 'field:lightning.block.tooltip' },
          { owner: { kind: 'document', id: '' }, property: 'field:lightning.block.tooltip' },
        ],
        value: 'x',
      } as never) as { status: string; error?: { params?: Record<string, unknown> } }
      expect(many.status).toBe('rejected')
      expect(many.error?.params?.reason).toBe('unsupportedPropertyRefShape')
    } finally {
      h.dispose()
    }
  })

  it('**逐条清单**：对 `Command` 联合**每一个**成员，端口都必须给出显式结算', async () => {
    const h = await harness()
    const kinds = Object.keys(PROBE_EXTRA) as (keyof typeof PROBE_EXTRA)[]
    // `Record<Command['kind'], …>` 保证键集 == 联合；这里再钉一次"数量非空"。
    expect(kinds.length, '清单必须非空').toBeGreaterThan(0)
    try {
      for (const kind of kinds) {
        const outcome = h.port.executeNow({
          kind,
          contextId: KERNEL_CONTEXT_ID,
          ...PROBE_EXTRA[kind](),
        } as never)
        judgeExplicitOutcome(outcome)
      }
      // 反向断言（防"清单里混进了不存在的东西"）：四条 QUEUED_ONLY 必须**都在**清单里。
      for (const k of QUEUED_ONLY_KINDS) expect(kinds).toContain(k)
      // `undo` 也在清单里（它是最容易"悄悄不接"的一条）。
      expect(kinds).toContain('undo')
    } finally {
      h.dispose()
    }
  })

  it('负对照：只说"没有静默丢弃"不够 —— 断言器必须能判**丢弃**判红', async () => {
    // 变异体 A：端口返回 `undefined`（= 丢弃）。断言器**必须**判红。
    expect(redOf(() => judgeExplicitOutcome(undefined)), '`undefined`（静默丢弃）必须判红').toBe(true)
    // 变异体 B：`rejected` 但不给原因（= "点了没反应"）。必须判红。
    expect(
      redOf(() => judgeExplicitOutcome({ status: 'rejected', error: {} } as unknown as CommandOutcomeLike)),
      '无名拒绝必须判红',
    ).toBe(true)
    // 反面（防恒红）：合规形态必须判绿。
    expect(redOf(() => judgeExplicitOutcome({ status: 'changed' in {} ? 'applied' : 'unchanged', version: { documentVersion: 1 } } as CommandOutcomeLike))).toBe(false)
    expect(
      redOf(() =>
        judgeExplicitOutcome({
          status: 'rejected',
          error: { code: 'UnsupportedOperation', params: { reason: 'x' } },
        } as unknown as CommandOutcomeLike),
      ),
    ).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 判据④：负对照**实测判红**
// ─────────────────────────────────────────────────────────────────────────────

describe('判据④ 负对照实测判红：同一个断言器必须抓到三种"端口改道"的变异体', () => {
  it('变异体 A（绕过内核、只写 legacy 载体）⇒ 判据①的断言器判红', async () => {
    const probe = await harness()
    const { cell } = pickCell(probe.session)
    probe.dispose()

    const h = await harness([cell])
    try {
      // ── 注入：把说明**直接**写进 legacy 载体（= C4 删掉的那条 legacy 转发的效果），
      //    内核**不动**。这条注入就是"绕过内核的写"。
      h.ctx.setDocument(injectLegacyTooltipOnly(h.doc()!, cell, '绕过内核写的'), 'content-sync')
      expect(legacyTooltipAt(h.doc(), cell), '前提：注入确实写进了载体').toBe('绕过内核写的')
      expect(kernelTooltipsAll(h.session, cell).every((t) => t === undefined), '前提：内核确实没有').toBe(true)

      // ★ 同一个断言器在这个形态上**必然判红**（判据①的核心断言表达式在此取不到值）。
      expect(
        redOf(() => judgeRoutedThroughKernel(h, cell, '绕过内核写的')),
        '绕过内核的写 ⇒ 判据①的断言器必须判红（正对照里它是判绿的）',
      ).toBe(true)
    } finally {
      h.dispose()
    }
  })

  it('变异体 B（只在内核生效、不投影 ⇒ "假成功"）⇒ 判据①的断言器判红', async () => {
    const probe = await harness()
    const { cell } = pickCell(probe.session)
    probe.dispose()

    const h = await harness([cell])
    try {
      // ── 注入：**只**走内核（`KernelSession.submit` + `drain`），跳过
      //    `Context#submitContentEditSettlement` ⇒ 跳过 `syncLegacyFromKernel`。
      //    这正是被删掉的 `workbenchCommandSink` 注释警示的"命令被 applied、
      //    界面上什么都没变"的**假成功**形态（#333 的同族）。
      h.session.submit({ kind: 'setCellTooltip', contextId: KERNEL_CONTEXT_ID, cells: [cell], text: '只在内核里' })
      h.session.drain()
      expect(kernelTooltipsAll(h.session, cell).every((t) => t === '只在内核里'), '前提：内核确实写了').toBe(true)
      expect(legacyTooltipAt(h.doc(), cell), '前提：载体确实没被投影').toBeNull()

      expect(
        redOf(() => judgeRoutedThroughKernel(h, cell, '只在内核里')),
        '"只在内核生效、界面无变化"的假成功 ⇒ 判据①的断言器必须判红',
      ).toBe(true)
    } finally {
      h.dispose()
    }
  })

  it('变异体 C（一次交互记两条历史）⇒ "恰好一条"的断言判红', async () => {
    const probe = await harness()
    const { cell } = pickCell(probe.session)
    probe.dispose()

    const h = await harness([cell])
    try {
      // 两次**独立**的领域写 = 两条历史（模拟"一次交互被记了两次"）。
      portCommitControl(h.port, 'field:lightning.block.tooltip', '第一次')
      portCommitControl(h.port, 'field:lightning.block.tooltip', '第二次')
      expect(h.historyDepth(), '前提：确实记了两条').toBe(2)

      expect(
        redOf(() => judgeRoutedThroughKernel(h, cell, '第二次')),
        '"恰好一条历史"的断言必须能判红（否则它只是"有历史"的换名）',
      ).toBe(true)
    } finally {
      h.dispose()
    }
  })

  it('反面（防恒红）：**合规**的一次端口写在同一批断言器上判绿', async () => {
    const probe = await harness()
    const { cell } = pickCell(probe.session)
    probe.dispose()

    const h = await harness([cell])
    try {
      expect(portCommitControl(h.port, 'field:lightning.block.tooltip', '合规').status).toBe('applied')
      expect(
        redOf(() => judgeRoutedThroughKernel(h, cell, '合规')),
        '合规形态必须判绿 —— 否则上面三条"判红"证明不了区分力',
      ).toBe(false)
    } finally {
      h.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A05 产品级缺口（此刻**可达**的那一半）：真实编辑通道
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## 这一组补的是 A05 的**产品级缺口**，不重复内核层判据
 *
 * A05 的内核层判据已在 `src/__tests__/a05a17MultiAreaHistory.test.ts`（该文件头的
 * 层级表把"产品层"标为 ❌ 归 #282），本文件**不重造**它。
 *
 * 它当时标 ❌ 的原因是"产品**输入口**仍是 legacy 转发"（同一句话也写在
 * `r1aProjectFormatProduction.test.ts` 的定级里）。**C4 把那一半兑现了**：
 * 现在有了一条真实编辑通道 ——
 *
 * ```
 * CommandIntent（`draft.commit`）→ dispatchIntent → resolveIntent → 输入端口
 *   → 内核提交 → 恰好一条历史 → syncLegacyFromKernel 投影
 * ```
 *
 * 于是 A05 判据里"真实编辑通道下**提交仅一条历史**"与"两处观察看到**同一**事实"
 * 在本层**可达**（它们不需要浏览器）：本组钉这两条。
 *
 * ⚠️ **仍未覆盖**的是"两个真实 3D Area 在 UI 里拖动"（需要浏览器 + 双 Area 装配）
 * —— 那是 #282 / L3 e2e 的事，本组**不**声称它。
 */
describe('A05 产品级缺口 · 真实编辑通道（`draft.commit` 意图 → 分发 → 端口 → 内核）', () => {
  const CONTROL_ID = 'field:lightning.block.tooltip'

  function bindingsOf(): ReturnType<typeof createInputCommandBindings> {
    const control: ControlBinding = {
      controlId: CONTROL_ID,
      contextId: KERNEL_CONTEXT_ID,
      // 生产 `ControlBinding.ref`：面板寻址（`owner` 是壳、`property` 是 `field:<描述符 id>`）。
      ref: { owner: { kind: 'document', id: '' }, property: CONTROL_ID },
      kind: 'text',
      label: '说明',
    }
    return createInputCommandBindings({ controls: [control] })
  }

  it('**提交仅一条历史**：一次 `draft.commit` 意图 ⇒ 恰好一条历史且投影可见', async () => {
    const probe = await harness()
    const { cell } = pickCell(probe.session)
    probe.dispose()

    const h = await harness([cell])
    try {
      const intent: CommandIntent = {
        commandId: 'draft.commit',
        params: { controlId: CONTROL_ID, value: '经意图提交的说明' },
      }
      const dispatched = dispatchIntent(h.port, EMPTY_DISPATCH_LEDGER, 1, intent, bindingsOf())
      // `settled`（而不是 `submitted`）：`queue:false` 的命令必须走**同步结算**面
      // —— 生产没有帧循环 drain，"接收了但永不结算"正是旧端口的假成功形态。
      if (dispatched.status !== 'settled') {
        throw new Error(`真实编辑通道必须**同步结算**，实收 ${dispatched.status}`)
      }
      expect(dispatched.outcome.status, '意图提交必须成功').toBe('applied')
      expect(dispatched.commandId, '分发必须回报命令 id').toBe('draft.commit')

      // A05「提交仅一条历史」+ 投影可见（与判据①同一批断言）。
      judgeRoutedThroughKernel(h, cell, '经意图提交的说明')
    } finally {
      h.dispose()
    }
  })

  it('**撤销也走真实通道**：`edit.undo` 意图 ⇒ 内容回原状、历史清空、脏语义回基线', async () => {
    const probe = await harness()
    const { cell } = pickCell(probe.session)
    probe.dispose()

    const h = await harness([cell])
    try {
      const commit: CommandIntent = {
        commandId: 'draft.commit',
        params: { controlId: CONTROL_ID, value: '经意图提交的说明' },
      }
      const written = dispatchIntent(h.port, EMPTY_DISPATCH_LEDGER, 1, commit, bindingsOf())
      if (written.status !== 'settled') throw new Error(`提交未结算（${written.status}）`)
      expect(written.outcome.status).toBe('applied')
      expect(h.ctx.kernelDirty()).toBe(true)

      const undo: CommandIntent = { commandId: 'edit.undo', params: { contextId: KERNEL_CONTEXT_ID } }
      const undone = dispatchIntent(h.port, EMPTY_DISPATCH_LEDGER, 2, undo, bindingsOf())
      if (undone.status !== 'settled') throw new Error(`撤销未结算（${undone.status}）`)
      expect(undone.outcome.status, '经真实通道的撤销必须成功').toBe('applied')
      expect(h.historyDepth(), '一次撤销清空历史').toBe(0)
      expect(h.ctx.kernelDirty(), '撤销回保存基线 ⇒ 不脏').toBe(false)
      expect(legacyTooltipAt(h.doc(), cell), '载体也必须回原状').toBeNull()
    } finally {
      h.dispose()
    }
  })

  it('**两处观察看到同一事实**（A05「面板相同」的读面形态）：读面里没有 area/region 维度', async () => {
    const probe = await harness()
    const { cell } = pickCell(probe.session)
    probe.dispose()

    const h = await harness([cell])
    try {
      const intent: CommandIntent = {
        commandId: 'draft.commit',
        params: { controlId: CONTROL_ID, value: '两处都该看到' },
      }
      const dispatched = dispatchIntent(h.port, EMPTY_DISPATCH_LEDGER, 1, intent, bindingsOf())
      if (dispatched.status !== 'settled') throw new Error(`提交未结算（${dispatched.status}）`)

      const view1 = h.ctx.cellTooltips()
      const view2 = h.ctx.cellTooltips()
      expect(view1, '读面必须给出两侧事实').not.toBeNull()
      expect(view1, 'A05：两个观察方读到的必须是**同一**事实').toEqual(view2)
      expect(view1?.source, '以内核为权威').toBe('kernel')
      // 机位/区域维度**不在**读面里 ⇒ "两个 Area 各持机位"不需要额外机制
      // （内核层同一条已由 `a05a17MultiAreaHistory.test.ts` 的键集断言钉住）。
      expect(h.ctx.cellTooltips.length, '读面必须**不接受**任何 area/region 参数').toBe(0)
    } finally {
      h.dispose()
    }
  })
})
