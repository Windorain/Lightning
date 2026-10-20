/**
 * `presentation/shotCamera` 单测 —— **验收器具的显式正交机位 + #87 ortho-north 不变式**。
 *
 * ## 这条判据钉的是什么
 *
 * #87 的 `ortho-north` 曾只画出孤立一枚、整排 5 格消失。根因不是几何/合面/贴图，而是
 * **近平面符号写反**：旧写法 `near = -maxZ + ε` 把近平面放到内容 AABB 最近点**之后**，
 * 而轴对齐机位的贴面**整面**恰好落在最近点那个平面上 ⇒ 最前一层被整面裁掉。
 *
 * 该缺陷的修复在分支上是 `render/viewport/orthoFrustum#fitOrthoDepthToBox`；合并到新内核后，
 * 导出链的裁剪面政策**只有一处**（`presentation/isoExportCamera#clipPlanesAroundBounds`），
 * 本文件因此把不变式改锚在**新内核实际使用的那个函数**上：
 *
 *  - `shotCameraSpecOf` 产出的 `CameraSpec` 经**真正要用的**映射
 *    （`presentation/offscreenCamera#threeCameraOf`）构造相机；
 *  - 断言内容 AABB 的**八个角全部落在视锥内**（一个都不许被裁）；
 *  - 负对照：把 near 改回 `nearest + ε`（= 修复前的形态）⇒ 该机位的贴面四角必须被裁。
 *
 * 另外钉住"正交全高进入内核口径"的**结构性**换算：`fov = 2·atan((orthoHeight/2)/d)`
 * ⇒ `threeCameraOf` 给出的盒半高恰为 `orthoHeight/2`（逐位），不是拟合。
 */
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'

import { threeCameraOf } from '@/presentation/offscreenCamera'
import { SHOT_MIN_DISTANCE, shotCameraSpecOf, type ShotPlacement } from '@/presentation/shotCamera'
import type { IsoExportBounds } from '@/presentation/isoExportCamera'
import type { CameraSpec } from '@/domain/captureSpec'

const WIDTH = 1280
const HEIGHT = 720
/** #87 六机位共用 orthoHeight（cameras.json）。 */
const ORTHO_HEIGHT = 6

/**
 * #87 复现场景的内容 AABB（web 世界系）：横排 5 格 + 孤立枚，
 * MC 内容 AABB = x[64,69) y[12,13) z[64,67)，中心 (66.5,12.5,65.5)。
 */
const CONTENT_BOX: IsoExportBounds = Object.freeze({
  min: Object.freeze([-2.5, -0.5, -1.5]) as readonly [number, number, number],
  max: Object.freeze([2.5, 0.5, 1.5]) as readonly [number, number, number],
})

/** #87 六机位在结构相对口径下的落点（MC pos − center）。 */
const SHOT_OFFSETS: Record<string, readonly [number, number, number]> = {
  'ortho-south': [0, 0, 8],
  'ortho-north': [0, 0, -8],
  'ortho-east': [8, 0, 0],
  'ortho-west': [-8, 0, 0],
  'ortho-top': [0, 8, 0.5],
  'ortho-iso': [-6.124, 5, 6.124],
}

function specOf(offset: readonly [number, number, number], orthoHeight = ORTHO_HEIGHT): CameraSpec {
  const r = shotCameraSpecOf(CONTENT_BOX, { offset, orthoHeight })
  if (!r.ok) throw new Error('shotCameraSpecOf 失败：' + r.error.code + ' ' + JSON.stringify(r.error.params))
  return r.value
}

function orthoCameraOf(spec: CameraSpec, width = WIDTH, height = HEIGHT): THREE.OrthographicCamera {
  return threeCameraOf(spec, { width, height }) as THREE.OrthographicCamera
}

function boxCorners(box: IsoExportBounds): THREE.Vector3[] {
  const out: THREE.Vector3[] = []
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) out.push(new THREE.Vector3(x, y, z))
    }
  }
  return out
}

