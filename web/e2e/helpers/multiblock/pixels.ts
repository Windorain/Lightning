/**
 * 无头渲染断言管线 —— 截图非空断言（像素级）。
 *
 * 设计要点（零替身原则 4「公开观测」）：
 *  - 像素只在**浏览器侧**解码：Playwright 截下的 PNG 以 data URL 交回页面，
 *    由页面自身的 `Image` + `CanvasRenderingContext2D` 解码取像素。
 *    这样 Node 侧不需要任何 PNG 解码依赖（仓库无 pngjs/sharp/jimp），
 *    也不触碰渲染器的私有状态（不读 WebGL drawingBuffer、不调 toDataURL）。
 *  - 统计量选「独特色数 + 亮度标准差 + 非黑像素占比」三条互相独立、
 *    对退化图像（纯色/双色/全黑）必然触发的判据。
 *
 * 阈值理由见 `DEFAULT_BLANK_THRESHOLDS` 的逐条注释；
 * 阈值有效性由 `e2e/multiblock-falsification.spec.ts` 的
 * 「纯色 PNG 必须被拒」用例证伪（保证断言不是恒绿）。
 */

import { expect, type Page } from '@playwright/test'

/** 5 bit/通道 量化后的颜色桶数（32×32×32 = 32768 桶）。 */
export const COLOR_BUCKETS = 32 * 32 * 32

/** 判「非黑」的亮度门限（0..255）。 */
export const NON_BLACK_LUMA = 16

export interface PixelStats {
  width: number
  height: number
  pixels: number
  /** 5bit/通道量化后的独特色数；纯色图恒为 1，双色图 ≤ 8。 */
  uniqueColors: number
  /** 亮度（Rec.709）标准差，0..~128。纯色图恒为 0。 */
  stdDevLuma: number
  meanLuma: number
  minLuma: number
  maxLuma: number
  /** 亮度 > NON_BLACK_LUMA 的像素占比，0..1。 */
  nonBlackRatio: number
}

export interface BlankThresholds {
  minUniqueColors: number
  minStdDevLuma: number
  minNonBlackRatio: number
}

/**
 * 非空阈值的取值理由（量级对照，实测值在 spec 日志中打印）：
 *
 *  - `minUniqueColors: 32`
 *    真实渲染帧 = 抗锯齿 3D 几何 + 纹理 + 明暗渐变 + UI chrome，
 *    实测独特色数在 10^3～10^4 量级（见 spec 打印的 stats）。
 *    退化图：全黑/全白/纯色 = 1；双色 = 2；三色 = 3。
 *    取 32 —— 比所有退化工况高 16 倍以上，又比实测低两个数量级，
 *    既能挡住「canvas 没画出来只剩纯背景色」，也不会被抗锯齿抖动误伤。
 *
 *  - `minStdDevLuma: 3`
 *    纯色图 σ=0。真实帧 σ 实测在 20～60 量级（结构体 + 深色背景 + UI 文字）。
 *    取 3（≈1.2% 满量程）留足余量：即使某个 project（移动端窄视口）
 *    把 3D 区域压得很小、大部分面积是同色面板，也仍然远超门限。
 *
 *  - `minNonBlackRatio: 0.02`
 *    真实帧里亮度 >16 的像素占比远超 0.5（面板底色、文字、几何高光都算）。
 *    取 2% —— 只有「整幅几乎全黑」才会跌破，正是要拦的失效模式
 *    （WebGL 上下文丢失 / mesh 未构建 / preserveDrawingBuffer 导致黑帧）。
 *
 * 三条为「与」关系：任一条不满足即判定非空断言失败，失败时输出全部实测值。
 */
export const DEFAULT_BLANK_THRESHOLDS: BlankThresholds = {
  minUniqueColors: 32,
  minStdDevLuma: 3,
  minNonBlackRatio: 0.02,
}

