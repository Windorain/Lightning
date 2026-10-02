/**
 * T2.2 装配器验收 —— **552 组合逐格 diff 基准**。
 *
 * 基准来源：`scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs --verify-grids`
 * 落盘的参考展开网格（`scripts/multiblock-fixtures/.out/expanded-fixtures/`，552 份）。
 * 该目录在 `.gitignore` 中（可再生），故本测试在缺文件时**就地用同一份参考蓝本**
 * `scripts/multiblock-fixtures/lib.mjs` 生成该文件（与 `--verify-grids` 同一实现），
 * 不会让验收线在干净检出上静默跳过。
 *
 * 通过标准：3 份 fixture 的全部 552 个已声明组合，TS 装配器输出与参考网格**逐格一致（差异 = 0）**。
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { assembleSelection, assembleVariant, listVariants, parseVariantKey } from '@/context/multiblock'
import type { Dims, MultiblockInnerDocument } from '@/context/multiblock'
import {
  REF_DIR,
  exists,
  listReferenceFiles,
  loadInnerDocument,
  loadReferenceLib,
  readJson,
  refPath,
  writeReference,
} from './multiblockFixtureIo.mjs'

/** 三份 fixture（契约 §10.1）：多通道 / 作用域相交例外 / 仅总 Tier。 */
const FIXTURES = ['multiblock-ebf-2ch', 'multiblock-lsc-overlap', 'multiblock-tier-only'] as const
/** 各 fixture 的已声明变体数（契约 §10.2）：432 + 108 + 12 = 552。 */
const EXPECTED_VARIANTS: Record<string, number> = {
  'multiblock-ebf-2ch': 432,
  'multiblock-lsc-overlap': 108,
  'multiblock-tier-only': 12,
}

const loadInner = (name: string): MultiblockInnerDocument => loadInnerDocument(name) as MultiblockInnerDocument

interface ReferenceGrid {
  variant: string
  dims: Dims
  cellGrid: number[][][]
}

/** 缺参考文件时用冻结蓝本就地生成（与 `--verify-grids` 同一实现）。 */
beforeAll(async () => {
  const missing: Array<{ name: string; key: string }> = []
  for (const name of FIXTURES) {
    for (const v of listVariants(loadInner(name))) {
      if (!exists(refPath(name, v.key))) missing.push({ name, key: v.key })
    }
  }
  if (missing.length === 0) return
  const lib = (await loadReferenceLib()) as {
    assembleVariant: (doc: unknown, key: string) => ReferenceGrid
  }
  const docs = new Map<string, MultiblockInnerDocument>()
  for (const m of missing) {
    if (!docs.has(m.name)) docs.set(m.name, loadInner(m.name))
    const ref = lib.assembleVariant(docs.get(m.name), m.key)
    writeReference(m.name, m.key, { variant: m.key, dims: ref.dims, cellGrid: ref.cellGrid })
  }
  // eslint-disable-next-line no-console
  console.warn(`[T2.2] 参考展开网格缺失 ${missing.length} 份，已用 lib.mjs（冻结蓝本）就地生成到 ${REF_DIR}`)
}, 120_000)

function readReference(name: string, variantKey: string): ReferenceGrid {
  return readJson<ReferenceGrid>(refPath(name, variantKey))
}

interface GridDiff {
  cells: number
  diffs: Array<{ x: number; y: number; z: number; got: number; want: number }>
  shape: string | null
}

