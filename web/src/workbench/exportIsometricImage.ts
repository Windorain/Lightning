/**
 * 离屏 WebGL：与预览相同的 mesh 管线，固定等轴四向（绕 Y 旋转 90°）导出 PNG Data URL。
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

import { loadPreviewSessionFromDocument } from '@/preview/previewSession'
import { resolveRenderBundle } from '@/render/data/bundleResolve'
import {
  applyDiagonalOrbitView,
  STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG,
} from '@/render/interaction/initialCamera'
import { buildBlockMesh } from '@/render/mesh/blockMesh'

/** 四向等轴方位角（度），相邻相差 90° */
export const ISOMETRIC_EXPORT_YAW_DEG: readonly number[] = [45, 135, 225, 315]

/**
 * 正交视锥在相机局部 XY 上包住 `box` 的 8 个角（画布为正方形时用 max(半宽,半高) 居中）。
 */
function fitOrthographicCameraToBox(
  camera: THREE.OrthographicCamera,
  box: THREE.Box3,
  padding = 1.08,
): void {
  if (box.isEmpty()) {
    const fs = 5
    camera.left = -fs
    camera.right = fs
    camera.bottom = -fs
    camera.top = fs
    camera.near = 0.1
    camera.far = 500
    camera.updateProjectionMatrix()
    return
  }

  camera.updateMatrixWorld(true)
  const p = new THREE.Vector3()
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity

  const { min, max } = box
  for (const x of [min.x, max.x]) {
    for (const y of [min.y, max.y]) {
      for (const z of [min.z, max.z]) {
        p.set(x, y, z).applyMatrix4(camera.matrixWorldInverse)
        minX = Math.min(minX, p.x)
        maxX = Math.max(maxX, p.x)
        minY = Math.min(minY, p.y)
        maxY = Math.max(maxY, p.y)
        minZ = Math.min(minZ, p.z)
        maxZ = Math.max(maxZ, p.z)
      }
    }
  }

  const cx = (minX + maxX) * 0.5
  const cy = (minY + maxY) * 0.5
  const halfX = ((maxX - minX) * 0.5) * padding
  const halfY = ((maxY - minY) * 0.5) * padding
  const half = Math.max(halfX, halfY, 1e-4)

  camera.left = cx - half
  camera.right = cx + half
  camera.bottom = cy - half
  camera.top = cy + half

  /** 视空间可见 z ∈ [-far, -near]（near/far 为正参量） */
  const zEps = 1e-2
  camera.near = Math.max(0.01, -maxZ + zEps)
  camera.far = Math.max(camera.near + 0.02, -minZ + zEps)
  camera.updateProjectionMatrix()
}

export function dataUrlToPngBlob(dataUrl: string): Blob {
  const i = dataUrl.indexOf(',')
  const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let j = 0; j < binary.length; j++) {
    bytes[j] = binary.charCodeAt(j)
  }
  return new Blob([bytes], { type: 'image/png' })
}

/**
 * @param directionIndex 0..3，对应 {@link ISOMETRIC_EXPORT_YAW_DEG}
 */
export async function bakeIsometricStructurePngDataUrl(
  document: unknown,
  directionIndex: number,
  options?: { pixelSize?: number },
): Promise<string> {
  const size = Math.max(64, Math.min(1024, options?.pixelSize ?? 480))
  const dirIdx = ((Math.floor(directionIndex) % 4) + 4) % 4
  const yawDeg = ISOMETRIC_EXPORT_YAW_DEG[dirIdx] ?? 45

  const { materialLibrary, renderBundle } = await loadPreviewSessionFromDocument(document)
  let controls: OrbitControls | null = null
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  })

  try {
    const { definition } = resolveRenderBundle(renderBundle)
    const built = await buildBlockMesh(definition, materialLibrary, {
      layerPreview: 'all',
    })

    renderer.setSize(size, size)
    renderer.setPixelRatio(1)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setClearColor(0x000000, 0)

    const scene = new THREE.Scene()
    scene.background = null

    const ambient = new THREE.AmbientLight(0xffffff, 0.55)
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.9)
    dirLight.position.set(6, 10, 8)
    scene.add(ambient, dirLight)

    /** 根 pivot：将内容 AABB 中心平移到世界原点，轨道目标恒为原点（即原 AABB 中心） */
    const pivot = new THREE.Group()
    scene.add(pivot)
    const group = built.group
    pivot.add(group)

    group.updateMatrixWorld(true)
    const contentAabb = new THREE.Box3().setFromObject(group)
    let dist = 10
    let maxDim = 1

    if (!contentAabb.isEmpty()) {
      const aabbCenter = new THREE.Vector3()
      contentAabb.getCenter(aabbCenter)
      const sizeVec = new THREE.Vector3()
      contentAabb.getSize(sizeVec)
      maxDim = Math.max(sizeVec.x, sizeVec.y, sizeVec.z, 1e-6)
      dist = maxDim * 2.2
      pivot.position.copy(aabbCenter).negate()
    }

    pivot.updateMatrixWorld(true)
    const boxForFrustum = new THREE.Box3().setFromObject(group)

    const persp = new THREE.PerspectiveCamera(45, 1, Math.max(0.001, maxDim * 0.001), maxDim * 100)
    controls = new OrbitControls(persp, renderer.domElement)
    controls.enabled = false
    /** 世界原点 = 未平移前 mesh 的 AABB 中心 */
    controls.target.set(0, 0, 0)
    applyDiagonalOrbitView(persp, controls, {
      distance: dist,
      yawDeg,
      elevationFromHorizontalDeg: STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG,
    })
    controls.update()
    persp.updateProjectionMatrix()

    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, maxDim * 100)
    ortho.position.copy(persp.position)
    ortho.quaternion.copy(persp.quaternion)
    ortho.up.copy(persp.up)
    ortho.updateMatrixWorld(true)
    fitOrthographicCameraToBox(ortho, boxForFrustum)

    renderer.render(scene, ortho)

    const dataUrl = renderer.domElement.toDataURL('image/png')

    pivot.removeFromParent()
    built.dispose()

    return dataUrl
  } finally {
    controls?.dispose()
    renderer.dispose()
    materialLibrary.dispose()
  }
}
