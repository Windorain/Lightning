/**
 * 视口画面统计的观测面原语（截图 → 页面内解码 → 只回统计标量）。
 *
 * ## 为什么像素留在浏览器里
 *
 * 判据要的三件事 —— 机器占多少画面、纹理细节够不够、拖滑杆后画面变没变 —— 只能从
 * 真实像素算，但**像素本身不必离开浏览器**：截图（无损 PNG）进页面解码后，掩码 /
 * 色桶 / 局部细节 / 包围盒 / 前后差异全在页面内算完，只把统计标量交回 Node。
 *
 * 早先的实现把整幅 RGB 数组当读数搬出页面（1440×900 视口下画面 1138×672 = 764736 像素
 * ⇒ 764736×3 = 2294208 个数/张，单张 JSON 约 7.4 MB、两张合计约 14.9 MB），再让逐像素
 * 差异把前后两组数组各传回页面。一次判据因此是四次全量数组往返（出 2 次 + 回 2 次），
 * 合计约 29.6 MB 的 CDP 载荷。现在同样的像素、同样的逐像素口径，跨 CDP 只有 3 段 PNG
 * base64（before 两次：本帧一次、作为 after 的比较帧一次；after 一次；合计约 196 KB）
 * 与两次统计标量（约 222 B/次）。
 *
 * ⚠️ 口径边界（不要读成"没有任何全量像素过网"）：不传的是 **RGB number[] 全量数组**；
 * 无损 PNG 仍承载全部像素信息，只是交给页面解码器还原成同一份像素缓冲。判据因此不变弱
 * —— 不抽样、不降分辨率、不用 hash 代替逐像素。
 *
 * ## 取样与判据口径（与逐像素实现同一条）
 *
 *  - 取样区：中央 `x∈[22%,88%] × y∈[10%,90%]`（排除左侧工具栏 / 右下 HUD 等 DOM 覆盖物）；
 *  - 背景：右上角空白带（`x∈[90%,96%] × y∈[4%,10%]`，步长 2）各通道中位色；
 *  - 机器掩码：任一通道与背景差 > 14（`PICTURE_TOL`）；
 *  - `machineColors`：机器区内 5 bit/通道量化（32×32×32 桶）的独特色桶数；
 *  - `detailPixels`：机器区内 3×3 亮度极差 > 12 的像素数（Rec.709 亮度）；
 *  - `bbox`：机器区包围盒；
 *  - `changed`：**任一分量绝对差之和 > 24** 记一个变了的像素（整幅、全分辨率、逐像素）。
 *
 * 注入方式：亮度一次性预计算进 `Float64Array`（公式与求和顺序不变 ⇒ 每个像素的 double
 * 值与逐点计算逐位相同），3×3 邻域按 `row + x + dx` 直接取下标（不再每个邻点分配一个
 * `[r,g,b]` 数组）。数值口径不变，省掉的只是分配与搬运。
 *
 * 调用形态：每次 `readPictureStats` 一次 `page.evaluate`；`after` 那次同时把 before 的
 * PNG 带进去比较，故一次判据共 3 次页面内解码。
 */

import type { Page } from '@playwright/test'

/** 机器掩码门限：任一通道与背景差 > 该值 ⇒ 机器像素。 */
export const PICTURE_TOL = 14
/** 纹理细节门限：3×3 邻域亮度极差 > 该值 ⇒ 细节像素。 */
export const PICTURE_DETAIL_MIN_RANGE = 12
/** 变化门限：任一分量绝对差之和 > 该值 ⇒ 该像素变了。 */
export const PICTURE_CHANGED_STEP = 24
/** Rec.709 亮度系数（与旧实现的字面量与求和顺序一致）。 */
export const PICTURE_LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 } as const

/** 视口画面的像素统计（**画面层判据**的观测面）。**不暴露 rgb**：像素只在页面内消费。 */
export interface PictureStats {
  readonly width: number
  readonly height: number
  /** 中央取样面积（排除左侧工具栏 / 右下 HUD 等 DOM 覆盖物）。 */
  readonly sampled: number
  /** 与背景色差异 > 门限的像素数（= 机器占了多少画面）。 */
  readonly machinePixels: number
  readonly machineRatio: number
  /** 机器区域内 5bit/通道量化后的**独特色桶数**（两片纯色红面会极低）。 */
  readonly machineColors: number
  /**
   * **纹理细节像素**：机器区域内局部（3x3）亮度极差 > 12 的像素数。
   *
   * 这是"贴图真的贴上了"的判据：平坦纯色面只在棱边有对比，而 16x16 像素纹理
   * 在面内部就有大量高频细节（占位资产时代实测 ~0；真贴图实测占机器像素 20%~40%）。
   */
  readonly detailPixels: number
  readonly detailRatio: number
  /** 机器区域包围盒（画面坐标；变高的方向性证据）。 */
  readonly bbox: readonly [number, number, number, number]
  /** 背景色（取自右上角空白带的中位色）。 */
  readonly background: readonly [number, number, number]
}

