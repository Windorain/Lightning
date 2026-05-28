import * as THREE from 'three'
import type { BContext } from '@/workbench/context/bContext'
import type { OperatorType, OperatorProperties } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'

const WORLD_AXES: Record<string, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
}

interface ScreenProjection {
  screenDirX: number
  screenDirY: number
  k: number
}

/** Project a world-space direction vector to screen-space at the given origin point. */
function projectAxis(
  bctx: BContext,
  origin: { x: number; y: number; z: number },
  dir: THREE.Vector3,
): ScreenProjection {
  const camera = bctx.viewport.camera.value
  const domEl = bctx.viewport.domElement.value
  if (!camera || !domEl) return { screenDirX: 0, screenDirY: 0, k: 0 }
  const rect = domEl.getBoundingClientRect()
  const p1 = new THREE.Vector3(origin.x, origin.y, origin.z).project(camera)
  const p2 = new THREE.Vector3(origin.x + dir.x, origin.y + dir.y, origin.z + dir.z).project(camera)
  const sx = ((p2.x - p1.x) / 2) * rect.width
  const sy = -((p2.y - p1.y) / 2) * rect.height
  const screenLen = Math.sqrt(sx * sx + sy * sy)
  if (screenLen < 0.001) return { screenDirX: 0, screenDirY: 0, k: 0 }
  return { screenDirX: sx / screenLen, screenDirY: sy / screenLen, k: 1 / screenLen }
}

/** Build the list of (worldDir, screenProjection) pairs for the current drag mode. */
function buildProjectionAxes(
  bctx: BContext,
  s: MoveModalState,
): Array<{ dir: THREE.Vector3; proj: ScreenProjection }> {
  const origin = { x: s._originX, y: s._originY, z: s._originZ }

  // Axis lock overrides everything
  if (s._axisLock) {
    const dir = WORLD_AXES[s._axisLock]
    return [{ dir, proj: projectAxis(bctx, origin, dir) }]
  }

  // Gizmo single axis
  if (s._gizmoAxis && s._gizmoAxis.length === 1) {
    const dir = WORLD_AXES[s._gizmoAxis]
    return [{ dir, proj: { screenDirX: s._screenDirX, screenDirY: s._screenDirY, k: s._k } }]
  }

  // Gizmo plane (xy, xz, yz)
  if (s._gizmoAxis && s._gizmoAxis.length === 2) {
    return [
      { dir: WORLD_AXES[s._gizmoAxis[0]], proj: { screenDirX: s._screenDirX1, screenDirY: s._screenDirY1, k: s._k1 } },
      { dir: WORLD_AXES[s._gizmoAxis[1]], proj: { screenDirX: s._screenDirX2, screenDirY: s._screenDirY2, k: s._k2 } },
    ]
  }

  // Free move: camera right and up
  const camera = bctx.viewport.camera.value
  if (!camera) return []
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
  return [
    { dir: right, proj: projectAxis(bctx, origin, right) },
    { dir: up, proj: projectAxis(bctx, origin, up) },
  ]
}

/** Animation-safe way to get gizmo. Prefers props ref, falls back to registry. */
function getGizmo(bctx: BContext, props: OperatorProperties): { root: THREE.Group } | null {
  return ((props as any).gizmo as { root: THREE.Group } | null)
    ?? (bctx.toolRegistry.activeGizmo.value as { root: THREE.Group } | null)
}

interface MoveModalState {
  _gizmoAxis: string | null
  _axisLock: string | null
  _freeMove: boolean
  _originX: number; _originY: number; _originZ: number
  _startX: number; _startY: number
  _initialPositions: Array<{ x: number; y: number; z: number }>
  _precision: boolean
  _hasMoved: boolean
  _pointerId: number
  // Single-axis params (existing)
  _screenDirX: number; _screenDirY: number; _k: number
  // Second axis params (plane drag)
  _screenDirX1: number; _screenDirY1: number; _k1: number
  _screenDirX2: number; _screenDirY2: number; _k2: number
}

function toState(props: OperatorProperties): MoveModalState {
  return props as unknown as MoveModalState
}

