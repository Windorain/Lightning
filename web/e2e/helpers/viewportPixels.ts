/**
 * M2-4 · **呈现画面的像素判据原语**（就绪门 + 像素读回 + 颜色分布）。
 *
 * ## 为什么要单独一个 helper（缺口 1 的落点）
 *
 * M1 复核 §3.2 #1：4 份 kernel spec 只截图、**零** sha/snapshot 断言 ——
 * 「有真实几何、10–15 s 后有真实纹理、不是白模」这条核心观感没有任何自动判据。
 * 但"像素判据"很容易写成假绿，本文件把四个坑固定在原语里：
 *
 *  1. **就绪门必须是事实信号**：采样一律要求调用方声明"此刻应当处于哪个
 *     `data-texture-state`"（M2-3 落地的机器可读状态），并在**读像素前后各读一次**核对。
 *     门不满足时以 `'ready'` 门采样会**直接抛错** —— 这正是"纹理未就绪门未满足时
 *     不得采样当就绪证据"的判据化（负对照由 spec 调用）。禁止 `waitForTimeout` 当门。
 *  2. **像素读回必须够快**：真实的白模窗口实测只有约 0.9 s（t≈0.9 s loading →
 *     t≈1.8 s ready），而 `locator.screenshot()` 的一次 PNG 往返就可能跨过整个窗口
 *     （实测：唯一一次尝试被"采样期间状态翻转"拒绝）。故像素在**页面内**读：
 *     `drawImage(视口 canvas → 2D canvas) + getImageData`，状态读与像素读在**同一次
 *     evaluate** 内完成，窗口内可采到多帧。若改用截图，判据只能碰运气。
 *  3. **读的是产品自己暴露的 canvas**：`slot.domElement`（`renderViewport.ts:71` 的
 *     `renderer.domElement`）。该渲染器本来就带 `preserveDrawingBuffer: true`
 *     （`renderViewport.ts:55`，产品为等距导出开的），故任意时刻 `drawImage` 拿到的是
 *     最后渲染的那一帧 —— 不读 WebGL 私有 drawingBuffer、不改产品选项。
 *     （若哪天该选项被关，读回会是空帧 ⇒ `blankViolations` 当场判红，不会假绿。）
 *  4. **统计口径与既有 `multiblock/pixels.ts` 逐条一致**（同一套 5bit 色桶、Rec.709
 *     亮度、16×16 灰度签名），所以那里按实测标定的阈值在本文件同样成立
 *     —— 阈值与差分判据直接复用，不另立一套。
 *
 * ## 字节口径（铁律 6）
 *
 * sha256 算的是**原始 RGBA 像素缓冲**（页面内 `crypto.subtle.digest`），
 * 不是文本文件、**不落盘**任何快照 ⇒ 与 `core.autocrlf` 无关，
 * 也不受 PNG 编码器非确定性影响。
 */

import { expect, type Page } from '@playwright/test'
import type { PixelStats } from './multiblock/pixels'

/** 状态栏根节点（`StatusBar.vue`；`data-texture-state` 的宿主）。 */
export const STATUS_BAR = '.sb-root'
/** 纹理五态的终态集合（#399：就绪 / 缺失 / 失败；loading 是过程态）。 */
export const TERMINAL_TEXTURE_STATES = ['ready', 'missing', 'failed'] as const

/** 当前机器可读纹理状态（未写入 ⇒ null）。 */
export async function readTextureState(page: Page): Promise<string | null> {
  return await page.locator(STATUS_BAR).getAttribute('data-texture-state')
}

/** 粘性「loading 曾被观察到」标记（M2-3 读面）。 */
export async function readLoadingSeen(page: Page): Promise<string | null> {
  return await page.locator(STATUS_BAR).getAttribute('data-texture-loading-seen')
}

/**
 * 等 `data-texture-state` 落进给定集合（事实信号；不 sleep）。
 * 超时抛错并带上最后一次读数，避免"只知超时，不知卡在哪一态"。
 */
export async function waitTextureState(
  page: Page,
  states: readonly string[],
  label: string,
  timeout = 120_000,
): Promise<string> {
  let last: string | null = null
  const deadline = Date.now() + timeout
  for (;;) {
    last = await readTextureState(page)
    if (last !== null && states.includes(last)) return last
    if (Date.now() > deadline) {
      throw new Error(
        `M2-4：等待纹理状态超时（${timeout}ms）—— ${label}；最后一次 data-texture-state=${String(last)}`,
      )
    }
    await page.waitForTimeout(40)
  }
}

/**
 * 等 region 槽位**活着**（camera + definition + domElement 同时非空）。
 *
 * `RenderEngineHost` 只在 `loadStatus === 'ok'` 时挂载，挂载与相机初始化都是异步的。
 * 条件与 `helpers/parts/hover.ts` 逐字相同（P6 记录：只查"字段非空"会对已 dispose
 * 的句柄成立，故三件必须同时在）。
 */
