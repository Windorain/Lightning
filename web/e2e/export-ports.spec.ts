/**
 * **P10f/E（#301）· 导出面端口的真实 GL 证据**（真实 Chromium + 真实 WebGL2）。
 *
 * ## 本文件补什么（与 vitest 侧判据的分工，**这是本批的硬边界**）
 *
 * 本仓 `gl@8.1.6`（headless-gl）是 **WebGL 1.0**，而锁定的 `three ^0.174.0`
 * 硬编码请求 **`webgl2`** ⇒ 无头环境下 `new THREE.WebGLRenderer` **必然抛**
 * （实测 `TypeError: gl.texImage3D is not a function`）。`package.json` 属本批硬边界。
 *
 * | 判据面 | 环境 | 证什么 |
 * |---|---|---|
 * | `src/adapters/export/__tests__/exportPorts.test.ts`（E1–E8） | vitest（无 GL，**受控设备**） | 取景映射、逐帧求值键、场景→呈现→编译→挂载、PNG 字节、生命周期、四条失败路径 |
 * | **本文件** | **真 GL** | **真 GPU 真的把像素填进了渲染目标，且能被读回** |
 *
 * 两半都真跑，**没有一半是源码指纹**。少了本文件，"生产级实现"在像素层面
 * 就只能算"接线已就位"——故 Lead 裁决 1 批了本 e2e 窗口。
 *
 * ## 零替身
 *
 * 全程生产类：`assembleSnapshotExportJob` → `SnapshotOffscreenRenderPort` →
 * `createThreeOffscreenDevice`（真 `WebGLRenderer` + `WebGLRenderTarget`）→
 * `readRenderTargetPixels` → `createEncoderPort`（真 PNG 字节）。
 *
 * ## 负对照为什么必须有
 *
 * "非透明像素 > 0"这条判据若不加负对照，就是**恒真**的：任何渲染器吐出的图都
 * "可能有像素"。负对照（**不装任何内容**跑一次，读回必须全透明 ⇒ 端口会
 * **诚实失败**而不是给一张空图）证明该判据确实在检测"真画了东西"。
 */

import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { gotoWorkbench, injectSceneDocumentOk, readFixture, waitForViewportMounted } from './helpers/multiblock'

/** 证据落点（走既有 gitignore 的 `web/e2e/screenshots/`；上传 Gitea 后即持久）。 */
const OUT_DIR = path.join(import.meta.dirname, 'screenshots', 'p10f-export-ports')

interface ExportPortProbeResult {
  note: string
  status: string
  bytesLength: number
  pngMagic: boolean
  ihdrWidth: number
  ihdrHeight: number
  nonTransparent: number
  totalPixels: number
  framesRendered: number
  releasedFor: number
  errorReason: string | null
  cameraSource: 'content-bounds' | 'fallback'
}

/**
 * 在页面里跑探针（经 vite 转译加载，见探针文件头"为什么不裸 import('three')"）。
 */
async function runProbe(page: Page, options: { width?: number; height?: number; negativeEmpty?: boolean }): Promise<ExportPortProbeResult> {
  return (await page.evaluate(async (opts) => {
    const mod = (await import('/e2e/helpers/p10f/exportPortsProbe.ts')) as {
      runExportPortProbe: (o: typeof opts) => Promise<unknown>
    }
    return await mod.runExportPortProbe(opts)
  }, options)) as ExportPortProbeResult
}

interface ExportGifProbeResult {
  note: string
  status: string
  errorReason: string | null
  gifMagic: boolean
  screenWidth: number
  screenHeight: number
  imageCount: number
  delaysCs: number[]
  bytesLength: number
  framesRendered: number
  releasedFor: number
  decodedWidth: number
  decodedHeight: number
  decoderOk: boolean
}

/** 在页面里跑**动画（GIF）**探针（M6-2：真 GL 逐帧 + 组合编码端口的 GIF part）。 */
async function runGifProbe(page: Page, options: { width?: number; height?: number; holdsMs?: number[] }): Promise<ExportGifProbeResult> {
  return (await page.evaluate(async (opts) => {
    const mod = (await import('/e2e/helpers/p10f/exportPortsProbe.ts')) as {
      runExportGifProbe: (o: typeof opts) => Promise<unknown>
    }
    return await mod.runExportGifProbe(opts)
  }, options)) as ExportGifProbeResult
}

