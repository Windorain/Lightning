/**
 * **生产接线**：装配产物装进内核会话，且内核持有权威。
 *
 * ## 本文件证明什么（以及它与 `kernelAssembly.test.ts` 的分工）
 *
 * | 文件 | 判据面 |
 * |---|---|
 * | `kernelAssembly.test.ts` | 装配**正确性**（真实文件 → 内核 Scene 的内容） |
 * | `kernelProjection.test.ts` | 反向编码**保真**（内核 → 旧格式往返） |
 * | **本文件** | 装配产物**确实进入内核会话**，且内核**读面反映它** |
 *
 * 第三层是必要的：前两层都只证明"函数算得对"，而缺口是
 * 「**没有生产代码**把旧场景文件装配成内核 `Scene`」—— 一个只被测试调用的
 * 装配函数**仍然**是那个缺口。故本文件的判据是"内核会话**真的**持有了它"。
 *
 * ## 三条判据
 *
 * 1. **权威在内核**：`KernelSession.document()` 返回的文档带装配出的对象；
 * 2. **帧声明来自内核**：帧数/时长由内核文档的 `frameAxis` 给出（不再读旧文档）；
 * 3. **能力不回退**：`adoptDocument` 重建 `Editor` 后，能力裁剪**仍然生效**
 *    （嵌入 profile 的内容编辑命令仍被拒）—— 这是"重建实例"这个实现方式的
 *    最容易静默违反的一条。
 */

import { describe, expect, it } from 'vitest'
import { KernelSession, KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID } from '@/runtime/kernelSession'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { createDocument, withContent } from '@/domain/document'
import { createParserRegistry } from '@/context/parserRegistry'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'
import { unwrap } from '@/domain/errors'
import { ALL_CAPABILITIES, VIEWER_CAPABILITIES } from '@/application/commands'
import { frameCount, frameDurationsMs } from '@/domain/content'

async function assembledFixture(name: string) {
  const envelope = readJson(fixturePath(name)) as Record<string, unknown>
  const result = await createParserRegistry().detectAndParse(envelope)
  expect(result.document, `${name} 应能被生产解析器解析`).not.toBeNull()
  const layers = await readEnvelopeLayers(envelope as never)
  return unwrap(assembleKernelDocument({ doc: result.document!, plainRoot: layers.plain }))
}

/** 由装配产物造一个内核 `Document`（与生产接线 `adoptDocumentIntoKernel` 同一构造）。 */
function kernelDocumentOf(assembled: Awaited<ReturnType<typeof assembledFixture>>, documentId = KERNEL_DOCUMENT_ID) {
  const base = createDocument(documentId, { sceneId: assembled.scene.id, content: assembled.content })
  const withScene = withContent(base, assembled.scene, base.animation, assembled.content)
  return Object.freeze({ ...withScene.doc, saveBaseline: withScene.version })
}

describe('生产接线：装配产物进入内核会话', () => {
  it('采纳后内核会话**真的**持有装配出的对象（不是只算了一遍）', async () => {
    const assembled = await assembledFixture('multiblock-tier-only')
    const session = new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: ALL_CAPABILITIES,
    })
    // 采纳前：内核文档是 `openDocument` 造的空场景（反空洞真）
    const before = session.document()
    expect(before, '会话构造后应已有文档（openDocument）').toBeDefined()
    expect(Object.keys(before!.scene.objects).length, '前提：内核初始文档是空场景').toBe(0)

    session.adoptDocument(kernelDocumentOf(assembled), assembled.content)

    const after = session.document()
    expect(after, '采纳后内核应持有文档').toBeDefined()
    expect(
      Object.keys(after!.scene.objects).length,
      '采纳后内核文档必须持有装配出的对象（否则"装配"只是被测试调用的函数）',
    ).toBe(Object.keys(assembled.scene.objects).length)
    // 且对象 id 逐项一致（不是"数量恰好相同"）
    expect(Object.keys(after!.scene.objects).sort()).toEqual(Object.keys(assembled.scene.objects).sort())
    // 只读归属随内容一起进入内核
    expect(after!.scene.data['structure:multiblock:data']?.source, '多方块生成物的只读归属必须随装配进入内核').toBe('content')
    session.dispose()
  })

  it('内核**读面**反映装配内容（`ReadView.objects.list()` 能查到）', async () => {
    const assembled = await assembledFixture('multiblock-tier-only')
    const session = new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: ALL_CAPABILITIES,
    })
    session.adoptDocument(kernelDocumentOf(assembled), assembled.content)
    const view = session.read()
    const list = view.objects.list()
    expect(list.ok, '内核读面应可用').toBe(true)
    if (list.ok) {
      expect(list.value.length, '内核读面必须能看到装配出的对象').toBe(Object.keys(assembled.scene.objects).length)
      // 写权经读面可见（§3.3 的可观测面）
      const mb = list.value.find((o) => o.id === 'structure:multiblock')
      expect(mb, '读面应能查到多方块网格对象').toBeDefined()
      expect(mb!.authority, '读面必须报出 readOnly（生成物只读）').toBe('readOnly')
    }
    session.dispose()
  })

  it('多方块文档**没有时间轴帧**：帧轴为空，场景声明仍随内容进入内核', async () => {
    const assembled = await assembledFixture('multiblock-tier-only')
    const session = new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: ALL_CAPABILITIES,
    })
    session.adoptDocument(kernelDocumentOf(assembled), assembled.content)
    const kdoc = session.document()!
    // 帧清单 = 变体配置集合（场景），不是时间轴：内核帧轴必须为空。
    expect(frameCount(kdoc.content.frameAxis), '内核文档的帧轴必须为空（场景不是时间轴）').toBe(0)
    expect(frameDurationsMs(kdoc.content.frameAxis).length, '没有帧时长轴').toBe(0)
    expect(session.frameCount(), '会话没有可播放帧').toBe(0)
    session.seekFrame(1)
    expect(session.frameIndex(), '跳帧不生效：场景切换 ≠ 动画').toBe(0)
    // 但内容没有丢：全部场景声明仍在内核内容里（空帧轴 ≠ 丢内容）。
    expect(assembled.content.multiblock.scenes.length, '前提：夹具确实声明了多场景').toBeGreaterThan(1)
    expect(kdoc.content.multiblock.scenes.length).toBe(assembled.content.multiblock.scenes.length)
    session.dispose()
  })

  it('**能力不回退**：采纳（重建 Editor）后嵌入 profile 仍被拒内容编辑', async () => {
    const assembled = await assembledFixture('multiblock-tier-only')
    // 嵌入能力：无 content.edit / content.add / content.delete
    const session = new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: VIEWER_CAPABILITIES,
    })
    session.adoptDocument(kernelDocumentOf(assembled), assembled.content)
    // 重建 Editor 后若忘了重新注入能力，这条会失败（能力回退成全能力）
    const ticket = session.submit({
      kind: 'addObject',
      contextId: KERNEL_CONTEXT_ID,
      objectType: 'block',
    })
    session.drain()
    const outcome = session.settlementOf(ticket)
    expect(outcome, '命令应被结算').not.toBeNull()
    expect(
      outcome!.status,
      '采纳后能力裁剪必须仍然生效（否则重建 Editor 把 A15 的运行时拒绝弄丢了）',
    ).toBe('rejected')
    session.dispose()
  })

  it('**对照**：同一命令在工作台能力下成功（证明拒绝来自能力裁剪）', async () => {
    const assembled = await assembledFixture('multiblock-tier-only')
    const session = new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: ALL_CAPABILITIES,
    })
    session.adoptDocument(kernelDocumentOf(assembled), assembled.content)
    const ticket = session.submit({
      kind: 'addObject',
      contextId: KERNEL_CONTEXT_ID,
      objectType: 'block',
    })
    session.drain()
    const outcome = session.settlementOf(ticket)
    expect(outcome!.status, '工作台能力下应成功').toBe('applied')
    session.dispose()
  })
})

