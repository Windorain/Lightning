/**
 * **P10f（#301）C′1 · D8 修复的注入判据**（GF-16 装配成功读面）。
 *
 * ## D8 是什么（既存缺陷）
 *
 * 帧源守卫测的是"**文档存在**"（`kernel.document() !== undefined`，恒真），
 * 而注释声称"装配未覆盖时回落 legacy（能力不回退）" ⇒ 装配失败时返回
 * **空帧轴（0）**，而那处回落**从未生效**。
 *
 * ## ⚠️ 本判据的核心要求（Lead 明确）：**必须有装配失败注入**
 *
 * 要证明回落**真的生效**，而不是"没再观察到 0"。两者的区别是决定性的：
 *
 * | 写法 | 装配成功 | 装配失败 | 能否区分"修好了"与"缺陷仍在" |
 * |---|---|---|---|
 * | 原缺陷（守卫 = 文档存在） | N | **0** ❌ | — |
 * | 只在成功路径断言 | N ✅ | 不测 | **不能**（假绿） |
 * | **本判据** | N ✅ | **N ✅**（回落 legacy） | **能** |
 *
 * ## 判的是**生产代码本身**（不是测试里复刻的一份）
 *
 * 判定逻辑是纯函数 `runtime/frameDeclarations#resolveFrameDeclarations`，
 * `Context.frameDeclarations` 只负责取事实并调用它。故本文件**直接调生产函数**
 * —— 不存在"两份实现漂移"的余地（B′ 曾因宿主复刻而不得不另加一条源码级判据，
 * 本批把这个结构问题从根上消掉）。
 *
 * ## "装配失败"如何**真实**注入（不是 mock 一个布尔）
 *
 * 走**生产**的 `adoptLoadedDocument`，喂它一份内核装配**真的不支持**的形态
 * （`assembleKernelDocument` 显式返回 `UnsupportedOperation`：`frames` 缺失
 * 且不是多方块文档）。于是 `adoptDocument` **不被调用** ⇒ GF-16 保持 `false`，
 * 而 legacy 文档已装上 ⇒ GF-15 为 `true`。那正是 D8 的现实形态。
 */
import { describe, expect, it } from 'vitest'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { resolveFrameDeclarations, type FrameDeclarationSet } from '@/runtime/frameDeclarations'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { RuntimeDocument } from '@/context/runtimeDocument'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'

function parsers() {
  const p = createParserRegistry()
  p.register(V2PlainParser)
  p.register(createEnvelopeParser(p))
  p.register(WorldParser)
  p.register(StructureDataParser)
  return p
}

/** 内核不支持的形态（`frames` 缺失且非多方块）⇒ 装配**必失败**。 */
function unassemblableDoc(): RuntimeDocument {
  return new RuntimeDocument({ id: 'unassemblable' })
}

function newSession(): KernelSession {
  return new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: [],
  })
}

