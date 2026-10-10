/**
 * `domain/spatial` —— **坐标约定、仿射变换、显式枢轴、父链求值与多选枢轴策略**
 * （#249 §19.2、§14 A26；契约 §1.1 负对照）。
 *
 * ## 1. 坐标约定（#249 §19.2 第 1 段）
 *
 * 「场景采用有明确约定的**右手、Y-up** 坐标；Minecraft 单位默认映射一个场景单位，
 * 文件的轴序/原点转换**只在适配器执行**」。
 *
 * 本模块把这三件事拆成三层，不混在一起：
 *
 * | 层 | 职责 | 归属 |
 * |---|---|---|
 * | 约定（convention） | 右手 + Y-up 的基向量与手性判定 | **本模块**（数学契约） |
 * | 变换（transform） | 仿射表达、求值、逆、父链 | **本模块** |
 * | 格式映射（轴序 / 原点） | 某个外部格式的轴序与原点平移 | **适配器**（`adapters/files`，实现归 #260） |
 *
 * 故本模块**没有**任何具体格式的知识，也不做"1 格 = N 单位"这类**具体**换算
 * （那属适配器）。它只提供**由显式 profile 参数化**的通用转换
 * （{@link applyAxisProfile}），以及固定样本期望（{@link AXIS_PROFILE_SAMPLES}）供
 * 往返验收引用 —— 这正是 #254 E2「交付数学契约与固定样本期望，适配实现归 #260」。
 *
 * ## 2. 仿射表达不丢剪切（#249 §19.2 第 2 段末）
 *
 * 「变换数学保留仿射表达能力，**不以有损 TRS 分解悄悄丢剪切**」。
 *
 * 本模块的求值货币是 {@link Affine}（4×4 矩阵），**不是** TRS 三元组。
 * `domain/scene` 的 `Transform`（TRS + pivot）是**创作**形态，它到仿射的映射
 * {@link toAffine} 是**单射**；反向 {@link decomposeTrs} 可能丢剪切，因此它
 * **返回 `Result` 并在存在剪切时显式拒绝**（`InvalidValue.params.shear` 带量值），
 * 绝不静默丢弃。
 *
 * ## 3. 显式枢轴（#249 §19.2 第 2 段）
 *
 * 「对象有局部变换和**显式原点/枢轴**语义；世界变换由父链求值。对象原点**不是**
 * 随网格包围盒变化而自动移动的中心」。
 *
 * 枢轴是 `Transform` 的**持久**字段，由创作写入，任何求值路径都不改它。
 * 多选时的"选择包围盒中心"是**工具参数**（{@link PivotStrategy}），
 * 一次交互结束即失效 —— 它**不会**被写进对象枢轴。
 * 两者的分离就是 A26 负对照「用包围盒中心冒充持久枢轴」的落点。
 *
 * ## 4. 奇异逆变换明确拒绝（#249 §19.2）
 *
 * {@link invertAffine} 返回 `Result`；判据是行列式绝对值 ≤
 * {@link MATH_CONTRACT.singularDeterminantEps}。
 *
 * ## 5. 父链无环（#249 §19.2）
 *
 * {@link worldMatrix} 先经 `domain/scene#sceneParentChain` 判环，有环即
 * **显式拒绝**（`InvalidValue{reason:'parentCycle'}`），不递归到栈溢出。
 *
 * ## 6. 集合不形成变换父子（#249 §19.2）
 *
 * `ObjectCollection.members` 与 `SceneObject.parentId` 在 `domain/scene` 里是两个
 * 不同字段；本模块的父链求值**只**看 `parentId`。
 *
 * ## 矩阵布局（**读这一节再看代码**）
 *
 * `Affine` 用**列主序**存储（与 Three.js 的 `Matrix4.elements` 同布局，
 * `m[12..14]` 是平移）。这个选择带来一个经典陷阱：**存储数组的"行主序读法"
 * 是实际矩阵的转置**。为避免这类错误，本模块内部**只用** {@link at} 访问分量，
 * 其签名是"先逻辑行后逻辑列"：`at(m, row, col) = m.m[col * 4 + row]`。
 * 所有几何量（点变换、行列式、逆、列向量）都从 `at` 推导。
 *
 * 与之配套，{@link multiplyAffine} 的语义是**教科书约定**
 * （`multiplyAffine(a, b)` = `M_a · M_b`，即**先应用 b，再应用 a**）——
 * 与读者对矩阵乘法的预期一致。
 */

import { err, invalidValue, missingTarget, ok, type Result } from './errors'
import { findObject, sceneParentChain, type Quat, type Scene, type Transform, type Vec3 } from './scene'
import { boundsOfPositions, type Aabb } from './geometry'

// ─────────────────────────────────────────────────────────────────────────────
// 数学契约的数值容限（#254 E3：容限在数学契约中写明并被测试引用）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 数值与空间误差容限（**契约常量**，测试直接引用本对象 —— 不各写一份魔数）。
 *
 * #249 §19.2 末段：「数值与空间误差容限在数学契约和测试中明确，**不任意四舍五入
 * 到整数**」。
 *
 * 取值依据：IEEE-754 `double` 有约 15–17 位十进制有效数字；场景坐标量级为
 * 10^0–10^6（MC 1 格 = 1 单位、世界高度 10^2、结构尺寸 10^3），
 * 故 `1e-9` 足够容纳 ~10^6 量级上的累积舍入误差（10^6 × 1e-15 ≈ 1e-9），
 * 同时远小于任何有意义的建模精度（1e-9 单位 = 纳米级）。
 */
