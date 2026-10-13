/**
 * **R1-α 判据：工程格式接生产 —— 保存 → 重开往返保真**（#249 §12；R0-D④ 的零生产入口缺口）。
 *
 * ## 要证明什么
 *
 * | 组 | 断言 |
 * |---|---|
 * | ① 往返保真 | 真实信封经生产载入 → `Context#projectForSave()` → `decodeProject` → `Context#adoptProject()` → **业务语义读面**逐项读回（网格尺寸 / 逐格说明 / 真实方块身份含命名空间 / 资源清单 / 文档元数据） |
 * | ② 版本拒绝 | 未知主版本 ⇒ `UnsupportedOperation`（**不**降级读取，`projectFormat` 文件头判据 1） |
 * | ③ 未知字段按文档身份承载 | GF-14 口径：工程文件里的未知顶层键不得进核心，也不得静默丢弃（保真记录面） |
 * | ④ 负对照 | 不保存直接重开（空负载）必须**不**得到原文档的读数 ⇒ 证明 ① 不是恒真 |
 *
 * ## 为什么用真 `Context`（`Object.create(Context.prototype)`）
 *
 * `projectForSave`/`adoptProject` 是**生产实现本体**（不是判据复刻）。宿主只注入它们
 * 真正用到的两个字段（`main` / `kernel`）—— 这与
 * `runtime/__tests__/kernelReadTestHost.ts` 的既有手法同一口径（C′1 的教训：
 * "宿主复刻被测算法"会让注入缺陷仍全绿）。
 *
 * ## 定级
 *
 * 本文件是 **kernel + 适配器层**验证（生产解析 → 生产装配 → 生产 `Context` 方法）。
 * 生产 UI 入口（菜单项 + `OPERATOR_*_PROJECT`）已接线，但**生产输入口仍是 legacy 转发**
 * （`workbench/inputHotkeys.ts` 的 `workbenchCommandSink`）；端口切换属 β 批。
 * ⇒ 本文件**不**声称"UI 上点一下就能跑通"。
 */

import fs from 'node:fs'
import path from 'node:path'
import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import type { Ref } from 'vue'
import { ALL_CAPABILITIES } from '@/application/commands'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { Context } from '@/runtime/context'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { adoptLoadedDocument } from '@/composition/documentLoad'
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

/**
 * **真 `Context`**：只注入 `projectForSave`/`adoptProject`/`setDocument` 用到的字段。
 *
 * `setDocument` 实测只依赖 `this.kernel` 与 `this.main`（`main.replaceDoc` +
 * 两个信号 Ref）—— 见 `runtime/__tests__/kernelReadTestHost#makeFakeMain`
 * （本处与它同形，避免第二份替身实现）。
 */
function makeProjectHost(session: KernelSession): {
  ctx: Context
  docRef: Ref<RuntimeDocument | null>
  dispose: () => void
} {
  const docRef = ref<RuntimeDocument | null>(null) as unknown as Ref<RuntimeDocument | null>
  const ctx = Object.create(Context.prototype) as Context
  Object.assign(ctx as unknown as Record<string, unknown>, {
    main: {
      doc: docRef,
      contentRefreshTick: ref(0),
      documentRevision: ref(0),
      replaceDoc(next: RuntimeDocument | null): void {
        docRef.value = next
      },
      requestContentRefresh(): void {},
    },
    kernel: session,
  })
  return { ctx, docRef, dispose: () => session.dispose() }
}

/** 生产口径装载真实信封 → 内核会话（与产品路径同一份代码）。 */
async function loadRealEnvelope(): Promise<{ session: KernelSession; ctx: Context }> {
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
  const { ctx } = makeProjectHost(session)
  return { session, ctx }
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
      entryKey === undefined
        ? undefined
        : p.palette?.find((e) => blockPaletteEntryKey(e) === entryKey)?.registryId
    if (typeof rid === 'string' && rid !== '' && rid !== 'air') identities.push([key, rid])
  }
  return {
    size: [p.sizeColumn ?? -1, p.sizeRow ?? -1, p.sizeZSlice ?? -1],
    tooltips: tooltips.sort(),
    identities: identities.sort(),
    resources: session.document()!.content.resources.map((r) => `${r.ref.assetId}@${r.ref.contentVersion}`).sort(),
  }
}

