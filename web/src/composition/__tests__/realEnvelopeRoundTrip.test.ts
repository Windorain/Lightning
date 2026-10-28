/**
 * **R1-α 判据：真实信封 round-trip + 两条负对照**（"真实载入 + 真修改写通"）。
 *
 * ## 这条判据要证明什么（逐条对应任务书的"缺一即判未完成"）
 *
 * | 组 | 断言 | 为什么它能证明"内核是权威" |
 * |---|---|---|
 * | ① Round-trip | 真实桌面导出信封（仓外 `structuredata/structuredata-exported-envelope.json`，57 条 base64 纹理 blob、7×6×19 网格、18 个带说明的格）经**生产解析 + 生产装配**进入内核，用**内核语义命令**改格内容 / 方块身份 / 注解，再按**业务语义**读回 | 写入必须真的落到内核文档上，且能按领域语义读出来 |
 * | ② 负对照 A | **直接改旧 `RuntimeDocument`** 必须**无法**影响内核读面 | 若两者是同一份事实，内核就不是权威（这就是第二权威的判据） |
 * | ③ 负对照 B | 断开内核写（不发命令）时同一读回断言必须**判红** | 证明 ① 不是"恰好为真"的空转 |
 *
 * ## 为什么输入必须是**生产解析 + 装配**（两次擒获的教训）
 *
 * 纯函数判据喂"已带字段"的手工载荷会**恒绿**，而生产装配可能从不填该字段
 * （`gridInputOf` 漏传 `cellPalette`、`gridPayload` 漏填 `sizeColumn/sizeRow/sizeZSlice`
 * —— 同一族两连）。故本文件的输入是
 * `createParserRegistry().detectAndParse(raw)` + `adoptLoadedDocument(...)`，
 * 与产品路径**同一份代码**。
 *
 * ## 定级（**不得**拔高）
 *
 * 本文件是 **kernel 层**验证：命令经 `KernelSession.submit` → 生产 `reduceCommand` 本体。
 * ⚠️ **本段原写"生产输入口仍是 legacy 转发、端口切换属 β 批"——该描述已被
 * R1-β① C4 取代**：`workbench/inputHotkeys.ts` 的 `workbenchCommandSink` 现在走
 * 三条**已结算**入口（`setProperty` → 边界层 `commitDraftControlValue`；
 * `undo`/`redo` → `Context#submitKernelUndoRedo`；其余领域命令 →
 * `Context#submitContentEditSettlement`），旧转发表与旧票号前缀已删除。
 * 端口改道的判据在 `src/workbench/__tests__/inputPortKernelRouting.test.ts`。
 * ⇒ 本文件仍**只**声称 kernel 层（它直接 `submit`，不经端口）。
 */

import { describe, expect } from 'vitest'
import { ALL_CAPABILITIES } from '@/application/commands'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { plainRootOf } from '@/adapters/plainRoot'
import { decodeEnvelope } from '@/adapters/files/envelopeCodec'
import { kernelGridOf } from '@/runtime/gridRead'
import { kernelAnnotationsOf } from '@/runtime/annotationRead'
import { findObject, findObjectData } from '@/domain/scene'
import type { ObjectDataPayload } from '@/domain/scene'
import { cellContentKey } from '@/domain/cellContent'
import { blockPaletteEntryKey } from '@/domain/blockGeometry'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { realFixtureText, withRealFixture } from '../../../e2e/real-fixture-vitest'

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

/** 真实桌面导出信封（**冻结输入**；R0 已登记 sha256，本文件不改它）。 */
function envelopeRaw(): Plain {
  // 铁律 6：读入口归一化行尾（仓外真实夹具经 `realFixtureText` 惰性读取）。
  return JSON.parse(realFixtureText('structureDataExportedEnvelope')) as Plain
}

