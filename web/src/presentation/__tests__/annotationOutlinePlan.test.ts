/**
 * `presentation/annotationPlan` 与 `presentation/outlinePlan` 的判据测试（#289 P10d）。
 *
 * ## 本文件证的三组事
 *
 * | 组 | 判据 | 违反的后果 |
 * |---|---|---|
 * | 注解编译 | 5 种形状各自读**对它有意义**的字段，缺必需参数**显式跳过** | 少画一个注解而无人知道 |
 * | 注解覆盖层分组 | `overlay: true` ⇒ 覆盖层（不参与深度） | 覆盖层被世界几何遮挡 |
 * | 描边版本判定 | 过期求值/过期拓扑 ⇒ **显式失败**，不画错位的边 | A12「新描边配旧几何」 |
 *
 * ## 为什么描边那组必须用"版本不同"当场判红
 *
 * 「不得新描边配旧几何」是一条**只在时间上成立**的判据 —— 静态读代码看不出。
 * 故本文件构造"拾取键 ≠ 当前键"的场景，并断言返回的是 `stale-evaluation`
 * 而**不是**一条画出来的边。
 */

import { describe, expect, it } from 'vitest'
import {
  ANNOTATION_OVERLAY_RENDER_ORDER,
  DEFAULT_BOX_FILL_OPACITY,
  compileAnnotations,
  partitionAnnotationPrimitives,
  type AnnotationInput,
} from '@/presentation/annotationPlan'
import {
  planOutline,
  planOutlines,
  type OutlineGeometrySource,
  type OutlineRequest,
  type OutlineTarget,
} from '@/presentation/outlinePlan'
import { TIME_ZERO, type EvaluationKey } from '@/presentation/evaluationKey'

// ─────────────────────────────────────────────────────────────────────────────
// 注解编译
// ─────────────────────────────────────────────────────────────────────────────

function anno(init: Partial<AnnotationInput> & Pick<AnnotationInput, 'objectId' | 'shape'>): AnnotationInput {
  return { text: '', visible: true, ...init }
}

