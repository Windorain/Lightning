/**
 * **面板入口的逐格说明写入（内核路径）**。
 *
 * ## 本文件补的是哪个**判据空洞**（根因，不是"锦上添花"）
 *
 * D0 段二在 `workbench-rna#submitPropertyWrite` 加了"逐格说明改走内核命令"的拦截，
 * 但当时代码里**三条**判据面**全都够不到它**：
 *
 * | 判据 | 为什么够不到 |
 * |---|---|
 * | `tooltipEditWrite.test.ts`（回归锁） | 替身把 `submitContentEdit` 固定成 `() => false` ⇒ **只覆盖回落分支**（那是它的本意） |
 * | `cellTooltipWrite.test.ts` | 打的是**命令层**（`setCellTooltip` 的语义） |
 * | `tooltipRowFlip.test.ts` | 打的是**算子层**（`metaEditOperators` 的行序翻转） |
 *
 * ⇒ 「面板入口 → 内核命令 → **回写 legacy**」这条链**零判据**，于是
 * "内核写了、legacy 没投影"这个缺陷在单测里全绿，只在 e2e 的 L3 才暴露。
 *
 * ## 本文件钉的三件事
 *
 * 1. **面板入口的内核路径真的落点**：内核 `cellContent.tooltip` 与 **legacy
 *    `tooltipPalette`/`cellTooltipGrid`** 两侧都要有值（直接断言）；
 * 2. **两侧投影一致**：`syncLegacyFromKernel` 写进 legacy 的侧表 == 保存投影
 *    （`plainForSave()`）给出的侧表 —— 防"面板看到的"与"存出来的"分叉；
 * 3. **删除语义**：删掉最后一条说明后 legacy 侧表必须**清成没有**
 *    （否则"删不掉"是静默失效）。
 *
 * ## 宿主为什么是**真 `Context`**（不是复刻）
 *
 * 与 `kernelReadTestHost` / `tooltipRowFlip` 同一教训：替身复刻被测逻辑时
 * 判据会**空转**（本项目已三度实测）。本文件注入的只有 `main` / `kernel` /
 * `getSelection` 三件，跑的是**生产** `submitPropertyWrite` 与**生产**
 * `syncLegacyFromKernel`。
 *
 * ## 负对照（防止判据恒绿）
 *
 * 见最后一组：把 `syncLegacyFromKernel` 的逐格说明那一步**注入掉**（用一条
 * 只投影注解的等价实现）⇒ 第 1 组的核心断言**必然判红**。这条证明判据
 * 真的在测"回写发生了"，而不是"某个字段恰好有值"。
 */

import { describe, it, expect } from 'vitest'
import { ref, type Ref } from 'vue'
import { Context } from '@/runtime/context'
import { RuntimeDocument, RuntimeFrame, Grid } from '@/context/runtimeDocument'
import { ALL_CAPABILITIES } from '@/application/commands'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { createDocument, withContent, withDocumentContent } from '@/domain/document'
import { emptyScene, findObject, findObjectData, objectData, sceneObject, withObject } from '@/domain/scene'
import type { Scene } from '@/domain/scene'
import { cellContentKey } from '@/domain/cellContent'
import { commitFieldValue, submitPropertyWrite, workbenchRegistry } from '@/editors/workbench-rna'
import { writeErrorKey } from '@/editors/property-writers'
import { projectCellTooltipsToLegacy } from '@/runtime/tooltipRead'
import { projectAnnotationsToLegacy } from '@/runtime/annotationRead'
import { createFieldRejectionStore } from '@/runtime/fieldRejections'
import { createDiagnosticRecorder } from '@/application/diagnostics'

const OBJ = 'structure:frame-0'
/** 高度 2 的网格（`cellGrid` 行序：row 0 = 顶部 ⇒ 世界 y = h-1-row）。 */
const CELLS = { '0,0,0': 'minecraft:stone:0', '0,1,0': 'minecraft:dirt:0' }
const H = 2

interface Harness {
  ctx: Context
  session: KernelSession
  doc(): RuntimeDocument | null
  dispose(): void
}