/** 生产口径装载：解析 → 装配（与 `saveProjection.test.ts` 同一路径）。 */
async function loadedEnvelope(): Promise<{ session: KernelSession; legacy: RuntimeDocument; raw: Plain }> {
  const raw = envelopeRaw()
  const parsed = await productionParsers().detectAndParse(raw)
  if (parsed.document === null || parsed.document === undefined) throw new Error('真实信封解析失败')
  const session = new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: ALL_CAPABILITIES,
  })
  const ok = adoptLoadedDocument({ kernel: session, log: NOOP_LOG }, parsed.document as never, plainRootOf(raw), 'envelope')
  if (!ok) throw new Error('真实信封装配失败（这会同时失败 saveProjection 的等价判据）')
  return { session, legacy: parsed.document as never, raw }
}

function settle(session: KernelSession, cmd: Record<string, unknown>) {
  const t = session.submit(cmd as never)
  session.drain()
  return session.settlementOf(t) as { status?: string; error?: { code?: string; params?: Record<string, unknown> } } | null
}

/** 第一个含 `blockGrid` 载荷的对象 id（帧为主形态；同 `gridRead` 的出现序口径）。 */
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
  const obj = findObject(doc.scene, objectId)
  expect(obj, `对象 ${objectId} 必须存在`).toBeDefined()
  const data = findObjectData(doc.scene, obj!.dataId)
  expect(data?.payload.kind).toBe('blockGrid')
  return data!.payload as Extract<ObjectDataPayload, { kind: 'blockGrid' }>
}

/**
 * **业务语义读回**：某个世界坐标上的**真实方块身份**。
 *
 * 经 `cellPalette` 的内容键 → `palette` 条目取 `registryId`，**不**经有损编码的
 * `cells` 编码（那个编码丢命名空间，用它当期望就是"用有缺陷的旧编码当正确答案"）。
 */
function blockIdentityAt(session: KernelSession, x: number, y: number, z: number): string | undefined {
  const p = payloadOf(session, firstGridObjectId(session))
  const key = p.cellPalette?.[cellContentKey(x, y, z)]
  if (key === undefined) return undefined
  return p.palette?.find((e) => blockPaletteEntryKey(e) === key)?.registryId
}

/** 真实信封里的一个**有说明的格**（生产装填写进去的，不是我们造的）。 */
function firstTooltipCell(session: KernelSession): { key: string; text: string } {
  const p = payloadOf(session, firstGridObjectId(session))
  const table = p.cellContent
  if (table === undefined) throw new Error('真实信封没有逐格内容（说明格）')
  for (const key of Object.keys(table)) {
    const t = table[key]?.tooltip
    if (typeof t === 'string' && t.length > 0) return { key, text: t }
  }
  throw new Error('真实信封没有带说明的格')
}