describe('注解编译：按形状读它该读的字段', () => {
  it('box：`min`/`max`/`renderStyle`/`opacity`/`fillOpacity`/`frameThickness`/`overlay` 全部进图元', () => {
    const out = compileAnnotations([
      anno({
        objectId: 'a1',
        shape: 'box',
        geometry: {
          min: { x: -1, y: 0, z: -1 },
          max: { x: 1, y: 2, z: 1 },
          renderStyle: 'translucent',
          renderOpacity: 0.4,
          fillOpacity: 0.2,
          frameThickness: 0.05,
          overlay: true,
          color: '#ff0000',
        },
      }),
    ])
    expect(out.skipped).toEqual([])
    expect(out.primitives.length).toBe(1)
    const p = out.primitives[0]!
    expect(p.kind).toBe('box')
    if (p.kind !== 'box') throw new Error('narrow')
    expect(p.min).toEqual([-1, 0, -1])
    expect(p.max).toEqual([1, 2, 1])
    expect(p.renderStyle).toBe('translucent')
    expect(p.opacity).toBe(0.4)
    expect(p.fillOpacity).toBe(0.2)
    expect(p.frameThickness).toBe(0.05)
    expect(p.overlay).toBe(true)
    expect(p.color).toBe('#ff0000')
  })

  it('box：`renderStyle: hidden` ⇒ **显式跳过**（不产出一个"隐藏的盒"让下游再判一次）', () => {
    const out = compileAnnotations([
      anno({ objectId: 'a1', shape: 'box', geometry: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 }, renderStyle: 'hidden' } }),
    ])
    expect(out.primitives).toEqual([])
    expect(out.skipped.length).toBe(1)
    expect(out.skipped[0]!.reason).toBe('invisible')
  })

  it('**负对照**：box 缺 `max` ⇒ `incompleteGeometry`（不用缺省值糊过去）', () => {
    const out = compileAnnotations([
      anno({ objectId: 'a1', shape: 'box', geometry: { min: { x: 0, y: 0, z: 0 } } }),
    ])
    expect(out.primitives).toEqual([])
    expect(out.skipped[0]!.reason).toBe('incompleteGeometry')
    expect(out.skipped[0]!.detail).toContain('max')
  })

  it('point：读 `icon`/`size`；**缺 `size` ⇒ 跳过 + 诊断**（D4-a 裁决）', () => {
    // ⚠️ 本条原先断言"未声明时用呈现缺省 `DEFAULT_POINT_SIZE`"。那**已被裁决推翻**：
    // legacy 的 `_buildPoint` 没有兜底（`annotationMeshProvider:195` 直接 `a.size * 0.1`），
    // 故缺 `size` 时它渲染 NaN 几何 —— 屏幕上**无输出**。回落成 0.3 会画出一个可见的点，
    // 那是**偷渡视觉变更**（"有没有东西"比样式差异更重）。
    // ⇒ 取"跳过 + 结构化诊断"：屏幕结果与 legacy 逐像素一致（都无输出），且缺陷可见。
    const out = compileAnnotations([anno({ objectId: 'p', shape: 'point', geometry: { pos: { x: 1, y: 2, z: 3 } } })])
    expect(out.primitives, '缺 size ⇒ 不产出图元（与 legacy 的 NaN 无绘制一致）').toEqual([])
    expect(out.skipped[0]!.reason, '但必须**显式**报出，不静默').toBe('missingSize')
    expect(out.skipped[0]!.detail, '诊断要说清"缺的是尺寸"').toContain('size')
  })

  it('point：**有** `size` ⇒ 原样使用（不覆盖调用方给的数）', () => {
    const out = compileAnnotations([
      anno({ objectId: 'p', shape: 'point', geometry: { pos: { x: 1, y: 2, z: 3 }, size: 0.75 } }),
    ])
    const p = out.primitives[0]!
    if (p.kind !== 'point') throw new Error('narrow')
    expect(p.pos).toEqual([1, 2, 3])
    expect(p.icon, '未声明 icon 时仍用缺省（icon 有 legacy 兜底）').toBe('diamond')
    expect(p.size, '显式 size 必须原样保留').toBe(0.75)
  })

  it('line：**一个点不算线** ⇒ `incompleteGeometry`（退化的线是缺陷，不是空线）', () => {
    const out = compileAnnotations([
      anno({ objectId: 'l', shape: 'line', geometry: { points: [{ x: 0, y: 0, z: 0 }] } }),
    ])
    expect(out.primitives).toEqual([])
    expect(out.skipped[0]!.reason).toBe('incompleteGeometry')
    expect(out.skipped[0]!.detail).toContain('至少 2')
  })

  it('text：文本来自**载荷**（title/description），几何只提供锚点与字号', () => {
    const out = compileAnnotations([
      anno({ objectId: 't', shape: 'text', text: '标题\n\n说明', geometry: { pos: { x: 0, y: 1, z: 0 }, fontSize: 20 } }),
    ])
    const p = out.primitives[0]!
    if (p.kind !== 'text') throw new Error('narrow')
    expect(p.text).toBe('标题\n\n说明')
    expect(p.fontSize).toBe(20)
  })

  it('face：读 `blockPos` + `quadIndex`', () => {
    const out = compileAnnotations([
      anno({ objectId: 'f', shape: 'face', geometry: { blockPos: { x: 2, y: 3, z: 4 }, quadIndex: 7 } }),
    ])
    const p = out.primitives[0]!
    if (p.kind !== 'face') throw new Error('narrow')
    expect(p.blockPos).toEqual([2, 3, 4])
    expect(p.quadIndex).toBe(7)
  })

  it('非有限坐标 ⇒ `nonFinite`（几何契约 §1：非有限值不参与几何）', () => {
    const out = compileAnnotations([
      anno({ objectId: 'bad', shape: 'point', geometry: { pos: { x: Number.NaN, y: 0, z: 0 } } }),
    ])
    expect(out.primitives).toEqual([])
    expect(out.skipped[0]!.reason).toBe('nonFinite')
  })

  it('无几何参数 ⇒ `noGeometry`（内核只承载了语义数据）', () => {
    const out = compileAnnotations([anno({ objectId: 'n', shape: 'box' })])
    expect(out.skipped[0]!.reason).toBe('noGeometry')
  })

  it('不可见 ⇒ `invisible`（正常跳过，与"缺陷"区分）', () => {
    const out = compileAnnotations([anno({ objectId: 'v', shape: 'point', visible: false, geometry: { pos: { x: 0, y: 0, z: 0 } } })])
    expect(out.primitives).toEqual([])
    expect(out.skipped[0]!.reason).toBe('invisible')
  })

  it('覆盖层分组：`overlay: true` 进覆盖层，其余进世界层', () => {
    const out = compileAnnotations([
      anno({ objectId: 'w', shape: 'box', geometry: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } } }),
      anno({ objectId: 'o', shape: 'box', geometry: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 }, overlay: true } }),
    ])
    const parts = partitionAnnotationPrimitives(out.primitives)
    expect(parts.world.map((p) => p.objectId)).toEqual(['w'])
    expect(parts.overlay.map((p) => p.objectId)).toEqual(['o'])
    expect(ANNOTATION_OVERLAY_RENDER_ORDER).toBe(999)
  })

  it('默认填充不透明度只在未声明时生效（声明了 0 就是 0 —— "缺席"与"零"可区分）', () => {
    const withZero = compileAnnotations([
      anno({ objectId: 'z', shape: 'box', geometry: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 }, fillOpacity: 0 } }),
    ])
    const p = withZero.primitives[0]!
    if (p.kind !== 'box') throw new Error('narrow')
    expect(p.fillOpacity, '显式声明的 0 必须保留').toBe(0)
    expect(DEFAULT_BOX_FILL_OPACITY, '缺省值本身非 0（否则"保留 0"这条无意义）').toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 描边版本判定