/** 真 `RuntimeDocument`（面板读它；`withCellTooltips` 也落在它上面）。 */
function legacyDoc(): RuntimeDocument {
  const rows: (null | { name: string; meta: number })[][] = [
    [{ name: 'stone', meta: 0 }],
    [{ name: 'dirt', meta: 0 }],
  ]
  return new RuntimeDocument({
    id: 'probe',
    frames: [new RuntimeFrame(0, undefined, new Grid(1, H, 1, [rows]))],
  })
}

/** 真 `Context` + 真内核会话（走生产装配序列 `adoptDocument`）。 */
function harness(): Harness {
  const session = new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: ALL_CAPABILITIES,
  })
  const base = createDocument(KERNEL_DOCUMENT_ID, { sceneId: 'probe-scene' })
  const scene = withObject(
    emptyScene('probe-scene'),
    sceneObject({ id: OBJ, type: 'block', dataId: `${OBJ}:data` }),
    objectData(`${OBJ}:data`, { kind: 'blockGrid', cells: CELLS }, 'document'),
  ) as Scene
  const withSceneDoc = withContent(base, scene, base.animation)
  const adopted = withDocumentContent(withSceneDoc.doc, withSceneDoc.doc.content).doc
  session.adoptDocument(adopted, adopted.content)

  const docRef = ref(legacyDoc()) as unknown as Ref<RuntimeDocument | null>
  const ctx = makeWorkbenchContext(docRef, session)
  return { ctx, session, doc: () => docRef.value, dispose: () => session.dispose() }
}

/**
 * 造一个**真** `Context`，只注入 `submitPropertyWrite` 链所需的字段。
 *
 * | 注入项 | 为什么生产链需要它 |
 * |---|---|
 * | `main.doc` + `main.replaceDoc` | `documentStateOf` 读文档；`setDocument`（唯一写入口）写它 |
 * | `kernel` | 内核会话（写权威）；`null` = 无会话 ⇒ 回落分支 |
 * | `getContentRefreshTick` | `versionOf`/`accessOfContext` 读它（内容重读宽信号） |
 * | `getSelection` | `targetFacts` 读选中集 |
 * | `capabilities` | 写能力来自装配能力 `content.edit`（`defaultCapabilities`） |
 * | `getShellSettings` | `accessOfContext` 读 `lang.value`（A33 的实例级语言） |
 * | `main.embedPublish` + `getToolSettings` | `documentStateOf` 造 `shell` 时读它们（空文档占位） |
 * | `fieldRejections` + `log` | 写路由的结算处同时写**字段拒绝回执**与**底栏成句原因** |
 *
 * ⚠️ `fieldRejections` 必须显式注入：`Object.create(Context.prototype)` **不执行**
 * 类字段初始化器，于是生产里那个 `private readonly` 存储在这里不存在。
 * 注入的是**生产工厂**（`createFieldRejectionStore`），不是替身。
 *
 * ⚠️ 注入的**不是**"判定"：`submitPropertyWrite` 与 `syncLegacyFromKernel` 跑的都是
 * **生产实现本体**（本文件要钉的正是它们）。
 */
