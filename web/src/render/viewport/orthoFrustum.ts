import * as THREE from 'three'

/** 与 {@link View3DRenderer} 构造时 `DEFAULT_FRUSTUM_SIZE` 一致：竖直半高 */
export const ORTHO_CANONICAL_HALF_HEIGHT = 5

export function orthoVerticalHalfExtent(cam: THREE.OrthographicCamera): number {
  return (cam.top - cam.bottom) * 0.5
}

export function orthoAspectFromFrustum(cam: THREE.OrthographicCamera): number {
  const halfH = Math.max(orthoVerticalHalfExtent(cam), 1e-6)
  const halfW = (cam.right - cam.left) * 0.5
  return halfW / halfH
}

/** 以世界 Y 为竖直轴、对称视锥；缩放仅由 `camera.zoom` 表达 */
export function setSymmetricOrthoFrustum(
  cam: THREE.OrthographicCamera,
  viewportAspect: number,
  halfHeight = ORTHO_CANONICAL_HALF_HEIGHT,
): void {
  const aspect = Math.max(viewportAspect, 1e-6)
  const halfH = halfHeight
  cam.left = -halfH * aspect
  cam.right = halfH * aspect
  cam.top = halfH
  cam.bottom = -halfH
  cam.updateProjectionMatrix()
}

/** 将当前视锥半高与 `camera.zoom` 合并为逻辑 `ViewportCameraState.zoom` */
export function effectiveOrthoZoomForState(
  cam: THREE.OrthographicCamera,
  canonicalHalfHeight = ORTHO_CANONICAL_HALF_HEIGHT,
): number {
  const halfH = Math.max(orthoVerticalHalfExtent(cam), 1e-4)
  return Math.max(0.01, (cam.zoom ?? 1) * (canonicalHalfHeight / halfH))
}