export const MATH_CONTRACT = Object.freeze({
  /** 位置/长度的绝对容限（场景单位）。 */
  positionEps: 1e-9,
  /** 旋转分量（四元数）的容限；四元数已归一化，故量级为 1。 */
  rotationEps: 1e-9,
  /** 缩放分量的容限（无量纲）。 */
  scaleEps: 1e-9,
  /** 枢轴比较容限（场景单位）。 */
  pivotEps: 1e-9,
  /** 判定"仿射带剪切"的容限（见 {@link shearMagnitude}）。 */
  shearEps: 1e-9,
  /**
   * 判定"不可逆"的行列式绝对值下限。
   *
   * 为什么不是 `=== 0`：浮点下"数学上奇异"的矩阵其行列式常是一个 ~1e-17 的
   * 非零数。取 `1e-12` 意味着"某轴缩放小于 1e-4"被判不可逆 —— 这是**有意的**：
   * 那种变换在场景单位下已无法稳定求逆（1e-4 单位 = 0.1 微米）。
   */
  singularDeterminantEps: 1e-12,
  /** 单位向量/正交性比较容限。 */
  unitScaleEps: 1e-9,
})

export function approxVec3(a: Vec3, b: Vec3, eps: number = MATH_CONTRACT.positionEps): boolean {
  // `NaN` 必须判**不等**：`Math.abs(NaN - NaN) <= eps` 是 false，故这里天然正确；
  // 但显式写出来是为了让"NaN 与自身也必须不等"成为**有意**的语义而非巧合
  // （见 `mathContract.test.ts > 非有限值不被容限比较吞掉`）。
  if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(a.z)) return false
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.z)) return false
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.z - b.z) <= eps
}

/**
 * 两个四元数是否在容限内表达同一旋转（`q` 与 `-q` 是同一旋转，故两向都比）。
 *
 * 非有限输入判不等（与 {@link approxVec3} 同一政策）。
 */
export function approxQuat(a: Quat, b: Quat, eps: number = MATH_CONTRACT.rotationEps): boolean {
  for (const v of [a.x, a.y, a.z, a.w, b.x, b.y, b.z, b.w]) if (!Number.isFinite(v)) return false
  const same = Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.z - b.z) <= eps && Math.abs(a.w - b.w) <= eps
  if (same) return true
  return Math.abs(a.x + b.x) <= eps && Math.abs(a.y + b.y) <= eps && Math.abs(a.z + b.z) <= eps && Math.abs(a.w + b.w) <= eps
}

/** 两个标量是否在容限内相等（非有限输入判不等，理由同 {@link approxVec3}）。 */
export function approxNumber(a: number, b: number, eps: number = MATH_CONTRACT.positionEps): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return Math.abs(a - b) <= eps
}

// ─────────────────────────────────────────────────────────────────────────────
// 显式命名的取整工具（**唯一**允许出现 `Math.floor` 的地方）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把标量吸附到给定的像素/网格格距。
 *
 * ## 为什么它单独存在，而不是"顺手取整"
 *
 * #254 E3 要求「**不任意四舍五入到整数**」。要满足这条，光靠"我们没写取整"是不够的
 * —— 那无法被检查。故把它变成一条**结构事实**：
 *
 *  - 本模块里 `Math.floor` **只**出现在本函数（由 `mathContract.test.ts` 的静态判据
 *    逐字断言）；
 *  - 函数名 `pixelSnap` 显式说明它的语义是**像素吸附**（呈现侧的需求），
 *    不是坐标求值；
 *  - 没有**任何**求值路径（`toAffine` / `worldMatrix` / `transformPoint` / …）
 *    调用它。
 *
 * 于是"坐标被取整"这件事要么不发生，要么**必须**经过一个名字就写着"我在吸附
 * 到像素格"的函数 —— 后者在 review 时无法被误认成普通数学。
 */
export function pixelSnap(value: number, gridSize: number): number {
  if (!(gridSize > 0) || !Number.isFinite(gridSize)) return value
  return Math.floor(value / gridSize + 0.5) * gridSize
}

// ─────────────────────────────────────────────────────────────────────────────
// 坐标约定（右手、Y-up）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 场景坐标约定（**冻结**）。
 *
 * 右手系 + Y 轴向上。基向量显式列出而不是"隐含在矩阵乘法的写法里"：
 * 约定是可断言的**数据**，不是一种需要靠读代码推断的惯例。
 */