/** 在页面内解码 PNG（data URL）并统计像素。不依赖 Node 侧解码器。 */
export async function readPixelStats(page: Page, png: Buffer): Promise<PixelStats> {
  const b64 = png.toString('base64')
  return await page.evaluate(
    async ({ b64, buckets, nonBlackLuma }) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const w = img.naturalWidth
      const h = img.naturalHeight
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const g = canvas.getContext('2d', { willReadFrequently: true })
      if (!g) throw new Error('像素统计：无法获取 2D 上下文')
      g.drawImage(img, 0, 0)
      const { data } = g.getImageData(0, 0, w, h)

      const seen = new Uint8Array(buckets)
      let uniqueColors = 0
      let sum = 0
      let sumSq = 0
      let minLuma = 255
      let maxLuma = 0
      let nonBlack = 0
      const n = w * h
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]!
        const gg = data[i + 1]!
        const b = data[i + 2]!
        // 5bit/通道 量化色桶
        const key = ((r >> 3) << 10) | ((gg >> 3) << 5) | (b >> 3)
        if (seen[key] === 0) {
          seen[key] = 1
          uniqueColors++
        }
        const luma = 0.2126 * r + 0.7152 * gg + 0.0722 * b
        sum += luma
        sumSq += luma * luma
        if (luma < minLuma) minLuma = luma
        if (luma > maxLuma) maxLuma = luma
        if (luma > nonBlackLuma) nonBlack++
      }
      const mean = sum / n
      const variance = Math.max(0, sumSq / n - mean * mean)
      return {
        width: w,
        height: h,
        pixels: n,
        uniqueColors,
        stdDevLuma: Math.sqrt(variance),
        meanLuma: mean,
        minLuma,
        maxLuma,
        nonBlackRatio: nonBlack / n,
      }
    },
    { b64, buckets: COLOR_BUCKETS, nonBlackLuma: NON_BLACK_LUMA },
  )
}

/** 返回被违反的判据描述（空数组 = 通过）。 */
export function blankViolations(
  stats: PixelStats,
  thresholds: BlankThresholds = DEFAULT_BLANK_THRESHOLDS,
): string[] {
  const out: string[] = []
  if (stats.uniqueColors < thresholds.minUniqueColors) {
    out.push(`uniqueColors=${stats.uniqueColors} < ${thresholds.minUniqueColors}`)
  }
  if (stats.stdDevLuma < thresholds.minStdDevLuma) {
    out.push(`stdDevLuma=${stats.stdDevLuma.toFixed(3)} < ${thresholds.minStdDevLuma}`)
  }
  if (stats.nonBlackRatio < thresholds.minNonBlackRatio) {
    out.push(`nonBlackRatio=${stats.nonBlackRatio.toFixed(5)} < ${thresholds.minNonBlackRatio}`)
  }
  return out
}

/**
 * 截图非空断言。返回实测统计供调用方打印/归档为证据。
 * 失败信息里带上完整实测值，避免「只知道红了」。
 */
export function expectNotBlank(
  stats: PixelStats,
  label: string,
  thresholds: BlankThresholds = DEFAULT_BLANK_THRESHOLDS,
): void {
  const violations = blankViolations(stats, thresholds)
  expect(violations, `${label}：截图疑似全黑/全空。实测 ${JSON.stringify(stats)}`).toEqual([])
}

/** 可截图对象：Playwright 的 `Page` 与 `Locator` 都满足。 */
export interface ScreenshotTarget {
  screenshot(options?: { path?: string }): Promise<Buffer>
}

/** 一次截图同时拿到：像素统计 + 非空断言结果 + 像素签名（证据链归档用）。 */
export interface EvidenceCapture {
  stats: PixelStats
  signature: number[]
}

/**
 * 截图 → 非空断言 → （可选）落盘 → 像素签名。
 *
 * 通道滑杆遍历与真实产物验收对每个取值组合调用一次即可同时得到
 * 「非空证据」与「相邻取值差异判据」所需的全部数据。
 */