test.describe('P10f/E · 导出面端口在真实 GL 下产出 PNG', () => {
  test('真 GL：完整链路跑通，产物是合法 PNG 且**真的有非透明像素**', { tag: '@smoke' }, async ({ page }, testInfo) => {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    await gotoWorkbench(page)
    // 用**真实多方块夹具**（走生产解析器 → 内核装配），使内容面非空。
    const fx = readFixture('multiblock-tier-only.json')
    await injectSceneDocumentOk(page, fx.envelope, 'multiblock-tier-only.json')
    await waitForViewportMounted(page)
    await page.waitForTimeout(1500)

    const result = await runProbe(page, { width: 64, height: 64 })
    console.log('[P10f/E·ports] live =', JSON.stringify(result))

    // ① 作业**真的完成**（不是"接线到了但跑不通"）
    expect(result.status, `作业必须完成（note=${result.note} reason=${result.errorReason}）`).toBe('completed')
    // ①b 取景必须**由内容包围盒导出**（`fallback` 说明呈现根尚未装配 ⇒ 取景可能与内容
    //     不匹配而读出 0 像素，那是**探针取景问题**、不是实现缺陷 —— 必须能区分开）。
    expect(
      result.cameraSource,
      '取景必须由内容包围盒导出（fallback 下"0 像素"不能归因于实现）',
    ).toBe('content-bounds')
    // ② 产物是**真 PNG**（魔数 + IHDR 尺寸 == 请求）
    expect(result.pngMagic, '产物必须是 PNG（魔数）').toBe(true)
    expect(result.ihdrWidth, 'IHDR 宽必须等于请求宽').toBe(64)
    expect(result.ihdrHeight, 'IHDR 高必须等于请求高').toBe(64)
    expect(result.bytesLength, '产物必须是真实字节（非空）').toBeGreaterThan(100)
    // ③ **真 GL 真的画了东西**：独立解码后必须有非透明像素
    expect(result.totalPixels, '图片必须可被浏览器解码器解开').toBe(64 * 64)
    expect(
      result.nonTransparent,
      '读回的像素里必须有非透明像素 —— 这证明真 GL 把内容画进了渲染目标',
    ).toBeGreaterThan(0)
    // ④ 生命周期正确
    expect(result.framesRendered, '单帧请求 ⇒ 恰好渲染 1 帧').toBe(1)
    expect(result.releasedFor, '分配句柄数必须非零且被释放').toBeGreaterThan(0)

    // 证据落盘（gitignore 内；上传 Gitea 后持久）
    fs.writeFileSync(
      path.join(OUT_DIR, `p10f-e-port-probe-${testInfo.workerIndex}.json`),
      JSON.stringify(result, null, 2),
      'utf8',
    )
  })

  test('**负对照**：不装任何内容 ⇒ 端口**诚实失败**（不产出"看起来成功"的空图）', async ({ page }) => {
    await gotoWorkbench(page)
    const fx = readFixture('multiblock-tier-only.json')
    await injectSceneDocumentOk(page, fx.envelope, 'multiblock-tier-only.json')
    await waitForViewportMounted(page)
    await page.waitForTimeout(1000)

    const result = await runProbe(page, { width: 32, height: 32, negativeEmpty: true })
    console.log('[P10f/E·ports] negative =', JSON.stringify(result))

    // 空场景**没有**可绘制内容 ⇒ 端口必须判失败（`offscreenNoDrawableContent`），
    // 而不是产出一张全透明的 PNG 冒充成功。
    expect(result.status, '空内容必须**失败**，不得产出空图冒充完整').toBe('failed')
    expect(result.errorReason, '失败原因必须是"没有可绘制内容"').toBe('offscreenNoDrawableContent')
    expect(result.bytesLength, '失败路径不得产出任何字节').toBe(0)
    expect(result.nonTransparent, '失败路径不得有像素').toBe(0)
  })
})
test.describe('M6-2 · 真 GL 下的**动画**导出（逐帧 hold → GIF 字节）', () => {
  test('真 GL：三帧不等驻留 ⇒ 真 GIF89a，帧数/逐帧 delay/尺寸逐项等于声明', { tag: '@smoke' }, async ({ page }, testInfo) => {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    await gotoWorkbench(page)
    const fx = readFixture('multiblock-tier-only.json')
    await injectSceneDocumentOk(page, fx.envelope, 'multiblock-tier-only.json')
    await waitForViewportMounted(page)
    await page.waitForTimeout(1500)

    const holds = [50, 100, 50]
    const result = await runGifProbe(page, { width: 32, height: 32, holdsMs: holds })
    console.log('[M6-2·gif] live =', JSON.stringify(result))

    // ① 作业真的完成（不是"GIF part 接线到了但跑不通"）
    expect(result.status, '作业必须完成（note=' + result.note + ' reason=' + String(result.errorReason) + '）').toBe('completed')
    // ② 产物是**真 GIF89a**，且尺寸等于请求
    expect(result.gifMagic, '产物必须是 GIF89a（魔数）').toBe(true)
    expect(result.screenWidth, 'GIF 逻辑屏幕宽必须等于请求宽').toBe(32)
    expect(result.screenHeight, 'GIF 逻辑屏幕高必须等于请求高').toBe(32)
    expect(result.bytesLength, '产物必须是真实字节（非空）').toBeGreaterThan(100)
    // ③ 帧数 == 请求采样数（少渲一帧必须被抓到，而不是静默产出短 GIF）
    expect(result.framesRendered, '三帧请求必须真渲染三次').toBe(3)
    expect(result.imageCount, 'GIF 里的图像个数必须等于帧数').toBe(3)
    // ④ **逐帧时延来自声明**：[50,100,50] ⇒ [5,10,5]（旧"ticks*5 自算"会给 [5,5,5]）
    expect(result.delaysCs, '逐帧 delay 必须等于 holdMs/10（不等时长 ⇒ [5,10,5]）').toEqual([5, 10, 5])
    expect(result.delaysCs, '不得退化成"每帧同值"的自算结果').not.toEqual([5, 5, 5])
    // ⑤ 浏览器**解码器**能解开（独立于编码器的判据）
    expect(result.decoderOk, '产物必须能被浏览器解码器解开').toBe(true)
    expect(result.decodedWidth, '解码宽度必须等于请求宽').toBe(32)
    expect(result.decodedHeight, '解码高度必须等于请求高').toBe(32)
    // ⑥ 生命周期
    expect(result.releasedFor, '分配句柄数必须非零且被释放').toBeGreaterThan(0)

    fs.writeFileSync(
      path.join(OUT_DIR, 'm6-2-gif-probe-' + testInfo.workerIndex + '.json'),
      JSON.stringify(result, null, 2),
      'utf8',
    )
  })

  test('**负对照**：同一份内容走 PNG 端口编 animation ⇒ 显式失败（组合端口不是"一个端口声称全能"）', async ({ page }) => {
    await gotoWorkbench(page)
    const fx = readFixture('multiblock-tier-only.json')
    await injectSceneDocumentOk(page, fx.envelope, 'multiblock-tier-only.json')
    await waitForViewportMounted(page)
    await page.waitForTimeout(1000)

    // 在页面里直接调 PNG part 编动画：必须 encoderKindUnsupported（而不是"按 PNG 编出来"）。
    const reason = await page.evaluate(async () => {
      const [{ createPngEncoderPort }, { planExportRequest }] = await Promise.all([
        import('/src/adapters/export/encoderPort.ts'),
        import('/src/application/exportPlan.ts'),
      ])
      const ctx = (window as unknown as { __vm__?: Record<string, any> }).__vm__
      const doc = ctx?.kernel?.document?.()
      if (doc === undefined || doc === null) return 'no-live-kernel-document'
      const animation = { tracks: {}, defaults: {} }
      const spec = {
        frameRate: 20,
        frameCount: 1,
        mapping: { source: 'scene', startFrame: 0, stepFrames: 1 },
        channels: {},
        camera: {
          kind: 'view',
          label: 'm6-2-neg',
          view: {
            projection: 'perspective',
            position: { x: 40, y: 40, z: 40 },
            target: { x: 0, y: 0, z: 0 },
            up: { x: 0, y: 1, z: 0 },
            fovDegrees: 45,
            near: 0.1,
            far: 5000,
          },
        },
        render: { width: 8, height: 8, background: 'transparent' },
        animation,
      }
      const planned = planExportRequest({
        requestId: 'm6-2-neg',
        now: 0,
        documentId: 'live',
        version: { documentVersion: 1, contentVersion: 1 },
        scene: doc.scene,
        animation,
        camera: spec.camera,
        spec,
        assets: [],
      })
      if (!planned.ok) return 'plan-failed:' + planned.error.code
      const frame = {
        index: 0,
        time: planned.value.frames[0],
        pixels: new Uint8Array(8 * 8 * 4),
        width: 8,
        height: 8,
        holdMs: 50,
      }
      const r = await createPngEncoderPort().encode({
        request: planned.value,
        kind: 'animation',
        encoding: 'gif',
        rendered: [frame],
        signal: { cancelled: false },
      })
      return r.ok ? 'unexpected-success' : String(r.error.params.reason)
    })
    console.log('[M6-2·gif] png-part-on-animation =', reason)
    expect(reason, 'PNG 端口编 animation 必须显式拒绝').toBe('encoderKindUnsupported')
  })
})
