/**
 * **R1-α 判据：工程格式接生产 —— 保存 → 重开往返保真**（#249 §12；R0-D④ 的零生产入口缺口）。
 *
 * ## 要证明什么
 *
 * | 组 | 断言 |
 * |---|---|
 * | ① 往返保真 | 真实信封经生产载入 → `composition/projectIo#projectForSave` → `decodeProjectFile` → `adoptProject` → **业务语义读面**逐项读回（网格尺寸 / 逐格说明 / 真实方块身份含命名空间 / 资源身份 / 文档元数据） |
 * | ② 版本拒绝 | 未知主版本 ⇒ `UnsupportedOperation`（**不**降级读取，`projectFormat` 文件头判据 1） |
 * | ③ 未知字段按文档身份承载 | GF-14 口径：未知顶层键不得进核心负载，也不得让整份工程被拒 |
 * | ④ 负对照 | 不 `adoptProject` 就比对 ⇒ 业务语义**不得**等于原读数（证明 ① 不是恒真） |
 * | ⑤ 未装配显式失败 | `projectForSave` 在未装配时**不**回落旧文档（那正是第二权威的入口） |
 *
 * ## 为什么打 `composition/projectIo` 而**不是** `Context`
 *
 * R1-α 第一版把这三个入口加在 `Context` 上，架构闸门**当场判红**：
 * `runtime/context.ts` 是**待清算**的旧层文件（多条接缝指着它），
 * 从它 import `adapters/files/projectFormat`/`domain/errors`/`domain/editing`
 * 产生了三条**新的旧层→内核边**。判红是对的 —— 把新能力加进正在退场的宿主
 * 就是 #171 禁止的"新门面包旧核心保活"。
 * ⇒ 落点改为 `composition/projectIo`（与 `composition/documentLoad` 同层同性质：
 * 那是装载脊柱的接线，这是工程往返的接线）。本文件打的就是**生产实现本体**。
 *
 * ## 定级（**不拔高**）
 *
 * 本文件是 **kernel + 适配器 + 装配层**验证。生产 UI 入口（File 菜单两项 +
 * 两个算子入注册表）已接线，但生产**输入口**仍是 legacy 转发
 * （`workbench/inputHotkeys.ts` 的 `workbenchCommandSink`）；端口切换属 β 批。
 * ⇒ 本文件**不**声称"UI 上点一下就能跑通"。
 */

import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_CAPABILITIES } from '@/application/commands'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { adoptProject, decodeProjectFile, projectForSave, type ProjectHost } from '@/composition/projectIo'
import { plainRootOf } from '@/adapters/plainRoot'
import { kernelGridOf } from '@/runtime/gridRead'
import { findObject, findObjectData } from '@/domain/scene'
import type { ObjectDataPayload } from '@/domain/scene'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { blockPaletteEntryKey } from '@/domain/blockGeometry'

type Plain = Record<string, unknown>
const NOOP_LOG = { info: () => {}, warn: () => {} }

function productionParsers() {
  const p = createParserRegistry()
  p.register(V2PlainParser)
  p.register(createEnvelopeParser(p))
  p.register(WorldParser)
  p.register(StructureDataParser)
  return p
}

function envelopeRaw(): Plain {
  const abs = path.join(process.cwd(), 'e2e', 'fixtures', 'structuredata-exported-envelope.json')
  return JSON.parse(fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')) as Plain
}

/** 生产宿主面：只给接线真正需要的两件事（`setDocument` 换旧格式载体）。 */
function hostOf(session: KernelSession, sink: { doc: RuntimeDocument | null }): ProjectHost {
  return {
    kernel: session,
    setDocument(next: RuntimeDocument | null): void {
      sink.doc = next
    },
  }
}

/** 生产口径装载真实信封 → 内核会话（与产品路径同一份代码）。 */
async function loadRealEnvelope(): Promise<{
  session: KernelSession
  host: ProjectHost
  sink: { doc: RuntimeDocument | null }
}> {
  const raw = envelopeRaw()
  const parsed = await productionParsers().detectAndParse(raw)
  if (parsed.document === null || parsed.document === undefined) throw new Error('真实信封解析失败')
  const session = new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: ALL_CAPABILITIES,
  })
  const ok = adoptLoadedDocument({ kernel: session, log: NOOP_LOG }, parsed.document as never, plainRootOf(raw), 'envelope')
  if (!ok) throw new Error('真实信封装配失败')
  const sink = { doc: parsed.document as RuntimeDocument | null }
  return { session, host: hostOf(session, sink), sink }
}

