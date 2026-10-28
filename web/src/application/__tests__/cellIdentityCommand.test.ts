/**
 * **R1-β① 判据：`setCellIdentity`（块身份写命令）**。
 *
 * ## 要证明什么
 *
 * | 组 | 断言 | 为什么它必须存在 |
 * |---|---|---|
 * | ① 两表成对 | 写身份后 `cells` 与 `cellPalette` **同时**指向新方块 | 只改 `cells` 会把调色板引用留在旧方块上（"身份在 B、内容还在 A"） |
 * | ② **命名空间不被改写** | 写 `appliedenergistics2:…` 后读回仍是 `appliedenergistics2:…` | 事故成因是旧路径按 `minecraft:${name}` 反拼；本命令必须**不可能**经写再发生 |
 * | ③ `null` = 无方块 | 删两表的键，且与"空串"可区分 | 「缺席 ≠ 空」的核心口径 |
 * | ④ 多帧广播 | 每个 `blockGrid` 对象都被原子写入 = 一条历史 | 身份是逐帧字段；漏一帧就是"两视图不一致" |
 * | ⑤ 拒绝面 | 空 cells / 重复键 / 越界 / 只读 / 版本 / 空名 | 事务纪律：不得静默半写 |
 * | ⑥ 幂等 | 同值重发 ⇒ `unchanged`，不记历史 | 拖拽/重复提交不得污染历史 |
 *
 * ## 为什么断言打的是**生产命令通路**而不是复刻
 *
 * 输入经 `KernelSession.submit` ⇒ 走的就是生产 `reduceCommand` 本体
 * （与 `cellWriteCommands.test.ts` / `cellTooltipWrite.test.ts` 同一口径）。
 *
 * ## 负对照（本文件内，逐条给正判据）
 *
 * - ② 的负对照：`NAMESPACED_ENTRY` 的 `registryId` 里**没有** `minecraft:` 前缀，
 *   故任何"补前缀/反拼"的实现都会让 `registryIdAt` 读回 `minecraft:appliedenergistics2:…`
 *   —— 该读回路径**只**经 `cellPalette` → `palette` 条目，不经任何编码器，故有区分力。
 * - ③ 的负对照：先写 `{name:'', …}` 必须被拒（非法），再写 `null` 必须删键 ——
 *   两态压一态即本组失败。
 */

import { describe, it, expect } from 'vitest'
import { ALL_CAPABILITIES } from '@/application/commands'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { createDocument, withContent, withDocumentContent } from '@/domain/document'
import { emptyScene, findObject, findObjectData, objectData, sceneObject, withObject } from '@/domain/scene'
import type { ObjectDataPayload, Scene } from '@/domain/scene'
import { cellContentKey } from '@/domain/cellContent'
import { blockPaletteEntryKey, type BlockPaletteEntry } from '@/domain/blockGeometry'

/** 事故里被改写成 `minecraft:` 的那一类：**真**命名空间条目。 */
const NAMESPACED_ENTRY: BlockPaletteEntry = Object.freeze({
  assetId: 'geo:cablebus',
  registryId: 'appliedenergistics2:tile.BlockCableBus',
  meta: 0,
  renderMode: 'BakedModel',
  geometry: null,
  occludesAdjacentFaces: false,
})
const NAMESPACED_KEY = blockPaletteEntryKey(NAMESPACED_ENTRY)

const STONE_ENTRY: BlockPaletteEntry = Object.freeze({
  assetId: 'geo:stone',
  registryId: 'minecraft:stone',
  meta: 0,
  renderMode: 'BakedModel',
  geometry: null,
})
const GLASS_ENTRY: BlockPaletteEntry = Object.freeze({
  assetId: 'geo:glass',
  registryId: 'minecraft:glass',
  meta: 0,
  renderMode: 'BakedModel',
  geometry: null,
})

/** 最小内核会话；每个元素是**一个** `blockGrid` 对象（多帧 = 多个）。 */
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

/** 两格：`0,0,0` 是 AE2 电缆（**带命名空间**），`1,0,0` 是石头。 */
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
    cellPalette: { '0,0,0': NAMESPACED_KEY, '1,0,0': blockPaletteEntryKey(STONE_ENTRY) },
    cellPaletteIndex: { '0,0,0': 1, '1,0,0': 2 },
    palette: [NAMESPACED_ENTRY, STONE_ENTRY],
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

