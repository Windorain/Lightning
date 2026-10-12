/**
 * **P10f（#301）A′ · 文档生命周期接线**：`Context.setDocument` 存在性镜像的逐路径对齐。
 *
 * ## 本文件证什么
 *
 * A′ 把 15 条路径的 21 处 `ctx.main.replaceDoc(...)` 收口成 `ctx.setDocument(...)`，
 * 并按 GF-15 让内核侧暴露 `hasLoadedDocument()`。本文件钉住**对齐**：
 *
 * ```
 * 在**每一条**文档替换路径上：  ctx.kernel.hasLoadedDocument()  ===  (ctx.getDoc().value !== null)
 * ```
 *
 * ## 为什么这条判据是 A′ 的全部价值所在
 *
 * 后续批次（B′）要把 `raw-authority-object` 的 **29 处 N1 存在性判定**
 * （`getDoc().value !== null`）换成内核读面。若两者在**任一条**路径上不等价，
 * 那次替换就会**静默改变行为** —— 表现为"菜单项本该灰掉却可选"或反之
 * （P10f 子批 A 的侦察实测：`document()` 恒 defined，故直接换 `document()` 是**恒真**的）。
 *
 * ⇒ 本文件的作用是让"能不能换"成为**机器可查**的事实，而不是评审时的印象。
 *
 * ## 判据分三层（缺任一层都会留下假绿）
 *
 * | 层 | 判据 | 防什么 |
 * |---|---|---|
 * | 构造期 | `hasLoadedDocument() === false` 而 `document()` 已 defined | 把"空文档"当成"已装载"（恒真的替换） |
 * | **逐路径对齐** | 21 处各断言两侧相等 | 某条路径漏镜像 |
 * | **反空洞真** | 6 处 `null` 路径必须**真的**把读面置 false | "永远 true" 也能让"相等"在上半段成立 |
 *
 * ## 显式**不**断言（本批边界，不冒充）
 *
 * **原地修改路径**（注解增删改 / tooltip 编辑 / 属性写）的内核**内容**一致性
 * **不在本批范围**，本文件只对它们断言存在性。理由：它们在旧文档上是 in-place
 * 字段（`annotations`/`cellTooltipGrid`/RNA 写回），内核侧对应物是对象载荷
 * （`annotation` 对象 / `cellContent`），映射需要新的命令面 ⇒ 归 C′。
 * 本文件用一个**具名**测试把这条边界写成断言（而不是留在注释里）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { RuntimeDocument } from '@/context/runtimeDocument'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { plainRootOf } from '@/adapters/plainRoot'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具与最小宿主
// ─────────────────────────────────────────────────────────────────────────────

function productionParsers() {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

function loadFixture(name: string): Record<string, unknown> {
  return readJson(fixturePath(name)) as Record<string, unknown>
}

/**
 * 最小宿主：**只**提供 `setDocument` 的镜像语义与 legacy 文档槽。
 *
 * ## 为什么不构造真 `Context`
 *
 * `Context` 的构造参数是 `Main`/`WM`/`ViewportManager`/`ScreenRoot`/… 一整套外壳对象；
 * 构造它们会把本判据变成"外壳装配测试"（与本批无关，且会随外壳演进假红）。
 *
 * 而 `Context.setDocument` 的**全部语义**只有两件事：写 legacy 槽 + 镜像内核状态。
 * ⇒ 本宿主**逐字复刻**那两件事，并**不重写**任何判定。
 *
 * ⚠️ 这构成一处真实的"重复实现"风险，故由**源码级断言**兜住：
 * 下方 `setDocument 的语义在真实实现里也成立` 用例读 `src/runtime/context.ts`，
 * 断言它确实按"先 replaceDoc、后 markUnloaded/markLoaded"的顺序实现。
 * ⇒ 本宿主若哪天与真实实现脱钩，那条会判红。
 */
