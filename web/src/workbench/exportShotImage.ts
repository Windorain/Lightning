/**
 * 离屏 WebGL：**任意正交机位**出图（PNG Data URL）。
 *
 * 与 `exportIsometricImage.ts` 的分工：
 *  - `exportIsometricImage`：固定四向等轴 + 自动 AABB 贴合（≤1024 正方），供工作台「等轴 PNG」按钮；
 *  - 本文件：机位**完全由调用方给定**（落点 / 方位 / 仰角 / 正交全高 / 任意分辨率），不自动贴合，
 *    用于「SDE 结构 JSON → 与游戏内控制面 CameraSpec 同机位」的验收出图（#87 §2.2 三对齐）。
 *
 * 坐标系：内容按 `render/mesh/quadGeometry.ts` 的约定居中于原点（网格 w/h/d 居中），
 * 故**结构中心恒为世界原点**；调用方给出的 `spec.pos` 是 web 局部系**相机落点**
 * （= MC 世界坐标 − 结构中心），相机朝原点看（`elevationDeg` 即由落点相对中心的仰角表达）。
 *
 * 材质为 `MeshBasicMaterial`（见 `render/materials`），光照无效 → 不加灯。
 */

import * as THREE from 'three'

import { buildMaterialLibrary } from '@/render/data/buildMaterialLibrary'
import { resolveRenderBundle } from '@/render/data/bundleResolve'
import { buildBlockMesh } from '@/render/mesh/blockMesh'
import { fitOrthoDepthToBox, setSymmetricOrthoFrustum } from '@/render/viewport/orthoFrustum'

export type { ShotCameraSpec } from '@/pure/mcShotCamera'
import type { ShotCameraSpec } from '@/pure/mcShotCamera'

/** 默认底色：不透明天空蓝。透明底会在「目检非空白」时被当成纯黑/杂物。 */
export const SHOT_DEFAULT_BACKGROUND = 0x9ec6e8

export interface BakeShotPngOptions {
  /** 不透明底色（0xRRGGBB）；缺省 {@link SHOT_DEFAULT_BACKGROUND} */
  background?: number
}

/**
 * 以 `spec` 指定的正交机位离屏渲染当前文档 → PNG Data URL。
 *
 * @param document 渲染管线输入（`RuntimeDocument.serialize()` 的产物；
 *                 `textureBlobs` / `materialPalette` 必须随文档带出，否则贴图缺失）
 * @param spec     web 口径机位（MC 口径请先经 `pure/mcShotCamera.ts#mcSpecToShotCamera` 换算）
 */
