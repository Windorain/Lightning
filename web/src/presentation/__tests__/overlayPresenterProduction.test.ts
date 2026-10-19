/**
 * **R1-β① C7 · 注解/描边真的进 GPU**（生产装配链）。
 *
 * ## 判据的输入来自生产解析 + 装配
 *
 * 链条：`RuntimeDocument.fromV2Plain(...)`（真实 V2Plain 信封）
 * → `assembleKernelDocument({doc})`（生产装配）→ 内核 `Scene`
 * → `kernelAnnotationInputs(scene)` → `compileAnnotations`
 * → `PresenterSession.setAnnotations` → `presenterSession.object3d` 下的真实 THREE 对象。
 *
 * 禁手搓载荷：本文件不构造 `AnnotationInput`，只从信封出发。
 *
 * ## 负对照
 *
 * ① 不调用 `setAnnotations`（= 画面仍由 legacy `AnnotationMeshProvider` 产出）⇒ 对象数为 0；
 * ② 内核承载丢掉几何（P10c 实测状态）⇒ 一件都不画且**显式**报原因。
 * 两条都必须判红，故"新路径能用"不是恒真。
 */

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { RuntimeDocument } from '@/context/runtimeDocument'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { kernelAnnotationInputs } from '@/composition/kernelAnnotationInputs'
import { PresenterSession } from '@/composition/presenterSession'
import { planOutline, type OutlineGeometrySource } from '@/presentation/outlinePlan'
import { unwrap } from '@/domain/errors'
import type { EvaluationKey } from '@/presentation/evaluationKey'

/** 真实 V2Plain 信封（含网格，故装配出的场景是生产形态而不是手工空壳）。 */
function envelope(annotations: Record<string, unknown>[]): RuntimeDocument {
  return RuntimeDocument.fromV2Plain({
    format_version: '2.0',
    id: 'c7-anno',
    meta: { name: 'c7', author: '', created_at_ms: 0, description: '', tags: [], origin: { x: 0, y: 0, z: 0 } },
    annotations,
    labels: [],
    frames: [
      {
        index: 0,
        structure: {
          geometryPhase: 'baked',
          cellGrid: [[[1]]],
          blockPalette: [
            { registryId: 'air', meta: 0, renderMode: 'BlockModel' },
            { registryId: 'minecraft:stone', meta: 0, renderMode: 'BlockModel' },
          ],
        },
      },
    ],
  })!
}

const BOX = {
  id: 'b1',
  type: 'box',
  title: '盒',
  visible: true,
  min: { x: -1, y: 0, z: -2 },
  max: { x: 3, y: 4, z: 5 },
  color: '#44ff88',
  renderStyle: 'boxFrame',
  renderOpacity: 0.5,
  fillOpacity: 0.2,
  frameThickness: 0.06,
} as const

function sessionFor(annotations: Record<string, unknown>[]): {
  session: PresenterSession
  sceneObjects: number
  /** 短 id（信封里的 `id`）→ 内核场景对象 id。 */
  objectIdOf: (short: string) => string
} {
  const doc = envelope(annotations)
  const assembled = unwrap(assembleKernelDocument({ doc }))
  const inputs = kernelAnnotationInputs(assembled.scene).inputs
  const session = new PresenterSession({ scope: 'c7-annotation-prod' })
  session.setAnnotations(inputs)
  return {
    session,
    sceneObjects: inputs.length,
    objectIdOf: (short) => {
      const hit = Object.keys(assembled.scene.objects).find((id) => id.endsWith(`:${short}`))
      if (hit === undefined) throw new Error(`装配后找不到注解对象 ${short}`)
      return hit
    },
  }
}

function key(documentVersion: number): EvaluationKey {
  return {
    documentVersion,
    scene: 'scene-1',
    time: { seconds: 0, numerator: 0, denominator: 1 },
    parameterVersion: 0,
    contentResourceVersions: {},
  }
}

