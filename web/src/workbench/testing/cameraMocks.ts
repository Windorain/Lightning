/**
 * 等轴相机 mock — 纯数学，无 Three.js 依赖。
 *
 * 对标生产环境的 fitIsometricOrbitToContentGroup + applyDiagonalOrbitView。
 * 相机参数固定但可根据场景尺寸自适应。
 */

import type { CameraParams } from './rayMath'
import { vec3 } from './rayMath'

/** 标准等轴俯仰角：atan(1/√2) ≈ 35.264° */
export const ISOMETRIC_ELEVATION_DEG = Math.atan(1 / Math.sqrt(2)) * (180 / Math.PI)

/** 正交视锥参考半 FOV（度），对标 ORTHO_FRUSTUM_REF_HALF_FOV_DEG = 25 */
const REF_HALF_FOV_DEG = 25

declare function degToRad(deg: number): number

function degToRadImpl(deg: number): number {
  return deg * (Math.PI / 180)
}

/** 球坐标 → 笛卡尔（三.js 约定：phi 从 Y 轴量，theta 从 Z 轴在 XZ 平面量） */
function sphericalToCartesian(distance: number, phi: number, theta: number) {
  return vec3(
    distance * Math.sin(phi) * Math.sin(theta),
    distance * Math.cos(phi),
    distance * Math.sin(phi) * Math.cos(theta),
  )
}

export interface IsometricCameraOptions {
  /** 视口尺寸 */
  viewportWidth?: number
  viewportHeight?: number
  /** 场景包围盒中心 */
  target?: { x: number; y: number; z: number }
  /** 方位角（度），默认 225（等轴经典视角） */
  yawDeg?: number
  /** 俯仰角（度），默认标准等轴 */
  elevationDeg?: number
  /** 强制覆盖距离（否则自动 fit） */
  distance?: number
  /** 场景包围盒尺寸（用于自动计算距离和视锥） */
  sceneMin?: { x: number; y: number; z: number }
  sceneMax?: { x: number; y: number; z: number }
}

/**
 * 创建等轴正交相机。
 *
 * 用法：
 *   const cam = createIsometricCamera({ sceneMin: {x:0,y:0,z:0}, sceneMax: {x:5,y:3,z:5} })
 *   const screen = worldToScreen({x:3,y:0,z:5}, cam)
 */
export function createIsometricCamera(opts: IsometricCameraOptions = {}): CameraParams {
  const vpW = opts.viewportWidth ?? 800
  const vpH = opts.viewportHeight ?? 600
  const yawDeg = opts.yawDeg ?? 225
  const elevDeg = opts.elevationDeg ?? ISOMETRIC_ELEVATION_DEG

  // 目标点：场景包围盒中心，或给定值
  let target = opts.target ?? vec3(0, 0, 0)
  let distance = opts.distance

  if (distance === undefined && opts.sceneMin && opts.sceneMax) {
    const sizeX = opts.sceneMax.x - opts.sceneMin.x
    const sizeY = opts.sceneMax.y - opts.sceneMin.y
    const sizeZ = opts.sceneMax.z - opts.sceneMin.z
    const maxDim = Math.max(sizeX, sizeY, sizeZ, 0.1)
    distance = Math.max(8, maxDim * 2.2)

    if (!opts.target) {
      target = vec3(
        (opts.sceneMin.x + opts.sceneMax.x) / 2,
        (opts.sceneMin.y + opts.sceneMax.y) / 2,
        (opts.sceneMin.z + opts.sceneMax.z) / 2,
      )
    }
  }

  const dist = distance ?? 15

  // 球坐标 → 相机位置
  const theta = degToRadImpl(yawDeg)
  const phi = Math.PI / 2 - degToRadImpl(elevDeg)
  const offset = sphericalToCartesian(dist, phi, theta)
  const position = {
    x: target.x + offset.x,
    y: target.y + offset.y,
    z: target.z + offset.z,
  }

  // 正交视锥高度（对标生产：2 * distance * tan(25°)）
  const orthoHeight = 2 * dist * Math.tan(degToRadImpl(REF_HALF_FOV_DEG))
  const aspect = vpW / Math.max(vpH, 1)
  const halfH = orthoHeight / 2

  return {
    position,
    target: { ...target },
    up: { x: 0, y: 1, z: 0 },
    left: -halfH * aspect,
    right: halfH * aspect,
    top: halfH,
    bottom: -halfH,
    near: 0.1,
    far: 500,
    viewportWidth: vpW,
    viewportHeight: vpH,
  }
}

/**
 * 从方块列表自动创建相机（自动 fit 所有方块）。
 */
export function createCameraForBlocks(
  blocks: Array<{ x: number; y: number; z: number }>,
  opts?: Omit<IsometricCameraOptions, 'sceneMin' | 'sceneMax' | 'target'>,
): CameraParams {
  if (blocks.length === 0) return createIsometricCamera(opts)

  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity

  for (const b of blocks) {
    // 方块为轴对齐单位立方体 [pos-0.5, pos+0.5]
    if (b.x - 0.5 < minX) minX = b.x - 0.5
    if (b.y - 0.5 < minY) minY = b.y - 0.5
    if (b.z - 0.5 < minZ) minZ = b.z - 0.5
    if (b.x + 0.5 > maxX) maxX = b.x + 0.5
    if (b.y + 0.5 > maxY) maxY = b.y + 0.5
    if (b.z + 0.5 > maxZ) maxZ = b.z + 0.5
  }

  return createIsometricCamera({
    sceneMin: { x: minX, y: minY, z: minZ },
    sceneMax: { x: maxX, y: maxY, z: maxZ },
    ...opts,
  })
}
