/**
 * **D3b（#289 P10d）· 内核注解 → 呈现规划输入**。
 *
 * ## 本文件证什么
 *
 * 实测：`presentation/annotationPlan` 的生产消费者是 **0**（唯一消费者是它自己的测试
 * —— D1 交付了规划器却没有接线）。本文件钉住"接线"这一环：内核承载的注解
 * （`ObjectDataPayload{kind:'annotation'}`）能如实翻译成规划器的入参。
 *
 * ## ⚠️ 本文件**不**声称"像素与 legacy 一致"
 *
 * 侦察发现规划器与 legacy `AnnotationMeshProvider` 有**三处真实语义分歧**（默认值），
 * 已按 Lead 的指令**停下上报**，不在本批擅自统一（也不写一个"看起来对上"的判据）。
 * 分歧清单见 `kernelAnnotationInputs` 的汇报（不在源码里立假判据）。
 */

import { describe, expect, it } from 'vitest'
import { kernelAnnotationInputs } from '@/composition/kernelAnnotationInputs'
import { compileAnnotations, partitionAnnotationPrimitives } from '@/presentation/annotationPlan'
import { emptyScene, objectData, sceneObject, type ObjectData, type Scene, type SceneObject } from '@/domain/scene'

/** 造一个只含注解对象的场景（与既有测试同形：`emptyScene` + `objectData` + `sceneObject`）。 */
function sceneWith(
  entries: readonly {
    readonly id: string
    readonly shape: 'box' | 'point' | 'line' | 'text' | 'face'
    readonly text?: string
    readonly geometry?: Record<string, unknown>
  }[],
): Scene {
  const data: Record<string, ObjectData> = {}
  const objects: Record<string, SceneObject> = {}
  const order: string[] = []
  for (const e of entries) {
    const dataId = `${e.id}-data`
    data[dataId] = objectData(dataId, {
      kind: 'annotation',
      shape: e.shape,
      ...(e.text === undefined ? {} : { text: e.text }),
      ...(e.geometry === undefined ? {} : { geometry: e.geometry as never }),
    })
    objects[e.id] = sceneObject({ id: e.id, type: 'annotation', dataId })
    order.push(e.id)
  }
  const base = emptyScene('scene-1')
  return { ...base, order: Object.freeze(order), objects: Object.freeze(objects), data: Object.freeze(data) }
}

const BOX_GEOMETRY: Record<string, unknown> = Object.freeze({
  min: Object.freeze({ x: 0, y: 0, z: 0 }),
  max: Object.freeze({ x: 1, y: 1, z: 1 }),
})

