import * as THREE from 'three'
import {
  type ModalOperation,
  type ModalKeymap,
  createModalKeymap,
  eventDispatcher,
} from '@/workbench/eventDispatcher'
import type { MoveGizmo, GizmoAxis } from '@/workbench/tools/gizmos'
import type { ThreeToolContext } from '@/workbench/tools/_base'

const GIZMO_DRAG_ITEMS = [
  { key: 'Escape', value: 'CANCEL' },
  { key: 'Enter', value: 'CONFIRM' },
  { key: 'Shift', value: 'PRECISION_TOGGLE' },
  { key: 'Control', value: 'SNAP_TOGGLE' },
  { key: 'z', ctrl: true, shift: false, value: 'UNDO' },
] as const

export class GizmoDragModal implements ModalOperation {
  id = 'gizmo-drag'
  private gizmo: MoveGizmo
  private toolCtx: ThreeToolContext
  private controlsRef: { enabled: boolean } | null
  private origin: THREE.Vector3
  private gizmoPart: GizmoAxis
  private initialPositions: Array<{ x: number; y: number; z: number }>
  private keymap: ModalKeymap
  private precision = false
  private computeScreenDelta: (event: PointerEvent) => number

  constructor(
    gizmoPart: GizmoAxis,
    gizmo: MoveGizmo,
    toolCtx: ThreeToolContext,
    controlsRef: { enabled: boolean } | null,
    computeScreenDelta: (event: PointerEvent) => number,
  ) {
    this.gizmoPart = gizmoPart
    this.gizmo = gizmo
    this.toolCtx = toolCtx
    this.controlsRef = controlsRef
    this.origin = gizmo.root.position.clone()
    this.keymap = createModalKeymap(GIZMO_DRAG_ITEMS as any)
    this.initialPositions = [...(toolCtx.selection.items.value)].map(i => ({ ...i.pos }))
    this.computeScreenDelta = computeScreenDelta
  }

  onEnter(_event: PointerEvent): ModalKeymap | null {
    if (this.controlsRef) this.controlsRef.enabled = false
    return this.keymap
  }

  handleEvent(event: Event): { break: boolean } {
    const evt = event as any

    // Modal keymap events (synthetic MODAL_MAP type)
    if (evt.type === 'MODAL_MAP') {
      switch (evt.value) {
        case 'CANCEL':
          eventDispatcher.cancelModal() // internally calls onExit(true)
          return { break: true }
        case 'CONFIRM':
          eventDispatcher.commitModal() // internally calls onExit(false)
          return { break: true }
        case 'PRECISION_TOGGLE':
          this.precision = !this.precision
          return { break: true }
      }
      return { break: true }
    }

    if (!(event instanceof PointerEvent)) return { break: false }

    // Pointer move: update gizmo position along constrained axis
    if (event.type === 'pointermove') {
      let delta = this.computeScreenDelta(event)
      if (this.precision) delta *= 0.1

      const dirs: Record<string, THREE.Vector3> = {
        x: new THREE.Vector3(1, 0, 0),
        y: new THREE.Vector3(0, 1, 0),
        z: new THREE.Vector3(0, 0, 1),
      }
      const dir = dirs[this.gizmoPart] ?? new THREE.Vector3()
      this.gizmo.root.position.copy(this.origin.clone().addScaledVector(dir, delta))
      return { break: true }
    }

    // Pointer up: commit the move
    if (event.type === 'pointerup') {
      const finalDelta = this.gizmo.root.position.clone().sub(this.origin)
      const dx = Math.round(finalDelta.x)
      const dy = Math.round(finalDelta.y)
      const dz = Math.round(finalDelta.z)
      if (dx !== 0 || dy !== 0 || dz !== 0) {
        this.toolCtx.executeMove(this.initialPositions, { x: dx, y: dy, z: dz })
      }
      eventDispatcher.commitModal() // internally calls onExit(false)
      return { break: true }
    }

    return { break: false }
  }

  onExit(cancelled: boolean): void {
    if (cancelled) {
      this.gizmo.root.position.copy(this.origin)
    }
    if (this.controlsRef) this.controlsRef.enabled = true
  }
}
