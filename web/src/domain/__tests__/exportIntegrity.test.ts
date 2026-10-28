/**
 * **cell-not-lost 判据**：真实导出件上正对照必须绿、手工抠格必须红。
 *
 * ## 为什么这是"判据的判据"
 *
 * 一条恒绿的判据比没有判据更危险（它会让"方块蒸发"看起来有覆盖）。故本文件同时钉住：
 *  - **正对照**：真实 CTM 导出件 + 同一次 run 的世界侧 `read.blocks` 读数 ⇒ 绿；
 *  - **负对照**：把一件有用方块几何的格手工改成空气 ⇒ 必红，且报出**哪一格**丢失；
 *  - **恒绿防线**：统计自报值被改成"丢 0"也仍然红（逐格对账优先于自报）；
 *  - **不可判 ≠ 通过**：缺 `captureStats` / 缺 `scanBounds` / 世界方块越界 ⇒ 红。
 *
 * 输入全部来自生产解码（`normalizeEnvelopeToPlain` 解真实信封），不是手工拼的"已带字段"载荷。
 *
 * 真实信封在**仓外**：`<LIGHTNING_REAL_FIXTURES_DIR>/tesr/tesr-capture-placeholder.ctm.json`；
 * 世界侧读数 `e2e/fixtures/tesr-capture-placeholder.read-blocks.json` 无纹理，仍留公开树。
 * 信封缺失时本文件 8 条判据全部显式 skip（它们都以真实信封为前提）。
 */
/// <reference path="../../../e2e/real-fixtures.d.ts" />
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { realFixtureAvailable, realFixturePath } from '../../../e2e/real-fixtures.mjs'
import { normalizeEnvelopeToPlain } from '@/render/data/compactSceneDocument'
import { cellNotLostOf, type WorldBlockRef } from '../exportIntegrity'

const TESR_FIXTURE_KEY = 'tesrCaptureCtm'

/**
 * 依赖真实件的判据门控：夹具可用 ⇒ 正常注册；缺失 ⇒ **显式 skip**（不是整文件 exclude）。
 * 返回 void，避免把 `it` / `it.skip` 的联合塞进条件表达式后丢失调用签名。
 */
function withTesrCtmFixture(name: string, fn: () => Promise<void>): void {
  if (realFixtureAvailable(TESR_FIXTURE_KEY)) it(name, fn)
  else it.skip(name, fn)
}

interface LoadedFixture {
  structure: Record<string, unknown>
  rootBlockPalette: unknown
  blocks: readonly WorldBlockRef[]
}

async function loadFixture(): Promise<LoadedFixture> {
  const dir = path.join(process.cwd(), 'e2e', 'fixtures')
  const readJson = (name: string): unknown =>
    JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n'))
  // 真实信封来自仓外夹具根（行尾归一化口径与 Vitest 既有铁律一致）。
  const envelope = JSON.parse(
    fs.readFileSync(realFixturePath(TESR_FIXTURE_KEY), 'utf8').replace(/\r\n/g, '\n'),
  ) as Record<string, unknown>
  const plain = (await normalizeEnvelopeToPlain(envelope)) as {
    frames?: { structure?: Record<string, unknown> }[]
  }
  const structure = plain.frames?.[0]?.structure
  if (structure === undefined) throw new Error('真实信封解不出 structure —— 判据无法建立')
  // World 形态：跨帧共享的 blockPalette 在文档根（帧内 structure 不带它）。
  const rootBlockPalette = (plain as { blockPalette?: unknown }).blockPalette
  const read = readJson('tesr-capture-placeholder.read-blocks.json') as {
    blocks?: { pos: [number, number, number]; id?: string }[]
  }
  return {
    structure,
    rootBlockPalette,
    blocks: (read.blocks ?? []).map((b) => ({ pos: b.pos, id: b.id })),
  }
}

function cloneStructure(structure: Record<string, unknown>): {
  cellGrid: number[][][]
  captureStats: Record<string, number>
} & Record<string, unknown> {
  return JSON.parse(JSON.stringify(structure)) as {
    cellGrid: number[][][]
    captureStats: Record<string, number>
  } & Record<string, unknown>
}

/** 世界坐标 → 格下标（与判据同口径；测试侧只用来定位要篡改的格）。 */
function indexOf(structure: Record<string, unknown>, pos: readonly [number, number, number]): [number, number, number] {
  const b = structure.scanBounds as { minX: number; maxY: number; minZ: number }
  return [pos[2] - b.minZ, b.maxY - pos[1], pos[0] - b.minX]
}

