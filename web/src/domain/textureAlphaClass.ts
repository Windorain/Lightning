/**
 * `domain/textureAlphaClass` —— **RGBA8 像素 → alpha 类别**（三态纯函数）。
 *
 * ## 它回答什么、不回答什么
 *
 * 只回答一件事：这张贴图的 alpha 通道**是不是二值的**。
 *
 * | 类别 | 判据 | 语义 |
 * |---|---|---|
 * | `opaque` | 全部像素 alpha = 255 | 完全不透明（没有可裁掉的像素） |
 * | `binary` | 只有 0 与 255，且**至少一个 0** | 二值 alpha：要么全透、要么全实 |
 * | `partial` | 出现任何 1..254 | 真半透明（有中间值） |
 *
 * 它**不**回答"该怎么画"——那是 `domain/materialPass` 的映射（本模块只给类别，
 * 不给 `alphaTest`/`depthWrite`）。两者的分工与 `domain/materialPass` 文件头一致：
 * 类别是**贴图事实**（字节派生的），pass 状态是**呈现决策**。
 *
 * ## 为什么需要它（#87 修复轮 3）
 *
 * MC 的材质声明（导出件 `materialPalette[].blend`）只说"这个方块走哪个 RenderLayer"，
 * 而**运行期**会按贴图的真实透明度改变实际 pass：
 * Angelica（`AngelicaChunkBuildContext.java:103-106` 的口径）把"声明为 TRANSLUCENT
 * 但贴图透明度等级不是 TRANSLUCENT"的材质**降级为 CUTOUT_MIPPED**（alphaTest + 写深度）。
 * 于是游戏里 ACC 这类"二值 alpha 的玻璃"实际走 cutout —— 它**有**深度裁决，
 * web 侧若照着 `blend=translucent` 画成"混合 + 不写深度"，就会出现"远处玻璃盖住近处
 * 玻璃"的深度顺序颠倒（#87 的像素级证据）。
 *
 * ⇒ 与"资源五态"同一条纪律：**事实从字节派生，不由声明冒充**。
 *
 * ## 纯度
 *
 * 不 import three/DOM、不读时钟、不改输入（`domain/` 的通用纪律）。
 * 输入形状是**结构**的（`{ width, height, rgba }`），与 `presentation/textureBinding` 的
 * `TexturePixels` 同形 —— 故 presentation 侧无需转换即可传入，而本模块无需反向依赖。
 */

/** 贴图的 alpha 类别（三态；见文件头表格）。 */
export type TextureAlphaClass = 'opaque' | 'binary' | 'partial'

/** 三态的全集（顺序固定；给穷举断言与诊断文案用）。 */
export const TEXTURE_ALPHA_CLASSES: readonly TextureAlphaClass[] = Object.freeze([
  'opaque',
  'binary',
  'partial',
])

/**
 * 本模块接受的像素形状（**结构**类型，不是 `TexturePixels` 的别名）。
 *
 * 刻意不 import `presentation/textureBinding#TexturePixels`：依赖方向是"呈现依赖领域"，
 * 反过来会把 `domain/` 绑在呈现层的类型上（`domain/` 不得 import 旧层或呈现层）。
 * 结构相同 ⇒ 调用方直接传入即可，无需适配函数。
 */
export interface Rgba8Pixels {
  readonly width: number
  readonly height: number
  /** RGBA8，长度 = `width * height * 4`。 */
  readonly rgba: Uint8Array
}

/**
 * 像素 → alpha 类别。
 *
 * ## 非法输入为什么答 `partial`（保守方向 = **保持现状**）
 *
 * 两条可选处置：显式判错（抛 / 返回 `Result`）或保守归类。这里选**保守归类**，理由有三：
 *
 * 1. **反向错误更贵**：`binary`/`opaque` 会把材质降级成 cutout（alphaTest 0.5 + 写深度），
 *    一旦对一份**读不懂**的数据这么判，画面上被裁掉的像素是不可恢复的（静默丢内容）；
 *    而停在 `partial` 只是维持现状（混合 + 不写深度），与"还没解码"完全一样。
 * 2. **本函数在解码链的热路径上**（每张贴图一次）：抛错会把"分类实现缺陷"变成"这张贴图
 *    解码失败"（五态里的 `failed`），把两种完全不同的事实混成一种 —— 与
 *    `presentation/textureBinding` 的五态纪律相悖。
 * 3. **`partial` 本来就是"不能下结论"的类别**：它既覆盖"真半透明"，也覆盖"未知"。
 *    给它加一个第四态（`unknown`）会让下游映射多一个与 `partial` **行为相同**的分支
 *    （"看起来完备的假分支"），故不加。
 *
 * 长度不合法（`rgba.length !== width * height * 4`）、尺寸非正整数、空图像
 * （`width * height === 0`）都落这条。空图像也算非法：没有像素就没有 alpha 事实，
 * 而 `opaque`/`binary` 都会**下结论**。
 *
 * ## 动画竖条贴图对**整幅**分类
 *
 * 帧条（竖直拼接的动画贴图）按整幅扫描，不逐帧。理由：分类服务的是**材质 pass 状态**
 * （整份材质一个），而同一张图的所有帧共享同一个材质；逐帧分类只会造出"第 3 帧是
 * binary、第 4 帧是 partial"这种无法落到单一材质状态上的结论。
 */
export function textureAlphaClassOf(pixels: Rgba8Pixels | null | undefined): TextureAlphaClass {
  if (pixels === null || pixels === undefined) return 'partial'
  const { width, height, rgba } = pixels
  if (!Number.isInteger(width) || !Number.isInteger(height)) return 'partial'
  if (width <= 0 || height <= 0) return 'partial'
  if (rgba.length !== width * height * 4) return 'partial'

  let sawZero = false
  for (let i = 3; i < rgba.length; i += 4) {
    const alpha = rgba[i]!
    if (alpha === 255) continue
    if (alpha === 0) {
      sawZero = true
      continue
    }
    // 任何中间值 ⇒ 真半透明（不必扫完：结论已定，且大图上的提前返回是有意义的）。
    return 'partial'
  }
  return sawZero ? 'binary' : 'opaque'
}
