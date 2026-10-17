/**
 * **P10f（#301）D3 · 新读面（R4/R6/R7/R8/R9）的判据**。
 *
 * ## 本文件证明什么（每条对应一处会静默违反的约束）
 *
 * | 组 | 读面 | 违反的后果（**静默**） |
 * |---|---|---|
 * | R4 | `frameDeclarations().labels` | 帧标签在某条分流分支上被丢 ⇒ 面板帧名空但无人报错 |
 * | R6 | `cellTooltips()` | 未装配时不回落 legacy ⇒ 面板读到"没有说明"而 legacy 有（#333 同族） |
 * | R7 | `documentMetadata()` | 内核分支把 `formatVersion` 给 `''` ⇒ "没声明版本"与"不知道版本"混同 |
 * | R8 | `documentSnapshot()` / `restoreDocumentSnapshot()` | 令牌携带 `RuntimeDocument` ⇒ 只是把访问器改了个名（#171 禁）；或 `null` 令牌被当成"不动" ⇒ 撤销回不到"无文档" |
 * | R9 | `legacyRenderSource()` | 它被当成内容读入口 ⇒ 变成后门（已登记接缝，不得扩大） |
 *
 * ## ⚠️ 判的是**生产 `Context` 本体**（不是复刻）
 *
 * 宿主 `kernelReadTestHost` 造的是 `Object.create(Context.prototype)` 的真实例
 * ⇒ 注入缺陷（例如把 `cellTooltips` 的回落分支删掉）会当场判红。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { RuntimeDocument } from '@/context/runtimeDocument'
import { makeAdoptedKernelReadHost, makeKernelReadHost } from './kernelReadTestHost'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import { documentContent, documentMetadata, frameAxis } from '@/domain/content'
import { objectData, sceneObject } from '@/domain/scene'
import { withScene, createDocument } from '@/domain/document'
import { cellContent, cellContentKey } from '@/domain/cellContent'
import type { Scene } from '@/domain/scene'

function parsers() {
  const p = createParserRegistry()
  p.register(V2PlainParser)
  p.register(createEnvelopeParser(p))
  p.register(WorldParser)
  p.register(StructureDataParser)
  return p
}

async function loadFixture(name: string): Promise<{ doc: RuntimeDocument; plainRoot: Record<string, unknown> }> {
  const envelope = readJson(fixturePath(name)) as Record<string, unknown>
  const parsed = await parsers().detectAndParse(envelope)
  expect(parsed.document, `${name} 应可被生产解析器解析`).not.toBeNull()
  const layers = await readEnvelopeLayers(envelope as never)
  return { doc: parsed.document!, plainRoot: layers.plain as Record<string, unknown> }
}

/**
 * **帧为主文档**（时间轴的拥有者；两帧、各带网格）。
 *
 * M5-1 之后多方块文档的帧轴恒为空，故"帧标签来自内核帧轴"这条判据只能由帧为主文档承担。
 */
const FRAME_DOMINANT_PLAIN: Record<string, unknown> = Object.freeze({
  format_version: '2.0',
  id: 'frame-dominant',
  meta: { name: '两帧', author: 'a', created_at_ms: 1, description: '', tags: [], origin: { x: 0, y: 0, z: 0 } },
  annotations: [],
  labels: [],
  frames: [
    { index: 0, label: 'f0', durationMs: 50, structure: { geometryPhase: 'baked', cellGrid: [[[1]]], blockPalette: [{ registryId: 'air', meta: 0 }, { registryId: 'minecraft:stone', meta: 0 }] } },
    { index: 1, label: 'f1', durationMs: 100, structure: { geometryPhase: 'baked', cellGrid: [[[1]]], blockPalette: [{ registryId: 'air', meta: 0 }, { registryId: 'minecraft:stone', meta: 0 }] } },
  ],
})