function firstGridObjectId(session: KernelSession): string {
  const doc = session.document()
  if (doc === undefined) throw new Error('内核无文档')
  for (const id of doc.scene.order) {
    const obj = findObject(doc.scene, id)
    if (obj === undefined || obj.type !== 'block') continue
    const data = findObjectData(doc.scene, obj.dataId)
    if (data !== undefined && data.payload.kind === 'blockGrid') return id
  }
  throw new Error('真实信封里没有 blockGrid 对象')
}

function payloadOf(session: KernelSession, objectId: string): Extract<ObjectDataPayload, { kind: 'blockGrid' }> {
  const doc = session.document()!
  const obj = findObject(doc.scene, objectId)!
  return findObjectData(doc.scene, obj.dataId)!.payload as Extract<ObjectDataPayload, { kind: 'blockGrid' }>
}

/** 业务语义快照（**读面**给出的事实；用于往返逐项对照）。 */
function businessSnapshot(session: KernelSession): {
  size: number[]
  tooltips: [string, string][]
  identities: [string, string][]
  resources: string[]
  metadataName: string
  /** ⚠️ **内容本体**（不是身份列表）：逐资源的字节摘要 / 呈现参数 / 纹理序列规格。 */
  resourceBodies: string[]
  /** 全部资源字节的 sha256（一个标量覆盖所有字节）。 */
  payloadDigest: string
  /** 帧时长轴的逐帧声明（`index` + `label`）—— R1-α 实测曾整体丢失。 */
  frameAxis: (string | null)[][]
  /** 逐帧 `durationMs` —— 同上。 */
  frameDurations: (number | null)[]
  /** 文档元数据（具名字段全量，不只是 `name`）。 */
  metadata: string
} {
  const objectId = firstGridObjectId(session)
  const p = payloadOf(session, objectId)
  const grid = kernelGridOf(session.document(), 0)!
  const tooltips: [string, string][] = []
  const identities: [string, string][] = []
  for (const key of Object.keys(p.cells).sort()) {
    const [x, y, z] = key.split(',').map(Number)
    const t = grid.tooltipAt({ x: x!, y: y!, z: z! })
    if (typeof t === 'string' && t.length > 0) tooltips.push([key, t])
    // 真实身份经**条目内容键**（`cellPalette`）→ `palette` 表取，与 `gridRead`
    // 的口径同一套（**不**经 GF-7 的 `cells` 编码 —— 那个丢命名空间）。
    const entryKey = p.cellPalette?.[key]
    const rid =
      entryKey === undefined ? undefined : p.palette?.find((e) => blockPaletteEntryKey(e) === entryKey)?.registryId
    if (typeof rid === 'string' && rid !== '' && rid !== 'air') identities.push([key, rid])
  }
  const doc = session.document()!
  const content = doc.content
  // ── **内容本体**（R1-α 复核打回 1 的落点）──────────────────────────────────
  // 只比 `assetId@contentVersion`（身份列表）**看不见**这次丢失的形态：
  // 实测当时是「资源清单 62 条而 `resources === []`」—— 身份列表为空，
  // 而清单摘要判据仍说"保住了"。⇒ 逐资源钉住**字节**（长度 + sha256）、
  // 呈现参数（`blend`/`emissive`）、纹理序列规格、图集归属，并单独钉住帧时长轴。
  const resourceBodies = content.resources.map((r) =>
    [
      r.ref.assetId,
      r.ref.contentVersion,
      r.kind,
      r.payload === null ? 'payload=null' : `payload=${r.payload.replace(/\r\n/g, '\n').length}:${sha256(r.payload)}`,
      `blend=${r.blend}`,
      `emissive=${r.emissive}`,
      `atlas=${r.atlas}`,
      `linear=${r.linear}`,
      `useMipmaps=${r.useMipmaps}`,
      `anim=${r.animation === null ? 'null' : canonicalText(r.animation)}`,
    ].join('|'),
  )
  const payloadDigest = sha256(
    content.resources.map((r) => (r.payload === null ? '\u0000null' : r.payload.replace(/\r\n/g, '\n'))).join('\u0001'),
  )
  const frames = content.frameAxis.frames
  return {
    size: [p.sizeColumn ?? -1, p.sizeRow ?? -1, p.sizeZSlice ?? -1],
    tooltips: tooltips.sort(),
    identities: identities.sort(),
    resources: content.resources.map((r) => `${r.ref.assetId}@${r.ref.contentVersion}`).sort(),
    metadataName: content.metadata.name,
    resourceBodies: resourceBodies.sort(),
    payloadDigest,
    frameAxis: frames.map((f) => [String(f.index), f.label] as (string | null)[]),
    frameDurations: frames.map((f) => f.durationMs),
    metadata: canonicalText(content.metadata),
  }
}

