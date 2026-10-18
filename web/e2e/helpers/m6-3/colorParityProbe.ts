/**
 * **M6-3 修复环 · 色彩一致性探针**（导出产物 vs 屏上观感）。
 *
 * ## 为什么需要它（既有判据都不覆盖这一维）
 *
 * | 既有判据 | 它比的是什么 | 为什么不覆盖 |
 * |---|---|---|
 * | `export-scene-gif` C9 | **导出**（GIF 首帧）vs **导出**（同参数 PNG） | 两边都是导出链，同时偏暗也相等 |
 * | `export-sampling-parity` ② | 采样**参数**（frame/offset/repeat…） | 参数相同不代表写出的**像素值**相同 |
 * | `texture-time-dual-area` | 视口 vs 视口 | 不涉及导出 |
 *
 * ⇒ 本探针补的是**输出编码这一跳**：同一份场景、同一台相机、同样大小，
 * 分别经（a）生产导出链、（b）画布输出（= 视口用的那条输出阶段）、
 * （c）画布输出但线性写出（负对照状态），三者的像素读数必须能区分 (b) 与 (c)。
 *
 * ## 为什么 (b)/(c) 是同一份会话的两次渲染（而不是另建一条链）
 *
 * 参考渲染复用**生产呈现会话**（createPresenterSession + applyIfChanged +
 * bindTextures）与**生产相机值**（threeCameraOf(request.camera, request.render)），
 * 只把输出到哪换成画布 —— 于是三者的差别**只有输出编码**这一项。
 */

import * as THREE from 'three'
import { createDomTextureDecoder } from '@/adapters/textureDecode'
import { runIsoExport } from '@/workbench/export/isoExportJob'
import { captureExportSnapshot, type ExportCapture, type ExportCaptureSource } from '@/composition/exportCapture'
import { createPresenterSession } from '@/composition/presenterSession'
import { threeCameraOf } from '@/presentation/offscreenCamera'
import { evaluationKeyOf } from '@/application/exportPlan'
import { createRendererTextureUpload } from '@/adapters/export/offscreenTextureUpload'
import { texturePortOf } from '@/presentation/textureUploadPort'
import { nextDeviceScope } from '@/presentation/resourceCache'
import type { Scene } from '@/domain/scene'

type Vm = Record<string, any>

function vm(): Vm {
  return (window as unknown as { __vm__?: Vm }).__vm__ ?? {}
}

/** 像素读数（内容掩码内的均值 + 众数色）。 */
export interface ColorStats {
  readonly width: number
  readonly height: number
  readonly pixels: number
  /** 平均亮度（Rec.709 权重，0..255）。 */
  readonly meanLuma: number
  readonly meanRgb: readonly [number, number, number]
  readonly modalColor: readonly [number, number, number]
  readonly modalShare: number
  /**
   * **占比前 5 的主色**（各自是所属量化簇的精确均值）。
   *
   * ## 为什么需要"一组"而不只是"一个"
   *
   * 几何的顶点色里**烘焙了逐面明暗**（`structureMaterialPrimitives` 的顶点色路径），
   * 于是同一张贴图在不同朝向的面上亮度不同。视口里"哪一面占主导"会随取景/宽高比
   * 变化（实测：同一夹具两次测量主色 198 vs 179）—— 只比**单一**主色会把
   * "选面不同"误判成"偏色"。⇒ 判据口径是"导出的主色必须**出现在**视口的主色组里"。
   */
  readonly topColors: readonly (readonly [number, number, number])[]
}

function statsOf(data: Uint8ClampedArray | Uint8Array, w: number, h: number, mask: (i: number) => boolean): ColorStats {
  let n = 0
  let sr = 0
  let sg = 0
  let sb = 0
  let sl = 0
  const counts = new Uint32Array(16 * 16 * 16)
  const rCounts = new Float64Array(16 * 16 * 16)
  const gCounts = new Float64Array(16 * 16 * 16)
  const bCounts = new Float64Array(16 * 16 * 16)
  for (let i = 0; i < w * h; i++) {
    if (!mask(i)) continue
    const o = i * 4
    const r = data[o]!
    const g = data[o + 1]!
    const b = data[o + 2]!
    n += 1
    sr += r
    sg += g
    sb += b
    sl += 0.2126 * r + 0.7152 * g + 0.0722 * b
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    counts[key]! += 1
    rCounts[key]! += r
    gCounts[key]! += g
    bCounts[key]! += b
  }
  let top = 0
  let topKey = 0
  for (let k = 0; k < counts.length; k++) {
    if (counts[k]! > top) {
      top = counts[k]!
      topKey = k
    }
  }
  const c = top > 0 ? counts[topKey]! : 1
  // 前 5 簇（按占比降序；每簇给出精确均值）
  const clusterOrder = Array.from({ length: counts.length }, (_, k) => k)
    .filter((k) => counts[k]! > 0)
    .sort((a, b) => counts[b]! - counts[a]!)
    .slice(0, 5)
  const topColors = clusterOrder.map((k) => {
    const d = counts[k]!
    return [rCounts[k]! / d, gCounts[k]! / d, bCounts[k]! / d] as readonly [number, number, number]
  })
  return {
    topColors,
    width: w,
    height: h,
    pixels: n,
    meanLuma: n === 0 ? 0 : sl / n,
    meanRgb: n === 0 ? [0, 0, 0] : [sr / n, sg / n, sb / n],
    modalColor: top > 0 ? [rCounts[topKey]! / c, gCounts[topKey]! / c, bCounts[topKey]! / c] : [0, 0, 0],
    modalShare: n === 0 ? 0 : top / n,
  }
}

