/**
 * 混合模式（+ alpha 类别）→ **three 渲染状态**（纯映射；无 three 依赖，只给参数）。
 *
 * ## 为什么必须是纯函数、又必须有唯一来源
 *
 * 同一条语义（导出件 `materialPalette[].blend`）被**两处**消费：旧渲染链
 * `render/materials/simpleMaterialLibrary` 与内核呈现链 `presentation/presenter#createMaterial`。
 * 两处各写一份"transparent/alphaTest/depthWrite"就必然漂移 —— 而漂移的表现是
 * "同一个导出件在两条链上画得不一样"，且**只在有重叠半透明几何时才可见**（极易被当成偶发）。
 *
 * ## 判据：跟着 **Angelica 的实际 pass** 走（不是"看起来合理"，也不是 MC 的声明层）
 *
 * 导出件的 `blend` 只记录方块的 RenderLayer 声明；**运行期**决定 pass 的是贴图透明度 + 声明，
 * 见 GTNH 运行期绑定的 Angelica（`mod/gtnh/dependencies.gradle:20` 的 `angelica: "2.2.16"`）。
 * 下面三处行号取**该绑定版本**（`2.2.16`；仓库 HEAD 是另一条线（2.0.0-alpha21），
 * 语义相同、行号不同，故不以 HEAD 为基线）：
 *
 * | Angelica 2.2.16 事实 | 位置 | 含义 |
 * |---|---|---|
 * | `CUTOUT_MIPPED_PASS`：`pass 0` + `fragmentDiscard(true)`；`CUTOUT_MIPPED_MATERIAL` 的 cutoff = `AlphaCutoffParameter.HALF`（**0.5**）；pipeline 里 `glAlphaFunc(GL_GREATER, HALF.cutoff())` | `AngelicaRenderPassConfiguration.java:54-58,69,107` | 二值 alpha ⇒ alphaTest（0.5）+ 深度即几何 |
 * | `TRANSLUCENT_PASS`：`pass 1` + `useReverseOrder(true)` + `useTranslucencySorting(true)` | 同上 `:60-65` | 真半透明 ⇒ **排序**（画家算法），不是"顺序随批次" |
 * | 声明 TRANSLUCENT 但贴图透明度等级 ≠ TRANSLUCENT ⇒ **降级为 CUTOUT_MIPPED_MATERIAL**（`OPAQUE` 也一样：该分支只看"≠ TRANSLUCENT"） | `AngelicaChunkBuildContext.java:117-125` | 二值 alpha 的"玻璃"在游戏里实际走 cutout |
 *
 * 两条**已知且有意**的取舍（写在这里，避免"实现与引用看起来逐字对齐"的假象）：
 *
 * 1. 游戏侧的降级只在该 sprite **没有动画元数据**时生效（`!sprite.hasAnimationMetadata()`，
 *    `:118`）。web 侧按本判据的既定口径对**整幅**（含动画竖条）分类 —— 动画条按整幅是
 *    为了避免"逐帧类别不同 ⇒ 同一材质状态无法确定"；代价是动画 translucent 材质也会被降级
 *    （二值 alpha 下这一位只影响深度写入，不影响像素可见性）。
 * 2. 游戏侧还有 `useRenderPassOptimization`/材质包覆盖两个开关；web 侧无对应概念，
 *    恒按"优化在打开状态"取语义。
 *
 * ⇒ 本模块的判据是三段（不是两段）：
 *
 * | `blend` | `alphaClass` | `transparent` | `alphaTest` | `depthWrite` | 语义 |
 * |---|---|---|---|---|---|
 * | `opaque` | 任意 | 否 | 0 | 是 | 深度即几何 |
 * | `cutout` | 任意 | 是 | 0.5 | 是 | 二值透明，仍当实体写深度 |
 * | `translucent` | `binary` / `opaque` | 是 | 0.5 | **是** | **Angelica 降级语义 = cutout** |
 * | `translucent` | `partial` / 缺席（未知） | 是 | 0 | **否** | 真半透明（排序路径） |
 *
 * 未知（贴图还没解码）按 `partial` 那一行处理 —— 那是**现状**（修复前的形态），
 * 解码完成后由 `TextureBinding#alphaClass` 在场触发材质按新分类重建
 * （重建链核实见 `presentation/presenter#materialIdentityOf`）。
 *
 * ## LP 物流管那次实测缺陷的**精确**表述（本段修正过旧叙述）
 *
 * 现场：导出件里管子的**接缝竖板**（`z=0.1875`，不透明纹理）紧贴在两张
 * **全透明**四边形（`z=0.1872`，纹理是空图）之后 **0.0003**。游戏里竖板看得见，
 * 而两份实现都写了 `depthWrite: true` ⇒ 全透明那两张先写深度 ⇒ 竖板被深度剔除
 * ⇒ "接缝凭空消失"。
 *
 * 真实机制是「**没有 alphaTest 时，α=0 的四边形照样写深度**」，而不是
 * "MC 的混合 pass 写/不写深度"这一句笼统的话：游戏侧那两张全透明四边形之所以无害，
 * 是因为它们走的是**二值 alpha** 的 cutout 语义 —— 像素被 alphaTest 丢弃 ⇒ 不写深度。
 *
 * ⇒ 本次对齐（二值 translucent ⇒ cutout）**不削弱**那条回归保护，两半都要成立：
 *
 * | 贴图 | `alphaClass` | 结果 | 接缝板可见性 |
 * |---|---|---|---|
 * | 全透明（只有 α=0） | `binary` | cutout：alphaTest 丢掉 α=0 像素 ⇒ 不写深度 | ✅ 可见 |
 * | 真半透明（含 1..254） | `partial` | 混合、不写深度 | ✅ 可见 |
 *
 * 这正是"判据跟着 pass 语义走"的应有结果：两条路径都**不会**让 α=0 的几何偷写深度。
 *
 * 所以本模块给的是**pass 状态**，不是"某个材质看起来该怎样"。
 */