// ─────────────────────────────────────────────────────────────────────────────

const KEY_A: EvaluationKey = {
  documentVersion: 1,
  scene: 's1',
  time: TIME_ZERO,
  parameterVersion: 0,
  contentResourceVersions: {},
}
/** 只改了 `documentVersion`（结构维度变了 ⇒ 过期）。 */
const KEY_B: EvaluationKey = { ...KEY_A, documentVersion: 2 }
/** 只改了机位（**非结构**维度 ⇒ A11 要求不算过期）。 */
const KEY_VIEW_ONLY: EvaluationKey = { ...KEY_A, viewProjection: { camera: 'c2', localDisplay: 'all' } }

function source(init: Partial<OutlineGeometrySource> = {}): OutlineGeometrySource {
  return {
    boundsOf: () => ({ min: [0, 0, 0], max: [2, 2, 2] }),
    elementPointsOf: () => [[0, 0, 0]],
    topologyVersionOf: () => 3,
    partBoxesOf: () => [{ min: [0, 0, 0], max: [1, 1, 1] }],
    ...init,
  }
}

function req(target: OutlineTarget, keyAtPick: EvaluationKey = KEY_A): OutlineRequest {
  return { target, keyAtPick, geometry: { id: 'geo:1', version: 'v1' } }
}

