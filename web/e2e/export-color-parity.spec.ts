/**
 * **M6-3 修复环 · 色彩一致性判据（导出必须与屏上同观感）**。
 *
 * ## 缺口（为什么必须有这一条）
 *
 * | 既有判据 | 比的是什么 | 漏掉的 |
 * |---|---|---|
 * | C9（GIF 首帧 ≈ 同参数 PNG） | 导出 vs 导出 | 两条导出链同时偏暗也"相等" |
 * | ② sampling-parity | 采样**参数** | 参数相同 ≠ 像素值相同 |
 * | texture-time-dual-area | 视口 vs 视口 | 不涉及导出 |
 *
 * 实测（修复前）：同一夹具、同一参数，导出平均亮度 **38.79**，
 * 画布输出 **96.77**、活视口 **≈96.8** —— 导出与"线性写出"**逐位相同**。
 *
 * ## 判据（三条，缺一不可）
 *
 * 1. **导出 vs 画布输出**（= 视口所用的输出阶段）：同一会话、同一相机、同一尺寸、
 *    同一资源表，只把"输出到哪"换成画布 ⇒ 平均亮度与主色必须一致；
 * 2. **导出 vs 活视口**：视口内容像素的亮度/主色与导出一致；
 * 3. **负对照**：同一次渲染改成**线性写出**（`LinearSRGBColorSpace`）⇒ 与导出的差异
 *    必须**远超**容差 —— 证明容差不是恒真，且"改回线性"会被同一条判据判红。
 *
 * ## 容差怎么定（先量噪声地板，再定阈值）
 *
 * - 噪声地板 = 同状态两次测量的相对差（日志 `[M6-3·color] noiseRel`，实测 0）；
 * - 容差 = `max(噪声地板 × 3, 0.08)`（8%）。依据：修复前偏差 **-60%** 是容差的 7.5 倍；
 *   而抗锯齿/取景差异造成的正常偏差实测 < 2%。
 * - 主色容差 12 级（贴图源色 198/86/64）：覆盖"8 位线性渲染目标"的量化上限（约 6 级）。
 *
 * ## 为什么夹具必须是**中调**色
 *
 * 0 与 255 是 sRGB 传递函数的**不动点** ⇒ 纯红/纯白/纯黑在两态下字节相同，判据会恒真。
 * `color-midtone.v2.json` 用 #C65640（中调砖红），两态相差近一倍。
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import path from 'node:path'
import { gotoWorkbench, injectSceneDocumentOk, waitForViewportMounted } from './helpers/multiblock'
import { readJson } from './helpers/saveReopen'
import { TERMINAL_TEXTURE_STATES, waitTextureState } from './helpers/viewportPixels'

/** 贴图源色（sRGB 字节）：判据用它核对"主色没漂"，**不从被测实现读**。 */
const SOURCE_COLOR = [198, 86, 64] as const
const MODAL_TOLERANCE = 12

interface ColorStats {
  width: number
  height: number
  pixels: number
  meanLuma: number
  meanRgb: readonly number[]
  modalColor: readonly number[]
  modalShare: number
  topColors: readonly (readonly number[])[]
}

interface ColorParityResult {
  note: string
  export: ColorStats | null
  exportBytes: number
  referenceSrgb: ColorStats | null
  referenceLinear: ColorStats | null
  referenceSrgb2: ColorStats | null
}

async function measure(page: Page, pixelSize: number): Promise<ColorParityResult> {
  return (await page.evaluate(async (size: number) => {
    const mod = (await import('/e2e/helpers/m6-3/colorParityProbe.ts')) as {
      measureColorParity: (o: { pixelSize: number }) => Promise<unknown>
    }
    return await mod.measureColorParity({ pixelSize: size })
  }, pixelSize)) as ColorParityResult
}

/**
 * 视口**内容像素**读数（经 `slot.domElement`，与 `sampleViewport` 同一取帧手法）。
 *
 * ## 掩码为什么是"离背景色足够远"
 *
 * 工作台背景实测是中性 88/88/88（`viewportHistogram` 单色占 92%）。夹具是中调砖红
 * ⇒ `|ΔR|+|ΔG|+|ΔB| > 24` 精确圈出"贴图内容"，不依赖彩度阈值（砖红的彩度与某些高光接近）。
 */