function makeWorkbenchContext(
  docRef: Ref<RuntimeDocument | null>,
  session: KernelSession | null,
): Context {
  const ctx = Object.create(Context.prototype) as Context
  Object.assign(ctx as unknown as Record<string, unknown>, {
    // 属性写结算会写结构化诊断面（`command.unChanged`/`property.readOnly`/`command.wouldBlock`）。
    wm: { diagnostics: createDiagnosticRecorder({ capacity: 64, now: () => 0 }) },
    main: {
      doc: docRef,
      // `documentStateOf` 读它造 shell 快照；本判据不看壳设置 ⇒ 给最小可读形状
      embedPublish: ref({}),
    },
    kernel: session,
    // 写能力来自**装配能力** `content.edit`（生产工作台装配的同一项）。
    // 缺它 ⇒ 提交会被能力拒绝，那测的就是"能力门"而不是本文件要钉的"回写"。
    capabilities: ['content.edit', 'shell.workbench'],
    workbench: {},
    getSelection: () => ({ active: ref(null), items: ref(new Set()) }),
    getContentRefreshTick: () => ref(0),
    getShellSettings: () => ({ lang: ref('zh') }),
    fieldRejections: createFieldRejectionStore(),
    log: fakeLog(),
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

/**
 * 最小可用 `ctx.log`（结算处只用到两个方法）。
 *
 * 记录写下的实时状态，供"拒绝必须到达底栏"这类断言直接读——它**不是**替身逻辑，
 * 只是把生产 `LogCenter` 的两个方法按其契约换成可观测的内存槽
 * （本文件钉的是写路由的结算，不是 LogCenter 的去重策略，后者有自己的单测）。
 */
function fakeLog(): {
  setLiveStatus(message: string, level?: number, state?: string | null, origin?: string | null): void
  clearRejectionStatus(): void
  live: { message: string; level: number; state: string | null; origin: string | null } | null
} {
  const slot = {
    live: null as { message: string; level: number; state: string | null; origin: string | null } | null,
    setLiveStatus(message: string, level = 0, state: string | null = null, origin: string | null = null): void {
      slot.live = { message, level, state, origin }
    },
    clearRejectionStatus(): void {
      if (slot.live?.origin === 'rejection') slot.live = null
    },
  }
  return slot
}

/** 内核侧读一条逐格说明。 */
function kernelTooltipAt(session: KernelSession, x: number, y: number, z: number): string | undefined {
  const doc = session.document()!
  const obj = findObject(doc.scene, OBJ)
  const data = obj === undefined ? undefined : findObjectData(doc.scene, obj.dataId)
  if (data === undefined || data.payload.kind !== 'blockGrid') return undefined
  return data.payload.cellContent?.[cellContentKey(x, y, z)]?.tooltip
}

/**
 * legacy 侧读一条逐格说明（**按文件格式的 row 序**）：
 * `cellTooltipGrid[z][row][col]` → 池下标 → 文案。
 *
 * 注意 `row` 与**世界 y** 的关系是 `row = h - 1 - y`
 * （`adapters/tooltipPool` 的契约事实 1）—— 本助手按文件口径读，
 * 故调用方传**世界 y**，这里翻成 row。
 */
function legacyTooltipAt(
  doc: RuntimeDocument | null,
  x: number,
  y: number,
  z: number,
  height: number,
): string | null {
  const grid = doc?.cellTooltipGrid
  if (grid === undefined) return null
  const row = height - 1 - y
  const idx = grid[z]?.[row]?.[x]
  if (idx === undefined || idx < 0) return null
  // `tooltipPalette` 在 `RuntimeDocument` 上是 `unknown[]`（旧格式未经校验的池）
  // ⇒ 读面按 `string` 收窄（生产消费方 `pure/tooltipResolution` 同一口径）。
  const pool = doc?.tooltipPalette
  const text = pool?.[idx]
  return typeof text === 'string' ? text : null
}

/** 面板入口的一次提交（**生产** `submitPropertyWrite`）。 */
function panelCommit(ctx: Context, x: number, y: number, z: number, text: string): unknown {
  return submitPropertyWrite(
    ctx,
    [
      {
        property: 'lightning.block.tooltip',
        owner: { kind: 'object', type: 'lightning.block', id: `${x},${y},${z}` },
      } as never,
    ],
    text,
  )
}

describe('面板入口逐格说明写入走内核路径（真 Context，非回落）', () => {
  it('**两侧都要落点**：面板提交后内核与 legacy **都**必须拿到该文案', () => {
    const h = harness()
    try {
      // 反空洞：必须真的装配成功，否则会走回落分支 ⇒ 本判据空转（前提）
      expect(h.session.hasAdoptedContent(), '必须先证明装配成功（否则走回落，判据空转）').toBe(true)
      expect(h.doc()?.cellTooltipGrid, '前提：legacy 起初没有侧表').toBeUndefined()

      const outcome = panelCommit(h.ctx, 0, 1, 0, '面板写的说明')
      expect((outcome as { status: string }).status, '面板提交必须成功').toBe('applied')

      // ① 内核侧
      expect(kernelTooltipAt(h.session, 0, 1, 0), '内核必须记下该格说明').toBe('面板写的说明')
      // ② legacy 侧（**失败点：修前这里恒为 null**）
      expect(
        legacyTooltipAt(h.doc(), 0, 1, 0, H),
        'legacy 侧表**必须**被投影（修前：内核写了、legacy 没写 ⇒ 面板读不到值 = 该缺陷）',
      ).toBe('面板写的说明')
      // ③ 另一格不受影响（防"写到镜像的那一行"）
      expect(kernelTooltipAt(h.session, 0, 0, 0), '另一格不得被写').toBeUndefined()
      expect(legacyTooltipAt(h.doc(), 0, 0, 0, H), '另一格不得被写').toBeNull()
    } finally {
      h.dispose()
    }
  })

  it('**逐格往返对称**：两次写不同格 ⇒ 两侧各得其所（不是"都写同一格"）', () => {
    const h = harness()
    try {
      expect(h.session.hasAdoptedContent()).toBe(true)
      panelCommit(h.ctx, 0, 1, 0, 'BOTTOM')
      panelCommit(h.ctx, 0, 0, 0, 'TOP')
      for (const [y, text] of [
        [1, 'BOTTOM'],
        [0, 'TOP'],
      ] as const) {
        expect(kernelTooltipAt(h.session, 0, y, 0), `内核 y=${y}`).toBe(text)
        expect(legacyTooltipAt(h.doc(), 0, y, 0, H), `legacy y=${y}`).toBe(text)
      }
    } finally {
      h.dispose()
    }
  })

  it('**删除语义**：删掉最后一条说明 ⇒ 两侧都清成"没有"（"删不掉"是静默失效）', () => {
    const h = harness()
    try {
      expect(h.session.hasAdoptedContent()).toBe(true)
      panelCommit(h.ctx, 0, 1, 0, '要删掉的')
      expect(legacyTooltipAt(h.doc(), 0, 1, 0, H), '前提：先真的写进去了').toBe('要删掉的')
      panelCommit(h.ctx, 0, 1, 0, '')
      expect(kernelTooltipAt(h.session, 0, 1, 0), '内核侧必须移除该字段').toBeUndefined()
      expect(
        legacyTooltipAt(h.doc(), 0, 1, 0, H),
        'legacy 侧表必须清成"没有"（把 `null` 当"不改"就会留下旧池 = 删不掉）',
      ).toBeNull()
    } finally {
      h.dispose()
    }
  })

  it('**两侧投影一致**：legacy 回写的侧表 == 保存投影给出的侧表（防"看到的 ≠ 存出来的"）', () => {
    const h = harness()
    try {
      expect(h.session.hasAdoptedContent()).toBe(true)
      panelCommit(h.ctx, 0, 0, 0, 'A')
      panelCommit(h.ctx, 0, 1, 0, 'B')
      const viaSync = projectCellTooltipsToLegacy(h.session.document()!)
      expect(viaSync, '内核里确有说明 ⇒ 投影非空').not.toBeNull()
      // ① legacy 文档上的侧表 == 直接投影的结果
      expect(h.doc()?.tooltipPalette, 'legacy 池必须逐字等于投影').toEqual([...(viaSync?.palette ?? [])])
      expect(h.doc()?.cellTooltipGrid, 'legacy 网格必须逐项等于投影').toEqual(
        (viaSync?.grid ?? []).map((s) => s.map((r) => [...r])),
      )
      // ② 保存投影（`plainForSave`）给出的侧表也一致 —— 这是"面板看到的 = 存出来的"
      const saved = h.ctx.plainForSave()
      expect(saved.source, '装配成功 ⇒ 保存投影以内核为权威').toBe('kernel')
      expect(saved.plain?.tooltipPalette, '保存产物的池必须与 legacy 一致').toEqual(h.doc()?.tooltipPalette)
      expect(saved.plain?.cellTooltipGrid, '保存产物的网格必须与 legacy 一致').toEqual(h.doc()?.cellTooltipGrid)
    } finally {
      h.dispose()
    }
  })

  it('**幂等**：同一值写两次 ⇒ 不产生重复池条目、值稳定（净零往返不重建）', () => {
    const h = harness()
    try {
      expect(h.session.hasAdoptedContent()).toBe(true)
      panelCommit(h.ctx, 0, 1, 0, 'SAME')
      const poolAfterFirst = [...(h.doc()?.tooltipPalette ?? [])]
      expect(poolAfterFirst, '第一次写入应产出 1 条池').toEqual(['SAME'])
      panelCommit(h.ctx, 0, 1, 0, 'SAME')
      // ⚠️ **不**断言"引用不变"：第二次提交时内核命令返回 `unchanged`
      //（`reduceSetCellTooltip` 的幂等）⇒ `submitContentEdit` 返回 `false`
      // ⇒ 面板按设计走**回落分支**（legacy 写同值）。这是既有语义，不是本缺陷。
      // 本判据钉的是**可观测不变量**：池不重复增长、值稳定。
      expect(h.doc()?.tooltipPalette, '同值重写不得让池重复增长').toEqual(['SAME'])
      expect(legacyTooltipAt(h.doc(), 0, 1, 0, H), '值必须稳定').toBe('SAME')
      expect(kernelTooltipAt(h.session, 0, 1, 0), '内核侧同样稳定').toBe('SAME')
    } finally {
      h.dispose()
    }
  })
})

describe('负对照（证明上面的判据真的在测"回写"）', () => {
  it('**"只投影注解"的形态上，核心断言表达式必然取空值**（判据非恒绿、非空洞真）', () => {
    const h = harness()
    try {
      expect(h.session.hasAdoptedContent()).toBe(true)
      panelCommit(h.ctx, 0, 1, 0, '面板写的说明')
      // ① 修复后的实现：核心断言表达式的值为文案
      expect(
        legacyTooltipAt(h.doc(), 0, 1, 0, H),
        '修复后：面板提交 ⇒ legacy 侧表有值（第 1 组钉的就是这条）',
      ).toBe('面板写的说明')

      // ② **显式构造**修复前的形态（只投影注解、侧表留空）——
      //    不依赖当前实现，故本对照不会与"判据本身"互相印证。
      const prefixState = h.doc()!.clone()
      ;(prefixState as unknown as { annotations: unknown[] }).annotations = [
        ...projectAnnotationsToLegacy(h.session.document()!),
      ]
      ;(prefixState as unknown as { tooltipPalette: string[] | undefined }).tooltipPalette = undefined
      ;(prefixState as unknown as { cellTooltipGrid: number[][][] | undefined }).cellTooltipGrid = undefined

      // 同一条断言表达式在修复前的形态上**取空值** ⇒ 第 1 组会判红（判据有区分力）
      expect(
        legacyTooltipAt(prefixState, 0, 1, 0, H),
        '修复前的形态上该表达式取 null ⇒ 第 1 组的断言必然判红（故它不是恒真）',
      ).toBeNull()
      // ③ 反空洞真：内核侧两侧形态**都**有值 —— 证明差异确实在"回写"这一步，
      //    而不是"内核根本没写进去"（后者会让本对照测错对象）
      expect(kernelTooltipAt(h.session, 0, 1, 0), '内核侧在两种形态下都有值').toBe('面板写的说明')
    } finally {
      h.dispose()
    }
  })

  /**
   * ## 本组守的**新不变量**（处置 B）
   *
   * 原判据是负对照：「**未装配 ⇒ 面板走 legacy 写（能力不回退）**」
   * —— 它要求 存在性=true / 装配成功=false 时 `panelCommit` 仍 `applied` 并写进
   * `doc.tooltipPalette`。
   *
   * 该口径已被**取代**：在"有文档但内核未 adopted"这一状态下，
   * 往 legacy 载体写是一条**会说谎的写路径** —— 权威在内核（此刻未 adopted），
   * 写进 `doc.tooltipPalette` 之后，下一次 `syncLegacyFromKernel` 会把它覆盖掉，
   * 用户看到的是"改了、又没了"，正是该缺陷本身警示的形态。保住的只是能力的**外观**。
   *
   * ⇒ 新不变量：**单一内容权威 —— 未装配即显式不可用**。
   * 判据形态（三半，缺一即失去区分力）：
   *  1. 状态 `rejected`（**不是** applied，也不是静默无变化）；
   *  2. 结构化原因 `UnsupportedOperation` + `reason:'kernel-not-adopted'`（响亮可诊断）；
   *  3. **legacy 载体逐字未被改动**（后半句才是区分力所在：它证明**没有**回落写）。
   */
  it('**单一内容权威**：未装配 ⇒ 面板内容写**显式拒绝**（`kernel-not-adopted`），且 legacy 载体逐字未动', () => {
    // 预置**非空**的 legacy 侧表：这样"未被改动"才是可判的事实（空表上判"没变"没有区分力）。
    const seeded = legacyDoc().withCellTooltips(['既有的'], [[[0]]])
    const docRef = ref(seeded) as unknown as Ref<RuntimeDocument | null>
    const fresh = new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: ALL_CAPABILITIES,
    })
    const ctx = makeWorkbenchContext(docRef, fresh)
    try {
      expect(fresh.hasAdoptedContent(), '前提：未装配').toBe(false)
      // ⚠️ **必须镜像存在性**（暴露的一处替身失真）
      //
      // 生产里"装上一份文档"是**一次** `Context.setDocument`：它先 `replaceDoc`
      //（写 `main.doc`）**再** `kernel.markLoaded()`。本宿主直接注入 `main.doc`，
      // 跳过了后者 ⇒ `hasLoadedDocument()` 会返回 **false**（内核侧不知道自己已装载），
      // 于是 `targetFacts` 判 `exists:false` ⇒ 提交被拒 **'rejected'**。
      // 那是**替身失真**，不是生产行为：补上镜像这一半即可（与 `kernelReadTestHost`
      // 的 `swapDocument` 同一处置）。
      fresh.markLoaded()
      expect(ctx.hasLoadedDocument(), '前提：镜像后 GF-15 = true').toBe(true)
      expect(fresh.hasAdoptedContent(), 'GF-16 仍为假（有文档但未装配）').toBe(false)

      const paletteBefore = docRef.value?.tooltipPalette
      const gridBefore = docRef.value?.cellTooltipGrid
      const docBefore = docRef.value

      const outcome = panelCommit(ctx, 0, 1, 0, '回落写的') as {
        status: string
        error?: { code?: string; params?: Record<string, unknown> }
      }
      expect(outcome.status, '未装配 ⇒ 内容写**不可用**（不再有会说谎的回落）').toBe('rejected')
      expect(outcome.error?.code, '拒绝必须具名（结构化错误码）').toBe('UnsupportedOperation')
      expect(outcome.error?.params?.reason, '原因必须可归因：不是"没反应"').toBe('kernel-not-adopted')

      // ★ 区分力所在：形态上"写没写 legacy"必须可判。
      expect(docRef.value, '不得替换文档引用（没有 setDocument ⇒ 没有回落写）').toBe(docBefore)
      expect(docRef.value?.tooltipPalette, 'legacy 说明池**逐字**未被改动').toEqual(paletteBefore)
      expect(docRef.value?.cellTooltipGrid, 'legacy 说明网格**逐字**未被改动').toEqual(gridBefore)
      expect(docRef.value?.tooltipPalette, '前提：池里确有旧值（否则上面那条是空转）').toEqual(['既有的'])
    } finally {
      fresh.dispose()
    }
  })

  /**
   * **注入负对照**（证明上一条的"未改动"半句有区分力，不是恒真）。
   *
   * 注入方式：在内存里模拟一次**回落写**（把 `tooltipPalette` 拼上新文案）——
   * 若生产里有人把 legacy 回落加回 `submitPropertyWrite`，上一条的两条断言
   *（`tooltipPalette` 未改动、引用未替换）**必然判红**。
   *
   * ⚠️ 刻意不读真实文件、也不改 `src/`：本对照只需证明"命中集合变大时该断言会失败"
   *（与 `seams.test.ts` 的注入负对照同一手法）。
   */
  it('**负对照**：注入一次 legacy 回落写 ⇒ 上一条的"逐字未被改动"断言必然判红', () => {
    const seeded = legacyDoc().withCellTooltips(['既有的'], [[[0]]])
    // 注入：这条表达式**就是**被取代的那条回落分支的形态（拼池 + 换网格）。
    // 池的字段在 legacy 文档上是弱类型的（`unknown`），故此处显式收窄——
    // 这只是让注入表达式可编译，不改变它的区分力（下两条断言照旧）。
    const seededPool = (seeded.tooltipPalette as string[] | undefined) ?? []
    const injected = seeded.withCellTooltips(
      [...seededPool, '回落写的'],
      [[[0, 1]]],
    )
    expect(
      injected.tooltipPalette,
      '注入后池必须变 ⇒ "池逐字未改动"这条断言确实有区分力',
    ).not.toEqual(seeded.tooltipPalette)
    expect(injected.cellTooltipGrid, '注入后网格也必须变（两半都要有区分力）').not.toEqual(seeded.cellTooltipGrid)
    // 反面：**不**注入时两半都相等 —— 证明上面那条不是"任何输入都判红"。
    expect(seeded.tooltipPalette).toEqual(['既有的'])
    expect(seeded.cellTooltipGrid).toEqual([[[0]]])
  })

  /**
   * **拒绝必须响亮可诊断**（A6.2 的判据形态）：拒绝原因经**面板的诊断键**唯一化，
   * 而不是被压成布尔或默认值。
   *
   * 落点：`editors/property-writers#writeErrorKey`（面板/LogCenter 显示拒绝原因时
   * 用的**稳定诊断键**；`PanelSession.rejections` 按局部属性名存放同一条
   * `DomainError`，由 `buildFieldViewModel` 的 `rejection` 字段渲染）。
   */
  it('**可诊断**：未装配的拒绝经面板入口产出**稳定诊断键**（不是"点了没反应"）', () => {
    const seeded = legacyDoc().withCellTooltips(['既有的'], [[[0]]])
    const docRef = ref(seeded) as unknown as Ref<RuntimeDocument | null>
    const fresh = new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: ALL_CAPABILITIES,
    })
    const ctx = makeWorkbenchContext(docRef, fresh)
    try {
      fresh.markLoaded()
      // 面板的**真实**提交入口（`commitFieldValue`）：它自己从选中集解析目标。
      Object.assign(ctx as unknown as Record<string, unknown>, {
    // 属性写结算会写结构化诊断面（`command.unChanged`/`property.readOnly`/`command.wouldBlock`）。
    wm: { diagnostics: createDiagnosticRecorder({ capacity: 64, now: () => 0 }) },
        getSelection: () => ({
          active: ref(null),
          items: ref(new Set([{ kind: 'block', ref: { pos: { x: 0, y: 1, z: 0 } } }])),
        }),
        getHoveredBlock: () => ref(null),
        getHoveredAnnotationId: () => ref(null),
      })
      const desc = workbenchRegistry().registry.descriptor('lightning.block.tooltip')
      expect(desc, '前提：面板确实声明了 `tooltip` 属性').toBeTruthy()
      const outcome = commitFieldValue(ctx, desc!, '测诊断键') as {
        status: string
        error?: { code?: string; params?: Record<string, unknown> }
      }
      expect(outcome.status, '面板入口必须如实拒绝').toBe('rejected')
      expect(outcome.error, '拒绝必须带原因（不是布尔）').toBeTruthy()
      expect(
        writeErrorKey(outcome.error as never),
        '诊断键必须稳定可读（面板/日志按它显示原因）',
      ).toBe('UnsupportedOperation:kernel-not-adopted')
    } finally {
      fresh.dispose()
    }
  })
})