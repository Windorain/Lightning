/**
 * 裁剪面必须**包住**内容：near 落在最近表面之前、far 落在最远表面之后。
 *
 * 回归的缺陷（实测）：`near = -maxZ + zEps` 把近平面放在**最近表面之内** 1 cm，
 * 正交轴视图下被裁掉的正是"朝向相机的可见面"；剩下的侧棱面积为 0、背面被背面剔除
 * ⇒ 整幅空白（验收里 front/bottom 内容比 0.00）。
 *
 * 判据形状：把内容包围盒的 8 个角点投到视空间，断言每个角点的深度都落在 [near, far] 内。
 * 比"near 是否等于某公式"更稳——公式可以改，包住内容这条不许破。
 */
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { fitOrthoFrustumToWorldBox, syncClipPlanesToGroup } from '@/render/interaction/initialCamera'

function cameraAt(distance: number, axis: 'z' | 'x' | 'y' = 'z'): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-8, 8, 5, -5, 0.1, 100)
  if (axis === 'z') cam.position.set(0, 0, distance)
  if (axis === 'x') cam.position.set(distance, 0, 0)
  if (axis === 'y') cam.position.set(0, distance, 0)
  cam.lookAt(0, 0, 0)
  cam.updateMatrixWorld(true)
  return cam
}

/** 盒角点在视空间的深度（正值 = 相机前方的距离）。 */
function depths(cam: THREE.OrthographicCamera, box: THREE.Box3): number[] {
  cam.updateMatrixWorld(true)
  const inv = cam.matrixWorldInverse
  const p = new THREE.Vector3()
  const out: number[] = []
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        p.set(x, y, z).applyMatrix4(inv)
        out.push(-p.z)
      }
    }
  }
  return out
}

describe('裁剪面包住内容', () => {
  const box = new THREE.Box3(new THREE.Vector3(-1.5, -1, -1), new THREE.Vector3(1.5, 1, 1))

  for (const axis of ['z', 'x', 'y'] as const) {
    it(`fitOrthoFrustumToWorldBox：${axis} 轴向每个角点都在 [near, far] 内`, () => {
      const cam = cameraAt(11, axis)
      fitOrthoFrustumToWorldBox(cam, box, 16 / 9, 1.06)
      const d = depths(cam, box)
      expect(Math.min(...d)).toBeGreaterThanOrEqual(cam.near - 1e-6)
      expect(Math.max(...d)).toBeLessThanOrEqual(cam.far + 1e-6)
    })

    it(`syncClipPlanesToGroup：${axis} 轴向每个角点都在 [near, far] 内`, () => {
      const cam = cameraAt(11, axis)
      const group = new THREE.Group()
      const size = new THREE.Vector3().subVectors(box.max, box.min)
      const center = new THREE.Vector3().addVectors(box.min, box.max).multiplyScalar(0.5)
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), new THREE.MeshBasicMaterial())
      mesh.position.copy(center)
      group.add(mesh)
      group.updateMatrixWorld(true)
      const changed = syncClipPlanesToGroup(cam, group)
      expect(changed).toBe(true)
      const d = depths(cam, box)
      expect(Math.min(...d)).toBeGreaterThanOrEqual(cam.near - 1e-6)
      expect(Math.max(...d)).toBeLessThanOrEqual(cam.far + 1e-6)
    })
  }
})