describe('采纳的可重复性与隔离', () => {
  it('采纳**两份不同的**文档 ⇒ 内核内容随之替换（不是累加）', async () => {
    const a = await assembledFixture('multiblock-tier-only')
    const b = await assembledFixture('multiblock-lsc-overlap')
    const session = new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: ALL_CAPABILITIES,
    })
    session.adoptDocument(kernelDocumentOf(a), a.content)
    const countA = Object.keys(session.document()!.scene.objects).length
    session.adoptDocument(kernelDocumentOf(b), b.content)
    const countB = Object.keys(session.document()!.scene.objects).length
    expect(countA, '第一份文档应有对象').toBeGreaterThan(0)
    expect(countB, '第二份文档应有对象').toBeGreaterThan(0)
    // 对象 id 应换成第二份的（"替换"而不是"两份都在"）
    expect(Object.keys(session.document()!.scene.objects).sort()).toEqual(Object.keys(b.scene.objects).sort())
    session.dispose()
  })

  it('**同页两实例**各自采纳 ⇒ 互不可见（实例隔离）', async () => {
    const a = await assembledFixture('multiblock-tier-only')
    const b = await assembledFixture('multiblock-ebf-2ch')
    const s1 = new KernelSession({ documentId: 'doc-1', contextId: 'ctx-1', capabilities: ALL_CAPABILITIES })
    const s2 = new KernelSession({ documentId: 'doc-1', contextId: 'ctx-1', capabilities: ALL_CAPABILITIES })
    s1.adoptDocument(kernelDocumentOf(a, 'doc-1'), a.content)
    s2.adoptDocument(kernelDocumentOf(b, 'doc-1'), b.content)
    // 两实例各持自己的内容（同一 documentId 也不互相污染）。
    // 以**声明身份**判隔离（帧轴对多方块文档恒空，不能再用帧数当指纹）。
    expect(s1.document()!.content.multiblock.id, '实例 1 的声明应是 tier-only 的').toBe(a.content.multiblock.id)
    expect(s2.document()!.content.multiblock.id, '实例 2 的声明应是 ebf-2ch 的').toBe(b.content.multiblock.id)
    expect(s1.document()!.content.multiblock.id).not.toBe(s2.document()!.content.multiblock.id)
    s1.dispose()
    s2.dispose()
  })

  it('采纳**同一份内容两次** ⇒ 内容身份稳定（不因重建实例而漂移）', async () => {
    const a = await assembledFixture('multiblock-tier-only')
    const session = new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: ALL_CAPABILITIES,
    })
    session.adoptDocument(kernelDocumentOf(a), a.content)
    const first = session.document()!.version.contentVersion
    session.adoptDocument(kernelDocumentOf(a), a.content)
    const second = session.document()!.version.contentVersion
    expect(second, '同一份内容两次采纳的内容身份必须相同（重放/对账前提）').toBe(first)
    session.dispose()
  })
})
