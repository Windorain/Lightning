/**
 * Viewport navigation operators — 对标 Blender 的 VIEW3D_OT_rotate/move/zoom。
 *
 * 只修改 Main.cameras；DRW 将状态同步到 THREE。
 */
import type { OperatorType, OperatorProperties } from '@/operators/operatorType'
import { OP_RESULT } from '@/operators/operatorType'
import { resolveViewportSlot } from '@/runtime/context'
import { applyViewportCameraFromMainInitial } from '@/runtime/viewportCameraApply'
import {
  ensureMainViewportCamera,
  rotateViewportState,
  panViewportState,
  zoomViewportState,
} from '@/runtime/viewportCamera'

interface NavState {
  _startX: number
  _startY: number
  _pointerId: number
}

function releasePointerCapture(ctx: any, props: any): void {
  const s = props as unknown as NavState
  if (s._pointerId >= 0) {
    const vp = resolveViewportSlot(ctx, props)
    const el = vp.domElement.value
    try { el?.releasePointerCapture(s._pointerId) } catch { /* already released */ }
    s._pointerId = -1
  }
}

export const ViewRotateOperator: OperatorType = {
  id: 'OPERATOR_VIEW_ROTATE',
  label: '旋转视图',
  description: 'MMB 拖拽旋转视角',

  poll(ctx) {
    return ctx.getViewport().camera.value !== null && ctx.getViewport().domElement.value !== null
  },

  invoke(_ctx, props, event) {
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

  modal(ctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.PASS_THROUGH
    const s = props as unknown as NavState & OperatorProperties
    const vp = resolveViewportSlot(ctx, props)
    if (!vp.camera.value) return OP_RESULT.CANCELLED

    if (event.type === 'pointermove') {
      const dx = event.clientX - s._startX
      const dy = event.clientY - s._startY
      const key = vp.cameraMainKey
      const camRef = ctx.main.cameras[key]
      const cur = ensureMainViewportCamera(ctx.main, key, vp.definition.value)
      camRef.value = rotateViewportState(cur, dx, dy)
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

  cancel(ctx, props) { releasePointerCapture(ctx, props) },
}

export const ViewPanOperator: OperatorType = {
  id: 'OPERATOR_VIEW_PAN',
  label: '平移视图',
  description: 'Shift+MMB 拖拽平移视角',

  poll(ctx) {
    return ctx.getViewport().camera.value !== null && ctx.getViewport().domElement.value !== null
  },

  invoke(_ctx, props, event) {
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

  modal(ctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.PASS_THROUGH
    const s = props as unknown as NavState & OperatorProperties
    const vp = resolveViewportSlot(ctx, props)
    if (!vp.camera.value) return OP_RESULT.CANCELLED

    if (event.type === 'pointermove') {
      const dx = event.clientX - s._startX
      const dy = event.clientY - s._startY
      const key = vp.cameraMainKey
      const camRef = ctx.main.cameras[key]
      const cur = ensureMainViewportCamera(ctx.main, key, vp.definition.value)
      camRef.value = panViewportState(cur, dx, dy)
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

  cancel(ctx, props) { releasePointerCapture(ctx, props) },
}

export const InitViewportCameraOperator: OperatorType = {
  id: 'OPERATOR_INIT_VIEWPORT_CAMERA',
  label: '初始化视口相机',
  internal: true,
  poll(ctx) {
    const vp = ctx.getViewport()
    return vp.camera.value !== null
  },
  exec(ctx, props) {
    applyViewportCameraFromMainInitial(ctx, props)
  },
}

export const ViewResetOperator: OperatorType = {
  id: 'OPERATOR_VIEW_RESET',
  label: '复位视角',
  description: '恢复 Main 初始相机（无外界时自动框选）',

  poll(ctx) {
    const vp = ctx.getViewport()
    return vp.camera.value !== null
  },

  exec(ctx, props) {
    applyViewportCameraFromMainInitial(ctx, props)
  },
}

export const ViewZoomOperator: OperatorType = {
  id: 'OPERATOR_VIEW_ZOOM',
  label: '缩放视图',
  description: 'Ctrl+MMB 拖拽 / 滚轮缩放视角',

  poll(ctx) {
    return ctx.getViewport().camera.value !== null && ctx.getViewport().domElement.value !== null
  },

  invoke(ctx, props, event) {
    if (event instanceof WheelEvent) {
      const factor = event.deltaY > 0 ? 0.85 : 1.18
      const vp = resolveViewportSlot(ctx, props)
      const key = vp.cameraMainKey
      const camRef = ctx.main.cameras[key]
      const cur = ensureMainViewportCamera(ctx.main, key, vp.definition.value)
      camRef.value = zoomViewportState(cur, factor)
      return OP_RESULT.FINISHED
    }

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

  modal(ctx, props, event) {
    if (event instanceof WheelEvent) {
      const factor = event.deltaY > 0 ? 0.85 : 1.18
      const vp = resolveViewportSlot(ctx, props)
      const key = vp.cameraMainKey
      const camRef = ctx.main.cameras[key]
      const cur = ensureMainViewportCamera(ctx.main, key, vp.definition.value)
      camRef.value = zoomViewportState(cur, factor)
      return OP_RESULT.FINISHED
    }

    if (!(event instanceof PointerEvent)) return OP_RESULT.PASS_THROUGH
    const s = props as unknown as NavState & OperatorProperties
    const vp = resolveViewportSlot(ctx, props)
    if (!vp.camera.value) return OP_RESULT.CANCELLED

    if (event.type === 'pointermove') {
      const dy = event.clientY - s._startY
      const factor = dy > 0 ? 1 + dy * 0.005 : 1 / (1 - dy * 0.005)
      const key = vp.cameraMainKey
      const camRef = ctx.main.cameras[key]
      const cur = ensureMainViewportCamera(ctx.main, key, vp.definition.value)
      camRef.value = zoomViewportState(cur, factor)
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

  cancel(ctx, props) { releasePointerCapture(ctx, props) },
}
