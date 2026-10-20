/**
 * **D3b（#289 P10d）· 规划器缺省值必须与 legacy 逐位一致**。
 *
 * ## 本文件为什么存在
 *
 * 本批侦察抓出规划器与 legacy `AnnotationMeshProvider` 的**四处默认值分歧**。
 * 按 Lead 裁决「以 legacy 为准」修正后，本文件把**每一个缺省值**钉住。
 *
 * ## 旧判据为何漏掉它们（这才是分歧存活的机制）
 *
 * `annotationOutlinePlan.test.ts` 只断言了**显式传入**的值
 * （例如 `frameThickness: 0.05` ⇒ 期望 `0.05`），**从未**断言"不传时是什么"。
 * ⇒ 默认值改动**没有任何判据把守**，两个数因此可以长期并存。
 *
 * 这与 D3a 的 `structureGeometryAttributes` 同族：**声称一致 ≠ 判据把守**。
 *
 * ## 判据的形状
 *
 * 每条都断言"缺省 = legacy 的那个字面量"，并把 legacy 的**出处**写进断言消息
 * （改值时能立刻看到它从哪来、为什么要独立裁决）。
 */

import { describe, expect, it } from 'vitest'
import {
  compileAnnotations,
  DEFAULT_BOX_FRAME_THICKNESS,
  DEFAULT_BOX_WIREFRAME_THICKNESS,
  DEFAULT_TEXT_BACKGROUND_ALPHA,
  type AnnotationInput,
} from '@/presentation/annotationPlan'

function box(geometry: Record<string, unknown> = {}): AnnotationInput {
  return {
    objectId: 'b1',
    shape: 'box',
    text: '',
    visible: true,
    geometry: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 },
      ...geometry,
    } as never,
  }
}

function text(fontSize?: number, backgroundAlpha?: number): AnnotationInput {
  return {
    objectId: 't1',
    shape: 'text',
    text: '标题',
    visible: true,
    geometry: {
      pos: { x: 0, y: 0, z: 0 },
      ...(fontSize === undefined ? {} : { fontSize }),
      ...(backgroundAlpha === undefined ? {} : { backgroundAlpha }),
    } as never,
  }
}

describe('D3b · 缺省值 = legacy 实测值（逐位一致）', () => {
  it('`frameThickness` 缺省 = **0.04**（legacy `annotationMeshProvider:125` 的 `?? 0.04`）', () => {
    // ⚠️ 改这个值需要**独立裁决** —— 它不是架构迁移的一部分。
    expect(DEFAULT_BOX_FRAME_THICKNESS, 'legacy 实测 0.04；第一版误写 0.03').toBe(0.04)
    const compiled = compileAnnotations([box()])
    const p = compiled.primitives[0]!
    expect(p.kind).toBe('box')
    if (p.kind !== 'box') throw new Error('unreachable')
    expect(p.frameThickness, '不传时必须落到 legacy 的值').toBe(0.04)
  })

  it('`wireframeThickness` 缺省 = **0.02**（legacy `:102`/`:113` 的硬编码）', () => {
    const compiled = compileAnnotations([box({ renderStyle: 'wireframe' })])
    const p = compiled.primitives[0]!
    if (p.kind !== 'box') throw new Error('unreachable')
    expect(
      p.wireframeThickness,
      'legacy 硬编码 0.02；本字段是为**表达**它而补的，不是新政策',
    ).toBe(0.02)
    expect(DEFAULT_BOX_WIREFRAME_THICKNESS).toBe(0.02)
  })

  it('`backgroundAlpha` 缺省 = **0xCC/255**（legacy `:231` 的 `?? 0xCC`）', () => {
    // ⚠️ 改这个值需要**独立裁决**。
    expect(DEFAULT_TEXT_BACKGROUND_ALPHA, 'legacy 实测 0xCC/255；第一版误写 0.6').toBe(0xcc / 255)
    const compiled = compileAnnotations([text()])
    const p = compiled.primitives[0]!
    if (p.kind !== 'text') throw new Error('unreachable')
    expect(p.backgroundAlpha, '不传时必须落到 legacy 的值').toBeCloseTo(0.8, 5)
  })

  it('**显式值仍然优先**（缺省改动不得覆盖调用方给的数）', () => {
    const compiled = compileAnnotations([box({ frameThickness: 0.05 }), text(18, 0.25)])
    const b = compiled.primitives[0]!
    const t = compiled.primitives[1]!
    if (b.kind !== 'box' || t.kind !== 'text') throw new Error('unreachable')
    expect(b.frameThickness, '显式 0.05 必须原样保留').toBe(0.05)
    expect(t.backgroundAlpha, '显式 0.25 必须原样保留').toBe(0.25)
    expect(t.fontSize).toBe(18)
  })

  it('**负对照**：`wireframeThickness` 与 `frameThickness` 是**两个**数（不得合并成一个）', () => {
    // legacy 里它们确实是两个数（0.02 vs 0.04）。若有人"统一"成一个，
    // wireframe 的杆厚会变粗一倍 —— 那是可见的像素变化。
    expect(
      DEFAULT_BOX_WIREFRAME_THICKNESS,
      'legacy：wireframe 0.02 ≠ boxFrame 0.04；合并它们会改变像素',
    ).not.toBe(DEFAULT_BOX_FRAME_THICKNESS)
  })
})