import type { ResourceBlendMode } from './content'
import type { TextureAlphaClass } from './textureAlphaClass'

export interface MaterialPassState {
  /** three `MeshBasicMaterial.transparent`。 */
  readonly transparent: boolean
  /** three `MeshBasicMaterial.alphaTest`（0 = 不做 alpha 测试）。 */
  readonly alphaTest: number
  /** three `MeshBasicMaterial.depthWrite`。 */
  readonly depthWrite: boolean
}

/** cutout 状态的唯一字面量（`cutout` 与"二值 translucent 降级"**必须**是同一个值）。 */
const CUTOUT_STATE: MaterialPassState = Object.freeze({
  transparent: true,
  alphaTest: 0.5,
  depthWrite: true,
})

/**
 * `blend`（+ 贴图 alpha 类别）→ 渲染状态。**唯一映射点**（两条渲染链共用）。
 *
 * @param blend 导出件声明的混合模式（缺省/未知 ⇒ 当 `opaque`）
 * @param alphaClass 贴图的 alpha 类别（`domain/textureAlphaClass` 的产出）。
 *   **缺席 = 未知**（贴图还没解码）⇒ 真半透明路径（现状，见文件头）。
 *
 * 未知/缺席的 `blend` 按 `opaque` 处理：文件没声明混合模式时，最安全的语义是"当实体画"
 * （写深度、不混合）—— 它不会让别的几何被意外剔除。
 */
export function materialPassStateOf(
  blend: ResourceBlendMode | string | undefined,
  alphaClass?: TextureAlphaClass,
): MaterialPassState {
  if (blend === 'translucent') {
    // Angelica 降级语义：二值（或完全无 alpha）的"半透明"材质实际走 cutout。
    // `alphaTest: 0.5` 与 2.2.16 的 `AlphaCutoffParameter.HALF` 逐值相等（`AngelicaRenderPassConfiguration.java:69,107`）。
    // `opaque` 也落这一支的理由：贴图没有可裁像素时，"混合 + 不写深度"没有任何收益，
    // 却会丢掉深度裁决 ⇒ 与游戏侧（二值透明度等级 ⇒ CUTOUT_MIPPED）一致。
    if (alphaClass === 'binary' || alphaClass === 'opaque') return CUTOUT_STATE
    // 真半透明 / 未知（未解码）⇒ 现状：混合、不做 alphaTest、不写深度。
    return Object.freeze({ transparent: true, alphaTest: 0, depthWrite: false })
  }
  if (blend === 'cutout') return CUTOUT_STATE
  return Object.freeze({ transparent: false, alphaTest: 0, depthWrite: true })
}