export const COORDINATE_CONVENTION = Object.freeze({
  handedness: 'right' as const,
  up: 'y' as const,
  right: Object.freeze({ x: 1, y: 0, z: 0 }),
  upVector: Object.freeze({ x: 0, y: 1, z: 0 }),
  /**
   * 前向（"看向"的方向）。
   *
   * 右手 Y-up 下前向是 **−Z**（`right × up = +Z` 是"向后"）。
   * 这个符号是同类代码最常见的笔误来源，故 {@link isRightHandedYUp}
   * 把它变成一条可执行断言而不是注释。
   */
  forward: Object.freeze({ x: 0, y: 0, z: -1 }),
} satisfies CoordinateConvention)

/**
 * 坐标约定的**形状**（比 {@link COORDINATE_CONVENTION} 的推断类型宽）。
 *
 * 存在的理由：{@link isRightHandedYUp} 必须能接受一个**违反**约定的输入 ——
 * 否则"负对照"在类型层面就写不出来，而 #249 §14 要求负对照必须能真的破坏目标保证。
 * 用一个显式接口（而不是 `typeof COORDINATE_CONVENTION`）使判据接受任何符合形状的
 * 约定，从而可被证伪。
 */
export interface CoordinateConvention {
  readonly handedness: 'right' | 'left'
  readonly up: 'x' | 'y' | 'z'
  readonly right: Vec3
  readonly upVector: Vec3
  readonly forward: Vec3
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return Object.freeze({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  })
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

export function norm(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z)
}

/**
 * 基向量是否构成**右手 Y-up** 系。
 *
 * 三条判据（缺一即 false）：
 *  1. 三者两两正交；
 *  2. 三者均为单位向量；
 *  3. `cross(right, up) === −forward` —— 右手系的**定义**。
 *
 * 若有人把 `forward` 改成 `+z`（左手系的常见笔误），第 3 条立刻判 false。
 */
export function isRightHandedYUp(conv: CoordinateConvention = COORDINATE_CONVENTION): boolean {
  const { right, upVector, forward } = conv
  const unit = MATH_CONTRACT.unitScaleEps
  if (!approxNumber(norm(right), 1, unit) || !approxNumber(norm(upVector), 1, unit) || !approxNumber(norm(forward), 1, unit)) return false
  if (Math.abs(dot(right, upVector)) > unit || Math.abs(dot(right, forward)) > unit || Math.abs(dot(upVector, forward)) > unit) return false
  const n = cross(right, upVector)
  return approxVec3(n, Object.freeze({ x: -forward.x, y: -forward.y, z: -forward.z }), unit)
}

// ─────────────────────────────────────────────────────────────────────────────
// 仿射矩阵（列主序存储；分量一律经 `at` 访问）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 4×4 仿射矩阵，**列主序**存储（`m[12..14]` 是平移，与 Three.js 一致）。
 *
 * 读法见文件头「矩阵布局」一节：**不要**直接按下标解释语义，
 * 用 {@link at}（`at(m, row, col)`）。
 */
export interface Affine {
  readonly m: readonly number[]
}

/** 分量访问：逻辑第 `row` 行、第 `col` 列。列主序存储的**唯一**合法读法。 */
export function at(m: Affine, row: number, col: number): number {
  return m.m[col * 4 + row]
}

export function affine(m: readonly number[]): Affine {
  if (m.length !== 16) throw new Error(`Affine 需要 16 个分量，得到 ${m.length}`)
  return Object.freeze({ m: Object.freeze([...m]) })
}

/** 由逻辑行主序的 16 个分量构造（测试与固定样本用；避免手写列主序）。 */
export function affineFromRows(rows: readonly number[]): Affine {
  if (rows.length !== 16) throw new Error(`affineFromRows 需要 16 个分量，得到 ${rows.length}`)
  const out = new Array<number>(16)
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) out[col * 4 + row] = rows[row * 4 + col]
  return affine(out)
}

/** 逻辑行主序的分量（诊断与逐项断言用）。 */
export function affineRows(m: Affine): readonly number[] {
  const out = new Array<number>(16)
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) out[row * 4 + col] = at(m, row, col)
  return Object.freeze(out)
}

export function identityAffine(): Affine {
  return affineFromRows([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
}

export function translationAffine(t: Vec3): Affine {
  return affineFromRows([1, 0, 0, t.x, 0, 1, 0, t.y, 0, 0, 1, t.z, 0, 0, 0, 1])
}

export function scaleAffine(s: Vec3): Affine {
  return affineFromRows([s.x, 0, 0, 0, 0, s.y, 0, 0, 0, 0, s.z, 0, 0, 0, 0, 1])
}

/**
 * 四元数 → 旋转矩阵（归一化后转换）。
 *
 * 零长度四元数返回 `null`（**显式退化**）而不是"当作恒等"：静默退化会让
 * "旋转丢失"变成不可观测的 bug（#249 §7「不悄悄夹取并宣称目标已实现」）。
 */
export function rotationAffine(q: Quat): Affine | null {
  const len = Math.hypot(q.x, q.y, q.z, q.w)
  if (!Number.isFinite(len) || len <= MATH_CONTRACT.rotationEps) return null
  const x = q.x / len
  const y = q.y / len
  const z = q.z / len
  const w = q.w / len
  const xx = x * x
  const yy = y * y
  const zz = z * z
  const xy = x * y
  const xz = x * z
  const yz = y * z
  const wx = w * x
  const wy = w * y
  const wz = w * z
  return affineFromRows([
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), 0,
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), 0,
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy), 0,
    0, 0, 0, 1,
  ])
}