/** 键序无关的规范化文本（比较**结构化内容的值**；不用于源码文本的字节断言）。 */
function canonicalText(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort)
    if (x !== null && typeof x === 'object') {
      const o = x as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = sort(o[k])
      return out
    }
    return x
  }
  return JSON.stringify(sort(v))
}

/** sha256 十六进制。调用方已归一化行尾（铁律 6：字节级断言先归一化再算）。 */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

describe('R1-α ④ 工程格式接生产：保存 → 重开往返保真（真实信封 + 生产装配）', () => {
  it('工程往返：`projectForSave` → `decodeProjectFile` → `adoptProject` 后业务语义逐项读回', async () => {
    const { session, host } = await loadRealEnvelope()
    const before = businessSnapshot(session)

    const encoded = projectForSave(host)
    expect(encoded.ok, '内核已装配 ⇒ 工程保存必须成功').toBe(true)
    if (!encoded.ok) return
    const projectFile = encoded.value
    expect(projectFile.formatVersion, '工程格式版本必须是显式主版本').toBe('1.0')
    expect(projectFile.payload.assets.length, '资源清单必须随工程往返').toBeGreaterThan(0)

    const roundTripped = JSON.parse(JSON.stringify(projectFile)) as unknown
    const decoded = decodeProjectFile(roundTripped)
    expect(decoded.ok, '自己写出的工程必须能被自己读回').toBe(true)
    if (!decoded.ok) return

    const fresh = new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: ALL_CAPABILITIES,
    })
    try {
      expect(kernelGridOf(fresh.document(), 0), '空会话不得有网格').toBeNull()
      const freshSink = { doc: null as RuntimeDocument | null }
      const adopted = adoptProject(hostOf(fresh, freshSink), decoded.value)
      expect(adopted.ok, '工程重开必须成功').toBe(true)
      const after = businessSnapshot(fresh)
      expect(after.size, '网格声明尺寸往返保真').toEqual(before.size)
      expect(after.tooltips, '逐格说明往返保真（18 个说明格）').toEqual(before.tooltips)
      expect(after.identities, '逐格真实方块身份往返保真（含命名空间）').toEqual(before.identities)
      expect(after.resources, '资源身份（assetId@contentVersion）往返保真').toEqual(before.resources)
      expect(after.metadataName, '文档元数据往返保真').toBe(before.metadataName)
      expect(after.tooltips.length, '说明格数必须与冻结读数一致').toBe(18)
      // ── **内容本体**逐项（R1-α 复核打回 1）──────────────────────────────────
      // 上一条 `resources`（身份列表）**不足以**覆盖契约 §2.7 第 2 条
      // 「内容本体必须进负载」：实测的丢失形态正是"清单 62 条而 `resources === []`"，
      // 身份列表为空而清单摘要判据仍绿。⇒ 下面四条钉住**字节与时长**。
      expect(after.resourceBodies, '逐资源内容本体（字节摘要 + blend/emissive/atlas/linear/mipmaps + 纹理序列规格）往返保真').toEqual(
        before.resourceBodies,
      )
      expect(after.payloadDigest, '全部资源字节的 sha256 往返保真').toBe(before.payloadDigest)
      expect(after.frameAxis, '帧声明（index + label）往返保真').toEqual(before.frameAxis)
      expect(after.frameDurations, '逐帧 durationMs 往返保真').toEqual(before.frameDurations)
      expect(after.metadata, '文档元数据（具名字段全量）往返保真').toBe(before.metadata)
      // **反空洞真**：本夹具必须**真的**带字节与帧轴 —— 否则上面四条是空转
      //（真实信封实测 57 条纹理 blob，且 demo 的 blob 是 base64 内嵌字节）。
      const bodies = fresh.document()!.content.resources.filter((r) => r.payload !== null)
      expect(bodies.length, '真实信封必须有内嵌字节的资源（否则"字节保真"是空转）').toBeGreaterThan(0)
      expect(before.frameDurations.length, '帧轴必须有帧（否则"时长保真"是空转）').toBeGreaterThan(0)
      expect(fresh.document()!.version.contentVersion, '还原后内容身份必须等于基线').toBe(
        fresh.document()!.saveBaseline.contentVersion,
      )
      expect(freshSink.doc, '重开必须换上 legacy 渲染载体（画面可用）').not.toBeNull()
    } finally {
      fresh.dispose()
    }
    session.dispose()
  })

  it('未知主版本 ⇒ `UnsupportedOperation`（**不**降级读取）', async () => {
    const { session, host } = await loadRealEnvelope()
    try {
      const encoded = projectForSave(host)
      expect(encoded.ok).toBe(true)
      if (!encoded.ok) return
      const tampered = JSON.parse(JSON.stringify(encoded.value)) as Plain
      tampered.formatVersion = '99.0'
      const decoded = decodeProjectFile(tampered)
      expect(decoded.ok, '未知主版本必须拒绝').toBe(false)
      if (decoded.ok) return
      expect(decoded.error.code, '能力不存在 ⇒ UnsupportedOperation（契约 §3.2）').toBe('UnsupportedOperation')
      expect(decoded.error.params?.reason).toBe('projectFormatVersionUnsupported')
    } finally {
      session.dispose()
    }
  })

  it('未知字段按**文档身份**承载（GF-14 口径）：不进核心、也不让整份被拒', async () => {
    const { session, host } = await loadRealEnvelope()
    try {
      const encoded = projectForSave(host)
      expect(encoded.ok).toBe(true)
      if (!encoded.ok) return
      const withUnknown = JSON.parse(JSON.stringify(encoded.value)) as Plain
      withUnknown.futureField = { hello: 'world' }
      const decoded = decodeProjectFile(withUnknown)
      expect(decoded.ok, '未知顶层键不得导致整份工程被拒（加宽兼容）').toBe(true)
      if (!decoded.ok) return
      const payload = decoded.value.payload as unknown as Record<string, unknown>
      expect(payload.futureField, '未知键不得进核心负载').toBeUndefined()
      // 它**也不得**被静默丢弃：保真记录面（`adapters/files/fidelityRecord`，
      // 按**文档身份**承载）是它的落点 —— 本判据只钉"不进核心 + 不报错"，
      // 保真记录的完整往返由 `plainEnvelopeFidelity.test.ts` 的既有判据把守。
    } finally {
      session.dispose()
    }
  })

  it('**负对照**：不 `adoptProject` ⇒ 业务语义**不得**等于原文档读数（证明 ① 有区分力）', async () => {
    const { session, host } = await loadRealEnvelope()
    try {
      const before = businessSnapshot(session)
      const encoded = projectForSave(host)
      expect(encoded.ok).toBe(true)
      if (!encoded.ok) return
      const empty = new KernelSession({
        documentId: KERNEL_DOCUMENT_ID,
        contextId: KERNEL_CONTEXT_ID,
        capabilities: ALL_CAPABILITIES,
      })
      try {
        expect(kernelGridOf(empty.document(), 0), '空会话必须没有网格').toBeNull()
        const decoded = decodeProjectFile(JSON.parse(JSON.stringify(encoded.value)))
        expect(decoded.ok).toBe(true)
        if (!decoded.ok) return
        const sink = { doc: null as RuntimeDocument | null }
        expect(adoptProject(hostOf(empty, sink), decoded.value).ok).toBe(true)
        expect(kernelGridOf(empty.document(), 0), '重开后必须有网格').not.toBeNull()
        expect(businessSnapshot(empty).tooltips, '重开后逐格说明必须等于原读数').toEqual(before.tooltips)
      } finally {
        empty.dispose()
      }
    } finally {
      session.dispose()
    }
  })

  it('未装配内核 ⇒ `projectForSave` 显式失败（**不**用旧文档填工程负载）', async () => {
    const bare = new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: ALL_CAPABILITIES,
    })
    try {
      const r = projectForSave(hostOf(bare, { doc: null }))
      expect(r.ok, '未装配 ⇒ 必须失败，不得回落旧文档').toBe(false)
      if (r.ok) return
      expect(r.error.code).toBe('UnsupportedOperation')
      expect(r.error.params?.reason).toBe('kernelNotAdopted')
    } finally {
      bare.dispose()
    }
  })
})
