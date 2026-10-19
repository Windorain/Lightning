/**
 * R1-β① C5 · **内核写权读面**（`Context#kernelWriteAuthority`）的生产装配判据。
 *
 * ## 这条判据保护的语义
 *
 * `editors/workbench-rna.ts#targetFacts` 要回答「这个目标是不是**生成内容** ⇒ 只读」
 * （#249 §3.3「不编辑生成结果」）。C5 之前它从 `ctx.legacyRenderSource()` 的
 * `doc.multiblock != null` 读这一位（接缝 `legacy-render-source-document` 的消费点之一）。
 * C5 之后它读**内核自己的写权事实**：
 *
 * ```
 * const gridObjectId = ctx.kernelGridObjectId(0)
 * return gridObjectId !== null && ctx.kernelWriteAuthority(gridObjectId) === 'readOnly'
 * ```
 *
 * ## 为什么必须走生产解析 + 生产装配（#301 D3 的教训）
 *
 * 语料里**出现过**这类判据的失效形态：手搓一份"已带正确字段"的载荷 ⇒ 恒绿，
 * 而生产装配**从不填该字段**。故本文件的输入一律是：
 * 生产 `detectAndParse` → 生产 `adoptLoadedDocument`（经 `makeAdoptedKernelReadHost`）。
 *
 * ## 正判据 + 负对照（缺一不成立）
 *
 * | 断言 | 抓什么 |
 * |---|---|
 * | ① 多方块夹具（`multiblock-tier-only`）⇒ `'readOnly'` | 正判据：生产装配真的把生成内容标成 `source:'content'` |
 * | ② **帧为主**夹具（`minimal-v2`）⇒ `'writable'` | **负对照**：证明该读面**有区分力**，不是恒答 `readOnly` |
 * | ③ 未装配（legacy 宿主）⇒ `'missing'` | **负对照**：不得把"读不到"伪装成 `writable`（`e2e` 里那条"静默可写"的形态） |
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { makeAdoptedKernelReadHost, makeKernelReadHost } from '@/runtime/__tests__/kernelReadTestHost'
import { RuntimeDocument } from '@/context/runtimeDocument'
import { KernelSession } from '@/runtime/kernelSession'

const MB_FIXTURE = path.join(process.cwd(), 'src', 'context', '__tests__', 'fixtures', 'multiblock-tier-only.json')
const PLAIN_FIXTURE = path.join(process.cwd(), 'e2e', 'fixtures', 'minimal-v2.json')

/** **生产**解析器注册（与 `web/src/context/parserRegistry` 的生产装配同形）。 */
function productionRegistry() {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

/** 读夹 JSON（行尾归一化 —— 铁律 6；夹具是数据，不改语义）。 */
function readJson(p: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')) as Record<string, unknown>
}

async function adoptedHostOf(fixture: string) {
  const raw = readJson(fixture)
  const parsed = await productionRegistry().detectAndParse(raw)
  expect(parsed.document, `${fixture} 必须能被**生产**解析器解析`).not.toBeNull()
  // `makeAdoptedKernelReadHost` 内部走**生产** `adoptLoadedDocument`（真装配）。
  return makeAdoptedKernelReadHost(parsed.document!, raw)
}

describe('R1-β① C5 · `Context#kernelWriteAuthority`（写权按拥有者判定，内核承载）', () => {
  it('① 正判据：多方块夹具（生产解析 + 生产装配）⇒ 帧网格对象的写权 = `readOnly`', async () => {
    const host = await adoptedHostOf(MB_FIXTURE)
    try {
      const gridObjectId = host.ctx.kernelGridObjectId(0)
      expect(gridObjectId, '生产装配必须给出第 0 帧的网格对象 id').not.toBeNull()
      expect(
        host.ctx.kernelWriteAuthority(gridObjectId!),
        '多方块生成内容的写权必须是 `readOnly`（内核 `source:\'content\'` 标记）',
      ).toBe('readOnly')
    } finally {
      host.dispose()
    }
  })

  it('② **负对照**：帧为主夹具 ⇒ `writable`（证明该读面有区分力，不是恒答 readOnly）', async () => {
    const host = await adoptedHostOf(PLAIN_FIXTURE)
    try {
      const gridObjectId = host.ctx.kernelGridObjectId(0)
      expect(gridObjectId, '帧为主夹具同样装配出 blockGrid 对象').not.toBeNull()
      expect(
        host.ctx.kernelWriteAuthority(gridObjectId!),
        '帧为主文档的网格是**文档内容**（非装配产物）⇒ 必须 `writable`；'
        + '若这里是 `readOnly`，说明判据恒真、没有区分力',
      ).toBe('writable')
    } finally {
      host.dispose()
    }
  })

  it('③ **负对照**：未装配（legacy 宿主）⇒ `missing`（不得把"读不到"伪装成可写）', async () => {
    const parsed = await productionRegistry().detectAndParse(readJson(MB_FIXTURE))
    const legacyHost = makeKernelReadHost(parsed.document as RuntimeDocument)
    expect(
      legacyHost.ctx.kernelWriteAuthority('whatever-id'),
      '未装配时不得静默答 `writable`（那会让生成内容在装配失败时变成可编辑）',
    ).toBe('missing')
    expect(legacyHost.ctx.kernelGridObjectId(0)).toBeNull()
  })

  it('④ **旧依据已退**：`workbench-rna.ts` 的生成态判定不再读旧文档的 `multiblock` 节', () => {
    const src = fs
      .readFileSync(path.join(process.cwd(), 'src', 'editors', 'workbench-rna.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
    // 先去注释再匹配：本文件**刻意**在说明段里保留历史依据的名字（"C5 之前取自 …"），
    // 那是记录而不是消费点。口径与 `legacyRenderSourceConsumers.test.ts` 同一份判据。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    expect(/\.legacyRenderSource\s*\(/.test(code), '消费点必须为 0（注释里的历史记载不算）').toBe(false)
    expect(
      /kernelWriteAuthority\s*\(/.test(code),
      '必须由内核写权读面提供该事实（否则本条是"删了旧依据却没接新依据"）',
    ).toBe(true)
  })

  it('⑤ **前置机制**：装配确实把对象数据标成 `source:\'content\'`（正判据的机制，不是巧合）', async () => {
    const raw = readJson(MB_FIXTURE)
    const parsed = await productionRegistry().detectAndParse(raw)
    const session = new KernelSession({ documentId: 'd', contextId: 'c', capabilities: [] })
    try {
      expect(
        adoptLoadedDocument({ kernel: session, log: { info: () => {}, warn: () => {} } }, parsed.document!, raw, 'p'),
        '前置：装配必须成功',
      ).toBe(true)
      const doc = session.document()
      expect(doc, '内核文档必须已建立').toBeDefined()
      let marked = false
      for (const id of doc!.scene.order) {
        const obj = doc!.scene.objects[id]
        if (obj === undefined) continue
        if (doc!.scene.data[obj.dataId]?.source === 'content') marked = true
      }
      expect(marked, '装配产物里必须存在 `source:\'content\'` 的对象数据（读面的机制前提）').toBe(true)
    } finally {
      session.dispose()
    }
  })
})