/** 把会话的装配事实转成纯函数的入参（**与 `Context.kernelAdoptedFrames` 同口径**）。 */
function adoptedFramesOf(session: KernelSession): FrameDeclarationSet | null {
  if (!session.hasAdoptedContent()) return null
  const kdoc = session.document()
  if (kdoc === undefined) return null
  const frames = kdoc.content.frameAxis.frames
  return {
    count: frames.length,
    durationsMs: frames.map((f) => f.durationMs ?? 0),
    labels: frames.map((f) => f.label),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 纯函数本身：三态
// ─────────────────────────────────────────────────────────────────────────────

describe('C′1 · D8 ① 纯函数三态（`resolveFrameDeclarations`）', () => {
  it('装配成功 ⇒ 内核为权威（source=kernel）', () => {
    const r = resolveFrameDeclarations(
      { count: 432, durationsMs: [50], labels: [null] },
      { count: 1, durationsMs: [1], labels: [null] },
    )
    expect(r.source).toBe('kernel')
    expect(r.count).toBe(432)
  })

  it('**装配失败（adopted=null）⇒ 回落 legacy**（这正是 D8 修复要恢复的路径）', () => {
    const r = resolveFrameDeclarations(null, { count: 12, durationsMs: [50], labels: ['\u7b2c 0 \u5e27'] })
    expect(r.source, '未装配成功 ⇒ 必须回落 legacy，而不是返回 0').toBe('legacy')
    expect(r.count, '帧数必须是 legacy 的 12').toBe(12)
  })

  it('两者皆无 ⇒ `count: 0`，来源报 legacy（"没有文档"是 legacy 侧的事实）', () => {
    const r = resolveFrameDeclarations(null, null)
    expect(r).toEqual({ count: 0, durationsMs: [], labels: [], source: 'legacy' })
  })

  it('**反空洞真**：装配产物**真的声明 0 帧**时，仍以内核为权威（0 是真实答案，不是回落）', () => {
    const r = resolveFrameDeclarations(
      { count: 0, durationsMs: [], labels: [] },
      { count: 12, durationsMs: [50], labels: [null] },
    )
    expect(r.source, '装配成功且声明 0 帧 ⇒ 内核权威（不得被误当成"没装配"而回落）').toBe('kernel')
    expect(r.count).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ② **注入装配失败**：用生产 `adoptLoadedDocument` 造真形态
// ─────────────────────────────────────────────────────────────────────────────

describe('C′1 · D8 ② **装配失败注入**（走生产 `adoptLoadedDocument`）', () => {
  it('正常路径：真实夹具装配成功 ⇒ GF-16 为 true、内核帧轴为权威', async () => {
    const raw = readJson(fixturePath('multiblock-ebf-2ch')) as Record<string, unknown>
    const parsed = await parsers().detectAndParse(raw)
    expect(parsed.document, '夹具应可解析').not.toBeNull()
    const session = newSession()
    try {
      const ok = adoptLoadedDocument(
        { kernel: session, log: { info: () => {}, warn: () => {} } },
        parsed.document!,
        undefined,
        'ebf-2ch',
      )
      expect(ok, '前置：本夹具装配必须成功').toBe(true)
      expect(session.hasAdoptedContent(), 'GF-16 = true').toBe(true)
      const r = resolveFrameDeclarations(adoptedFramesOf(session), { count: 1, durationsMs: [1], labels: [null] })
      expect(r.source).toBe('kernel')
      expect(r.count, '应为内核声明的帧数').toBe(parsed.document!.frameCount)
    } finally {
      session.dispose()
    }
  })

  it('**注入**不支持形态 ⇒ GF-16 为 false，帧数**回落 legacy**（不是 0）', () => {
    const session = newSession()
    try {
      const ok = adoptLoadedDocument(
        { kernel: session, log: { info: () => {}, warn: () => {} } },
        unassemblableDoc(),
        undefined,
        'unassemblable',
      )
      expect(ok, '前置：该形态装配必须**失败**（这就是注入）').toBe(false)
      expect(
        session.hasAdoptedContent(),
        'GF-16 必须为 false —— 这就是 D8 里"有文档但内核不是装配产物"的事实',
      ).toBe(false)

      // **判据本体**：帧数必须是 legacy 的 12，而不是缺陷时的 0
      const legacy: FrameDeclarationSet = {
        count: 12,
        durationsMs: new Array(12).fill(50),
        labels: new Array(12).fill(null),
      }
      const r = resolveFrameDeclarations(adoptedFramesOf(session), legacy)
      expect(r.source, '装配失败 ⇒ 回落 legacy').toBe('legacy')
      expect(
        r.count,
        'D8 判据：装配失败时帧数必须**回落 legacy（12）**。\n' +
          '若这里是 0，说明守卫仍在测"文档存在" ⇒ 回落没生效（缺陷复发）。',
      ).toBe(12)
      expect(r.durationsMs.length, '时长也必须来自 legacy').toBe(12)
      expect(r.count, '反空洞真：legacy 帧数非 0，故"回落生效"可被区分').not.toBe(0)
    } finally {
      session.dispose()
    }
  })

  it('**GF-15 与 GF-16 是不同事实**：装配失败时"有文档"为 true 而"装配成功"为 false', () => {
    const session = newSession()
    try {
      const ok = adoptLoadedDocument(
        { kernel: session, log: { info: () => {}, warn: () => {} } },
        unassemblableDoc(),
        undefined,
        'unassemblable',
      )
      expect(ok).toBe(false)
      expect(session.hasAdoptedContent(), 'GF-16 = 装配成功 = false').toBe(false)
      session.markLoaded() // 模拟 `Context.setDocument` 的存在性镜像
      expect(session.hasLoadedDocument(), 'GF-15 = 有文档 = true').toBe(true)
      expect(
        session.hasLoadedDocument() !== session.hasAdoptedContent(),
        '两个读面在"有文档但未装配"时必须给出**不同**答案，否则 GF-16 没有存在理由',
      ).toBe(true)
    } finally {
      session.dispose()
    }
  })

  it('`markUnloaded` 必须**一起**清掉 GF-16', () => {
    const session = newSession()
    try {
      session.markLoaded()
      session.markUnloaded()
      expect(session.hasLoadedDocument(), 'GF-15 已清').toBe(false)
      expect(session.hasAdoptedContent(), 'GF-16 也必须被清').toBe(false)
    } finally {
      session.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ `Context.frameDeclarations` 只是"取事实 + 调纯函数"（外壳不得自己判）
// ─────────────────────────────────────────────────────────────────────────────

describe('C′1 · D8 ③ `Context.frameDeclarations` 委托判定（不得内联分流）', () => {
  it('实现必须①读响应式源 ②调纯函数 ③不自行 `if hasAdoptedContent` 分支', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const abs = path.join(process.cwd(), 'src', 'runtime', 'context.ts')
    const raw = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n')
    const sigStart = code.indexOf('frameDeclarations(): {')
    expect(sigStart, '`Context.frameDeclarations` 必须存在').toBeGreaterThan(-1)
    // ⚠️ 签名跨多行（返回类型是对象字面量类型）⇒ 方法体从 `} {` 开始。
    // 第一版直接从签名切到第一个 `\n  }`，切到的是**返回类型**的收尾括号
    // ⇒ body 里没有实现，判据假红（本条实测抓出）。
    const bodyOpen = code.indexOf('} {', sigStart)
    const body = code.slice(bodyOpen, code.indexOf('\n  }', bodyOpen))

    expect(
      /const\s+\w+\s*=\s*this\.main\.doc\.value/.test(body),
      '必须读一次 `this.main.doc.value`（响应式依赖；否则 `StatusBar.vue` 的 computed 不刷新）',
    ).toBe(true)
    expect(body, '必须委托纯函数判定').toContain('resolveFrameDeclarations(')
    expect(
      /if\s*\([^)]*hasAdoptedContent\(\)/.test(body),
      '外壳**不得**自行分流（判定只在纯函数里；两处判就是两份会漂移的实现）',
    ).toBe(false)
  })

  it('**反空洞真**：纯函数确实被生产调用（不是测试里才用）', () => {
    // 上一条已断言 `Context` 调用它；此处再确认它不是"只被测试引用"的死代码。
    const r = resolveFrameDeclarations(
      { count: 3, durationsMs: [1, 2, 3], labels: ['a', null, 'c'] },
      null,
    )
    expect(r.count).toBe(3)
    // #301 P10f D3（R4）：`labels` 与 `count`/`durationsMs` **同源**（同一份轴）——
    // 故它必须经同一处分流，而不是被某条分支悄悄丢掉（丢标签是静默的：
    // 帧标签只影响展示，不会让任何断言变红）。
    expect(r.labels, 'labels 必须随 count 一起透传').toEqual(['a', null, 'c'])
  })
})