async function viewportContent(page: Page): Promise<ColorStats> {
  return (await page.evaluate(async () => {
    const ctx = (window as unknown as { __vm__?: Record<string, any> }).__vm__
    const cells = Array.from(document.querySelectorAll('.area-node--leaf[data-area-id]') as NodeListOf<HTMLElement>)
    const ids = cells.map((c) => c.dataset.wmRegion ?? '').filter((r) => r !== '')
    let canvas: HTMLCanvasElement | null = null
    for (const id of ids) {
      const c = ctx?.viewports?.get?.(id)?.domElement?.value as HTMLCanvasElement | undefined
      if (c?.tagName === 'CANVAS') { canvas = c; break }
    }
    if (canvas === null) throw new Error('视口 canvas 不存在（视口未挂载）')
    const c = document.createElement('canvas')
    c.width = canvas.width
    c.height = canvas.height
    const g = c.getContext('2d', { willReadFrequently: true })!
    g.fillStyle = '#000'
    g.fillRect(0, 0, c.width, c.height)
    g.drawImage(canvas, 0, 0)
    const { data } = g.getImageData(0, 0, c.width, c.height)
    let n = 0, sr = 0, sg = 0, sb = 0, sl = 0
    const counts = new Map<number, { c: number; r: number; g: number; b: number }>()
    for (let i = 0; i < c.width * c.height; i++) {
      const o = i * 4
      const r = data[o]!, gg = data[o + 1]!, b = data[o + 2]!
      if (Math.abs(r - 88) + Math.abs(gg - 88) + Math.abs(b - 88) <= 24) continue
      n += 1; sr += r; sg += gg; sb += b
      sl += 0.2126 * r + 0.7152 * gg + 0.0722 * b
      const key = ((r >> 4) << 8) | ((gg >> 4) << 4) | (b >> 4)
      const e = counts.get(key) ?? { c: 0, r: 0, g: 0, b: 0 }
      e.c += 1; e.r += r; e.g += gg; e.b += b
      counts.set(key, e)
    }
    const ordered = [...counts.values()].sort((a, b2) => b2.c - a.c)
    const top = ordered[0]
    const den = top?.c ?? 1
    const topColors = ordered.slice(0, 5).map((x) => [x.r / x.c, x.g / x.c, x.b / x.c] as readonly number[])
    return {
      width: c.width, height: c.height, pixels: n,
      meanLuma: n ? sl / n : 0,
      meanRgb: n ? [sr / n, sg / n, sb / n] : [0, 0, 0],
      modalColor: top ? [top.r / den, top.g / den, top.b / den] : [0, 0, 0],
      modalShare: n ? (top?.c ?? 0) / n : 0,
      topColors,
    }
  })) as ColorStats
}

function rel(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(1, b)
}

