/**
 * 方块单面 UV（与 MyCTMLib `UVDomain.calc` + `QuadRender.drawFace` 对齐）。
 *
 * **数据流**（与旧管线一致）：
 * 1. `UVDomain`：按 Forge 面决定子纹理矩形上的 **drawMinU/MaxU/MinV/MaxV**（全格贴满时为 sprite 全宽全高）。
 * 2. `QuadRender.drawFace`：每个 `ForgeDirection` 四条 `addVertexWithUV(x,y,z, u, v)`，其中 **u,v** 取 **minU、maxU、minV、maxV** 的角点组合。
 *
 * 此处假定 **满 tile**（子纹理归一化为 0–1）：**minU=0, maxU=1, minV=0, maxV=1**，代入 Java 侧公式即得各顶点 **(u,v)**。
 * 与 `quadGeometryForFace` 中 **q0→q1→q2→q3** 顺序一致（同 `QuadRender` 四条顶点顺序）。
 *
 * **Forge ↔ FaceName（世界外法线）**：见 `faceConstants.ts` 注释表。
 *
 * 上下方向由 `simpleMaterialLibrary.loadTexture` 中 `Texture.flipY` 统一决定（与 QuadRender 一致），此处不改 v。
 */

import type { FaceName } from '../schema/types'

/** NORTH / WEST：QuadRender 中 (minU,maxU,minV,maxV) 代入后相同的四角模式 */
const UV_FULL_TILE_NORTH_OR_WEST = new Float32Array([1, 0, 0, 0, 0, 1, 1, 1])

export function uv8ForFace(face: FaceName): Float32Array {
  switch (face) {
    case '-y': // ForgeDirection.DOWN
      return new Float32Array([0, 0, 0, 1, 1, 1, 1, 0])
    case '+y': // UP
      return new Float32Array([1, 1, 1, 0, 0, 0, 0, 1])
    case '-z': // NORTH（−Z）
      return new Float32Array(UV_FULL_TILE_NORTH_OR_WEST)
    case '+z': // SOUTH（+Z）
      return new Float32Array([0, 0, 0, 1, 1, 1, 1, 0])
    case '-x': // WEST（−X）
      return new Float32Array(UV_FULL_TILE_NORTH_OR_WEST)
    case '+x': // EAST（+X）
      return new Float32Array([0, 1, 1, 1, 1, 0, 0, 0])
    default:
      throw new Error(`unknown face: ${String(face)}`)
  }
}
