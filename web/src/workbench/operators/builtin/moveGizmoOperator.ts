/**
 * MoveGizmoOperator — 对标 Blender 的 TRANSFORM_OT_translate（gizmo 路径）。
 *
 * 当用户拖拽 MoveGizmo 的箭头时，进入此操作符的模态。
 * invoke 由 toolGizmoHandler 在 pointerdown 触发。
 */
import type { OperatorType, OperatorProperties } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'
import type { MoveGizmo, GizmoAxis } from '@/workbench/tools/gizmos'

interface GizmoDragState {
  _gizmo: MoveGizmo
  _gizmoPart: GizmoAxis
  _origin: { x: number; y: number; z: number }
  _initialPositions: Array<{ x: number; y: number; z: number }>
  _startX: number
  _startY: number
  _precision: boolean
  _controlsRef: { enabled: boolean } | null
}

function findBlock(
  blocks: Array<{ pos: { x: number; y: number; z: number }; block_state_id: string }>,
  pos: { x: number; y: number; z: number },
) {
  return blocks.find(b => b.pos.x === pos.x && b.pos.y === pos.y && b.pos.z === pos.z)
}

export const MoveGizmoOperator: OperatorType = {
  id: 'OPERATOR_MOVE_GIZMO',
  label: 'Gizmo 移动',
  flagUndo: true,

  poll(bctx) {
    return bctx.scene.scene.value !== null && bctx.selection.items.value.size > 0 && bctx.controlsRef !== null
  },

  /**
   * 由 toolGizmoHandler 调用。参数通过 props 传入：
   *  gizmoPart, gizmo, computeScreenDelta
   */
  invoke(bctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED

    const gizmo = props._gizmo as MoveGizmo
    const gizmoPart = props._gizmoPart as GizmoAxis
    const controlsRef = bctx.controlsRef
    if (!gizmo || !gizmoPart || !controlsRef) return OP_RESULT.CANCELLED

    const state: GizmoDragState = {
      _gizmo: gizmo,
      _gizmoPart: gizmoPart,
      _origin: { x: gizmo.root.position.x, y: gizmo.root.position.y, z: gizmo.root.position.z },
      _initialPositions: [...bctx.selection.items.value].map(i => ({ ...i.pos })),
      _startX: event.clientX,
      _startY: event.clientY,
      _precision: false,
      _controlsRef: controlsRef,
    }

    // Disable orbit controls during drag
    controlsRef.enabled = false

    // Copy state into props
    Object.assign(props, state)
    return OP_RESULT.RUNNING_MODAL
  },

  modal(bctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.PASS_THROUGH
    const s = props as unknown as GizmoDragState & OperatorProperties

    if (event.type === 'pointermove') {
      const dx = event.clientX - s._startX
      const dy = event.clientY - s._startY
      const k = bctx.settings.dragSensitivity
      const part = s._gizmoPart
      let delta = (part === 'x' || part === 'z') ? -dx * k : dy * k
      if (s._precision) delta *= 0.1

      const newPos = bctx.queries.axisAdd(s._origin, s._gizmoPart as 'x' | 'y' | 'z', delta)
      s._gizmo.root.position.set(newPos.x, newPos.y, newPos.z)
      return OP_RESULT.RUNNING_MODAL
    }

    if (event.type === 'pointerup') {
      const cur = s._gizmo.root.position
      const delta = bctx.queries.roundVec({
        x: cur.x - s._origin.x,
        y: cur.y - s._origin.y,
        z: cur.z - s._origin.z,
      })

      if (delta.x !== 0 || delta.y !== 0 || delta.z !== 0) {
        const frame = bctx.queries.getCurrentFrame()
        if (frame) {
          for (const initPos of s._initialPositions) {
            const block = findBlock(frame.blocks as any[], initPos)
            if (block) {
              block.pos.x = initPos.x + delta.x
              block.pos.y = initPos.y + delta.y
              block.pos.z = initPos.z + delta.z
            }
          }
          bctx.scene.markDirty()
        }
      } else {
        // No movement — restore gizmo position
        s._gizmo.root.position.set(s._origin.x, s._origin.y, s._origin.z)
      }

      if (s._controlsRef) s._controlsRef.enabled = true
      return OP_RESULT.FINISHED
    }

    return OP_RESULT.PASS_THROUGH
  },

  cancel(_bctx, props) {
    const s = props as unknown as GizmoDragState
    s._gizmo.root.position.set(s._origin.x, s._origin.y, s._origin.z)
    if (s._controlsRef) s._controlsRef.enabled = true
  },
}