export async function waitViewportLive(page: Page, rid: string, timeout = 60_000): Promise<void> {
  await page.waitForFunction(
    (regionId) => {
      const slot = (window as any).__vm__?.viewports?.get(regionId)
      return !!slot?.camera?.value && !!slot?.definition?.value && !!slot?.domElement?.value
    },
    rid,
    { timeout },
  )
}

/** 引擎侧机位签名（只取决定取景的稳定字段；理由见 `kernel-viewport-camera.spec.ts`）。 */
export async function readCameraPose(page: Page, rid: string): Promise<unknown> {
  return await page.evaluate((regionId) => {
    const cam = (window as any).__vm__?.viewports?.get(regionId)?.camera?.value
    if (!cam) return null
    cam.updateMatrixWorld()
    return {
      m: [...cam.matrixWorld.elements],
      zoom: cam.zoom,
      frustum: [cam.left, cam.right, cam.top, cam.bottom],
    }
  }, rid)
}

/** 等引擎机位稳定（连续两次读数一致；`initialCamera` 是异步 fit）。 */
export async function waitCameraStable(page: Page, rid: string, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout
  let prev = JSON.stringify(await readCameraPose(page, rid))
  for (;;) {
    await page.waitForTimeout(150)
    const cur = JSON.stringify(await readCameraPose(page, rid))
    if (cur !== 'null' && cur === prev) return
    prev = cur
    if (Date.now() > deadline) throw new Error(`M2-4：region ${rid} 机位在 ${timeout}ms 内未稳定`)
  }
}

/** 一次纹理状态变迁（页面时钟；DOM 事实，不读产品内部状态）。 */
export interface TextureTick {
  t: number
  state: string | null
}

/**
 * 在**装载之前**开始记录 `data-texture-state` 的每次变迁。
 *
 * 用途与 #399 的 T1 相同：白模窗口很窄，瞬时快照会错过"曾经 loading"；
 * 装在这里让像素判据在失败时能给出完整时间线（而不是只报一句超时）。
 */
export async function traceTextureStates(page: Page): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (el === null) throw new Error('M2-4: 状态栏根节点不存在（' + sel + '）')
    const w = window as unknown as { __tex_state_trace__?: TextureTick[] }
    const out: TextureTick[] = []
    w.__tex_state_trace__ = out
    const snap = (): void => {
      out.push({ t: Math.round(performance.now()), state: el.getAttribute('data-texture-state') })
    }
    snap()
    new MutationObserver(snap).observe(el, { attributes: true, attributeFilter: ['data-texture-state'] })
  }, STATUS_BAR)
}

/** 读回纹理状态时间线。 */
export async function textureStateTrace(page: Page): Promise<TextureTick[]> {
  return (await page.evaluate(
    () => (window as unknown as { __tex_state_trace__?: TextureTick[] }).__tex_state_trace__ ?? [],
  )) as TextureTick[]
}

/**
 * 颜色分布（"是不是单一中性灰"的机械判据）。
 *
 * - `chromaticRatio`：彩度（max−min 通道差）> 16 且亮度 > 20 的像素占比。
 *   白模 = 灰阶明暗（彩度≈0）⇒ 接近 0；贴图/彩色方块 ⇒ 显著大于 0。
 * - `dominantColorShare`：4 bit/通道量化后**最常见色**的占比（单一色画面 ⇒ 接近 1）。
 * - `neutralGrayRatio`：彩度 ≤ 6 的像素占比（"中性灰"的字面读面）。
 *
 * 阈值在 spec 里按**实测值**标定并记录。
 */
export interface ChromaStats {
  chromaticRatio: number
  dominantColorShare: number
  neutralGrayRatio: number
}

/** 一次"门控采样"的完整读数（证据链：状态 + 像素 sha + 统计 + 签名 + 颜色分布 + 机位）。 */
export interface ViewportSample {
  /** 采样时刻的 `data-texture-state`（门已核对，前后各一次）。 */
  state: string
  /** 原始 RGBA 像素缓冲的 sha256（页面内计算）。 */
  sha256: string
  /** 像素数（w×h）。 */
  pixels: number
  width: number
  height: number
  stats: PixelStats
  /** 16×16 灰度签名（与 `multiblock/pixels.ts#readPixelSignature` 同算法）。 */
  signature: number[]
  chroma: ChromaStats
  /** 采样时刻的引擎机位（证明两次采样之间没有相机移动）。 */
  camera: unknown
}

/**
 * **门控采样**：只有 `data-texture-state` ∈ `expectedStates` 才允许读像素。
 *
 * 读像素前后各读一次状态并都要求落进 `expectedStates` —— 后者防"读像素期间状态翻页"。
 * 门不满足时抛出的错误带 `未就绪` 字样，供负对照断言"这次采样必须被拒"。
 * 拒绝发生在**读像素之前**（无副作用、开销可忽略），故可以在窗口内安全地反复试门。
 */