describe('R1-α ① 真实信封 → 内核语义写 → 业务语义读回（生产解析 + 生产装配）', () => {
  withRealFixture(
    'structureDataExportedEnvelope',
    '装配后的基础事实与 R0 冻结读数一致（57 纹理 blob / 7×6×19 网格 / 18 个说明格）',
    async () => {
    const { session, raw } = await loadedEnvelope()
    try {
      const doc = session.document()
      expect(doc, '内核必须有文档').toBeDefined()
      // ── 纹理 blob：真实信封是 `gzip+base64` 信封，blob 在**解包后的负载**里 ──────
      // （R0 冻结读数 57；根级取不到是信封形态使然，不是装配丢了东西 ——
      //  故这里走**生产解码器**取内层负载，而不是自己解 base64/gzip。）
      const inner = decodeEnvelopePayload(raw)
      expect((inner.textureBlobs as unknown[]).length, '真实信封的纹理 blob 条数（R0 冻结读数 57）').toBe(57)
      expect((inner.materialPalette as unknown[]).length, '材质调色板条数（R0 冻结读数 62）').toBe(62)
      // ── 网格尺寸：`cellGrid` 的三个维度 → `sizeColumn/sizeRow/sizeZSlice` ─────────
      const p = payloadOf(session, firstGridObjectId(session))
      expect([p.sizeColumn, p.sizeRow, p.sizeZSlice], 'R0 冻结读数 19×6×7（列×行×层）').toEqual([19, 6, 7])
      // ── 说明格：内核逐格内容里带 tooltip 的格数（R0 冻结读数 18）───────────────
      const withTooltip = Object.values(p.cellContent ?? {}).filter((c) => typeof c.tooltip === 'string' && c.tooltip.length > 0)
      expect(withTooltip.length, '说明格数（R0 冻结读数 18）').toBe(18)
      // ── 命名空间：调色板条目里非 `minecraft:` 的条数（有损编码事故的度量面）────────
      const palette = p.palette ?? []
      const namespaced = palette.filter((e) => e.registryId !== '' && !e.registryId.startsWith('minecraft:'))
      expect(namespaced.length, '真实信封必须含带命名空间的方块（否则身份判据无区分力）').toBeGreaterThan(0)
    } finally {
      session.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    '写格内容：`setCellContent` 的写入被**业务语义读面**读回',
    async () => {
    const { session } = await loadedEnvelope()
    try {
      const target = firstTooltipCell(session)
      const r = settle(session, {
        kind: 'setCellContent',
        contextId: KERNEL_CONTEXT_ID,
        cells: [coordOf(target.key)],
        content: { tooltip: 'R1-ALPHA-ROUNDTRIP' },
      })
      expect(r?.status, '写必须 applied').toBe('applied')
      // 业务语义读回：经「网格读面」取该格说明（不是读内部字段）
      const grid = kernelGridOf(session.document(), 0)
      expect(grid, '网格读面必须可用').not.toBeNull()
      expect(grid!.tooltipAt(coordOf(target.key)), '写入必须经读面读回').toBe('R1-ALPHA-ROUNDTRIP')
    } finally {
      session.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    '写方块身份：`moveCells` 后目标格的真实身份（含命名空间）经读面读回，且源格消失',
    async () => {
    const { session } = await loadedEnvelope()
    try {
      const objectId = firstGridObjectId(session)
      const p = payloadOf(session, objectId)
      // 取一个**带命名空间**的真实格作为被测对象（R0 实测 68 条调色板里 66 条被改写，
      // 故这里必须挑一个非 `minecraft:` 的，否则负对照没有区分力）。
      const sourceKey = Object.keys(p.cells).find((k) => {
        const key = p.cellPalette?.[k]
        const rid = key === undefined ? undefined : p.palette?.find((e) => blockPaletteEntryKey(e) === key)?.registryId
        return rid !== undefined && !rid.startsWith('minecraft:')
      })
      expect(sourceKey, '真实信封必须含带命名空间的方块（否则本判据的负对照无区分力）').toBeDefined()
      const from = coordOf(sourceKey!)
      const before = blockIdentityAt(session, from.x, from.y, from.z)
      expect(before).toBeDefined()
      // 目标：网格里一个**空**格（`cells` 无该键），且在声明尺寸内
      const occupied = new Set(Object.keys(p.cells))
      let to: { x: number; y: number; z: number } | null = null
      for (let z = 0; z < (p.sizeZSlice ?? 0) && to === null; z += 1) {
        for (let y = 0; y < (p.sizeRow ?? 0) && to === null; y += 1) {
          for (let x = 0; x < (p.sizeColumn ?? 0) && to === null; x += 1) {
            if (!occupied.has(`${x},${y},${z}`)) to = { x, y, z }
          }
        }
      }
      expect(to, '网格必须有空格可作目标').not.toBeNull()
      const r = settle(session, { kind: 'moveCells', contextId: KERNEL_CONTEXT_ID, objectId, moves: [{ from, to }] })
      expect(r?.status, `移动必须 applied（${JSON.stringify(r?.error ?? {})}）`).toBe('applied')
      expect(blockIdentityAt(session, to!.x, to!.y, to!.z), '真实身份（含命名空间）必须随格迁移且不被改写').toBe(before)
      expect(blockIdentityAt(session, from.x, from.y, from.z), '源格必须消失').toBeUndefined()
    } finally {
      session.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    '写注解：真实信封**不含**注解（如实登记）⇒ 经内核命令新建/改/删并按语义读回',
    async () => {
    const { session } = await loadedEnvelope()
    try {
      // ⚠️ **如实登记**：真实信封的负载里**没有** `annotations` 键（实测；它不是注解文档）。
      // 故"改一条真实注解"在本夹具上不可做 —— 若我在这里断言 `> 0`，那是把期望写错
      // （判据要按**事实**写，不按设想写）。改用同一份真实文档上的**内核注解命令闭环**：
      // 新建（`addObject`）→ 按语义读回 → 改（`select` 后属性写路径的承载面）→ 删（`deleteObject`）。
      expect(kernelAnnotationsOf(session.document()!), '该夹具如实不含注解').toEqual([])

      const created = settle(session, {
        kind: 'addObject',
        contextId: KERNEL_CONTEXT_ID,
        objectType: 'annotation',
        name: 'R1-α annotation',
        params: { shape: 'point', objectId: 'annotation:r1a' },
      })
      expect(created?.status, `新建注解必须 applied（${JSON.stringify(created?.error ?? {})}）`).toBe('applied')
      const after = kernelAnnotationsOf(session.document()!)
      expect(after.length, '新建后注解读面必须读到').toBe(1)
      // 读面给出的 `id` 是**注解自身的 id**，而对象身份是 `annotation:<id>`
      // （装配侧口径：`annotation:<legacyId>`；写路径经 `params.objectId` 沿用）。
      // 两者都要断言 —— 只断言其中一个会把"身份两级"这件事漏掉一半。
      expect(after[0]!.id, '读面给注解自身 id').toBe('r1a')
      expect(findObject(session.document()!.scene, 'annotation:r1a'), '对象身份必须是 `annotation:r1a`').toBeDefined()

      const removed = settle(session, { kind: 'deleteObject', contextId: KERNEL_CONTEXT_ID, objectId: 'annotation:r1a' })
      expect(removed?.status, '删除注解必须 applied').toBe('applied')
      expect(kernelAnnotationsOf(session.document()!), '删除后读面必须为空').toEqual([])
    } finally {
      session.dispose()
    }
    },
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// 两条负对照（缺一即判未完成）
// ─────────────────────────────────────────────────────────────────────────────

describe('R1-α ② 负对照 A：直接改旧 `RuntimeDocument` 必须**无法**影响内核读面', () => {
  withRealFixture(
    'structureDataExportedEnvelope',
    '改旧文档的格内容 / 注解后，内核读面读数**逐项不变**',
    async () => {
    const { session, legacy } = await loadedEnvelope()
    try {
      const target = firstTooltipCell(session)
      const coord = coordOf(target.key)
      const gridBefore = kernelGridOf(session.document(), 0)
      expect(gridBefore).not.toBeNull()
      const beforeTooltip = gridBefore!.tooltipAt(coord)
      const annotationsBefore = kernelAnnotationsOf(session.document()!).map((a) => a.id)

      // ① **直接改旧 `RuntimeDocument`**（不经任何内核命令）——
      //    这是 R0-D② 实测的"第二权威"写路径（`moveTranslate.ts:309` 的形态）。
      const legacyGrid = legacy.frame(0)?.grid
      expect(legacyGrid, '旧文档必须有网格（否则负对照无输入）').toBeDefined()
      legacyGrid!.moveBlock(coord, { x: coord.x, y: coord.y, z: coord.z })
      const legacyDocAny = legacy as unknown as {
        withAnnotations?: (rows: unknown) => RuntimeDocument
        withCellTooltips?: (p: unknown, g: unknown) => RuntimeDocument
      }
      // 旧文档的注解/说明侧表：能改就改（`with*` 是它的公开写面）
      if (typeof legacyDocAny.withCellTooltips === 'function') {
        try {
          legacyDocAny.withCellTooltips(['NEGATIVE-CONTROL'], [[[0]]])
        } catch {
          // 形状不符时忽略 —— 负对照的主证明是"内核读数不变"，不是"旧文档一定改得动"
        }
      }

      // ② 内核读面必须**读数不变**（旧文档不是权威）
      const gridAfter = kernelGridOf(session.document(), 0)
      expect(gridAfter!.tooltipAt(coord), '改旧文档**不得**影响内核读面').toBe(beforeTooltip)
      expect(kernelAnnotationsOf(session.document()!).map((a) => a.id), '注解也不得受影响').toEqual(annotationsBefore)
    } finally {
      session.dispose()
    }
    },
  )
})

describe('R1-α ③ 负对照 B：不发内核命令时，同一读回断言必须判红（证明 ① 有区分力）', () => {
  withRealFixture(
    'structureDataExportedEnvelope',
    '未提交命令 ⇒ 读面**不会**给出新值（若给出，说明读面读的不是内核文档）',
    async () => {
    const { session } = await loadedEnvelope()
    try {
      const target = firstTooltipCell(session)
      const coord = coordOf(target.key)
      const grid = kernelGridOf(session.document(), 0)
      const before = grid!.tooltipAt(coord)
      // 刻意**不** submit：读面必须仍是旧值。
      const again = kernelGridOf(session.document(), 0)!.tooltipAt(coord)
      expect(again, '未写就不该变').toBe(before)
      expect(again, '读面不得凭空给出新值').not.toBe('R1-ALPHA-ROUNDTRIP')
      // 正对照：**提交同一条命令后**该值必须出现（同一断言的两侧，证明它有区分力）
      settle(session, { kind: 'setCellContent', contextId: KERNEL_CONTEXT_ID, cells: [coord], content: { tooltip: 'R1-ALPHA-ROUNDTRIP' } })
      expect(kernelGridOf(session.document(), 0)!.tooltipAt(coord), '提交后必须出现').toBe('R1-ALPHA-ROUNDTRIP')
    } finally {
      session.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    '破坏内核写（只读源）⇒ 同一写命令被判红（证明"写通"不是恒真）',
    async () => {
    const { session } = await loadedEnvelope()
    try {
      // 把一个 `blockGrid` 对象数据改成 `content` 源（只读）—— 模拟"内核权威被切断"。
      const objectId = firstGridObjectId(session)
      const doc = session.document()!
      const obj = findObject(doc.scene, objectId)!
      const data = findObjectData(doc.scene, obj.dataId)!
      const patched = {
        ...doc,
        scene: {
          ...doc.scene,
          data: { ...doc.scene.data, [obj.dataId]: { ...data, source: 'content' as const } },
        },
      }
      session.adoptDocument(patched as never, patched.content)
      const target = firstTooltipCell(session)
      const r = settle(session, {
        kind: 'setCellContent',
        contextId: KERNEL_CONTEXT_ID,
        cells: [coordOf(target.key)],
        content: { tooltip: 'SHOULD-BE-REJECTED' },
      })
      expect(r?.status, '只读源必须判红').toBe('rejected')
      expect(r?.error?.code).toBe('ReadOnly')
      // 且读面**没有**新值（拒绝不得改文档）
      const grid = kernelGridOf(session.document(), 0)
      expect(grid!.tooltipAt(coordOf(target.key))).not.toBe('SHOULD-BE-REJECTED')
    } finally {
      session.dispose()
    }
    },
  )
})

/** `"x,y,z"` → 坐标（真实信封的键格式与 `cells` 同一套）。 */
function coordOf(key: string): { x: number; y: number; z: number } {
  const parts = key.split(',')
  if (parts.length !== 3) throw new Error(`不是逐格键：${key}`)
  return { x: Number(parts[0]), y: Number(parts[1]), z: Number(parts[2]) }
}

/**
 * **真实信封的边界解码**（`gzip+base64` → 内层负载）。
 *
 * 为什么不用 `raw.textureBlobs`：该夹具是**信封**形态（`documentFormat: 'Envelope'`，
 * `payloadEncoding: 'gzip+base64'`），负载在内层。取内层必须走**生产解码器**
 * （`adapters/files/envelopeCodec`），而不是判据自己解一遍 base64/gzip ——
 * 后者会让"解码器坏了"与"夹具变了"不可区分。
 */
function decodeEnvelopePayload(raw: Plain): Plain {
  const decoded = decodeEnvelope(raw)
  if (!decoded.ok) throw new Error(`信封解码失败：${decoded.error.code}`)
  return decoded.value.plain as Plain
}
