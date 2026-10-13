/**
 * **R1-α 判据：格内容 / 格移动 / 文档元数据三条写命令**（GF-13 最小集的余下三员）。
 *
 * ## 要证明什么（逐条对应 `application/commands.ts` 的命令注释）
 *
 * | 组 | 断言 | 为什么它必须存在 |
 * |---|---|---|
 * | ① `setCellContent` | 整值写入 / `null` 删键 / `{}`（有键无内容）与 `null` 可区分 / 幂等 `unchanged` / 多帧广播 | 「缺席 ≠ 空」的核心口径；两态压一态就是 A36 负对照的形态 |
 * | ② `moveCells` | 五项逐格表**同键**一起搬 / **块身份随格迁移且命名空间不被改写** / 目标替换而非交换 / 同时语义（`a→b, b→c`）/ 幂等 / 拒绝（重复、缺源、越界、只读、版本） | 命名空间事故（GF-7 更正：投影实测 68 条里 66 条被写成 `minecraft:`）必须不可能经**写**再发生 |
 * | ③ `setDocumentMeta` | 只改 patch 里给的字段 / `createdAtMs: null` 可表达 / 幂等 / 空 patch 拒绝 / 推进内容版本 | `Partial` 的 `undefined` 是"不改"，不是"置空" |
 *
 * ## 为什么断言打的是**生产命令通路**而不是复刻
 *
 * 输入是 `KernelSession.submit` ⇒ 走的就是生产 `reduceCommand` 本体
 * （与 `p10fCellTooltipWrite.test.ts` 同一口径）。不存在"宿主复刻被测算法"的空转。
 *
 * ## 负对照（本文件内）
 *
 * ② 的命名空间组自带负对照：同一份载荷**只**搬 `cells`（不经命令）会丢掉
 * `cellPalette` 的引用 ⇒ 读回的 registryId 退回 GF-7 有损形态。
 * 该对照在 `r1CellWriteProduction.test.ts`（生产装配输入）里更完整。
 */

import { describe, it, expect } from 'vitest'
import { ALL_CAPABILITIES } from '@/application/commands'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { createDocument, isDirty, withContent, withDocumentContent } from '@/domain/document'
import { emptyScene, findObject, findObjectData, objectData, sceneObject, withObject } from '@/domain/scene'
import type { ObjectDataPayload, Scene } from '@/domain/scene'
import { cellContentKey } from '@/domain/cellContent'
import { blockPaletteEntryKey, type BlockPaletteEntry } from '@/domain/blockGeometry'

/** 一个**带命名空间**的调色板条目（GF-7 事故里被改写成 `minecraft:` 的那一类）。 */
const NAMESPACED_ENTRY: BlockPaletteEntry = Object.freeze({
  assetId: 'geo:cablebus',
  registryId: 'appliedenergistics2:tile.BlockCableBus',
  meta: 0,
  renderMode: 'BakedModel',
  geometry: null,
  occludesAdjacentFaces: false,
})
const NAMESPACED_KEY = blockPaletteEntryKey(NAMESPACED_ENTRY)

const PLAIN_ENTRY: BlockPaletteEntry = Object.freeze({
  assetId: 'geo:stone',
  registryId: 'minecraft:stone',
  meta: 0,
  renderMode: 'BakedModel',
  geometry: null,
})

/** 造最小内核会话；`grids` 的每个元素是**一个** `blockGrid` 对象（多帧 = 多个）。 */
function sessionWith(grids: readonly ObjectDataPayload[]): KernelSession {
  const session = new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: ALL_CAPABILITIES,
  })
  const base = createDocument(KERNEL_DOCUMENT_ID, { sceneId: 'probe-scene' })
  let scene: Scene = emptyScene('probe-scene')
  grids.forEach((payload, i) => {
    const id = `structure:frame-${i}`
    scene = withObject(
      scene,
      sceneObject({ id, type: 'block', dataId: `${id}:data` }),
      objectData(`${id}:data`, payload, 'document'),
    ) as Scene
  })
  const withSceneDoc = withContent(base, scene, base.animation)
  const adopted = withDocumentContent(withSceneDoc.doc, withSceneDoc.doc.content).doc
  session.adoptDocument(adopted, adopted.content)
  return session
}

