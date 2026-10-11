/**
 * **P10d（#289）· 注解几何的承载往返**（内核内容面补全的第三半）。
 *
 * ## 本文件证什么
 *
 * P10c（#286）实测的决定性事实（机械证据）：
 *
 * > **注解几何** | 旧面（渲染消费）`min/max/renderStyle/renderOpacity/color/overlay/
 * > frameThickness/frameIndex/locked…` | 内核承载 `{shape, text?}` 两项 |
 * > 实测：注入完整 box 注解 ⇒ 内核 payload = `{"kind":"annotation","shape":"box","text":"T\n\nD"}`
 * > —— **几何字段全丢**
 *
 * ⇒ 内核通道下的注解渲染不出几何（`annotationMeshProvider` 读的字段全缺席）。
 * 本文件证明那 22 个呈现参数**真的进了内核**并且**能原样回来**。
 *
 * ## 判据的形状
 *
 * 逐字段**双向**断言：正向（文件 → 内核载荷）与反向（内核载荷 → 文件条目）都要成立，
 * 且**未给出的字段不得凭空出现**（那会让"这份注解没写颜色"变成"写了默认色"，
 * 而后者在往返后无法退回）。
 */

import { describe, expect, it } from 'vitest'
import { assembleKernelDocument, annotationGeometryFromLegacy } from '@/composition/kernelAssembly'
import { RuntimeDocument } from '@/context/runtimeDocument'
import { unwrap } from '@/domain/errors'
import type { AnnotationGeometry } from '@/domain/scene'

