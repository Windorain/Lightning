/**
 * Viewport navigation operators — 对标 Blender 的 VIEW3D_OT_rotate/move/zoom。
 *
 * MMB drag → rotate, Shift+MMB → pan, Ctrl+MMB / wheel → zoom。
 * 每个操作符进入模态，在 modal 中读鼠标 delta 变换相机。
 */
import type { OperatorType, OperatorProperties } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'

interface NavState {
  _startX: number
  _startY: number
  _pointerId: number
}

export const ViewRotateOperator: OperatorType = {
  id: 'OPERATOR_VIEW_ROTATE',
  label: '旋转视图',
  description: 'MMB 拖拽旋转视角',

  poll(bctx) {
    return bctx.viewport.camera.value !== null && bctx.viewport.domElement.value !== null
  },

  invoke(_bctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED
    const target = event.target as HTMLElement | null
    target?.setPointerCapture(event.pointerId)
    const state: NavState = {
      _startX: event.clientX,
      _startY: event.clientY,
      _pointerId: event.pointerId,
    }
    Object.assign(props, state)
    return OP_RESULT.RUNNING_MODAL
  },

  modal(bctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.PASS_THROUGH
    const s = props as unknown as NavState & OperatorProperties
    const camera = bctx.viewport.camera.value
    if (!camera) return OP_RESULT.CANCELLED

    if (event.type === 'pointermove') {
      const dx = event.clientX - s._startX
      const dy = event.clientY - s._startY
      const orbitTarget = bctx.viewport.orbitTarget.value
      const tx = orbitTarget?.x ?? 0
      const ty = orbitTarget?.y ?? 0
      const tz = orbitTarget?.z ?? 0
      const px = camera.position.x - tx
      const py = camera.position.y - ty
      const pz = camera.position.z - tz
      const r = Math.sqrt(px * px + py * py + pz * pz)
      const theta = Math.atan2(px, pz) - dx * 0.005
      const phi = Math.acos(py / r) - dy * 0.005
      const clampedPhi = Math.max(0.01, Math.min(Math.PI - 0.01, phi))
      camera.position.x = tx + r * Math.sin(clampedPhi) * Math.sin(theta)
      camera.position.y = ty + r * Math.cos(clampedPhi)
      camera.position.z = tz + r * Math.sin(clampedPhi) * Math.cos(theta)
      camera.lookAt(tx, ty, tz)
      s._startX = event.clientX
      s._startY = event.clientY
      return OP_RESULT.RUNNING_MODAL
    }

    if (event.type === 'pointerup' || event.type === 'pointercancel') {
      const el = event.target as HTMLElement | null
      el?.releasePointerCapture(event.pointerId)
      return OP_RESULT.FINISHED
    }

    return OP_RESULT.PASS_THROUGH
  },

  cancel(bctx, props) {
    const s = props as unknown as NavState
    if (s._pointerId >= 0) {
      const el = bctx.viewport.domElement.value
      try { el?.releasePointerCapture(s._pointerId) } catch { /* already released */ }
      s._pointerId = -1
    }
  },
}

export const ViewPanOperator: OperatorType = {
  id: 'OPERATOR_VIEW_PAN',
  label: '平移视图',
  description: 'Shift+MMB 拖拽平移视角',

  poll(bctx) {
    return bctx.viewport.camera.value !== null && bctx.viewport.domElement.value !== null
  },

  invoke(_bctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED
    const target = event.target as HTMLElement | null
    target?.setPointerCapture(event.pointerId)
    const state: NavState = {
      _startX: event.clientX,
      _startY: event.clientY,
      _pointerId: event.pointerId,
    }
    Object.assign(props, state)
    return OP_RESULT.RUNNING_MODAL
  },

  modal(bctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.PASS_THROUGH
    const s = props as unknown as NavState & OperatorProperties
    const camera = bctx.viewport.camera.value
    if (!camera) return OP_RESULT.CANCELLED

    if (event.type === 'pointermove') {
      const dx = event.clientX - s._startX
      const dy = event.clientY - s._startY
      const k = 0.03
      const orbitTarget = bctx.viewport.orbitTarget.value
      const tx = orbitTarget?.x ?? 0
      const ty = orbitTarget?.y ?? 0
      const tz = orbitTarget?.z ?? 0
      const fx = tx - camera.position.x, fy = ty - camera.position.y, fz = tz - camera.position.z
      const fl = Math.sqrt(fx * fx + fy * fy + fz * fz)
      const forward = { x: fx / fl, y: fy / fl, z: fz / fl }
      const rx = forward.z, ry = 0, rz = -forward.x
      const rl = Math.sqrt(rx * rx + rz * rz) || 1
      const right = { x: rx / rl, y: ry, z: rz / rl }
      const ux = forward.y * right.z - forward.z * right.y
      const uy = forward.z * right.x - forward.x * right.z
      const uz = forward.x * right.y - forward.y * right.x
      const panX = (dx * right.x + dy * ux) * k
      const panY = (dx * right.y + dy * uy) * k
      const panZ = (dx * right.z + dy * uz) * k
      camera.position.x += panX
      camera.position.y += panY
      camera.position.z += panZ
      // 平移时 orbit target 跟随相机移动，保持旋转中心在场景中的相对位置
      if (orbitTarget) {
        orbitTarget.x += panX
        orbitTarget.y += panY
        orbitTarget.z += panZ
      }
      s._startX = event.clientX
      s._startY = event.clientY
      return OP_RESULT.RUNNING_MODAL
    }

    if (event.type === 'pointerup' || event.type === 'pointercancel') {
      const el = event.target as HTMLElement | null
      el?.releasePointerCapture(event.pointerId)
      return OP_RESULT.FINISHED
    }

    return OP_RESULT.PASS_THROUGH
  },

  cancel(bctx, props) {
    const s = props as unknown as NavState
    if (s._pointerId >= 0) {
      const el = bctx.viewport.domElement.value
      try { el?.releasePointerCapture(s._pointerId) } catch { /* already released */ }
      s._pointerId = -1
    }
  },
}

