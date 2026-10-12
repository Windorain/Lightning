/**
 * **D1（#289 P10d）· 两条加载脊柱的内核装配等价性** —— 本批的独立验收点。
 *
 * ## 本文件证什么（为什么它是本工程收官阶段最重要的一条）
 *
 * 侦察实测（本批）：内核文档**只在文件选择器路径被填充**。
 *
 * | 入口 | 装配内核？ | 位置 |
 * |---|---|---|
 * | `OpenSceneOperator`（文件选择器） | ✅ | `operators/builtin/docLifecycleOperators` |
 * | `DocumentSource`（**wiki-data** / SDE / 本地抽屉） | ❌ **从不** | `workbench/document/pipeline.ts` |
 *
 * ⇒ 而 `DocumentSource` 正是 **wiki-data（最高价值路径）**、SDE 导出、本地文件抽屉的入口。
 * 不统一则任何"改读内核"的迁移会在 wiki-data 路径上读到**空内核文档** ——
 * 那是**静默能力回退**（页面照常渲染，因为旧路径兜底），不是可见的失败。
 *
 * ## 判据的形状：**语义等价**，不是"两处都调了同一个函数"
 *
 * 只断言"两处都 import 了 `adoptLoadedDocument`"是**结构**判据，不能证明**语义**等价：
 * 比如一处传 `plainRootOf(raw)`、另一处传 `undefined`，结构断言照样绿，
 * 而元数据一边丢一边不丢。
 *
 * 故本文件断言：同一份真实夹具经两条路径装配后，内核**场景投影**
 * （对象集 / 数据载荷 / 内容三块）与**载荷内容摘要**逐字段相同。
 *
 * ## 两条脊柱在这里是**独立复刻**的调用序列
 *
 * 本文件不调用 `documentLoadPipeline`（那需要整个 `Context`），而是复刻它的**调用序列**
 * —— 并同时断言生产源码里那条序列**确实存在**（见最后一组）。
 * 两半缺一不可：调用序列等价证明"语义对"，源码断言证明"生产真的那样写"。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { plainRootOf } from '@/adapters/plainRoot'
import { KernelSession, KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID } from '@/runtime/kernelSession'
import { ALL_CAPABILITIES } from '@/application/commands'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'
import { digestOf } from '@/domain/identity'
import type { RuntimeDocument } from '@/context/runtimeDocument'

/** 与宿主同序的生产解析器注册（见 `runtime/host/workbenchHost`）。 */
function productionParsers() {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

/** 收集日志的假 ctx（两条路径的装配只需 `kernel` + `log`）。 */
function ctxOf(session: KernelSession) {
  const logs: { scope: string; message: string; detail?: unknown }[] = []
  return {
    logs,
    ctx: {
      kernel: session,
      log: {
        info: (scope: string, message: string, detail?: unknown) => logs.push({ scope, message, detail }),
        warn: (scope: string, message: string, detail?: unknown) => logs.push({ scope, message, detail }),
      },
    },
  }
}

function newSession(): KernelSession {
  return new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: ALL_CAPABILITIES,
  })
}

/**
 * `detectAndParse` 是 async；本文件全部夹具在本地，故用 await 串起来。
 * 刻意**不**共享解析结果：两条脊柱各自独立解析，否则测到的是缓存。
 */
async function parse(raw: unknown): Promise<RuntimeDocument> {
  const result = await productionParsers().detectAndParse(raw)
  expect(result.document, '夹具应能被生产解析器解析').not.toBeNull()
  return result.document!
}

/** **脊柱 A**：文件选择器路径（`docLifecycleOperators` 的 `OpenSceneOperator` 序列）。 */
async function spineFileDialog(raw: unknown, name: string, opts: { omitPlainRoot?: boolean } = {}) {
  const session = newSession()
  const { ctx, logs } = ctxOf(session)
  const doc = await parse(raw)
  session.seekFrame(0)
  adoptLoadedDocument(ctx, doc, opts.omitPlainRoot ? undefined : plainRootOf(raw), name)
  return { session, logs }
}