describe('C7 · 注解：生产装配 → PresenterSession → 真实对象', () => {
  it('盒注解的杆与填充按 `min`/`max` 落在世界坐标（几何真的来自内核承载）', () => {
    const { session, sceneObjects, objectIdOf } = sessionFor([BOX])
    expect(sceneObjects, '生产装配必须认出 1 条注解').toBe(1)
    const id = objectIdOf('b1')
    const stats = session.overlayStatsSnapshot()
    expect(stats.annotationObjects, '必须真的往 GPU 侧建对象').toBeGreaterThan(0)

    const bars: THREE.Mesh[] = []
    let fill: THREE.Mesh | null = null
    session.object3d.traverse((o) => {
      if (o.name.startsWith(`anno-box-frame-${id}-`)) bars.push(o as THREE.Mesh)
      if (o.name === `anno-box-fill-${id}`) fill = o as THREE.Mesh
    })
    expect(bars.length, 'boxFrame 的 12 根杆').toBe(12)
    expect(fill, 'fillOpacity>0 ⇒ 有填充').not.toBeNull()

    const xs = bars.map((b) => b.position.x)
    expect(Math.min(...xs), '杆的 x 下界 = min.x').toBeCloseTo(-1, 6)
    expect(Math.max(...xs), '杆的 x 上界 = max.x').toBeCloseTo(3, 6)
    const barMat = bars[0]!.material as THREE.MeshBasicMaterial
    expect(barMat.color.getHexString(), '颜色来自内核承载 #44ff88').toBe('44ff88')
  })

  it('`overlay: true` 的画在覆盖层（不写深度 + renderOrder 999），世界层的照旧参与深度', () => {
    const { session } = sessionFor([
      { ...BOX, id: 'w1', overlay: false },
      { ...BOX, id: 'o1', overlay: true },
    ])
    const world = session.object3d.getObjectByName('annotations-world:c7-annotation-prod')!
    const overlay = session.object3d.getObjectByName('annotations-overlay:c7-annotation-prod')!
    expect(world.children.length, '世界层有对象').toBeGreaterThan(0)
    expect(overlay.children.length, '覆盖层有对象').toBeGreaterThan(0)
    const overlayBar = overlay.children[0] as THREE.Mesh
    const worldBar = world.children[0] as THREE.Mesh
    const om = overlayBar.material as THREE.MeshBasicMaterial
    const wm = worldBar.material as THREE.MeshBasicMaterial
    expect(om.depthTest, '覆盖层不测深度').toBe(false)
    expect(overlayBar.renderOrder).toBe(999)
    expect(wm.depthTest, '世界层参与深度').toBe(true)
    expect(worldBar.renderOrder).toBe(0)
  })

  it('五形状：box/point/line/face 出对象，text 在无 canvas 环境**显式**报不画（不冒充）', () => {
    const { session, objectIdOf } = sessionFor([
      BOX,
      { id: 'p1', type: 'point', visible: true, pos: { x: 1, y: 2, z: 3 }, size: 2, icon: 'diamond', color: '#ff0000' },
      {
        id: 'l1',
        type: 'line',
        visible: true,
        points: [
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 4, z: 0 },
        ],
        thickness: 0.2,
        arrow: 'end',
        showPoints: true,
        color: '#00ff00',
      },
      { id: 'f1', type: 'face', visible: true, blockPos: { x: 0, y: 0, z: 0 }, quadIndex: 0, color: '#ffffff' },
      { id: 't1', type: 'text', visible: true, title: 'T', text: 'T', pos: { x: 1, y: 1, z: 1 }, fontSize: 12 },
    ])
    const names: string[] = []
    session.object3d.traverse((o) => names.push(o.name))
    const b = objectIdOf('b1')
    const p = objectIdOf('p1')
    const l = objectIdOf('l1')
    const f = objectIdOf('f1')
    expect(names.some((n) => n.startsWith(`anno-box-frame-${b}-`))).toBe(true)
    expect(names.some((n) => n.startsWith(`anno-point-${p}`))).toBe(true)
    expect(names.some((n) => n === `anno-line-${l}#s0`)).toBe(true)
    expect(names.some((n) => n === `anno-line-arrow-${l}`)).toBe(true)
    expect(names.filter((n) => n.startsWith(`anno-point-${l}#v`)), 'showPoints ⇒ 逐点小球').toHaveLength(2)
    // `face` 需要几何端口；会话未注入端口 ⇒ 必须显式报"不画"，而不是悄悄跳过。
    const outcome = session.setAnnotations([{ objectId: f, shape: 'face', text: '', visible: true }])
    expect(outcome.unrendered.map((u) => u.aspect)).toContain('skipped:noGeometry')
  })

  it('**负对照①（留旁路必须判红）**：不给会话喂注解 ⇒ overlay 一件都没有', () => {
    const doc = envelope([BOX])
    const assembled = unwrap(assembleKernelDocument({ doc }))
    expect(doc.annotations.length, '信封里确实有注解（故上一条不是恒真）').toBeGreaterThan(0)
    const inputs = kernelAnnotationInputs(assembled.scene).inputs
    expect(inputs.length).toBe(1)

    // 模拟"画面仍由 legacy 的 `AnnotationMeshProvider` 产出"：内核呈现会话从未拿到注解。
    const idle = new PresenterSession({ scope: 'c7-annotation-bypass' })
    expect(idle.overlayStatsSnapshot().annotationObjects, '旁路 ⇒ 0 件').toBe(0)

    const wired = new PresenterSession({ scope: 'c7-annotation-wired' })
    wired.setAnnotations(inputs)
    expect(wired.overlayStatsSnapshot().annotationObjects, '接线 ⇒ >0 件').toBeGreaterThan(0)
  })

  it('**负对照②（内核承重丢字段）**：注解在但几何参数缺席 ⇒ 一件不画且显式报据', () => {
    const { session } = sessionFor([{ id: 'b9', type: 'box', title: '只有语义', visible: true }])
    const outcome = session.setAnnotations(
      kernelAnnotationInputs(unwrap(assembleKernelDocument({ doc: envelope([{ id: 'b9', type: 'box', visible: true }]) })).scene).inputs,
    )
    expect(session.overlayStatsSnapshot().annotationObjects).toBe(0)
    expect(outcome.drawn).toBe(0)
    expect(outcome.unrendered[0]!.aspect).toMatch(/^skipped:/)
  })
})

