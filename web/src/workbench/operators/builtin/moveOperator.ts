import type { OperatorType, OperatorProperties } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'

/**
 * MoveOperator — 对标 Blender 的 TRANSFORM_OT_translate。
 *
 * 两种执行模式：
 * - Gizmo 轴拖拽：props.gizmoAxis 由 GizmoHandler 设置，
 *   按轴向移动选中方块并创建撤销条目。
 * - 空白点击：pointerdown pick/select → 未命中且无修饰键
 *   则进入模态监听 pointerup，区分 click（清选）vs drag（保留选中）。
 */
export const MoveOperator: OperatorType = {
  id: 'OPERATOR_MOVE',
  label: '移动',
  description: '拖拽 Gizmo 箭头移动选中方块',

  poll(bctx) {
    return bctx.doc.value !== null
  },

  initModalState(): OperatorProperties {
    return {
      _gizmoAxis: null,
      _originX: 0,
      _originY: 0,
      _originZ: 0,
      _startX: 0,
      _startY: 0,
      _initialPositions: [],
      _precision: false,
      _screenDirX: 0,
      _screenDirY: 0,
      _k: 0,
      _hasMoved: false,
      _pointerId: -1,
    }
  },

  invoke(bctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED

    // Gizmo 轴拖拽（由 GizmoHandler 触发）
    if (props.gizmoAxis) {
      const gizmo = props.gizmo as any
      if (!gizmo) return OP_RESULT.CANCELLED

      const target = event.target as HTMLElement | null
      target?.setPointerCapture(event.pointerId)

      Object.assign(props, {
        _gizmoAxis: props.gizmoAxis,
        _originX: gizmo.root.position.x,
        _originY: gizmo.root.position.y,
        _originZ: gizmo.root.position.z,
        _startX: event.clientX,
        _startY: event.clientY,
        _initialPositions: [...(bctx.selection.items.value)].filter(e => e.kind === 'block').map(e => ({ ...e.ref.pos })),
        _precision: false,
        _screenDirX: (props.screenDirX as number) ?? 0,
        _screenDirY: (props.screenDirY as number) ?? 0,
        _k: (props.k as number) ?? 0,
        _hasMoved: false,
        _pointerId: event.pointerId,
      })
      return OP_RESULT.RUNNING_MODAL
    }

    // 普通点击：pick → select/add
    bctx.selection.resetCycle()
    const picked = bctx.queries.pickVoxel(event)
    if (picked) {
      if (event.ctrlKey || event.metaKey) {
        bctx.selection.add([picked])
      } else {
        bctx.selection.select(picked)
      }
      return OP_RESULT.FINISHED
    }

    // 点击空白——进入模态监听 click vs drag
    if (!event.ctrlKey && !event.metaKey) {
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
    const s = props as unknown as OperatorProperties & {
      _gizmoAxis: string | null
      _originX: number
      _originY: number
      _originZ: number
      _startX: number
      _startY: number
      _initialPositions: Array<{ x: number; y: number; z: number }>
      _precision: boolean
      _screenDirX: number
      _screenDirY: number
      _k: number
      _hasMoved: boolean
      _pointerId: number
    }

    // ===== Gizmo 轴拖拽模式 =====
    if (s._gizmoAxis) {
      if ((event as any).type === 'MODAL_MAP') {
        switch ((event as any).value) {
          case 'CANCEL':
            return OP_RESULT.CANCELLED
          case 'CONFIRM':
            return OP_RESULT.FINISHED
          case 'PRECISION_TOGGLE':
            s._precision = !s._precision
            return OP_RESULT.RUNNING_MODAL
        }
        return OP_RESULT.RUNNING_MODAL
      }

      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') return OP_RESULT.CANCELLED
        if (event.key === 'Enter') return OP_RESULT.FINISHED
        if (event.key === 'Shift') {
          s._precision = !s._precision
          return OP_RESULT.RUNNING_MODAL
        }
        return OP_RESULT.RUNNING_MODAL
      }

      if (!(event instanceof PointerEvent)) return OP_RESULT.PASS_THROUGH

      const gizmo = (props as any).gizmo as any
      if (!gizmo) return OP_RESULT.CANCELLED

      if (event.type === 'pointermove') {
        const dx = event.clientX - s._startX
        const dy = event.clientY - s._startY
        const proj = dx * s._screenDirX + dy * s._screenDirY
        let delta = proj * s._k
        if (s._precision) delta = Math.round(delta * 10) / 10

        const origin = { x: s._originX, y: s._originY, z: s._originZ }
        const newPos = bctx.queries.axisAdd(origin, s._gizmoAxis as any, delta)
        gizmo.root.position.set(newPos.x, newPos.y, newPos.z)
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
              id: 'gizmo_' + Math.random().toString(36).slice(2, 10),
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

    // ===== 空白点击（deselect watch）模式 =====
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
    const s = props as unknown as {
      _gizmoAxis: string | null
      _originX: number
      _originY: number
      _originZ: number
      _pointerId: number
    }

    if (s._gizmoAxis) {
      const gizmo = (props as any).gizmo as any
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