/** **脊柱 B**：`DocumentSource` 路径（`workbench/document/pipeline` 的 `documentLoadPipeline` 序列）。 */
async function spineDocumentSource(raw: unknown, locator: string, opts: { omitPlainRoot?: boolean } = {}) {
  const session = newSession()
  const { ctx, logs } = ctxOf(session)
  const doc = await parse(raw)
  session.seekFrame(0)
  adoptLoadedDocument(ctx, doc, opts.omitPlainRoot ? undefined : plainRootOf(raw), locator)
  return { session, logs }
}

/** 场景的**可序列化投影**（对象集 + 数据 + 内容三块 + 载荷内容摘要）。 */
function sceneProjectionOf(session: KernelSession) {
  const doc = session.document()
  if (doc === undefined) return null
  const objects = Object.entries(doc.scene.objects)
    .map(([id, o]) => ({
      id,
      type: o.type,
      name: o.name,
      dataId: o.dataId,
      visible: o.visible,
      transform: o.transform,
      parentId: o.parentId ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const data = Object.entries(doc.scene.data)
    .map(([id, d]) => ({
      id,
      source: d.source,
      kind: d.payload.kind,
      contentVersion: d.contentVersion,
      topologyVersion: d.topologyVersion,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return {
    objectCount: objects.length,
    dataCount: data.length,
    objects,
    data,
    meta: doc.content.metadata,
    frameCount: doc.content.frameAxis.frames.length,
    resources: doc.content.resources
      .map((r) => ({ assetId: r.ref.assetId, kind: r.kind }))
      .sort((a, b) => a.assetId.localeCompare(b.assetId)),
    /** 全部载荷的**内容摘要**（`digestOf` 键序稳定）——"装进内核的是什么"的机械指纹。 */
    payloadDigest: digestOf(
      Object.fromEntries(Object.entries(doc.scene.data).map(([k, v]) => [k, v.payload])),
    ),
  }
}

const FIXTURES = [
  { name: 'multiblock-tier-only', label: '多方块为主' },
  { name: 'multiblock-ebf-2ch', label: '多方块为主（多通道）' },
] as const

/** 帧为主真实信封（在 `e2e/fixtures/`，不在 `context/__tests__/fixtures/`）。 */
const ENVELOPE_FIXTURE = path.join(process.cwd(), 'e2e', 'fixtures', 'structuredata-exported-envelope.json')

describe('D1 · 两条加载脊柱装配出**等价**的内核文档', () => {
  for (const f of FIXTURES) {
    it(`${f.name}（${f.label}）：文件选择器路径 ≡ DocumentSource 路径`, async () => {
      const raw = readJson(fixturePath(f.name)) as Record<string, unknown>
      const a = await spineFileDialog(raw, f.name)
      const b = await spineDocumentSource(raw, f.name)
      const pa = sceneProjectionOf(a.session)
      const pb = sceneProjectionOf(b.session)
      expect(pa, '脊柱 A 必须装配出内核文档').not.toBeNull()
      expect(pb, '脊柱 B 必须装配出内核文档（此前它从不装配）').not.toBeNull()
      // 反空洞真：场景必须真的有对象（否则"两条都是空"也算等价）
      expect(pa!.objectCount, `${f.name} 必须装配出真实对象（否则等价是 0=0 的空洞真）`).toBeGreaterThan(0)
      expect(pa, `${f.name}：两条脊柱的装配产物必须逐字段相同`).toEqual(pb)
      console.log(
        `[D1] ${f.name}: 对象 ${pa!.objectCount} / 载荷 ${pa!.dataCount} / ` +
          `资源 ${pa!.resources.length} / 载荷摘要 ${pa!.payloadDigest} —— 两脊柱一致`,
      )
    })
  }
})

describe('D1 · 帧为主真实信封（几何"无处可逃"的形态）也两脊柱等价', () => {
  it('structuredata-exported-envelope：文件选择器路径 ≡ DocumentSource 路径', async () => {
    const raw = JSON.parse(
      fs.readFileSync(ENVELOPE_FIXTURE, 'utf8').replace(/\r\n/g, '\n'),
    ) as Record<string, unknown>
    const a = await spineFileDialog(raw, 'envelope')
    const b = await spineDocumentSource(raw, 'envelope')
    const pa = sceneProjectionOf(a.session)
    const pb = sceneProjectionOf(b.session)
    expect(pa, '脊柱 A 必须装配出内核文档').not.toBeNull()
    expect(pa!.objectCount, '真实信封必须装配出真实对象').toBeGreaterThan(0)
    expect(pa, '真实信封：两条脊柱的装配产物必须逐字段相同').toEqual(pb)
    console.log(
      `[D1] envelope: 对象 ${pa!.objectCount} / 载荷 ${pa!.dataCount} / ` +
        `资源 ${pa!.resources.length} / 载荷摘要 ${pa!.payloadDigest} —— 两脊柱一致`,
    )
  })
})

describe('D1 · 反空洞真与负对照', () => {
  it('**装配确定性**：同一份文件两次装配 ⇒ 同一份内核内容身份（本批实测抓出的缺陷）', async () => {
    // ## 这条钉住本批实测抓出的一个**真实缺陷**
    //
    // `RuntimeDocument.fromV2Plain` 在 `raw.meta` 缺席时**伪造** meta，含
    // `created_at_ms: Date.now()`（`context/runtimeDocument.ts:389`）。
    // 而信封类文档的 meta 被解包器摊平到 plain 根 ⇒ "文件没声明创建时间"
    // 变成"刚刚创建"，且 `documentMetadata` **进内容身份**。
    //
    // 后果：同一份文件两次装配得到**不同的内核内容** ⇒
    // "同一份文件 ⇒ 同一份内容身份"被破坏（缓存/脏标记/保真往返建在一个会变的数字上）。
    //
    // 修法在装配层（`metadataFromLegacy` 的 `declaredCreatedAtMs`）：读**源声明**，
    // 源没有就 `null`（如实缺席），不读旧解析器的伪造值。
    const raw = readJson(fixturePath('multiblock-tier-only')) as Record<string, unknown>
    const a = await spineFileDialog(raw, 'first')
    const b = await spineFileDialog(raw, 'second')
    const pa = sceneProjectionOf(a.session)!
    const pb = sceneProjectionOf(b.session)!
    expect(pa.meta, '两次装配的元数据必须逐字段相同（含 createdAtMs）').toEqual(pb.meta)
    expect(pa.payloadDigest, '两次装配的载荷摘要必须相同').toBe(pb.payloadDigest)
    // 反空洞真：该夹具**确实**没有声明创建时间（否则这条判据测不到伪造值）
    expect(pa.meta.createdAtMs, '该夹具未声明 created_at_ms ⇒ 必须是 null（缺席），不是 Date.now()').toBeNull()
  })

  it('**负对照**：脊柱 B 不传 `plainRoot` ⇒ 元数据**必然**不同（证明上一条不是恒真）', async () => {
    const raw = readJson(fixturePath('multiblock-tier-only')) as Record<string, unknown>
    const a = await spineFileDialog(raw, 'A')
    const b = await spineDocumentSource(raw, 'B', { omitPlainRoot: true })
    const pa = sceneProjectionOf(a.session)!
    const pb = sceneProjectionOf(b.session)!
    // 根级 `label` 只在 plain 里（`RuntimeDocument` 有损，见 `plainRootOf` 的说明），
    // 故丢 plainRoot 会让元数据不同 ⇒ 投影**必须**判出差异。
    expect(pa.meta, '丢 plainRoot 后元数据必须不同（否则"等价"判据无意义）').not.toEqual(pb.meta)
  })

  it('**反空洞真**：`plainRootOf` 对信封给 Plain 形、对裸明文原样返回', () => {
    const envelope = readJson(fixturePath('multiblock-tier-only')) as Record<string, unknown>
    const plain = plainRootOf(envelope)
    expect(plain, '信封解包必须产出 plain').toBeDefined()
    expect(plain!.documentFormat, '解包后必须是 Plain 形（否则"下载 Plain"仍带 Envelope）').toBe('Plain')
    expect(plainRootOf(plain), '裸明文输入**就是** plain，必须原样返回').toBe(plain)
    expect(plainRootOf(null), '非对象输入 ⇒ undefined（调用方据此如实降级）').toBeUndefined()
    expect(plainRootOf([1, 2]), '数组输入 ⇒ undefined').toBeUndefined()
  })

  it('无会话时**不装配也不抛错**（如实降级：那是配置事实，不是缺陷）', async () => {
    const raw = readJson(fixturePath('multiblock-tier-only')) as Record<string, unknown>
    const doc = await parse(raw)
    const logs: unknown[] = []
    const ok = adoptLoadedDocument(
      { kernel: null, log: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a) } },
      doc,
      plainRootOf(raw),
      'no-session',
    )
    expect(ok, '无会话 ⇒ 返回 false（未装配）').toBe(false)
    expect(logs.length, '无会话不是缺陷 ⇒ 不该产生任何日志（含警告）').toBe(0)
  })
})

/**
 * ## 第二半：**生产源码里那条序列确实存在**
 *
 * 上面证明了"两条脊柱的调用序列语义等价"。本组证明**生产真的那样写** ——
 * 两半缺一不可，否则等价性只是本文件自己构造出来的。
 */
describe('D1 · 生产源码断言：两条脊柱都装配内核', () => {
  const SRC = path.join(process.cwd(), 'src')

  /** 读源码并归一化行尾（铁律 6：本仓新鲜检出是 CRLF）。 */
  function readSource(rel: string): string {
    return fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
  }

  it('`DocumentSource` 路径（wiki-data 入口）调 `adoptLoadedDocument` 且传 `plainRootOf`', () => {
    const src = readSource('workbench/document/pipeline.ts')
    expect(src, 'wiki-data 路径必须装配内核（本批修的就是这一条）').toContain('adoptLoadedDocument(')
    expect(src, '必须传**无损**源（plainRootOf(loadResult.raw)），否则根级元数据静默丢失').toContain(
      'plainRootOf(loadResult.raw)',
    )
    expect(src, '不得用有损的 `serialize()` 当装配输入').not.toMatch(/adoptLoadedDocument\([^)]*serialize\(\)/)
  })

  it('文件选择器路径同样调 `adoptLoadedDocument`（两条**同一份**判据）', () => {
    const src = readSource('operators/builtin/docLifecycleOperators.ts')
    expect(src, '文件选择器路径的装配必须转发到共用判据').toContain('adoptLoadedDocument(')
    expect(src, '不得再私有第二份信封解包（判据重复必然漂移）').not.toContain('normalizeEnvelopeToPlain')
  })

  it('装配层不承担外壳职责（它只装配与投递）', () => {
    // 剥注释后再查：本模块的**散文**里会提到 `replaceDoc`（说明它替代了什么），
    // "提到某函数名"不等于"调用它" —— 与 G-6 判据的 `codeOnly` 同一把尺子。
    const src = readSource('composition/documentLoad.ts')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
    for (const forbidden of [
      'replaceDoc',
      'setWorkspaceMode',
      'pushRecentStructure',
      'resetAllViewportCameras',
      'getEditHistory',
      'confirmDirty',
    ]) {
      expect(src.includes(forbidden), `装配层不得承担外壳职责：${forbidden}`).toBe(false)
    }
  })
})
