/**
 * **K2：数学契约样本逐条 + 本格式 profile 的构造正确性**
 * （「K2 旧格式往返固定样本（含数学契约样本）通过」；
 * `docs/contracts/web-kernel-geometry-contract.md` §7（轴序 / 原点 profile，含「切分」表）。
 *
 * ## 这个文件证明的是什么（**与 `mathContract.test.ts` 不重复**）
 *
 * `mathContract.test.ts` 的样本证明：**给定正确的 profile，数学给出正确结果**
 * （`AXIS_PROFILE_SAMPLES` 是 `(输入, profile, 期望)` 三元组）。
 * 本文件证明的是切分表的另一半：**这个具体格式的 profile 构造正确** ——
 * 即 `mcCellGridAxisProfile(rowCount)` 的 `permutation`/`signs`/`origin`
 * 确实对应 `docs/contracts/format-*.md` 里写的 `cellGrid[z][row][col]` + `row 0 = 顶部`
 * 与 `web-kernel-geometry-contract.md` §2 的右手 Y-up 场景约定。
 *
 * > 契约原文（`web-kernel-geometry-contract.md` §7）：
 * > 「这个切分让"适配器写错了 profile"与"数学算错了"**不会长得一模一样**。」
 *
 * 故本文件的断言**不复制**样本 profile 再自证；它做两件互补的事：
 *  1. **逐条跑** `AXIS_PROFILE_SAMPLES`（正方向：证明这条链在本仓可用作判据）；
 *  2. **断言本格式 profile 与样本的关系**（含"**不等价**"这一如实结论 ——
 *     强行声称等价才是错的，见 `mcAxisProfile.ts` 文件头的推导）；
 *  3. **负对照**：把 profile 换成 identity（等价于"忽略轴序、直接返回输入"）
 *     ⇒ 样本第 2/3 条与 MC 的真实换算**同时**判红。
 *
 * ## 铁律 6（CRLF）
 *
 * 读契约文档经 `replace(/\r\n/g,'\n')`（下面逐条给依据行号时会做子串匹配）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  applyAxisProfile,
  AXIS_PROFILE_SAMPLES,
  checkAxisProfileSamples,
  MATH_CONTRACT,
  approxVec3,
  approxNumber,
} from '@/domain/spatial'
import {
  AXIS_EQUIVALENCE_PROBE_INPUTS,
  isUsableMcCellGridProfile,
  MC_CELL_GRID_PERMUTATION,
  MC_CELL_GRID_SIGNS,
  mcCellGridAxisProfile,
  mcCellToScene,
  mcProfileEquivalenceNotes,
  mcSceneToCell,
  profilesEquivalentOn,
} from '@/adapters/files/mcAxisProfile'
import { cellGridIndexToScene } from '@/adapters/files/legacyFields'

// ─────────────────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────────────────

const WEB_ROOT = process.cwd()

/** 读契约文档并归一化行尾为 LF（铁律 6）。 */
function readDoc(rel: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, '..', rel), 'utf8').replace(/\r\n/g, '\n')
}