export async function captureEvidence(
  page: Page,
  target: ScreenshotTarget,
  label: string,
  path: string | null = null,
  thresholds: BlankThresholds = DEFAULT_BLANK_THRESHOLDS,
): Promise<EvidenceCapture> {
  const png = path ? await target.screenshot({ path }) : await target.screenshot()
  const stats = await readPixelStats(page, png)
  expectNotBlank(stats, label, thresholds)
  const signature = await readPixelSignature(page, png)
  return { stats, signature }
}

/** 截图 → 非空断言（不需要签名时用这个）。 */
export async function assertScreenshotNotBlank(
  page: Page,
  target: ScreenshotTarget,
  label: string,
  path: string | null = null,
): Promise<PixelStats> {
  return (await captureEvidence(page, target, label, path)).stats
}

// ---------------------------------------------------------------------------
// 像素签名：为「相邻取值截图必须有差异」提供机器判据
//   通道滑杆遍历与真实产物验收直接复用：
//   驱动滑杆 → 截图 → 签名距离 > 门限，即证明结构**真的变了**（不是恒绿断言）。
// ---------------------------------------------------------------------------

/** 签名网格边长（16×16 = 256 个灰度均值）。 */
export const SIGNATURE_GRID = 16

/**
 * 把截图压成 `SIGNATURE_GRID × SIGNATURE_GRID` 的灰度均值向量。
 *
 * 选 16×16 的理由：足以捕捉「结构体变大 / 某层被隐藏 / 通道换材质」这类
 * 全局变化，又对单像素抗锯齿抖动不敏感（每格是几十～几千像素的均值），
 * 因此可以设一个宽松但非零的门限而不会 flaky。
 */
export async function readPixelSignature(
  page: Page,
  png: Buffer,
  grid: number = SIGNATURE_GRID,
): Promise<number[]> {
  const b64 = png.toString('base64')
  return await page.evaluate(
    async ({ b64, grid }) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const g = c.getContext('2d', { willReadFrequently: true })!
      g.drawImage(img, 0, 0)
      const { data } = g.getImageData(0, 0, c.width, c.height)
      const sum = new Float64Array(grid * grid)
      const cnt = new Float64Array(grid * grid)
      for (let y = 0; y < c.height; y++) {
        const gy = Math.min(grid - 1, Math.floor((y * grid) / c.height))
        for (let x = 0; x < c.width; x++) {
          const gx = Math.min(grid - 1, Math.floor((x * grid) / c.width))
          const i = (y * c.width + x) * 4
          const luma = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
          const k = gy * grid + gx
          sum[k] += luma
          cnt[k] += 1
        }
      }
      const out: number[] = []
      for (let k = 0; k < sum.length; k++) out.push(cnt[k]! > 0 ? sum[k]! / cnt[k]! : 0)
      return out
    },
    { b64, grid },
  )
}

/** 两张签名的平均绝对差（0..255）。完全相同 = 0。 */
export function signatureDistance(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) throw new Error('签名长度不一致')
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!)
  return sum / a.length
}

/**
 * 单个签名格的亮度变化门限（0..255）。8/255 ≈ 3%：
 * 远高于截图噪声（实测重复截图每格差 ≤ 2），远低于真实结构变化
 * （落在结构 body 上的格差 30～200）。
 */
export const SIGNATURE_CELL_DELTA = 8

export interface SignatureDiff {
  /** 平均绝对差（0..255）。 */
  meanAbs: number
  /** 单格最大绝对差。 */
  maxAbs: number
  /** 变化超过 `SIGNATURE_CELL_DELTA` 的格数。 */
  changedCells: number
  /** 变化格占比（0..1）。 */
  changedCellRatio: number
}

/**
 * 两帧截图的签名差异。
 *
 * 为什么要看「变化格占比」而不只看均值：窄视口（`mobile-chrome` = 250×1526 CSS px）
 * 下结构体只占画面一小条，均值会被大片同色背景稀释（实测 ALL vs 单层 Y=0
 * 均值差仅 0.45，但结构所在的格整体变化极大）。
 * 「有多少格真的变了」对画面比例不敏感，是更稳的判据。
 */
