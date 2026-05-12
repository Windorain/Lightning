import * as THREE from 'three'
import type { EventHandler } from '@/workbench/eventDispatcher'
import { eventDispatcher } from '@/workbench/eventDispatcher'
import type { MoveGizmo, GizmoAxis } from '@/workbench/tools/gizmos'
import type { ThreeToolContext } from '@/workbench/tools/_base'
import { GizmoDragModal } from '@/workbench/modalOperations/GizmoDragModal'

/**
 * Create an event handler that intercepts pointerdown on gizmo axes.
 * Priority 15: runs after the viewport's own pointer handling but before activeToolHandler.
 */
export function createToolGizmoHandler(
  getActiveToolId: () => string,
  getGizmo: () => MoveGizmo | null,
  getToolCtx: () => ThreeToolContext | null,
  getCamera: () => THREE.Camera | null,
  getControlsRef: () => { enabled: boolean } | null,
): EventHandler {
  return {
    priority: 15,
    handle(event: Event): { break: boolean } {
      if (event.type !== 'pointerdown') return { break: false }
      if (getActiveToolId() !== 'move') return { break: false }

      const gizmo = getGizmo()
      const camera = getCamera()
      if (!gizmo || !camera) return { break: false }

      const pe = event as PointerEvent
      const raycaster = new THREE.Raycaster()
      const target = event.target as HTMLElement
      const rect = target.getBoundingClientRect?.()
      if (!rect) return { break: false }

      const x = ((pe.clientX - rect.left) / rect.width) * 2 - 1
      const y = -((pe.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(new THREE.Vector2(x, y), camera)

      const hit = gizmo.hitTest(raycaster)

      // Only single-character axes ('x', 'y', 'z') — plane handles deferred
      if (!hit || hit.length !== 1) return { break: false }

      const toolCtx = getToolCtx()
      const controlsRef = getControlsRef()
      if (!toolCtx) return { break: false }

      // Build a screen-space delta computer that translates pointer movement
      // into gizmo-axis displacement via a scale factor.
      const startX = pe.clientX
      const startY = pe.clientY
      const computeDelta = (_moveEvent: PointerEvent): number => {
        const dx = _moveEvent.clientX - startX
        const dy = _moveEvent.clientY - startY
        // Scale factor: pixels to world units (tuned empirically)
        const k = 0.05
        // For horizontal axes (x, z), map horizontal screen movement to axis direction.
        // For vertical axis (y), map vertical screen movement.
        return (hit === 'x' || hit === 'z') ? -dx * k : dy * k
      }

      const modal = new GizmoDragModal(
        hit as GizmoAxis,
        gizmo,
        toolCtx,
        controlsRef,
        computeDelta,
      )
      eventDispatcher.pushModal(modal, pe)

      return { break: true }
    },
  }
}
