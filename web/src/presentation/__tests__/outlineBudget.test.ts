/**
 * B-5（#38）— 描边 mask 通道的**预算结算**断言（`presentation/outlineBudget.ts`，原 `pure/outlineLimits.ts`）。
 *
 * 背景：#38「完成定义」要求「命中总数与既有 ≤500 口径对齐——超出截断 + 可辨认提示，
 * 不得静默失效」，并明确「现状 `extraMaskMeshes` 通道无上限的问题本任务一并收口」。
 * `drw.bindSelectionOutline` 的通道装配走本函数，故在此逐项钉死：
 *  - 总量 ≤ 上限；
 *  - 选择/悬停 mask 优先占预算，附加 mask 用余额、超出即截断；
 *  - 截断量可从 `dropped` 读出（上层的"可辨认提示"唯一依据）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { OUTLINE_MASK_LIMIT, applyOutlineMaskBudget } from '@/presentation/outlineBudget'

const range = (n: number, tag: string): string[] => Array.from({ length: n }, (_, i) => `${tag}${i}`)

describe('B-5 描边预算：≤500 口径与 extraMaskMeshes 收口', () => {
  it('口径常量 = 500（与 SelectionHighlightProvider 自保值同源）', () => {
    expect(OUTLINE_MASK_LIMIT).toBe(500)
  })

  it('选择/悬停 + 附加 都在额度内 ⇒ 全额通过，无截断', () => {
    const b = applyOutlineMaskBudget(range(3, 's'), range(4, 'x'))
    expect(b.all).toEqual([...range(3, 's'), ...range(4, 'x')])
    expect(b.total).toBe(7)
    expect(b.shown).toBe(7)
    expect(b.dropped).toBe(0)
  })

  it('附加通道超出上限 ⇒ 截断到上限，`dropped` 报出被丢弃的数量（不静默）', () => {
    const b = applyOutlineMaskBudget([], range(OUTLINE_MASK_LIMIT + 120, 'x'))
    expect(b.all).toHaveLength(OUTLINE_MASK_LIMIT)
    expect(b.total).toBe(OUTLINE_MASK_LIMIT + 120)
    expect(b.shown).toBe(OUTLINE_MASK_LIMIT)
    expect(b.dropped).toBe(120)
    // 前 N 条保留（顺序稳定 ⇒ 截断结果确定，不是"整体失效"）
    expect(b.all[0]).toBe('x0')
    expect(b.all.at(-1)).toBe(`x${OUTLINE_MASK_LIMIT - 1}`)
  })

  it('选择/悬停 mask 优先占预算：附加只能用余额', () => {
    const b = applyOutlineMaskBudget(range(OUTLINE_MASK_LIMIT - 2, 's'), range(10, 'x'))
    expect(b.shown).toBe(OUTLINE_MASK_LIMIT)
    expect(b.dropped).toBe(8)
    expect(b.all.slice(0, OUTLINE_MASK_LIMIT - 2)).toEqual(range(OUTLINE_MASK_LIMIT - 2, 's'))
    expect(b.all.slice(OUTLINE_MASK_LIMIT - 2)).toEqual(['x0', 'x1'])
  })

  it('选择/悬停 已占满 ⇒ 附加整条被截断（总量仍恰为上限，不越界）', () => {
    const b = applyOutlineMaskBudget(range(OUTLINE_MASK_LIMIT, 's'), range(5, 'x'))
    expect(b.shown).toBe(OUTLINE_MASK_LIMIT)
    expect(b.dropped).toBe(5)
  })

  it('空输入 ⇒ 空输出（既有"无选择不动通道"的行为不变）', () => {
    const b = applyOutlineMaskBudget([], [])
    expect(b.all).toEqual([])
    expect(b.total).toBe(0)
    expect(b.shown).toBe(0)
    expect(b.dropped).toBe(0)
  })
})

/**
 * ## 接线判据（#289 P10d D3b，Lead 要求的「同一常量、同一 budget」）
 *
 * 上面那组判据证明**算法**对；本组证明**生产真的在用它**。
 * 两者缺一不可：只证算法 ⇒ 可能出现"新模块正确但没人用"（本工程已多次踩到，
 * 如 `annotationPlan`/`outlinePlan`/`compileScene` 都曾有零生产消费者）。
 */