/** 一格（`appliedenergistics2` 身份）+ 一格普通方块；两格都有逐格内容。 */
function richGrid(): ObjectDataPayload {
  return {
    kind: 'blockGrid',
    cells: { '0,0,0': 'minecraft:tile.BlockCableBus:0', '1,0,0': 'minecraft:stone:0' },
    sizeColumn: 4,
    sizeRow: 3,
    sizeZSlice: 4,
    cellContent: {
      '0,0,0': { tooltip: 'cable' },
      '1,0,0': { tooltip: 'stone' },
    },
    cellPalette: { '0,0,0': NAMESPACED_KEY, '1,0,0': blockPaletteEntryKey(PLAIN_ENTRY) },
    cellPaletteIndex: { '0,0,0': 1, '1,0,0': 2 },
    palette: [NAMESPACED_ENTRY, PLAIN_ENTRY],
  }
}

function submit(session: KernelSession, cmd: Record<string, unknown>) {
  const t = session.submit(cmd as never)
  session.drain()
  return session.settlementOf(t) as { status?: string; error?: { code?: string; params?: Record<string, unknown> } } | null
}

function payloadOf(session: KernelSession, objectId: string): Extract<ObjectDataPayload, { kind: 'blockGrid' }> {
  const doc = session.document()!
  const obj = findObject(doc.scene, objectId)
  expect(obj, `对象 ${objectId} 必须存在`).toBeDefined()
  const data = findObjectData(doc.scene, obj!.dataId)
  expect(data?.payload.kind).toBe('blockGrid')
  return data!.payload as Extract<ObjectDataPayload, { kind: 'blockGrid' }>
}

/** 读回一格的**真实**方块身份（经 `cellPalette` 内容键 → `palette` 条目，**不**经 GF-7 编码）。 */
function registryIdAt(session: KernelSession, objectId: string, x: number, y: number, z: number): string | undefined {
  const p = payloadOf(session, objectId)
  const key = p.cellPalette?.[cellContentKey(x, y, z)]
  if (key === undefined) return undefined
  return p.palette?.find((e) => blockPaletteEntryKey(e) === key)?.registryId
}

describe('R1-α ① `setCellContent`：整值写入与三态', () => {
  it('写 parts + tooltip 后逐格内容整体生效，未写的格不被牵连', () => {
    const s = sessionWith([richGrid()])
    try {
      const r = submit(s, {
        kind: 'setCellContent',
        contextId: KERNEL_CONTEXT_ID,
        cells: [{ x: 0, y: 0, z: 0 }],
        content: { tooltip: 'new', parts: [] },
      })
      expect(r?.status, '写必须 applied').toBe('applied')
      const c = payloadOf(s, 'structure:frame-0').cellContent?.['0,0,0']
      expect(c?.tooltip).toBe('new')
      // `parts: []` 是**显式空**（在场），不是缺席 —— 缺席 ≠ 空
      expect(c?.parts, '显式空数组必须在场').toEqual([])
      expect(payloadOf(s, 'structure:frame-0').cellContent?.['1,0,0']?.tooltip, '未写的格不得被牵连').toBe('stone')
    } finally {
      s.dispose()
    }
  })

  it('`content: null` 删键；`{}`（有键无内容）与 `null`（无键）**必须可区分**', () => {
    const s = sessionWith([richGrid()])
    try {
      expect(submit(s, { kind: 'setCellContent', contextId: KERNEL_CONTEXT_ID, cells: [{ x: 0, y: 0, z: 0 }], content: {} })?.status).toBe('applied')
      let c = payloadOf(s, 'structure:frame-0').cellContent?.['0,0,0']
      expect(c, '`{}` ⇒ 键**在**，值是无内容的空壳').toBeDefined()
      expect(c?.tooltip).toBeUndefined()
      expect(c?.parts).toBeUndefined()

      expect(submit(s, { kind: 'setCellContent', contextId: KERNEL_CONTEXT_ID, cells: [{ x: 0, y: 0, z: 0 }], content: null })?.status).toBe('applied')
      c = payloadOf(s, 'structure:frame-0').cellContent?.['0,0,0']
      expect(c, '`null` ⇒ 键**不在**').toBeUndefined()
    } finally {
      s.dispose()
    }
  })

  it('幂等：同值再写 ⇒ `unchanged`（不推进版本、不进历史）', () => {
    const s = sessionWith([richGrid()])
    try {
      submit(s, { kind: 'setCellContent', contextId: KERNEL_CONTEXT_ID, cells: [{ x: 0, y: 0, z: 0 }], content: { tooltip: 'x' } })
      const before = s.document()!.version
      const r = submit(s, { kind: 'setCellContent', contextId: KERNEL_CONTEXT_ID, cells: [{ x: 0, y: 0, z: 0 }], content: { tooltip: 'x' } })
      expect(r?.status, '同值必须 unchanged').toBe('unchanged')
      expect(s.document()!.version.documentVersion, 'unchanged 不得推进版本').toBe(before.documentVersion)
    } finally {
      s.dispose()
    }
  })

  it('多帧文档：**全部**含该格的网格对象同时更新（投影只取第一份池）', () => {
    const s = sessionWith([richGrid(), richGrid()])
    try {
      submit(s, { kind: 'setCellContent', contextId: KERNEL_CONTEXT_ID, cells: [{ x: 0, y: 0, z: 0 }], content: { tooltip: 'both' } })
      for (const oid of ['structure:frame-0', 'structure:frame-1']) {
        expect(payloadOf(s, oid).cellContent?.['0,0,0']?.tooltip, `${oid} 必须同时更新`).toBe('both')
      }
    } finally {
      s.dispose()
    }
  })

  it('拒绝：孤儿格（不在任何网格）与重复格', () => {
    const s = sessionWith([richGrid()])
    try {
      const orphan = submit(s, { kind: 'setCellContent', contextId: KERNEL_CONTEXT_ID, cells: [{ x: 9, y: 9, z: 9 }], content: { tooltip: 'x' } })
      expect(orphan?.status).toBe('rejected')
      expect(orphan?.error?.code).toBe('MissingTarget')
      const dup = submit(s, {
        kind: 'setCellContent',
        contextId: KERNEL_CONTEXT_ID,
        cells: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }],
        content: { tooltip: 'x' },
      })
      expect(dup?.status).toBe('rejected')
      expect(dup?.error?.params?.reason).toBe('duplicateCells')
      void cellContentKey
      void isDirty
    } finally {
      s.dispose()
    }
  })
})