/**
 * 读回一格的**真实**方块身份 —— 只经 `cellPalette` 内容键 → `palette` 条目，
 * **不**经 `minecraft:${name}` 有损编码器。故"反拼前缀"的实现会在此暴露。
 */
function registryIdAt(session: KernelSession, objectId: string, x: number, y: number, z: number): string | undefined {
  const p = payloadOf(session, objectId)
  const key = p.cellPalette?.[cellContentKey(x, y, z)]
  if (key === undefined) return undefined
  return p.palette?.find((e) => blockPaletteEntryKey(e) === key)?.registryId
}

const CELL_000 = { x: 0, y: 0, z: 0 }

describe('R1-β① ① `setCellIdentity`：两表成对写入', () => {
  it('写新身份后 `cells` 与 `cellPalette` 同时指向新方块', () => {
    const s = sessionWith([richGrid()])
    try {
      const r = submit(s, {
        kind: 'setCellIdentity',
        contextId: KERNEL_CONTEXT_ID,
        cells: [CELL_000],
        identity: { name: 'glass', paletteRef: blockPaletteEntryKey(GLASS_ENTRY) },
      })
      expect(r?.status, '写必须 applied').toBe('applied')
      const p = payloadOf(s, 'structure:frame-0')
      expect(p.cells['0,0,0'], '`cells` 必须换成新方块（截前缀注册名）').toBe('glass')
      expect(
        p.cellPalette?.['0,0,0'],
        '`cellPalette` 必须**同批**换成新条目 —— 否则调色板引用留在旧方块上',
      ).toBe(blockPaletteEntryKey(GLASS_ENTRY))
      // 未写的格不受牵连
      expect(p.cells['1,0,0']).toBe('minecraft:stone:0')
      expect(p.cellPalette?.['1,0,0']).toBe(blockPaletteEntryKey(STONE_ENTRY))
    } finally {
      s.dispose()
    }
  })

  it('写身份不牵连逐格内容（`cellContent` 保持）', () => {
    const s = sessionWith([richGrid()])
    try {
      submit(s, {
        kind: 'setCellIdentity',
        contextId: KERNEL_CONTEXT_ID,
        cells: [CELL_000],
        identity: { name: 'glass', paletteRef: blockPaletteEntryKey(GLASS_ENTRY) },
      })
      expect(payloadOf(s, 'structure:frame-0').cellContent?.['0,0,0']?.tooltip).toBe('cable')
    } finally {
      s.dispose()
    }
  })
})

describe('R1-β① ② 命名空间不得被改写（事故成因的写侧封堵）', () => {
  it('把石头写成 `appliedenergistics2:…` 后，读回仍是 `appliedenergistics2:…`', () => {
    const s = sessionWith([richGrid()])
    try {
      const r = submit(s, {
        kind: 'setCellIdentity',
        contextId: KERNEL_CONTEXT_ID,
        cells: [{ x: 1, y: 0, z: 0 }],
        identity: { name: 'tile.BlockCableBus', paletteRef: NAMESPACED_KEY },
      })
      expect(r?.status).toBe('applied')
      expect(
        registryIdAt(s, 'structure:frame-0', 1, 0, 0),
        '真 registryId 必须原样保留：任何按 `minecraft:${name}` 反拼的实现都会在此读回 `minecraft:appliedenergistics2:…`',
      ).toBe('appliedenergistics2:tile.BlockCableBus')
      expect(payloadOf(s, 'structure:frame-0').cells['1,0,0']).toBe('tile.BlockCableBus')
      expect(
        registryIdAt(s, 'structure:frame-0', 1, 0, 0)?.startsWith('minecraft:'),
        '负对照：真命名空间条目**不**以 `minecraft:` 开头',
      ).toBe(false)
    } finally {
      s.dispose()
    }
  })

  it('负对照：`cells` 值本身不含命名空间，命名空间只活在 `cellPalette` 上', () => {
    // 若哪天有人"顺手"把 registryId 写进 cells，本组会红 —— 那正是有损形态。
    const s = sessionWith([richGrid()])
    try {
      const p = payloadOf(s, 'structure:frame-0')
      expect(p.cells['0,0,0']).not.toContain('appliedenergistics2')
      expect(registryIdAt(s, 'structure:frame-0', 0, 0, 0)).toBe('appliedenergistics2:tile.BlockCableBus')
    } finally {
      s.dispose()
    }
  })
})

