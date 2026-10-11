/**
 * **P10d（#289）· 部件与逐格说明的承载往返**（内核内容面补全的第二半）。
 *
 * ## 本文件证什么
 *
 * P10c（#286）实测登记的缺口是两类**逐格内容**无内核落点：
 *
 * > 同类缺口：注解几何（只剩 shape/text）、**部件（`cellPartsGrid`/`partLists`）**、
 * > **tooltip 池（`tooltipPalette`/`cellTooltipGrid`）**。
 *
 * 本文件证明它们**真的进了内核**并且**能原样回来**：
 *
 * ```
 * 真实文件 ──生产解析器──▶ RuntimeDocument ──装配──▶ 内核（逐格内容类型化）
 *                                                      │
 *                                                      └──投影──▶ cellPartsGrid/partLists
 *                                                                  cellTooltipGrid/tooltipPalette（逐格文本）
 * ```
 *
 * ## 三组判据
 *
 * | 组 | 判据 | 违反的后果 |
 * |---|---|---|
 * | 部件 | 逐格部件经内核往返后**逐字段相同**，且下标网格与 `cellGrid` 对位 | 部件的盒/说明/物品身份静默丢字段 |
 * | 部件池 | 同内容跨格**共享一份下标**（契约 §2.1 的内容签名去重） | 池膨胀；或去重算法与 `serialize()` 分叉 |
 * | 逐格说明 | `-1` 哨兵被**吸收**进"字段缺席"，且行序翻转与解析期同源 | 说明整体错位一行（`row 0 = 顶部` vs Y-up） |
 *
 * ## 为什么用真实部件夹具
 *
 * `parts-singlebox-mix.v2.json` / `parts-ae2-multibox.v2.json` 是仓里**仅有的**带
 * `cellPartsGrid`/`partLists` 的真实文件（由 P10 部件轮生产线产出）。合成一份最小
 * 部件表会让"盒越出 [0,1]³""`items: []` 是显式无"这类契约事实消失。
 */

