/**
 * `adapters/files/mcAxisProfile` —— **Minecraft 旧格式的轴序/原点 profile 构造**
 * （#249 §19.2；#254 E2 与 #260 的**切分点**；#260 验收 K2）。
 *
 * ## 为什么本文件存在（这是 #254 明文切给 #260 的那一半）
 *
 * `docs/contracts/web-kernel-geometry-contract.md:211-219` 把这件工作切成两半，
 * 并写明**为什么必须切**：
 *
 * | 面 | 归属 | 验收方式 |
 * |---|---|---|
 * | 数学（给定正确 profile 得到正确结果） | #254（P3） | `AXIS_PROFILE_SAMPLES` + `checkAxisProfileSamples` |
 * | **某具体格式的 profile 构造正确** | **#260（本批，适配器）** | **该格式的往返验收** |
 *
 * > 「这个切分让"适配器写错了 profile"与"数学算错了"**不会长得一模一样**。」
 *
 * ⇒ 复制 `AXIS_PROFILE_SAMPLES` 里的 profile 来"证明"适配器是对的，是**没有证明任何事**：
 * 样本证明的是"这些 profile 喂进数学得到这些输出"。本模块要证明的是另一件事：
 * **这份旧格式的朝向约定确实对应这些 `permutation`/`signs`/`origin`**，而依据是
 * 契约文档与既有实现的**逐行事实**，不是命名直觉。
 *
 * ## 依据（逐条给行号，不凭名称猜）
 *
 * ### 1. 网格下标 → 场景坐标：`[z][row][col]` 且 `row 0 = 顶部`
 *
 * - `docs/contracts/format-scene-file.md:123`：`cellGrid` 是「`[z][row][col]` 的整数下标网格」；
 * - `docs/contracts/format-multiblock-doc.md:210`：「`cellGrid: [ [ [1,1,1],… ] ]` 必填：
 *   `[z][y][x]`（**row 0 = 顶部**，与既有 cellGrid 约定一致）」；
 * - 既有实现：`web/src/render/data/grid.ts:3`（「`def.cellGrid[zSlice][row][column]`；
 *   row 0 = 结构顶（最高 Y）」）与 `web/src/pure/vec.ts:31-34`：
 *
 *   ```ts
 *   // 原文（含注释）：/** Convert cellGrid row (0 = top) to world Y (0 = bottom) *\/
 *   export function structureRowToWorldY(row: number, sizeRow: number): number {
 *     return sizeRow - 1 - row
 *   }
 *   ```
 *
 * ### 2. 场景坐标：右手、Y-up
 *
 * `docs/contracts/web-kernel-geometry-contract.md:48-56`：
 * `handedness='right'`、`up='y'`、`right=(1,0,0)`、`upVector=(0,1,0)`、`forward=(0,0,−1)`。
 *
 * ### 3. 推导
 *
 * 输入三元组取 `(col, row, zSlice)`（网格的枚举顺序），输出取场景 `(x, y, z)`：
 *
 * | 场景轴 | 由谁决定 | 依据 |
 * |---|---|---|
 * | `x` | `col` | `voxelCenterWorld` 的 `v.x = column + …`（`pure/vec.ts:48`） |
 * | `y` | `(rowCount − 1) − row` | `structureRowToWorldY`（`pure/vec.ts:32-34`） |
 * | `z` | `zSlice` | `voxelCenterWorld` 的 `v.z = zSlice + …`（`pure/vec.ts:50`） |
 *
 * ⇒ `permutation = [0, 1, 2]`（不换轴）、`signs = [1, −1, 1]`（只有 Y 反向）、
 * `origin = (0, rowCount − 1, 0)`。
 *
 * ## 这个 profile **不是** `AXIS_PROFILE_SAMPLES[1]`（`yUpToZUp`）
 *
 * 样本第 2 条是"Y-up 世界 → Z-up 世界"的**跨引擎**换轴（`permutation=[0,2,1]`）。
 * Minecraft 的 `cellGrid` **不是**另一套世界坐标系，它是**同一套 Y-up 世界里的一张
 * 以"顶部为第 0 行"编号的表**。两者的数学形态不同（一个是换轴、一个是反向 + 平移），
 * 把它们混为一谈正是"凭名称猜约定"的典型：
 *
 * > **不因为两者都"跟 Y 有关"就套同一个 profile。**
 *
 * 故 {@link MC_AXIS_EQUIVALENCE} 记录的是"本 profile 与样本里的哪些 profile 语义等价"
 * 这一**经过推导**的结论 —— 答案是：**只在 `rowCount = 1` 时**退化为
 * `permutation=[0,1,2]`+`signs=[1,1,1]`+`origin=null` 的 identity 形态；
 * 一般情况下它**不**与任何样本等价（样本里没有"单轴反向 + 原点平移"这一形态）。
 * 这条"不等价"是**如实结论**，不是缺陷 —— 强行声称等价才是。
 *
 * ## 原点为什么必须进 profile（而不是"顺手加一下"）
 *
 * `AXIS_PROFILE_SAMPLES[2]`（`yUpToZUpWithOrigin`）的存在理由就写在它的名字里：
 * 「换轴 + 原点平移（z 分量非零，**漏加即判红**）」。MC 的 `row 0 = 顶部` 同样携带一个
 * 非零原点项（`rowCount − 1`）—— 把它漏掉，`row 0` 会落到地面，整个结构上下翻转。
 * 这正是负对照要抓住的形态。
 */

