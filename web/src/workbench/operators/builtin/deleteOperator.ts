import type { OperatorType } from '@/workbench/operators/operatorType'
import type { V2PlainSceneDocument, V2BlockInstance } from '@/render/data/sceneDocumentV2'

export const DeleteOperator: OperatorType = {
  id: 'OPERATOR_DELETE',
  label: '删除',
  description: '删除所有选中的方块',
  flagUndo: true,

  poll(bctx) {
    return bctx.scene.scene.value !== null && bctx.selection.items.value.size > 0
  },

  exec(bctx, _props) {
    const doc = bctx.scene.scene.value as V2PlainSceneDocument | null
    if (!doc?.frames?.length) return
    const idx = bctx.selection.frameIndex.value ?? 0
    const frame = doc.frames[idx]
    if (!frame) return

    const targetKeys = new Set(
      [...bctx.selection.items.value].map(t => `${t.pos.x},${t.pos.y},${t.pos.z}`),
    )
    const keep: V2BlockInstance[] = []
    for (const b of frame.blocks) {
      const k = `${b.pos.x},${b.pos.y},${b.pos.z}`
      if (!targetKeys.has(k)) keep.push(b)
    }
    frame.blocks = keep
    bctx.scene.markDirty()
    bctx.selection.clear()
  },
}
