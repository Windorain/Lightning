import type { OperatorType } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'
import type { V2AnnotationBox, V2FloatPos } from '@/render/data/sceneDocumentV2'

interface AnnotModalState {
  _mode: 'drag' | 'attach'
  _startPos?: V2FloatPos | null
  _currentPos?: V2FloatPos | null
  _preview?: { min: V2FloatPos; max: V2FloatPos } | null
}

export const AddAnnotationBoxOperator: OperatorType = {
  id: 'OPERATOR_ADD_ANNOTATION_BOX',
  label: '添加注解框',
  description: '拖拽创建注解框',
  flagUndo: true,

  poll(bctx) {
    return bctx.scene.scene.value !== null
  },

  invoke(bctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED

    const state = props as AnnotModalState
    const worldPoint = bctx.queries.pickWorldPoint(event)
    if (!worldPoint) return OP_RESULT.CANCELLED

    state._mode = 'drag'
    state._startPos = { x: worldPoint.x, y: worldPoint.y, z: worldPoint.z }
    state._currentPos = { ...state._startPos }
    state._preview = null

    return OP_RESULT.RUNNING_MODAL
  },

  modal(bctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.PASS_THROUGH
    const state = props as AnnotModalState

    if (event.type === 'pointermove' && state._mode === 'drag') {
      const worldPoint = bctx.queries.pickWorldPoint(event)
      if (worldPoint && state._startPos) {
        state._currentPos = { x: worldPoint.x, y: worldPoint.y, z: worldPoint.z }
        const s = state._startPos
        const e = state._currentPos
        state._preview = {
          min: { x: Math.min(s.x, e.x), y: Math.min(s.y, e.y), z: Math.min(s.z, e.z) },
          max: { x: Math.max(s.x, e.x), y: Math.max(s.y, e.y), z: Math.max(s.z, e.z) },
        }
      }
      return OP_RESULT.RUNNING_MODAL
    }

    if (event.type === 'pointerup') {
      if (!state._startPos || !state._preview) return OP_RESULT.FINISHED

      const doc = bctx.queries.getDocument()
      if (!doc) return OP_RESULT.FINISHED

      const annotation: V2AnnotationBox = {
        id: 'anno_' + Math.random().toString(36).slice(2, 8),
        title: '',
        description: '',
        min: state._preview.min,
        max: state._preview.max,
        color: '#4488ff',
        visible: true,
        created_at: Date.now(),
        updated_at: Date.now(),
        hover_event: 'none',
        hover_payload: '',
        render_style: 'wireframe',
        render_opacity: 1.0,
        linked_block_ref: '',
      }

      if (!doc.annotations) doc.annotations = []
      doc.annotations.push(annotation)
      bctx.scene.markDirty()

      return OP_RESULT.FINISHED
    }

    return OP_RESULT.PASS_THROUGH
  },
}
