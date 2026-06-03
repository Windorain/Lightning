/**
 * Embed 视口触控（对齐地图 / OrbitControls 惯例）：
 * - 单指拖动：轨道旋转（yaw + 俯仰）
 * - 双指捏合：缩放（相对手势起点的距离比）
 * - 双指同移：平移目标点（摄像机位置）
 * - 双指扭转：水平旋转（yaw）
 *
 * 开发 touchSim：Alt+拖=单指旋转，Alt+Shift+拖=捏合缩放+平移
 */
import * as THREE from 'three'
import type { RegionEventHandler } from '@/events/handlerTypes'
import { HANDLER_TYPE } from '@/events/handlerTypes'
import type { Context } from '@/runtime/context'
import { resolveViewportSlot } from '@/runtime/context'
import type { ViewportCameraState } from '@/runtime/viewportCamera'
import {
  ensureViewportCamera,
  panViewportState,
  rotateViewportState,
  rotateViewportYawState,
} from '@/runtime/viewportCamera'
import { isEmbedTouchScreenPointer, isMouseTouchSim } from '@/embed/touchPointer'

interface TouchPoint {
  clientX: number
  clientY: number
}

interface TwoFingerBaseline {
  dist: number
  cx: number
  cy: number
  angle: number
  camera: ViewportCameraState
}

const MIN_PINCH_DIST_PX = 24
const SIM_PINCH_BASE_DIST = 120
/** 双指扭转角度 → 场景 yaw（约 1:1，略降敏） */
const TWIST_YAW_GAIN = 0.9

function sortedTouches(map: Map<number, TouchPoint>): TouchPoint[] {
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, p]) => p)
}

function pinchDistance(pts: TouchPoint[]): number {
  if (pts.length < 2) return 0
  const dx = pts[1].clientX - pts[0].clientX
  const dy = pts[1].clientY - pts[0].clientY
  return Math.hypot(dx, dy)
}

function pinchAngle(pts: TouchPoint[]): number {
  if (pts.length < 2) return 0
  return Math.atan2(
    pts[1].clientY - pts[0].clientY,
    pts[1].clientX - pts[0].clientX,
  )
}

function centroid(pts: TouchPoint[]): { x: number; y: number } {
  let x = 0
  let y = 0
  for (const p of pts) {
    x += p.clientX
    y += p.clientY
  }
  const n = pts.length || 1
  return { x: x / n, y: y / n }
}

function unwrapAngleDelta(prev: number, next: number): number {
  let d = next - prev
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return d
}

function cloneCamera(s: ViewportCameraState): ViewportCameraState {
  return {
    target: { ...s.target },
    yawDeg: s.yawDeg,
    elevationDeg: s.elevationDeg,
    distance: s.distance,
    zoom: s.zoom,
  }
}

