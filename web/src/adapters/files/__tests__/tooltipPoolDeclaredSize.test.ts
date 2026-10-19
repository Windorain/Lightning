/**
 * `adapters/tooltipPool` —— **说明网格形状的权威**（M1 P3 定向判据）。
 *
 * ## 这条判据修的是什么
 *
 * `tooltipPoolOf` 原先只按"说明格包围盒"推 `width/height/depth`。而消费侧
 * （`composition/kernelAssembly#tooltipContentOf`）**逐字**按载荷声明的 `sizeRow`
 * 反解行号 —— 其注释即写明「说明网格与 `cellGrid` **同形**」。
 * ⇒ "最高一行（或最右一列/最深一层）没有说明"的文档会产出一个**比声明小**的
 * `cellTooltipGrid`，重开时同一个注解被映到**另一格**：静默搬行/移格。
 *
 * 实测（真实信封 `structuredata-exported-envelope.json`，删掉最高行注解后走
 * `保存到文件 → 打开场景`）：`cellGrid` 声明 `7×6×19` 而产物 `cellTooltipGrid`
 * 为 `7×5×16`，重开后 17 个注解**全部上移一行**。
 *
 * ## 判据设计（为什么不是"形状相等"一句话）
 *
 * | 组 | 断言 | 抓什么 |
 * |---|---|---|
 * | ① 声明更大 | 形状 == 声明；注解落在**声明行号** `声明高-1-y` | 退回包围盒 ⇒ 判红 |
 * | ② 无声明 | 形状 == 包围盒（与修复前**逐字相同**） | 误伤"内核自创内容"路径 ⇒ 判红 |
 * | ③ 声明更小（畸形） | 按包围盒**扩张**，注解一格不丢 | "截断到声明"式丢数据 ⇒ 判红 |
 * | ④ 非法声明分量 | 视为无声明（`0`/负数/小数/`NaN`） | 声明校验缺失导致空网格 ⇒ 判红 |
 *
 * ⑤ 是**装配-投影往返**：本模块的输出经 `assembleTooltipContent`（生产装配，
 * 用 `sizeRow` 反解）读回，世界坐标必须逐格不变 —— 证明"形状权威"两侧同一条。
 */

import { describe, expect, it } from 'vitest'
import { tooltipPoolOf } from '@/adapters/tooltipPool'
import { TOOLTIP_GRID_NONE } from '@/adapters/files/legacyFields'
import { assembleTooltipContent } from '@/composition/kernelPaletteAssembly'

/** 池的非空格读数：`world y = height - 1 - row`（池自身的编码），带文本。 */
function worldCellsOf(pool: { palette: readonly string[]; grid: readonly number[][][] }): string[] {
  const out: string[] = []
  for (let z = 0; z < pool.grid.length; z++) {
    const slice = pool.grid[z]!
    for (let row = 0; row < slice.length; row++) {
      for (let x = 0; x < slice[row]!.length; x++) {
        const idx = slice[row]![x]!
        if (idx === TOOLTIP_GRID_NONE) continue
        out.push(`${x},${slice.length - 1 - row},${z}=${pool.palette[idx]}`)
      }
    }
  }
  return out.sort()
}

const dims = (pool: { grid: readonly number[][][] }): string =>
  `${pool.grid.length}x${pool.grid[0]!.length}x${pool.grid[0]![0]!.length}`

