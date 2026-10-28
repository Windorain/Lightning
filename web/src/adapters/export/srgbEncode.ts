/**
 * `adapters/export/srgbEncode` —— **线性读回 → sRGB 编码**。
 *
 * ## 为什么必须有这一跳（这是色彩回归的根因落点）
 *
 * three r174 的输出阶段按**渲染目标是否存在**决定写出编码（`three.module.js` 的
 * `getProgram` 参数表）：
 *
 * ```js
 * outputColorSpace: ( currentRenderTarget === null )
 *   ? renderer.outputColorSpace
 *   : ( currentRenderTarget.isXRRenderTarget === true
 *       ? currentRenderTarget.texture.colorSpace
 *       : LinearSRGBColorSpace )
 * ```
 *
 * ⇒ **只要渲染到 `WebGLRenderTarget`，输出就恒为线性**，与
 * `renderer.outputColorSpace = SRGBColorSpace` **无关**。而离屏导出的读回正是
 * 读回渲染目标像素（渲染目标是唯一可能），于是读到的是**线性光值**；
 * 把它当 sRGB 编码进 PNG，画面就系统性偏暗。
 *
 * 旧烘焙链看不出这个问题：它直接 `renderer.render()` 到 **canvas**
 * （`currentRenderTarget === null`），那里 `outputColorSpace` 生效，输出本来就是 sRGB。
 *
 * ## 实测（修复前，中调夹具 #C65640）
 *
 * | 管线 | 平均亮度 | 主色 |
 * |---|---|---|
 * | 导出（渲染目标 → 直接当 sRGB 编码） | **38.79** | 144/24/13 |
 * | 画布输出（sRGB 输出阶段） | **96.77** | 198/86/64 |
 * | 画布输出但**线性**写出（负对照） | **38.79** | 144/24/13 |
 *
 * ⇒ 导出与"线性写出"**逐位相同**，与 sRGB 输出差 **-60%**。数值特征即根因。
 *
 * ## 为什么用查表而不是逐像素 pow
 *
 * 读回是 **8 位**、每通道只有 256 个可能值 ⇒ 传递函数可以预算成一张 256 项表：
 * 判定与产物都**逐位可复现**（`Math.pow` 在不同引擎上的末位差异不会进入产物），
 * 且比逐像素幂运算快一个量级。
 *
 * ## 精度边界（如实登记）
 *
 * 渲染目标本身是 8 位**线性**存储 ⇒ 暗部在编码前已被量化（最坏误差约 6 个 sRGB 级，
 * 出现在近黑处）。这是"渲染目标 8 位 + 线性存储"的固有上限，不是本函数引入的；
 * 判据的容差按此设定（见 `e2e/export-color-parity.spec.ts`）。
 *
 * ## 纯度
 *
 * 无 GL、无 DOM、无 three import ⇒ 可在 vitest 里逐值断言（`__tests__/srgbEncode.test.ts`）。
 */

/** sRGB 传递函数的**编码**方向（线性 0..1 → sRGB 0..1）。 */
export function linearToSrgb(value: number): number {
  const v = value <= 0 ? 0 : value >= 1 ? 1 : value
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

/** sRGB 传递函数的**解码**方向（sRGB 0..1 → 线性 0..1）。 */
export function srgbToLinear(value: number): number {
  const v = value <= 0 ? 0 : value >= 1 ? 1 : value
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

/**
 * 8 位查表（预算一次；产物逐位可复现）。
 *
 * ⚠️ 只对 **RGB** 生效：alpha 是**覆盖度**，不是颜色。按 sRGB 传递函数变换它会让
 * 半透明边缘变厚/变薄（那是另一类错误）。
 */
const TABLE: Uint8Array = (() => {
  const out = new Uint8Array(256)
  for (let i = 0; i < 256; i += 1) {
    out[i] = Math.round(linearToSrgb(i / 255) * 255)
  }
  return out
})()

/** 单通道查表（0..255，越界按端点夹取）。 */
export function linearByteToSrgbByte(v: number): number {
  return TABLE[v <= 0 ? 0 : v >= 255 ? 255 : v | 0]!
}

/**
 * 把一帧**线性**读回的 RGBA 就地编码成 sRGB（alpha 不动）。
 *
 * @param pixels 行主序 RGBA8（长度必须是 4 的倍数；不合法 ⇒ 显式抛，不静默跳过）
 * @returns 同一个缓冲（就地改写；调用方通常紧接着交给编码器）
 */
export function encodeLinearRgbaToSrgb(pixels: Uint8Array): Uint8Array {
  if (pixels.length % 4 !== 0) {
    throw new Error('encodeLinearRgbaToSrgb: 像素缓冲长度必须是 4 的倍数（实得 ' + String(pixels.length) + '）')
  }
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = TABLE[pixels[i]!]!
    pixels[i + 1] = TABLE[pixels[i + 1]!]!
    pixels[i + 2] = TABLE[pixels[i + 2]!]!
    // pixels[i + 3] 保持不变（alpha = 覆盖度）
  }
  return pixels
}

/** 表的只读视图（判据用；避免判据自己再算一遍表而与实现漂移）。 */
export function srgbEncodeTable(): Uint8Array {
  return TABLE
}
