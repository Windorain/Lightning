/**
 * **OBJ 装配期的不可表达事实必须带出来**（M6-4；SPEC §9）。
 *
 * ## 本文件证什么
 *
 * 在 M6-4 之前，OBJ 的两条既知损失只存在于**产物字节的注释行**里：
 *  - `# voxels_non_air=… skipped_unmapped_voxels=…`（`bundleMeshAssembly.ts`）；
 *  - 竖条动画纹理被 `measureTextureBlobFirstFrame` 悄悄裁到首帧（`textureAtlasRaster.ts`）。
 *
 * 机器与用户都读不到它们。本判据跑**真实装配**（`buildStructureBundleZip`），
 * 断言 `onSemanticReport` 收到的事实与夹具的已知损失逐字段一致。
 *
 * ## 为什么用真实装配而不是直接喂一个报告对象
 *
 * 直接喂对象只能测映射函数（那已在 `application/__tests__/exportSemantics.test.ts` 里）。
 * 这里要证的是**采集点真的在跑**：把 `recordFirstFrameOnly`/`recordBlendApproximations`
 * 的任何一处删掉，本文件必须判红。
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { BundleSemanticReport } from '@/application/exportSemantics'
import { loadStructureOrWorld } from '@/render/data/bundleResolve'
import { buildStructureBundleZip } from '@/workbench/export/bundleMeshAssembly'

// ─── 浏览器原语替身（只实现装配链用到的：Image 的尺寸、canvas 的 drawImage/toBlob）──

const FRAME_NAMES = ['rasterizeVoxelAtlasToPngBlob', 'textureBlobToFirstFramePngBlob'] as const

function innermostFrame(): string {
  for (const line of (new Error().stack ?? '').split('\n')) {
    for (const name of FRAME_NAMES) if (line.includes(name)) return name
  }
  return 'other'
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(0) !== 0x89504e47) return null
  return { width: dv.getUint32(16), height: dv.getUint32(20) }
}

function base64OfDataUrl(url: string): string {
  const i = url.indexOf('base64,')
  return i < 0 ? url : url.slice(i + 7)
}

class StubImage {
  crossOrigin = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 0
  naturalHeight = 0
  width = 0
  height = 0
  private __src = ''
  set src(v: string) {
    this.__src = v
    const size = pngSize(Buffer.from(base64OfDataUrl(v), 'base64'))
    if (size === null) {
      queueMicrotask(() => this.onerror?.())
      return
    }
    this.naturalWidth = size.width
    this.naturalHeight = size.height
    this.width = size.width
    this.height = size.height
    queueMicrotask(() => this.onload?.())
  }
  get src(): string {
    return this.__src
  }
}

const frames: string[] = []

function makeCanvas(): unknown {
  const frame = innermostFrame()
  frames.push(frame)
  return {
    width: 1,
    height: 1,
    getContext() {
      return {
        clearRect() {},
        drawImage() {},
        createImageData(w: number, h: number) {
          return { data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }
        },
        putImageData() {},
        getImageData(_x: number, _y: number, w: number, h: number) {
          return { data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }
        },
      }
    },
    toBlob(cb: (b: Blob | null) => void) {
      // 注释：node 的 Blob 不被 jszip 读取（无 FileReader ⇒ support.blob=false），
      // 故交出 jszip 可读的 Uint8Array，同时按 Blob 形状回调（同
      // `materialIndexEndToEnd.test.ts` 的手法）。
      cb(new Uint8Array([0]) as unknown as Blob)
    },
  }
}

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>
  g.Image = StubImage
  g.document = {
    createElement(tag: string) {
      if (tag === 'canvas') return makeCanvas()
      return {}
    },
  }
  g.createImageBitmap = async () => ({ width: 1, height: 1 })
})

// ─── 夹具：1 个正常体素 + 1 个无几何体素；一张两帧竖条贴图；材质 translucent ───

/** 4×8 竖条 PNG（上 4×4、下 4×4）⇒ 两帧。 */
const TWO_FRAME_STRIP =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAICAYAAADeM14FAAAAFklEQVR4nGP4z8DwHxkzkCGAxidHAADQmD/BvPNxagAAAABJRU5ErkJggg=='