/** 逐格比对（`[z][y][x]`，契约朝向），差异全部记录（最多保留 8 条证据）。 */
function diffGrids(got: number[][][], want: number[][][], wantDims: Dims): GridDiff {
  const out: GridDiff = { cells: 0, diffs: [], shape: null }
  if (
    got.length !== wantDims.d ||
    (got[0]?.length ?? 0) !== wantDims.h ||
    (got[0]?.[0]?.length ?? 0) !== wantDims.w
  ) {
    out.shape = `形状 ${got.length}x${got[0]?.length ?? 0}x${got[0]?.[0]?.length ?? 0} ≠ 参考 ${wantDims.d}x${wantDims.h}x${wantDims.w}`
  }
  for (let z = 0; z < wantDims.d; z++) {
    for (let y = 0; y < wantDims.h; y++) {
      for (let x = 0; x < wantDims.w; x++) {
        out.cells++
        const a = got[z]?.[y]?.[x]
        const b = want[z]?.[y]?.[x]
        if (a !== b && out.diffs.length < 8) out.diffs.push({ x, y, z, got: a as number, want: b as number })
      }
    }
  }
  return out
}

describe('T2.2 装配器：与参考展开网格逐格一致', () => {
  it('3 份 fixture / 552 个组合全部逐格一致（差异 = 0）', () => {
    const summary: string[] = []
    let totalVariants = 0
    let totalCells = 0

    for (const name of FIXTURES) {
      const doc = loadInner(name)
      const variants = listVariants(doc)
      expect(variants.length, `${name} 的已声明变体数`).toBe(EXPECTED_VARIANTS[name])

      let cells = 0
      const failures: string[] = []
      for (const v of variants) {
        const ref = readReference(name, v.key)
        const res = assembleVariant(doc, v.key)
        const d = diffGrids(res.cellGrid, ref.cellGrid, ref.dims)
        cells += d.cells
        if (d.shape) failures.push(`变体 ${v.key}: ${d.shape}`)
        if (d.diffs.length > 0) {
          failures.push(
            `变体 ${v.key}: ${d.diffs.length} 处差异 ` +
              d.diffs.map((x) => `(${x.x},${x.y},${x.z}) got=${x.got} want=${x.want}`).join(' '),
          )
        }
      }
      expect(failures.slice(0, 4).join('\n'), `${name}: 与参考网格的差异必须为 0`).toBe('')
      summary.push(
        `${name}: ${variants.length} 组合 / ${cells} 格 逐格一致（差异 0），步进总耗时见下`,
      )
      totalVariants += variants.length
      totalCells += cells
    }

    expect(totalVariants).toBe(552)
    expect(totalCells).toBe(14574)
    // eslint-disable-next-line no-console
    console.log(`[T2.2] 逐格 diff 通过 ${totalVariants}/${totalVariants} 组合，共 ${totalCells} 格\n` + summary.join('\n'))
  })

  it('同一变体两次装配逐格一致（确定性）', () => {
    let checked = 0
    for (const name of FIXTURES) {
      const doc = loadInner(name)
      for (const v of listVariants(doc)) {
        const a = assembleVariant(doc, v.key)
        const b = assembleVariant(doc, v.key)
        expect(JSON.stringify(b.cellGrid), `${name} / ${v.key} 第二次装配必须逐格一致`).toBe(
          JSON.stringify(a.cellGrid),
        )
        checked++
      }
    }
    expect(checked).toBe(552)
  })

  it('EBF 432 组合纯查表装配总耗时在毫秒~秒级', () => {
    const doc = loadInner('multiblock-ebf-2ch')
    const variants = listVariants(doc)
    const t0 = performance.now()
    for (const v of variants) assembleVariant(doc, v.key)
    const ms = performance.now() - t0
    // eslint-disable-next-line no-console
    console.log(`[T2.2] EBF ${variants.length} 组合装配总耗时 ${ms.toFixed(1)} ms`)
    expect(ms).toBeLessThan(5000)
  })

  it('基准自身有效：参考目录在位 ≥552 份，且篡改一格必然被判为差异', () => {
    const files = listReferenceFiles().filter((f) => f.startsWith('multiblock-'))
    expect(files.length).toBeGreaterThanOrEqual(552)

    const name = 'multiblock-ebf-2ch'
    const key = 'height:3|coil:2|glass:1|tt:2|runstate:active'
    const ref = readReference(name, key)
    const res = assembleVariant(loadInner(name), key)
    // 未篡改 → 无差异
    expect(diffGrids(res.cellGrid, ref.cellGrid, ref.dims).diffs).toEqual([])
    // 篡改一格 → 必被判为差异（证明本用例不是恒绿）
    const tampered = JSON.parse(JSON.stringify(ref.cellGrid)) as number[][][]
    const before = tampered[0]![0]![0]!
    tampered[0]![0]![0] = before === 0 ? 1 : 0
    const d = diffGrids(res.cellGrid, tampered, ref.dims)
    expect(d.cells).toBe(ref.dims.w * ref.dims.h * ref.dims.d)
    expect(d.diffs.length).toBe(1)
    expect(d.diffs[0]).toEqual({ x: 0, y: 0, z: 0, got: res.cellGrid[0]![0]![0], want: tampered[0]![0]![0] })
  })
})