describe('R1-α ④ 工程格式接生产：保存 → 重开往返保真（真实信封 + 生产装配）', () => {
  it('工程往返：`projectForSave` → `decodeProject` → `adoptProject` 后业务语义逐项读回', async () => {
    const { session, ctx } = await loadRealEnvelope()
    const before = businessSnapshot(session)

    // ① 保存工程（生产 `Context` 方法；内核 `Document` 是唯一权威）
    const encoded = ctx.projectForSave()
    expect(encoded.ok, '内核已装配 ⇒ 工程保存必须成功').toBe(true)
    if (!encoded.ok) return
    const projectFile = encoded.value
    expect(projectFile.formatVersion, '工程格式版本必须是显式主版本').toBe('1.0')
    expect(projectFile.payload.assets.length, '资源清单必须随工程往返（真实信封 62 条材质 / 57 blob）').toBeGreaterThan(0)

    // ② 经**边界解码**再进内核（与生产 `OPERATOR_OPEN_PROJECT` 同路）
    const roundTripped = JSON.parse(JSON.stringify(projectFile)) as unknown
    const decoded = ctx.decodeProjectFile(roundTripped)
    expect(decoded.ok, '自己写出的工程必须能被自己读回').toBe(true)
    if (!decoded.ok) return

    // ③ 重开：先把内核清空（证明 ④ 的重开真的重建了内容，不是读到旧状态）
    const fresh = new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: ALL_CAPABILITIES,
    })
    const { ctx: freshCtx } = makeProjectHost(fresh)
    try {
      // 空会话：读面此时**没有**网格（负对照的另一半）
      expect(kernelGridOf(fresh.document(), 0), '空会话不得有网格').toBeNull()
      const adopted = freshCtx.adoptProject(decoded.value)
      expect(adopted.ok, '工程重开必须成功').toBe(true)
      const after = businessSnapshot(fresh)
      expect(after.size, '网格声明尺寸往返保真').toEqual(before.size)
      expect(after.tooltips, '逐格说明往返保真（18 个说明格）').toEqual(before.tooltips)
      expect(after.identities, '逐格真实方块身份往返保真（含命名空间）').toEqual(before.identities)
      expect(after.resources, '资源身份（assetId@contentVersion）往返保真').toEqual(before.resources)
      expect(after.tooltips.length, '说明格数必须与冻结读数一致').toBe(18)
      // 内容权威是内核：还原出的文档必须**干净**（刚打开 = 与保存基线相同）
      expect(fresh.document()!.version.contentVersion, '还原后内容身份必须等于基线').toBe(
        fresh.document()!.saveBaseline.contentVersion,
      )
    } finally {
      fresh.dispose()
    }
    session.dispose()
  })

  it('未知主版本 ⇒ `UnsupportedOperation`（**不**降级读取）', async () => {
    const { session, ctx } = await loadRealEnvelope()
    try {
      const encoded = ctx.projectForSave()
      expect(encoded.ok).toBe(true)
      if (!encoded.ok) return
      const tampered = JSON.parse(JSON.stringify(encoded.value)) as Plain
      tampered.formatVersion = '99.0'
      const decoded = ctx.decodeProjectFile(tampered)
      expect(decoded.ok, '未知主版本必须拒绝').toBe(false)
      if (decoded.ok) return
      expect(decoded.error.code, '能力不存在 ⇒ UnsupportedOperation（契约 §3.2）').toBe('UnsupportedOperation')
      expect(decoded.error.params?.reason).toBe('projectFormatVersionUnsupported')
    } finally {
      session.dispose()
    }
  })

  it('未知字段按**文档身份**承载（GF-14 口径）：不进核心、也不静默丢弃', async () => {
    const { session, ctx } = await loadRealEnvelope()
    try {
      const encoded = ctx.projectForSave()
      expect(encoded.ok).toBe(true)
      if (!encoded.ok) return
      // 在工程文件里塞一个未知顶层键（模拟"新版本工程被旧版本读"）。
      const withUnknown = JSON.parse(JSON.stringify(encoded.value)) as Plain
      withUnknown.futureField = { hello: 'world' }
      const decoded = ctx.decodeProjectFile(withUnknown)
      expect(decoded.ok, '未知顶层键不得导致整份工程被拒（加宽兼容）').toBe(true)
      if (!decoded.ok) return
      // 核心类型里**没有**这个键的位置（`ProjectPayload` 是具名字段表，不是字段袋）。
      const payload = decoded.value.payload as unknown as Record<string, unknown>
      expect(payload.futureField, '未知键不得进核心负载').toBeUndefined()
      // 而它**也不得**被静默丢弃：保真记录面（`adapters/files/fidelityRecord`，
      // 按**文档身份**承载）是它的落点 —— 本判据只钉"不进核心 + 不报错"，
      // 保真记录的完整往返由 `plainEnvelopeFidelity.test.ts` 的既有判据把守。
    } finally {
      session.dispose()
    }
  })

  it('**负对照**：不装载就重开同一份工程 ⇒ 业务语义**不得**等于原文档读数', async () => {
    const { session, ctx } = await loadRealEnvelope()
    try {
      const before = businessSnapshot(session)
      const encoded = ctx.projectForSave()
      expect(encoded.ok).toBe(true)
      if (!encoded.ok) return
      // 空会话**不** adoptProject ⇒ 读数必须与"已重开"相反（证明 ① 的对照真有区分力）。
      const empty = new KernelSession({
        documentId: KERNEL_DOCUMENT_ID,
        contextId: KERNEL_CONTEXT_ID,
        capabilities: ALL_CAPABILITIES,
      })
      try {
        expect(kernelGridOf(empty.document(), 0), '空会话必须没有网格').toBeNull()
        // 正对照：同一份工程**经** adoptProject 后必须读回原读数。
        const decoded = ctx.decodeProjectFile(JSON.parse(JSON.stringify(encoded.value)))
        expect(decoded.ok).toBe(true)
        if (!decoded.ok) return
        const { ctx: freshCtx } = makeProjectHost(empty)
        expect(freshCtx.adoptProject(decoded.value).ok).toBe(true)
        expect(kernelGridOf(empty.document(), 0), '重开后必须有网格').not.toBeNull()
        expect(businessSnapshot(empty).tooltips, '重开后逐格说明必须等于原读数').toEqual(before.tooltips)
      } finally {
        empty.dispose()
      }
    } finally {
      session.dispose()
    }
  })
})