export const MoveOperator: OperatorType = {
  id: 'OPERATOR_MOVE',
  label: '移动',
  description: '拖拽 Gizmo 或空白区域移动选中方块，X/Y/Z 锁定轴向',

  poll(bctx) {
    return bctx.doc.value !== null
  },

  initModalState(): OperatorProperties {
    return {
      _gizmoAxis: null,
      _axisLock: null,
      _freeMove: false,
      _originX: 0, _originY: 0, _originZ: 0,
      _startX: 0, _startY: 0,
      _initialPositions: [],
      _precision: false,
      _hasMoved: false,
      _pointerId: -1,
      _screenDirX: 0, _screenDirY: 0, _k: 0,
      _screenDirX1: 0, _screenDirY1: 0, _k1: 0,
      _screenDirX2: 0, _screenDirY2: 0, _k2: 0,
    }
  },

  invoke(bctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED

    // ---- Gizmo drag (single axis or plane) ----
    if (props.gizmoAxis) {
      const gizmo = getGizmo(bctx, props)
      if (!gizmo) return OP_RESULT.CANCELLED

      const target = event.target as HTMLElement | null
      target?.setPointerCapture(event.pointerId)

      Object.assign(props, {
        _gizmoAxis: props.gizmoAxis as string,
        _axisLock: null,
        _freeMove: false,
        _originX: gizmo.root.position.x,
        _originY: gizmo.root.position.y,
        _originZ: gizmo.root.position.z,
        _startX: event.clientX,
        _startY: event.clientY,
        _initialPositions: [...bctx.selection.items.value]
          .filter(e => e.kind === 'block')
          .map(e => ({ ...e.ref.pos })),
        _precision: false,
        _hasMoved: false,
        _pointerId: event.pointerId,
        // Single axis params
        _screenDirX: (props.screenDirX as number) ?? 0,
        _screenDirY: (props.screenDirY as number) ?? 0,
        _k: (props.k as number) ?? 0,
        // Plane params (second axis)
        _screenDirX1: (props.screenDirX1 as number) ?? 0,
        _screenDirY1: (props.screenDirY1 as number) ?? 0,
        _k1: (props.k1 as number) ?? 0,
        _screenDirX2: (props.screenDirX2 as number) ?? 0,
        _screenDirY2: (props.screenDirY2 as number) ?? 0,
        _k2: (props.k2 as number) ?? 0,
      })
      return OP_RESULT.RUNNING_MODAL
    }

    // ---- Non-gizmo: block pick → select ----
    bctx.selection.resetCycle()
    const picked = bctx.queries.pickVoxel(event)
    if (picked) {
      if (event.shiftKey) {
        bctx.selection.add([picked])
      } else if (event.ctrlKey || event.metaKey) {
        bctx.selection.remove([picked])
      } else {
        bctx.selection.select(picked)
      }
      return OP_RESULT.FINISHED
    }

    // ---- Non-gizmo: empty space → free move or deselect ----
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
      const sel = [...bctx.selection.items.value].filter(e => e.kind === 'block')
      const isMoveTool = bctx.toolRegistry.activeTool.value?.id === 'move'

      if (isMoveTool && sel.length > 0) {
        // Free move
        const gizmo = getGizmo(bctx, props)
        const target = event.target as HTMLElement | null
        target?.setPointerCapture(event.pointerId)

        Object.assign(props, {
          _gizmoAxis: null,
          _axisLock: null,
          _freeMove: true,
          _originX: gizmo?.root.position.x ?? 0,
          _originY: gizmo?.root.position.y ?? 0,
          _originZ: gizmo?.root.position.z ?? 0,
          _startX: event.clientX,
          _startY: event.clientY,
          _initialPositions: sel.map(e => ({ ...e.ref.pos })),
          _precision: false,
          _hasMoved: false,
          _pointerId: event.pointerId,
          _screenDirX: 0, _screenDirY: 0, _k: 0,
          _screenDirX1: 0, _screenDirY1: 0, _k1: 0,
          _screenDirX2: 0, _screenDirY2: 0, _k2: 0,
        })
        return OP_RESULT.RUNNING_MODAL
      }

      // Select tool or no selection: deselect-watch
      Object.assign(props, {
        _startX: event.clientX,
        _startY: event.clientY,
        _hasMoved: false,
        _pointerId: event.pointerId,
      })
      return OP_RESULT.RUNNING_MODAL
    }

    return OP_RESULT.FINISHED
  },

  modal(bctx, props, event) {
    const s = toState(props)

    // ---- Keyboard: MODAL_MAP events ----
    if ((event as any).type === 'MODAL_MAP') {
      switch ((event as any).value) {
        case 'CANCEL': return OP_RESULT.CANCELLED
        case 'CONFIRM': return OP_RESULT.FINISHED
        case 'PRECISION_TOGGLE':
          s._precision = !s._precision
          return OP_RESULT.RUNNING_MODAL
      }
      return OP_RESULT.RUNNING_MODAL
    }

    // ---- Keyboard: direct key events ----
    if (event instanceof KeyboardEvent) {
      if (event.key === 'Escape') return OP_RESULT.CANCELLED
      if (event.key === 'Enter') return OP_RESULT.FINISHED
      if (event.key === 'Shift') {
        s._precision = !s._precision
        return OP_RESULT.RUNNING_MODAL
      }
      // Axis lock
      if (event.key === 'x' || event.key === 'X' || event.key === 'y' || event.key === 'Y' || event.key === 'z' || event.key === 'Z') {
        const axis = event.key.toLowerCase()
        s._axisLock = s._axisLock === axis ? null : axis
        return OP_RESULT.RUNNING_MODAL
      }
      return OP_RESULT.RUNNING_MODAL
    }

    // ---- Free move or gizmo drag ----
    if (s._gizmoAxis || s._freeMove) {
      if (!(event instanceof PointerEvent)) return OP_RESULT.PASS_THROUGH

      const gizmo = getGizmo(bctx, props)
      if (!gizmo) return OP_RESULT.CANCELLED

      if (event.type === 'pointermove') {
        const axes = buildProjectionAxes(bctx, s)
        const dx = event.clientX - s._startX
        const dy = event.clientY - s._startY

        let totalDelta = new THREE.Vector3()
        for (const { dir, proj } of axes) {
          let d = dx * proj.screenDirX + dy * proj.screenDirY
          d *= proj.k
          if (s._precision) d = Math.round(d * 10) / 10
          totalDelta.addScaledVector(dir, d)
        }

        gizmo.root.position.set(
          s._originX + totalDelta.x,
          s._originY + totalDelta.y,
          s._originZ + totalDelta.z,
        )
        return OP_RESULT.RUNNING_MODAL
      }

      if (event.type === 'pointerup') {
        const origin = { x: s._originX, y: s._originY, z: s._originZ }
        const cur = gizmo.root.position
        const delta = bctx.queries.roundVec({
          x: cur.x - origin.x,
          y: cur.y - origin.y,
          z: cur.z - origin.z,
        })

        if (delta.x !== 0 || delta.y !== 0 || delta.z !== 0) {
          const doc = bctx.doc.value
          const rf = doc?.frame(bctx.selection.frameIndex.value ?? 0)
          const grid = rf?.grid
          if (grid) {
            const moves = s._initialPositions.map(initPos => ({
              from: { x: initPos.x, y: initPos.y, z: initPos.z },
              to: { x: initPos.x + delta.x, y: initPos.y + delta.y, z: initPos.z + delta.z },
            }))

            const sel = bctx.selection
            bctx.editHistory.push({
              id: 'move_' + Math.random().toString(36).slice(2, 10),
              label: `移动 (${delta.x}, ${delta.y}, ${delta.z})`,
              timestamp: Date.now(),
              execute: () => {
                for (const m of moves) grid.moveBlock(m.from, m.to)
                const newItems = [...sel.items.value].map(item => {
                  if (item.kind !== 'block') return item
                  const m = moves.find(
                    mm =>
                      mm.from.x === item.ref.pos.x &&
                      mm.from.y === item.ref.pos.y &&
                      mm.from.z === item.ref.pos.z,
                  )
                  return m
                    ? { ...item, ref: { ...item.ref, pos: { x: m.to.x, y: m.to.y, z: m.to.z } } }
                    : item
                })
                sel.items.value = new Set(newItems)
                bctx.markStructureDirty()
              },
              undo: () => {
                for (const m of moves) grid.moveBlock(m.to, m.from)
                const newItems = [...sel.items.value].map(item => {
                  if (item.kind !== 'block') return item
                  const m = moves.find(
                    mm =>
                      mm.to.x === item.ref.pos.x &&
                      mm.to.y === item.ref.pos.y &&
                      mm.to.z === item.ref.pos.z,
                  )
                  return m
                    ? { ...item, ref: { ...item.ref, pos: { x: m.from.x, y: m.from.y, z: m.from.z } } }
                    : item
                })
                sel.items.value = new Set(newItems)
                bctx.markStructureDirty()
              },
            })
          }
        }

        const el = event.target as HTMLElement | null
        el?.releasePointerCapture(event.pointerId)
        return OP_RESULT.FINISHED
      }

      if (event.type === 'pointercancel') return OP_RESULT.CANCELLED

      return OP_RESULT.PASS_THROUGH
    }

    // ---- Deselect-watch mode (select tool, no gizmo) ----
    if (!(event instanceof PointerEvent)) return OP_RESULT.PASS_THROUGH

    if (event.type === 'pointermove') {
      s._hasMoved = true
      return OP_RESULT.RUNNING_MODAL
    }

    if (event.type === 'pointerup' && event.button === 0) {
      const dx = event.clientX - s._startX
      const dy = event.clientY - s._startY
      if (dx * dx + dy * dy < 25) {
        bctx.selection.clear()
      }
      return OP_RESULT.FINISHED
    }

    if (event.type === 'pointercancel') return OP_RESULT.FINISHED

    return OP_RESULT.PASS_THROUGH
  },

  cancel(bctx, props) {
    const s = toState(props)

    if (s._gizmoAxis || s._freeMove) {
      const gizmo = getGizmo(bctx, props)
      if (gizmo) {
        gizmo.root.position.set(s._originX, s._originY, s._originZ)
      }
      if (s._pointerId >= 0) {
        const el = bctx.viewport.domElement.value
        try {
          el?.releasePointerCapture(s._pointerId)
        } catch {
          /* already released */
        }
      }
    }
  },
}