describe('描边规划：版本判定必须**先于**几何取用', () => {
  it('object 目标：产出整对象边界盒', () => {
    const out = planOutline(req({ objectId: 'o1', kind: 'object' }), KEY_A, source())
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('narrow')
    expect(out.plan.primitives[0]!.kind).toBe('objectBounds')
  })

  it('**A12 负对照**：拾取键过期 ⇒ `stale-evaluation`，**不**画边', () => {
    const out = planOutline(req({ objectId: 'o1', kind: 'object' }, KEY_A), KEY_B, source())
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('narrow')
    expect(out.skip.kind).toBe('stale-evaluation')
  })

  it('**A11 正面对照**：只改机位（非结构维度）**不算**过期（否则转一下视角描边就消失）', () => {
    const out = planOutline(req({ objectId: 'o1', kind: 'object' }, KEY_A), KEY_VIEW_ONLY, source())
    expect(out.ok).toBe(true)
  })

  it('元素目标：拓扑版本不符 ⇒ `stale-topology`（并报出期望/实际版本）', () => {
    const target: OutlineTarget = { objectId: 'o1', kind: 'face', element: { elementId: 'f1', topologyVersion: 7 } }
    const out = planOutline(req(target), KEY_A, source({ topologyVersionOf: () => 9 }))
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('narrow')
    expect(out.skip.kind).toBe('stale-topology')
    if (out.skip.kind !== 'stale-topology') throw new Error('narrow')
    expect(out.skip.expected).toBe(7)
    expect(out.skip.actual).toBe(9)
  })

  it('元素目标：版本对但拓扑里找不到元素 ⇒ `missing-geometry`（不静默不画）', () => {
    const target: OutlineTarget = { objectId: 'o1', kind: 'vertex', element: { elementId: 'v9', topologyVersion: 3 } }
    const out = planOutline(req(target), KEY_A, source({ elementPointsOf: () => undefined }))
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('narrow')
    expect(out.skip.kind).toBe('missing-geometry')
  })

  it('part 目标：产出部件盒；缺 `partLocalId` ⇒ `incomplete-target`', () => {
    const ok = planOutline(req({ objectId: 'o1', kind: 'part', partLocalId: 'ae2:p1' }), KEY_A, source())
    expect(ok.ok).toBe(true)
    const bad = planOutline(req({ objectId: 'o1', kind: 'part' }), KEY_A, source())
    expect(bad.ok).toBe(false)
    if (bad.ok) throw new Error('narrow')
    expect(bad.skip.kind).toBe('incomplete-target')
  })

  it('cell 目标：缺坐标 ⇒ `incomplete-target`', () => {
    const bad = planOutline(req({ objectId: 'o1', kind: 'cell' }), KEY_A, source())
    expect(bad.ok).toBe(false)
    if (bad.ok) throw new Error('narrow')
    expect(bad.skip.kind).toBe('incomplete-target')
  })

  it('整对象无几何 ⇒ `missing-geometry`（**不**用零盒冒充）', () => {
    const out = planOutline(req({ objectId: 'o1', kind: 'object' }), KEY_A, source({ boundsOf: () => undefined }))
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('narrow')
    expect(out.skip.kind).toBe('missing-geometry')
  })

  it('批量：**逐条独立**失败（一条过期不让其余选择消失），且失败原因逐条报出', () => {
    const out = planOutlines(
      [
        req({ objectId: 'ok1', kind: 'object' }, KEY_A),
        req({ objectId: 'stale', kind: 'object' }, KEY_A),
        req({ objectId: 'ok2', kind: 'object' }, KEY_A),
      ],
      KEY_B,
      source(),
    )
    expect(out.plans.length).toBe(0)
    expect(out.skipped.length).toBe(3)
    // 全部过期（因为整批用同一 keyAtPick）：三条各自报一次
    expect(out.skipped.every((s) => s.kind === 'stale-evaluation')).toBe(true)
  })

  it('批量：混合情况——可画的画出，过期的进 skipped', () => {
    const out = planOutlines(
      [req({ objectId: 'a', kind: 'object' }, KEY_A), req({ objectId: 'b', kind: 'object' }, KEY_B)],
      KEY_A,
      source(),
    )
    expect(out.plans.map((p) => p.primitives[0]!.objectId)).toEqual(['a'])
    expect(out.skipped.length).toBe(1)
  })

  it('描边的几何版本随结果返回（供呈现侧做几何缓存键）', () => {
    const out = planOutline(req({ objectId: 'o1', kind: 'object' }), KEY_A, source())
    if (!out.ok) throw new Error('narrow')
    expect(out.plan.geometry).toEqual({ id: 'geo:1', version: 'v1' })
  })
})