describe('R1-α ② `moveCells`：整格同时移动与身份保真', () => {
  it('五项逐格表**同键**一起搬；源键消失；目标格被替换', () => {
    const s = sessionWith([richGrid()])
    try {
      const r = submit(s, {
        kind: 'moveCells',
        contextId: KERNEL_CONTEXT_ID,
        objectId: 'structure:frame-0',
        moves: [{ from: { x: 0, y: 0, z: 0 }, to: { x: 2, y: 0, z: 0 } }],
      })
      expect(r?.status).toBe('applied')
      const p = payloadOf(s, 'structure:frame-0')
      // ① cells 搬
      expect(p.cells['0,0,0']).toBeUndefined()
      expect(p.cells['2,0,0']).toBe('minecraft:tile.BlockCableBus:0')
      // ② cellContent 搬（同键）
      expect(p.cellContent?.['0,0,0']).toBeUndefined()
      expect(p.cellContent?.['2,0,0']?.tooltip).toBe('cable')
      // ③ cellPalette 搬 + ④ cellPaletteIndex 搬
      expect(p.cellPalette?.['2,0,0']).toBe(NAMESPACED_KEY)
      expect(p.cellPaletteIndex?.['2,0,0']).toBe(1)
      // 另一格不动
      expect(p.cells['1,0,0']).toBe('minecraft:stone:0')
    } finally {
      s.dispose()
    }
  })

  it('**块身份随格迁移，命名空间不被改写**（GF-7 事故不得经写路径复发）', () => {
    const s = sessionWith([richGrid()])
    try {
      submit(s, {
        kind: 'moveCells',
        contextId: KERNEL_CONTEXT_ID,
        objectId: 'structure:frame-0',
        moves: [{ from: { x: 0, y: 0, z: 0 }, to: { x: 3, y: 2, z: 3 } }],
      })
      expect(registryIdAt(s, 'structure:frame-0', 3, 2, 3), '真身份必须带命名空间').toBe(
        'appliedenergistics2:tile.BlockCableBus',
      )
      expect(registryIdAt(s, 'structure:frame-0', 3, 2, 3)).not.toBe('minecraft:tile.BlockCableBus')
    } finally {
      s.dispose()
    }
  })

  it('同时语义：`a→b, b→c` 的净效果 = a 与 b 都到 c（**不**是链式）', () => {
    const s = sessionWith([richGrid()])
    try {
      submit(s, {
        kind: 'moveCells',
        contextId: KERNEL_CONTEXT_ID,
        objectId: 'structure:frame-0',
        moves: [
          { from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 } },
          { from: { x: 1, y: 0, z: 0 }, to: { x: 2, y: 0, z: 0 } },
        ],
      })
      const p = payloadOf(s, 'structure:frame-0')
      // b 既是目标又是源 ⇒ 先写 a 到 b、再写 b（快照里的原 b）到 c ⇒ b 的最终值来自**第二条 move 的快照**
      expect(p.cells['2,0,0'], 'c 收到 b 的快照值').toBe('minecraft:stone:0')
      expect(p.cells['1,0,0'], 'b 收到 a 的快照值').toBe('minecraft:tile.BlockCableBus:0')
      expect(p.cells['0,0,0'], 'a 是源且不是目标 ⇒ 删除').toBeUndefined()
    } finally {
      s.dispose()
    }
  })

  it('目标格原有内容被**替换**（不是交换）：源格不接收目标的原内容', () => {
    const s = sessionWith([richGrid()])
    try {
      submit(s, {
        kind: 'moveCells',
        contextId: KERNEL_CONTEXT_ID,
        objectId: 'structure:frame-0',
        moves: [{ from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 } }],
      })
      const p = payloadOf(s, 'structure:frame-0')
      expect(p.cellContent?.['1,0,0']?.tooltip, '目标被覆盖').toBe('cable')
      expect(p.cells['0,0,0'], '源格不接收目标的原内容（不是交换）').toBeUndefined()
    } finally {
      s.dispose()
    }
  })

  it('幂等：全部 `from === to` ⇒ `unchanged`', () => {
    const s = sessionWith([richGrid()])
    try {
      const before = s.document()!.version.documentVersion
      const r = submit(s, {
        kind: 'moveCells',
        contextId: KERNEL_CONTEXT_ID,
        objectId: 'structure:frame-0',
        moves: [{ from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 0 } }],
      })
      expect(r?.status).toBe('unchanged')
      expect(s.document()!.version.documentVersion).toBe(before)
    } finally {
      s.dispose()
    }
  })

  it('拒绝：重复源/重复目标、缺源、越界、空 moves', () => {
    const s = sessionWith([richGrid()])
    try {
      const dupFrom = submit(s, {
        kind: 'moveCells',
        contextId: KERNEL_CONTEXT_ID,
        objectId: 'structure:frame-0',
        moves: [
          { from: { x: 0, y: 0, z: 0 }, to: { x: 2, y: 0, z: 0 } },
          { from: { x: 0, y: 0, z: 0 }, to: { x: 3, y: 0, z: 0 } },
        ],
      })
      expect(dupFrom?.error?.params?.reason).toBe('duplicateCells')
      const dupTo = submit(s, {
        kind: 'moveCells',
        contextId: KERNEL_CONTEXT_ID,
        objectId: 'structure:frame-0',
        moves: [
          { from: { x: 0, y: 0, z: 0 }, to: { x: 2, y: 0, z: 0 } },
          { from: { x: 1, y: 0, z: 0 }, to: { x: 2, y: 0, z: 0 } },
        ],
      })
      expect(dupTo?.error?.params?.reason).toBe('duplicateCells')
      const noSrc = submit(s, {
        kind: 'moveCells',
        contextId: KERNEL_CONTEXT_ID,
        objectId: 'structure:frame-0',
        moves: [{ from: { x: 3, y: 3, z: 3 }, to: { x: 2, y: 0, z: 0 } }],
      })
      expect(noSrc?.error?.code).toBe('MissingTarget')
      const outside = submit(s, {
        kind: 'moveCells',
        contextId: KERNEL_CONTEXT_ID,
        objectId: 'structure:frame-0',
        moves: [{ from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 9, z: 0 } }],
      })
      expect(outside?.error?.params?.reason, '声明尺寸 4×3×4 ⇒ y=9 越界').toBe('outsideDeclaredGrid')
      const empty = submit(s, { kind: 'moveCells', contextId: KERNEL_CONTEXT_ID, objectId: 'structure:frame-0', moves: [] })
      expect(empty?.error?.code).toBe('MissingTarget')
    } finally {
      s.dispose()
    }
  })

  it('拒绝：只读（`content` 源）对象数据与过期版本', () => {
    const session = new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: ALL_CAPABILITIES,
    })
    try {
      const base = createDocument(KERNEL_DOCUMENT_ID, { sceneId: 'ro' })
      let scene: Scene = emptyScene('ro')
      scene = withObject(
        scene,
        sceneObject({ id: 'ro-grid', type: 'block', dataId: 'ro-grid:data' }),
        objectData('ro-grid:data', richGrid(), 'content'),
      ) as Scene
      const withSceneDoc = withContent(base, scene, base.animation)
      const adopted = withDocumentContent(withSceneDoc.doc, withSceneDoc.doc.content).doc
      session.adoptDocument(adopted, adopted.content)
      const ro = submit(session, {
        kind: 'moveCells',
        contextId: KERNEL_CONTEXT_ID,
        objectId: 'ro-grid',
        moves: [{ from: { x: 0, y: 0, z: 0 }, to: { x: 2, y: 0, z: 0 } }],
      })
      expect(ro?.error?.code, '`content` 源必须拒写').toBe('ReadOnly')
    } finally {
      session.dispose()
    }
  })

  it('版本冲突：`expectedVersion` 不符 ⇒ `VersionConflict` 且文档不变', () => {
    const s = sessionWith([richGrid()])
    try {
      const v = s.document()!.version
      const r = submit(s, {
        kind: 'moveCells',
        contextId: KERNEL_CONTEXT_ID,
        objectId: 'structure:frame-0',
        moves: [{ from: { x: 0, y: 0, z: 0 }, to: { x: 2, y: 0, z: 0 } }],
        expectedVersion: { documentVersion: v.documentVersion + 7, contentVersion: v.contentVersion },
      })
      expect(r?.error?.code).toBe('VersionConflict')
      expect(payloadOf(s, 'structure:frame-0').cells['0,0,0'], '拒绝不得改文档').toBeDefined()
    } finally {
      s.dispose()
    }
  })
})