/**
 * 一次截图的**原始 PNG**（Node 侧持有）。
 *
 * 它不是判据读数，而是 `changed` 的比较输入：`after` 采样时把它递回页面，与 after 的
 * PNG 一起在页面内解码后逐像素比对。跨 CDP 的是 PNG，而不是解码后的 RGB 数组。
 */
export interface PictureShot {
  /** 真实 canvas 截图的 PNG（base64，无 data URL 前缀）。 */
  readonly pngBase64: string
  /** PNG 字节数（仅作传输量证据，不参与判据）。 */
  readonly pngBytes: number
}

/** 两幅画面的逐像素差异（`changed = 任一分量绝对差之和 > 24` 的像素）。 */
export interface PictureChanged {
  readonly pixels: number
  readonly ratio: number
}

/** 一次画面观测：stats + 原始截图（可作下一次比较的 before）+（可选）changed。 */
export interface PictureObservation {
  readonly stats: PictureStats
  readonly shot: PictureShot
  readonly changed: PictureChanged | null
}

/** 浏览器侧入参（`page.evaluate` 只搬运函数源码，外部量一律走参数）。 */
interface PictureProbeArgs {
  readonly b64: string
  readonly compareB64: string | null
  readonly tol: number
  readonly detailMinRange: number
  readonly changedStep: number
  readonly lumaR: number
  readonly lumaG: number
  readonly lumaB: number
}

/** 浏览器侧出参（只有小 stats 与一个整数；**没有任何像素数组**）。 */
interface PictureProbeResult {
  readonly stats: PictureStats
  readonly compared: boolean
  readonly changedPixels: number
  readonly changedRatio: number
}

/**
 * **浏览器侧**统计内核（自包含：不引用模块作用域的任何东西，只吃 {@link PictureProbeArgs}）。
 *
 * 本帧与可选的比较帧都在**页面内**解码（仓库无 PNG 解码依赖，与 `multiblock/pixels.ts`
 * 同一手法）：`Image.decode()` → 2D `drawImage` → `getImageData`。统计与逐像素差异全在
 * 这里算完，返回值里只有统计标量。
 */
