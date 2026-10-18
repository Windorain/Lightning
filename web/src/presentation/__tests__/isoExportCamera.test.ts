/**
 * **M6-3 判据：等轴四向 = 四个固定 `CameraSpec` 值**（纯层，无 GL）。
 *
 * ## 本文件钉什么
 *
 * | 判据 | 断言 |
 * |---|---|
 * | 常量同源 | `STANDARD_ISOMETRIC_ELEVATION_DEG` 与 `render/interaction/initialCamera` 的常量**逐位相等**（值不漂移） |
 * | 四向是四个值 | 四份 `CameraSpec` 两两不同，且相邻方位角相差 90° |
 * | **正交盒精确复现 legacy** | 用 `threeCameraOf` 构造真相机，把 AABB 八个角投影到视空间：`half = max|px|,|py| * padding` 与相机的 `(top-bottom)/2` **逐位相等**（结构性证明，不是拟合） |
 * | 盒心在视轴原点 | 投影盒的 `cx/cy` ≈ 0（目标点 = AABB 中心 ⇒ 与 legacy 的 pivot 平移等价） |
 * | near/far 包住内容 | 八个角的视空间深度全部落在 `(near, far)` 内（保守值不得切内容） |
 * | **负对照** | padding 改变 ⇒ half 必须变（判据不是恒真）；`directionIndex` 越界 ⇒ 显式抛出（不静默夹取） |
 *
 * ## 为什么用 `threeCameraOf` 而不是自己再算一遍
 *
 * "值可以表达同一取景"这句话的**唯一**证据是：**真正要用的那个映射函数**
 * （`presentation/offscreenCamera#threeCameraOf`）吃下这份值后得到的盒，恰好等于
 * legacy 的盒。若判据自己用另一套公式算盒，那就只是"两个公式一致"，与实现无关。
 */
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  ISO_EXPORT_FOV_DEGREES,
  ISO_EXPORT_ORTHO_PADDING,
  ISOMETRIC_EXPORT_YAW_DEG,
  STANDARD_ISOMETRIC_ELEVATION_DEG,
  isoCameraSpecOf,
  isoCameraSpecsOf,
} from '@/presentation/isoExportCamera'
import { threeCameraOf } from '@/presentation/offscreenCamera'
import { STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG } from '@/render/interaction/initialCamera'
import type { IsoExportBounds } from '@/presentation/isoExportCamera'

const BOUNDS: IsoExportBounds = Object.freeze({
  min: Object.freeze([-3, -2, -5]) as readonly [number, number, number],
  max: Object.freeze([7, 4, 1]) as readonly [number, number, number],
})

/** 视空间里的盒（与 legacy `fitOrthographicCameraToBox` 同一手法：`matrixWorldInverse` 投八角）。 */
function viewBox(spec: ReturnType<typeof isoCameraSpecOf>, bounds: IsoExportBounds): {
  cx: number
  cy: number
  halfX: number
  halfY: number
  minDepth: number
  maxDepth: number
} {
  const camera = threeCameraOf(spec, { width: 64, height: 64 })
  const p = new THREE.Vector3()
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
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
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    halfX: (maxX - minX) / 2,
    halfY: (maxY - minY) / 2,
    // 视空间 z 为负向前 ⇒ 深度 = -z
    minDepth: -maxZ,
    maxDepth: -minZ,
  }
}