import { applyAxisProfile, MATH_CONTRACT, approxVec3, type AxisProfile } from '@/domain/spatial'
import type { Vec3 } from '@/domain/scene'

/**
 * MC `cellGrid` 的轴序（**不换轴**）。
 *
 * 依据见文件头 §3：`x←col`、`y←row`（经符号反向）、`z←zSlice`，输入三元组的顺序
 * 就是网格的枚举顺序，故是恒等置换。**不换轴不等于"没有转换"** —— 转换在符号与
 * 原点上（见 `signs`/`origin`）。
 */
export const MC_CELL_GRID_PERMUTATION: readonly [number, number, number] = Object.freeze([0, 1, 2] as const)

/**
 * MC `cellGrid` 的符号：只有 Y 反向。
 *
 * 依据 `pure/vec.ts:32-34` 的 `sizeRow - 1 - row` —— `row` 增大时世界 Y **减小**。
 */
export const MC_CELL_GRID_SIGNS: readonly [number, number, number] = Object.freeze([1, -1, 1] as const)

/**
 * 构造 MC `cellGrid` 的轴序 profile（把网格下标 `(col, row, zSlice)` 映射到场景位置）。
 *
 * `rowCount` 是**显式输入**（不是从某个全局读到的）：profile 是数据，而"这份网格有几行"
 * 是调用方从文件里读到的**事实**。让它当参数而不是让函数自己去看文档，是为了让
 * "拿错行数"在调用点就可见 —— 那正是 `AXIS_PROFILE_SAMPLES[2]` 原点项漏加的同族错误。
 *
 * `origin.y = rowCount − 1`：`row = 0` 时 `(−1)·0 + (rowCount−1) = rowCount−1`（最高 Y），
 * `row = rowCount−1` 时得 `0`（最低 Y）。与 `structureRowToWorldY` 逐值一致。
 */
export function mcCellGridAxisProfile(rowCount: number): AxisProfile {
  if (!Number.isFinite(rowCount) || rowCount < 0) {
    // 行数非法时把非法值**带进 profile**（而不是夹取成 0）：夹取会让"行数读错了"
    // 变成一个看起来正常的 geometry，与 #249 §7「不悄悄夹取并宣称目标已实现」冲突。
    // 调用方（校验层）据 `Number.isFinite(profile.origin.y)` 显式拒绝。
    return Object.freeze({
      id: 'mcCellGrid/rowCountInvalid',
      permutation: MC_CELL_GRID_PERMUTATION,
      signs: MC_CELL_GRID_SIGNS,
      origin: Object.freeze({ x: 0, y: NaN, z: 0 }),
    })
  }
  return Object.freeze({
    id: `mcCellGrid/rows=${rowCount}`,
    permutation: MC_CELL_GRID_PERMUTATION,
    signs: MC_CELL_GRID_SIGNS,
    origin: Object.freeze({ x: 0, y: rowCount - 1, z: 0 }),
  })
}

/** MC `cellGrid` 的 profile 是否可用（行数合法且原点有限）。 */
export function isUsableMcCellGridProfile(profile: AxisProfile): boolean {
  const o = profile.origin
  return o !== null && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z)
}

/**
 * 网格下标 → 场景位置（转发 `mcCellGridAxisProfile` + `applyAxisProfile`）。
 *
 * 本函数是**唯一**的换算出口：不存在第二条"顺手 `sizeRow-1-row`"的写法。
 * 于是"row 0 = 顶部"这条朝向约定只有一处实现，而那份实现被
 * `applyAxisProfile` 的数学契约样本间接覆盖。
 */
export function mcCellToScene(col: number, row: number, zSlice: number, rowCount: number): Vec3 {
  return applyAxisProfile(Object.freeze({ x: col, y: row, z: zSlice }), mcCellGridAxisProfile(rowCount))
}

/**
 * 逆映射：场景位置 → 网格下标（往返的另一半）。
 *
 * 由 profile 的**逐项逆**导出，而不是另写一份 `row = rowCount-1-y` 的相反公式 ——
 * 两份相反公式是漂移的经典来源（其中一份改了另一份没改，往返测试会红，但**只在你碰巧
 * 测到那个方向时**才红）。这里从 `permutation`/`signs`/`origin` 反向求解，
 * 于是"profile 变了而逆映射没变"在结构上不可能。
 */
