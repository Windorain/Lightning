import {
  type ModalOperation,
  type ModalKeymap,
  createModalKeymap,
  eventDispatcher,
} from '@/workbench/eventDispatcher'
import type { MoveGizmo, GizmoAxis } from '@/workbench/tools/gizmos'
import type { BContext } from '@/workbench/context/bContext'
import { logCenter } from '@/workbench/logging/LogCenter'
import type { SessionHandle } from '@/workbench/logging/LogCenter'

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
  private bctx: BContext
  private controlsRef: { enabled: boolean } | null
  private origin: { x: number; y: number; z: number }
  private gizmoPart: GizmoAxis
  private initialPositions: Array<{ x: number; y: number; z: number }>
  private keymap: ModalKeymap
  private precision = false
  private session: SessionHandle | null = null
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
    this.session = logCenter.beginSession('GizmoDrag', `拖拽 ${this.gizmoPart} 开始`, {
      axis: this.gizmoPart,
      startPos: { ...this.origin },
      selectionSize: this.initialPositions.length,
    })
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
      if (this.precision) delta = Math.round(delta * 10) / 10
      this.session?.update(`拖拽 ${this.gizmoPart} ${delta.toFixed(2)}`, { delta })

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
        const q = this.bctx.queries
        const moves = this.initialPositions.map(initPos => ({
          from: { ...initPos },
          to: { x: initPos.x + delta.x, y: initPos.y + delta.y, z: initPos.z + delta.z },
        }))

        const label = `移动 (${delta.x}, ${delta.y}, ${delta.z})`
        const sel = this.bctx.selection
        this.bctx.editHistory.push({
          id: 'gizmo_' + Math.random().toString(36).slice(2, 10),
          label,
          timestamp: Date.now(),
          execute: () => {
            for (const m of moves) {
              q.moveBlockInCellGrid(m.from, m.to)
            }
            // 同步更新 selection 坐标
            const newItems = [...sel.items.value].map(item => {
              const m = moves.find(mm => mm.from.x === item.pos.x && mm.from.y === item.pos.y && mm.from.z === item.pos.z)
              return m ? { ...item, pos: { ...m.to } } : item
            })
            sel.items.value = new Set(newItems)
            this.bctx.scene.markDirty()
            this.bctx.scene.syncPreview()
          },
          undo: () => {
            for (const m of moves) {
              q.moveBlockInCellGrid(m.to, m.from)
            }
            const newItems = [...sel.items.value].map(item => {
              const m = moves.find(mm => mm.to.x === item.pos.x && mm.to.y === item.pos.y && mm.to.z === item.pos.z)
              return m ? { ...item, pos: { ...m.from } } : item
            })
            sel.items.value = new Set(newItems)
            this.bctx.scene.markDirty()
            this.bctx.scene.syncPreview()
          },
        })
      }
      this.session?.end(`拖拽 ${this.gizmoPart} 完成`, {
        delta: { x: delta.x, y: delta.y, z: delta.z },
        blocksAffected: this.initialPositions.length,
        axis: this.gizmoPart,
      })
      eventDispatcher.commitModal()
      return { break: true }
    }

    return { break: false }
  }

  onExit(cancelled: boolean): void {
    if (cancelled) {
      this.session?.end(`拖拽 ${this.gizmoPart} 取消`, { cancelled: true })
      this.gizmo.root.position.set(this.origin.x, this.origin.y, this.origin.z)
    }
    if (this.controlsRef) this.controlsRef.enabled = true
  }
}