describe('cell-not-lost：世界格 ↔ 导出格逐格对账', () => {
  withTesrCtmFixture('正对照：真实导出件 + 真实世界读数 ⇒ 绿（6 格 = 3 真实几何 + 1 占位 + 2 合法空）', async () => {
    const { structure, rootBlockPalette, blocks } = await loadFixture()
    const report = cellNotLostOf({ structure, rootBlockPalette, blocks })
    expect(report.violations, `不得有违规：${JSON.stringify(report.violations)}`).toEqual([])
    expect(report.ok).toBe(true)
    expect(report).toMatchObject({
      worldBlocks: 6,
      bakedCells: 3,
      placeholderCells: 1,
      airCells: 2,
      declaredEmptyCells: 2,
      lostCells: 0,
    })
    const statusOf = (p: readonly [number, number, number]) =>
      report.cells.find((c) => c.pos[0] === p[0] && c.pos[1] === p[1] && c.pos[2] === p[2])?.status
    expect(statusOf([64, 12, 64]), '箱子格是真实几何').toBe('baked')
    expect(statusOf([64, 12, 66]), '末影储罐格是占位').toBe('placeholder')
    expect(statusOf([64, 12, 65]), '裸转运器格被声明为空').toBe('declared_empty')
  })

  withTesrCtmFixture('负对照：把真实几何格手工抠成空气 ⇒ 必红，并指出该格', async () => {
    const { structure, rootBlockPalette, blocks } = await loadFixture()
    const damaged = cloneStructure(structure)
    const [z, row, col] = indexOf(damaged, [64, 12, 64])
    expect(damaged.cellGrid[z]![row]![col], '夹具前提：该格本来是箱子几何').not.toBe(0)
    damaged.cellGrid[z]![row]![col] = 0
    const report = cellNotLostOf({ structure: damaged, rootBlockPalette, blocks })
    expect(report.ok, '抠掉一格必须判红').toBe(false)
    expect(report.lostCells).toBe(1)
    expect(report.violations.map((v) => v.code)).toContain('cell_lost')
    expect(report.violations.find((v) => v.code === 'cell_lost')?.detail, '诊断必须点名被抠的格').toContain(
      '(64,12,64)',
    )
  })

  withTesrCtmFixture('负对照：把占位格抠成空气同样红（占位不是"可以丢"的豁免）', async () => {
    const { structure, rootBlockPalette, blocks } = await loadFixture()
    const damaged = cloneStructure(structure)
    const [z, row, col] = indexOf(damaged, [64, 12, 66])
    damaged.cellGrid[z]![row]![col] = 0
    const report = cellNotLostOf({ structure: damaged, rootBlockPalette, blocks })
    expect(report.ok).toBe(false)
    expect(report.lostCells).toBe(1)
    expect(report.violations.some((v) => v.code === 'cell_lost')).toBe(true)
  })

  withTesrCtmFixture('恒绿防线：把 captureStats.lostCells 自报成 0，逐格对账仍判红', async () => {
    const { structure, rootBlockPalette, blocks } = await loadFixture()
    const damaged = cloneStructure(structure)
    const [z, row, col] = indexOf(damaged, [64, 12, 64])
    damaged.cellGrid[z]![row]![col] = 0
    damaged.captureStats.lostCells = 0
    const report = cellNotLostOf({ structure: damaged, rootBlockPalette, blocks })
    expect(report.ok).toBe(false)
    expect(report.violations.some((v) => v.code === 'stats_mismatch')).toBe(true)
  })

  withTesrCtmFixture('负对照：计数改大以"吸收"被抠掉的格 ⇒ 分项和不闭合，仍红', async () => {
    const { structure, rootBlockPalette, blocks } = await loadFixture()
    const damaged = cloneStructure(structure)
    const [z, row, col] = indexOf(damaged, [64, 12, 64])
    damaged.cellGrid[z]![row]![col] = 0
    damaged.captureStats.declaredEmptyCells = 3 // 空气格 3 → 预算看似够
    const report = cellNotLostOf({ structure: damaged, rootBlockPalette, blocks })
    expect(report.lostCells, '算术上丢失被吸收了').toBe(0)
    expect(report.ok, '但分项和 3+1+3+0=7 != 6 ⇒ 记账不闭合，必须红').toBe(false)
    expect(report.violations.some((v) => v.code === 'stats_mismatch')).toBe(true)
  })

  withTesrCtmFixture('不可判不等于通过：缺 captureStats / 缺 scanBounds 都判红', async () => {
    const { structure, rootBlockPalette, blocks } = await loadFixture()
    const noStats = cloneStructure(structure)
    delete (noStats as { captureStats?: unknown }).captureStats
    const r1 = cellNotLostOf({ structure: noStats, rootBlockPalette, blocks })
    expect(r1.ok).toBe(false)
    expect(r1.violations.map((v) => v.code)).toContain('missing_capture_stats')

    const noBounds = cloneStructure(structure)
    delete noBounds.scanBounds
    const r2 = cellNotLostOf({ structure: noBounds, rootBlockPalette, blocks })
    expect(r2.ok).toBe(false)
    expect(r2.violations.map((v) => v.code)).toContain('missing_scan_bounds')
  })

  withTesrCtmFixture('世界方块落在导出网格外 ⇒ 红（不静默忽略）', async () => {
    const { structure, rootBlockPalette, blocks } = await loadFixture()
    const foreign = [...blocks, { pos: [999, 12, 999] as const, id: 'minecraft:stone' }]
    const report = cellNotLostOf({ structure, rootBlockPalette, blocks: foreign })
    expect(report.ok).toBe(false)
    expect(report.violations.map((v) => v.code)).toContain('out_of_bounds')
  })

  withTesrCtmFixture('映射口径：row 0 = 结构顶（maxY - y），不是 y 升序', async () => {
    const { structure, rootBlockPalette } = await loadFixture()
    // 箱子在 (64,12,64)：scanBounds minX=63/maxY=15/minZ=62 ⇒ col=1,row=3,z=2。
    expect(indexOf(structure, [64, 12, 64])).toEqual([2, 3, 1])
    const grid = structure.cellGrid as number[][][]
    const entry = (rootBlockPalette as { registryId: string }[])[grid[2]![3]![1]!]
    expect(entry?.registryId).toBe('minecraft:chest')
  })
})