describe('R1-β① ③ `null` = 该格没有方块（与空串可区分）', () => {
  it('`identity: null` 删两表的键', () => {
    const s = sessionWith([richGrid()])
    try {
      const r = submit(s, {
        kind: 'setCellIdentity',
        contextId: KERNEL_CONTEXT_ID,
        cells: [CELL_000],
        identity: null,
      })
      expect(r?.status).toBe('applied')
      const p = payloadOf(s, 'structure:frame-0')
      expect('0,0,0' in p.cells, '`cells` 的键必须**缺席**（不是空串）').toBe(false)
      expect(p.cellPalette?.['0,0,0'], '`cellPalette` 的键必须同批删除').toBeUndefined()
      expect(p.cells['1,0,0'], '邻格不受影响').toBe('minecraft:stone:0')
    } finally {
      s.dispose()
    }
  })

  it('空名被拒（缺席由 `null` 表达，不用空串冒充）', () => {
    const s = sessionWith([richGrid()])
    try {
      const r = submit(s, {
        kind: 'setCellIdentity',
        contextId: KERNEL_CONTEXT_ID,
        cells: [CELL_000],
        identity: { name: '', paletteRef: blockPaletteEntryKey(GLASS_ENTRY) },
      })
      expect(r?.status, '空注册名必须拒绝').toBe('rejected')
      expect(r?.error?.code).toBe('InvalidValue')
      // 拒绝后文档必须**原封不动**
      expect(payloadOf(s, 'structure:frame-0').cells['0,0,0']).toBe('minecraft:tile.BlockCableBus:0')
    } finally {
      s.dispose()
    }
  })
})

describe('R1-β① ④ 多帧广播：一条命令 = 一次事务 = 一条历史', () => {
  it('两个帧网格都被原子写入', () => {
    const s = sessionWith([richGrid(), richGrid()])
    try {
      const r = submit(s, {
        kind: 'setCellIdentity',
        contextId: KERNEL_CONTEXT_ID,
        cells: [CELL_000],
        identity: { name: 'glass', paletteRef: blockPaletteEntryKey(GLASS_ENTRY) },
      })
      expect(r?.status).toBe('applied')
      for (const id of ['structure:frame-0', 'structure:frame-1']) {
        expect(payloadOf(s, id).cells['0,0,0'], `${id} 必须同批写入`).toBe('glass')
      }
    } finally {
      s.dispose()
    }
  })

  it('一条命令只记**一条**历史条目', () => {
    const s = sessionWith([richGrid(), richGrid()])
    try {
      expect(s.documentSummary()?.canUndo, '初始无历史').toBe(false)
      submit(s, {
        kind: 'setCellIdentity',
        contextId: KERNEL_CONTEXT_ID,
        cells: [CELL_000],
        identity: { name: 'glass', paletteRef: blockPaletteEntryKey(GLASS_ENTRY) },
      })
      // 两帧写入必须是**一次**事务 —— 第二次 `undo` 必须直接回到"无历史"态，
      // 若每帧各记一条，这里会剩一条且 `canUndo` 仍为 true。
      expect(s.documentSummary()?.canUndo, '一次写入之后必须有历史').toBe(true)
      s.submit({ kind: 'undo', contextId: KERNEL_CONTEXT_ID } as never)
      s.drain()
      expect(s.documentSummary()?.canUndo, '**一次** undo 必须撤销整条命令（两帧同事务）').toBe(false)
      for (const id of ['structure:frame-0', 'structure:frame-1']) {
        expect(payloadOf(s, id).cells['0,0,0'], `${id} 必须一起回退`).toBe('minecraft:tile.BlockCableBus:0')
      }
    } finally {
      s.dispose()
    }
  })
})