export function createEmbedTouchHandler(
  regionId: string,
  getCtx: () => Context,
): RegionEventHandler {
  const pointers = new Map<number, TouchPoint>()
  let mode: 'none' | 'orbit' | 'pinch' = 'none'
  let simPinch = false
  let lastOrbitX = 0
  let lastOrbitY = 0
  let pinchBaseline: TwoFingerBaseline | null = null

  function currentCamera(ctx: Context): ViewportCameraState | null {
    const vp = resolveViewportSlot(ctx, { _regionId: regionId })
    if (!vp.camera.value) return null
    return cloneCamera(ensureViewportCamera(vp.viewportCamera, vp.definition.value))
  }

  function commitCamera(ctx: Context, state: ViewportCameraState): void {
    const vp = resolveViewportSlot(ctx, { _regionId: regionId })
    if (!vp.camera.value) return
    vp.viewportCamera.value = state
  }

  function capturePointer(pe: PointerEvent): void {
    try {
      if (pe.currentTarget instanceof Element) {
        pe.currentTarget.setPointerCapture(pe.pointerId)
      }
    } catch { /* ignore */ }
  }

  function releasePointer(pe: PointerEvent): void {
    try {
      if (pe.currentTarget instanceof Element) {
        pe.currentTarget.releasePointerCapture(pe.pointerId)
      }
    } catch { /* ignore */ }
  }

  function beginOrbit(pe: PointerEvent): void {
    mode = 'orbit'
    simPinch = false
    pinchBaseline = null
    lastOrbitX = pe.clientX
    lastOrbitY = pe.clientY
  }

  function beginPinch(ctx: Context): void {
    const pts = sortedTouches(pointers)
    if (pts.length < 2) return
    const dist = pinchDistance(pts)
    if (dist < MIN_PINCH_DIST_PX) return
    const c = centroid(pts)
    const cam = currentCamera(ctx)
    if (!cam) return

    mode = 'pinch'
    simPinch = false
    pinchBaseline = {
      dist,
      cx: c.x,
      cy: c.y,
      angle: pinchAngle(pts),
      camera: cam,
    }
  }

  function beginSimPinch(ctx: Context, pe: PointerEvent): void {
    const cam = currentCamera(ctx)
    if (!cam) return
    mode = 'pinch'
    simPinch = true
    pinchBaseline = {
      dist: SIM_PINCH_BASE_DIST,
      cx: pe.clientX,
      cy: pe.clientY,
      angle: 0,
      camera: cam,
    }
  }

  function applyPinchGesture(ctx: Context): void {
    const base = pinchBaseline
    if (!base) return

    if (simPinch) {
      const pe = sortedTouches(pointers)[0]
      if (!pe) return
      const panDx = pe.clientX - base.cx
      const panDy = pe.clientY - base.cy
      const dist = Math.max(MIN_PINCH_DIST_PX, base.dist - panDy * 1.2)
      const zoomFactor = dist / base.dist

      let next = cloneCamera(base.camera)
      next = { ...next, zoom: Math.max(0.01, base.camera.zoom * zoomFactor) }
      next = panViewportState(next, panDx, panDy)
      commitCamera(ctx, next)
      return
    }

    const pts = sortedTouches(pointers)
    if (pts.length < 2) return

    const dist = Math.max(MIN_PINCH_DIST_PX, pinchDistance(pts))
    const c = centroid(pts)
    const angle = pinchAngle(pts)

    const zoomFactor = dist / base.dist
    const panDx = c.x - base.cx
    const panDy = c.y - base.cy
    const twistRad = unwrapAngleDelta(base.angle, angle)
    const twistDeg = -THREE.MathUtils.radToDeg(twistRad) * TWIST_YAW_GAIN

    let next = cloneCamera(base.camera)
    next = { ...next, zoom: Math.max(0.01, base.camera.zoom * zoomFactor) }
    next = panViewportState(next, panDx, panDy)
    if (Math.abs(twistDeg) > 0.02) {
      next = rotateViewportYawState(next, twistDeg)
    }

    commitCamera(ctx, next)
  }

  return {
    type: HANDLER_TYPE.GIZMO,
    handle(event: Event): { break: boolean } {
      if (!(event instanceof PointerEvent) || !isEmbedTouchScreenPointer(event)) {
        return { break: false }
      }

      const ctx = getCtx()
      if (!ctx) return { break: false }
      const pe = event

      if (pe.type === 'pointerdown') {
        pointers.set(pe.pointerId, { clientX: pe.clientX, clientY: pe.clientY })
        pe.preventDefault()
        capturePointer(pe)
        ctx.wm.events.cancelModal(regionId)

        if (isMouseTouchSim(pe) && pe.shiftKey) {
          beginSimPinch(ctx, pe)
        } else if (pointers.size >= 2) {
          beginPinch(ctx)
        } else {
          beginOrbit(pe)
        }

        return { break: true }
      }

      if (pe.type === 'pointermove' && pointers.has(pe.pointerId)) {
        pointers.set(pe.pointerId, { clientX: pe.clientX, clientY: pe.clientY })
        pe.preventDefault()

        if (mode === 'pinch') {
          if (!pinchBaseline) {
            if (simPinch || (isMouseTouchSim(pe) && pe.shiftKey)) {
              beginSimPinch(ctx, pe)
            } else {
              beginPinch(ctx)
            }
          }
          applyPinchGesture(ctx)
        } else if (mode === 'orbit' && pointers.size === 1) {
          const dx = pe.clientX - lastOrbitX
          const dy = pe.clientY - lastOrbitY
          if (dx !== 0 || dy !== 0) {
            const vp = resolveViewportSlot(ctx, { _regionId: regionId })
            if (vp.camera.value) {
              const cur = ensureViewportCamera(vp.viewportCamera, vp.definition.value)
              commitCamera(ctx, rotateViewportState(cur, dx, dy))
            }
          }
          lastOrbitX = pe.clientX
          lastOrbitY = pe.clientY
        }

        return { break: true }
      }

      if (
        (pe.type === 'pointerup' || pe.type === 'pointercancel')
        && pointers.has(pe.pointerId)
      ) {
        pointers.delete(pe.pointerId)
        releasePointer(pe)

        if (pointers.size === 0) {
          mode = 'none'
          simPinch = false
          pinchBaseline = null
        } else if (pointers.size === 1) {
          ctx.wm.events.cancelModal(regionId)
          const only = sortedTouches(pointers)[0]
          mode = 'orbit'
          simPinch = false
          pinchBaseline = null
          lastOrbitX = only.clientX
          lastOrbitY = only.clientY
        } else {
          beginPinch(ctx)
        }

        return { break: true }
      }

      return { break: false }
    },
  }
}
