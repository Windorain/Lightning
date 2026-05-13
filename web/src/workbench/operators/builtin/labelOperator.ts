import type { OperatorType } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'
import type { V2Label } from '@/render/data/sceneDocumentV2'

export const LabelOperator: OperatorType = {
  id: 'OPERATOR_LABEL',
  label: '标签',
  description: '在点击位置放置标签',
  flagUndo: true,

  poll(bctx) {
    return bctx.scene.scene.value !== null
  },

  invoke(bctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED
    const picked = bctx.queries.pickVoxel(event)
    if (!picked) return OP_RESULT.CANCELLED

    const doc = bctx.queries.getDocument()
    if (!doc) return OP_RESULT.CANCELLED

    if (!doc.labels) doc.labels = []
    const label: V2Label = {
      id: 'lbl_' + Math.random().toString(36).slice(2, 8),
      text: (props.text as string) ?? '',
      x: picked.pos.x,
      y: picked.pos.y,
      z: picked.pos.z,
      color: (props.color as string) ?? '#ffffff',
      font_size: (props.font_size as number) ?? 16,
      visible: true,
    }
    doc.labels.push(label)
    bctx.scene.markDirty()
    return OP_RESULT.FINISHED
  },
}