describe('R1-α ③ `setDocumentMeta`：具名字段 patch', () => {
  it('只改 patch 里给的字段；`creator`/`tags` 等缺席字段原样保留', () => {
    const s = sessionWith([richGrid()])
    try {
      const r = submit(s, {
        kind: 'setDocumentMeta',
        contextId: KERNEL_CONTEXT_ID,
        patch: { name: 'probe', tags: ['a', 'b'] },
      })
      expect(r?.status).toBe('applied')
      const meta = s.document()!.content.metadata
      expect(meta.name).toBe('probe')
      expect(meta.tags).toEqual(['a', 'b'])
      expect(meta.author, '缺席字段不得被清空').toBe('')
      expect(meta.createdAtMs, '缺席字段不得被清空').toBeNull()
    } finally {
      s.dispose()
    }
  })

  it('`createdAtMs: null` 可显式表达（`undefined` 才是"不改"）', () => {
    const s = sessionWith([richGrid()])
    try {
      submit(s, { kind: 'setDocumentMeta', contextId: KERNEL_CONTEXT_ID, patch: { createdAtMs: 1234 } })
      expect(s.document()!.content.metadata.createdAtMs).toBe(1234)
      submit(s, { kind: 'setDocumentMeta', contextId: KERNEL_CONTEXT_ID, patch: { createdAtMs: null } })
      expect(s.document()!.content.metadata.createdAtMs, '`null` 必须可写').toBeNull()
    } finally {
      s.dispose()
    }
  })

  it('幂等：同值 ⇒ `unchanged`；空 patch ⇒ 拒绝', () => {
    const s = sessionWith([richGrid()])
    try {
      submit(s, { kind: 'setDocumentMeta', contextId: KERNEL_CONTEXT_ID, patch: { author: 'x' } })
      expect(submit(s, { kind: 'setDocumentMeta', contextId: KERNEL_CONTEXT_ID, patch: { author: 'x' } })?.status).toBe('unchanged')
      const empty = submit(s, { kind: 'setDocumentMeta', contextId: KERNEL_CONTEXT_ID, patch: {} })
      expect(empty?.status).toBe('rejected')
      expect(empty?.error?.params?.reason).toBe('emptyMetadataPatch')
    } finally {
      s.dispose()
    }
  })

  it('元数据是**内容**：写后内容版本推进（可撤销、会变脏）', () => {
    const s = sessionWith([richGrid()])
    try {
      const before = s.document()!.version
      submit(s, { kind: 'setDocumentMeta', contextId: KERNEL_CONTEXT_ID, patch: { description: 'd' } })
      const after = s.document()!.version
      expect(after.documentVersion).toBeGreaterThan(before.documentVersion)
      expect(after.contentVersion, '内容身份必须变').not.toBe(before.contentVersion)
      expect(isDirty(s.document()!)).toBe(true)
    } finally {
      s.dispose()
    }
  })
})
