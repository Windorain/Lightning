/**
 * A26 `coordinates-relations` —— **坐标、父子、集合、附着与适配往返**
 * （几何契约）。
 *
 * ## A26 的可观测断言
 *
 * | Given / When | 必须成立 | 负对照必须判红 |
 * |---|---|---|
 * | 父子对象旋转缩放、多选枢轴、附着注解、适配往返 | 世界/局部变换一致；集合成员**不**隐式成为变换父子；注解/拾取/导出一致；循环父子与奇异逆变换**明确拒绝** | **重复坐标翻转**、**用包围盒中心冒充持久枢轴** |
 *
 * ## 四条负对照的注入方式（必须真破坏目标保证）
 *
 * 1. **循环父子**：真的构造 A→B→A 的父链，断言 `worldMatrix` 返回
 *    `InvalidValue{reason:'parentCycle'}` 而**不是**栈溢出或"取一段当父"。
 * 2. **奇异逆变换**：真的把 scale 设为 0（矩阵奇异），断言 `invertAffine`
 *    显式拒绝 —— 且断言"返回近似逆"的变异实现会被同一断言器判红。
 * 3. **坐标翻转**：同一个 profile 应用两次（真的再做一次换轴），断言结果
 *    **不**等于原坐标 ⇒ 证明"往返不是恒等"，故"重复翻转"必须能被检出。
 * 4. **包围盒中心冒充持久枢轴**：真的把 `boundsCenter(...)` 写进
 *    `transform.pivot`，断言"持久枢轴"断言器判红。
 */

import { describe, expect, it } from 'vitest'
import {
  AXIS_PROFILE_SAMPLES,
  COORDINATE_CONVENTION,
  DEFAULT_GRID_CONSTRAINT,
  DEFAULT_PIVOT_STRATEGY,
  MATH_CONTRACT,
  affineFromRows,
  applyAxisProfile,
  applyGridConstraint,
  approxNumber,
  approxQuat,
  approxVec3,
  at,
  aabbCorners,
  canParent,
  checkAxisProfileSamples,
  cross,
  decomposeTrs,
  determinant3,
  identityAffine,
  individualPivots,
  invertAffine,
  isRightHandedYUp,
  localMatrix,
  multiplyAffine,
  rotationAffine,
  scaleAffine,
  selectionPivot,
  shearMagnitude,
  snapPositionInWorld,
  toAffine,
  transformDirection,
  transformPoint,
  translationAffine,
  worldMatrix,
  worldMatrixInverse,
  worldPosition,
  type AxisProfile,
  type CoordinateConvention,
  type PivotStrategy,
} from '@/domain/spatial'
import { meshBounds, meshFromPayload } from '@/domain/geometry'
import { addMeshObject, addAnnotationObject, createDocument } from '@/domain/document'
import type { Scene } from '@/domain/scene'
import { objectLocalAnchor, resolveAnchor, displayPosition, nextLastValidWorld, anchorTargetsObject } from '@/domain/anchor'
import { worldBounds as _unusedWorldBounds } from '@/domain/spatial'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

/** 造"父 P 带子 C"的场景；P 有旋转与缩放，C 有局部平移。 */
function parentChild(): Scene {
  const base = createDocument('doc-1').scene
  const p = addMeshObject(base, { objectId: 'P', dataId: 'gp', size: 2 })
  if (!p.ok) throw new Error('fixture')
  const c = addMeshObject(p.value, { objectId: 'C', dataId: 'gc', size: 1 })
  if (!c.ok) throw new Error('fixture')
  const objects = {
    ...c.value.objects,
    // 父：绕 Y 轴 90°，位置 (10,0,0)，非均匀缩放
    P: Object.freeze({
      ...c.value.objects['P'],
      transform: Object.freeze({
        position: Object.freeze({ x: 10, y: 0, z: 0 }),
        // 绕 Y 转 90°：q = (0, sin45, 0, cos45)
        rotation: Object.freeze({ x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }),
        scale: Object.freeze({ x: 2, y: 1, z: 1 }),
        pivot: Object.freeze({ x: 0, y: 0, z: 0 }),
      }),
    }),
    // 子：局部平移 (1,0,0)，显式父
    C: Object.freeze({
      ...c.value.objects['C'],
      parentId: 'P',
      transform: Object.freeze({
        position: Object.freeze({ x: 1, y: 0, z: 0 }),
        rotation: Object.freeze({ x: 0, y: 0, z: 0, w: 1 }),
        scale: Object.freeze({ x: 1, y: 1, z: 1 }),
        pivot: Object.freeze({ x: 0, y: 0, z: 0 }),
      }),
    }),
  }
  return Object.freeze({ ...c.value, objects: Object.freeze(objects) })
}

// ─────────────────────────────────────────────────────────────────────────────
// 坐标约定（右手 Y-up）
// ─────────────────────────────────────────────────────────────────────────────

