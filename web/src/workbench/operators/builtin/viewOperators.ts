/**
 * Viewport navigation operators — 对标 Blender 的 VIEW3D_OT_rotate/move/zoom。
 *
 * MMB drag → rotate, Shift+MMB → pan, Ctrl+MMB / wheel → zoom。
 * 每个操作符进入模态，在 modal 中读鼠标 delta 变换相机。
 * 纯数学实现，不依赖 THREE 导入 — 仅通过 bctx.viewport.camera.value 操作。
 */
import type { OperatorType, OperatorProperties } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'

interface NavState {
  _startX: number
  _startY: number
  _controlsRef: { enabled: boolean } | null
}

function disableOrbit(bctx: any): { enabled: boolean } | null {
  const ref = bctx.viewport.controls.value
  if (ref) ref.enabled = false
  return ref
}

function enableOrbit(ref: { enabled: boolean } | null): void {
  if (ref) ref.enabled = true
}

export const ViewRotateOperator: OperatorType = {
  id: 'OPERATOR_VIEW_ROTATE',
  label: '旋转视图',
  description: 'MMB 拖拽旋转视角',

  poll(bctx) {
    return bctx.viewport.camera.value !== null && bctx.viewport.domElement.value !== null
  },

  invoke(bctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED
    const state: NavState = {
      _startX: event.clientX,
      _startY: event.clientY,
      _controlsRef: disableOrbit(bctx),
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
      const r = Math.sqrt(camera.position.x ** 2 + camera.position.y ** 2 + camera.position.z ** 2)
      const theta = Math.atan2(camera.position.x, camera.position.z) - dx * 0.005
      const phi = Math.acos(camera.position.y / r) + dy * 0.005
      const clampedPhi = Math.max(0.1, Math.min(Math.PI - 0.1, phi))
      camera.position.x = r * Math.sin(clampedPhi) * Math.sin(theta)
      camera.position.y = r * Math.cos(clampedPhi)
      camera.position.z = r * Math.sin(clampedPhi) * Math.cos(theta)
      camera.lookAt(0, 0, 0)
      s._startX = event.clientX
      s._startY = event.clientY
      return OP_RESULT.RUNNING_MODAL
    }

    if (event.type === 'pointerup') {
      enableOrbit(s._controlsRef)
      return OP_RESULT.FINISHED
    }

    return OP_RESULT.PASS_THROUGH
  },

  cancel(_bctx, props) {
    const s = props as unknown as NavState
    enableOrbit(s._controlsRef)
  },
}

export const ViewPanOperator: OperatorType = {
  id: 'OPERATOR_VIEW_PAN',
  label: '平移视图',
  description: 'Shift+MMB 拖拽平移视角',

  poll(bctx) {
    return bctx.viewport.camera.value !== null && bctx.viewport.domElement.value !== null
  },

  invoke(bctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED
    const state: NavState = {
      _startX: event.clientX,
      _startY: event.clientY,
      _controlsRef: disableOrbit(bctx),
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
      const k = 0.01
      // Camera-relative pan using pure math (no THREE)
      const fx = -camera.position.x, fy = -camera.position.y, fz = -camera.position.z
      const fl = Math.sqrt(fx * fx + fy * fy + fz * fz)
      const forward = { x: fx / fl, y: fy / fl, z: fz / fl }
      const rx = forward.z, ry = 0, rz = -forward.x
      const rl = Math.sqrt(rx * rx + rz * rz) || 1
      const right = { x: rx / rl, y: ry, z: rz / rl }
      const ux = forward.y * right.z - forward.z * right.y
      const uy = forward.z * right.x - forward.x * right.z
      const uz = forward.x * right.y - forward.y * right.x
      camera.position.x += (-dx * right.x + dy * ux) * k
      camera.position.y += (-dx * right.y + dy * uy) * k
      camera.position.z += (-dx * right.z + dy * uz) * k
      s._startX = event.clientX
      s._startY = event.clientY
      return OP_RESULT.RUNNING_MODAL
    }

    if (event.type === 'pointerup') {
      enableOrbit(s._controlsRef)
      return OP_RESULT.FINISHED
    }

    return OP_RESULT.PASS_THROUGH
  },

  cancel(_bctx, props) {
    const s = props as unknown as NavState
    enableOrbit(s._controlsRef)
  },
}

export const ViewZoomOperator: OperatorType = {
  id: 'OPERATOR_VIEW_ZOOM',
  label: '缩放视图',
  description: 'Ctrl+MMB 拖拽 / 滚轮缩放视角',

  poll(bctx) {
    return bctx.viewport.camera.value !== null && bctx.viewport.domElement.value !== null
  },

  invoke(bctx, props, event) {
    const state: NavState = {
      _startX: event instanceof PointerEvent ? event.clientX : 0,
      _startY: event instanceof PointerEvent ? event.clientY : 0,
      _controlsRef: disableOrbit(bctx),
    }
    Object.assign(props, state)
    return OP_RESULT.RUNNING_MODAL
  },

  modal(bctx, props, event) {
    if (event instanceof WheelEvent) {
      const camera = bctx.viewport.camera.value
      if (!camera) return OP_RESULT.CANCELLED
      const factor = event.deltaY > 0 ? 1.1 : 0.9
      camera.position.x *= factor
      camera.position.y *= factor
      camera.position.z *= factor
      enableOrbit((props as unknown as NavState)._controlsRef)
      return OP_RESULT.FINISHED
    }

    if (!(event instanceof PointerEvent)) return OP_RESULT.PASS_THROUGH
    const s = props as unknown as NavState & OperatorProperties
    const camera = bctx.viewport.camera.value
    if (!camera) return OP_RESULT.CANCELLED

    if (event.type === 'pointermove') {
      const dy = event.clientY - s._startY
      const factor = dy > 0 ? 1 + dy * 0.005 : 1 / (1 - dy * 0.005)
      camera.position.x *= factor
      camera.position.y *= factor
      camera.position.z *= factor
      s._startX = event.clientX
      s._startY = event.clientY
      return OP_RESULT.RUNNING_MODAL
    }

    if (event.type === 'pointerup') {
      enableOrbit(s._controlsRef)
      return OP_RESULT.FINISHED
    }

    return OP_RESULT.PASS_THROUGH
  },

  cancel(_bctx, props) {
    const s = props as unknown as NavState
    enableOrbit(s._controlsRef)
  },
}
