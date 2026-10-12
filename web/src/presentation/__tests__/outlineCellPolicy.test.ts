/**
 * **P10e（#299）· 描边规划的两个待裁决项**：`cellQuads` 形态 + 政策点两向实测。
 *
 * ## 为什么这两个分支必须有判据（而不是"实现了就行"）
 *
 * P10d D3b 登记的两个待裁决项（O1/O3 的兜底盒政策、O2 的 A12 版本检查）是**政策**分歧，
 * 不是实现分歧 —— 两条分支都"对"，选哪条由 Lead 裁决（#289 的裁决纪律）。
 *
 * 于是执行者的义务是**让两条分支都可运行、可断言、默认值 = 基线**。本文件就是那个"可断言"：
 *
 * | 政策点 | 两向判据 |
 * |---|---|
 * | ① `cellWithoutQuads` | `'fallback-box'` ⇒ 产出 `cellBox`；`'none'` ⇒ `missing-geometry` |
 * | ② `stalePickAtOutline` | `'suspend'` ⇒ 过期不出计划；`'draw'` ⇒ 过期照样出计划 |
 *
 * 缺任何一向，那个政策就退化成"注释里说有两个选项，代码里只有一个"
 * —— 而裁决后要改的地方就没被验证过。**未验证的分支等于不存在**。
 */
import { describe, expect, it } from 'vitest'
import {
  BASELINE_OUTLINE_POLICY,
  planOutline,
  planOutlines,
  type OutlineGeometrySource,
  type OutlinePolicy,
  type OutlineRequest,
  type OutlineTarget,
} from '@/presentation/outlinePlan'
import { TIME_ZERO, type EvaluationKey } from '@/presentation/evaluationKey'

const KEY_A: EvaluationKey = {
  documentVersion: 1,
  scene: 's1',
  time: TIME_ZERO,
  parameterVersion: 0,
  contentResourceVersions: {},
}
/** 结构维度变了 ⇒ 过期。 */
const KEY_B: EvaluationKey = { ...KEY_A, documentVersion: 2 }

/** 一个四边形（格内局部坐标，与生产 `domain/blockGeometry#Quad` 同空间）。 */
const QUAD = Object.freeze({
  materialIndex: 0,
  vertices: Object.freeze([
    Object.freeze({ x: 0, y: 0, z: 0, u: 0, v: 0 }),
    Object.freeze({ x: 16, y: 0, z: 0, u: 1, v: 0 }),
    Object.freeze({ x: 16, y: 16, z: 0, u: 1, v: 1 }),
    Object.freeze({ x: 0, y: 16, z: 0, u: 0, v: 1 }),
  ]),
})

function source(init: Partial<OutlineGeometrySource> = {}): OutlineGeometrySource {
  return {
    boundsOf: () => ({ min: [0, 0, 0], max: [2, 2, 2] }),
    elementPointsOf: () => [[0, 0, 0]],
    topologyVersionOf: () => 3,
    partBoxesOf: () => [{ min: [0, 0, 0], max: [1, 1, 1] }],
    cellQuadsOf: () => [QUAD],
    cellOriginOf: () => [-0.5, -0.5, -0.5],
    ...init,
  }
}

function req(target: OutlineTarget, keyAtPick: EvaluationKey = KEY_A): OutlineRequest {
  return { target, keyAtPick, geometry: { id: 'geo:1', version: 'v1' } }
}

const CELL_TARGET: OutlineTarget = { objectId: 'o1', kind: 'cell', cell: [1, 2, 3] }

describe('P10e · `cellQuads` 形态：逐格四边形轮廓（legacy 整格 quads 通道的等价物）', () => {
  it('有四边形 ⇒ 产出 `cellQuads`，带 origin 与该格的四边形**逐字段**保留', () => {
    const out = planOutline(req(CELL_TARGET), KEY_A, source())
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('narrow')
    const prim = out.plan.primitives[0]!
    expect(prim.kind).toBe('cellQuads')
    if (prim.kind !== 'cellQuads') throw new Error('narrow')
    expect(prim.objectId).toBe('o1')
    expect(prim.origin).toEqual([-0.5, -0.5, -0.5])
    expect(prim.quads.length).toBe(1)
    expect(prim.quads[0]!.materialIndex).toBe(0)
    expect(prim.quads[0]!.vertices.length).toBe(4)
    // 顶点坐标**逐字段**保留（不做任何变换 —— 变换由呈现侧按 origin 施加）
    expect(prim.quads[0]!.vertices[2]).toEqual({ x: 16, y: 16, z: 0, u: 1, v: 1 })
  })

  it('**不是** `cellBox`：有四边形时不得退化成 1×1×1 盒（那是可感知的视觉回退）', () => {
    const out = planOutline(req(CELL_TARGET), KEY_A, source())
    if (!out.ok) throw new Error('narrow')
    expect(out.plan.primitives[0]!.kind).not.toBe('cellBox')
  })

  it('端口**缺席** `cellQuadsOf`（不提供该能力）⇒ 走政策（不是崩，也不是静默不画）', () => {
    const src = source()
    delete (src as { cellQuadsOf?: unknown }).cellQuadsOf
    const out = planOutline(req(CELL_TARGET), KEY_A, src)
    expect(out.ok, '端口缺席不是错误，是"该来源不支持逐格轮廓"').toBe(true)
    if (!out.ok) throw new Error('narrow')
    expect(out.plan.primitives[0]!.kind, '基线政策下退化为兜底盒').toBe('cellBox')
  })

  it('格**不在当前网格**（`cellOriginOf` 返回 undefined）⇒ `missing-geometry`（与"格在但无几何"是两件事）', () => {
    const out = planOutline(req(CELL_TARGET), KEY_A, source({ cellOriginOf: () => undefined }))
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('narrow')
    expect(out.skip.kind).toBe('missing-geometry')
    expect(out.skip.detail).toContain('没有格')
  })

  it('缺 `cell` 坐标 ⇒ `incomplete-target`（保持既有判据，未被新分支覆盖）', () => {
    const out = planOutline(req({ objectId: 'o1', kind: 'cell' }), KEY_A, source())
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('narrow')
    expect(out.skip.kind).toBe('incomplete-target')
  })
})

