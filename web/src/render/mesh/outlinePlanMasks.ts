/**
 * `render/mesh/outlinePlanMasks` —— **描边计划 → mask 网格**（Three.js 侧最小适配层）。
 *
 * ## 为什么这一层存在（它的边界就是"呈现 + 适配"，不含任何判定）
 *
 * `presentation/outlinePlan` 产出的是**纯数据**（`OutlinePlan.primitives`），
 * 而描边通道（`SelectionOutlinePass`）吃的是 `THREE.Mesh[]`。两者之间只有
 * **形状适配**：挑哪种图元、平移到哪里、用哪个累加器 —— 全部由计划里的字段决定。
 *
 * 于是本文件**不得**出现任何"该不该画"的分支（兜底盒、版本过期、缺几何都在
 * `planOutline` 里判完）；它只做"计划说画什么就画什么"。任何 `if (缺…)` 都是
 * 把判定搬回呈现层的信号（`outlinePlan` 文件头禁的形态）。
 *
 * ## 逐图元的适配（与 legacy mask 通道**逐位同空间**）
 *
 * | 图元 | mask 网格 | 坐标系 |
 * |---|---|---|
 * | `cellQuads` | `buildQuadsMaskMesh(quads, origin)` | `origin` 是**格角**（世界） |
 * | `cellBox` | `BoxGeometry(1,1,1)` 平移到 `origin + 0.5` | 同上（格角 → 格中心） |
 * | `partBoxes` | `buildBoxesMaskMesh(boxes, origin)` | 同上 |
 * | `objectBounds` | `BoxGeometry(max−min)` 平移到盒中心 | 世界空间边界盒 |
 * | `element` | **不产出 mesh** | 元素是点集（`THREE.Points`），而 mask 通道只吃实体 |
 *
 * `cellBox` 的 `+0.5` 不是新约定：legacy 兜底盒写的是
 * `BoxGeometry(1,1,1).translate(center)`，而计划的 `origin` 定义为
 * "格中心 − 0.5"（见 `outlinePlan.ts` 的 `cellOriginOf` 说明）⇒ 两者同一位置。
 */

import * as THREE from 'three'
import type { BakedQuad, PartBox } from '@/render/schema/types'
import type { OutlinePlan, OutlinePrimitive } from '@/presentation/outlinePlan'
import { buildBoxesMaskMesh, buildQuadsMaskMesh } from './maskGeometryBuild'

/** 世界空间轴对齐盒 → mesh（`objectBounds` 通道；不与格角平移共用一条路径）。 */
function boxBoundsMesh(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): THREE.Mesh | null {
  const sx = max[0] - min[0]
  const sy = max[1] - min[1]
  const sz = max[2] - min[2]
  if (!(sx > 0) || !(sy > 0) || !(sz > 0)) return null
  const geo = new THREE.BoxGeometry(sx, sy, sz)
  geo.translate(min[0] + sx / 2, min[1] + sy / 2, min[2] + sz / 2)
  return new THREE.Mesh(geo)
}

function primitiveToMask(p: OutlinePrimitive): THREE.Mesh | null {
  switch (p.kind) {
    case 'cellQuads':
      return buildQuadsMaskMesh(
        p.quads as unknown as readonly BakedQuad[],
        { x: p.origin[0], y: p.origin[1], z: p.origin[2] },
      )
    case 'cellBox': {
      const geo = new THREE.BoxGeometry(1, 1, 1)
      geo.translate(p.origin[0] + 0.5, p.origin[1] + 0.5, p.origin[2] + 0.5)
      return new THREE.Mesh(geo)
    }
    case 'partBoxes':
      return buildBoxesMaskMesh(
        p.boxes.map((b): PartBox => ({ min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]], kind: 'visual' })),
        { x: 0, y: 0, z: 0 },
      )
    case 'objectBounds':
      return boxBoundsMesh(p.min, p.max)
    case 'element':
      // 元素点集不参与 mask（mask 是实体几何）。**不**静默：调用方从计划的
      // `primitives` 里就能看到该图元存在（本函数只负责它能产出的那部分）。
      return null
    default:
      return null
  }
}

/** 一个计划的全部图元 → mask 网格（空计划 ⇒ 空数组）。 */
export function planToMaskMeshes(plan: OutlinePlan): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = []
  for (const p of plan.primitives) {
    const m = primitiveToMask(p)
    if (m !== null) meshes.push(m)
  }
  return meshes
}

/** 多个计划 → mask 网格（逐条独立；与 `planOutlines` 的"逐条失败不连坐"同口径）。 */
export function plansToMaskMeshes(plans: readonly OutlinePlan[]): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = []
  for (const p of plans) meshes.push(...planToMaskMeshes(p))
  return meshes
}