describe('M1 P3 · 逐格说明池的形状权威 = 载荷声明（不是说明格包围盒）', () => {
  it('① 声明更大：形状 == 声明，且注解落在**声明行号**上（最高行没有说明也不搬行）', () => {
    // 声明 6 高，注解只在世界 y=2（文件 row=3）与 y=1（row=4）—— 最高行（y=5）为空。
    const pool = tooltipPoolOf({ '3,2,5': { tooltip: 'A' }, '9,1,5': { tooltip: 'B' } }, {
      width: 19,
      height: 6,
      depth: 7,
    })
    expect(pool, '有说明 ⇒ 必须产出池').not.toBeNull()
    expect(dims(pool!), '形状必须 == 声明（7x6x19），不是包围盒（6x3x2）').toBe('7x6x19')
    // 行号 = 声明高 - 1 - 世界 y ⇒ y=2 → row 3；y=1 → row 4（与装配侧 `structureRowToWorldY` 自逆）
    expect(pool!.grid[5]![3]![3], 'y=2 必须在 row 3').toBeGreaterThanOrEqual(0)
    expect(pool!.grid[5]![4]![9], 'y=1 必须在 row 4').toBeGreaterThanOrEqual(0)
    expect(pool!.grid[5]![0]!.every((v) => v === TOOLTIP_GRID_NONE), '补出来的最高行必须是 -1，不是 0').toBe(true)
    expect(worldCellsOf(pool!), '世界坐标读数必须与输入逐格相同').toEqual(['3,2,5=A', '9,1,5=B'])
  })

  it('② 无声明：形状 == 包围盒（与修复前**逐字相同**，不误伤内核自创内容）', () => {
    const pool = tooltipPoolOf({ '3,2,5': { tooltip: 'A' }, '9,1,5': { tooltip: 'B' } })
    expect(dims(pool!), '无声明 ⇒ 回落包围盒（宽 10 x 高 3 x 深 6）').toBe('6x3x10')
    expect(worldCellsOf(pool!)).toEqual(['3,2,5=A', '9,1,5=B'])
  })

  it('③ 声明更小（畸形）：按包围盒**扩张**，注解一格不丢', () => {
    const pool = tooltipPoolOf({ '9,4,5': { tooltip: 'A' } }, { width: 2, height: 2, depth: 2 })
    expect(dims(pool!), '声明小于内容 ⇒ 取包围盒（绝不截断注解）').toBe('6x5x10')
    expect(worldCellsOf(pool!)).toEqual(['9,4,5=A'])
  })

  it('④ 非法声明分量视为无声明（0/负数/小数/NaN 不得让网格塌成空或抛错）', () => {
    for (const bad of [0, -3, 1.5, Number.NaN]) {
      const pool = tooltipPoolOf({ '9,4,5': { tooltip: 'A' } }, { width: bad, height: bad, depth: bad })
      expect(pool, `非法声明 ${String(bad)} ⇒ 仍必须产出池`).not.toBeNull()
      expect(dims(pool!), `非法声明 ${String(bad)} ⇒ 回落包围盒`).toBe('6x5x10')
    }
  })

  it('⑤ 装配-投影往返（生产装配函数）：世界坐标逐格不变（形状权威两侧同一条）', () => {
    // 输入是**文件形态**：7 深、6 高、19 宽；只在 row=3/row=5 有说明
    const cellTooltipGrid: number[][][] = []
    for (let z = 0; z < 7; z++) {
      const slice: number[][] = []
      for (let row = 0; row < 6; row++) slice.push(new Array<number>(19).fill(TOOLTIP_GRID_NONE))
      cellTooltipGrid.push(slice)
    }
    cellTooltipGrid[5]![3]![9] = 0
    cellTooltipGrid[5]![5]![8] = 1
    const palette = ['链接主网', '放入过滤标记']
    // 装配（生产函数）：sizeRow = 声明高（`kernelAssembly#tooltipContentOf` 同一条）
    const cells = assembleTooltipContent({ cellTooltipGrid, tooltipPalette: palette, sizeRow: 6 })
    // 投影（本模块）：声明尺寸同传
    const pool = tooltipPoolOf(cells, { width: 19, height: 6, depth: 7 })
    expect(pool, '装配产出的逐格内容必须能投影回池').not.toBeNull()
    expect(dims(pool!), '往返后形状 == 文件声明').toBe('7x6x19')
    // 逐格文本按**世界坐标**相同（装配 → 池 → 装配 是恒等）
    const roundTrip = assembleTooltipContent({
      cellTooltipGrid: pool!.grid,
      tooltipPalette: pool!.palette,
      sizeRow: 6,
    })
    expect(roundTrip, '世界坐标逐格文本必须与第一次装配**逐字相同**').toEqual(cells)
  })
})
