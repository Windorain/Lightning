/**
 * MoveGizmoOperator — 对标 Blender 的 TRANSFORM_OT_translate（gizmo 路径）。
 *
 * 当用户拖拽 MoveGizmo 的箭头时，进入此操作符的模态。
 * invoke 由 toolGizmoHandler 在 pointerdown 触发。
 */
import type { OperatorType, OperatorProperties } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'
import * as THREE from 'three'
import type { MoveGizmo, GizmoAxis } from '@/workbench/tools/gizmos'

interface GizmoDragState {
  _gizmo: MoveGizmo
  _gizmoPart: GizmoAxis
  _origin: THREE.Vector3
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
      _origin: gizmo.root.position.clone(),
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
      const k = 0.05
      const part = s._gizmoPart
      let delta = (part === 'x' || part === 'z') ? -dx * k : dy * k
      if (s._precision) delta *= 0.1

      const dirs: Record<string, THREE.Vector3> = {
        x: new (THREE as any).Vector3(1, 0, 0),
        y: new (THREE as any).Vector3(0, 1, 0),
        z: new (THREE as any).Vector3(0, 0, 1),
      }
      const dir = dirs[s._gizmoPart] ?? new (THREE as any).Vector3()
      s._gizmo.root.position.copy(s._origin.clone().addScaledVector(dir, delta))
      return OP_RESULT.RUNNING_MODAL
    }

    if (event.type === 'pointerup') {
      const finalDelta = s._gizmo.root.position.clone().sub(s._origin)
      const dx = Math.round(finalDelta.x)
      const dy = Math.round(finalDelta.y)
      const dz = Math.round(finalDelta.z)

      if (dx !== 0 || dy !== 0 || dz !== 0) {
        const doc = bctx.scene.scene.value
        if (doc && 'frames' in (doc as any)) {
          const frames = (doc as any).frames
          if (frames?.length) {
            const idx = bctx.selection.frameIndex.value ?? 0
            const frame = frames[idx]
            if (frame) {
              for (const initPos of s._initialPositions) {
                const block = findBlock(frame.blocks, initPos)
                if (block) {
                  block.pos.x = initPos.x + dx
                  block.pos.y = initPos.y + dy
                  block.pos.z = initPos.z + dz
                }
              }
              bctx.scene.markDirty()
            }
          }
        }
      } else {
        // No movement — restore gizmo position
        s._gizmo.root.position.copy(s._origin)
      }

      if (s._controlsRef) s._controlsRef.enabled = true
      return OP_RESULT.FINISHED
    }

    return OP_RESULT.PASS_THROUGH
  },

  cancel(_bctx, props) {
    const s = props as unknown as GizmoDragState
    s._gizmo.root.position.copy(s._origin)
    if (s._controlsRef) s._controlsRef.enabled = true
  },
}