/** 解 PNG → RGBA（页面内，浏览器解码器；不自己解自己写的字节）。 */
async function pngStats(bytes: Uint8Array): Promise<ColorStats> {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/png' })
  const bmp = await createImageBitmap(blob)
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.clearRect(0, 0, c.width, c.height)
  g.drawImage(bmp, 0, 0)
  const { data } = g.getImageData(0, 0, c.width, c.height)
  // 导出：透明背景是有意的（capture 固定 transparent）⇒ 只统计有内容的像素。
  return statsOf(data, c.width, c.height, (i) => data[i * 4 + 3]! > 128)
}

/** 参考渲染：把**同一个会话**画到画布上（输出色彩空间是唯一变量）。 */
function renderReference(capture: ExportCapture, scope: string, outputColorSpace: string): ColorStats {
  const request = capture.request
  const w = request.render.width
  const h = request.render.height
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true })
  try {
    renderer.setPixelRatio(1)
    renderer.setSize(w, h, false)
    renderer.outputColorSpace = outputColorSpace as typeof THREE.SRGBColorSpace
    renderer.setClearColor(0x000000, 0)
    const camera = threeCameraOf(request.camera, request.render)
    // ⚠️ 参考渲染必须拿到**纹理端口**（否则材质走中性色 —— 首跑实测：参考图是纯白，
    // 那不是"编码差异"，而是"根本没有贴图"）。端口与生产设备同源：同一渲染器 + 同一资源表。
    const upload = createRendererTextureUpload(nextDeviceScope('m6-3-color-ref'), renderer)
    const textures = texturePortOf(upload, capture.textureResources)
    const session = createPresenterSession({ scope, textures })
    try {
      const key = evaluationKeyOf(
        request,
        request.frames[0]!,
        Object.fromEntries(capture.content.resources.map((r) => [r.ref.assetId, r.ref.contentVersion])),
      )
      session.applyIfChanged({ scene: request.payload.scene as Scene, content: capture.content, key })
      session.bindTextures(capture.textureResources)
      const scene3 = new THREE.Scene()
      scene3.add(session.object3d)
      renderer.render(scene3, camera)
      const gl = renderer.getContext()
      const pixels = new Uint8Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      return statsOf(pixels, w, h, (i) => pixels[i * 4 + 3]! > 128)
    } finally {
      session.dispose()
      upload.dispose()
    }
  } finally {
    renderer.dispose()
  }
}

export interface ColorParityResult {
  readonly note: string
  readonly export: ColorStats | null
  readonly exportBytes: number
  readonly referenceSrgb: ColorStats | null
  readonly referenceSrgb2: ColorStats | null
  readonly referenceLinear: ColorStats | null
  readonly channels: Readonly<Record<string, number>> | null
}

export async function measureColorParity(options: {
  readonly directionIndex?: number
  readonly pixelSize?: number
}): Promise<ColorParityResult> {
  const ctx = vm()
  if (typeof ctx.kernelPresentationSnapshot !== 'function') {
    return empty('no-live-kernel-document')
  }
  const capture = await captureExportSnapshot(ctx as ExportCaptureSource, {
    kind: 'image',
    directionIndex: options.directionIndex ?? 0,
    pixelSize: options.pixelSize ?? 160,
    seconds: 0,
    decoder: createDomTextureDecoder(),
    now: 1_700_000_000_000,
    requestId: 'm6-3-color',
  })
  if (!capture.ok) return empty('capture-failed:' + String(capture.error.params.reason))
  const c = capture.value

  const exported = await runIsoExport(ctx as ExportCaptureSource, {
    kind: 'image',
    directionIndex: options.directionIndex ?? 0,
    pixelSize: options.pixelSize ?? 160,
    seconds: 0,
    decoder: createDomTextureDecoder(),
    now: 1_700_000_000_000,
  })
  if (!exported.ok) return empty('export-failed:' + String(exported.error.params.reason))

  return {
    note: 'ok',
    export: await pngStats(exported.value.bytes),
    exportBytes: exported.value.bytes.length,
    referenceSrgb: renderReference(c, 'm6-3-color-ref-srgb', THREE.SRGBColorSpace),
    referenceSrgb2: renderReference(c, 'm6-3-color-ref-srgb-2', THREE.SRGBColorSpace),
    referenceLinear: renderReference(c, 'm6-3-color-ref-linear', THREE.LinearSRGBColorSpace),
    channels: ctx.kernelPresentationSnapshot?.()?.channels ?? null,
  }
}

function empty(note: string): ColorParityResult {
  return {
    note,
    export: null,
    exportBytes: 0,
    referenceSrgb: null,
    referenceSrgb2: null,
    referenceLinear: null,
    channels: null,
  }
}