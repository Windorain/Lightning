import type { OperatorType } from '@/workbench/operators/operatorType'

export const DeleteOperator: OperatorType = {
  id: 'OPERATOR_DELETE',
  label: '删除',
  description: '删除所有选中的方块',
  flagUndo: true,

  poll(bctx) {
    return bctx.scene.scene.value !== null && bctx.selection.items.value.size > 0
  },

  exec(bctx, _props) {
    const frame = bctx.queries.getCurrentFrame()
    if (!frame) return

    const targetKeys = new Set(
      [...bctx.selection.items.value].map(t => `${t.pos.x},${t.pos.y},${t.pos.z}`),
    )
    const keep: Array<{ pos: { x: number; y: number; z: number }; block_state_id: string }> = []
    for (const b of (frame as any).blocks) {
      const k = `${b.pos.x},${b.pos.y},${b.pos.z}`
      if (!targetKeys.has(k)) keep.push(b)
    }
    ;(frame as any).blocks = keep
    bctx.scene.markDirty()
    bctx.selection.clear()
  },
}