test.describe('M6-3 · 导出与屏上**同观感**（色彩一致性）', () => {
  test('导出亮度/主色 == 画布输出 == 活视口；线性写出必须判红', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '导出判据固定在 desktop-chrome')
    await gotoWorkbench(page)
    await injectSceneDocumentOk(
      page,
      readJson(path.join(import.meta.dirname, 'fixtures', 'color-midtone.v2.json')),
      'color-midtone.v2.json',
    )
    await waitForViewportMounted(page)
    expect(await waitTextureState(page, TERMINAL_TEXTURE_STATES, '纹理终态', 120_000), '夹具必须就绪').toBe('ready')
    await page.waitForTimeout(1200)

    const first = await measure(page, 160)
    const second = await measure(page, 160)
    const vp1 = await viewportContent(page)
    const vp2 = await viewportContent(page)
    console.log('[M6-3·color] export=' + JSON.stringify(first.export))
    console.log('[M6-3·color] refSrgb=' + JSON.stringify(first.referenceSrgb))
    console.log('[M6-3·color] refLinear=' + JSON.stringify(first.referenceLinear))
    console.log('[M6-3·color] viewport=' + JSON.stringify(vp1))

    expect(first.note, '探针必须跑通（note=' + first.note + '）').toBe('ok')
    expect(first.export, '导出必须产出像素').not.toBeNull()
    expect(first.referenceSrgb, '参考渲染必须产出像素').not.toBeNull()
    expect(first.referenceLinear, '线性负对照必须产出像素').not.toBeNull()
    // 反空洞真：三边都必须有内容像素（否则均值是 0 vs 0 的空转）
    expect(first.export!.pixels, '导出必须有内容像素').toBeGreaterThan(1000)
    expect(first.referenceSrgb!.pixels, '参考渲染必须有内容像素').toBeGreaterThan(1000)
    expect(vp1.pixels, '视口必须圈出内容像素').toBeGreaterThan(1000)

    const noise = Math.max(
      rel(first.export!.meanLuma, second.export!.meanLuma),
      rel(first.referenceSrgb!.meanLuma, second.referenceSrgb!.meanLuma),
      rel(vp1.meanLuma, vp2.meanLuma),
    )
    console.log('[M6-3·color] noiseRel=' + noise.toFixed(4))
    const TOL = Math.max(noise * 3, 0.08)

    // ── ① 导出 vs 画布输出（同一会话/相机/尺寸/资源表，唯一差别是输出阶段）──
    const d1 = rel(first.export!.meanLuma, first.referenceSrgb!.meanLuma)
    console.log('[M6-3·color] luma export=' + first.export!.meanLuma.toFixed(2)
      + ' refSrgb=' + first.referenceSrgb!.meanLuma.toFixed(2)
      + ' refLinear=' + first.referenceLinear!.meanLuma.toFixed(2)
      + ' viewport=' + vp1.meanLuma.toFixed(2)
      + ' | d(export,refSrgb)=' + d1.toFixed(4) + ' tol=' + TOL.toFixed(3))
    expect(d1, '导出平均亮度必须与**画布输出**一致（线性写出会系统性偏暗）').toBeLessThanOrEqual(TOL)
    for (let i = 0; i < 3; i += 1) {
      expect(rel(first.export!.meanRgb[i]!, first.referenceSrgb!.meanRgb[i]!), '通道 ' + i + ' 均值必须一致').toBeLessThanOrEqual(TOL)
      expect(
        Math.abs(first.export!.modalColor[i]! - first.referenceSrgb!.modalColor[i]!),
        '通道 ' + i + ' 主色必须一致（偏色也要被抓到）',
      ).toBeLessThanOrEqual(MODAL_TOLERANCE)
    }

    // ── ② 导出 vs 活视口 ──
    expect(rel(first.export!.meanLuma, vp1.meanLuma), '导出平均亮度必须与**屏上视口**一致').toBeLessThanOrEqual(TOL)
    for (let i = 0; i < 3; i += 1) {
      expect(rel(first.export!.meanRgb[i]!, vp1.meanRgb[i]!), '通道 ' + i + ' 的均值必须与屏上一致').toBeLessThanOrEqual(TOL)
    }
    /**
     * **主色**的对账口径：导出的主色必须出现在视口的前 5 个主色里（容差内）。
     *
     * 几何顶点色里烘焙了逐面明暗 ⇒ 同一贴图在不同朝向的面上亮度不同，"哪一面占主导"
     * 会随取景变化（实测同一夹具两次测量主色 198 vs 179）。只比单一主色会把
     * "选面不同"误判成"偏色"；而线性写出会让**整组**主色下移约 50 级，
     * 故"整组里找不到"仍然精确判红。
     */
    const nearest = vp1.topColors
      .map((c) => Math.max(...c.map((v, i) => Math.abs(v - first.export!.modalColor[i]!))))
      .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY)
    console.log('[M6-3·color] modalMatch=' + JSON.stringify({
      exportModal: first.export!.modalColor,
      viewportTop: vp1.topColors.map((c) => c.map((v) => Math.round(v))),
      nearest: Math.round(nearest),
    }))
    expect(nearest, '导出的主色必须出现在视口的前 5 个主色里（容差 ' + MODAL_TOLERANCE + '）').toBeLessThanOrEqual(MODAL_TOLERANCE)
    // 主色还必须落在**贴图源色**附近（防止两边一起错到同一个地方）
    for (let i = 0; i < 3; i += 1) {
      expect(
        Math.abs(first.export!.modalColor[i]! - SOURCE_COLOR[i]!),
        '导出主色必须等于贴图源色（通道 ' + i + '）',
      ).toBeLessThanOrEqual(MODAL_TOLERANCE)
    }

    // ── ③ 负对照：线性写出必须被判据判红 ──
    const negVsSrgb = rel(first.referenceLinear!.meanLuma, first.referenceSrgb!.meanLuma)
    const negVsExport = rel(first.referenceLinear!.meanLuma, first.export!.meanLuma)
    console.log('[M6-3·color] negative=' + JSON.stringify({
      linear: first.referenceLinear!.meanLuma.toFixed(2),
      vsSrgb: negVsSrgb.toFixed(3), vsExport: negVsExport.toFixed(3), tol: TOL.toFixed(3),
    }))
    expect(negVsSrgb, '线性写出与 sRGB 输出的差异必须远超容差（否则容差恒真）').toBeGreaterThan(TOL * 3)
    expect(negVsExport, '若导出退回线性写出，同一条容差必须判红').toBeGreaterThan(TOL * 3)
  })
})
