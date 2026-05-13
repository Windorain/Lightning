import {
  type ModalOperation,
  type ModalKeymap,
  createModalKeymap,
  eventDispatcher,
} from '@/workbench/eventDispatcher'
import type { MoveGizmo, GizmoAxis } from '@/workbench/tools/gizmos'
import type { BContext } from '@/workbench/context/bContext'

const GIZMO_DRAG_ITEMS = [
  { key: 'Escape', value: 'CANCEL' },
  { key: 'Enter', value: 'CONFIRM' },
  { key: 'Shift', value: 'PRECISION_TOGGLE' },
  { key: 'Control', value: 'SNAP_TOGGLE' },
  { key: 'z', ctrl: true, shift: false, value: 'UNDO' },
] as const

function findBlock(
  blocks: Array<{ pos: { x: number; y: number; z: number }; block_state_id: string }>,
  pos: { x: number; y: number; z: number },
) {
  return blocks.find(b => b.pos.x === pos.x && b.pos.y === pos.y && b.pos.z === pos.z)
}

export class GizmoDragModal implements ModalOperation {
  id = 'gizmo-drag'
  private gizmo: MoveGizmo
  private bctx: BContext
  private controlsRef: { enabled: boolean } | null
  private origin: { x: number; y: number; z: number }
  private gizmoPart: GizmoAxis
  private initialPositions: Array<{ x: number; y: number; z: number }>
  private keymap: ModalKeymap
  private precision = false
  private computeScreenDelta: (event: PointerEvent) => number

  constructor(
    gizmoPart: GizmoAxis,
    gizmo: MoveGizmo,
    bctx: BContext,
    controlsRef: { enabled: boolean } | null,
    computeScreenDelta: (event: PointerEvent) => number,
  ) {
    this.gizmoPart = gizmoPart
    this.gizmo = gizmo
    this.bctx = bctx
    this.controlsRef = controlsRef
    this.origin = { x: gizmo.root.position.x, y: gizmo.root.position.y, z: gizmo.root.position.z }
    this.keymap = createModalKeymap(GIZMO_DRAG_ITEMS as any)
    this.initialPositions = [...(bctx.selection.items.value)].map(i => ({ ...i.pos }))
    this.computeScreenDelta = computeScreenDelta
  }

  onEnter(_event: PointerEvent): ModalKeymap | null {
    if (this.controlsRef) this.controlsRef.enabled = false
    return this.keymap
  }

  handleEvent(event: Event): { break: boolean } {
    const evt = event as any

    if (evt.type === 'MODAL_MAP') {
      switch (evt.value) {
        case 'CANCEL':
          eventDispatcher.cancelModal()
          return { break: true }
        case 'CONFIRM':
          eventDispatcher.commitModal()
          return { break: true }
        case 'PRECISION_TOGGLE':
          this.precision = !this.precision
          return { break: true }
      }
      return { break: true }
    }

    if (!(event instanceof PointerEvent)) return { break: false }

    if (event.type === 'pointermove') {
      let delta = this.computeScreenDelta(event)
      if (this.precision) delta *= 0.1

      const newPos = this.bctx.queries.axisAdd(this.origin, this.gizmoPart as any, delta)
      this.gizmo.root.position.set(newPos.x, newPos.y, newPos.z)
      return { break: true }
    }

    if (event.type === 'pointerup') {
      const cur = this.gizmo.root.position
      const delta = this.bctx.queries.roundVec({
        x: cur.x - this.origin.x,
        y: cur.y - this.origin.y,
        z: cur.z - this.origin.z,
      })

      if (delta.x !== 0 || delta.y !== 0 || delta.z !== 0) {
        const frame = this.bctx.queries.getCurrentFrame()
        if (frame) {
          // Snapshot current positions for undo
          const oldPositions = this.initialPositions.map(initPos => {
            const block = findBlock(frame.blocks as any[], initPos)
            return block ? { x: block.pos.x, y: block.pos.y, z: block.pos.z } : null
          })
          const newPositions = this.initialPositions.map(initPos => ({
            x: initPos.x + delta.x,
            y: initPos.y + delta.y,
            z: initPos.z + delta.z,
          }))

          // Push undo command (push() internally calls execute() to apply the move)
          const label = `移动 (${delta.x}, ${delta.y}, ${delta.z})`
          this.bctx.editHistory.push({
            id: 'gizmo_' + Math.random().toString(36).slice(2, 10),
            label,
            timestamp: Date.now(),
            execute: () => {
              for (let i = 0; i < this.initialPositions.length; i++) {
                const initPos = this.initialPositions[i]
                const block = findBlock(frame.blocks as any[], initPos)
                if (block) {
                  block.pos.x = newPositions[i].x
                  block.pos.y = newPositions[i].y
                  block.pos.z = newPositions[i].z
                }
              }
              this.bctx.scene.markDirty()
            },
            undo: () => {
              for (let i = 0; i < this.initialPositions.length; i++) {
                const initPos = this.initialPositions[i]
                const block = findBlock(frame.blocks as any[], initPos)
                if (block && oldPositions[i]) {
                  block.pos.x = oldPositions[i]!.x
                  block.pos.y = oldPositions[i]!.y
                  block.pos.z = oldPositions[i]!.z
                }
              }
              this.bctx.scene.markDirty()
            },
          })
        }
      }
      eventDispatcher.commitModal()
      return { break: true }
    }

    return { break: false }
  }

  onExit(cancelled: boolean): void {
    if (cancelled) {
      this.gizmo.root.position.set(this.origin.x, this.origin.y, this.origin.z)
    }
    if (this.controlsRef) this.controlsRef.enabled = true
  }
}