function fixture(): Record<string, unknown> {
  return {
    // 直接给**终态结构**（`geometryPhase: 'baked'`）：`loadStructureOrWorld` 对它走
    // `loadStructureData`，不经过 World 的帧清单（判据只关心装配期事实）。
    geometryPhase: 'baked',
    id: 'm6-4-obj-semantics',
    // 1 列 × 1 行 × 2 层：z=0 是正常方块，z=1 是一条**解码必然失败**的方块
    cellGrid: [[[1, 2]]],
          blockPalette: [
            { registryId: 'air', meta: 0, renderMode: 'BakedQuads', geometry: { encoding: 'bakedQuadsJsonV1', quads: [] }, occludesAdjacentFaces: false, tooltip: [] },
            {
              registryId: 'minecraft:stone',
              meta: 0,
              renderMode: 'BakedQuads',
              geometry: {
                encoding: 'bakedQuadsJsonV1',
                quads: [
                  {
                    materialIndex: 0,
                    vertices: [
                      { x: 0, y: 0, z: 1, u: 0, v: 0, color: 16777215 },
                      { x: 1, y: 0, z: 1, u: 1, v: 0, color: 16777215 },
                      { x: 1, y: 1, z: 1, u: 1, v: 1, color: 16777215 },
                      { x: 0, y: 1, z: 1, u: 0, v: 1, color: 16777215 },
                    ],
                  },
                ],
              },
              occludesAdjacentFaces: true,
              tooltip: [],
            },
            // 未知 encoding ⇒ `decodeBakedGeometry` 抛错 ⇒ 该体素被跳过（skipped_unmapped_voxels）
            { registryId: 'm6:unmapped', meta: 0, renderMode: 'BakedQuads', geometry: { encoding: 'not-a-real-encoding', quads: [] }, occludesAdjacentFaces: false, tooltip: [] },
    ],
    materialPalette: [
      { textureBlobIndex: 0, blend: 'translucent', kind: 'animated', animation: { defaultFrametimeTicks: 1, frameSequence: [{ index: 0 }, { index: 1, timeTicks: 2 }] } },
    ],
    textureBlobs: { '0': TWO_FRAME_STRIP },
  }
}

describe('M6-4 · OBJ 装配期事实（首帧纹理 / 跳过体素 / 混合近似）', () => {
  it('真实装配把三条损失结构化带出（不再只写注释行）', async () => {
    const plain = fixture()
    const def = loadStructureOrWorld(plain, undefined)
    let report: BundleSemanticReport | null = null
    await buildStructureBundleZip(def, plain, {
      mode: 'block',
      onSemanticReport: (r) => { report = r },
    })
    expect(report, '装配必须调用 onSemanticReport（否则判据无法取证）').not.toBeNull()
    const r = report as unknown as BundleSemanticReport

    // ① 竖条动画只画首帧
    expect(r.firstFrameOnly, '两帧竖条贴图必须被记为"只用首帧"').toHaveLength(1)
    expect(r.firstFrameOnly[0]!.blobIndex).toBe(0)
    expect(r.firstFrameOnly[0]!.frameCount).toBe(2)
    expect(r.firstFrameOnly[0]!.materialIndices).toEqual([0])

    // ② 无几何体素被跳过（与产物注释行的计数同源）
    expect(r.skippedUnmappedVoxels, '跳过的体素数必须与注释行口径一致').toBe(1)
    expect(r.skippedVoxels.map((s) => s.registryKey)).toEqual(['m6:unmapped@0'])
    expect(r.skippedVoxels[0]!.reason).toBe('decode_error')

    // ③ translucent 只能用 MTL 的 d/illum 近似
    expect(r.blendApproximations.map((b) => b.blend)).toEqual(['translucent'])
  })

  it('**负对照**：没有调用方回调时装配照常成功（诊断是旁路，不是前置）', async () => {
    const plain = fixture()
    const def = loadStructureOrWorld(plain, undefined)
    const blob = await buildStructureBundleZip(def, plain, { mode: 'block' })
    expect(blob.size, '没有诊断回调也必须产出真 zip').toBeGreaterThan(100)
  })

  it('**负对照**：回调抛错不得让导出失败（诊断坏了不能把成功导出变成失败）', async () => {
    const plain = fixture()
    const def = loadStructureOrWorld(plain, undefined)
    const blob = await buildStructureBundleZip(def, plain, {
      mode: 'block',
      onSemanticReport: () => { throw new Error('diagnostics boom') },
    })
    expect(blob.size).toBeGreaterThan(100)
  })
})