/** 当前投影矩阵下落在视锥外的 AABB 角（空数组 = 内容一个角都没被裁）。 */
function clippedCorners(cam: THREE.Camera, box: IsoExportBounds): number[][] {
  const clip = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
  const frustum = new THREE.Frustum().setFromProjectionMatrix(clip)
  return boxCorners(box)
    .filter((p) => !frustum.containsPoint(p))
    .map((p) => [p.x, p.y, p.z])
}

/** 视空间深度（与 `clipPlanesAroundBounds` 同一手法：matrixWorldInverse 投八角）。 */
function depthExtents(cam: THREE.Camera, box: IsoExportBounds): { nearest: number; farthest: number } {
  const p = new THREE.Vector3()
  let minZ = Infinity
  let maxZ = -Infinity
  for (const c of boxCorners(box)) {
    p.copy(c).applyMatrix4(cam.matrixWorldInverse)
    if (p.z < minZ) minZ = p.z
    if (p.z > maxZ) maxZ = p.z
  }
  return { nearest: -maxZ, farthest: -minZ }
}

describe('shotCameraSpecOf · #87 六机位：内容 AABB 八角全部落在视锥内', () => {
  it('六机位逐台（north/south/east/west/top/iso）：一个角都不许被裁', () => {
    for (const [name, offset] of Object.entries(SHOT_OFFSETS)) {
      const spec = specOf(offset)
      const cam = orthoCameraOf(spec)
      expect(clippedCorners(cam, CONTENT_BOX), name + ' offset=' + JSON.stringify(offset)).toEqual([])
    }
  })

  it('ortho-north：近平面必须落在最近面**之前**（整排消失的直接判据）', () => {
    const cam = orthoCameraOf(specOf(SHOT_OFFSETS['ortho-north']!))
    const { nearest, farthest } = depthExtents(cam, CONTENT_BOX)
    // 内容最近点距离 = 6.5（横排 -z 面），最远点 = 9.5
    expect(nearest).toBeCloseTo(6.5, 9)
    expect(farthest).toBeCloseTo(9.5, 9)
    expect(cam.near, '近平面必须在最近面之前（更靠近相机）').toBeLessThan(nearest)
    expect(cam.far, '远平面必须在最远面之后').toBeGreaterThan(farthest)
    // 横排 -z 面（贴面整面）在视锥内 → 不会被裁
    expect(clippedCorners(cam, CONTENT_BOX)).toEqual([])
  })

  it('**负对照**：旧公式 `nearest + ε` 必然裁掉贴面整面（符号再写反即此用例变红）', () => {
    const cam = orthoCameraOf(specOf(SHOT_OFFSETS['ortho-north']!))
    const { nearest, farthest } = depthExtents(cam, CONTENT_BOX)
    const zEps = 1e-2
    cam.near = Math.max(0.01, nearest + zEps) // 旧实现：-maxZ + ε
    cam.far = Math.max(cam.near + 0.02, farthest + zEps)
    cam.updateProjectionMatrix()

    const clipped = clippedCorners(cam, CONTENT_BOX)
    // 横排所在的四个角（z = -1.5，即朝向 north 相机的贴面）全部被裁 ⇒ 整排消失
    expect(clipped).toHaveLength(4)
    expect(clipped.every((c) => c[2] === -1.5), JSON.stringify(clipped)).toBe(true)
  })
})