describe('P10e · 政策点 ① `cellWithoutQuads`：两向实测（O1/O3 待裁决项）', () => {
  it("`'fallback-box'`（**基线** = legacy 行为）⇒ 产出 `cellBox`，且带真实 origin", () => {
    const out = planOutline(
      req(CELL_TARGET),
      KEY_A,
      source({ cellQuadsOf: () => undefined }),
      { ...BASELINE_OUTLINE_POLICY, cellWithoutQuads: 'fallback-box' },
    )
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('narrow')
    const prim = out.plan.primitives[0]!
    expect(prim.kind).toBe('cellBox')
    if (prim.kind !== 'cellBox') throw new Error('narrow')
    expect(prim.cell).toEqual([1, 2, 3])
    expect(prim.origin, '兜底盒必须有真实格角（呈现侧不得自己从下标算世界坐标）').toEqual([-0.5, -0.5, -0.5])
  })

  it("`'none'` ⇒ `missing-geometry` 且**不画**（判别式里说明是政策选择，不是缺陷）", () => {
    const out = planOutline(
      req(CELL_TARGET),
      KEY_A,
      source({ cellQuadsOf: () => undefined }),
      { ...BASELINE_OUTLINE_POLICY, cellWithoutQuads: 'none' },
    )
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('narrow')
    expect(out.skip.kind).toBe('missing-geometry')
    expect(out.skip.detail, '诊断必须点明是政策而非缺陷').toContain("cellWithoutQuads='none'")
  })

  it('**空四边形数组**与 `undefined` 走**同一条**政策（无面就画不出轮廓）', () => {
    const empty = planOutline(
      req(CELL_TARGET),
      KEY_A,
      source({ cellQuadsOf: () => [] }),
      { ...BASELINE_OUTLINE_POLICY, cellWithoutQuads: 'none' },
    )
    expect(empty.ok).toBe(false)
    const missing = planOutline(
      req(CELL_TARGET),
      KEY_A,
      source({ cellQuadsOf: () => undefined }),
      { ...BASELINE_OUTLINE_POLICY, cellWithoutQuads: 'none' },
    )
    expect(missing.ok).toBe(false)
    // 两者都走政策 ⇒ 同一分支。若哪天有人让空数组绕过政策，这一条会判红。
    if (empty.ok || missing.ok) throw new Error('narrow')
    expect(empty.skip.kind).toBe(missing.skip.kind)
  })

  it('**两向都不是恒真**：同一输入在两个政策下给出**不同**结果', () => {
    const mk = (p: OutlinePolicy) =>
      planOutline(req(CELL_TARGET), KEY_A, source({ cellQuadsOf: () => undefined }), p)
    const box = mk({ ...BASELINE_OUTLINE_POLICY, cellWithoutQuads: 'fallback-box' })
    const none = mk({ ...BASELINE_OUTLINE_POLICY, cellWithoutQuads: 'none' })
    expect(box.ok, 'fallback-box 必须成功').toBe(true)
    expect(none.ok, 'none 必须失败').toBe(false)
    // 这是"政策真的生效"的机械证据：结果不同，故两个分支都被覆盖
    expect(box.ok).not.toBe(none.ok)
  })
})

