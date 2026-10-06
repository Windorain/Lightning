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

/**
 * 深度（near/far）相对内容 AABB 的**外扩**余量（世界单位）。
 * 必须朝「远离内容」的方向让开——否则贴着包围盒的那一层几何会被整面裁掉（见 {@link fitOrthoDepthToBox}）。
 */
export const ORTHO_DEPTH_MARGIN = 1e-2

/**
 * 按内容 AABB 收紧正交相机的深度范围（near/far），保证 **box 整体落在视锥内**。
 *
 * 视空间可见 z ∈ [-far, -near]（near/far 为正参量），其中 `-maxZ` = 离相机**最近**的
 * 包围盒角距离、`-minZ` = 最远角距离。两个平面都必须**向外**让开 `margin`：
 *
 * ```
 * near = -maxZ - margin   // 位于最近点之前（更靠近相机）
 * far  = -minZ + margin   // 位于最远点之后
 * ```
 *
 * ⚠️ 反例（#87 ortho-north 根因）：near 曾写成 `-maxZ + margin`，把近平面放到最近点**之后**。
 * 对**轴对齐机位**（north/south/east/west/top），内容 AABB 的贴面**整面**恰好落在最近点那个
 * 平面上 ⇒ 最前一层被整齐裁掉：north 机位下那层正是横排 5 格唯一朝向相机的 -z 面，
 * 于是整排消失、只剩更远处的孤立枚；south 机位下被裁的是孤立枚的 +z 面（其"全框 tile"消失）。
 * 等轴（斜向）机位只裁掉最近角的一丝像素，故该 bug 长期未被发现。
 */
export function fitOrthoDepthToBox(
  camera: THREE.OrthographicCamera,
  box: THREE.Box3,
  margin: number = ORTHO_DEPTH_MARGIN,
): void {
  if (box.isEmpty()) return
  const { min, max } = box
  if (!Number.isFinite(min.x) || !Number.isFinite(max.x)) return

  camera.updateMatrixWorld(true)
  const p = new THREE.Vector3()
  let minZ = Infinity
  let maxZ = -Infinity
  for (const x of [min.x, max.x]) {
    for (const y of [min.y, max.y]) {
      for (const z of [min.z, max.z]) {
        p.set(x, y, z).applyMatrix4(camera.matrixWorldInverse)
        if (p.z < minZ) minZ = p.z
        if (p.z > maxZ) maxZ = p.z
      }
    }
  }
  camera.near = Math.max(0.01, -maxZ - margin)
  camera.far = Math.max(camera.near + 0.02, -minZ + margin)
  camera.updateProjectionMatrix()
}

/** 将当前视锥半高与 `camera.zoom` 合并为逻辑 `ViewportCameraState.zoom` */
export function effectiveOrthoZoomForState(
  cam: THREE.OrthographicCamera,
  canonicalHalfHeight = ORTHO_CANONICAL_HALF_HEIGHT,
): number {
  const halfH = Math.max(orthoVerticalHalfExtent(cam), 1e-4)
  return Math.max(0.01, (cam.zoom ?? 1) * (canonicalHalfHeight / halfH))
}