describe('shotCameraSpecOf · 正交全高进入内核口径（结构性换算，不是拟合）', () => {
  it('盒半高逐位等于 orthoHeight/2（6 → 3；12 → 6）', () => {
    for (const orthoHeight of [6, 12, 4.5]) {
      const cam = orthoCameraOf(specOf([0, 0, 8], orthoHeight))
      const halfHeight = (cam.top - cam.bottom) / 2
      expect(halfHeight, 'orthoHeight=' + String(orthoHeight)).toBeCloseTo(orthoHeight / 2, 9)
    }
  })

  it('任意分辨率：盒宽 = 盒高 × 宽高比（不强制正方、不 clamp）', () => {
    const spec = specOf([0, 0, 8])
    for (const [w, h] of [[1280, 720], [720, 1280], [1025, 3]] as const) {
      const cam = orthoCameraOf(spec, w, h)
      const halfHeight = (cam.top - cam.bottom) / 2
      const halfWidth = (cam.right - cam.left) / 2
      expect(halfWidth, w + 'x' + h).toBeCloseTo(halfHeight * (w / h), 9)
    }
  })

  it('落点与视线：position = 内容中心 + offset，target = 内容中心，视线指向中心', () => {
    const offset: readonly [number, number, number] = [-6.124, 5, 6.124]
    const spec = specOf(offset)
    expect(spec.position.x).toBeCloseTo(offset[0], 9)
    expect(spec.position.y).toBeCloseTo(offset[1], 9)
    expect(spec.position.z).toBeCloseTo(offset[2], 9)
    expect(spec.target).toEqual({ x: 0, y: 0, z: 0 })

    const cam = orthoCameraOf(spec)
    const aim = new THREE.Vector3()
    cam.getWorldDirection(aim)
    const expected = new THREE.Vector3(-offset[0], -offset[1], -offset[2]).normalize()
    expect(aim.dot(expected)).toBeCloseTo(1, 9)
  })

  it('内容不居中时（内核**不**平移内容）：target 仍是包围盒中心，落点相对它偏移', () => {
    const far: IsoExportBounds = Object.freeze({
      min: Object.freeze([10, 20, 30]) as readonly [number, number, number],
      max: Object.freeze([16, 22, 33]) as readonly [number, number, number],
    })
    const r = shotCameraSpecOf(far, { offset: [0, 0, 8], orthoHeight: 6 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.target).toEqual({ x: 13, y: 21, z: 31.5 })
    expect(r.value.position.x).toBeCloseTo(13, 9)
    expect(r.value.position.y).toBeCloseTo(21, 9)
    expect(r.value.position.z).toBeCloseTo(39.5, 9)
    expect(clippedCorners(orthoCameraOf(r.value), far)).toEqual([])
  })
})

describe('shotCameraSpecOf · 不可表达的机位显式失败（不静默夹取）', () => {
  const failureOf = (placement: ShotPlacement): { code: string; reason: unknown } => {
    const r = shotCameraSpecOf(CONTENT_BOX, placement)
    if (r.ok) throw new Error('期望失败，实际成功')
    return { code: r.error.code, reason: r.error.params.reason }
  }

  it('落点贴到内容中心（视线方向未定义）⇒ shotOffsetDegenerate', () => {
    expect(failureOf({ offset: [0, 0, 0], orthoHeight: 6 }).reason).toBe('shotOffsetDegenerate')
    expect(failureOf({ offset: [0, SHOT_MIN_DISTANCE / 2, 0], orthoHeight: 6 }).reason).toBe(
      'shotOffsetDegenerate',
    )
  })

  it('正交全高非正/非有限 ⇒ shotOrthoHeightInvalid', () => {
    for (const orthoHeight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(failureOf({ offset: [0, 0, 8], orthoHeight }).reason).toBe('shotOrthoHeightInvalid')
    }
  })

  it('落点含非有限分量 ⇒ shotOffsetInvalid', () => {
    expect(failureOf({ offset: [0, Number.NaN, 8], orthoHeight: 6 }).reason).toBe('shotOffsetInvalid')
  })

  it('空/非法包围盒 ⇒ shotBoundsEmpty（不产出一台"看得见什么"的相机）', () => {
    const r = shotCameraSpecOf({ min: [0, 0, 0], max: [-1, -1, -1] }, { offset: [0, 0, 8], orthoHeight: 6 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.params.reason).toBe('shotBoundsEmpty')
  })

  it('正交全高与落点距离不自洽（视场角贴到 180°）⇒ shotFramingNotExpressible', () => {
    // 半高 500 / 距离 0.001 ⇒ fov ≈ 179.9998°，`threeCameraOf` 的 <180° 夹取会让盒变小
    const r = shotCameraSpecOf(CONTENT_BOX, { offset: [0, 0, 0.001], orthoHeight: 1000 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.params.reason).toBe('shotFramingNotExpressible')
  })
})
