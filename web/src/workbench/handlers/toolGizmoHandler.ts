import * as THREE from 'three'
import type { TypedEventHandler } from '@/workbench/events/eventTypes'
import { HANDLER_TYPE } from '@/workbench/events/eventTypes'
import type { MoveGizmo, GizmoAxis } from '@/workbench/tools/gizmos'
import type { BContext } from '@/workbench/context/bContext'
import { GizmoDragModal } from '@/workbench/modalOperations/GizmoDragModal'

/**
 * Gizmo handler (HANDLER_TYPE.GIZMO).
 * pointermove: hover highlight (never consumes event)
 * pointerdown: hit test → enter GizmoDragModal
 */
export function createToolGizmoHandler(
  getActiveToolId: () => string,
  getGizmo: () => MoveGizmo | null,
  getBctx: () => BContext | null,
  getCamera: () => THREE.Camera | null,
  getControlsRef: () => { enabled: boolean } | null,
): TypedEventHandler {
  return {
    type: HANDLER_TYPE.GIZMO,
    handle(event: Event): { break: boolean } {
      const gizmo = getGizmo()
      const camera = getCamera()
      const toolId = getActiveToolId()
      if (!gizmo || !camera) return { break: false }

      const pe = event as PointerEvent
      const target = event.target as HTMLElement
      const rect = target.getBoundingClientRect?.()
      if (!rect) return { break: false }

      const x = ((pe.clientX - rect.left) / rect.width) * 2 - 1
      const y = -((pe.clientY - rect.top) / rect.height) * 2 + 1
      const raycaster = new THREE.Raycaster()
      raycaster.setFromCamera(new THREE.Vector2(x, y), camera)

      if (event.type === 'pointermove') {
        if (toolId === 'OPERATOR_MOVE') {
          const hit = gizmo.hitTest(raycaster)
          gizmo.setHighlight(hit)
        }
        return { break: false }
      }

      if (event.type !== 'pointerdown') return { break: false }
      if (toolId !== 'OPERATOR_MOVE') return { break: false }

      const hit = gizmo.hitTest(raycaster)
      if (!hit || hit.length !== 1) return { break: false }

      const bctx = getBctx()
      const controlsRef = getControlsRef()
      if (!bctx) return { break: false }

      const startX = pe.clientX
      const startY = pe.clientY
      const computeDelta = (_moveEvent: PointerEvent): number => {
        const dx = _moveEvent.clientX - startX
        const dy = _moveEvent.clientY - startY
        const bctxNow = getBctx()
        const k = bctxNow?.settings.dragSensitivity ?? 0.05
        if (hit === 'x') return dx * k
        if (hit === 'y') return -dy * k
        return -dx * k  // 'z'
      }

      const modal = new GizmoDragModal(
        hit as GizmoAxis,
        gizmo,
        bctx,
        controlsRef,
        computeDelta,
      )
      bctx.eventDispatcher.pushModal(modal, pe)

      return { break: true }
    },
  }
}