export async function bakeShotPngDataUrl(
  document: unknown,
  spec: ShotCameraSpec,
  options?: BakeShotPngOptions,
): Promise<string> {
  const { width, height } = spec
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`出图分辨率无效：width=${width} height=${height}`)
  }
  if (!Number.isFinite(spec.orthoHeight) || spec.orthoHeight <= 0) {
    throw new Error(`正交全高无效：orthoHeight=${spec.orthoHeight}`)
  }

  const materialLibrary = await buildMaterialLibrary(document)
  const { definition } = resolveRenderBundle({ document })
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true,
  })

  try {
    const built = await buildBlockMesh(definition, materialLibrary, {
      layerPreview: 'all',
    })

    renderer.setPixelRatio(1)
    renderer.setSize(width, height)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setClearColor(options?.background ?? SHOT_DEFAULT_BACKGROUND, 1)

    const scene = new THREE.Scene()

    /** 根 pivot：把内容 AABB 中心平移到世界原点，使 target 恒为原点 */
    const pivot = new THREE.Group()
    scene.add(pivot)
    const group = built.group
    pivot.add(group)

    group.updateMatrixWorld(true)
    const contentAabb = new THREE.Box3().setFromObject(group)
    /** 内容尺寸（未平移前；也用于「落点离中心太近」的退化守卫） */
    const contentSizeVec = contentAabb.isEmpty() ? new THREE.Vector3() : contentAabb.getSize(new THREE.Vector3())
    const maxDim = Math.max(contentSizeVec.x, contentSizeVec.y, contentSizeVec.z, 1e-6)

    if (!contentAabb.isEmpty()) {
      const aabbCenter = new THREE.Vector3()
      contentAabb.getCenter(aabbCenter)
      pivot.position.copy(aabbCenter).negate()
    }
    pivot.updateMatrixWorld(true)

    /** 平移后的内容 AABB（世界系 = pivot 空间）——near/far 由它给，避免裁切 */
    const boxForFrustum = new THREE.Box3().setFromObject(group)

    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, Math.max(1000, maxDim * 100))
    setSymmetricOrthoFrustum(ortho, width / height, spec.orthoHeight / 2)
    ortho.zoom = 1

    /**
     * 摆位（#87 §2.2 三对齐）：web 局部系里**结构已被 pivot 平移到世界原点**，
     * 故「结构中心」恒为 `(0,0,0)`；`spec.pos` 是**相机落点**（MC 世界坐标 − 结构中心）。
     *
     * 本实现 = **相机落在 `spec.pos`，朝向结构中心**。三条口径同时成立：
     *  1. 落点精确等于调用方给的 `spec.pos`（控制面 CameraSpec 的 `pos` 语义）；
     *  2. 视线方向 = `normalize(−spec.pos)`，即「看向结构中心」；
     *  3. 正交视锥对称展开且以目标为中心 ⇒ 结构恒居中，任意 yaw/elevation 都不出画。
     *
     * 与任务书 `target = pos + d·10` 的关系：`lookAt(target)` 的方向 = `normalize(target − cameraPos)`；
     * 相机在 `spec.pos` 时它等于 `normalize(−spec.pos)`——与「取 `d = normalize(−spec.pos)`、
     * `target = pos + d·10`」**完全等价**（由 `pure/mcShotCamera.ts` 的换算保证 `d` 就是该方向）。
     * 因此这里直接写 `lookAt(原点)`，少一层易错的距离中间量。
     *
     * ⚠️ 实测反例（为何不逐字照抄任务书的 `applyDiagonalOrbitView(target = pos + d·10)`）：
     * 该调用的落点自带 `target − d·distance`，于是相机实际落在 `pos` 沿视线的**另一侧**、
     * 且 `lookAt` 目标不在结构上。对 `spec.pos=(0,0,30)`、elevation=10° 的实测：
     * 世界原点被投到 NDC y ≈ +0.868（贴画面顶端第 47 行 / 720）；`orthoHeight=4` 时结构
     * **完全出画**（非空像素 0），而本实现同一机位为 5064 非空像素、结构中心落在第 359.5 行。
     */
    ortho.position.set(spec.pos.x, spec.pos.y, spec.pos.z)
    const structureCenter = new THREE.Vector3(0, 0, 0)
    /**
     * 退化守卫：落点几乎在结构中心时，`lookAt` 方向未定义（内容 AABB 已平移到原点），
     * 出图必然空白——显式报错，别让调用方拿到一张不知为何空白的图。
     */
    const posRadius = ortho.position.length()
    if (posRadius < 1e-3) {
      throw new Error(
        `机位落点退化：pos=(${ortho.position.toArray().join(', ')}) 距结构中心 ${posRadius.toExponential(2)}，` +
          'lookAt 方向未定义。请检查 MC 侧 CameraSpec.pos 与 center 是否配套（pos 不应等于 center）。',
      )
    }
    ortho.up.set(0, 1, 0)
    ortho.lookAt(structureCenter)
    ortho.updateMatrixWorld(true)

    /** 自检 1：相机落点必须 = 给定落点 */
    const expectedCameraPos = new THREE.Vector3(spec.pos.x, spec.pos.y, spec.pos.z)
    if (ortho.position.distanceTo(expectedCameraPos) > 1e-6) {
      throw new Error(
        `机位摆位自检失败：yaw=${spec.yawDeg} elevation=${spec.elevationDeg} ` +
          `期望相机在 (${expectedCameraPos.toArray().join(', ')})，实际在 (${ortho.position.toArray().join(', ')})`,
      )
    }
    /** 自检 2：视线必须指向结构中心（正交下这是「结构居中」的充要条件） */
    const aim = new THREE.Vector3()
    ortho.getWorldDirection(aim)
    const aimExpected = structureCenter.clone().sub(ortho.position).normalize()
    if (aim.dot(aimExpected) < 1 - 1e-6) {
      throw new Error(
        `机位视线自检失败：yaw=${spec.yawDeg} elevation=${spec.elevationDeg} ` +
          `期望看向 (0, 0, 0)，实际视线=(${aim.toArray().join(', ')})`,
      )
    }
    ortho.updateMatrixWorld(true)

    /**
     * near/far 由内容 AABB **向外**包住（见 {@link fitOrthoDepthToBox}）。
     *
     * ⚠️ 这里曾是 #87「ortho-north 只出孤立一枚」的根因：内联写法把近平面放到最近点**之后**
     * （`-maxZ + zEps`），而轴对齐机位的贴面整面恰好落在最近点平面上 ⇒ 最前一层被整面裁掉。
     * north 机位下被裁的正是横排 5 格唯一朝向相机的 -z 面 ⇒ 整排消失。已改为共用带正确
     * 符号的 helper，并由 `orthoFrustum.test.ts` 钉住「box 八角不得被裁」。
     */
    fitOrthoDepthToBox(ortho, boxForFrustum)

    renderer.render(scene, ortho)

    const dataUrl = renderer.domElement.toDataURL('image/png')

    pivot.removeFromParent()
    built.dispose()

    return dataUrl
  } finally {
    renderer.dispose()
    materialLibrary.dispose()
  }
}
