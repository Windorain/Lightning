import { describe, it } from 'vitest'
import { createTestHarness } from '@/workbench/testing/harness'

describe('add tool integration', () => {
  it('Shift+A → context menu → select Block → click face → block placed', () => {
    const h = createTestHarness({
      blocks: [{ x: 1, y: 0, z: 1, id: 'stone' }],
    })
    h.setBrush('oak')

    h.keyDown('a', { shift: true })
    h.assertContextMenuOpen()

    h.clickContextMenuItem('方块')
    h.assertContextMenuClosed()
    h.assertOperatorActive('OPERATOR_ADD_BLOCK')

    h.clickBlock({ x: 1, y: 0, z: 1 })
    h.assertBlockCount(2)
  })

  it('Shift+A → context menu → select Annotation Box → drag → box created', () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'seed' }],
    })

    h.keyDown('a', { shift: true })
    h.clickContextMenuItem('注解框')
    h.assertOperatorActive('OPERATOR_ADD_ANNOTATION_BOX')

    const p1 = h.ctx.queries.projectBlock({ x: 0, y: 0, z: 0 })!
    const p2 = h.ctx.queries.projectBlock({ x: 3, y: 0, z: 3 })!
    h.drag(p1.x, p1.y, p2.x, p2.y)

    h.assertAnnotationBoxCount(1)
  })
})