describe('D3b 接线：生产消费者读新层，且**常量只有一个来源**', () => {
  const readSource = (rel: string): string =>
    fs.readFileSync(path.join(process.cwd(), 'src', rel), 'utf8').replace(/\r\n/g, '\n')

  /**
   * 三处生产消费者必须**都**从新层取（旧层模块已随之删除）。
   *
   * 判据是**逐文件命名**的，不是"全树 count > 0"：后者会让"三处里只接了一处"漏过。
   */
  const CONSUMERS = [
    'render/mesh/selectionHighlightProvider.ts',
    'runtime/drw.ts',
    'pure/itemOutlinePlan.ts',
    'shared/viewport/EmbedViewport.vue',
  ] as const

  for (const rel of CONSUMERS) {
    it(`${rel} 从 \`presentation/outlineBudget\` 取口径`, () => {
      const src = readSource(rel)
      expect(src, `${rel} 必须从新层取（旧 \`pure/outlineLimits\` 已删除）`).toContain('@/presentation/outlineBudget')
      expect(src, `${rel} 不得再引用已删除的旧模块`).not.toContain('@/pure/outlineLimits')
    })
  }

  it('旧模块**已删除**（不是保留转发 —— 转发即"并存"，且撞 barrel 禁令）', () => {
    expect(fs.existsSync(path.join(process.cwd(), 'src', 'pure', 'outlineLimits.ts')), '旧模块必须真的没了').toBe(
      false,
    )
  })

  it('**反空洞真**：全树不得再有第二份 `500` 口径字面量（否则两处会漂移）', () => {
    // 本判据把"同一个数"从**约定**变成**可机械检查的事实**：
    // 旧实现的文件头写明"散落的字面量正是口径漂移的来源"，这条就是那句话的执行面。
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) {
          if (ent.name === '__tests__' || ent.name === 'node_modules') continue
          walk(full)
        } else if (/\.(ts|vue)$/.test(ent.name)) files.push(full)
      }
    }
    walk(path.join(process.cwd(), 'src'))
    /** 剥注释与字符串：散文里出现 `500` 是说明，不是口径。 */
    const codeOnly = (text: string): string =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    const offenders = files
      .filter((abs) => !abs.endsWith(path.join('presentation', 'outlineBudget.ts')))
      // **只查 `.ts`**：`.vue` 的 `<style>` 里 `font-weight: 500`/`z-index: 500`
      // 与描边口径无关（实测算进来会产生 4 处假红 —— "判据比它要测的东西更宽"）；
      // 而口径的**定义点**必须是 `.ts`。
      .filter((abs) => abs.endsWith('.ts'))
      .filter((abs) => {
        const src = codeOnly(fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n'))
        // 只查描边相关文件
        if (!/outline|mask/i.test(src)) return false
        // ## 判据的第三次修正是**赋值形态**（前两版都不行，两边的错都实测过）
        //
        //  · 第一版 `(limit|max)\s*[:=]\s*500`：**空洞** —— 注入
        //    `const MASK_LIMIT_FALLBACK = 500` 时**不判红**（只覆盖我预期的写法）。
        //  · 第二版 `\b500\b`：**过宽** —— `render/viewport/renderViewport.ts:67`
        //    的 `500` 是**相机远裁剪面**（`OrthographicCamera(..., 0.1, 500)`），
        //    与描边无关，产生**真**假红。
        //
        // 两者的区别是**语法角色**：口径必然是**赋值**（`X = 500`），
        // 而相机远裁剪面是**实参**（`500,`）。⇒ 判据取 `= 500`。
        return /=\s*500\b/.test(src)
      })
      .map((abs) => path.relative(path.join(process.cwd(), 'src'), abs).replace(/\\/g, '/'))
    expect(offenders, `描边上限不得有第二份字面量，实测：${offenders.join(', ')}`).toEqual([])
    // **反空洞真**：用内存样本直接验证判据的两端（不依赖树里恰好有没有重复）。
    // 这三条正是上面三段注释里实测过的三个形态。
    expect(codeOnly('const MASK_LIMIT_FALLBACK = 500'), '① 任意命名的赋值必须被抓到').toMatch(/=\s*500\b/)
    expect(codeOnly('const L = 500'), '② 短名赋值同样必须被抓到').toMatch(/=\s*500\b/)
    expect(
      codeOnly('new THREE.OrthographicCamera(-fs/2, fs/2, 0.1, 500,)'),
      '③ 相机远裁剪面（实参形态）**不得**被判红',
    ).not.toMatch(/=\s*500\b/)
    expect(codeOnly('// 上限 500（注释不是口径）'), '④ 注释里的 500 不算法口径').not.toMatch(/=\s*500\b/)
  })
})
