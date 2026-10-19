/**
 * 混合模式 → **three 渲染状态**（纯映射；无 three 依赖，只给参数）。
 *
 * ## 为什么必须是纯函数、又必须有唯一来源
 *
 * 同一条语义（导出件 `materialPalette[].blend`）被**两处**消费：旧渲染链
 * `render/materials/simpleMaterialLibrary` 与内核呈现链 `presentation/presenter#createMaterial`。
 * 两处各写一份"transparent/alphaTest/depthWrite"就必然漂移 —— 而漂移的表现是
 * "同一个导出件在两条链上画得不一样"，且**只在有重叠半透明几何时才可见**（极易被当成偶发）。
 *
 * ## 判据：跟着 **MC 的渲染 pass** 走，不是"看起来合理"
 *
 * MC 1.7.10 的三段分工（`RenderBlocks` / `EntityRenderer`）：
 *
 * | pass | `transparent` | `alphaTest` | `depthWrite` | 语义 |
 * |---|---|---|---|---|
 * | opaque（pass 0，不透明） | 否 | 0 | 是 | 深度即几何 |
 * | cutout（pass 0，alpha 测试） | 是 | 0.5 | **是** | 二值透明，仍当实体写深度 |
 * | translucent（pass 1，混合） | 是 | 0 | **否** | 只有颜色叠加，**不写深度** |
 *
 * ### `translucent` 不写深度这一条是**实测缺陷的根因**（2026-10-20，LP 物流管）
 *
 * 现场：导出件里管子的**接缝竖板**（`z=0.1875`，不透明纹理）紧贴在两张
 * **全透明**四边形（`z=0.1872`，纹理是空图）之后 **0.0003**。游戏里竖板看得见
 * （= MC 的混合 pass 不写深度）；而两份实现都写了 `depthWrite: true` ⇒ 全透明的
 * 那两张先写深度 ⇒ 竖板被**深度剔除** ⇒ "接缝凭空消失"。几何、UV、纹理、朝向全都正确，
 * 只有这一位状态错了。
 *
 * 所以本模块给的是**pass 状态**，不是"某个材质看起来该怎样"。
 */

import type { ResourceBlendMode } from './content'

export interface MaterialPassState {
  /** three `MeshBasicMaterial.transparent`。 */
  readonly transparent: boolean
  /** three `MeshBasicMaterial.alphaTest`（0 = 不做 alpha 测试）。 */
  readonly alphaTest: number
  /** three `MeshBasicMaterial.depthWrite`。 */
  readonly depthWrite: boolean
}

/**
 * `blend` → 渲染状态。**唯一映射点**（两条渲染链共用）。
 *
 * 未知/缺席按 `opaque` 处理：文件没声明混合模式时，最安全的语义是"当实体画"
 * （写深度、不混合）—— 它不会让别的几何被意外剔除。
 */
export function materialPassStateOf(blend: ResourceBlendMode | string | undefined): MaterialPassState {
  if (blend === 'translucent') {
    return Object.freeze({ transparent: true, alphaTest: 0, depthWrite: false })
  }
  if (blend === 'cutout') {
    return Object.freeze({ transparent: true, alphaTest: 0.5, depthWrite: true })
  }
  return Object.freeze({ transparent: false, alphaTest: 0, depthWrite: true })
}
