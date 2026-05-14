import type { OperatorType } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'
import type { V2AnnotationBox } from '@/render/data/sceneDocumentV2'

interface AnnotState {
  _annotStart?: { x: number; y: number; z: number } | null
  _annotEnd?: { x: number; y: number; z: number } | null
  _annotating?: boolean
  _annotPreview?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null
}

export const AnnotationOperator: OperatorType = {
  id: 'OPERATOR_ANNOTATION',
  label: '注解',
  description: '拖拽创建注解框',
  flagUndo: true,

  poll(bctx) {
    return bctx.scene.scene.value !== null
  },

  invoke(bctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED
    const picked = bctx.queries.pickVoxel(event)
    if (!picked) return OP_RESULT.CANCELLED

    const state = props as AnnotState
    state._annotStart = { ...picked.pos }
    state._annotating = true
    return OP_RESULT.RUNNING_MODAL
  },

  modal(bctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.PASS_THROUGH
    const state = props as AnnotState

    if (event.type === 'pointermove' && state._annotating) {
      const picked = bctx.queries.pickVoxel(event)
      if (picked) {
        state._annotEnd = { ...picked.pos }
        const s = state._annotStart!
        const e = picked.pos
        state._annotPreview = {
          min: { x: Math.min(s.x, e.x), y: Math.min(s.y, e.y), z: Math.min(s.z, e.z) },
          max: { x: Math.max(s.x, e.x), y: Math.max(s.y, e.y), z: Math.max(s.z, e.z) },
        }
      }
      return OP_RESULT.RUNNING_MODAL
    }

    if (event.type === 'pointerup' && state._annotating) {
      state._annotating = false
      if (!state._annotStart || !state._annotPreview) {
        state._annotStart = null
        state._annotEnd = null
        state._annotPreview = null
        return OP_RESULT.FINISHED
      }

      const doc = bctx.queries.getDocument()
      if (!doc) {
        state._annotStart = null
        state._annotEnd = null
        state._annotPreview = null
        return OP_RESULT.FINISHED
      }

      const annotation: V2AnnotationBox = {
        id: 'anno_' + Math.random().toString(36).slice(2, 8),
        title: '',
        description: '',
        min: state._annotPreview.min,
        max: state._annotPreview.max,
        color: '#4488ff',
        visible: true,
        created_at: Date.now(),
        updated_at: Date.now(),
        hover_event: 'none',
        hover_payload: '',
        render_style: 'wireframe',
        render_opacity: 0.5,
        linked_block_ref: '',
      }

      if (!doc.annotations) doc.annotations = []
      doc.annotations.push(annotation)
      bctx.scene.markDirty()

      state._annotStart = null
      state._annotEnd = null
      state._annotPreview = null
      return OP_RESULT.FINISHED
    }

    return OP_RESULT.PASS_THROUGH
  },
}