describe('D3b · 内核注解 → 规划器入参（接线这一环）', () => {
  it('逐字段映射：`shape`/`text`/`geometry` 如实搬运', () => {
    const scene = sceneWith([{ id: 'a1', shape: 'box', text: '标题', geometry: BOX_GEOMETRY }])
    const { inputs, skipped } = kernelAnnotationInputs(scene)
    expect(skipped.length).toBe(0)
    expect(inputs.length).toBe(1)
    expect(inputs[0]!.objectId).toBe('a1')
    expect(inputs[0]!.shape).toBe('box')
    expect(inputs[0]!.text).toBe('标题')
    expect(inputs[0]!.geometry).toEqual(BOX_GEOMETRY)
  })

  it('无 `text` ⇒ `\'\'`（规划器的"无文本"约定），**不是** `undefined`', () => {
    const { inputs } = kernelAnnotationInputs(sceneWith([{ id: 'a1', shape: 'point', geometry: BOX_GEOMETRY }]))
    expect(inputs[0]!.text).toBe('')
  })

  it('无 `geometry` ⇒ 字段缺席（规划器据此报 `noGeometry`，不产出几何图元）', () => {
    const { inputs } = kernelAnnotationInputs(sceneWith([{ id: 'a1', shape: 'box', text: '只有语义' }]))
    expect(inputs[0]!.geometry).toBeUndefined()
    const compiled = compileAnnotations(inputs)
    expect(compiled.primitives.length, '无几何参数 ⇒ 不产出图元').toBe(0)
    expect(compiled.skipped[0]!.reason, '且必须**显式**报出（不静默丢）').toBe('noGeometry')
  })

  it('非注解载荷 ⇒ 跳过并**报出原因**（不静默）', () => {
    const scene = sceneWith([{ id: 'a1', shape: 'box', geometry: BOX_GEOMETRY }])
    // 追加一个相机对象（由它自己的呈现路径负责）
    const data: Record<string, ObjectData> = {
      ...scene.data,
      cam: objectData('cam', { kind: 'camera', projection: 'perspective', fov: 70, clipStart: 0.1, clipEnd: 100 }),
    }
    const objects: Record<string, SceneObject> = {
      ...scene.objects,
      cam: sceneObject({ id: 'cam', type: 'camera', dataId: 'cam' }),
    }
    const withCam: Scene = {
      ...scene,
      order: Object.freeze([...scene.order, 'cam']),
      objects: Object.freeze(objects),
      data: Object.freeze(data),
    }
    const { inputs, skipped } = kernelAnnotationInputs(withCam)
    expect(inputs.length).toBe(1)
    expect(skipped.length).toBe(1)
    expect(skipped[0]!.reason).toBe('not-annotation:camera')
  })

  it('`visible` 恒 `true`（可见性属**视口状态**，不在内核文档内容里）', () => {
    const { inputs } = kernelAnnotationInputs(sceneWith([{ id: 'a1', shape: 'box', geometry: BOX_GEOMETRY }]))
    // 内核 `ObjectDataPayload.annotation` **没有** visible 字段 —— 若这里凭空编一个
    // 按视口猜的值，就是把呈现决策混进文档声明。调用方按视口状态过滤。
    expect(inputs[0]!.visible).toBe(true)
  })

  it('五形状全部可搬运（`shape` 两边是同一联合）', () => {
    const shapes = ['box', 'point', 'line', 'text', 'face'] as const
    const scene = sceneWith(shapes.map((s, i) => ({ id: `a${i}`, shape: s, geometry: BOX_GEOMETRY })))
    const { inputs, skipped } = kernelAnnotationInputs(scene)
    expect(skipped.length).toBe(0)
    expect(inputs.map((i) => i.shape)).toEqual([...shapes])
  })

  it('顺序稳定 = 场景 `order`（注解的 z 序对重叠框可见性有影响）', () => {
    const scene = sceneWith([
      { id: 'z', shape: 'box', geometry: BOX_GEOMETRY },
      { id: 'a', shape: 'box', geometry: BOX_GEOMETRY },
      { id: 'm', shape: 'box', geometry: BOX_GEOMETRY },
    ])
    expect(kernelAnnotationInputs(scene).inputs.map((i) => i.objectId)).toEqual(['z', 'a', 'm'])
  })

  it('不修改输入场景（纯函数纪律）', () => {
    const scene = sceneWith([{ id: 'a1', shape: 'box', geometry: BOX_GEOMETRY }])
    const before = JSON.stringify(scene)
    kernelAnnotationInputs(scene)
    expect(JSON.stringify(scene), '入参不得被改写').toBe(before)
  })

  it('空场景 ⇒ 空输入 + 空跳过', () => {
    const empty = emptyScene('empty')
    const { inputs, skipped } = kernelAnnotationInputs(empty)
    expect(inputs.length).toBe(0)
    expect(skipped.length).toBe(0)
  })
})

describe('D3b · 规划产物能被既有分桶消费（覆盖层/世界层的分组是呈现问题）', () => {
  it('`overlay` 由几何参数决定，分桶按它分组', () => {
    const scene = sceneWith([
      { id: 'world', shape: 'box', geometry: { ...BOX_GEOMETRY, overlay: false } },
      { id: 'screen', shape: 'box', geometry: { ...BOX_GEOMETRY, overlay: true } },
    ])
    const compiled = compileAnnotations(kernelAnnotationInputs(scene).inputs)
    expect(compiled.primitives.length).toBe(2)
    const buckets = partitionAnnotationPrimitives(compiled.primitives)
    expect(buckets.world.length, '世界层 1 件').toBe(1)
    expect(buckets.overlay.length, '覆盖层 1 件').toBe(1)
    expect(buckets.world[0]!.objectId).toBe('world')
    expect(buckets.overlay[0]!.objectId).toBe('screen')
  })

  it('**负对照**：几何参数缺失 ⇒ 分桶里一件都没有（证明上一条不是恒真）', () => {
    const scene = sceneWith([{ id: 'a1', shape: 'box', text: '无语义几何' }])
    const compiled = compileAnnotations(kernelAnnotationInputs(scene).inputs)
    const buckets = partitionAnnotationPrimitives(compiled.primitives)
    expect(buckets.world.length + buckets.overlay.length).toBe(0)
    expect(compiled.skipped.length, '但必须报出 1 条跳过').toBe(1)
  })
})