function applyViewZoom(camera: any, factor: number): void {
  // OrthographicCamera 通过 camera.zoom 缩放，updateProjectionMatrix 自动处理 frustum
  if (!camera) return
  camera.zoom = Math.max(0.01, camera.zoom * factor)
  camera.updateProjectionMatrix()
}

export const ViewZoomOperator: OperatorType = {
  id: 'OPERATOR_VIEW_ZOOM',
  label: '缩放视图',
  description: 'Ctrl+MMB 拖拽 / 滚轮缩放视角',

  poll(bctx) {
    return bctx.viewport.camera.value !== null && bctx.viewport.domElement.value !== null
  },

  invoke(bctx, props, event) {
    // WheelEvent: zoom immediately
    if (event instanceof WheelEvent) {
      const camera = bctx.viewport.camera.value
      if (!camera) return OP_RESULT.CANCELLED
      const factor = (event as WheelEvent).deltaY > 0 ? 0.85 : 1.18
      applyViewZoom(camera, factor)
      return OP_RESULT.FINISHED
    }

    // PointerEvent (Ctrl+MMB drag) → enter modal
    if (event instanceof PointerEvent) {
      const target = event.target as HTMLElement | null
      target?.setPointerCapture(event.pointerId)
    }
    const state: NavState = {
      _startX: event instanceof PointerEvent ? event.clientX : 0,
      _startY: event instanceof PointerEvent ? event.clientY : 0,
      _pointerId: event instanceof PointerEvent ? event.pointerId : -1,
    }
    Object.assign(props, state)
    return OP_RESULT.RUNNING_MODAL
  },

  modal(bctx, props, event) {
    if (event instanceof WheelEvent) {
      const camera = bctx.viewport.camera.value
      if (!camera) return OP_RESULT.CANCELLED
      const factor = event.deltaY > 0 ? 0.85 : 1.18
      applyViewZoom(camera, factor)
      return OP_RESULT.FINISHED
    }

    if (!(event instanceof PointerEvent)) return OP_RESULT.PASS_THROUGH
    const s = props as unknown as NavState & OperatorProperties
    const camera = bctx.viewport.camera.value
    if (!camera) return OP_RESULT.CANCELLED

    if (event.type === 'pointermove') {
      const dy = event.clientY - s._startY
      const factor = dy > 0 ? 1 + dy * 0.005 : 1 / (1 - dy * 0.005)
      applyViewZoom(camera, factor)
      s._startX = event.clientX
      s._startY = event.clientY
      return OP_RESULT.RUNNING_MODAL
    }

    if (event.type === 'pointerup' || event.type === 'pointercancel') {
      const el = event.target as HTMLElement | null
      el?.releasePointerCapture(event.pointerId)
      return OP_RESULT.FINISHED
    }

    return OP_RESULT.PASS_THROUGH
  },

  cancel(bctx, props) {
    const s = props as unknown as NavState
    if (s._pointerId >= 0) {
      const el = bctx.viewport.domElement.value
      try { el?.releasePointerCapture(s._pointerId) } catch { /* already released */ }
      s._pointerId = -1
    }
  },
}