describe('P10e · 政策点 ② `stalePickAtOutline`：两向实测（O2 待裁决项 / A12）', () => {
  it("`'suspend'`（**基线** = 新规划器行为）⇒ 过期时**不画**，且原因可展示", () => {
    const out = planOutline(
      req({ objectId: 'o1', kind: 'object' }, KEY_A),
      KEY_B,
      source(),
      { ...BASELINE_OUTLINE_POLICY, stalePickAtOutline: 'suspend' },
    )
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('narrow')
    expect(out.skip.kind).toBe('stale-evaluation')
    expect(out.skip.detail).toContain('A12')
  })

  it("`'draw'`（= legacy 行为：不做版本检查）⇒ 过期时**照样**出计划", () => {
    const out = planOutline(
      req({ objectId: 'o1', kind: 'object' }, KEY_A),
      KEY_B,
      source(),
      { ...BASELINE_OUTLINE_POLICY, stalePickAtOutline: 'draw' },
    )
    expect(out.ok, "'draw' 政策下过期不得阻止出计划").toBe(true)
    if (!out.ok) throw new Error('narrow')
    expect(out.plan.primitives[0]!.kind).toBe('objectBounds')
  })

  it("`'draw'` 政策下**只**关掉版本判定：其它判据（拓扑/几何）仍然生效", () => {
    // 这是"政策是**局部**开关"的判据：放宽版本检查不得顺带放宽拓扑过期与几何缺失。
    const staleTopo = planOutline(
      req({ objectId: 'o1', kind: 'face', element: { elementId: 'f1', topologyVersion: 7 } }, KEY_A),
      KEY_B,
      source({ topologyVersionOf: () => 9 }),
      { ...BASELINE_OUTLINE_POLICY, stalePickAtOutline: 'draw' },
    )
    expect(staleTopo.ok, '拓扑过期仍必须判红（政策只关版本判定）').toBe(false)
    if (staleTopo.ok) throw new Error('narrow')
    expect(staleTopo.skip.kind).toBe('stale-topology')

    const noGeom = planOutline(
      req({ objectId: 'o1', kind: 'object' }, KEY_A),
      KEY_B,
      source({ boundsOf: () => undefined }),
      { ...BASELINE_OUTLINE_POLICY, stalePickAtOutline: 'draw' },
    )
    expect(noGeom.ok, '无几何仍必须判红').toBe(false)
    if (noGeom.ok) throw new Error('narrow')
    expect(noGeom.skip.kind).toBe('missing-geometry')
  })

  it('机位变化（**非结构**维度）在两个政策下都不算过期（A11，未被政策影响）', () => {
    const viewOnly: EvaluationKey = { ...KEY_A, viewProjection: { camera: 'c2', localDisplay: 'all' } }
    for (const p of ['suspend', 'draw'] as const) {
      const out = planOutline(
        req({ objectId: 'o1', kind: 'object' }, KEY_A),
        viewOnly,
        source(),
        { ...BASELINE_OUTLINE_POLICY, stalePickAtOutline: p },
      )
      expect(out.ok, `政策 ${p}：只改机位不得算过期`).toBe(true)
    }
  })
})

describe('P10e · 政策是**唯一**的施加点（防"三处各判一次兜底盒"）', () => {
  it('`planOutlines` 透传政策，且仍**逐条独立**失败', () => {
    const requests = [
      req({ objectId: 'ok1', kind: 'cell', cell: [0, 0, 0] }),
      req({ objectId: 'nogeo', kind: 'cell', cell: [0, 0, 0] }),
      req({ objectId: 'ok2', kind: 'cell', cell: [1, 0, 0] }),
    ]
    const src = source({
      // 只有 `nogeo` 那一格没有几何
      cellQuadsOf: (objectId) => (objectId === 'nogeo' ? undefined : [QUAD]),
      cellOriginOf: (objectId) => (objectId === 'nogeo' ? [0, 0, 0] : [1, 1, 1]),
    })
    // 基线：三条全出计划（nogeo 走兜底盒）
    const baseline = planOutlines(requests, KEY_A, src, BASELINE_OUTLINE_POLICY)
    expect(baseline.plans.length).toBe(3)
    expect(baseline.skipped.length).toBe(0)

    // 'none'：只有 nogeo 失败，其余两条**不受影响**（逐条独立）
    const strict = planOutlines(requests, KEY_A, src, { ...BASELINE_OUTLINE_POLICY, cellWithoutQuads: 'none' })
    expect(strict.plans.length).toBe(2)
    expect(strict.skipped.length).toBe(1)
    expect(strict.plans.map((p) => p.primitives[0]!.objectId)).toEqual(['ok1', 'ok2'])
  })

  it('**反空洞真**：基线政策的两个字段就是台账里登记的那两个取值', () => {
    // 防止有人把基线悄悄改成"更严"的那一档而不留痕（那会让本批引入未经裁决的行为变更）。
    expect(BASELINE_OUTLINE_POLICY.cellWithoutQuads, '基线 = legacy 的两处兜底盒').toBe('fallback-box')
    expect(BASELINE_OUTLINE_POLICY.stalePickAtOutline, '基线 = 规划器现行为（A12 字面）').toBe('suspend')
    expect(Object.isFrozen(BASELINE_OUTLINE_POLICY), '基线必须冻结（政策不得被就地改写）').toBe(true)
  })
})
