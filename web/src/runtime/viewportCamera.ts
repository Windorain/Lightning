import { watch, type Ref } from 'vue'
import * as THREE from 'three'
import {
  applyDiagonalOrbitView,
  resolveFocusOrbitTarget,
  STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG,
} from '@/render/interaction/initialCamera'
import type { StructureDefinition } from '@/render/schema/types'
import { cameraToSpherical } from '@/pure/camera'
import {
  effectiveOrthoZoomForState,
  orthoAspectFromFrustum,
  setSymmetricOrthoFrustum,
} from '@/render/viewport/orthoFrustum'
import type { InitialCamera } from '@/viewer/viewerConfig'
import type { Main } from '@/runtime/main'
import type { CameraMainKey } from '@/runtime/mainCameras'

/** 视口逻辑相机（轨道参数，非 THREE 对象；操作符与 DRW 同步真源） */
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

/** 模板 / bootstrap / session 是否指定了显式视角（有则跳过无参自动框选复位） */
export function hasExplicitExternalCamera(external?: InitialCamera): boolean {
  if (!external) return false
  return (
    external.yawDeg != null
    || external.elevationDeg != null
    || external.zoom != null
    || external.distance != null
  )
}

function numOr<T extends number>(v: T | undefined, fallback: T): T {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * 统一初始相机：外界 initialCamera 优先，其次 JSON 焦点 target/distance，最后默认等轴。
 */
export function resolveInitialViewportCamera(opts: {
  external?: InitialCamera
  definition?: StructureDefinition | null
}): ViewportCameraState {
  const base = createDefaultViewportCamera(opts.definition)
  const focus = resolveFocusOrbitTarget(opts.definition)
  if (focus) base.target = { ...focus }

  const defIc = opts.definition?.initialCamera
  if (defIc?.distance != null && opts.external?.distance == null) {
    base.distance = defIc.distance
  }

  const ext = opts.external
  if (ext) {
    if (ext.yawDeg != null) base.yawDeg = ext.yawDeg
    if (ext.elevationDeg != null) base.elevationDeg = ext.elevationDeg
    if (ext.distance != null) base.distance = ext.distance
    if (ext.zoom != null) base.zoom = Math.max(0.01, ext.zoom)
  }

  base.distance = numOr(base.distance, DEFAULT_DISTANCE)
  base.zoom = numOr(base.zoom, 1)
  base.elevationDeg = numOr(base.elevationDeg, STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG)
  return base
}

export function ensureMainViewportCamera(
  main: Main,
  key: CameraMainKey,
  definition?: StructureDefinition | null,
): ViewportCameraState {
  const ref = main.cameras[key]
  if (!ref.value) {
    if (main.embedInitialView.value) {
      ref.value = {
        target: { ...main.embedInitialView.value.target },
        yawDeg: main.embedInitialView.value.yawDeg,
        elevationDeg: main.embedInitialView.value.elevationDeg,
        distance: main.embedInitialView.value.distance,
        zoom: main.embedInitialView.value.zoom,
      }
    } else {
      ref.value = resolveInitialViewportCamera({ definition })
    }
  }
  return ref.value
}

export function captureViewportCamera(
  camera: THREE.Camera,
  orbitTarget: THREE.Vector3,
): ViewportCameraState | null {
  const spherical = cameraToSpherical(camera, orbitTarget)
  if (!spherical) return null
  const zoom =
    camera instanceof THREE.OrthographicCamera
      ? Math.round(effectiveOrthoZoomForState(camera) * 100) / 100
      : spherical.zoom
  const px = camera.position.x - orbitTarget.x
  const py = camera.position.y - orbitTarget.y
  const pz = camera.position.z - orbitTarget.z
  const distance = Math.sqrt(px * px + py * py + pz * pz)
  return {
    yawDeg: spherical.yawDeg,
    elevationDeg: spherical.elevationDeg,
    zoom,
    distance: Math.max(0.1, distance),
    target: { x: orbitTarget.x, y: orbitTarget.y, z: orbitTarget.z },
  }
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
  if (camera instanceof THREE.OrthographicCamera) {
    const aspect = orthoAspectFromFrustum(camera)
    setSymmetricOrthoFrustum(camera, aspect)
    camera.zoom = Math.max(0.01, state.zoom)
    camera.updateProjectionMatrix()
  }
}

export function rotateViewportState(s: ViewportCameraState, dx: number, dy: number): ViewportCameraState {
  const dYaw = THREE.MathUtils.radToDeg(dx * 0.005)
  const dElev = THREE.MathUtils.radToDeg(dy * 0.005)
  return rotateViewportYawState(rotateViewportElevationState(s, dElev), dYaw)
}

export function rotateViewportYawState(s: ViewportCameraState, dYawDeg: number): ViewportCameraState {
  return { ...s, yawDeg: s.yawDeg - dYawDeg }
}

export function rotateViewportElevationState(s: ViewportCameraState, dElevDeg: number): ViewportCameraState {
  return {
    ...s,
    elevationDeg: Math.max(-89.9, Math.min(89.9, s.elevationDeg + dElevDeg)),
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