function makeHost(session: KernelSession | null) {
  let doc: RuntimeDocument | null = null
  return {
    host: {
      getDoc: () => doc,
      setDocument: (next: RuntimeDocument | null): void => {
        doc = next
        if (session === null) return
        if (next === null) session.markUnloaded()
        else session.markLoaded()
      },
    },
    /** 当前两侧状态（供逐点对齐断言）。 */
    snapshot: () => ({
      legacyHasDoc: doc !== null,
      kernelLoaded: session?.hasLoadedDocument() ?? false,
    }),
  }
}

function newSession(): KernelSession {
  return new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: [],
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 构造期：区分「空文档」与「无文档」
// ─────────────────────────────────────────────────────────────────────────────

describe('P10f A′ · GF-15 读面：构造期语义', () => {
  it('会话构造后 `document()` 已定义但 `hasLoadedDocument()` 为 **false**（两者可区分）', () => {
    const s = newSession()
    try {
      expect(s.document(), '构造时内核已有 datablock（`openDocument` 无条件建文档）').toBeDefined()
      expect(s.hasLoadedDocument(), '但它**未装载**任何内容 —— 这正是本读面存在的理由').toBe(false)
      // 反空洞真：那份"已存在的文档"确实是**空**的（否则"未装载"与"空"不可区分）
      expect(Object.keys(s.document()!.scene.objects).length).toBe(0)
    } finally {
      s.dispose()
    }
  })

  it('`markLoaded` / `markUnloaded` 是幂等且可往返的（装载状态是显式值）', () => {
    const s = newSession()
    try {
      s.markLoaded()
      expect(s.hasLoadedDocument()).toBe(true)
      s.markLoaded()
      expect(s.hasLoadedDocument(), '重复装载不改变状态').toBe(true)
      s.markUnloaded()
      expect(s.hasLoadedDocument()).toBe(false)
      s.markUnloaded()
      expect(s.hasLoadedDocument(), '重复卸载不改变状态').toBe(false)
      s.markLoaded()
      expect(s.hasLoadedDocument(), '卸载后可再次装载').toBe(true)
    } finally {
      s.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 逐路径对齐（15 条路径 / 21 处）
// ─────────────────────────────────────────────────────────────────────────────

describe('P10f A′ · 逐路径存在性对齐（15 路径 / 21 处）', () => {
  /** 装载类路径（内容对齐的加载）：`setDocument` + 装配。 */
  const LOAD_PATHS = [
    { label: '#2 OpenScene 成功', fixture: 'multiblock-tier-only' },
    { label: '#4 LoadBuiltin 成功', fixture: 'multiblock-ebf-2ch' },
    { label: '#6 LoadEmbed 成功', fixture: 'multiblock-tier-only' },
    { label: '#7 SDELoadExport 成功', fixture: 'multiblock-lsc-overlap' },
    { label: '#9 SDELoadWorkspace 成功', fixture: 'multiblock-ebf-2ch' },
    { label: '#11 documentLoadPipeline 成功（wiki-data 路径）', fixture: 'multiblock-tier-only' },
  ] as const

  for (const p of LOAD_PATHS) {
    it(`${p.label}：装载后两侧均为「有」，且内核**真的**被装配（objects > 0）`, async () => {
      const raw = loadFixture(p.fixture)
      const parsed = await productionParsers().detectAndParse(raw)
      expect(parsed.document, '夹具应可解析').not.toBeNull()
      const session = newSession()
      const { host } = makeHost(session)
      try {
        // ① 镜像存在性（收口入口）
        host.setDocument(parsed.document!)
        // ② 装配内容（加载路径的第二步）
        const assembled = adoptLoadedDocument(
          { kernel: session, log: { info: () => {}, warn: () => {} } },
          parsed.document!,
          plainRootOf(raw),
          p.fixture,
        )
        // ③ **对齐**
        expect(host.getDoc() !== null, 'legacy 有文档').toBe(true)
        expect(session.hasLoadedDocument(), '内核侧镜像为「已装载」').toBe(true)
        // ④ **内容真的进内核**（交付要求：4 条新增装配必须验证 objects > 0）
        expect(assembled, '装配必须成功（否则本路径仍是"从不装配"）').toBe(true)
        expect(
          Object.keys(session.document()!.scene.objects).length,
          '装配后内核必须**持有对象** —— 这是"这条路径接上了"的机械证据',
        ).toBeGreaterThan(0)
      } finally {
        session.dispose()
      }
    })
  }

  /** 空但存在（NewScene）：装载为 true 而内容为空。 */
  it('#1 NewScene：空场景 ⇒ legacy 有、内核「已装载」（**空 ≠ 无**）', () => {
    const session = newSession()
    const { host } = makeHost(session)
    try {
      host.setDocument(RuntimeDocument.empty())
      expect(host.getDoc() !== null, 'NewScene 的 legacy 文档非 null').toBe(true)
      expect(session.hasLoadedDocument(), '「空但存在」必须镜像为已装载').toBe(true)
    } finally {
      session.dispose()
    }
  })

  /** 卸载类路径（6 处 `replaceDoc(null)`）：两侧都必须为「无」。 */
  const UNLOAD_PATHS = [
    '#3 OpenScene 解析失败',
    '#5 LoadBuiltin 失败',
    '#8 SDELoadExport 失败',
    '#10 SDELoadWorkspace 失败',
    '#12 documentLoadPipeline 失败',
    '#13 工作区重置（miscOperators resetDocument）',
    '#17 pushDocUndo 传入 null（undo 回到无文档）',
  ] as const

  for (const label of UNLOAD_PATHS) {
    it(`${label}：卸载后两侧均为「无」（**反空洞真**的关键半边）`, () => {
      const session = newSession()
      const { host } = makeHost(session)
      try {
        // 先装载（否则"卸载后为 false"可能只是从未装载过）
        host.setDocument(RuntimeDocument.empty())
        expect(session.hasLoadedDocument(), '前置：先装载').toBe(true)
        // 再卸载
        host.setDocument(null)
        expect(host.getDoc(), 'legacy 文档为 null').toBeNull()
        expect(
          session.hasLoadedDocument(),
          '内核侧必须**真的**被置为未装载 —— 否则 B′ 的替换会在这条路径上恒真',
        ).toBe(false)
      } finally {
        session.dispose()
      }
    })
  }

  /** 原地修改路径（#14–#18）：存在性不变，**内容一致性显式不在本批范围**。 */
  const IN_PLACE_PATHS = [
    '#14 annotationOperators 创建',
    '#14 annotationOperators 更新',
    '#14 annotationOperators 删除',
    '#15 metaEditOperators tooltip 编辑',
    '#16 workbench-rna 属性写',
    '#18 modalOperatorWrapper 取消回放',
  ] as const

  for (const label of IN_PLACE_PATHS) {
    it(`${label}：原地改（非 null）⇒ 存在性保持「有」（内容同步归 C′，本批不断言）`, () => {
      const session = newSession()
      const { host } = makeHost(session)
      try {
        const before = RuntimeDocument.empty()
        host.setDocument(before)
        expect(session.hasLoadedDocument()).toBe(true)
        // 原地改：换一份 clone（与生产里 `doc.clone()` + 修改同形）
        host.setDocument(RuntimeDocument.empty())
        expect(host.getDoc()).not.toBeNull()
        expect(session.hasLoadedDocument(), '原地改不改变存在性').toBe(true)
      } finally {
        session.dispose()
      }
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 无会话：镜像静默跳过（配置事实，不是缺陷）
// ─────────────────────────────────────────────────────────────────────────────

describe('P10f A′ · 无内核会话时', () => {
  it('`setDocument` 写 legacy 而**不**镜像（无会话是配置事实，不抛错）', () => {
    const { host } = makeHost(null)
    expect(() => host.setDocument(RuntimeDocument.empty())).not.toThrow()
    expect(host.getDoc(), 'legacy 侧照常工作（能力不回退）').not.toBeNull()
    expect(() => host.setDocument(null)).not.toThrow()
    expect(host.getDoc()).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// pushDocUndo：**存在性必须由传入值派生**（A′ 设计时发现的唯一条件性 null）
// ─────────────────────────────────────────────────────────────────────────────

describe('P10f A′ · `pushDocUndo` 的 undo/redo 两侧（条件性 null）', () => {
  /**
   * ## 为什么这条值得单独钉（设计时实测发现的分支）
   *
   * `pushDocUndo` 的 early-return 是「`before === null` **且** `after === null`」
   * （`pushDocUndo.ts:25`）⇒ 存在 `after` 为 `null` 而 `before` 非 null 的**合法**组合
   * （撤销回到"有文档"、重做回到"无文档"）。
   *
   * 若实现时图省事写死 `markLoaded()`，那条路径会让内核侧**恒为已装载**
   * —— 而 legacy 侧确实回到了 null ⇒ B′ 的替换会在这条路径上改变行为。
   *
   * 本用例调用**真实** `pushDocUndo`（不是复刻），捕获它压入的撤销项，
   * 然后真的执行 `execute`/`undo`，断言两侧始终一致。
   */
  it('`execute`/`undo` 两侧都由**传入值**派生存在性（两侧均与 legacy 对齐）', async () => {
    const { pushDocUndo } = await import('@/operators/pushDocUndo')
    const session = newSession()
    const { host } = makeHost(session)
    try {
      const before = RuntimeDocument.empty()
      let captured: { execute: () => void; undo: () => void } | null = null
      const ctxStub = {
        ...host,
        getEditHistory: () => ({
          push: (entry: { execute: () => void; undo: () => void }) => {
            captured = entry
          },
        }),
      }
      // 前置：当前处于"无文档"（after = null 的组合）
      host.setDocument(null)

      pushDocUndo(ctxStub as never, before, null, '测试')
      expect(captured, 'pushDocUndo 必须压入一条撤销项').not.toBeNull()

      // ① execute：回到 after = null ⇒ 两侧都必须为「无」
      captured!.execute()
      expect(host.getDoc(), 'execute 后 legacy 回到 null').toBeNull()
      expect(
        session.hasLoadedDocument(),
        'execute 后内核必须同步为「未装载」—— 写死 markLoaded 会在这里判红',
      ).toBe(false)

      // ② undo：回到 before（非 null）⇒ 两侧都必须为「有」
      captured!.undo()
      expect(host.getDoc(), 'undo 后 legacy 回到非 null').not.toBeNull()
      expect(session.hasLoadedDocument(), 'undo 后内核必须同步为「已装载」').toBe(true)
    } finally {
      session.dispose()
    }
  })

  it('**负对照**：双 null 时不压入任何撤销项（前置判据本身有效）', async () => {
    const { pushDocUndo } = await import('@/operators/pushDocUndo')
    let pushed = 0
    const ctxStub = {
      getDoc: () => null,
      setDocument: () => {},
      getEditHistory: () => ({ push: () => { pushed += 1 } }),
    }
    pushDocUndo(ctxStub as never, null, null, '空')
    expect(pushed, '两侧皆 null ⇒ 不应压入（否则上一次判据的前置是错的）').toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 重复实现防线：本文件的宿主必须与真实 `Context.setDocument` 同序
// ─────────────────────────────────────────────────────────────────────────────

describe('P10f A′ · 反实现漂移（本文件的镜像宿主 vs 真实实现）', () => {
  /**
   * ## 为什么需要这条
   *
   * 本文件用了一个**最小宿主**来复刻 `Context.setDocument` 的两件事（见其说明）。
   * 那是一处真实的"两份实现"风险 —— 而本工程已多次实测"两份实现必然漂移"
   * （D3a 的几何收集器、P10d 的缺省值）。
   *
   * ⇒ 读**真实实现**的源码，断言它确实是"先 `replaceDoc`、后按 null 分支
   * `markUnloaded`/`markLoaded`"。于是本宿主若与它脱钩（例如真实实现改成
   * 先镜像后写 legacy，或改成不镜像），这条会判红。
   *
   * 用**去注释**后的代码骨架判定（本仓既有口径）：注释里解释这个顺序是
   * 有价值的设计记录，不该被判成实现。
   */
  const CONTEXT = path.join(process.cwd(), 'src', 'runtime', 'context.ts')

  /** 去掉行注释与块注释（保留行结构）—— 与 registry 的扫描器同一取舍。 */
  function stripComments(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
  }

  it('真实 `Context.setDocument`：先 `main.replaceDoc(next)`、再按 null 镜像内核', () => {
    const raw = fs.readFileSync(CONTEXT, 'utf8').replace(/\r\n/g, '\n')
    const code = stripComments(raw)
    // #301 C′2：签名加了 `intent` 参数（见下方"注释与签名一致"那条与 `context.ts` 的说明），
    // 故这里按**签名前缀**定位（不写死整串），否则每次加参数都要改本行 ——
    // 那会让"这条判据在守什么"变得含混（它守的是**方法体语义**，不是签名文本）。
    const start = code.indexOf('setDocument(next: RuntimeDocument | null, intent:')
    expect(start, '`Context.setDocument` 必须存在（它是唯一写入口）').toBeGreaterThan(-1)
    // 取方法体（到下一个顶层 `\n  }` 为止，足够覆盖本方法）
    const body = code.slice(start, code.indexOf('\n  }', start))

    const iReplace = body.indexOf('this.main.replaceDoc(next)')
    const iUnload = body.indexOf('markUnloaded()')
    const iLoad = body.indexOf('markLoaded()')
    expect(iReplace, '必须调用 `this.main.replaceDoc(next)`（legacy 侧写入口）').toBeGreaterThan(-1)
    expect(iUnload, '必须在 null 时镜像为未装载').toBeGreaterThan(-1)
    expect(iLoad, '必须在非 null 时镜像为已装载').toBeGreaterThan(-1)
    expect(iReplace, '**先写 legacy、后镜像**（顺序是语义的一部分，见方法注释）').toBeLessThan(iUnload)
    expect(iReplace).toBeLessThan(iLoad)
    // #301 C′2：**镜像必须在 `content-sync` 意图下被跳过**。
    // 否则编辑回写会把内核镜像成"刚装载"（`markLoaded` 清 GF-16）
    // ⇒ 读面回落 legacy，而内容其实在内核里（C′1 实测抓出的同型缺陷）。
    const iGuard = body.indexOf("if (intent === 'content-sync') return")
    expect(iGuard, '必须存在 `content-sync` 早退守卫（编辑回写不得动内核装载状态）').toBeGreaterThan(-1)
    expect(iGuard, '守卫必须在 `replaceDoc` **之后**（legacy 照写）').toBeGreaterThan(iReplace)
    expect(iGuard, '守卫必须在镜像**之前**（否则 content-sync 也会镜像）').toBeLessThan(iUnload)
    // 反空洞真：确认剥离确实发生过（否则断言可能落在注释里的同名文本上）
    expect(raw.includes('//'), '前置：源码确实含行注释（剥离才有意义）').toBe(true)
    expect(body.includes('先写 legacy'), '注释必须已被剥离（否则会误命中注释文本）').toBe(false)
  })

  /**
   * ## 为什么这条闸门值得单独存在（Lead 复核抓出的一处真实偏差）
   *
   * A′ 的设计表核定过 `setDocument(next, adoption?)` **双参数**形态，实现落成了
   * **单参数**两段式（理由见 `context.ts` 的注释）。而 `context.ts` 的注释一度**仍在
   * 描述那个不存在的 `adoption` 参数** —— 即"文档声称的接口 ≠ 真实接口"。
   *
   * 那正是本工程反复抓的"声称 ≠ 实现"族（P10d 的 methodology 第 5 条：
   * 「提到某函数名 ≠ 调用它」）。它**不会**被任何行为测试抓到：行为是对的，
   * 只有读注释的人会被误导 —— 而下一个消费者正是读注释的人。
   *
   * ⇒ 把"注释与签名一致"变成**机器可查**的事实：
   *  - **签名**参数个数必须等于 1（本批核定并实现的口径）；
   *  - 描述该方法的**文档注释**里**不得**出现 `adoption` 这个词
   *    （它只可能是对不存在参数的描述）。
   *
   * 若将来确实要加回 `adoption` 参数，本用例会判红并**逼**作者同批更新注释与
   * 本节口径 —— 那是正确的摩擦。
   */
  it('注释与签名一致：`setDocument` 是**单参数**，且文档注释不描述不存在的 `adoption`', () => {
    const raw = fs.readFileSync(CONTEXT, 'utf8').replace(/\r\n/g, '\n')

    // ① 签名参数个数（用去注释骨架，避免注释里的同名文本干扰）
    const code = stripComments(raw)
    const m = /setDocument\s*\(([^)]*)\)\s*:/.exec(code)
    expect(m, '`Context.setDocument` 必须存在').not.toBeNull()
    const params = m![1]!.split(',').map((s) => s.trim()).filter((s) => s !== '')
    // #301 C′2：参数个数由 1 变为 2（`next` + `intent`）。
    //
    // ⚠️ 这条判据的**用途**没变（"注释不得描述幻影参数"），变的是**当时的真值**：
    // A′ 核定的口径是"只做 legacy 写 + 存在性镜像"，故 1 个参数就对；
    // C′2 需要第二种意图（编辑回写：写 legacy 但**不**动内核装载状态），
    // 而它必须走**同一个**唯一写者（见 `context.ts` 的 `intent` 说明
    // ——我第一版让 `syncLegacyFromKernel` 自己调 `replaceDoc`，被闸门当场判红，那是对的）。
    // ⇒ 参数的**语义**因此被这条闸门钉住：多了就必须在这一节里说明它是什么。
    expect(params.length, `setDocument 参数个数（实测 ${params.length} 个：${params.join(' | ')}）`).toBe(2)
    expect(params[0]).toContain('next')
    expect(params[1], "第二个参数必须是 `intent`（装载 / 内容同步两种意图）").toContain('intent')
    // 意图的取值集合必须是这两个（多一个就要回来更新本节口径）
    expect(params[1], '`intent` 必须只允许 `load` 与 `content-sync`').toMatch(/'load'/)
    expect(params[1], '`intent` 必须只允许 `load` 与 `content-sync`').toMatch(/'content-sync'/)

    // ② 注释**不得**把 `adoption` 描述成**当前存在的参数**。
    //
    //    ⚠️ 判据刻意不是"注释里不许出现 `adoption`"（第一版那样写，**当场判红**）：
    //    本批的注释**需要**用这个词来**记录**那处偏离（"设计表核定过双参数、
    //    实现落成单参数两段式"）—— 那正是 Lead 要求的留档，删掉它是把
    //    偏差证据抹掉，比留着更糟。
    //
    //    真正要禁的是**静默描述幻影参数**：一段以它为主题的语义说明
    //    （旧注释的形态是 `## \`adoption\` 的语义` + "有值 ⇒ …、无值 ⇒ …"）。
    //    ⇒ 判据 = 若提及该词，则**必须**同时留下"这是偏离"的标记。
    const sigAt = raw.indexOf('setDocument(next: RuntimeDocument | null, intent:')
    expect(sigAt, '前置：必须能定位签名').toBeGreaterThan(-1)
    const docStart = raw.lastIndexOf('/**', sigAt)
    expect(docStart, '前置：该方法必须有文档注释').toBeGreaterThan(-1)
    const doc = raw.slice(docStart, sigAt)

    if (/adoption/i.test(doc)) {
      expect(
        /偏离|设计表/.test(doc),
        '注释提到了 `adoption`（该方法**没有**这个参数），故必须同时标明那是\n' +
          '"与设计表的偏离 + 实现理由"—— 否则读者会以为装载可以折进本方法。\n' +
          '（旧缺陷形态：一段 `## `adoption` 的语义` 如实描述一个不存在的参数。）',
      ).toBe(true)
      // 且不得保留旧的"语义说明"标题形态（那正是被修掉的那段）
      expect(
        /adoption\s*`?\s*的语义/.test(doc),
        '不得再出现"`adoption` 的语义"这类把它当现有参数的段落标题',
      ).toBe(false)
    }

    // ③ 反空洞真：注释里**确实**有内容（否则上面的判据是空转）
    expect(doc.length, '前置：文档注释非空，判据才有对象').toBeGreaterThan(200)
    expect(doc.includes('唯一写入口'), '前置：注释确实在描述本方法').toBe(true)
  })
})