/**
 * 矩阵乘法：`multiplyAffine(a, b)` = `M_a · M_b`（**先应用 b，再应用 a**）。
 *
 * 与教科书列向量约定一致（`(M_a·M_b)·p = M_a·(M_b·p)`）。
 */
export function multiplyAffine(a: Affine, b: Affine): Affine {
  const out = new Array<number>(16)
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += at(a, row, k) * at(b, k, col)
      out[col * 4 + row] = sum
    }
  }
  return affine(out)
}

/** 变换一个点（含平移）。 */
export function transformPoint(m: Affine, p: Vec3): Vec3 {
  return Object.freeze({
    x: at(m, 0, 0) * p.x + at(m, 0, 1) * p.y + at(m, 0, 2) * p.z + at(m, 0, 3),
    y: at(m, 1, 0) * p.x + at(m, 1, 1) * p.y + at(m, 1, 2) * p.z + at(m, 1, 3),
    z: at(m, 2, 0) * p.x + at(m, 2, 1) * p.y + at(m, 2, 2) * p.z + at(m, 2, 3),
  })
}

/** 变换一个方向（**忽略**平移）。 */
export function transformDirection(m: Affine, p: Vec3): Vec3 {
  return Object.freeze({
    x: at(m, 0, 0) * p.x + at(m, 0, 1) * p.y + at(m, 0, 2) * p.z,
    y: at(m, 1, 0) * p.x + at(m, 1, 1) * p.y + at(m, 1, 2) * p.z,
    z: at(m, 2, 0) * p.x + at(m, 2, 1) * p.y + at(m, 2, 2) * p.z,
  })
}

/** 3×3 部分的行列式。 */
export function determinant3(m: Affine): number {
  return (
    at(m, 0, 0) * (at(m, 1, 1) * at(m, 2, 2) - at(m, 1, 2) * at(m, 2, 1)) -
    at(m, 0, 1) * (at(m, 1, 0) * at(m, 2, 2) - at(m, 1, 2) * at(m, 2, 0)) +
    at(m, 0, 2) * (at(m, 1, 0) * at(m, 2, 1) - at(m, 1, 1) * at(m, 2, 0))
  )
}

/** 第 `col` 个**列向量**（3×3 部分的像，即基向量的像）。 */
export function column3(m: Affine, col: number): Vec3 {
  return Object.freeze({ x: at(m, 0, col), y: at(m, 1, col), z: at(m, 2, col) })
}

/**
 * 求逆。**奇异即显式拒绝**（#249 §19.2）。
 *
 * 非仿射输入（最后一行不是 `[0,0,0,1]`）同样显式拒绝：本工程的变换链永远不该
 * 产生投影矩阵，出现即说明接线错误 —— 与其静默求一个错的逆，不如报出来。
 */
