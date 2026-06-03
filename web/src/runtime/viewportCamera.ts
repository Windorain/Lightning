import { watch, type Ref } from 'vue'
import * as THREE from 'three'
import {
  applyDiagonalOrbitView,
  STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG,
} from '@/render/interaction/initialCamera'
import type { StructureDefinition } from '@/render/schema/types'
import { cameraToSpherical } from '@/pure/camera'

/** Main 持有的视口相机（轨道参数，非 THREE 对象） */
export interface ViewportCameraState {
  target: { x: number; y: number; z: number }
  yawDeg: number
  elevationDeg: number
  distance: number
  zoom: number
}

const DEFAULT_TARGET = { x: 0, y: 2, z: 0 }
const DEFAULT_DISTANCE = 10

export function createDefaultViewportCamera(def?: StructureDefinition | null): ViewportCameraState {
  const ic = def?.initialCamera
  return {
    target: { ...DEFAULT_TARGET },
    yawDeg: 225,
    elevationDeg: STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG,
    distance: ic?.distance ?? DEFAULT_DISTANCE,
    zoom: 1,
  }
}

/** 仅在「框选复位」等需要由包围盒推算新状态时调用 */
export function captureViewportCamera(
  camera: THREE.Camera,
  orbitTarget: THREE.Vector3,
): ViewportCameraState | null {
  const spherical = cameraToSpherical(camera, orbitTarget)
  if (!spherical) return null
  const px = camera.position.x - orbitTarget.x
  const py = camera.position.y - orbitTarget.y
  const pz = camera.position.z - orbitTarget.z
  const distance = Math.sqrt(px * px + py * py + pz * pz)
  return {
    yawDeg: spherical.yawDeg,
    elevationDeg: spherical.elevationDeg,
    zoom: spherical.zoom,
    distance: Math.max(0.1, distance),
    target: { x: orbitTarget.x, y: orbitTarget.y, z: orbitTarget.z },
  }
}

export function ensureViewportCamera(
  cameraRef: Ref<ViewportCameraState | null>,
  def?: StructureDefinition | null,
): ViewportCameraState {
  if (!cameraRef.value) {
    cameraRef.value = createDefaultViewportCamera(def)
  }
  return cameraRef.value
}

/** 视口挂载时注册/初始化本 region 的相机（Workbench / Embed 各有一份） */
export function registerViewportCamera(
  slot: { id: string; viewportCamera: Ref<ViewportCameraState | null> },
  def?: StructureDefinition | null,
): ViewportCameraState {
  return ensureViewportCamera(slot.viewportCamera, def)
}

export function positionFromViewportState(s: ViewportCameraState): { x: number; y: number; z: number } {
  const theta = THREE.MathUtils.degToRad(s.yawDeg)
  const phi = Math.PI / 2 - THREE.MathUtils.degToRad(s.elevationDeg)
  const offset = new THREE.Vector3().setFromSpherical(new THREE.Spherical(s.distance, phi, theta))
  return {
    x: s.target.x + offset.x,
    y: s.target.y + offset.y,
    z: s.target.z + offset.z,
  }
}

/** 将视口 slot 相机状态应用到 THREE（DRW watch / attach 调用） */
export function applyViewportCameraState(
  camera: THREE.Camera,
  orbitTarget: THREE.Vector3,
  state: ViewportCameraState,
): void {
  orbitTarget.set(state.target.x, state.target.y, state.target.z)
  applyDiagonalOrbitView(camera, orbitTarget, {
    yawDeg: state.yawDeg,
    elevationFromHorizontalDeg: state.elevationDeg,
    distance: state.distance,
  })
  if ('zoom' in camera) {
    const cam = camera as THREE.OrthographicCamera
    cam.zoom = Math.max(0.01, state.zoom)
    cam.updateProjectionMatrix()
  }
}

export function rotateViewportState(s: ViewportCameraState, dx: number, dy: number): ViewportCameraState {
  const dYaw = THREE.MathUtils.radToDeg(dx * 0.005)
  const dElev = THREE.MathUtils.radToDeg(dy * 0.005)
  return rotateViewportYawState(rotateViewportElevationState(s, dElev), dYaw)
}

/** 水平拖 / 双指扭转 → 绕目标 yaw */
export function rotateViewportYawState(s: ViewportCameraState, dYawDeg: number): ViewportCameraState {
  return { ...s, yawDeg: s.yawDeg - dYawDeg }
}

export function rotateViewportElevationState(s: ViewportCameraState, dElevDeg: number): ViewportCameraState {
  return {
    ...s,
    elevationDeg: Math.max(1, Math.min(89, s.elevationDeg + dElevDeg)),
  }
}

export function panViewportState(s: ViewportCameraState, dx: number, dy: number): ViewportCameraState {
  const pos = positionFromViewportState(s)
  const k = 0.03
  const fx = s.target.x - pos.x
  const fy = s.target.y - pos.y
  const fz = s.target.z - pos.z
  const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1
  const forward = { x: fx / fl, y: fy / fl, z: fz / fl }
  const rx = forward.z
  const rz = -forward.x
  const rl = Math.sqrt(rx * rx + rz * rz) || 1
  const right = { x: rx / rl, y: 0, z: rz / rl }
  const ux = forward.y * right.z - forward.z * right.y
  const uy = forward.z * right.x - forward.x * right.z
  const uz = forward.x * right.y - forward.y * right.x
  const pd = {
    x: (dx * right.x + dy * ux) * k,
    y: (dx * right.y + dy * uy) * k,
    z: (dx * right.z + dy * uz) * k,
  }
  return {
    ...s,
    target: {
      x: s.target.x + pd.x,
      y: s.target.y + pd.y,
      z: s.target.z + pd.z,
    },
  }
}

export function zoomViewportState(s: ViewportCameraState, factor: number): ViewportCameraState {
  return { ...s, zoom: Math.max(0.01, s.zoom * factor) }
}

/** Main → THREE；返回取消 watch */
export function bindViewportCameraSync(
  stateRef: Ref<ViewportCameraState | null>,
  cameraRef: Ref<THREE.Camera | null>,
  orbitRef: Ref<THREE.Vector3 | null>,
): () => void {
  return watch(
    stateRef,
    (state) => {
      if (!state) return
      const cam = cameraRef.value
      const orbit = orbitRef.value
      if (!cam || !orbit) return
      applyViewportCameraState(cam, orbit, state)
    },
    { deep: true, flush: 'sync' },
  )
}