describe('M6-3 · 等轴四向取景是值', () => {
  it('常量同源：仰角与 legacy/initialCamera 逐位相等', () => {
    expect(STANDARD_ISOMETRIC_ELEVATION_DEG).toBe(STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG)
    expect([...ISOMETRIC_EXPORT_YAW_DEG]).toEqual([45, 135, 225, 315])
    expect(ISO_EXPORT_FOV_DEGREES).toBe(45)
    expect(ISO_EXPORT_ORTHO_PADDING).toBe(1.08)
  })

  it('四向是四个**不同的值**，相邻方位角差 90°（不是"一个值 + 运行时方向"）', () => {
    const [a, b, c, d] = isoCameraSpecsOf({ bounds: BOUNDS })
    const all = [a, b, c, d]
    expect(all.every((s) => s.projection === 'orthographic')).toBe(true)
    expect(new Set(all.map((s) => JSON.stringify(s))).size).toBe(4)
    const target = a!.target
    const horizontal = all.map((s) => {
      const dx = s.position.x - target.x
      const dz = s.position.z - target.z
      return (Math.atan2(dx, dz) * 180) / Math.PI
    })
    for (let i = 0; i < 4; i += 1) {
      const diff = ((horizontal[(i + 1) % 4]! - horizontal[i]! + 360) % 360)
      expect(diff, '相邻方向必须相差 90°（实得 ' + String(diff) + '）').toBeCloseTo(90, 6)
    }
    // 目标点 = AABB 中心（不再平移场景）
    expect(target).toEqual({ x: 2, y: 1, z: -2 })
  })

  it('**正交盒精确复现 legacy 的 half = max(halfX, halfY) * padding**（逐位）', () => {
    for (let index = 0; index < 4; index += 1) {
      const spec = isoCameraSpecOf({ bounds: BOUNDS, directionIndex: index })
      const vb = viewBox(spec, BOUNDS)
      const camera = threeCameraOf(spec, { width: 64, height: 64 }) as THREE.OrthographicCamera
      const halfHeight = (camera.top - camera.bottom) / 2
      const legacyHalf = Math.max(vb.halfX * ISO_EXPORT_ORTHO_PADDING, vb.halfY * ISO_EXPORT_ORTHO_PADDING, 1e-4)
      expect(halfHeight, '方向 ' + String(index) + '：盒半高必须等于 legacy 的 half').toBeCloseTo(legacyHalf, 9)
      // 盒心在视轴上（legacy 的 cx/cy 恒 0，因为 pivot 把 AABB 中心搬到原点）
      expect(Math.abs(vb.cx)).toBeLessThan(1e-9)
      expect(Math.abs(vb.cy)).toBeLessThan(1e-9)
      // near/far 必须包住全部角点
      expect(camera.near).toBeLessThan(vb.minDepth)
      expect(camera.far).toBeGreaterThan(vb.maxDepth)
      // 对角在画幅内（否则"包住内容"只是 near/far 的局部事实）
      const ndc = new THREE.Vector3()
      for (const x of [BOUNDS.min[0], BOUNDS.max[0]]) {
        for (const y of [BOUNDS.min[1], BOUNDS.max[1]]) {
          for (const z of [BOUNDS.min[2], BOUNDS.max[2]]) {
            ndc.set(x, y, z).project(camera)
            expect(Math.abs(ndc.x)).toBeLessThanOrEqual(1)
            expect(Math.abs(ndc.y)).toBeLessThanOrEqual(1)
          }
        }
      }
    }
  })

  it('**负对照**：padding 改变 ⇒ 盒必须变（判据不是恒真）；方向越界 ⇒ 显式抛出', () => {
    const base = isoCameraSpecOf({ bounds: BOUNDS, directionIndex: 0 })
    const wider = isoCameraSpecOf({ bounds: BOUNDS, directionIndex: 0, padding: 2.16 })
    const baseHalf = (threeCameraOf(base, { width: 64, height: 64 }) as THREE.OrthographicCamera)
    const widerHalf = (threeCameraOf(wider, { width: 64, height: 64 }) as THREE.OrthographicCamera)
    expect(widerHalf.top - widerHalf.bottom).toBeGreaterThan((baseHalf.top - baseHalf.bottom) * 1.5)
    expect(() => isoCameraSpecOf({ bounds: BOUNDS, directionIndex: 4 })).toThrow()
    expect(() => isoCameraSpecOf({ bounds: BOUNDS, directionIndex: -1 })).toThrow()
  })

  it('空包围盒 ⇒ legacy 的 ±5 盒（不产出 NaN 相机）', () => {
    const empty = isoCameraSpecOf({
      bounds: { min: [0, 0, 0], max: [-1, -1, -1] },
      directionIndex: 0,
    })
    const camera = threeCameraOf(empty, { width: 64, height: 64 }) as THREE.OrthographicCamera
    expect((camera.top - camera.bottom) / 2).toBeCloseTo(5, 9)
    expect(camera.near).toBeCloseTo(0.1, 12)
    expect(camera.far).toBeCloseTo(500, 12)
    expect(Number.isNaN(camera.matrixWorld.elements[0])).toBe(false)
  })
})