describe('R1-β① ⑤ 拒绝面', () => {
  const cases: readonly { readonly label: string; readonly cmd: Record<string, unknown>; readonly code: string }[] = [
    {
      label: '空 cells',
      cmd: { cells: [], identity: { name: 'glass', paletteRef: blockPaletteEntryKey(GLASS_ENTRY) } },
      code: 'MissingTarget',
    },
    {
      label: '重复键',
      cmd: { cells: [CELL_000, CELL_000], identity: { name: 'glass', paletteRef: blockPaletteEntryKey(GLASS_ENTRY) } },
      code: 'InvalidValue',
    },
    {
      label: '键不在任何网格的 `cells` 里（含越界 x=9，sizeColumn=4）',
      // ⚠️ 期望 `MissingTarget` 而非"越界"专用码 —— **刻意**与 `setCellContent`/`setCellTooltip`
      // 逐字同口径：三条格写命令的判据都是「键必须已存在于 `cells`」。
      //
      // 本项目实测的事实（保留在此以免后人"重发现"）：`blockGrid` 载荷**确实**带
      // `sizeColumn`/`sizeRow`/`sizeZSlice` 声明尺寸，而 `cells` 是**稀疏**表
      // ⇒ 尺寸推不出来、只能承载。但"越界 vs 缺席"的分辨是**格式边界**的建模口径：
      // 让写命令替边界做这个判断，就是把边界语义漏进内核，
      // 且会让 `setCellIdentity` 成为三条命令里的异类、迫使改共用解析器。
      // 若将来出现**真实生产路径**（非测试合成）让越界键到达本命令，按 §8 登记 GF 后再动共用件。
      cmd: { cells: [{ x: 9, y: 0, z: 0 }], identity: { name: 'glass', paletteRef: blockPaletteEntryKey(GLASS_ENTRY) } },
      code: 'MissingTarget',
    },
    {
      // 与上一条**同码**：「空网格」与「没有网格」在此不区分（两者都不含该键）。
      label: '键不存在于任何网格（size* 声明之外，但同码）',
      cmd: { cells: [{ x: 5, y: 5, z: 5 }], identity: { name: 'glass', paletteRef: blockPaletteEntryKey(GLASS_ENTRY) } },
      code: 'MissingTarget',
    },
    {
      label: '版本不匹配',
      cmd: { cells: [CELL_000], identity: { name: 'glass', paletteRef: blockPaletteEntryKey(GLASS_ENTRY) }, expectedVersion: 999 },
      code: 'VersionConflict',
    },
  ]

  for (const c of cases) {
    it(`${c.label} ⇒ ${c.code}`, () => {
      const s = sessionWith([richGrid()])
      try {
        const r = submit(s, { kind: 'setCellIdentity', contextId: KERNEL_CONTEXT_ID, ...c.cmd })
        expect(r?.status, `${c.label} 必须被拒`).toBe('rejected')
        expect(r?.error?.code).toBe(c.code)
        expect(payloadOf(s, 'structure:frame-0').cells['0,0,0'], '拒绝 ⇒ 文档不得改动').toBe(
          'minecraft:tile.BlockCableBus:0',
        )
      } finally {
        s.dispose()
      }
    })
  }

  it('只读来源（`source: content`）⇒ readOnly', () => {
    const session = new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: ALL_CAPABILITIES,
    })
    try {
      const base = createDocument(KERNEL_DOCUMENT_ID, { sceneId: 'probe-scene' })
      let scene: Scene = emptyScene('probe-scene')
      scene = withObject(
        scene,
        sceneObject({ id: 'structure:frame-0', type: 'block', dataId: 'structure:frame-0:data' }),
        objectData('structure:frame-0:data', richGrid(), 'content'),
      ) as Scene
      const withSceneDoc = withContent(base, scene, base.animation)
      const adopted = withDocumentContent(withSceneDoc.doc, withSceneDoc.doc.content).doc
      session.adoptDocument(adopted, adopted.content)
      const r = submit(session, {
        kind: 'setCellIdentity',
        contextId: KERNEL_CONTEXT_ID,
        cells: [CELL_000],
        identity: { name: 'glass', paletteRef: blockPaletteEntryKey(GLASS_ENTRY) },
      })
      expect(r?.status).toBe('rejected')
      expect(r?.error?.code).toBe('ReadOnly')
    } finally {
      session.dispose()
    }
  })
})

describe('R1-β① ⑥ 幂等：同值重发 ⇒ unchanged，不记历史', () => {
  it('第二次写同样的身份不产生新历史条目', () => {
    const s = sessionWith([richGrid()])
    try {
      // 写**已经在那里**的身份（`1,0,0` 已是 `minecraft:stone:0` + STONE 条目）⇒ unchanged。
      const cmd = {
        kind: 'setCellIdentity',
        contextId: KERNEL_CONTEXT_ID,
        cells: [{ x: 1, y: 0, z: 0 }],
        identity: { name: 'minecraft:stone:0', paletteRef: blockPaletteEntryKey(STONE_ENTRY) },
      }
      const first = submit(s, cmd)
      expect(first?.status, '同值写入必须 `unchanged`（不记历史）').toBe('unchanged')
      expect(s.documentSummary()?.canUndo, '`unchanged` 不得记历史').toBe(false)
      const second = submit(s, cmd)
      expect(second?.status).toBe('unchanged')
      expect(s.documentSummary()?.canUndo).toBe(false)
    } finally {
      s.dispose()
    }
  })
})