export function invertAffine(m: Affine): Result<Affine> {
  const affine_ = Math.abs(at(m, 3, 0)) <= MATH_CONTRACT.positionEps && Math.abs(at(m, 3, 1)) <= MATH_CONTRACT.positionEps && Math.abs(at(m, 3, 2)) <= MATH_CONTRACT.positionEps && Math.abs(at(m, 3, 3) - 1) <= MATH_CONTRACT.positionEps
  if (!affine_) return err(invalidValue({ reason: 'notAffine', det: determinant3(m) }))

  const det = determinant3(m)
  if (!Number.isFinite(det) || Math.abs(det) <= MATH_CONTRACT.singularDeterminantEps) {
    // 明确拒绝：不返回"近似逆"、不夹取缩放（负对照：奇异输入必须判红）
    return err(invalidValue({ reason: 'singularTransform', det }))
  }
  const inv = 1 / det
  const a00 = at(m, 0, 0)
  const a01 = at(m, 0, 1)
  const a02 = at(m, 0, 2)
  const a10 = at(m, 1, 0)
  const a11 = at(m, 1, 1)
  const a12 = at(m, 1, 2)
  const a20 = at(m, 2, 0)
  const a21 = at(m, 2, 1)
  const a22 = at(m, 2, 2)
  const tx = at(m, 0, 3)
  const ty = at(m, 1, 3)
  const tz = at(m, 2, 3)

  const i00 = (a11 * a22 - a12 * a21) * inv
  const i01 = (a02 * a21 - a01 * a22) * inv
  const i02 = (a01 * a12 - a02 * a11) * inv
  const i10 = (a12 * a20 - a10 * a22) * inv
  const i11 = (a00 * a22 - a02 * a20) * inv
  const i12 = (a02 * a10 - a00 * a12) * inv
  const i20 = (a10 * a21 - a11 * a20) * inv
  const i21 = (a01 * a20 - a00 * a21) * inv
  const i22 = (a00 * a11 - a01 * a10) * inv

  return ok(
    affineFromRows([
      i00, i01, i02, -(i00 * tx + i01 * ty + i02 * tz),
      i10, i11, i12, -(i10 * tx + i11 * ty + i12 * tz),
      i20, i21, i22, -(i20 * tx + i21 * ty + i22 * tz),
      0, 0, 0, 1,
    ]),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Transform ⇄ Affine（枢轴显式；剪切不静默丢）
// ─────────────────────────────────────────────────────────────────────────────

function negate(v: Vec3): Vec3 {
  return Object.freeze({ x: -v.x, y: -v.y, z: -v.z })
}

/**
 * `Transform` → 仿射（**单射**，不丢信息）。
 *
 * 语义：对象空间一点 `p` 映射到 `position + R · S · (p − pivot)`，
 * 即 `M = T(position) · R · S · T(−pivot)`。`pivot` 是局部空间里保持不动的点。
 *
 * 零长度旋转四元数时**退化为恒等旋转**：本函数是纯映射、无 `Result` 出口，
 * 校验由 {@link localMatrix}（带 `Result`）承担。需要"拒绝退化旋转"的调用方
 * **必须**走 `localMatrix`。
 */
export function toAffine(t: Transform): Affine {
  const r = rotationAffine(t.rotation) ?? identityAffine()
  return multiplyAffine(
    translationAffine(t.position),
    multiplyAffine(r, multiplyAffine(scaleAffine(t.scale), translationAffine(negate(t.pivot)))),
  )
}

/**
 * 仿射的"剪切量"：3×3 部分各列归一化后，两两夹角的余弦绝对值的最大值。
 *
 * 纯旋转/缩放（含非均匀缩放）的列为正交 ⇒ 0；带剪切 ⇒ 显著大于 0。
 * 与行列式配合可判定"是否能无损 TRS 化"。
 */
export function shearMagnitude(m: Affine): number {
  const c0 = column3(m, 0)
  const c1 = column3(m, 1)
  const c2 = column3(m, 2)
  const l0 = norm(c0)
  const l1 = norm(c1)
  const l2 = norm(c2)
  if (l0 === 0 || l1 === 0 || l2 === 0) return Number.POSITIVE_INFINITY
  const n0 = Object.freeze({ x: c0.x / l0, y: c0.y / l0, z: c0.z / l0 })
  const n1 = Object.freeze({ x: c1.x / l1, y: c1.y / l1, z: c1.z / l1 })
  const n2 = Object.freeze({ x: c2.x / l2, y: c2.y / l2, z: c2.z / l2 })
  return Math.max(Math.abs(dot(n0, n1)), Math.abs(dot(n0, n2)), Math.abs(dot(n1, n2)))
}

/**
 * 仿射 → `Transform`（TRS + pivot）。
 *
 * **可能丢剪切**，故返回 `Result`：
 *  - 带剪切 ⇒ `InvalidValue{reason:'lossyTrsDecomposition'}`（`params.shear` 带量值）；
 *  - 镜像（负行列式）⇒ `InvalidValue{reason:'handednessFlip'}`，因为静默取绝对值
 *    会改变手性，而本工程的约定是右手系；
 *  - 奇异 ⇒ `InvalidValue{reason:'singularTransform'}`。
 *
 * 这是 #249 §19.2「不以有损 TRS 分解悄悄丢剪切」的落点 —— 拒绝而不是丢弃。
 *
 * **枢轴不猜**：枢轴是创作事实，数学上不可从矩阵唯一恢复
 * （`T(p)·R·S·T(−pivot)` 对不同 pivot 可给出同一矩阵）。故返回的 `pivot` 恒为零，
 * 且文档明确"枢轴必须由调用方显式给出"。静默编造枢轴正是 A26 负对照要判红的形态。
 */
export function decomposeTrs(m: Affine): Result<{ transform: Transform }> {
  const det = determinant3(m)
  if (!Number.isFinite(det) || Math.abs(det) <= MATH_CONTRACT.singularDeterminantEps) {
    return err(invalidValue({ reason: 'singularTransform', det }))
  }
  if (det < 0) return err(invalidValue({ reason: 'handednessFlip', det }))
  const shear = shearMagnitude(m)
  if (shear > MATH_CONTRACT.shearEps) {
    return err(invalidValue({ reason: 'lossyTrsDecomposition', shear }))
  }

  const c0 = column3(m, 0)
  const c1 = column3(m, 1)
  const c2 = column3(m, 2)
  const sx = norm(c0)
  const sy = norm(c1)
  const sz = norm(c2)
  const r00 = c0.x / sx
  const r10 = c0.y / sx
  const r20 = c0.z / sx
  const r01 = c1.x / sy
  const r11 = c1.y / sy
  const r21 = c1.z / sy
  const r02 = c2.x / sz
  const r12 = c2.y / sz
  const r22 = c2.z / sz

  const trace = r00 + r11 + r22
  let q: Quat
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    q = Object.freeze({ x: (r21 - r12) / s, y: (r02 - r20) / s, z: (r10 - r01) / s, w: 0.25 * s })
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2
    q = Object.freeze({ x: 0.25 * s, y: (r01 + r10) / s, z: (r02 + r20) / s, w: (r21 - r12) / s })
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2
    q = Object.freeze({ x: (r01 + r10) / s, y: 0.25 * s, z: (r12 + r21) / s, w: (r02 - r20) / s })
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2
    q = Object.freeze({ x: (r02 + r20) / s, y: (r12 + r21) / s, z: 0.25 * s, w: (r10 - r01) / s })
  }

  return ok({
    transform: Object.freeze({
      position: Object.freeze({ x: at(m, 0, 3), y: at(m, 1, 3), z: at(m, 2, 3) }),
      rotation: q,
      scale: Object.freeze({ x: sx, y: sy, z: sz }),
      pivot: Object.freeze({ x: 0, y: 0, z: 0 }),
    }),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 父链求值
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 对象的**局部**矩阵。
 *
 * 显式校验（不返回"看起来能跑"的结果）：
 *  - 对象不存在 ⇒ `MissingTarget`；
 *  - 任一分量非有限 ⇒ `InvalidValue{reason:'nonFiniteTransform'}`；
 *  - 旋转四元数为零长度 ⇒ `InvalidValue{reason:'degenerateRotation'}`。
 */
export function localMatrix(scene: Scene, objectId: string): Result<Affine> {
  const obj = findObject(scene, objectId)
  if (!obj) return err(missingTarget({ objectId }))
  const t = obj.transform
  if (!isFiniteTransform(t)) return err(invalidValue({ reason: 'nonFiniteTransform', objectId }))
  if (rotationAffine(t.rotation) === null) return err(invalidValue({ reason: 'degenerateRotation', objectId }))
  return ok(toAffine(t))
}

/**
 * 对象的**世界**矩阵：`W = M_root · … · M_parent · M_local`
 * （`multiplyAffine` 是教科书约定，故左乘祖先）。
 *
 * 有环即**显式拒绝**（#249 §19.2「父链必须无环」）。
 */
export function worldMatrix(scene: Scene, objectId: string): Result<Affine> {
  const chain = sceneParentChain(scene, objectId)
  if (chain === null) return err(invalidValue({ reason: 'parentCycle', objectId }))
  let acc = identityAffine()
  // chain = [self, parent, …, root]；从自身往上左乘 ⇒ 根在左、自身在右
  for (let i = 0; i < chain.length; i++) {
    const local = localMatrix(scene, chain[i])
    if (!local.ok) return local
    acc = multiplyAffine(local.value, acc)
  }
  return ok(acc)
}

/** 世界变换的逆（供"世界 → 局部"反查）。奇异时透传显式拒绝。 */
export function worldMatrixInverse(scene: Scene, objectId: string): Result<Affine> {
  const w = worldMatrix(scene, objectId)
  if (!w.ok) return w
  return invertAffine(w.value)
}

/** 对象的世界位置（世界矩阵作用于局部原点 `(0,0,0)`）。 */
export function worldPosition(scene: Scene, objectId: string): Result<Vec3> {
  const w = worldMatrix(scene, objectId)
  if (!w.ok) return w
  return ok(transformPoint(w.value, Object.freeze({ x: 0, y: 0, z: 0 })))
}

/**
 * 尝试建立父子关系（**先验环**）。
 *
 * 返回 `Result<null>` 且**不修改**任何东西（场景是值，改动由命令层做）。
 * 本函数是"父链无环"的**准入判据** —— 于是"先设父子再发现成环"不可能发生。
 */
export function canParent(scene: Scene, childId: string, parentId: string | null): Result<null> {
  if (!findObject(scene, childId)) return err(missingTarget({ objectId: childId }))
  if (parentId === null) return ok(null)
  if (parentId === childId) return err(invalidValue({ reason: 'parentCycle', objectId: childId, parentId }))
  if (!findObject(scene, parentId)) return err(missingTarget({ objectId: parentId }))
  // 沿**候选父**向上走：若遇到 child，则挂接会成环；若自身有环也拒绝（数据已损坏）。
  let cur: string | undefined = parentId
  const seen = new Set<string>()
  while (cur !== undefined) {
    if (cur === childId) return err(invalidValue({ reason: 'parentCycle', objectId: childId, parentId }))
    if (seen.has(cur)) return err(invalidValue({ reason: 'parentCycle', objectId: cur }))
    seen.add(cur)
    cur = findObject(scene, cur)?.parentId
  }
  return ok(null)
}

// ─────────────────────────────────────────────────────────────────────────────
// 多选枢轴策略（**工具参数**，不是另一套几何算法）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 多选变换枢轴策略（#249 §19.2 末段）。
 *
 * 「多选默认使用选择**包围盒中心**作为共同变换枢轴，可扩展活动对象/各自原点等策略。
 * 策略是**工具参数**，不是另一套几何算法」。
 *
 * 三种策略共用同一份"取世界位置 → 求枢轴"的算术，差别只在取哪些点。
 */
export type PivotStrategy =
  | { readonly kind: 'selectionBoundsCenter' }
  | { readonly kind: 'activeObjectOrigin' }
  | { readonly kind: 'individualOrigins' }

/** 默认策略：选择包围盒中心（#249 §19.2 明文）。 */
export const DEFAULT_PIVOT_STRATEGY: PivotStrategy = Object.freeze({ kind: 'selectionBoundsCenter' })

/** 局部包围盒解析器（由几何求得；无网格的对象返回 `null`）。 */
export type LocalBoundsResolver = (objectId: string, dataId: string) => Aabb | null

export interface SelectionPivotInput {
  readonly scene: Scene
  readonly objectIds: readonly string[]
  /** 活动对象（`activeObjectOrigin` / `individualOrigins` 策略的名义句柄）。 */
  readonly activeObjectId?: string
  readonly strategy?: PivotStrategy
}

/**
 * 计算多选共同枢轴（**世界空间**）。
 *
 * `selectionBoundsCenter` 的语义是"所有选中对象世界 AABB 并集的中心"——
 * 不是"各对象原点的平均"。无几何的对象（相机/注解）以自身原点作退化 AABB 参与。
 *
 * 返回 `Result`：对象不存在/变换奇异时显式拒绝，不返回近似值。
 */
export function selectionPivot(input: SelectionPivotInput, resolveBounds?: LocalBoundsResolver): Result<Vec3> {
  const { scene, objectIds } = input
  if (objectIds.length === 0) return err(invalidValue({ reason: 'noTargets' }))
  const strategy = input.strategy ?? DEFAULT_PIVOT_STRATEGY

  if (strategy.kind === 'activeObjectOrigin' || strategy.kind === 'individualOrigins') {
    // 两者都可给出"单个句柄位置"：活动对象（缺省取首个选中）。
    // `individualOrigins` 的**逐对象**枢轴见 `individualPivots`。
    const id = input.activeObjectId ?? objectIds[0]
    return worldPosition(scene, id)
  }

  let min: Vec3 | null = null
  let max: Vec3 | null = null
  for (const id of objectIds) {
    const obj = findObject(scene, id)
    if (!obj) return err(missingTarget({ objectId: id }))
    const w = worldMatrix(scene, id)
    if (!w.ok) return w
    const local = resolveBounds ? resolveBounds(id, obj.dataId) : null
    const corners = local ? aabbCorners(local) : [Object.freeze({ x: 0, y: 0, z: 0 })]
    for (const c of corners) {
      const p = transformPoint(w.value, c)
      if (min === null || max === null) {
        min = p
        max = p
      } else {
        min = Object.freeze({ x: Math.min(min.x, p.x), y: Math.min(min.y, p.y), z: Math.min(min.z, p.z) })
        max = Object.freeze({ x: Math.max(max.x, p.x), y: Math.max(max.y, p.y), z: Math.max(max.z, p.z) })
      }
    }
  }
  if (min === null || max === null) return err(invalidValue({ reason: 'noTargets' }))
  return ok(Object.freeze({ x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 }))
}

/**
 * `individualOrigins` 策略下**逐对象**的枢轴（世界空间）。
 *
 * 与 `selectionPivot` 的关系：后者给"一个共同句柄"供 UI 绘制，
 * 本函数给"实际每个对象绕哪里转"。两者在同一策略下**必然**不同 ——
 * 这正是"策略是工具参数"的可观测含义。
 */
export function individualPivots(scene: Scene, objectIds: readonly string[]): Result<readonly Vec3[]> {
  const out: Vec3[] = []
  for (const id of objectIds) {
    const p = worldPosition(scene, id)
    if (!p.ok) return p
    out.push(p.value)
  }
  return ok(Object.freeze(out))
}

/** 由 AABB 求 8 个角（世界 AABB 用）。 */
export function aabbCorners(b: Aabb): readonly Vec3[] {
  const out: Vec3[] = []
  for (const x of [b.min.x, b.max.x]) {
    for (const y of [b.min.y, b.max.y]) {
      for (const z of [b.min.z, b.max.z]) out.push(Object.freeze({ x, y, z }))
    }
  }
  return Object.freeze(out)
}

/** 局部位置集合 → 局部 AABB（转发 `domain/geometry`，保持单一实现点）。 */
export function localBounds(positions: readonly Vec3[]): Aabb | null {
  return boundsOfPositions(positions)
}

/**
 * 世界空间 AABB（对 8 个角取世界坐标后求包围盒）。
 *
 * 注意它是**世界 AABB**，不是"变换后的 OBB"：#249 §19.2 只要求"选择包围盒中心"
 * 作为枢轴，而枢轴是**中心点**，两种定义在中心上一致；AABB 更简单且无歧义。
 */
export function worldBounds(scene: Scene, objectId: string, local: Aabb | null): Result<Aabb> {
  const w = worldMatrix(scene, objectId)
  if (!w.ok) return w
  const corners = local ? aabbCorners(local) : [Object.freeze({ x: 0, y: 0, z: 0 })]
  const world = corners.map((c) => transformPoint(w.value, c))
  const b = boundsOfPositions(world)
  if (b === null) return err(invalidValue({ reason: 'noGeometry', objectId }))
  return ok(b)
}

// ─────────────────────────────────────────────────────────────────────────────
// 轴序 / 原点 profile（**通用**数学；具体格式映射在适配器，#260）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 轴序与原点 profile（**显式输入**）。
 *
 * #249 §19.2：「文件的轴序/原点转换**只在适配器执行**，所有格式往返通过固定样本
 * 验收，**不凭名称猜测矩阵约定**」。
 *
 * 本类型把"某个格式怎么摆轴"变成**数据**：`permutation` 是输出轴取自输入分量的
 * 下标映射，`signs` 是各输出轴的符号，`origin` 是原点平移（**场景单位**）。
 * 适配器（#260）为每个具体格式构造 profile；本模块只按 profile 做数学。
 * 这里没有任何具体格式字面量 —— 那正是"不凭名称猜约定"的落实。
 */
export interface AxisProfile {
  readonly id: string
  readonly permutation: readonly [number, number, number]
  readonly signs: readonly [number, number, number]
  /** 原点平移（场景单位）；`null` 表示"仅换轴、不平移"。 */
  readonly origin: Vec3 | null
}

export function applyAxisProfile(p: Vec3, profile: AxisProfile): Vec3 {
  const src = [p.x, p.y, p.z]
  const out = Object.freeze({
    x: src[profile.permutation[0]] * profile.signs[0],
    y: src[profile.permutation[1]] * profile.signs[1],
    z: src[profile.permutation[2]] * profile.signs[2],
  })
  const o = profile.origin
  if (o === null) return out
  return Object.freeze({ x: out.x + o.x, y: out.y + o.y, z: out.z + o.z })
}

export interface AxisProfileSample {
  readonly name: string
  readonly profile: AxisProfile
  readonly input: Vec3
  readonly expected: Vec3
}

/**
 * **固定样本期望**（#254 E2 的交付物）。
 *
 * 每条样本是一组 `(输入, profile, 期望输出)`，测试直接引用 —— 于是"适配实现归 #260"
 * 与"本单锁定数学契约"是两件可分别验收的事：本单证明**给定正确的 profile，
 * 数学给出正确结果**；#260 证明**某个具体格式的 profile 构造正确**。
 *
 * 样本刻意包含**不同**的轴序，用来证明"不凭名称猜约定"：若有人忽略 profile
 * 直接返回输入，第 2/3 条立刻判红。
 */
export const AXIS_PROFILE_SAMPLES: readonly AxisProfileSample[] = Object.freeze([
  Object.freeze({
    name: 'identity（无换轴、无平移）',
    profile: Object.freeze({
      id: 'identity',
      permutation: Object.freeze([0, 1, 2]) as readonly [number, number, number],
      signs: Object.freeze([1, 1, 1]) as readonly [number, number, number],
      origin: null,
    }),
    input: Object.freeze({ x: 1, y: 2, z: 3 }),
    expected: Object.freeze({ x: 1, y: 2, z: 3 }),
  }),
  Object.freeze({
    name: 'Y-up → Z-up（输出 x←源x，y←源z，z←−源y；保持右手性）',
    profile: Object.freeze({
      id: 'yUpToZUp',
      permutation: Object.freeze([0, 2, 1]) as readonly [number, number, number],
      signs: Object.freeze([1, 1, -1]) as readonly [number, number, number],
      origin: null,
    }),
    input: Object.freeze({ x: 1, y: 2, z: 3 }),
    expected: Object.freeze({ x: 1, y: 3, z: -2 }),
  }),
  Object.freeze({
    name: '换轴 + 原点平移（z 分量非零，漏加即判红）',
    profile: Object.freeze({
      id: 'yUpToZUpWithOrigin',
      permutation: Object.freeze([0, 2, 1]) as readonly [number, number, number],
      signs: Object.freeze([1, 1, -1]) as readonly [number, number, number],
      origin: Object.freeze({ x: 0, y: 0, z: 64 }),
    }),
    input: Object.freeze({ x: 1, y: 2, z: 3 }),
    expected: Object.freeze({ x: 1, y: 3, z: 62 }),
  }),
])

/** 逐条核对固定样本；返回不一致的描述（空数组 = 全通过）。 */
export function checkAxisProfileSamples(samples: readonly AxisProfileSample[] = AXIS_PROFILE_SAMPLES): readonly string[] {
  const bad: string[] = []
  for (const s of samples) {
    const got = applyAxisProfile(s.input, s.profile)
    if (!approxVec3(got, s.expected)) bad.push(`${s.name}: 期望 ${JSON.stringify(s.expected)}，实得 ${JSON.stringify(got)}`)
  }
  return Object.freeze(bad)
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部
// ─────────────────────────────────────────────────────────────────────────────

function isFiniteTransform(t: Transform): boolean {
  return (
    Number.isFinite(t.position.x) &&
    Number.isFinite(t.position.y) &&
    Number.isFinite(t.position.z) &&
    Number.isFinite(t.rotation.x) &&
    Number.isFinite(t.rotation.y) &&
    Number.isFinite(t.rotation.z) &&
    Number.isFinite(t.rotation.w) &&
    Number.isFinite(t.scale.x) &&
    Number.isFinite(t.scale.y) &&
    Number.isFinite(t.scale.z) &&
    Number.isFinite(t.pivot.x) &&
    Number.isFinite(t.pivot.y) &&
    Number.isFinite(t.pivot.z)
  )
}