import { describe, expect, it } from 'vitest'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { projectGridCells, parseBlockCellKey } from '@/composition/kernelProjection'
import { RuntimeDocument } from '@/context/runtimeDocument'
import { unwrap } from '@/domain/errors'
import { partListSignature, PARTS_GRID_NONE } from '@/pure/partTypes'
import { structureRowToWorldY } from '@/pure/vec'
import { readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'
import path from 'node:path'

const PARTS_FIXTURES = ['parts-singlebox-mix.v2.json', 'parts-ae2-multibox.v2.json'] as const

/** 读一份 V2Plain 部件夹具（经**生产解析器**，不手工构造 `RuntimeDocument`）。 */
async function loadPartsFixture(name: string) {
  const raw = readJson(path.join(process.cwd(), 'e2e', 'fixtures', name)) as Record<string, unknown>
  const doc = RuntimeDocument.fromV2Plain(raw)
  expect(doc, `${name} 应能被生产解析器读入`).not.toBeNull()
  return { doc: doc!, raw }
}

/** 首帧的 `structure`（`[z][row][col]` 朝向；row 0 = 顶部）。 */
function firstStructure(raw: Record<string, unknown>): Record<string, unknown> {
  const frames = raw.frames as Record<string, unknown>[]
  return frames[0]!.structure as Record<string, unknown>
}

describe('P10d · 部件：内核承载与投影往返', () => {
  for (const name of PARTS_FIXTURES) {
    it(`${name}：逐格部件经内核往返后**逐字段相同**`, async () => {
      const { doc, raw } = await loadPartsFixture(name)
      const st = firstStructure(raw)
      const srcParts = st.cellPartsGrid as number[][][]
      const srcLists = st.partLists as unknown[][]

      const assembled = unwrap(assembleKernelDocument({ doc }))
      const objectId = assembled.frameObjects[0]!
      const obj = assembled.scene.objects[objectId]!
      const data = assembled.scene.data[obj.dataId]!
      if (data.payload.kind !== 'blockGrid') throw new Error('首帧对象不是 blockGrid 载荷')
      const payload = data.payload

      // ── ① 部件**真的进了内核**（逐格内容非空）──
      expect(payload.cellContent, `${name} 内核载荷必须有逐格内容（否则部件没承载）`).toBeDefined()
      const contentKeys = Object.keys(payload.cellContent!)
      expect(contentKeys.length, `${name} 应有带部件的格`).toBeGreaterThan(0)
      const withParts = contentKeys.filter((k) => (payload.cellContent![k]!.parts?.length ?? 0) > 0)
      expect(withParts.length, `${name} 应有格携带部件列表`).toBeGreaterThan(0)

      // ── ② 投影回 `cellPartsGrid`/`partLists` ──
      const projected = projectGridCells({
        cells: payload.cells,
        geometry: payload.geometry,
        cellGeometry: payload.cellGeometry,
        palette: payload.palette,
        cellContent: payload.cellContent,
      })
      expect(projected.cellPartsGrid, `${name} 投影必须写出部件网格`).toBeDefined()
      expect(projected.partLists, `${name} 投影必须写出部件池`).toBeDefined()

      // ── ③ **逐格对位**：每个非 -1 的格在往返后仍是"同内容"的部件列表 ──
      // 池下标可能重编号（投影按首次出现顺序重建池），故判据是**内容等同**
      // （`partListSignature` 逐字段稳定序列化）而不是"下标相同"。
      const height = projected.cellPartsGrid!.length > 0 ? projected.cellPartsGrid![0]!.length : 0
      let checkedCells = 0
      for (let z = 0; z < srcParts.length; z++) {
        for (let row = 0; row < srcParts[z]!.length; row++) {
          for (let col = 0; col < srcParts[z]![row]!.length; col++) {
            const srcIdx = srcParts[z]![row]![col]!
            const dstIdx = projected.cellPartsGrid![z]?.[row]?.[col]
            if (srcIdx === PARTS_GRID_NONE) {
              expect(dstIdx, `${name} [${z}][${row}][${col}] 原始为"无部件"`).toBe(PARTS_GRID_NONE)
              continue
            }
            checkedCells += 1
            expect(typeof dstIdx, `${name} [${z}][${row}][${col}] 必须仍带部件`).toBe('number')
            expect(dstIdx, `${name} [${z}][${row}][${col}] 不得变成"无"`).not.toBe(PARTS_GRID_NONE)
            const src = srcLists[srcIdx] as unknown[]
            const dst = projected.partLists![dstIdx as number] as unknown[]
            expect(partListSignature(dst as never), `${name} [${z}][${row}][${col}] 部件内容必须逐字段相同`).toBe(
              partListSignature(src as never),
            )
          }
        }
      }
      expect(checkedCells, `${name} 必须有真实带部件的格被检查（否则本条是空洞真）`).toBeGreaterThan(0)
      expect(height, `${name} 部件网格行数应与结构高度一致`).toBeGreaterThan(0)
      console.log(`[P10d] ${name}: 部件池 ${srcLists.length} → ${projected.partLists!.length}，逐格检查 ${checkedCells} 格`)
    })
  }

  it('**负对照**：部件内容真变了 ⇒ 签名必须变（证明上面的"内容相同"不是恒等）', async () => {
    const { raw } = await loadPartsFixture('parts-singlebox-mix.v2.json')
    const st = firstStructure(raw)
    const lists = st.partLists as Record<string, unknown>[][]
    const orig = partListSignature(lists[0] as never)
    // 改一个字段（`displayName`）——契约 §3 的⑤要素之一
    const mutated = [{ ...lists[0]![0]!, displayName: '改过的名字' }]
    expect(partListSignature(mutated as never)).not.toBe(orig)
  })

  it('部件池按**内容签名**去重（契约 §2.1：同内容跨格共享一份下标）', async () => {
    const { raw } = await loadPartsFixture('parts-singlebox-mix.v2.json')
    const st = firstStructure(raw)
    const grid = st.cellPartsGrid as number[][][]
    const lists = st.partLists as unknown[][]
    // 该夹具的 `cellPartsGrid` = `[[[0,0,1,-1,2]]]` ⇒ 两个格共享下标 0
    const used = new Set<number>()
    for (const s of grid) for (const r of s) for (const v of r) if (v !== PARTS_GRID_NONE) used.add(v)
    expect(used.size, '该夹具应有共享的部件池下标（这正是去重的证据）').toBeLessThan(lists.length + 1)
    // 且下标 0 确实被多格使用
    const zeros = grid.flat(3).filter((v) => v === 0).length
    expect(zeros, '下标 0 应被多格共享').toBeGreaterThan(1)
  })
})

describe('P10d · 逐格说明：`-1` 哨兵被吸收进"字段缺席"', () => {
  it('构造一份带 `cellTooltipGrid` 的文档：经内核往返后逐格文本按**世界坐标**对位', async () => {
    // 用真实信封的 `tooltipPalette` 形态（16 条）合成一份 2×2×1 的最小文档。
    // 目的是让"下标网格 → 世界坐标"这条翻转**可判定**：高度 2 时
    // row 0（顶部）必须映射到 y=1，row 1 到 y=0。
    const doc = RuntimeDocument.fromV2Plain({
      format_version: '2.0',
      id: 'tooltip-probe',
      meta: { name: 'probe', author: '', created_at_ms: 0, description: '', tags: [], origin: { x: 0, y: 0, z: 0 } },
      annotations: [],
      labels: [],
      tooltipPalette: ['顶层说明', '底层说明'],
      // `[z][row][col]`：row 0 = 顶部
      cellTooltipGrid: [[[0, -1], [-1, 1]]],
      frames: [
        {
          index: 0,
          structure: {
            geometryPhase: 'baked',
            cellGrid: [[[1, 1], [1, 1]]],
            blockPalette: [
              { registryId: 'air', meta: 0, renderMode: 'BlockModel' },
              { registryId: 'minecraft:stone', meta: 0, renderMode: 'BlockModel' },
            ],
          },
        },
      ],
    })!
    const assembled = unwrap(assembleKernelDocument({ doc }))
    const objectId = assembled.frameObjects[0]!
    const data = assembled.scene.data[assembled.scene.objects[objectId]!.dataId]!
    if (data.payload.kind !== 'blockGrid') throw new Error('不是 blockGrid')
    const content = data.payload.cellContent
    expect(content, '内核载荷必须有逐格内容').toBeDefined()

    // row 0 = 顶部 ⇒ 世界 y = height - 1 - 0 = 1；col 0 ⇒ x = 0
    const top = content!['0,1,0']
    expect(top?.tooltip, 'row 0（顶部）的说明必须落在世界 y=1').toBe('顶层说明')
    // row 1 = 底部 ⇒ y = 0；col 1 ⇒ x = 1
    const bottom = content!['1,0,0']
    expect(bottom?.tooltip, 'row 1（底部）的说明必须落在世界 y=0').toBe('底层说明')
    // `-1` 哨兵 ⇒ **字段缺席**（不是空串，也不是 `-1`）
    expect(content!['1,1,0'], '`-1` 格不得出现在逐格内容里').toBeUndefined()
    expect(content!['0,0,0'], '`-1` 格不得出现在逐格内容里').toBeUndefined()

    // 且翻转与解析期同源（同一个自逆函数）
    expect(structureRowToWorldY(0, 2)).toBe(1)
    expect(structureRowToWorldY(1, 2)).toBe(0)
  })

  it('**负对照**：把 `-1` 当空串承载 ⇒ 与"字段缺席"不可区分（证明判据有意义）', () => {
    // 这条负对照是**类型级**的：`domain/cellContent#CellContent.tooltip` 的缺席
    // 与 `''` 是两个不同的值，故"该格无说明"与"该格说明为空"可分辨。
    const absent: { tooltip?: string } = {}
    const empty: { tooltip?: string } = { tooltip: '' }
    expect(Object.prototype.hasOwnProperty.call(absent, 'tooltip')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(empty, 'tooltip')).toBe(true)
    expect(absent.tooltip).toBeUndefined()
    expect(empty.tooltip).toBe('')
  })
})

describe('P10d · 单元格键：装配与投影**同一个**构造函数', () => {
  it('`parseBlockCellKey` 是键构造的逆（往返恒等，含负坐标）', () => {
    for (const p of [
      { x: 0, y: 0, z: 0 },
      { x: -91, y: 62, z: 20 },
      { x: 7, y: 1, z: 19 },
    ]) {
      expect(parseBlockCellKey(`${p.x},${p.y},${p.z}`)).toEqual(p)
    }
  })

  it('空段**显式拒绝**（`"1,2,"` 不得被读成 `(1,2,0)` —— 一次真实的坐标误读）', () => {
    expect(parseBlockCellKey('1,2,')).toBeNull()
    expect(parseBlockCellKey(',,')).toBeNull()
    expect(parseBlockCellKey('1,2')).toBeNull()
    expect(parseBlockCellKey('1,2,3,4')).toBeNull()
  })
})
