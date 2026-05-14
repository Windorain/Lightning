import { describe, it } from 'vitest'
import { createTestHarness } from '@/workbench/testing/harness'

describe('add annotation box operator', () => {
  it('drag defines annotation box from corner to corner', () => {
    const h = createTestHarness({
      blocks: [{ x: 2, y: 0, z: 2, id: 'seed' }],
    })

    h.activateTool('add-annotation-box')
    h.assertOperatorActive('OPERATOR_ADD_ANNOTATION_BOX')

    const start = h.ctx.queries.projectBlock({ x: 0, y: 0, z: 0 })!
    const end = h.ctx.queries.projectBlock({ x: 3, y: 0, z: 3 })!
    h.drag(start.x, start.y, end.x, end.y)

    h.assertAnnotationBoxCount(1)

    const boxes = h.ctx.queries.getAnnotationBoxes()
    h.assert(boxes.length === 1, 'should have one annotation box')
    h.assert(
      boxes[0].min.x !== Math.floor(boxes[0].min.x) || boxes[0].min.y !== Math.floor(boxes[0].min.y),
      'annotation box position should be floating-point, not integer'
    )
  })

  it('created annotation box has default attribute values', () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'seed' }],
    })

    h.activateTool('add-annotation-box')
    const p = h.ctx.queries.projectBlock({ x: 0, y: 0, z: 0 })!
    const p2 = h.ctx.queries.projectBlock({ x: 2, y: 0, z: 2 })!
    h.drag(p.x, p.y, p2.x, p2.y)

    const box = h.ctx.queries.getAnnotationBoxes()[0]
    h.assert(box.hover_event === 'none', 'default hover_event should be "none"')
    h.assert(box.render_style === 'wireframe', 'default render_style should be "wireframe"')
    h.assert(typeof box.render_opacity === 'number', 'render_opacity should be a number')
    h.assert(box.color.length > 0, 'color should have a default value')
  })

  it('annotation boxes persist in document, not frame', () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'seed' }],
    })

    h.activateTool('add-annotation-box')
    const p = h.ctx.queries.projectBlock({ x: 0, y: 0, z: 0 })!
    const p2 = h.ctx.queries.projectBlock({ x: 3, y: 2, z: 1 })!
    h.drag(p.x, p.y, p2.x, p2.y)

    const doc = h.ctx.queries.getDocument()
    h.assert(doc?.annotations?.length === 1, 'annotation box should be in document.annotations')
  })

  it('after creating annotation box, tool stays active', () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'seed' }],
    })

    h.activateTool('add-annotation-box')
    const p = h.ctx.queries.projectBlock({ x: 0, y: 0, z: 0 })!
    const p2 = h.ctx.queries.projectBlock({ x: 2, y: 0, z: 2 })!
    h.drag(p.x, p.y, p2.x, p2.y)

    h.assertOperatorActive('OPERATOR_ADD_ANNOTATION_BOX')
  })
})