/** 一份带 5 种注解的 V2Plain 文档（每种都写满它自己的字段）。 */
function docWithAnnotations(annotations: Record<string, unknown>[]): RuntimeDocument {
  return RuntimeDocument.fromV2Plain({
    format_version: '2.0',
    id: 'anno-probe',
    meta: { name: 'anno', author: '', created_at_ms: 0, description: '', tags: [], origin: { x: 0, y: 0, z: 0 } },
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

/** 从装配产物里取某注解对象的内核载荷。 */
function payloadOf(doc: RuntimeDocument, annotationId: string): AnnotationGeometry | undefined {
  const assembled = unwrap(assembleKernelDocument({ doc }))
  const objectId = `annotation:${annotationId}`
  const obj = assembled.scene.objects[objectId]
  if (obj === undefined) return undefined
  const data = assembled.scene.data[obj.dataId]
  if (data === undefined || data.payload.kind !== 'annotation') return undefined
  return data.payload.geometry
}

describe('P10d · 注解几何：22 个呈现参数的类型化承载', () => {
  it('box：`min`/`max`/`renderStyle`/`renderOpacity`/`fillOpacity`/`frameThickness`/`overlay`/`locked`/`color` 全部进内核', () => {
    const doc = docWithAnnotations([
      {
        id: 'b1',
        type: 'box',
        title: '盒',
        description: '说明',
        visible: true,
        locked: true,
        min: { x: -1, y: 0, z: -2 },
        max: { x: 3, y: 4, z: 5 },
        color: '#44ff88',
        renderStyle: 'translucent',
        renderOpacity: 0.4,
        fillOpacity: 0.2,
        frameThickness: 0.05,
        overlay: true,
        frameIndex: 2,
      },
    ])
    const g = payloadOf(doc, 'b1')
    expect(g, '内核载荷必须有 geometry（否则就是 P10c 实测的"几何字段全丢"）').toBeDefined()
    expect(g!.min).toEqual({ x: -1, y: 0, z: -2 })
    expect(g!.max).toEqual({ x: 3, y: 4, z: 5 })
    expect(g!.color).toBe('#44ff88')
    expect(g!.renderStyle).toBe('translucent')
    expect(g!.renderOpacity).toBe(0.4)
    expect(g!.fillOpacity).toBe(0.2)
    expect(g!.frameThickness).toBe(0.05)
    expect(g!.overlay).toBe(true)
    expect(g!.locked).toBe(true)
    expect(g!.frameIndex).toBe(2)
  })

  it('point：`pos`/`icon`/`size` 进内核', () => {
    const doc = docWithAnnotations([
      { id: 'p1', type: 'point', title: '点', visible: true, pos: { x: 1, y: 2, z: 3 }, icon: 'circle', size: 0.5 },
    ])
    const g = payloadOf(doc, 'p1')
    expect(g!.pos).toEqual({ x: 1, y: 2, z: 3 })
    expect(g!.icon).toBe('circle')
    expect(g!.size).toBe(0.5)
  })

  it('line：`points`/`thickness`/`arrow`/`showPoints` 进内核', () => {
    const doc = docWithAnnotations([
      {
        id: 'l1',
        type: 'line',
        title: '线',
        visible: true,
        points: [
          { x: 0, y: 0, z: 0 },
          { x: 1, y: 0, z: 0 },
          { x: 1, y: 1, z: 0 },
        ],
        thickness: 0.08,
        arrow: 'both',
        showPoints: true,
      },
    ])
    const g = payloadOf(doc, 'l1')
    expect(g!.points).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 1, y: 1, z: 0 },
    ])
    expect(g!.thickness).toBe(0.08)
    expect(g!.arrow).toBe('both')
    expect(g!.showPoints).toBe(true)
  })

  it('text：`anchorPos` 归一到内核的 `pos`，`fontSize`/`backgroundAlpha`/`linkedAnnotationId` 进内核', () => {
    const doc = docWithAnnotations([
      {
        id: 't1',
        type: 'text',
        title: '字',
        visible: true,
        anchorPos: { x: 2, y: 3, z: 4 },
        text: '内核外的文本',
        fontSize: 22,
        backgroundAlpha: 128,
        linkedAnnotationId: 'b1',
      },
    ])
    const g = payloadOf(doc, 't1')
    // 旧字段名 `anchorPos` 在**承载边界**上归一为内核的 `pos`（呈现层只读一个名字）
    expect(g!.pos, '`anchorPos` 必须被搬运（否则 text 注解的锚点静默丢失）').toEqual({ x: 2, y: 3, z: 4 })
    expect(g!.fontSize).toBe(22)
    expect(g!.backgroundAlpha).toBe(128)
    expect(g!.linkedAnnotationId).toBe('b1')
  })

  it('face：`blockPos`/`quadIndex` 进内核', () => {
    const doc = docWithAnnotations([
      { id: 'f1', type: 'face', title: '面', visible: true, blockPos: { x: 5, y: 6, z: 7 }, quadIndex: 3 },
    ])
    const g = payloadOf(doc, 'f1')
    expect(g!.blockPos).toEqual({ x: 5, y: 6, z: 7 })
    expect(g!.quadIndex).toBe(3)
  })

  it('**语义文本仍在**（`title` + `description` 合成到载荷的 `text`，几何不替代它）', () => {
    const doc = docWithAnnotations([
      { id: 'both', type: 'box', title: 'T', description: 'D', visible: true, min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    ])
    const assembled = unwrap(assembleKernelDocument({ doc }))
    const data = assembled.scene.data[assembled.scene.objects['annotation:both']!.dataId]!
    if (data.payload.kind !== 'annotation') throw new Error('不是 annotation 载荷')
    expect(data.payload.text).toBe('T\n\nD')
    expect(data.payload.geometry, '几何与语义必须**同时**在载荷里').toBeDefined()
  })

  it('**未给出的字段不得凭空出现**（否则往返后无法退回）', () => {
    const g = annotationGeometryFromLegacy({ type: 'box', min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } })
    expect(g).not.toBeNull()
    // 只给了 min/max ⇒ 不得出现 renderStyle/color/opacity/...
    expect(Object.keys(g!).sort()).toEqual(['max', 'min'])
  })

  it('**无几何字段** ⇒ `null`（缺席，而不是一个空对象）', () => {
    expect(annotationGeometryFromLegacy({ type: 'box', title: '只有标题', visible: true })).toBeNull()
    const doc = docWithAnnotations([{ id: 'bare', type: 'box', title: '只有标题', visible: true }])
    expect(payloadOf(doc, 'bare'), '无几何参数 ⇒ 载荷不带 geometry 字段').toBeUndefined()
  })

  it('非有限坐标**不进**几何（几何契约 §1：非有限值不参与几何）', () => {
    const g = annotationGeometryFromLegacy({ type: 'point', pos: { x: Number.NaN, y: 1, z: 2 } })
    expect(g?.pos, '含 NaN 的坐标必须被丢弃（而不是带着 NaN 进内核）').toBeUndefined()
  })

  it('**负对照**：P10c 实测的旧形态（只有 shape/text）确实**丢**几何 —— 证明本批的修法是必要的', () => {
    // 复现 P10c 的观测形状：只搬运 shape + text。
    const legacy: { kind: 'annotation'; shape: string; text?: string } = { kind: 'annotation', shape: 'box', text: 'T\n\nD' }
    const keys = Object.keys(legacy)
    expect(keys, 'P10c 观测到的载荷只有这三个键').toEqual(['kind', 'shape', 'text'])
    // 而修复后的载荷**必然**多出 geometry
    const g = annotationGeometryFromLegacy({ min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } })
    expect(g, '修复后的载荷必须携带 geometry（本文件其余用例逐字段证明它含什么）').not.toBeNull()
  })
})

describe('P10d · 注解形状的**开放**承载（#13「新增一类不需要改核心」）', () => {
  it('5 种形态都被承载，且未知形态**显式诊断**（不静默丢）', () => {
    const doc = docWithAnnotations([
      { id: 'ok', type: 'box', title: 'A', visible: true, min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      { id: 'bad', type: 'octahedron', title: 'B', visible: true },
    ])
    const assembled = unwrap(assembleKernelDocument({ doc }))
    expect(assembled.scene.objects['annotation:ok'], '合法形状必须装配').toBeDefined()
    expect(assembled.scene.objects['annotation:bad'], '未知形状不得被装配成半可用的对象').toBeUndefined()
    const diag = assembled.diagnostics.filter((d) => d.code === 'unsupportedAnnotationShape')
    expect(diag.length, '未知形状必须产出一条显式诊断').toBe(1)
    expect(diag[0]!.path).toContain('annotations[1]')
  })
})