describe('T2.2 assembleSelection：UI 取值选择 → 变体定位', () => {
  it('对全部 552 个组合，assembleSelection(声明值) 与 assembleVariant(键) 完全一致', () => {
    let checked = 0
    let withClamp = 0
    for (const name of FIXTURES) {
      const doc = loadInner(name)
      for (const v of listVariants(doc)) {
        const parsed = parseVariantKey(v.key)
        const res = assembleSelection(doc, {
          totalTier: parsed.totalTier,
          values: parsed.values,
          runstate: parsed.runstate,
        })
        const direct = assembleVariant(doc, v.key)
        expect(res.variantKey, `${name}: 选择 ${JSON.stringify(parsed)} 应命中变体 ${v.key}`).toBe(v.key)
        expect(JSON.stringify(res.cellGrid), `${name} / ${v.key}: 选择路径与键路径必须一致`).toBe(
          JSON.stringify(direct.cellGrid),
        )
        // 已声明组合也可能被**域/耦合夹取**（如 capacitor=0 回落 Tier=3 被域夹到 2）：
        // 选择路径不得比键路径多出或少掉任何夹取记录。
        expect(JSON.stringify(res.report.clamped), `${name} / ${v.key}: 夹取记录应与键路径一致`).toBe(
          JSON.stringify(direct.report.clamped),
        )
        expect(res.report.rejections).toEqual([])
        if (res.report.clamped.length > 0) withClamp++
        checked++
      }
    }
    expect(checked).toBe(552)
    // 覆盖证据：确实有一批已声明组合走了夹取路径（否则本用例是空转）
    expect(withClamp).toBeGreaterThan(100)
    // eslint-disable-next-line no-console
    console.log(`[T2.2] assembleSelection 路径自检 ${checked}/552，其中 ${withClamp} 个组合含夹取记录`)
  })

  it('输出 Grid 接入既有 Grid（Y-up、尺寸 = 骨架阶尺寸、air 为 null）', () => {
    const doc = loadInner('multiblock-ebf-2ch')
    const res = assembleSelection(doc, { totalTier: 2, values: { height: 3, coil: 3, glass: 1 }, runstate: 'active' })
    expect({ w: res.grid.width, h: res.grid.height, d: res.grid.depth }).toEqual(res.dims)
    expect(res.dims).toEqual({ w: 3, h: 3, d: 3 })
    // 契约 cellGrid row 0 = 顶部；Grid row → 世界 Y 已翻转：grid.at({x,y,z}) 对应 cellGrid[h-1-y]
    for (let z = 0; z < res.dims.d; z++) {
      for (let row = 0; row < res.dims.h; row++) {
        for (let x = 0; x < res.dims.w; x++) {
          const y = res.dims.h - 1 - row
          const idx = res.cellGrid[z]![row]![x]!
          const block = res.grid.at({ x, y, z })
          if (idx === 0) expect(block).toBeNull()
          else {
            expect(block).not.toBeNull()
            expect(block!.paletteIndex).toBe(idx)
          }
        }
      }
    }
    // air 恒为下标 0（契约 §6.1）
    expect(res.blocks[0]).toBeNull()
  })
})
