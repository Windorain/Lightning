/**
 * `render/viewport/orthoFrustum#fitOrthoDepthToBox` 单测 —— **#87 ortho-north 回归锁**。
 *
 * 缺陷形态（#87 验收）：六机位出图里 5 台取景一致，唯独 `ortho-north`（轴对齐、相机在 -z 侧
 * 朝 +z 看）只画出孤立枚、整排 5 格消失。根因不是几何/合面/贴图，而是**近平面符号写反**：
 * `near = -maxZ + ε` 把近平面放到内容 AABB 最近点**之后**，而轴对齐机位的贴面**整面**恰好
 * 落在最近点那个平面上 ⇒ 最前一层被整面裁掉。north 机位下那层正是横排 5 格唯一朝向相机的
 * -z 面 ⇒ 整排消失；south 机位下被裁的是孤立枚的 +z 面（其全框 tile 消失）。
 *
 * 本文件把不变式钉死为：**内容 AABB 的 8 个角必须全部落在视锥内**（不得裁掉任何内容），
 * 并按 #87 真实六机位逐台验证；另附「旧公式必然裁角」的负对照，防止符号再次写反。
 */
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { fitOrthoDepthToBox, setSymmetricOrthoFrustum } from '@/render/viewport/orthoFrustum'

const WIDTH = 1280
const HEIGHT = 720
/** #87 六机位共用 orthoHeight（cameras.json） */
const ORTHO_HEIGHT = 6

/**
 * #87 复现场景的内容 AABB（pivot 居中后 · web 局部系）：
 * 横排 5 格 + 孤立枚，MC 内容 AABB = x[64,69) y[12,13) z[64,67)，中心 (66.5,12.5,65.5)。
 */
const CONTENT_BOX = new THREE.Box3(
  new THREE.Vector3(-2.5, -0.5, -1.5),
  new THREE.Vector3(2.5, 0.5, 1.5),
)

/** #87 六机位在 web 局部系的落点（MC pos − center，center=(66.5,12.5,65.5)）。 */
const SHOT_POSITIONS: Record<string, [number, number, number]> = {
  'ortho-south': [0, 0, 8],
  'ortho-north': [0, 0, -8],
  'ortho-east': [8, 0, 0],
  'ortho-west': [-8, 0, 0],
  'ortho-top': [0, 8, 0.5],
  'ortho-iso': [-6.124, 5, 6.124],
}

function shotCamera(pos: readonly [number, number, number]): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000)
  setSymmetricOrthoFrustum(cam, WIDTH / HEIGHT, ORTHO_HEIGHT / 2)
  cam.position.set(pos[0], pos[1], pos[2])
  cam.up.set(0, 1, 0)
  cam.lookAt(new THREE.Vector3(0, 0, 0))
  cam.updateMatrixWorld(true)
  return cam
}

function boxCorners(box: THREE.Box3): THREE.Vector3[] {
  const { min, max } = box
  const out: THREE.Vector3[] = []
  for (const x of [min.x, max.x]) {
    for (const y of [min.y, max.y]) {
      for (const z of [min.z, max.z]) out.push(new THREE.Vector3(x, y, z))
    }
  }
  return out
}

/** 当前投影矩阵下落在视锥外的 AABB 角（空数组 = 内容一个角都没被裁） */
function clippedCorners(cam: THREE.OrthographicCamera, box: THREE.Box3): number[][] {
  cam.updateMatrixWorld(true)
  const clip = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
  const frustum = new THREE.Frustum().setFromProjectionMatrix(clip)
  return boxCorners(box)
    .filter((p) => !frustum.containsPoint(p))
    .map((p) => [p.x, p.y, p.z])
}

/** 视空间最近/最远点距离（与实现同一套角点变换） */
function depthExtents(cam: THREE.OrthographicCamera, box: THREE.Box3): { nearest: number; farthest: number } {
  cam.updateMatrixWorld(true)
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

describe('fitOrthoDepthToBox：深度范围必须向外包住内容 AABB', () => {
  it('#87 六机位逐台：内容 AABB 八个角全部落在视锥内（一个都不许被裁）', () => {
    for (const [name, pos] of Object.entries(SHOT_POSITIONS)) {
      const cam = shotCamera(pos)
      fitOrthoDepthToBox(cam, CONTENT_BOX)
      expect(clippedCorners(cam, CONTENT_BOX), `${name} pos=${JSON.stringify(pos)}`).toEqual([])
    }
  })

  it('ortho-north：近平面必须落在最近面**之前**（north 整排消失的直接判据）', () => {
    const cam = shotCamera(SHOT_POSITIONS['ortho-north']!)
    const { nearest, farthest } = depthExtents(cam, CONTENT_BOX)
    // 内容最近点距离 = 6.5（横排 -z 面），最远点 = 9.5
    expect(nearest).toBeCloseTo(6.5, 9)
    expect(farthest).toBeCloseTo(9.5, 9)

    fitOrthoDepthToBox(cam, CONTENT_BOX)
    expect(cam.near, '近平面必须在最近面之前（更靠近相机）').toBeLessThan(nearest)
    expect(cam.far, '远平面必须在最远面之后').toBeGreaterThan(farthest)
    // 横排 -z 面（贴面整面）在视锥内 → 不会被裁
    expect(clippedCorners(cam, CONTENT_BOX)).toEqual([])
  })

  it('负对照：旧公式 `-maxZ + ε` 必然裁掉贴面整面（符号再写反即此用例变红）', () => {
    const cam = shotCamera(SHOT_POSITIONS['ortho-north']!)
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

  it('空 Box3 不改变相机（不做无意义收紧，也不抛错）', () => {
    const cam = shotCamera(SHOT_POSITIONS['ortho-north']!)
    const near = cam.near
    const far = cam.far
    fitOrthoDepthToBox(cam, new THREE.Box3())
    expect(cam.near).toBe(near)
    expect(cam.far).toBe(far)
  })

  it('相机落在内容内部时 near 仍为正（不产出非法投影矩阵）', () => {
    const cam = shotCamera([0, 0, 0])
    fitOrthoDepthToBox(cam, CONTENT_BOX)
    expect(cam.near).toBeGreaterThan(0)
    expect(cam.far).toBeGreaterThan(cam.near)
  })

  it('margin 参数化：外扩量越大，近平面越靠前（方向不可反）', () => {
    const a = shotCamera(SHOT_POSITIONS['ortho-east']!)
    const b = shotCamera(SHOT_POSITIONS['ortho-east']!)
    fitOrthoDepthToBox(a, CONTENT_BOX, 1e-2)
    fitOrthoDepthToBox(b, CONTENT_BOX, 1)
    expect(b.near).toBeLessThan(a.near)
    expect(b.far).toBeGreaterThan(a.far)
  })
})