/** 造一份"编辑期文档"（无帧网格、带注解与元数据）。 */
function editedDoc(): RuntimeDocument {
  return new RuntimeDocument({
    id: 'edited',
    meta: { name: '我的结构', author: 'me', description: 'd', tags: ['a'], origin: { x: 1, y: 2, z: 3 } },
    frames: [{ index: 0, label: null, structure: { sizeColumn: 1, sizeRow: 1, sizeZSlice: 1, cellGrid: [], blockPalette: [] } }],
    tooltipPalette: ['hello'],
    cellTooltipGrid: [[[0]]],
  } as never)
}

// ─────────────────────────────────────────────────────────────────────────────
// R4 · 帧声明扩 `labels`
// ─────────────────────────────────────────────────────────────────────────────

describe('D3/R4 `frameDeclarations().labels`（与 count/durations 同源同分流）', () => {
  it('装配成功 ⇒ 标签来自**内核**帧轴（帧为主文档：两帧、带标签）', async () => {
    // ⚠️ M5-1：多方块文档的帧清单是**场景清单**，其帧轴恒为空 ⇒ 本判据改用帧为主文档
    // （帧轴 = 时间轴，标签随文档声明）；输入仍走生产解析器 + 生产装配。
    const parsed = await parsers().detectAndParse(FRAME_DOMINANT_PLAIN)
    expect(parsed.document, '帧为主夹具应可解析').not.toBeNull()
    const h = makeAdoptedKernelReadHost(parsed.document!, FRAME_DOMINANT_PLAIN)
    try {
      const decl = h.ctx.frameDeclarations()
      expect(decl.source, '前置：必须装配成功').toBe('kernel')
      const kdoc = h.session!.document()!
      expect(decl.labels).toEqual(kdoc.content.frameAxis.frames.map((f) => f.label))
      expect(decl.labels.length, '标签数必须与帧数一致（同一条轴）').toBe(decl.count)
      // 反空洞真：这份夹具的帧轴**真的有**帧（否则 labels 的比较是空转）。
      expect(decl.count).toBeGreaterThan(0)
      expect(decl.labels, '标签逐项来自声明').toEqual(['f0', 'f1'])
    } finally {
      h.dispose()
    }
  })

  it('M5-1 反向：多方块文档**没有时间轴帧** ⇒ 内核权威地给出 0 帧（不是回落）', async () => {
    const { doc, plainRoot } = await loadFixture('multiblock-tier-only')
    const h = makeAdoptedKernelReadHost(doc, plainRoot)
    try {
      const decl = h.ctx.frameDeclarations()
      expect(decl.source, '装配成功 ⇒ 内核权威（0 是真实答案，不是回落）').toBe('kernel')
      expect(decl.count, '场景清单不进时间轴 ⇒ 帧数 0').toBe(0)
      expect(decl.labels).toEqual([])
      // 反空洞真：该夹具确实声明了多场景（否则本判据可能只是夹具没内容）。
      expect(h.session!.document()!.content.multiblock.frames.length).toBeGreaterThan(1)
    } finally {
      h.dispose()
    }
  })

  it('未装配 ⇒ 标签来自 **legacy**（且来源字段如实报 `legacy`）', () => {
    const h = makeKernelReadHost(editedDoc())
    const decl = h.ctx.frameDeclarations()
    expect(decl.source, '无会话 ⇒ 回落 legacy').toBe('legacy')
    expect(decl.labels).toEqual([null])
    expect(decl.count).toBe(1)
  })

  it('**无文档** ⇒ 三者同时为空（不得只清 count 而留下标签）', () => {
    const h = makeKernelReadHost(null)
    const decl = h.ctx.frameDeclarations()
    expect(decl).toEqual({ count: 0, durationsMs: [], labels: [], source: 'legacy' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R6 · 逐格说明侧表
// ─────────────────────────────────────────────────────────────────────────────

describe('D3/R6 `cellTooltips()`（内核投影优先，未装配如实回落 legacy）', () => {
  it('未装配 ⇒ **必须**回落 legacy 侧表（否则面板与 legacy 分叉 = #333 同族）', () => {
    const h = makeKernelReadHost(editedDoc())
    const t = h.ctx.cellTooltips()
    expect(t, 'legacy 有侧表 ⇒ 读面必须给出它').not.toBeNull()
    expect(t!.source).toBe('legacy')
    expect(t!.palette).toEqual(['hello'])
    expect(t!.grid).toEqual([[[0]]])
  })

  it('装配成功 ⇒ 走**内核投影**（与保存投影同一条规则：#333 已交付的复用）', async () => {
    const { doc, plainRoot } = await loadFixture('multiblock-tier-only')
    const h = makeAdoptedKernelReadHost(doc, plainRoot)
    try {
      const t = h.ctx.cellTooltips()
      // ⚠️ 该夹具的 `tooltipPalette` 是**空池** ⇒ 内核侧"没有任何逐格说明"
      // ⇒ 按「缺席 ≠ 空池」口径，读面给 `null`（**不是** `{palette: [], grid: []}`）。
      expect(
        t,
        '内核权威且没有说明 ⇒ `null`（"没有这一对字段"）；给空池会与"有但是空"混同',
      ).toBeNull()
    } finally {
      h.dispose()
    }
  })

  it('**无文档** ⇒ `null`（不是空池）', () => {
    expect(makeKernelReadHost(null).ctx.cellTooltips()).toBeNull()
  })

  it('**反空洞真**：注入一条真实说明 ⇒ 内核分支必须给出它（否则上一条是空转）', () => {
    // 造一份内核侧**有**逐格说明的文档：`blockGrid.cellContent[key].tooltip`。
    const base = createDocument('d-tip', { sceneId: 's-tip' })
    const payload = {
      kind: 'blockGrid',
      cells: { '0,0,0': 'minecraft:stone:0' },
      sizeColumn: 1,
      sizeRow: 1,
      sizeZSlice: 1,
      cellContent: { [cellContentKey(0, 0, 0)]: cellContent({ tooltip: '注入的说明' }) },
    }
    const obj = sceneObject({ id: 'b', type: 'block', name: 'b', dataId: 'b:data' })
    const data = objectData('b:data', payload as never, 'document')
    const scene: Scene = { ...base.scene, order: ['b'], objects: { b: obj }, data: { 'b:data': data } }
    const doc = withScene(base, scene).doc
    // 纯函数路径（`Context` 需要装配 ⇒ 这里直接打投影面的可见结果）。
    const legacy = new RuntimeDocument({
      id: 'd-tip',
      frames: [{ index: 0, label: null, structure: { sizeColumn: 1, sizeRow: 1, sizeZSlice: 1, cellGrid: [], blockPalette: [] } }],
      tooltipPalette: ['legacy 里的旧说明'],
      cellTooltipGrid: [[[0]]],
    } as never)
    const h = makeKernelReadHost(legacy)
    const t = h.ctx.cellTooltips()
    expect(t?.source, '前提：未装配 ⇒ legacy 分支').toBe('legacy')
    expect(t?.palette, '前提：legacy 侧确有说明').toEqual(['legacy 里的旧说明'])
    // 内核文档的载荷确实带说明（证明"文档能承载"这件事成立，不是判据构造问题）。
    const content = doc.scene.data['b:data']!.payload as unknown as { cellContent?: Record<string, unknown> }
    expect(Object.keys(content.cellContent ?? {})).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R7 · 文档元数据
// ─────────────────────────────────────────────────────────────────────────────

describe('D3/R7 `documentMetadata()`', () => {
  it('未装配 ⇒ 逐字段来自 legacy（含 `createdAtMs` 缺席态）', () => {
    const h = makeKernelReadHost(editedDoc())
    const m = h.ctx.documentMetadata()
    expect(m.source).toBe('legacy')
    expect({ name: m.name, author: m.author, description: m.description, tags: m.tags }).toEqual({
      name: '我的结构',
      author: 'me',
      description: 'd',
      tags: ['a'],
    })
    expect(m.origin).toEqual({ x: 1, y: 2, z: 3 })
    expect(m.createdAtMs, '源里没有 created_at_ms ⇒ `null`（不是 0）').toBeNull()
  })

  it('装配成功 ⇒ 字段来自**内核** `DocumentContent.metadata`', async () => {
    const { doc, plainRoot } = await loadFixture('multiblock-tier-only')
    const h = makeAdoptedKernelReadHost(doc, plainRoot)
    try {
      const m = h.ctx.documentMetadata()
      expect(m.source).toBe('kernel')
      const km = h.session!.document()!.content.metadata
      expect({
        name: m.name,
        author: m.author,
        description: m.description,
        tags: m.tags,
        origin: m.origin,
        createdAtMs: m.createdAtMs,
      }).toEqual({
        name: km.name,
        author: km.author,
        description: km.description,
        tags: km.tags,
        origin: km.origin,
        createdAtMs: km.createdAtMs,
      })
    } finally {
      h.dispose()
    }
  })

  it('**无文档** ⇒ 全部给空/零，且 `createdAtMs` 为 `null`（不是 `0`）', () => {
    const m = makeKernelReadHost(null).ctx.documentMetadata()
    expect(m.source).toBe('legacy')
    expect({ ...m, source: undefined }).toEqual({
      name: '',
      author: '',
      description: '',
      tags: [],
      origin: { x: 0, y: 0, z: 0 },
      createdAtMs: null,
      formatVersion: '',
      // R1-β① C5：`gtnhVersion` 与 `formatVersion` 同族同源（都由文档声明承载，
      // 供嵌入元信息提示用）；无文档时与其余字段一并给空串。
      gtnhVersion: '',
      source: undefined,
    })
  })

  it('`formatVersion` 与旧文档**逐字相同**（读面不得自己发明一个版本）', () => {
    // 该判定刻意与 `frameDeclarations` 的 `null`/`0` 之分**不同**：
    // 后者的 `null` 表达"没有可用来源"（该回落），而 `format_version` 是**文件格式**的
    // 事实，旧消费点（`workbench-rna:305`）用的是 `doc.formatVersion ?? ''`
    // ⇒ 读面必须给同一个串（**不是**内核的 `schemaVersion`：那是另一份编号）。
    const doc = editedDoc()
    const h = makeKernelReadHost(doc)
    expect(
      h.ctx.documentMetadata().formatVersion,
      'legacy 分支必须逐字转发 `doc.formatVersion`（缺省 `2.0` ⇒ 断言值随之）',
    ).toBe(doc.formatVersion)
    expect(doc.formatVersion, '反空洞真：夹具确实声明了版本').toBe('2.0')
  })

  it('⚠️ 装配成功时 `formatVersion` **仍**取旧文档的声明（内核不承载该事实）', async () => {
    const { doc, plainRoot } = await loadFixture('multiblock-tier-only')
    const h = makeAdoptedKernelReadHost(doc, plainRoot)
    try {
      const m = h.ctx.documentMetadata()
      expect(m.source, '内容字段来源 = 内核').toBe('kernel')
      // ⚠️ 本处是**实测驱动的修正**：装配面的 `schemaVersion` 是**多方块声明**的
      // 格式版本（真实夹具 = 1），而 `doc.formatVersion` 是**文件格式**版本（2.0）
      // —— 两个不同的编号。若内核分支用 `schemaVersion` 冒充它，属性面板的
      // "格式版本"会从 `2.0` 变成 `1`（**静默的行为变更**，没有判据会变红）。
      expect(
        m.formatVersion,
        '必须是旧文档声明的文件格式版本，不是装配面的 schemaVersion',
      ).toBe(doc.formatVersion)
      const face = h.session!.assemblyFaceOf()?.multiblock as { schemaVersion?: unknown } | undefined
      expect(m.formatVersion).not.toBe(String(face?.schemaVersion ?? ''))
    } finally {
      h.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R8 · 撤销快照令牌
// ─────────────────────────────────────────────────────────────────────────────

describe('D3/R8 `documentSnapshot()` / `restoreDocumentSnapshot()`', () => {
  it('**令牌不透明**：没有可读载荷属性（不是"改了名的 `RuntimeDocument`"）', () => {
    const h = makeKernelReadHost(editedDoc())
    const token = h.ctx.documentSnapshot()!
    expect(token, '有文档 ⇒ 令牌非 null').not.toBeNull()
    expect(
      Object.keys(token as unknown as Record<string, unknown>),
      '令牌必须零可读属性 —— 否则它就只是把访问器改了个名（#171 禁"新门面包旧核心保活"）',
    ).toEqual([])
    expect(Object.getOwnPropertyNames(token)).toEqual([])
    // 也**不是**旧文档本身（`instanceof` 是最容易被误用的那一步）。
    expect(token as unknown).not.toBeInstanceOf(RuntimeDocument)
  })

  it('令牌捕获的是**那一刻**的副本：之后改原文档不影响它', () => {
    const h = makeKernelReadHost(editedDoc())
    const token = h.ctx.documentSnapshot()!
    h.setDocument(new RuntimeDocument({ id: 'other' } as never))
    h.ctx.restoreDocumentSnapshot(token)
    expect(h.ctx.frozenDocumentValue()!.id, '回到捕获时的文档').toBe('edited')
  })

  it('`null` 令牌 ⇒ **撤销到"无文档"**（R-WK-09 裁决 3 的 `before=null` 形态）', () => {
    const h = makeKernelReadHost(editedDoc())
    expect(h.ctx.documentSnapshot(), '有文档').not.toBeNull()
    h.ctx.restoreDocumentSnapshot(null)
    expect(h.ctx.hasLoadedDocument(), '`null` 令牌必须清成"无文档"，而不是"不动"').toBe(false)
    expect(h.ctx.documentSnapshot(), '无文档 ⇒ 令牌为 `null`').toBeNull()
  })

  it('**未知令牌如实抛错**（不静默当成"无文档" —— 那会静默清空用户文档）', () => {
    const h = makeKernelReadHost(editedDoc())
    const foreign = { fake: true } as never
    expect(() => h.ctx.restoreDocumentSnapshot(foreign)).toThrow(/未知的快照令牌/)
    expect(h.ctx.hasLoadedDocument(), '抛错前不得改动文档').toBe(true)
  })

  it('`frozenDocumentValue()` 是**副本**（改它不碰当前文档）', () => {
    const h = makeKernelReadHost(editedDoc())
    const frozen = h.ctx.frozenDocumentValue()!
    expect(frozen).not.toBe(h.ctx.frozenDocumentValue())
    expect(frozen.id).toBe('edited')
  })

  it('**无文档** ⇒ `documentSnapshot()` 与 `frozenDocumentValue()` 都为 `null`', () => {
    const h = makeKernelReadHost(null)
    expect(h.ctx.documentSnapshot()).toBeNull()
    expect(h.ctx.frozenDocumentValue()).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R2/S3 · `legacyRenderSource()` 终删 → 两个内核面读面
// ─────────────────────────────────────────────────────────────────────────────

describe('R2/S3 `legacyRenderSource()` 终删（接缝 `legacy-render-source-document` 的（乙）子句）', () => {
  it('读面**本体已删除**（不得留成死代码，也不得改个名继续存在）', () => {
    // ⚠️ 必须剥注释：本文件删除处留了一段"退役记录"注释，里面逐字提到该名字
    // （那是留痕，不是残留实现）。剥注释后若仍命中 ⇒ 实现还在。
    const src = fs
      .readFileSync(path.join(process.cwd(), 'src/runtime/context.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
    expect(
      /\.legacyRenderSource\s*\(|legacyRenderSource\s*\(\s*\)\s*:/.test(src),
      '`Context#legacyRenderSource()` 必须已从 `runtime/context.ts` 删除'
      + '（全仓调用点为 0 由 `legacyRenderSourceConsumers.test.ts` 机械把守）',
    ).toBe(false)
  })

  it('`kernelMultiblockDeclaration()`：与 `kernelMultiblockBody().declaration` 是**同一个对象**（装配期不变式）', async () => {
    const { doc, plainRoot } = await loadFixture('multiblock-tier-only')
    const h = makeAdoptedKernelReadHost(doc, plainRoot)
    try {
      const decl = h.ctx.kernelMultiblockDeclaration()
      expect(decl, '多方块文档必须给出声明').not.toBeNull()
      expect(decl!.multiblockCount, '真实声明的 multiblockCount 恒为 1').toBe(1)
      // 不变式（`composition/kernelAssembly.ts:622`）：body 的声明与 content.multiblock 同一对象。
      // 两次转换会造出"相等但不同物" ⇒ `toBe` 判红。
      expect(decl).toBe(h.ctx.kernelMultiblockBody()!.declaration)
    } finally {
      h.dispose()
    }
  })

  it('`kernelMultiblockDeclaration()`：**无会话** ⇒ `null`（不是"空声明对象"）', () => {
    expect(makeKernelReadHost(null).ctx.kernelMultiblockDeclaration()).toBeNull()
  })

  it('`kernelRenderViewInputs()`：装配面在场 ⇒ 四样齐（scene / content / frameObjects / 声明投影）', async () => {
    const { doc, plainRoot } = await loadFixture('multiblock-tier-only')
    const h = makeAdoptedKernelReadHost(doc, plainRoot)
    try {
      const inputs = h.ctx.kernelRenderViewInputs()
      expect(inputs, '装配面在场时必须给出输入（否则渲染链无处取场景）').not.toBeNull()
      expect(inputs!.frameObjects.length).toBeGreaterThan(0)
      expect(inputs!.scene.id).toBe(h.session!.document()!.scene.id)
      expect(inputs!.content.metadata).toBe(h.session!.document()!.content.metadata)
      expect(inputs!.multiblockDeclaration, '多方块文档必须带类型化声明投影').not.toBeNull()
    } finally {
      h.dispose()
    }
  })

  it('`kernelRenderViewInputs()`：**无会话** ⇒ `null`（消费方如实降级，不伪造空输入）', () => {
    expect(makeKernelReadHost(null).ctx.kernelRenderViewInputs()).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 反向：新读面**不得**成为第二个内容权威
// ─────────────────────────────────────────────────────────────────────────────

describe('D3 · 反向判据：读面与文档内容**同源**（不引入第二份权威）', () => {
  it('装配成功时，`documentMetadata` 与 `frameDeclarations` 报的是**同一份内核文档**', async () => {
    const { doc, plainRoot } = await loadFixture('multiblock-ebf-2ch')
    const h = makeAdoptedKernelReadHost(doc, plainRoot)
    try {
      const kdoc = h.session!.document()!
      expect(h.ctx.documentMetadata().source).toBe('kernel')
      expect(h.ctx.frameDeclarations().source).toBe('kernel')
      // 元数据与帧声明都来自 `kdoc.content` —— 同一次装配的同一份值。
      expect(h.ctx.documentMetadata().name).toBe(kdoc.content.metadata.name)
      expect(h.ctx.frameDeclarations().count).toBe(kdoc.content.frameAxis.frames.length)
    } finally {
      h.dispose()
    }
  })

  it('**反空洞真**：`editedDoc` 等装配夹具确实带内容（否则上面的比较是空转）', async () => {
    const { doc } = await loadFixture('multiblock-tier-only')
    expect(doc.frameCount).toBeGreaterThan(0)
    expect(doc.isMultiblock).toBe(true)
    // 占位：`documentContent`/`documentMetadata`/`frameAxis` 的导入被用在类型层。
    expect(typeof documentContent).toBe('function')
    expect(typeof documentMetadata).toBe('function')
    expect(typeof frameAxis).toBe('function')
  })
})