export async function pictureStatsProbe(args: PictureProbeArgs): Promise<PictureProbeResult> {
  const { b64, compareB64, tol, detailMinRange, changedStep, lumaR, lumaG, lumaB } = args

  const decodePng = async (payload: string): Promise<{ w: number; h: number; data: Uint8ClampedArray }> => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + payload
    await img.decode()
    const w = img.naturalWidth
    const h = img.naturalHeight
    const cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    const g = cv.getContext('2d', { willReadFrequently: true })
    if (!g) throw new Error('画面统计：无法获取 2D 上下文（PNG 解码失败）')
    g.drawImage(img, 0, 0)
    return { w, h, data: g.getImageData(0, 0, w, h).data }
  }

  const img = await decodePng(b64)
  const w = img.w
  const h = img.h
  const data = img.data
  /** 像素 (x,y) 的 RGBA 起始下标（直接下标读，不分配 `[r,g,b]`）。 */
  const at = (x: number, y: number): number => (y * w + x) * 4

  // ── 背景：右上角空白带的中位色（与旧口径同采样点、同中位定义）──
  const chR: number[] = []
  const chG: number[] = []
  const chB: number[] = []
  for (let y = Math.floor(h * 0.04); y < Math.floor(h * 0.1); y += 2) {
    for (let x = Math.floor(w * 0.9); x < Math.floor(w * 0.96); x += 2) {
      const i = at(x, y)
      chR.push(data[i]!)
      chG.push(data[i + 1]!)
      chB.push(data[i + 2]!)
    }
  }
  const median = (xs: number[]): number => {
    const s = [...xs].sort((p, q) => p - q)
    return s[Math.floor(s.length / 2)] ?? 0
  }
  const background: [number, number, number] = [median(chR), median(chG), median(chB)]

  // ── 亮度预计算（Rec.709；公式与求和顺序与旧实现逐字一致 ⇒ 同一 double 值）──
  // 旧实现在每个 3×3 邻点上调用一次 lumaOf（内部再取一次像素下标、返回三元数组）；
  // 这里一次性算好，detail 判据只按下标读，**数值不变、每邻点分配归零**。
  const luma = new Float64Array(w * h)
  for (let p = 0, i = 0; p < luma.length; p++, i += 4) {
    luma[p] = lumaR * data[i]! + lumaG * data[i + 1]! + lumaB * data[i + 2]!
  }

  // ── 中央取样区：机器掩码 / 色桶 / 局部细节 / 包围盒 ──
  const x0 = Math.floor(w * 0.22)
  const x1 = Math.floor(w * 0.88)
  const y0 = Math.floor(h * 0.1)
  const y1 = Math.floor(h * 0.9)
  let sampled = 0
  let machinePixels = 0
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  const seen = new Uint8Array(32 * 32 * 32)
  let machineColors = 0
  let detailPixels = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      sampled++
      const i = at(x, y)
      const r = data[i]!
      const gg = data[i + 1]!
      const b = data[i + 2]!
      const diff = Math.max(
        Math.abs(r - background[0]),
        Math.abs(gg - background[1]),
        Math.abs(b - background[2]),
      )
      if (diff <= tol) continue
      machinePixels++
      // 局部对比（3x3 内 luma 极差）：纹理与棱边的证据。
      if (x > x0 && y > y0 && x + 1 < x1 && y + 1 < y1) {
        let minL = 255
        let maxL = 0
        for (let dy = -1; dy <= 1; dy++) {
          const row = (y + dy) * w
          for (let dx = -1; dx <= 1; dx++) {
            const l = luma[row + x + dx]!
            if (l < minL) minL = l
            if (l > maxL) maxL = l
          }
        }
        if (maxL - minL > detailMinRange) detailPixels++
      }
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      const key = ((r >> 3) << 10) | ((gg >> 3) << 5) | (b >> 3)
      if (seen[key] === 0) {
        seen[key] = 1
        machineColors++
      }
    }
  }

  // ── 与 before 的逐像素差异（整幅、全分辨率；任一分量绝对差之和 > changedStep）──
  let compared = false
  let changedPixels = 0
  let changedRatio = 0
  if (compareB64 !== null) {
    compared = true
    const before = await decodePng(compareB64)
    const pa = before.data
    const n = Math.min(pa.length, data.length)
    for (let i = 0; i < n; i += 4) {
      const d =
        Math.abs(pa[i]! - data[i]!) +
        Math.abs(pa[i + 1]! - data[i + 1]!) +
        Math.abs(pa[i + 2]! - data[i + 2]!)
      if (d > changedStep) changedPixels++
    }
    changedRatio = changedPixels / Math.max(1, n / 4)
  }

  return {
    stats: {
      width: w,
      height: h,
      sampled,
      machinePixels,
      machineRatio: machinePixels / Math.max(1, sampled),
      machineColors,
      detailPixels,
      detailRatio: detailPixels / Math.max(1, machinePixels),
      bbox: [minX, minY, maxX, maxY] as [number, number, number, number],
      background,
    },
    compared,
    changedPixels,
    changedRatio,
  }
}

/**
 * 截 `canvas` 的真实画面并算 stats（**全部像素运算在页面内**）。
 *
 * 传了 `compareWith` 就同时算 `changed`：两张 PNG 在**同一个浏览器、同一次 evaluate** 内
 * 解码，逐像素比对后只回一个整数与一个比例。
 */
export async function readPictureStats(
  page: Page,
  canvas: string,
  compareWith: PictureShot,
): Promise<PictureObservation & { readonly changed: PictureChanged }>
export async function readPictureStats(
  page: Page,
  canvas: string,
): Promise<PictureObservation & { readonly changed: null }>
export async function readPictureStats(
  page: Page,
  canvas: string,
  compareWith?: PictureShot,
): Promise<PictureObservation> {
  const png = await page.locator(canvas).first().screenshot()
  const shot: PictureShot = { pngBase64: png.toString('base64'), pngBytes: png.byteLength }
  const probe = await page.evaluate(pictureStatsProbe, {
    b64: shot.pngBase64,
    compareB64: compareWith?.pngBase64 ?? null,
    tol: PICTURE_TOL,
    detailMinRange: PICTURE_DETAIL_MIN_RANGE,
    changedStep: PICTURE_CHANGED_STEP,
    lumaR: PICTURE_LUMA.r,
    lumaG: PICTURE_LUMA.g,
    lumaB: PICTURE_LUMA.b,
  } satisfies PictureProbeArgs)
  return {
    stats: probe.stats,
    shot,
    changed: probe.compared ? { pixels: probe.changedPixels, ratio: probe.changedRatio } : null,
  }
}