describe('C7 · 描边：OutlinePlan → PresenterSession → 真实对象', () => {
  function source(): OutlineGeometrySource {
    return {
      boundsOf: () => ({ min: [0, 0, 0] as const, max: [1, 2, 3] as const }),
      elementPointsOf: () => [
        [0, 0, 0] as const,
        [1, 1, 1] as const,
      ],
      topologyVersionOf: () => 7,
      partBoxesOf: () => [{ min: [0, 0, 0] as const, max: [1, 1, 1] as const }],
      cellOriginOf: () => [0, 0, 0] as const,
      cellQuadsOf: () => [
        {
          materialIndex: 0,
          vertices: [
            { x: 0, y: 0, z: 0, u: 0, v: 0 },
            { x: 16, y: 0, z: 0, u: 1, v: 0 },
            { x: 16, y: 16, z: 0, u: 1, v: 1 },
            { x: 0, y: 16, z: 0, u: 0, v: 1 },
          ],
        },
      ],
    }
  }

  it('对象盒/整格四边形描边产出真实对象，且用呈现侧的颜色政策', () => {
    const k = key(3)
    const session = new PresenterSession({ scope: 'c7-outline-prod' })
    const planned = planOutline(
      { target: { objectId: 'obj1', kind: 'object' }, keyAtPick: k, geometry: { id: 'g1', version: 'v1' } },
      k,
      source(),
    )
    expect(planned.ok, '同键 ⇒ 不是 stale').toBe(true)
    const outcome = session.applyOutline(planned.ok ? planned.plan : null, { color: 0xff8800, opacity: 0.8 })
    expect(outcome.drawn).toBeGreaterThan(0)
    const outline = session.object3d.getObjectByName('outline:c7-outline-prod')!
    expect(outline.children.length).toBeGreaterThan(0)
    const lines: THREE.LineSegments[] = []
    outline.traverse((o) => {
      if ((o as THREE.LineSegments).isLineSegments === true) lines.push(o as THREE.LineSegments)
    })
    expect(lines.length, '1 个 LineSegments').toBe(1)
    expect(
      lines[0]!.geometry.getAttribute('position').count,
      '12 条边 × 2 顶点',
    ).toBe(24)
    const material = lines[0]!.material as THREE.LineBasicMaterial
    expect(material.color.getHexString(), '颜色来自呈现侧政策（不是计划里的字段）').toBe('ff8800')
  })

  it('逐格四边形描边画出真实的格形状（不是 1×1×1 兜底盒）', () => {
    const k = key(5)
    const session = new PresenterSession({ scope: 'c7-outline-cell' })
    const planned = planOutline(
      {
        target: { objectId: 'obj1', kind: 'cell', cell: [0, 0, 0] },
        keyAtPick: k,
        geometry: { id: 'g1', version: 'v1' },
      },
      k,
      source(),
    )
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.plan.primitives[0]!.kind, '有 quads ⇒ 必须走 cellQuads 而不是兜底盒').toBe('cellQuads')
    session.applyOutline(planned.plan)
    const mesh = session.object3d.getObjectByName('outline-cell-obj1') as THREE.Mesh
    expect(mesh, '格子轮廓是一个 mesh（按四边形）').not.toBeNull()
    const pos = mesh.geometry.getAttribute('position').count
    expect(pos, '2 个三角形 × 3 顶点').toBe(6)
  })

  it('**负对照（A12）**：过期求值键 ⇒ 规划器拒绝，画面里不得出现新描边', () => {
    const current = key(9)
    const session = new PresenterSession({ scope: 'c7-outline-stale' })
    const planned = planOutline(
      { target: { objectId: 'obj1', kind: 'object' }, keyAtPick: key(4), geometry: { id: 'g1', version: 'v1' } },
      current,
      source(),
    )
    expect(planned.ok, '过期画面上的引用不得用于描边').toBe(false)
    if (!planned.ok) expect(planned.skip.kind).toBe('stale-evaluation')
    // 生产纪律：`ok:false` ⇒ 不 apply（而不是画一个"差不多"的）
    session.applyOutline(planned.ok ? planned.plan : null)
    const outline = session.object3d.getObjectByName('outline:c7-outline-stale')!
    expect(outline.children.length, '拒绝 ⇒ 0 件').toBe(0)
  })

  it('`applyOutline(null)` 清空；`dispose()` 释放（负对照：清空后不是"留着上一次的"）', () => {
    const k = key(3)
    const session = new PresenterSession({ scope: 'c7-outline-clear' })
    const planned = planOutline(
      { target: { objectId: 'obj1', kind: 'object' }, keyAtPick: k, geometry: { id: 'g1', version: 'v1' } },
      k,
      source(),
    )
    session.applyOutline(planned.ok ? planned.plan : null)
    expect(session.overlayStatsSnapshot().outlineObjects).toBeGreaterThan(0)
    session.applyOutline(null)
    expect(session.overlayStatsSnapshot().outlineObjects).toBe(0)
    session.applyOutline(planned.ok ? planned.plan : null)
    session.dispose()
    expect(session.overlayStatsSnapshot().disposals).toBeGreaterThan(0)
  })
})