export function mcSceneToCell(scene: Vec3, rowCount: number): Readonly<{ col: number; row: number; zSlice: number }> {
  const profile = mcCellGridAxisProfile(rowCount)
  const o = profile.origin ?? Object.freeze({ x: 0, y: 0, z: 0 })
  const shifted = [scene.x - o.x, scene.y - o.y, scene.z - o.z]
  // 逆置换：`out[i] = src[perm[i]] * signs[i]` ⇒ `src[perm[i]] = shifted[i] / signs[i]`。
  const src = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const divisor = profile.signs[i] === 0 ? 1 : profile.signs[i]
    // `+ 0` 消掉 IEEE-754 的负零：`0 / -1 === -0`，而 `-0` 与 `0` 在 `Object.is` 下
    // **不相等**（`assert.deepStrictEqual` / 契约侧的值比较都会因此判"往返不恒等"）。
    // 这一步不是美化：往返判据必须建立在 `Object.is` 口径上（`domain/identity` 的
    // `canonicalize` 也显式把 `-0` 归一成 `'0'`），否则"同一格换算出 -0 再算回去"
    // 会产出一个看起来相同、按位不同的下标。
    src[profile.permutation[i]] = shifted[i]! / divisor + 0
  }
  return Object.freeze({ col: src[0]!, row: src[1]!, zSlice: src[2]! })
}

/**
 * **本格式 profile 与 #254 固定样本的关系**（逐条给出结论与依据）。
 *
 * 存在的理由：K2 要求"断言你的格式 profile 与样本中的某个 profile **语义等价**
 * （**或**与契约文档里写的轴序约定一致，逐条给出依据行号）"。
 * 本表把这件事做成数据而不是散文：每条都能被测试逐项核对。
 */
export interface AxisEquivalenceNote {
  /** 固定样本名（`AXIS_PROFILE_SAMPLES[i].name`）。 */
  readonly sampleName: string
  readonly equivalent: boolean
  /** 依据（行号或推导），面向读者。 */
  readonly evidence: string
}

/**
 * 逐条结论。
 *
 * 判据是**逐值的**：对样本输入做两种换算，看结果是否在 `MATH_CONTRACT.positionEps`
 * 内相等 —— 不是比对 `id` 字符串（那会退化成"名字一样就算等价"，
 * 恰好是 #249 §19.2 禁止的"凭名称猜矩阵约定"）。
 */
export function mcProfileEquivalenceNotes(): readonly AxisEquivalenceNote[] {
  return Object.freeze([
    Object.freeze({
      sampleName: 'identity（无换轴、无平移）',
      equivalent: false,
      evidence:
        'identity 的 signs=[1,1,1] 且 origin=null；MC 的 signs=[1,−1,1] 且 origin=(0,rowCount−1,0)。'
        + '逐值判据：rowCount>1 时 `(col, row, z)` 经两者得到不同 y（MC 把 row 0 放到最高 Y，identity 放回 row 本身）。'
        + '依据：pure/vec.ts:32-34（sizeRow−1−row）。',
    }),
    Object.freeze({
      sampleName: 'Y-up → Z-up（输出 x←源x，y←源z，z←−源y；保持右手性）',
      equivalent: false,
      evidence:
        '该样本换轴（permutation=[0,2,1]）而 MC 不换轴（[0,1,2]）。MC 的 cellGrid 不是另一套世界坐标系，'
        + '而是同一 Y-up 世界里以"顶部为第 0 行"编号的表 —— 数学形态不同（换轴 vs 单轴反向+平移）。'
        + '依据：format-multiblock-doc.md:210（[z][y][x]，row 0 = 顶部）+ geometry-contract.md:48-56（场景 Y-up）。',
    }),
    Object.freeze({
      sampleName: '换轴 + 原点平移（z 分量非零，漏加即判红）',
      equivalent: false,
      evidence:
        '同样的换轴差异；另注意该样本 origin 落在 z 上（0,0,64），而 MC 的原点落在 y 上（0,rowCount−1,0）——'
        + '共有的性质是"原点项不可省"（MC 漏掉它会上下翻转），但形态不等价。',
    }),
  ])
}

/** 逐值判定两个 profile 在给定输入集上是否等价（**不用名字**；K2 判据的可执行形式）。 */
export function profilesEquivalentOn(
  a: AxisProfile,
  b: AxisProfile,
  inputs: readonly Vec3[],
  eps: number = MATH_CONTRACT.positionEps,
): boolean {
  for (const p of inputs) {
    if (!approxVec3(applyAxisProfile(p, a), applyAxisProfile(p, b), eps)) return false
  }
  return true
}

/**
 * 样本集上的等价性判定的**输入集**（取自 `AXIS_PROFILE_SAMPLES` 的输入并补几个
 * 会对"反向 vs 不反向"敏感的项）。
 *
 * 为什么必须显式给输入集：两个不同的 profile 在某些输入上恰好给出相同输出
 * （例如 `row = 0` 且 `origin` 抵消时）。只拿一个输入做等价判定会得出"等价"的
 * 假结论 —— 那正是"用名字判等价"的数值版本。
 */
export const AXIS_EQUIVALENCE_PROBE_INPUTS: readonly Vec3[] = Object.freeze([
  Object.freeze({ x: 1, y: 2, z: 3 }),
  Object.freeze({ x: 0, y: 0, z: 0 }),
  Object.freeze({ x: 0, y: 3, z: 0 }),
  Object.freeze({ x: -1, y: -2, z: -3 }),
])