export function signatureDiff(a: number[], b: number[]): SignatureDiff {
  if (a.length !== b.length || a.length === 0) throw new Error('签名长度不一致')
  let sum = 0
  let maxAbs = 0
  let changed = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!)
    sum += d
    if (d > maxAbs) maxAbs = d
    if (d > SIGNATURE_CELL_DELTA) changed++
  }
  return {
    meanAbs: sum / a.length,
    maxAbs,
    changedCells: changed,
    changedCellRatio: changed / a.length,
  }
}

/**
 * 「两张截图必须不同」的机器判据门限。
 *
 * 均值门限（`MIN_SIGNATURE_DISTANCE = 0.5`）用于**负向**判据（重复截图必须几乎相同）：
 * 实测重复截图均值差 0.0027（窄视口 250×1526）～0.0085（桌面 978×628），比门限低 50 倍以上。
 *
 * 正向判据由两条**互相独立**的证人构成（见 `pixelChangeViolations`），
 * 实测数据（ALL → 单层 Y=0，隐藏 167/173 格）：
 *
 * | 视口 | 重复截图（噪声地板） | 真实结构变化 |
 * |------|--------------------|-------------|
 * | 桌面 978×628  | meanAbs 0.0085 / maxAbs 2.10 / 变化格 0 | meanAbs 4.52 / maxAbs 76.02 / 变化格 38 |
 * | 窄 250×1526  | meanAbs 0.0027 / maxAbs 0.66 / 变化格 0 | meanAbs 0.45 / maxAbs 20.15 / 变化格 5  |
 *
 * - `maxAbs > SIGNATURE_CELL_DELTA`：噪声 0.66～2.10 vs 真实 20.15～76.02（10～36 倍余量）
 * - `changedCellRatio > MIN_CHANGED_CELL_RATIO`：噪声 **0** 格 vs 真实 5～38 格
 *
 * 窄视口下均值被大片同色背景稀释（0.45，甚至低于 0.5 的均值门限），
 * 这正是**不拿均值当正向判据**的原因；两条证人里 maxAbs 的余量最大。
 */
export const MIN_SIGNATURE_DISTANCE = 0.5

/** 正向判据一：至少 1% 的签名格（256 格里 ≥ 3 格）必须发生变化。 */
export const MIN_CHANGED_CELL_RATIO = 0.01

/** 正向判据的违反项（空数组 = 通过）。 */
export function pixelChangeViolations(diff: SignatureDiff): string[] {
  const v: string[] = []
  if (diff.maxAbs <= SIGNATURE_CELL_DELTA) {
    v.push(`maxAbs=${diff.maxAbs.toFixed(2)} 未超过单格门限 ${SIGNATURE_CELL_DELTA}`)
  }
  if (diff.changedCellRatio <= MIN_CHANGED_CELL_RATIO) {
    v.push(
      `changedCellRatio=${diff.changedCellRatio.toFixed(5)}（${diff.changedCells} 格）未超过门限 ${MIN_CHANGED_CELL_RATIO}`,
    )
  }
  return v
}

/**
 * 「取值变了 → 画面必须真的变」断言（滑杆遍历与真实产物验收的相邻等级差异判据）。
 * 返回实测差异供归档。
 */
export function expectSignificantPixelChange(
  before: number[],
  after: number[],
  label: string,
): SignatureDiff {
  const diff = signatureDiff(before, after)
  expect(
    pixelChangeViolations(diff),
    `${label}：画面未发生显著变化（疑似结构没变 / 网格未重建）。实测 ${JSON.stringify(diff)}`,
  ).toEqual([])
  return diff
}

/** 「同一状态重复截图必须一致」断言（判据噪声地板）。 */
export function expectStablePixels(before: number[], after: number[], label: string): SignatureDiff {
  const diff = signatureDiff(before, after)
  expect(diff.meanAbs, `${label}：同一状态重复截图不应有显著差异`).toBeLessThan(MIN_SIGNATURE_DISTANCE)
  expect(diff.changedCellRatio, `${label}：同一状态重复截图不应有格数级变化`).toBeLessThan(
    MIN_CHANGED_CELL_RATIO,
  )
  return diff
}

