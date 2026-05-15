/**
 * 无 Three.js 的 Gizmo mock + handler。
 *
 * 生产 toolGizmoHandler 用 THREE.Raycaster hit-test。
 * 测试中通过 bctx.queries.getGizmoAnchor 反算距离来模拟 hit-test。
 */

import type { TypedEventHandler } from '@/workbench/events/eventTypes'
import { HANDLER_TYPE } from '@/workbench/events/eventTypes'
import type { BContext } from '@/workbench/context/bContext'
import type { GizmoAxis } from '@/workbench/tools/gizmos'
import { GizmoDragModal } from '@/workbench/modalOperations/GizmoDragModal'


const HIT_RADIUS = 20 // px，点击距 gizmo 锚点在此范围内视为命中

export class MockGizmo {
  readonly root: { position: { x: number; y: number; z: number; set(x: number, y: number, z: number): void } }

  constructor() {
    const pos = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { pos.x = x; pos.y = y; pos.z = z } }
    this.root = { position: pos }
  }

  setPosition(pos: { x: number; y: number; z: number }): void {
    this.root.position.x = pos.x
    this.root.position.y = pos.y
    this.root.position.z = pos.z
  }

  setVisible(_v: boolean): void { /* no-op */ }

  /** 距离检测：检查点击位置是否靠近某轴的 gizmo 锚点 */
  hitTest(screenX: number, screenY: number, bctx: BContext): GizmoAxis | null {
    let best: GizmoAxis | null = null
    let bestDist = Infinity
    for (const axis of ['x', 'y', 'z'] as const) {
      const anchor = bctx.queries.getGizmoAnchor(axis)
      if (!anchor) continue
      const dx = screenX - anchor.x
      const dy = screenY - anchor.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < HIT_RADIUS && dist < bestDist) {
        bestDist = dist
        best = axis
      }
    }
    return best
  }

  setHighlight(_part: GizmoAxis): void { /* no-op */ }
}

/** 返回 GIZMO handler，注册在 eventDispatcher 上（type=GIZMO，优先级最高） */
export function createTestGizmoHandler(
  getGizmo: () => MockGizmo | null,
  getBctx: () => BContext | null,
): TypedEventHandler {
  return {
    type: HANDLER_TYPE.GIZMO,
    handle(event: Event): { break: boolean } {
      const gizmo = getGizmo()
      const bctx = getBctx()
      if (!gizmo || !bctx) return { break: false }

      if (event.type !== 'pointerdown') return { break: false }
      if (bctx.toolRegistry.activeTool.value?.id !== 'OPERATOR_MOVE') return { break: false }

      const pe = event as PointerEvent
      const hit = gizmo.hitTest(pe.clientX, pe.clientY, bctx)
      if (!hit || hit.length !== 1) return { break: false }

      // Sync gizmo world position to selection center
      let cx = 0, cy = 0, cz = 0
      let n = 0
      for (const item of bctx.selection.items.value) {
        cx += item.pos.x; cy += item.pos.y; cz += item.pos.z
        n++
      }
      if (n > 0) gizmo.setPosition({ x: cx / n, y: cy / n, z: cz / n })

      const startX = pe.clientX
      const startY = pe.clientY
      const axis = hit as 'x' | 'y' | 'z'
      const computeDelta = (_moveEvent: PointerEvent): number => {
        const dx = _moveEvent.clientX - startX
        const dy = _moveEvent.clientY - startY
        const k = bctx.settings.dragSensitivity
        if (axis === 'x') return dx * k
        if (axis === 'y') return -dy * k
        return -dx * k
      }

      const modal = new GizmoDragModal(
        hit as GizmoAxis,
        gizmo as any,
        bctx,
        { enabled: true },
        computeDelta,
      )
      bctx.eventDispatcher.pushModal(modal, pe)
      return { break: true }
    },
  }
}