export async function sampleViewport(
  page: Page,
  rid: string,
  expectedStates: readonly string[],
  label: string,
): Promise<ViewportSample> {
  const camera = await readCameraPose(page, rid)
  const read = await page.evaluate(
    async ({ regionId, expected }) => {
      const stateOf = (): string | null =>
        document.querySelector('.sb-root')?.getAttribute('data-texture-state') ?? null
      const stateBefore = stateOf()
      if (stateBefore === null || !expected.includes(stateBefore)) {
        return { refused: `未就绪（data-texture-state=${String(stateBefore)}，期望 ${expected.join('|')}）` }
      }
      const slot = (window as any).__vm__?.viewports?.get(regionId)
      const gl = slot?.domElement?.value as HTMLCanvasElement | null
      if (!gl || gl.tagName !== 'CANVAS') return { refused: '视口 canvas 不存在（视口未挂载）' }
      const w = gl.width
      const h = gl.height
      if (w === 0 || h === 0) return { refused: `视口 canvas 尺寸为 0（${w}×${h}）` }
      // 2D 暂存：先铺不透明底色（视口 canvas 带 alpha），再把这一帧画上去。
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const g = c.getContext('2d', { willReadFrequently: true })
      if (!g) return { refused: '无法获取 2D 上下文（读像素失败）' }
      g.fillStyle = '#000'
      g.fillRect(0, 0, w, h)
      g.drawImage(gl, 0, 0)
      const { data } = g.getImageData(0, 0, w, h)
      const stateAfter = stateOf()

      // ── 统计（与 multiblock/pixels.ts 逐条同口径）──
      const seen = new Uint8Array(32 * 32 * 32)
      let uniqueColors = 0
      let sum = 0
      let sumSq = 0
      let minLuma = 255
      let maxLuma = 0
      let nonBlack = 0
      let chromatic = 0
      let neutral = 0
      const counts = new Uint32Array(16 * 16 * 16)
      const n = w * h
      const GRID = 16
      const gridSum = new Float64Array(GRID * GRID)
      const gridCnt = new Float64Array(GRID * GRID)
      for (let y = 0; y < h; y++) {
        const gy = Math.min(GRID - 1, Math.floor((y * GRID) / h))
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4
          const r = data[i]!
          const gg = data[i + 1]!
          const b = data[i + 2]!
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
          if (luma > 16) nonBlack++
          const spread = Math.max(r, gg, b) - Math.min(r, gg, b)
          if (spread > 16 && luma > 20) chromatic++
          if (spread <= 6) neutral++
          const ck = ((r >> 4) << 8) | ((gg >> 4) << 4) | (b >> 4)
          counts[ck]! += 1
          const gk = gy * GRID + Math.min(GRID - 1, Math.floor((x * GRID) / w))
          gridSum[gk]! += luma
          gridCnt[gk]! += 1
        }
      }
      let top = 0
      for (let i = 0; i < counts.length; i++) if (counts[i]! > top) top = counts[i]!
      const mean = sum / n
      const variance = Math.max(0, sumSq / n - mean * mean)
      const signature: number[] = []
      for (let k = 0; k < gridSum.length; k++) {
        signature.push(gridCnt[k]! > 0 ? gridSum[k]! / gridCnt[k]! : 0)
      }
      // ── 原始 RGBA 的 sha256（页面内；不受 PNG 编码器影响）──
      const digest = await crypto.subtle.digest('SHA-256', data)
      const sha256 = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('')
      return {
        stateBefore,
        stateAfter,
        width: w,
        height: h,
        pixels: n,
        sha256,
        signature,
        stats: {
          width: w,
          height: h,
          pixels: n,
          uniqueColors,
          stdDevLuma: Math.sqrt(variance),
          meanLuma: mean,
          minLuma,
          maxLuma,
          nonBlackRatio: nonBlack / n,
        },
        chroma: {
          chromaticRatio: chromatic / n,
          dominantColorShare: top / n,
          neutralGrayRatio: neutral / n,
        },
      }
    },
    { regionId: rid, expected: [...expectedStates] },
  )

  if ('refused' in read) {
    throw new Error(`${label}：${read.refused} —— 不得把这一帧当作就绪证据`)
  }
  if (read.stateAfter !== read.stateBefore) {
    throw new Error(
      `${label}：采样期间纹理状态翻转（前 ${read.stateBefore} → 后 ${String(read.stateAfter)}），这一帧不属于单一状态，不得当证据`,
    )
  }
  expect(read.stateBefore, `${label}：采样状态必须是期望值之一`).toBeTruthy()
  return {
    state: read.stateBefore!,
    sha256: read.sha256,
    pixels: read.pixels,
    width: read.width,
    height: read.height,
    stats: read.stats,
    signature: read.signature,
    chroma: read.chroma,
    camera,
  }
}