/** 逐行取行号（1-based）—— 用于"依据行号"的证据输出。 */
function lineOf(text: string, needle: string): number {
  const idx = text.split('\n').findIndex((l) => l.includes(needle))
  return idx + 1
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、固定样本逐条（正方向）
// ─────────────────────────────────────────────────────────────────────────────

describe('K2-1 数学契约样本**逐条**通过（正方向）', () => {
  it('反空洞真：样本确实有 3 条、且**各含不同 profile**（否则"逐条"是在同一条上重复）', () => {
    expect(AXIS_PROFILE_SAMPLES.length).toBe(3)
    const ids = AXIS_PROFILE_SAMPLES.map((s) => s.profile.id)
    expect(new Set(ids).size, '三条样本必须是不同的 profile').toBe(3)
    // 至少有一条**换轴**（permutation 不是恒等）—— 这是"不凭名称猜约定"的载体。
    expect(AXIS_PROFILE_SAMPLES.some((s) => s.profile.permutation.join(',') !== '0,1,2'), '样本必须含换轴情形').toBe(true)
  })

  it('逐条：`applyAxisProfile(input, profile)` == `expected`（在 `MATH_CONTRACT.positionEps` 容限内）', () => {
    const results: string[] = []
    for (const s of AXIS_PROFILE_SAMPLES) {
      const got = applyAxisProfile(s.input, s.profile)
      const ok = approxVec3(got, s.expected, MATH_CONTRACT.positionEps)
      results.push(`${s.name}: ${ok ? '通过' : `失败（期望 ${JSON.stringify(s.expected)}，实得 ${JSON.stringify(got)}）`}`)
      expect(ok, `${s.name}（B1 对照表的 K2 一节逐条记录本结果）`).toBe(true)
    }
    expect(results.length).toBe(AXIS_PROFILE_SAMPLES.length)
  })

  it('`checkAxisProfileSamples()` 返回空数组（同一判据的官方入口，本文件不另写一份）', () => {
    expect(checkAxisProfileSamples()).toEqual([])
  })

  it('容限来自 `MATH_CONTRACT`（不在测试里各写魔数 —— 契约明令）', () => {
    expect(MATH_CONTRACT.positionEps).toBeGreaterThan(0)
    expect(MATH_CONTRACT.rotationEps).toBeGreaterThan(0)
    expect(approxNumber(1, 1 + MATH_CONTRACT.positionEps / 2)).toBe(true)
    expect(approxNumber(1, 1 + MATH_CONTRACT.positionEps * 10)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 二、本格式 profile 的构造正确性（切分表的另一半）
// ─────────────────────────────────────────────────────────────────────────────

describe('K2-2 **本格式**（MC `cellGrid`）的 profile 构造正确 —— 依据逐条给行号', () => {
  it('每一条依据都在契约文档里**真实存在**（行号可复算，不是凭记忆写的）', () => {
    const sceneContract = readDoc('docs/contracts/format-scene-file.md')
    const mbContract = readDoc('docs/contracts/format-multiblock-doc.md')
    const geoContract = readDoc('docs/contracts/web-kernel-geometry-contract.md')

    // ① `cellGrid` 是 `[z][row][col]`
    expect(lineOf(sceneContract, '`cellGrid` | array | `[z][row][col]`'), 'format-scene-file.md 的 cellGrid 形状行').toBeGreaterThan(0)
    // ② row 0 = 顶部
    expect(mbContract, 'format-multiblock-doc.md 明写 row 0 = 顶部').toContain('row 0 = 顶部')
    // ③ 场景右手 Y-up
    expect(geoContract, 'geometry-contract 明写右手 Y-up').toContain("handedness = 'right'")
    expect(geoContract, 'geometry-contract 明写 up=y').toContain("up         = 'y'")
    // ④ 既有实现的换算公式（源码，不是文档）
    const vecSrc = fs.readFileSync(path.join(WEB_ROOT, 'src', 'pure', 'vec.ts'), 'utf8').replace(/\r\n/g, '\n')
    expect(vecSrc, '既有实现逐字：sizeRow - 1 - row').toContain('return sizeRow - 1 - row')
    expect(vecSrc, '既有注释逐字：row 0 = top').toContain('row (0 = top) to world Y (0 = bottom)')
  })

  it('profile 的三个分量逐项等于**推导**结果（不是抄样本）', () => {
    const p = mcCellGridAxisProfile(4)
    // x ← col、y ← row（经符号反向）、z ← zSlice ⇒ 不换轴。
    expect([...p.permutation]).toEqual([0, 1, 2])
    // 只有 Y 反向（row 0 = 顶部 ⇒ 最高 Y）。
    expect([...p.signs]).toEqual([1, -1, 1])
    // 原点：row = 0 时必须落到最高 Y = rowCount − 1。
    expect(p.origin).toEqual({ x: 0, y: 3, z: 0 })
    expect(isUsableMcCellGridProfile(p)).toBe(true)
    // 常量导出与推导一致。
    expect([...MC_CELL_GRID_PERMUTATION]).toEqual([...p.permutation])
    expect([...MC_CELL_GRID_SIGNS]).toEqual([...p.signs])
  })

  it('**与既有实现逐值一致**（`pure/vec.ts` 的 `sizeRow-1-row` 是判据的独立来源）', () => {
    // 独立复算：直接按既有公式算，与经 profile 的换算比较。
    for (const rowCount of [1, 2, 4, 6, 19]) {
      for (let row = 0; row < rowCount; row++) {
        const expectedY = rowCount - 1 - row // ← 既有实现的公式
        const got = mcCellToScene(0, row, 0, rowCount)
        expect(got.y, `rowCount=${rowCount} row=${row}: 必须与既有公式一致`).toBe(expectedY)
      }
    }
  })

  it('row 0 = **顶部**（最高 Y）、最后一行 = 最低 Y（朝向的正确性，不是"某个公式"）', () => {
    const rowCount = 6
    expect(mcCellToScene(0, 0, 0, rowCount).y, 'row 0 必须是最高的 Y').toBe(rowCount - 1)
    expect(mcCellToScene(0, rowCount - 1, 0, rowCount).y, '最后一行必须是最低的 Y').toBe(0)
    // 单调性：row 越大 Y 越小。
    for (let row = 1; row < rowCount; row++) {
      expect(mcCellToScene(0, row, 0, rowCount).y).toBeLessThan(mcCellToScene(0, row - 1, 0, rowCount).y)
    }
    // col/zSlice 不反向（它们不是行号）。
    expect(mcCellToScene(3, 0, 7, rowCount)).toEqual({ x: 3, y: rowCount - 1, z: 7 })
  })

  it('逆映射从 profile 导出，故往返恒等（"profile 变了而逆映射没变"在结构上不可能）', () => {
    for (const rowCount of [1, 5, 12]) {
      for (let z = 0; z < 3; z++) {
        for (let row = 0; row < rowCount; row++) {
          for (let col = 0; col < 3; col++) {
            const scene = mcCellToScene(col, row, z, rowCount)
            const back = mcSceneToCell(scene, rowCount)
            expect(back, `(${col},${row},${z}) 往返必须恒等`).toEqual({ col, row, zSlice: z })
          }
        }
      }
    }
  })

  it('`legacyFields.cellGridIndexToScene` 与 `mcCellToScene` 是**同一个实现**（只有一处换算）', () => {
    for (const [col, row, z, n] of [[0, 0, 0, 4], [2, 3, 1, 4], [1, 1, 1, 1]] as const) {
      expect(cellGridIndexToScene(col, row, z, n)).toEqual(mcCellToScene(col, row, z, n))
    }
  })

  it('行数非法 ⇒ profile 显式标为不可用（不夹取成 0 —— 那会让"读数错"变成看着正常的几何）', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const p = mcCellGridAxisProfile(bad)
      expect(isUsableMcCellGridProfile(p), `rowCount=${bad} 必须判不可用`).toBe(false)
      expect(Number.isFinite(p.origin!.y)).toBe(false)
    }
    // 合法行数（含 0 与 1）可用。
    for (const okRow of [0, 1, 100]) {
      expect(isUsableMcCellGridProfile(mcCellGridAxisProfile(okRow))).toBe(true)
    }
  })

  it('`rowCount = 0` 的退化情形：结果是 (col, -1, z) —— 显式可算，下游按"无行"处理', () => {
    // 0 行网格不应对应"最高 Y = -1"这种想当然的失败；这里断言的是**不猜**：
    // 公式原样给出 -1，调用方据 `cellGrid.length === 0` 决定拒绝（不是这里静默改）。
    expect(mcCellToScene(0, 0, 0, 0)).toEqual({ x: 0, y: -1, z: 0 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 三、本格式 profile 与样本的关系（含**不等价**这一如实结论）
// ─────────────────────────────────────────────────────────────────────────────

describe('K2-3 本格式 profile 与数学契约样本的关系：**逐值判定**，不用名字', () => {
  it('如实结论：本格式 profile 与三条样本**均不等价**（依据见 `mcProfileEquivalenceNotes`）', () => {
    const notes = mcProfileEquivalenceNotes()
    expect(notes.length, '必须逐条给出结论（三条样本）').toBe(AXIS_PROFILE_SAMPLES.length)
    for (const n of notes) {
      expect(n.evidence.length, `${n.sampleName}: 必须给依据`).toBeGreaterThan(20)
      expect(n.equivalent, `${n.sampleName}: 本格式不是同一形态（换轴 vs 单轴反向+平移）`).toBe(false)
    }
    // 逐值验证"不等价"这个结论（不是只写在表里）。
    const mcProfile = mcCellGridAxisProfile(4)
    for (const s of AXIS_PROFILE_SAMPLES) {
      expect(
        profilesEquivalentOn(mcProfile, s.profile, AXIS_EQUIVALENCE_PROBE_INPUTS),
        `${s.name}: 逐值判定必须是不等价`,
      ).toBe(false)
    }
  })

  it('**唯一的等价情形**：`rowCount = 1` 时退化为"无换轴、无反向、原点为 0"', () => {
    const oneRow = mcCellGridAxisProfile(1)
    // origin.y = 0 ⇒ 与 `origin: null` 在数值上等价。
    expect(oneRow.origin).toEqual({ x: 0, y: 0, z: 0 })
    expect([...oneRow.permutation]).toEqual([0, 1, 2])
    expect([...oneRow.signs]).toEqual([1, -1, 1])
    // 单行网格里 row 只能是 0 ⇒ 符号不产生影响 ⇒ 与 identity **在该输入域上**等价。
    const identity = AXIS_PROFILE_SAMPLES[0]!.profile
    const singleRowInputs = [Object.freeze({ x: 1, y: 0, z: 3 }), Object.freeze({ x: 0, y: 0, z: 0 })]
    expect(profilesEquivalentOn(oneRow, identity, singleRowInputs), '单行输入域上与 identity 等价').toBe(true)
    // 但**输入域一变**（row 非 0）就分道扬镳 —— 这正是"逐值判定必须给输入集"的理由。
    const twoRowInputs = [Object.freeze({ x: 1, y: 1, z: 3 })]
    expect(profilesEquivalentOn(mcCellGridAxisProfile(2), identity, twoRowInputs)).toBe(false)
  })

  it('**负对照（K2 要求）**：profile 换成 identity ⇒ 样本第 2/3 条**必须判红**', () => {
    const identity = AXIS_PROFILE_SAMPLES[0]!.profile
    expect(identity.permutation.join(',')).toBe('0,1,2')
    expect(identity.origin, 'identity 无原点平移').toBeNull()

    const failing: string[] = []
    for (const s of AXIS_PROFILE_SAMPLES) {
      // 用 identity 代替样本自己的 profile —— 等价于"忽略轴序、直接返回输入"。
      const got = applyAxisProfile(s.input, identity)
      if (!approxVec3(got, s.expected, MATH_CONTRACT.positionEps)) failing.push(s.name)
    }
    // 第 1 条（identity 本身）**不**判红（它就是 identity）；第 2/3 条必须判红。
    expect(failing.length, '必须至少有两条判红').toBeGreaterThanOrEqual(2)
    expect(failing).toContain(AXIS_PROFILE_SAMPLES[1]!.name)
    expect(failing).toContain(AXIS_PROFILE_SAMPLES[2]!.name)
    expect(failing, '第 1 条不该被判红（它本来就是 identity）').not.toContain(AXIS_PROFILE_SAMPLES[0]!.name)
  })

  it('**负对照（本格式面）**：忽略 profile 直接返回输入 ⇒ row 0 落到**底部**，几何整体翻转', () => {
    /** **对照实现**：`identity`（不换轴、不反向、不平移）。 */
    const naiveIdentity = (col: number, row: number, z: number): { x: number; y: number; z: number } => ({ x: col, y: row, z: z })
    const rowCount = 6
    // 真实实现：row 0 在**顶部**。
    expect(mcCellToScene(0, 0, 0, rowCount).y).toBe(5)
    // 对照实现：row 0 在 0（底部）—— 整个结构上下翻转。
    expect(naiveIdentity(0, 0, 0).y, '对照实现让顶部落到最下面').toBe(0)
    expect(naiveIdentity(0, 0, 0).y).not.toBe(mcCellToScene(0, 0, 0, rowCount).y)
    // 且两者对所有 row>0 都不同（不是只有 row 0 的巧合）。
    for (let row = 1; row < rowCount; row++) {
      expect(naiveIdentity(0, row, 0).y).not.toBe(mcCellToScene(0, row, 0, rowCount).y)
    }
  })

  it('**负对照**：只反向不加原点 ⇒ 同样错（`AXIS_PROFILE_SAMPLES[2]` 名字里那句"漏加即判红"）', () => {
    /** **对照实现**：有反向、但漏掉原点项。 */
    const noOriginProfile = {
      id: 'mc/no-origin',
      permutation: Object.freeze([0, 1, 2]) as readonly [number, number, number],
      signs: Object.freeze([1, -1, 1]) as readonly [number, number, number],
      origin: null,
    }
    const rowCount = 6
    // `0 * -1 === -0`，而 `-0 === 0` 为 true 但 `Object.is(-0, 0)` 为 false。
    // 判据用 `Object.is`（与 `domain/identity.canonicalize` 把 `-0` 归一成 `'0'` 同一口径），
    // 故这里断言的是"符号反向**确实发生了**"（`Object.is` 看得见它），而不是裸 `toBe`。
    expect(Object.is(applyAxisProfile({ x: 0, y: 0, z: 0 }, noOriginProfile).y, -0), '对照实现给 row 0 得到 -0（反向生效但原点缺失）').toBe(true)
    expect(mcCellToScene(0, 0, 0, rowCount).y, '真实实现给 row 0 得到 5').toBe(5)
    expect(isUsableMcCellGridProfile(noOriginProfile) && noOriginProfile.origin !== null, '对照实现没有原点项').toBe(false)
    // 逐值判定：两者在所有 row 上都不同。
    const inputs = [0, 1, 5].map((row) => Object.freeze({ x: 0, y: row, z: 0 }))
    expect(profilesEquivalentOn(mcCellGridAxisProfile(rowCount), noOriginProfile, inputs)).toBe(false)
    // 用**非零** row 证明差异不是"只有 row 0 的 -0 噪音"：对照实现把 row 1 映到 -1，真实实现映到 4。
    expect(applyAxisProfile({ x: 0, y: 1, z: 0 }, noOriginProfile).y, '对照实现：row 1 → -1').toBe(-1)
    expect(mcCellToScene(0, 1, 0, rowCount).y, '真实实现：row 1 → 4').toBe(4)
  })

  it('`AXIS_EQUIVALENCE_PROBE_INPUTS` 含对"反向 vs 不反向"敏感的项（否则等价判定会假绿）', () => {
    expect(AXIS_EQUIVALENCE_PROBE_INPUTS.length).toBeGreaterThanOrEqual(3)
    // 至少一条 y != 0（否则反向与不反向分不开）。
    expect(AXIS_EQUIVALENCE_PROBE_INPUTS.some((p) => p.y !== 0), '必须有 y≠0 的探针').toBe(true)
    // 至少一条全非零（否则换轴与不换轴分不开）。
    expect(AXIS_EQUIVALENCE_PROBE_INPUTS.some((p) => p.x !== 0 && p.y !== 0 && p.z !== 0), '必须有三分量互异的探针').toBe(true)
  })

  it('`mcProfileEquivalenceNotes` 的 `sampleName` 与样本逐条对得上（表不得腐烂）', () => {
    const names = mcProfileEquivalenceNotes().map((n) => n.sampleName)
    for (const s of AXIS_PROFILE_SAMPLES) {
      expect(names, `样本「${s.name}」必须在结论表里`).toContain(s.name)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 四、证据输出（供对照表逐条抄录）
// ─────────────────────────────────────────────────────────────────────────────

describe('K2-4 证据：逐条结果可被机械抄录（对照表来源）', () => {
  it('产出一张 (样本名, 通过/失败, 依据) 的表，且**全部通过**', () => {
    const rows = AXIS_PROFILE_SAMPLES.map((s) => {
      const got = applyAxisProfile(s.input, s.profile)
      return {
        name: s.name,
        pass: approxVec3(got, s.expected, MATH_CONTRACT.positionEps),
        evidence: `profile(${s.profile.permutation.join(',')}|${s.profile.signs.join(',')}|origin=${s.profile.origin ? 'set' : 'null'}) → ${JSON.stringify(got)}`,
      }
    })
    expect(rows.every((r) => r.pass), `K2 逐条结果：\n${rows.map((r) => `${r.name} | ${r.pass ? '通过' : '失败'} | ${r.evidence}`).join('\n')}`).toBe(true)
    // 表本身可打印（这是"逐条给样本名 + 通过/失败 + 依据"的可执行形式）。
    for (const r of rows) {
      expect(r.name.length).toBeGreaterThan(0)
      expect(r.evidence.length).toBeGreaterThan(0)
    }
  })
})
