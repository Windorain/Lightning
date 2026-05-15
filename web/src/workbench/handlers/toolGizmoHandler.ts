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
      const target = event.target as HTMLElement | null
      const rect = target?.getBoundingClientRect?.()
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

      // Compute axis screen direction and pixel-to-world scale from camera
      const gPos = gizmo.root.position
      const axisWorldDir = new THREE.Vector3(
        hit === 'x' ? 1 : 0,
        hit === 'y' ? 1 : 0,
        hit === 'z' ? 1 : 0,
      )
      const p1 = gPos.clone().project(camera)
      const p2 = gPos.clone().add(axisWorldDir).project(camera)

      // 1 world unit along this axis = how many screen pixels?
      const sx = ((p2.x - p1.x) / 2) * rect.width
      const sy = -((p2.y - p1.y) / 2) * rect.height
      const screenLen = Math.sqrt(sx * sx + sy * sy)

      const screenDirX = screenLen > 0.001 ? sx / screenLen : 0
      const screenDirY = screenLen > 0.001 ? sy / screenLen : 0
      // pixels-per-world-unit = screenLen, so k = 1 / screenLen
      const k = screenLen > 0.001 ? 1 / screenLen : 0

      const startX = pe.clientX
      const startY = pe.clientY

      const computeDelta = (moveEvent: PointerEvent): number => {
        const dx = moveEvent.clientX - startX
        const dy = moveEvent.clientY - startY
        const proj = dx * screenDirX + dy * screenDirY
        return proj * k
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
