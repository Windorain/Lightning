/**
 * Viewport navigation operators — 对标 Blender 的 VIEW3D_OT_rotate/move/zoom。
 *
 * MMB drag → rotate, Shift+MMB → pan, Ctrl+MMB / wheel → zoom。
 * 每个操作符进入模态，在 modal 中读鼠标 delta 变换相机。
 */
import type { OperatorType, OperatorProperties } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'
import { resolveViewportSlot } from '@/workbench/context/bContext'
import { sphericalOrbitDelta, panDelta } from '@/pure/camera'

interface NavState {
  _startX: number
  _startY: number
  _pointerId: number
}

function releasePointerCapture(bctx: any, props: any): void {
  const s = props as unknown as NavState
  if (s._pointerId >= 0) {
    const vp = resolveViewportSlot(bctx, props)
    const el = vp.domElement.value
    try { el?.releasePointerCapture(s._pointerId) } catch { /* already released */ }
    s._pointerId = -1
  }
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
    const vp = resolveViewportSlot(bctx, props)
    const camera = vp.camera.value
    if (!camera) return OP_RESULT.CANCELLED

    if (event.type === 'pointermove') {
      const dx = event.clientX - s._startX
      const dy = event.clientY - s._startY
      const orbitTarget = vp.orbitTarget.value
      const tx = orbitTarget?.x ?? 0
      const ty = orbitTarget?.y ?? 0
      const tz = orbitTarget?.z ?? 0
      const px = camera.position.x - tx
      const py = camera.position.y - ty
      const pz = camera.position.z - tz
      const delta = sphericalOrbitDelta(px, py, pz, dx, dy)
      camera.position.x = tx + delta.x
      camera.position.y = ty + delta.y
      camera.position.z = tz + delta.z
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

  cancel(bctx, props) { releasePointerCapture(bctx, props) },
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
    const vp = resolveViewportSlot(bctx, props)
    const camera = vp.camera.value
    if (!camera) return OP_RESULT.CANCELLED

    if (event.type === 'pointermove') {
      const dx = event.clientX - s._startX
      const dy = event.clientY - s._startY
      const orbitTarget = vp.orbitTarget.value
      const tx = orbitTarget?.x ?? 0
      const ty = orbitTarget?.y ?? 0
      const tz = orbitTarget?.z ?? 0
      const pd = panDelta(
        { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        { x: tx, y: ty, z: tz },
        dx, dy,
      )
      camera.position.x += pd.x
      camera.position.y += pd.y
      camera.position.z += pd.z
      // 平移时 orbit target 跟随相机移动，保持旋转中心在场景中的相对位置
      if (orbitTarget) {
        orbitTarget.x += pd.x
        orbitTarget.y += pd.y
        orbitTarget.z += pd.z
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

  cancel(bctx, props) { releasePointerCapture(bctx, props) },
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
      const vp = resolveViewportSlot(bctx, props)
      const camera = vp.camera.value
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
      const vp = resolveViewportSlot(bctx, props)
      const camera = vp.camera.value
      if (!camera) return OP_RESULT.CANCELLED
      const factor = event.deltaY > 0 ? 0.85 : 1.18
      applyViewZoom(camera, factor)
      return OP_RESULT.FINISHED
    }

    if (!(event instanceof PointerEvent)) return OP_RESULT.PASS_THROUGH
    const s = props as unknown as NavState & OperatorProperties
    const vp = resolveViewportSlot(bctx, props)
    const camera = vp.camera.value
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

  cancel(bctx, props) { releasePointerCapture(bctx, props) },
}
