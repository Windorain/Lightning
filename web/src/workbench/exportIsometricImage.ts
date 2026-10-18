/**
 * 离屏 WebGL：与预览相同的 mesh 管线，固定等轴四向（绕 Y 旋转 90°）导出 PNG Data URL。
 *
 * ## M5-4：共享 stage（PNG 与 GIF 同一条烘焙链）
 *
 * 时间输入是**显式**的：`bakeIsometricStructurePngDataUrl` 的 `seconds` 缺省 0（与改造前
 * "帧偏移停在构造初值 0"逐位一致），非法值**抛**（不把 `NaN` 伪装成 `t=0`）。
 * 场景 GIF（`workbench/exportAnimatedGif.ts`）复用 {@link openIsometricStage}：同渲染器、
 * 同相机、同材质库 —— 这是"GIF 首帧 ≈ 同参数 PNG"判据的结构前提。
 */

import * as THREE from 'three'

import { buildMaterialLibrary } from '@/render/data/buildMaterialLibrary'
import { resolveRenderBundle } from '@/render/data/bundleResolve'
import {
  applyDiagonalOrbitView,
  STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG,
} from '@/render/interaction/initialCamera'
import { buildBlockMesh } from '@/render/mesh/blockMesh'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'

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
 * 导出时间的**唯一**归一入口（导出时间可固定可重现；SPEC.md:113）。
 *
 * - 缺省（`undefined`）= **0 秒**，与改造前"帧偏移 0"逐位一致（负对照 C3 钉这条）；
 * - 非有限数 / 非 number ⇒ **抛**，不静默当 0（把"写了 NaN"伪装成"t=0"正是要防的）；
 * - 负数**允许**：采样器对负时间取模（`domain/materials.ts#sampleStripFrameAt`），
 *   钳制它会制造第二种语义。
 */
export function normalizeIsoSeconds(raw: unknown): number {
  if (raw === undefined) return 0
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(`等轴导出的时间不是有限数：${String(raw)}`)
  }
  return raw
}

/**
 * 等轴烘焙的共享 stage：一个渲染器 + 一台正交相机 + 一个已建好的场景 + 材质库。
 *
 * ## 谁负责释放
 *
 * {@link IsometricStage.dispose} **幂等**，顺序固定：
 * 先 `built.dispose()`（几何/材质），再 `materialLibrary.dispose()`，再 `renderer.dispose()`。
 * 这与改造前 `bakeIsometricStructurePngDataUrl` 的 `built.dispose()` + `finally` 两段合并一致。
 *
 * ## 为什么把 stage 抽出来（M5-4）
 *
 * 场景 GIF 必须与 PNG **同一条**烘焙链（同相机/同尺寸/同材质库）：
 * 共享 stage 让"GIF 第 k 帧"与"同 seconds 的 PNG"从结构上就是同一张图。
 *
 * ⚠️ （M6-2/M6-3 更正）原文"呈现链会把整条竖帧贴图压到一个面上"**已过时**：
 * `presentation/presenter.ts` 自 M5-3 起按场景时间写 `repeat.y = 1/N` 与 `offset.y`，
 * 见 `textureBinding.ts`（唯一采样入口 `sampleBoundTexture`）与 `composition/seams.ts` 的
 * `isometric-export-legacy-bake`（登记面已承认该采样落地）。
 * 维持本 stage 的**当下**真实理由是：离屏链的**纹理域尚未接线**
 * （`offscreenRenderPort` 不调 `bindTextures`；设备自建的 `TexturePort` 只进 acquisition、不进会话），
 * 经它出的图会**没有任何贴图**（`presenter.ts` 的材质走中性色）。
 * ⇒ M6-3 的切换前置是"三处接线 + 采样面判据"，不是"补裁切"。
 */
export interface IsometricStage {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly ortho: THREE.OrthographicCamera
  readonly group: THREE.Group
  readonly materialLibrary: MaterialLibraryApi
  dispose(): void
}

/**
 * 建一个可复用的等轴烘焙 stage。
 *
 * @param directionIndex 0..3，对应 {@link ISOMETRIC_EXPORT_YAW_DEG}
 * @param options.seconds 场景秒数（缺省 0；非法值抛）——在**建库之后、任何 render 之前**
 *   写一次；GIF 逐帧再调 `materialLibrary.setSceneTime`。
 */
export async function openIsometricStage(
  document: unknown,
  directionIndex: number,
  options?: { pixelSize?: number; seconds?: number },
): Promise<IsometricStage> {
  const size = Math.max(64, Math.min(1024, options?.pixelSize ?? 480))
  const dirIdx = ((Math.floor(directionIndex) % 4) + 4) % 4
  const yawDeg = ISOMETRIC_EXPORT_YAW_DEG[dirIdx] ?? 45
  const seconds = normalizeIsoSeconds(options?.seconds)

  const materialLibrary = await buildMaterialLibrary(document)
  // 时间只在**一处**赋值（M5-4）：`setSceneTime` 是无状态纯映射
  // （`simpleMaterialLibrary`：sampleStripFrameAt → 写 tex.offset.y），
  // 调用时机只要求在 `renderer.render` 之前；放在建库之后使"这一库的时间"只有一处赋值。
  materialLibrary.setSceneTime(seconds)
  const { definition } = resolveRenderBundle({ document })
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  })

  const scene = new THREE.Scene()
  scene.background = null
  const pivot = new THREE.Group()
  let built: Awaited<ReturnType<typeof buildBlockMesh>> | null = null
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    pivot.removeFromParent()
    built?.dispose()
    materialLibrary.dispose()
    renderer.dispose()
  }

  try {
    built = await buildBlockMesh(definition, materialLibrary, {
      layerPreview: 'all',
    })

    renderer.setSize(size, size)
    renderer.setPixelRatio(1)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setClearColor(0x000000, 0)

    const ambient = new THREE.AmbientLight(0xffffff, 0.55)
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.9)
    dirLight.position.set(6, 10, 8)
    scene.add(ambient, dirLight)

    /** 根 pivot：将内容 AABB 中心平移到世界原点，轨道目标恒为原点（即原 AABB 中心） */
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
    /** 世界原点 = 未平移前 mesh 的 AABB 中心 */
    const target = new THREE.Vector3(0, 0, 0)
    applyDiagonalOrbitView(persp, target, {
      distance: dist,
      yawDeg,
      elevationFromHorizontalDeg: STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG,
    })
    persp.updateProjectionMatrix()

    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, maxDim * 100)
    ortho.position.copy(persp.position)
    ortho.quaternion.copy(persp.quaternion)
    ortho.up.copy(persp.up)
    ortho.updateMatrixWorld(true)
    fitOrthographicCameraToBox(ortho, boxForFrustum)

    return { renderer, scene, ortho, group, materialLibrary, dispose }
  } catch (e) {
    dispose()
    throw e
  }
}

/**
 * 等轴 PNG 的**唯一**生产入口（M5-4：`seconds` 显式时间）。
 *
 * @param directionIndex 0..3，对应 {@link ISOMETRIC_EXPORT_YAW_DEG}
 * @param options.seconds 场景秒数（缺省 0；`normalizeIsoSeconds` 是唯一归一入口）
 */
export async function bakeIsometricStructurePngDataUrl(
  document: unknown,
  directionIndex: number,
  options?: { pixelSize?: number; seconds?: number },
): Promise<string> {
  const stage = await openIsometricStage(document, directionIndex, options)
  try {
    stage.renderer.render(stage.scene, stage.ortho)
    return stage.renderer.domElement.toDataURL('image/png')
  } finally {
    stage.dispose()
  }
}