describe('A26 坐标约定：右手、Y-up（可断言的数据，不是惯例）', () => {
  it('基向量构成右手 Y-up 系（cross(right, up) === −forward）', () => {
    expect(COORDINATE_CONVENTION.handedness).toBe('right')
    expect(COORDINATE_CONVENTION.up).toBe('y')
    expect(isRightHandedYUp()).toBe(true)
  })

  it('**负对照**：把 forward 改成 +z（左手写法）⇒ 同一判据判红', () => {
    const leftHanded: CoordinateConvention = Object.freeze({
      ...COORDINATE_CONVENTION,
      forward: Object.freeze({ x: 0, y: 0, z: 1 }),
    })
    expect(isRightHandedYUp(leftHanded), '左手约定必须判红').toBe(false)
  })

  it('叉积遵守右手法则（x̂ × ŷ = ẑ）', () => {
    const n = cross(COORDINATE_CONVENTION.right, COORDINATE_CONVENTION.upVector)
    expect(approxVec3(n, Object.freeze({ x: 0, y: 0, z: 1 }))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 仿射矩阵（列主序陷阱的可执行防线）
// ─────────────────────────────────────────────────────────────────────────────

describe('A26 仿射表达：列主序访问、点/方向变换、不丢剪切', () => {
  it('`at(m,row,col)` 与 `affineFromRows` 互为逆（锁死列主序陷阱）', () => {
    const m = affineFromRows([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    // 逻辑行主序读法
    expect(at(m, 0, 0)).toBe(1)
    expect(at(m, 0, 1)).toBe(2)
    expect(at(m, 1, 0)).toBe(5)
    expect(at(m, 3, 0)).toBe(13)
    // 存储是列主序 ⇒ `m.m[12]` 是**逻辑 (0,3)**（= 4），不是逻辑 (3,0)（= 13）。
    // 这一条正是"列主序陷阱"的可执行防线：把两者搞混会静默转置整条变换链。
    expect(m.m[12]).toBe(4)
    expect(m.m[3]).toBe(13)
    // 平移矩阵的平移分量确实落在 12..14（这是列主序布局的用途）
    const t = translationAffine(Object.freeze({ x: 7, y: 8, z: 9 }))
    expect([t.m[12], t.m[13], t.m[14]]).toEqual([7, 8, 9])
  })

  it('平移矩阵变换点：加平移；变换方向：**不**加平移', () => {
    const t = translationAffine(Object.freeze({ x: 1, y: 2, z: 3 }))
    expect(transformPoint(t, Object.freeze({ x: 0, y: 0, z: 0 }))).toEqual({ x: 1, y: 2, z: 3 })
    expect(transformDirection(t, Object.freeze({ x: 1, y: 0, z: 0 }))).toEqual({ x: 1, y: 0, z: 0 })
  })

  it('乘法是教科书约定：`multiplyAffine(a,b)·p === a·(b·p)`', () => {
    const a = translationAffine(Object.freeze({ x: 1, y: 0, z: 0 }))
    const b = scaleAffine(Object.freeze({ x: 2, y: 2, z: 2 }))
    const p = Object.freeze({ x: 1, y: 1, z: 1 })
    const viaComposed = transformPoint(multiplyAffine(a, b), p)
    const viaSequential = transformPoint(a, transformPoint(b, p))
    expect(approxVec3(viaComposed, viaSequential)).toBe(true)
    expect(viaComposed).toEqual({ x: 3, y: 2, z: 2 })
  })

  it('旋转矩阵是正交的（列两两正交且单位长）', () => {
    const r = rotationAffine(Object.freeze({ x: 0.2, y: -0.3, z: 0.5, w: 0.8 }))
    expect(r).not.toBeNull()
    if (!r) return
    expect(shearMagnitude(r), '纯旋转无剪切').toBeLessThan(MATH_CONTRACT.shearEps)
    expect(approxNumber(Math.abs(determinant3(r)), 1, 1e-12)).toBe(true)
  })

  it('零长度四元数 ⇒ `rotationAffine` 返回 null（显式退化，不当恒等）', () => {
    expect(rotationAffine(Object.freeze({ x: 0, y: 0, z: 0, w: 0 }))).toBeNull()
  })

  it('**剪切不被静默丢弃**：带剪切的仿射 `decomposeTrs` 显式拒绝', () => {
    // 构造 shear：x 方向随 y 偏移
    const sheared = affineFromRows([1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    expect(shearMagnitude(sheared)).toBeGreaterThan(MATH_CONTRACT.shearEps)
    const r = decomposeTrs(sheared)
    expect(r.ok, '带剪切必须拒绝，不得静默 TRS 化').toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('InvalidValue')
    expect(r.error.params.reason).toBe('lossyTrsDecomposition')
    expect(Number(r.error.params.shear)).toBeGreaterThan(0)
  })

  it('**负对照**：若把剪切丢掉（变异实现），同一断言器会判红', () => {
    const sheared = affineFromRows([1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    // 变异实现：只取列长与归一化列当旋转 ⇒ 静默丢剪切
    const lossy = decomposeLossy(sheared)
    // 正确实现拒绝；变异实现"成功了" ⇒ 它**确实**破坏了保证
    expect(decomposeTrs(sheared).ok).toBe(false)
    expect(lossy).not.toBeNull()
    // 且往返不等（丢剪切是可观测的失真）
    const roundTrip = toAffine(lossy!)
    expect(approxVec3(transformPoint(roundTrip, Object.freeze({ x: 0, y: 1, z: 0 })), transformPoint(sheared, Object.freeze({ x: 0, y: 1, z: 0 })))).toBe(false)
  })

  it('镜像（负行列式）⇒ `decomposeTrs` 拒绝（不静默取绝对值翻转手性）', () => {
    const mirrored = affineFromRows([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    const r = decomposeTrs(mirrored)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.params.reason).toBe('handednessFlip')
  })

  it('纯 TRS 往返无损（旋转/非均匀缩放/平移/枢轴）', () => {
    // 四元数**已归一化**（创作侧的正常形态；`toAffine` 内部会归一化，未归一化输入
    // 与输出不可比 —— 这不是缺陷，故夹具用规范形态）
    const q = normalizeQuat(Object.freeze({ x: 0.1, y: 0.2, z: 0.3, w: 0.9 }))
    const t = Object.freeze({
      position: Object.freeze({ x: 1, y: 2, z: 3 }),
      rotation: q,
      scale: Object.freeze({ x: 2, y: 0.5, z: 1.5 }),
      pivot: Object.freeze({ x: 0, y: 0, z: 0 }),
    })
    const a = toAffine(t)
    const back = decomposeTrs(a)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(approxVec3(back.value.transform.position, t.position, 1e-12)).toBe(true)
    expect(approxVec3(back.value.transform.scale, t.scale, 1e-12)).toBe(true)
    expect(approxQuat(back.value.transform.rotation, t.rotation, 1e-9)).toBe(true)
    // 往返同一点
    const p = Object.freeze({ x: 0.3, y: -0.7, z: 1.1 })
    const roundTrip = toAffine(back.value.transform)
    expect(approxVec3(transformPoint(roundTrip, p), transformPoint(a, p), 1e-9)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 显式枢轴（持久）vs 多选枢轴（工具参数）
// ─────────────────────────────────────────────────────────────────────────────

describe('A26 枢轴语义：持久枢轴由创作写入，多选枢轴是**工具参数**', () => {
  it('`Transform.pivot` 是**局部空间**里落在 `position` 的那个锚点（旋转/缩放绕它发生）', () => {
    const rot = Object.freeze({ x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 })
    const t0 = Object.freeze({
      position: Object.freeze({ x: 0, y: 0, z: 0 }),
      rotation: rot,
      scale: Object.freeze({ x: 1, y: 1, z: 1 }),
      pivot: Object.freeze({ x: 0, y: 0, z: 0 }),
    })
    const t1 = Object.freeze({ ...t0, pivot: Object.freeze({ x: 1, y: 0, z: 0 }) })
    const m0 = toAffine(t0)
    const m1 = toAffine(t1)
    // 语义 `M = T(position)·R·S·T(−pivot)` ⇒ 局部点 `pivot` 恒映射到 `position`
    expect(approxVec3(transformPoint(m1, t1.pivot), t1.position, 1e-12), 'pivot 锚点落在 position').toBe(true)
    expect(approxVec3(transformPoint(m0, t0.pivot), t0.position, 1e-12)).toBe(true)
    // 同一网格点在不同枢轴下落到**不同**世界位置（枢轴真的参与求值）
    const p = Object.freeze({ x: 2, y: 0, z: 0 })
    expect(approxVec3(transformPoint(m0, p), transformPoint(m1, p), 1e-9), '不同枢轴 ⇒ 不同结果').toBe(false)
    expect(approxVec3(transformPoint(m0, p), Object.freeze({ x: 0, y: 0, z: -2 }), 1e-12)).toBe(true)
    expect(approxVec3(transformPoint(m1, p), Object.freeze({ x: 0, y: 0, z: -1 }), 1e-12)).toBe(true)
  })

  it('多选枢轴默认 = **选择包围盒中心**（不是原点平均）', () => {
    let scene = createDocument('doc-1').scene
    const a = addMeshObject(scene, { objectId: 'A', dataId: 'gA', size: 1 })
    if (!a.ok) throw new Error('fixture')
    const b = addMeshObject(a.value, { objectId: 'B', dataId: 'gB', size: 1 })
    if (!b.ok) throw new Error('fixture')
    // B 移到 x=10 ⇒ 并集 AABB 是 [-0.5,10.5]，中心 5（而原点平均是 5 —— 巧合相等）
    const moved = moveObject(b.value, 'B', { x: 10, y: 0, z: 0 })
    scene = moved

    const pivot = selectionPivot({ scene, objectIds: ['A', 'B'] }, (_objectId, dataId) => boundsOf(scene, dataId))
    expect(pivot.ok).toBe(true)
    if (!pivot.ok) return
    expect(pivot.value.x).toBeCloseTo(5, 12)

    // 差异用例：A 尺寸 4（AABB [-2,2]），B 在 x=10 尺寸 1（[9.5,10.5]）
    // ⇒ 并集中心 = ( -2 + 10.5 ) / 2 = 4.25，而"原点平均" = 5 ⇒ 两者不同
    const bigA = resizeBox(scene, 'A', 'gA', 4)
    const pivot2 = selectionPivot({ scene: bigA, objectIds: ['A', 'B'] }, (_objectId, dataId) => boundsOf(bigA, dataId))
    expect(pivot2.ok).toBe(true)
    if (!pivot2.ok) return
    expect(pivot2.value.x, '包围盒中心 ≠ 原点平均').toBeCloseTo((-2 + 10.5) / 2, 12)
    expect(pivot2.value.x).not.toBeCloseTo(5, 6)
  })

  it('**负对照**：把包围盒中心写进 `transform.pivot` ⇒ "持久枢轴不变"断言器判红', () => {
    let scene = createDocument('doc-1').scene
    // 对象**偏离原点**（否则包围盒中心恰为 (0,0,0)，与初始枢轴相同 ⇒ 夹具不敏感）
    const a = addMeshObject(scene, { objectId: 'A', dataId: 'gA', size: 1, transform: IDENTITY_TRANSFORM_AT(3, 4, 5) })
    if (!a.ok) throw new Error('fixture')
    scene = a.value
    const before = scene.objects['A'].transform.pivot
    expect(before, '前置：初始枢轴为原点旁的零值').toEqual({ x: 0, y: 0, z: 0 })

    const pivot = selectionPivot({ scene, objectIds: ['A'] }, (_objectId, dataId) => boundsOf(scene, dataId))
    expect(pivot.ok).toBe(true)
    if (!pivot.ok) return
    expect(pivot.value, '工具枢轴 = 包围盒中心 = 对象位置（非零）').not.toEqual({ x: 0, y: 0, z: 0 })
    expect(pivot.value).toEqual({ x: 3, y: 4, z: 5 })

    // 变异实现：把工具枢轴**写进**对象枢轴（A26 负对照的注入形态）
    const mutated = Object.freeze({
      ...scene,
      objects: Object.freeze({
        ...scene.objects,
        A: Object.freeze({ ...scene.objects['A'], transform: Object.freeze({ ...scene.objects['A'].transform, pivot: pivot.value }) }),
      }),
    })
    const violations = assertPersistentPivotUnchanged(scene, mutated)
    expect(violations.length, '用包围盒中心冒充持久枢轴必须判红').toBeGreaterThan(0)
    // 而正确路径：算枢轴**不**改对象
    expect(assertPersistentPivotUnchanged(scene, scene)).toEqual([])
    expect(scene.objects['A'].transform.pivot).toBe(before)
  })

  it('三种枢轴策略给出**不同**结果（证明"策略是工具参数"可观测）', () => {
    let scene = createDocument('doc-1').scene
    const a = addMeshObject(scene, { objectId: 'A', dataId: 'gA', size: 1 })
    if (!a.ok) throw new Error('fixture')
    const b = addMeshObject(a.value, { objectId: 'B', dataId: 'gB', size: 1 })
    if (!b.ok) throw new Error('fixture')
    scene = moveObject(b.value, 'B', { x: 10, y: 0, z: 0 })

    const boundsOfLocal = (_objectId: string, dataId: string) => boundsOf(scene, dataId)
    const center = selectionPivot({ scene, objectIds: ['A', 'B'], strategy: DEFAULT_PIVOT_STRATEGY }, boundsOfLocal)
    const active = selectionPivot(
      { scene, objectIds: ['A', 'B'], activeObjectId: 'B', strategy: Object.freeze({ kind: 'activeObjectOrigin' }) as PivotStrategy },
      boundsOfLocal,
    )
    const individual = individualPivots(scene, ['A', 'B'])
    expect(center.ok && active.ok && individual.ok).toBe(true)
    if (!center.ok || !active.ok || !individual.ok) return
    expect(center.value.x).toBeCloseTo(5, 12)
    expect(active.value.x).toBe(10)
    expect(center.value.x).not.toBeCloseTo(active.value.x, 6)
    expect(individual.value.map((p) => p.x)).toEqual([0, 10])
    expect(DEFAULT_PIVOT_STRATEGY.kind, '默认策略 = 选择包围盒中心').toBe('selectionBoundsCenter')
  })

  it('多选枢轴对空选择 ⇒ `InvalidValue`（不返回零点当"成功"）', () => {
    const scene = createDocument('doc-1').scene
    const r = selectionPivot({ scene, objectIds: [] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('InvalidValue')
    expect(r.error.params.reason).toBe('noTargets')
  })

  it('AABB 的 8 个角齐备（世界包围盒用）', () => {
    const b = Object.freeze({ min: Object.freeze({ x: -1, y: -2, z: -3 }), max: Object.freeze({ x: 1, y: 2, z: 3 }) })
    const corners = aabbCorners(b)
    expect(corners.length).toBe(8)
    expect(corners).toContainEqual({ x: -1, y: -2, z: -3 })
    expect(corners).toContainEqual({ x: 1, y: 2, z: 3 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 父链求值 / 集合不形成父子 / 循环拒绝
// ─────────────────────────────────────────────────────────────────────────────

describe('A26 父子求值：世界/局部一致、集合不形成变换父子、循环明确拒绝', () => {
  it('子对象世界位置 = 父矩阵作用于子局部原点', () => {
    const scene = parentChild()
    const wp = worldPosition(scene, 'C')
    expect(wp.ok).toBe(true)
    if (!wp.ok) return
    // P: 旋转 90°(Y) + 非均匀缩放(2,1,1) + 平移(10,0,0)
    // C 局部位置 (1,0,0) ⇒ 缩放后 (2,0,0) ⇒ 绕 Y 转 90° ⇒ (0,0,-2) ⇒ 平移 (10,0,-2)
    expect(approxVec3(wp.value, Object.freeze({ x: 10, y: 0, z: -2 }), 1e-12)).toBe(true)
  })

  it('世界矩阵 = 父·子（且**不等于**子局部矩阵）', () => {
    const scene = parentChild()
    const w = worldMatrix(scene, 'C')
    const l = localMatrix(scene, 'C')
    expect(w.ok && l.ok).toBe(true)
    if (!w.ok || !l.ok) return
    const p = Object.freeze({ x: 1, y: 0, z: 0 })
    expect(approxVec3(transformPoint(w.value, p), transformPoint(l.value, p), 1e-9), '有父 ⇒ 两者不同').toBe(false)
  })

  it('世界矩阵的逆作用后回到局部坐标（往返一致）', () => {
    const scene = parentChild()
    const inv = worldMatrixInverse(scene, 'C')
    expect(inv.ok).toBe(true)
    if (!inv.ok) return
    const world = worldPosition(scene, 'C')
    if (!world.ok) throw new Error('fixture')
    const back = transformPoint(inv.value, world.value)
    expect(approxVec3(back, Object.freeze({ x: 0, y: 0, z: 0 }), 1e-9)).toBe(true)
  })

  it('**集合成员不隐式成为变换父子**：加入集合不改变世界矩阵', () => {
    const scene = parentChild()
    const before = worldMatrix(scene, 'C')
    expect(before.ok).toBe(true)
    if (!before.ok) return
    // 把 C 放进一个集合（组织 + 可见性），**不**设 parentId
    const withCollection = Object.freeze({
      ...scene,
      collections: Object.freeze({ ...scene.collections, grp: Object.freeze({ id: 'grp', name: 'grp', members: Object.freeze(['P', 'C']), visible: true }) }),
    })
    const after = worldMatrix(withCollection, 'C')
    expect(after.ok).toBe(true)
    if (!after.ok) return
    // 逐分量相同 ⇒ 集合确实不影响变换父子
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) expect(at(after.value, r, c)).toBe(at(before.value, r, c))
    // 且 C 的 parentId 没被"顺手"设上
    expect(withCollection.objects['C'].parentId).toBe('P')
  })

  it('**负对照**：循环父链 ⇒ `worldMatrix` 明确拒绝（不栈溢出、不取一段当父）', () => {
    const scene = parentChild()
    // 造环：P 的父设为 C
    const cyclic = Object.freeze({
      ...scene,
      objects: Object.freeze({ ...scene.objects, P: Object.freeze({ ...scene.objects['P'], parentId: 'C' }) }),
    })
    const w = worldMatrix(cyclic, 'C')
    expect(w.ok, '循环父链必须明确拒绝').toBe(false)
    if (w.ok) return
    expect(w.error.code).toBe('InvalidValue')
    expect(w.error.params.reason).toBe('parentCycle')
  })

  it('`canParent` 是**准入判据**：成环/自环/缺目标/缺父都显式拒绝', () => {
    const scene = parentChild()
    // 自环
    expect(canParent(scene, 'C', 'C').ok).toBe(false)
    // 成环：P 的祖先是 C ⇒ 不能把 C 设为 P 的父
    expect(canParent(scene, 'P', 'C').ok, 'P 已是 C 的父 ⇒ 反向挂接成环').toBe(false)
    // 缺目标/缺父
    expect(canParent(scene, 'nope', 'P').ok).toBe(false)
    expect(canParent(scene, 'C', 'nope').ok).toBe(false)
    // 合法：解父
    expect(canParent(scene, 'C', null).ok).toBe(true)
  })

  it('**负对照**：绕过 `canParent` 直接写 parentId 会造出环，而求值必须能检出', () => {
    const scene = parentChild()
    const cyclic = Object.freeze({
      ...scene,
      objects: Object.freeze({ ...scene.objects, P: Object.freeze({ ...scene.objects['P'], parentId: 'C' }) }),
    })
    // 直接写绕过了准入 ⇒ 数据里有环；此时**求值**是唯一防线（必须拒绝而非崩）
    expect(canParent(cyclic, 'P', 'C').ok, '准入判据能识别既有环').toBe(false)
    expect(worldMatrix(cyclic, 'P').ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 奇异逆变换（明确拒绝）
// ─────────────────────────────────────────────────────────────────────────────

describe('A26 奇异逆变换：明确拒绝（不返回近似逆）', () => {
  it('scale 含 0 ⇒ `invertAffine` 拒绝且带行列式', () => {
    const singular = scaleAffine(Object.freeze({ x: 1, y: 0, z: 1 }))
    const r = invertAffine(singular)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('InvalidValue')
    expect(r.error.params.reason).toBe('singularTransform')
    expect(r.error.params.det).toBe(0)
  })

  it('极小微缩放到"不可稳定求逆"也拒绝（判据是 3×3 行列式，不是单个分量）', () => {
    // 行列式 = sx·sy·sz。取 (1e-5, 1e-5, 1) ⇒ det = 1e-10，
    // 仍**大于** 1e-12 ⇒ 可求逆（正确行为：容限只拒绝真正无法稳定求逆的矩阵）。
    const smallish = scaleAffine(Object.freeze({ x: 1e-5, y: 1e-5, z: 1 }))
    expect(determinant3(smallish)).toBeCloseTo(1e-10, 20)
    expect(invertAffine(smallish).ok, 'det=1e-10 > 1e-12 ⇒ 可求逆').toBe(true)
    // 取 (1e-5, 1e-5, 1e-5) ⇒ det = 1e-15 < 1e-12 ⇒ 拒绝
    const tiny = scaleAffine(Object.freeze({ x: 1e-5, y: 1e-5, z: 1e-5 }))
    expect(Math.abs(determinant3(tiny))).toBeLessThan(MATH_CONTRACT.singularDeterminantEps)
    expect(invertAffine(tiny).ok, 'det < 容限 ⇒ 明确拒绝').toBe(false)
  })

  it('**负对照**：若对奇异矩阵"返回近似逆"，同一断言器判红', () => {
    const singular = scaleAffine(Object.freeze({ x: 1, y: 0, z: 1 }))
    const naive = naiveInvert(singular)
    // 正确实现拒绝
    expect(invertAffine(singular).ok).toBe(false)
    // 变异实现"成功"了（它把 1/0 变成了 Infinity/NaN —— 静默污染的形态）
    expect(naive.ok).toBe(true)
    if (!naive.ok) return
    // 且它真的不满足"逆"的定义（M·M⁻¹ ≠ I），故它**确实**破坏了保证
    const prod = multiplyAffine(singular, naive.value)
    expect(approxNumber(at(prod, 1, 1), 1, 1e-9), '变异实现的"逆"不满足 M·M⁻¹=I').toBe(false)
  })

  it('含 Inf/NaN 的变换在**局部**矩阵处即被拒绝', () => {
    const base = createDocument('doc-1').scene
    const made = addMeshObject(base, { objectId: 'A', dataId: 'g', size: 1 })
    if (!made.ok) throw new Error('fixture')
    const bad = Object.freeze({
      ...made.value,
      objects: Object.freeze({
        ...made.value.objects,
        A: Object.freeze({
          ...made.value.objects['A'],
          transform: Object.freeze({ ...made.value.objects['A'].transform, position: Object.freeze({ x: Number.NaN, y: 0, z: 0 }) }),
        }),
      }),
    })
    const r = localMatrix(bad, 'A')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.params.reason).toBe('nonFiniteTransform')
  })

  it('零长度旋转 ⇒ 局部矩阵拒绝（`degenerateRotation`）', () => {
    const base = createDocument('doc-1').scene
    const made = addMeshObject(base, { objectId: 'A', dataId: 'g', size: 1 })
    if (!made.ok) throw new Error('fixture')
    const bad = Object.freeze({
      ...made.value,
      objects: Object.freeze({
        ...made.value.objects,
        A: Object.freeze({
          ...made.value.objects['A'],
          transform: Object.freeze({ ...made.value.objects['A'].transform, rotation: Object.freeze({ x: 0, y: 0, z: 0, w: 0 }) }),
        }),
      }),
    })
    const r = localMatrix(bad, 'A')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.params.reason).toBe('degenerateRotation')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 适配往返：轴序 / 原点（E2 固定样本；适配实现归适配层）
// ─────────────────────────────────────────────────────────────────────────────

describe('A26 E2 轴序/原点变换：只在适配器执行，固定样本锁定数学契约', () => {
  it('固定样本逐条通过（`checkAxisProfileSamples` 返回空）', () => {
    expect(checkAxisProfileSamples()).toEqual([])
    expect(AXIS_PROFILE_SAMPLES.length).toBeGreaterThanOrEqual(3)
  })

  it('identity profile 是恒等；非 identity profile **不是**恒等（证明 profile 真的被使用）', () => {
    const p = Object.freeze({ x: 1, y: 2, z: 3 })
    const identity = AXIS_PROFILE_SAMPLES.find((s) => s.profile.id === 'identity')
    const swap = AXIS_PROFILE_SAMPLES.find((s) => s.profile.id === 'yUpToZUp')
    expect(identity && swap).toBeTruthy()
    if (!identity || !swap) return
    expect(applyAxisProfile(p, identity.profile)).toEqual(p)
    expect(applyAxisProfile(p, swap.profile)).not.toEqual(p)
  })

  it('**负对照（重复坐标翻转）**：同一 profile 应用两次 ≠ 一次（故重复翻转可被检出）', () => {
    const p = Object.freeze({ x: 1, y: 2, z: 3 })
    const swap = AXIS_PROFILE_SAMPLES.find((s) => s.profile.id === 'yUpToZUp')
    if (!swap) throw new Error('fixture')
    const once = applyAxisProfile(p, swap.profile)
    const twice = applyAxisProfile(once, swap.profile)
    expect(once).toEqual(swap.expected)
    expect(twice, '往返两次**不**回到原点 ⇒ 重复翻转是可观测错误').not.toEqual(p)
    // 且两次的结果能被检出（与一次不同）
    expect(twice).not.toEqual(once)
  })

  it('原点平移不漏 z（非零 origin 的样本专门锁这一点）', () => {
    const withOrigin = AXIS_PROFILE_SAMPLES.find((s) => s.profile.id === 'yUpToZUpWithOrigin')
    if (!withOrigin) throw new Error('fixture')
    expect(withOrigin.expected.z).toBe(62)
    // 若漏加 z 平移，结果为 -2 ⇒ 判红
    expect(applyAxisProfile(withOrigin.input, withOrigin.profile).z).not.toBe(-2)
  })

  it('本模块**不含**具体格式知识（不凭名称猜矩阵约定）', () => {
    // AxisProfile 只有 permutation/signs/origin 三个数学参数 + 一个 id；
    // 任何"格式名 → 约定"的映射都必须由适配器显式构造。
    const sample: AxisProfile = AXIS_PROFILE_SAMPLES[0].profile
    expect(Object.keys(sample).sort()).toEqual(['id', 'origin', 'permutation', 'signs'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 注解锚点（附着）
// ─────────────────────────────────────────────────────────────────────────────

describe('A26 注解锚点：局部/场景/元素三态、未解析显式、身份恢复后重解析', () => {
  function sceneWithAnnotation() {
    const start = createDocument('doc-1').scene
    const mesh = addMeshObject(start, { objectId: 'A', dataId: 'gA', size: 2 })
    if (!mesh.ok) throw new Error('fixture: mesh')
    // 注意：`addAnnotationObject` 的返回类型是 `Scene | null`（**不是** `Result`），
    // 与 `addMeshObject` 不同 —— 前者只可能因 id 冲突失败，后者还要校验几何参数。
    const anno = addAnnotationObject(mesh.value, { objectId: 'N', dataId: 'gN', shape: 'point' })
    if (anno === null) throw new Error('fixture: annotation')
    return anno
  }

  it('对象局部锚点随对象变换走（对象移动 ⇒ 注解世界位置随之移动）', () => {
    const scene = sceneWithAnnotation()
    const anchor = objectLocalAnchor('A', Object.freeze({ x: 1, y: 0, z: 0 }))
    const r0 = resolveAnchor(scene, anchor)
    expect(r0.status).toBe('resolved')
    if (r0.status !== 'resolved') return
    expect(approxVec3(r0.world, Object.freeze({ x: 1, y: 0, z: 0 }), 1e-12)).toBe(true)

    const moved = moveObject(scene, 'A', { x: 5, y: 0, z: 0 })
    const r1 = resolveAnchor(moved, anchor)
    expect(r1.status).toBe('resolved')
    if (r1.status !== 'resolved') return
    expect(approxVec3(r1.world, Object.freeze({ x: 6, y: 0, z: 0 }), 1e-12), '跟着对象走（锚点是身份不是位置快照）').toBe(true)
  })

  it('显式场景坐标**不**随任何对象移动（它是绝对值）', () => {
    const scene = sceneWithAnnotation()
    const anchor = Object.freeze({ kind: 'scenePoint' as const, point: Object.freeze({ x: 1, y: 2, z: 3 }) })
    const moved = moveObject(scene, 'A', { x: 99, y: 0, z: 0 })
    const r = resolveAnchor(moved, anchor)
    expect(r.status).toBe('resolved')
    if (r.status !== 'resolved') return
    expect(r.world).toEqual({ x: 1, y: 2, z: 3 })
  })

  it('目标删除 ⇒ 保留并标**未解析**（带结构化原因），且呈现可用最后有效位置但**明确状态**', () => {
    const scene = sceneWithAnnotation()
    const anchor = objectLocalAnchor('A', Object.freeze({ x: 0, y: 1, z: 0 }))
    const first = resolveAnchor(scene, anchor)
    expect(first.status).toBe('resolved')
    if (first.status !== 'resolved') return
    const lastValid = nextLastValidWorld(null, first)
    expect(lastValid).not.toBeNull()

    // 删除目标对象
    const objects = { ...scene.objects }
    delete objects['A']
    const deleted = Object.freeze({ ...scene, objects: Object.freeze(objects), order: Object.freeze(scene.order.filter((i) => i !== 'A')) })

    const r = resolveAnchor(deleted, anchor, lastValid)
    expect(r.status, '默认行为：保留并标未解析').toBe('unresolved')
    if (r.status !== 'unresolved') return
    expect(r.reason).toBe('objectMissing')
    expect(r.detail.objectId).toBe('A')
    // 呈现可用最后有效位置，但**状态**必须明确
    const disp = displayPosition(r)
    expect(disp.world).toEqual(first.world)
    expect(disp.isStale, '必须标明"这是历史位置"').toBe(true)
    expect(disp.reason).toBe('objectMissing')
    // 解析成功时 isStale 为 false
    expect(displayPosition(first).isStale).toBe(false)
  })

  it('**不得偷偷绑定同名对象**：另造一个同名对象，锚点仍判未解析', () => {
    const scene = sceneWithAnnotation()
    const anchor = objectLocalAnchor('A', Object.freeze({ x: 0, y: 1, z: 0 }))
    // 删掉 A，另加一个**同名**（name = 'A'）但 id 不同的对象
    const objects = { ...scene.objects }
    delete objects['A']
    const impostor = addMeshObject(
      Object.freeze({ ...scene, objects: Object.freeze(objects), order: Object.freeze(scene.order.filter((i) => i !== 'A')) }),
      { objectId: 'A2', dataId: 'gA2', name: 'A', size: 1 },
    )
    if (!impostor.ok) throw new Error('fixture')
    const r = resolveAnchor(impostor.value, anchor)
    expect(r.status, '同名不同身份 ⇒ 必须仍未解析（不静默猜配）').toBe('unresolved')
    if (r.status !== 'unresolved') return
    expect(r.reason).toBe('objectMissing')
    expect(r.detail.objectId).toBe('A')
  })

  it('**不得绑定相同坐标处的新对象**：新对象落在原坐标，锚点仍未解析', () => {
    const scene = sceneWithAnnotation()
    const anchor = objectLocalAnchor('A', Object.freeze({ x: 0, y: 1, z: 0 }))
    const objects = { ...scene.objects }
    delete objects['A']
    const placed = addMeshObject(Object.freeze({ ...scene, objects: Object.freeze(objects), order: Object.freeze(scene.order.filter((i) => i !== 'A')) }), {
      objectId: 'A3',
      dataId: 'gA3',
      size: 2,
    })
    if (!placed.ok) throw new Error('fixture')
    // A3 的变换与原 A 相同（位置都是原点）⇒ 坐标一致
    const same = Object.freeze({
      ...placed.value,
      objects: Object.freeze({
        ...placed.value.objects,
        A3: Object.freeze({ ...placed.value.objects['A3'], transform: scene.objects['A'].transform }),
      }),
    })
    const r = resolveAnchor(same, anchor)
    expect(r.status, '同坐标不同身份 ⇒ 必须仍未解析').toBe('unresolved')
  })

  it('恢复原身份后**可重新解析**（身份回来了，锚点自然复活）', () => {
    const scene = sceneWithAnnotation()
    const anchor = objectLocalAnchor('A', Object.freeze({ x: 0, y: 1, z: 0 }))
    const objects = { ...scene.objects }
    delete objects['A']
    const deleted = Object.freeze({ ...scene, objects: Object.freeze(objects), order: Object.freeze(scene.order.filter((i) => i !== 'A')) })
    const gone = resolveAnchor(deleted, anchor, null)
    expect(gone.status).toBe('unresolved')
    // 撤销 = 拿回起点场景（原身份在原位）
    const restored = resolveAnchor(scene, anchor, null)
    expect(restored.status, '恢复原身份 ⇒ 重新解析').toBe('resolved')
    if (restored.status !== 'resolved') return
    expect(restored.from).toBe('objectLocal')
  })

  it('几何元素锚点携带元素身份与拓扑版本；拓扑变化 ⇒ 未解析且原因为 `topologyChanged`', () => {
    const scene = sceneWithAnnotation()
    const data = scene.data['gA']
    const mesh = meshFromPayload(data.payload)
    if (!mesh) throw new Error('fixture')
    const anchor = Object.freeze({
      kind: 'geometryElement' as const,
      objectId: 'A',
      dataId: 'gA',
      elementKind: 'vertex' as const,
      element: Object.freeze({ elementId: 'x0y0z0', topologyVersion: mesh.topology.version }),
    })
    const r = resolveAnchor(scene, anchor)
    expect(r.status).toBe('resolved')

    // 拓扑变化：推进数据的拓扑版本
    const bumpedMesh = Object.freeze({ ...mesh, topology: Object.freeze({ ...mesh.topology, version: mesh.topology.version + 1 }) })
    const bumped = Object.freeze({
      ...scene,
      data: Object.freeze({ ...scene.data, gA: Object.freeze({ ...data, payload: Object.freeze({ kind: 'mesh' as const, mesh: bumpedMesh }), topologyVersion: bumpedMesh.topology.version }) }),
    })
    const r2 = resolveAnchor(bumped, anchor)
    expect(r2.status).toBe('unresolved')
    if (r2.status !== 'unresolved') return
    expect(r2.reason).toBe('topologyChanged')
    expect(r2.detail.expected).toBe(0)
    expect(r2.detail.actual).toBe(1)
  })

  it('`lastValidWorld` 在一次失败后**保留**（不因一次未解析就丢历史）', () => {
    const valid = Object.freeze({ x: 5, y: 5, z: 5 })
    const failed = Object.freeze({ status: 'unresolved' as const, reason: 'objectMissing' as const, detail: Object.freeze({}), lastValidWorld: null })
    expect(nextLastValidWorld(valid, failed), '未解析 ⇒ 保留旧值').toBe(valid)
    const resolved = Object.freeze({ status: 'resolved' as const, world: Object.freeze({ x: 1, y: 1, z: 1 }), from: 'scenePoint' as const })
    expect(nextLastValidWorld(valid, resolved)).toEqual({ x: 1, y: 1, z: 1 })
  })

  it('`anchorTargetsObject` 按身份判定（供删除对象时收集受影响注解）', () => {
    const a = objectLocalAnchor('A', Object.freeze({ x: 0, y: 0, z: 0 }))
    expect(anchorTargetsObject(a, 'A')).toBe(true)
    expect(anchorTargetsObject(a, 'A2')).toBe(false)
    expect(anchorTargetsObject(Object.freeze({ kind: 'scenePoint' as const, point: Object.freeze({ x: 0, y: 0, z: 0 }) }), 'A')).toBe(false)
  })

  it('未解析原因用**稳定码**（不因语言变化而变）', () => {
    const scene = createDocument('doc-1').scene
    const r = resolveAnchor(scene, objectLocalAnchor('missing', Object.freeze({ x: 0, y: 0, z: 0 })))
    expect(r.status).toBe('unresolved')
    if (r.status !== 'unresolved') return
    expect(['objectMissing', 'dataMissing', 'elementMissing', 'topologyChanged', 'notAMesh']).toContain(r.reason)
  })

  it('非网格数据的元素锚点 ⇒ `notAMesh`（不当作"零顶点网格"）', () => {
    const scene = sceneWithAnnotation()
    const anchor = Object.freeze({
      kind: 'geometryElement' as const,
      objectId: 'N',
      dataId: 'gN',
      elementKind: 'vertex' as const,
      element: Object.freeze({ elementId: 'x', topologyVersion: 0 }),
    })
    const r = resolveAnchor(scene, anchor)
    expect(r.status).toBe('unresolved')
    if (r.status !== 'unresolved') return
    expect(r.reason).toBe('notAMesh')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 数值容限契约（E3）
// ─────────────────────────────────────────────────────────────────────────────

describe('E3 数值容限：写在数学契约里并被测试引用（不任意四舍五入到整数）', () => {
  it('容限是**契约常量**且量级合理（远小于建模精度、远大于浮点误差）', () => {
    expect(MATH_CONTRACT.positionEps).toBe(1e-9)
    expect(MATH_CONTRACT.singularDeterminantEps).toBe(1e-12)
    expect(MATH_CONTRACT.positionEps).toBeLessThan(1e-6)
    expect(MATH_CONTRACT.positionEps).toBeGreaterThan(1e-15)
  })

  it('近似比较**不**把小数四舍五入到整数（0.4 与 0.6 不等）', () => {
    expect(approxVec3(Object.freeze({ x: 0.4, y: 0, z: 0 }), Object.freeze({ x: 0.6, y: 0, z: 0 }))).toBe(false)
    expect(approxVec3(Object.freeze({ x: 0.4, y: 0, z: 0 }), Object.freeze({ x: 0.4 + 1e-12, y: 0, z: 0 }))).toBe(true)
    expect(approxNumber(0.4999, 0.5, 1e-9)).toBe(false)
  })

  it('微小位移不被"取整"吞掉：0.001 的位移可观测', () => {
    const t = translationAffine(Object.freeze({ x: 0.001, y: 0, z: 0 }))
    const p = transformPoint(t, Object.freeze({ x: 0, y: 0, z: 0 }))
    expect(p.x).toBe(0.001)
    expect(approxVec3(p, Object.freeze({ x: 0, y: 0, z: 0 })), '不得被判为"没动"').toBe(false)
  })

  it('四元数 q 与 −q 视为同一旋转（容限比较的语义）', () => {
    const q = Object.freeze({ x: 0.1, y: 0.2, z: 0.3, w: 0.9 })
    const neg = Object.freeze({ x: -0.1, y: -0.2, z: -0.3, w: -0.9 })
    expect(approxQuat(q, neg)).toBe(true)
    expect(approxQuat(q, Object.freeze({ x: 0.2, y: 0.2, z: 0.3, w: 0.9 }))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 内部：变异实现与夹具
// ─────────────────────────────────────────────────────────────────────────────

/** **变异实现**：对奇异矩阵也返回一个"逆"（不检查行列式）。 */
function naiveInvert(m: ReturnType<typeof identityAffine>): { ok: true; value: ReturnType<typeof identityAffine> } {
  // 只对**对角**矩阵做朴素求逆（够用来证明"不检查行列式就会给出 Inf/NaN 结果"）
  const d = [at(m, 0, 0), at(m, 1, 1), at(m, 2, 2)]
  return {
    ok: true,
    value: affineFromRows([1 / d[0], 0, 0, 0, 0, 1 / d[1], 0, 0, 0, 0, 1 / d[2], 0, 0, 0, 0, 1]),
  }
}

/** **变异实现**：有损 TRS 分解（静默丢剪切）。 */
function decomposeLossy(m: ReturnType<typeof identityAffine>) {
  const det = determinant3(m)
  if (!Number.isFinite(det) || det === 0) return null
  const c0 = Object.freeze({ x: at(m, 0, 0), y: at(m, 1, 0), z: at(m, 2, 0) })
  const c1 = Object.freeze({ x: at(m, 0, 1), y: at(m, 1, 1), z: at(m, 2, 1) })
  const c2 = Object.freeze({ x: at(m, 0, 2), y: at(m, 1, 2), z: at(m, 2, 2) })
  const l = (v: { x: number; y: number; z: number }): number => Math.hypot(v.x, v.y, v.z)
  const n = (v: { x: number; y: number; z: number }, k: number) => Object.freeze({ x: v.x / k, y: v.y / k, z: v.z / k })
  const r = [n(c0, l(c0)), n(c1, l(c1)), n(c2, l(c2))]
  const trace = r[0].x + r[1].y + r[2].z
  let q
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    q = Object.freeze({ x: (r[2].y - r[1].z) / s, y: (r[0].z - r[2].x) / s, z: (r[1].x - r[0].y) / s, w: 0.25 * s })
  } else {
    q = Object.freeze({ x: 0, y: 0, z: 0, w: 1 })
  }
  return Object.freeze({
    position: Object.freeze({ x: at(m, 0, 3), y: at(m, 1, 3), z: at(m, 2, 3) }),
    rotation: q,
    scale: Object.freeze({ x: l(c0), y: l(c1), z: l(c2) }),
    pivot: Object.freeze({ x: 0, y: 0, z: 0 }),
  })
}

/** "持久枢轴不得被工具策略改写"的断言器（正负对照共用）。 */
function assertPersistentPivotUnchanged(before: Scene, after: Scene): readonly string[] {
  const out: string[] = []
  for (const id of Object.keys(before.objects)) {
    const b = before.objects[id]
    const a = after.objects[id]
    if (!a) continue
    if (b.transform.pivot.x !== a.transform.pivot.x || b.transform.pivot.y !== a.transform.pivot.y || b.transform.pivot.z !== a.transform.pivot.z) {
      out.push(`${id}: 持久枢轴被改写（${JSON.stringify(b.transform.pivot)} → ${JSON.stringify(a.transform.pivot)}）`)
    }
  }
  return out
}

function boundsOf(scene: Scene, dataId: string) {
  const data = scene.data[dataId]
  const mesh = data ? meshFromPayload(data.payload) : undefined
  return mesh ? meshBounds(mesh) : null
}

/** 归一化四元数（夹具用；`toAffine` 内部会归一化，未归一化输入与输出不可比）。 */
function normalizeQuat(q: { x: number; y: number; z: number; w: number }) {
  const l = Math.hypot(q.x, q.y, q.z, q.w)
  return Object.freeze({ x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l })
}

// ─────────────────────────────────────────────────────────────────────────────
// 网格约束纯策略（「对象变换**可离开整数网格**；需要网格约束的
// 工具**显式**采用纯策略」）
// ─────────────────────────────────────────────────────────────────────────────

describe('A26 网格约束是**显式纯策略**（对象变换本身可离开整数网格）', () => {
  it('默认**无约束**：0.5 这样的小数位置原样保留（不静默吸附）', () => {
    const p = Object.freeze({ x: 0.5, y: -1.25, z: 3.7 })
    const r = applyGridConstraint(p, DEFAULT_GRID_CONSTRAINT)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value, '默认策略必须原样返回 —— 不得隐式吸附').toEqual(p)
    expect(r.value).toBe(p)
  })

  it('**显式** `snap` 策略才吸附，且三个分量都吸附', () => {
    const r = applyGridConstraint(Object.freeze({ x: 0.4, y: 1.6, z: -0.6 }), Object.freeze({ kind: 'snap', gridSize: 1, space: 'local' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ x: 0, y: 2, z: -1 })
  })

  it('格距任意正数都生效（不假定整数格距 —— MC 的 1 格只是默认映射，不是硬编码）', () => {
    const r = applyGridConstraint(Object.freeze({ x: 0.3, y: 0, z: 0 }), Object.freeze({ kind: 'snap', gridSize: 0.5, space: 'local' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.x).toBeCloseTo(0.5, 12)
  })

  it('**负对照（不做静默夹取）**：非法格距 ⇒ 显式拒绝，**不**退化成"无约束"', () => {
    for (const gridSize of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = applyGridConstraint(Object.freeze({ x: 0.5, y: 0, z: 0 }), Object.freeze({ kind: 'snap', gridSize, space: 'local' }))
      expect(r.ok, `gridSize=${gridSize} 必须拒绝`).toBe(false)
      if (r.ok) continue
      expect(r.error.code).toBe('InvalidValue')
      expect(r.error.params.reason).toBe('badGridSize')
    }
  })

  it('世界空间吸附：在**局部**格上吸附后再换回世界（故父的**非均匀**缩放被如实体现）', () => {
    const scene = parentChild()
    // C 的父 P = 平移(10,0,0) + 绕 Y 转 90° + 缩放(2,1,1) ⇒ W_C(l) = (lz+10, ly, −2(lx+1))
    // 取局部 (0.6, 0.4, 0.4) ⇒ 世界目标 (10.4, 0.4, −3.2)
    const worldTarget = Object.freeze({ x: 10.4, y: 0.4, z: -3.2 })
    const r = snapPositionInWorld(scene, 'C', worldTarget, Object.freeze({ kind: 'snap', gridSize: 1, space: 'world' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 局部吸附到 (1,0,0) ⇒ 回到世界 (10, 0, −4)
    expect(approxVec3(r.value, Object.freeze({ x: 10, y: 0, z: -4 }), 1e-9)).toBe(true)

    // 换回局部后确实落在整数格上
    const inv = worldMatrixInverse(scene, 'C')
    if (!inv.ok) throw new Error('fixture')
    const localSnapped = transformPoint(inv.value, r.value)
    for (const c of [localSnapped.x, localSnapped.y, localSnapped.z]) {
      expect(Math.abs(c - Math.round(c)), '局部坐标落在整数格上').toBeLessThan(1e-9)
    }

    // **关键区别**：直接对世界坐标取整会得到 (10, 0, −3) ≠ (10, 0, −4)
    const naiveWorld = Object.freeze({ x: Math.round(worldTarget.x), y: Math.round(worldTarget.y), z: Math.round(worldTarget.z) })
    expect(approxVec3(r.value, naiveWorld, 1e-9), '世界空间吸附 ≠ 直接对世界坐标取整').toBe(false)

    // 且**不存在**单一世界格距能复现该结果：父的缩放是非均匀的
    // （局部 x 走 1 步 ⇒ 世界 z 走 2；局部 y 走 1 步 ⇒ 世界 y 走 1）
    const w = worldMatrix(scene, 'C')
    if (!w.ok) throw new Error('fixture')
    const stepX = transformPoint(w.value, Object.freeze({ x: 1, y: 0, z: 0 }))
    const origin = transformPoint(w.value, Object.freeze({ x: 0, y: 0, z: 0 }))
    const stepY = transformPoint(w.value, Object.freeze({ x: 0, y: 1, z: 0 }))
    expect(Math.abs(stepX.z - origin.z), '局部 x 一步 ⇒ 世界 z 两步').toBeCloseTo(2, 12)
    expect(Math.abs(stepY.y - origin.y), '局部 y 一步 ⇒ 世界 y 一步').toBeCloseTo(1, 12)
    expect(Math.abs(stepX.z - origin.z)).not.toBeCloseTo(Math.abs(stepY.y - origin.y), 6)
  })

  it('**负对照**：用错入口（局部策略送进世界吸附）⇒ 显式拒绝，不"顺手"按局部处理', () => {
    const scene = parentChild()
    const r = snapPositionInWorld(scene, 'C', Object.freeze({ x: 1, y: 1, z: 1 }), Object.freeze({ kind: 'snap', gridSize: 1, space: 'local' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.params.reason).toBe('notWorldSpaceConstraint')
  })

  it('世界吸附遇奇异父链 ⇒ 透传显式拒绝（不返回近似值）', () => {
    const scene = parentChild()
    const singular = Object.freeze({
      ...scene,
      objects: Object.freeze({
        ...scene.objects,
        P: Object.freeze({ ...scene.objects['P'], transform: Object.freeze({ ...scene.objects['P'].transform, scale: Object.freeze({ x: 0, y: 1, z: 1 }) }) }),
      }),
    })
    const r = snapPositionInWorld(singular, 'C', Object.freeze({ x: 1, y: 1, z: 1 }), Object.freeze({ kind: 'snap', gridSize: 1, space: 'world' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.params.reason).toBe('singularTransform')
  })
})

/** 恒等旋转/缩放 + 指定平移的变换（夹具用）。 */
function IDENTITY_TRANSFORM_AT(x: number, y: number, z: number) {
  return Object.freeze({
    position: Object.freeze({ x, y, z }),
    rotation: Object.freeze({ x: 0, y: 0, z: 0, w: 1 }),
    scale: Object.freeze({ x: 1, y: 1, z: 1 }),
    pivot: Object.freeze({ x: 0, y: 0, z: 0 }),
  })
}

function moveObject(scene: Scene, objectId: string, position: { x: number; y: number; z: number }): Scene {
  const obj = scene.objects[objectId]
  return Object.freeze({
    ...scene,
    objects: Object.freeze({
      ...scene.objects,
      [objectId]: Object.freeze({ ...obj, transform: Object.freeze({ ...obj.transform, position: Object.freeze({ ...position }) }) }),
    }),
  })
}

/** 换一份更大的几何数据（用于"包围盒中心 ≠ 原点平均"用例）。 */
function resizeBox(scene: Scene, objectId: string, oldDataId: string, size: number): Scene {
  const obj = scene.objects[objectId]
  const made = addMeshObject(scene, { objectId: `${objectId}__tmp`, dataId: 'gBig', size })
  if (!made.ok) throw new Error('fixture')
  const bigMesh = meshFromPayload(made.value.data['gBig'].payload)
  if (!bigMesh) throw new Error('fixture')
  const data = { ...made.value.data }
  delete data['gBig']
  delete data['gBig_tmp']
  const objects = { ...made.value.objects }
  delete objects[`${objectId}__tmp`]
  // 把大网格塞回旧数据 id
  const original = scene.data[oldDataId]
  return Object.freeze({
    ...scene,
    objects: Object.freeze({ ...objects, [objectId]: Object.freeze({ ...obj, dataId: oldDataId }) }),
    data: Object.freeze({ ...data, [oldDataId]: Object.freeze({ ...original, payload: Object.freeze({ kind: 'mesh' as const, mesh: bigMesh }), topologyVersion: bigMesh.topology.version }) }),
  })
}

void _unusedWorldBounds
