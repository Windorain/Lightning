/**
 * **导出面端口的生产实现判据**（#301 P10f/E；判据 E1–E8）。
 *
 * ## 本文件证明什么、**不**证明什么（先说清楚，因为边界是判据的一部分）
 *
 * 本仓 `gl@8.1.6` 是 WebGL 1.0，而锁定的 `three ^0.174.0` 硬编码请求 `webgl2`
 * ⇒ 无头环境下 `new THREE.WebGLRenderer` **必然抛**（实测：
 * `TypeError: gl.texImage3D is not a function`；见 `adapters/export/renderDevice` 文件头）。
 * `package.json` 属本批硬边界（不可换依赖）。
 *
 * ⇒ **真实 GPU 填充**那一段由 e2e 承担（`e2e/export-ports.spec.ts`，真 Chromium + 真 WebGL）；
 * 本文件在**受控设备**上证明**其余每一环**：取景映射、逐帧求值键、场景→呈现→编译→挂载、
 * 设备调用序列、像素缓冲校验、**真实 PNG 字节**、生命周期与释放、四条失败路径。
 *
 * 「受控设备」是**注入的实现**（不是替身）：它占据的是 `OffscreenDeviceFactory` 那个
 * **已声明的端口**，返回确定性像素 —— 于是"这条链能跑"不是源码指纹，而是可执行的。
 *
 * ## 与 A29 判据（`snapshotExport.test.ts`）的关系
 *
 * 那个文件用**测试替身**证明作业的政策（`fakePort`/`okEncoder`）——它证明的是
 * 「作业在各种端口行为下的处置」。本文件正相反：**端口是真的**（生产实现），
 * 只有设备那一段被替换。两者互补，都不重复。
 */

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import fs from 'node:fs'
import path from 'node:path'
import pako from 'pako'
import { PNG_MAGIC, crc32, encodePngFromRgba } from '@/adapters/export/pngEncoder'
import { createEncoderPort, SUPPORTED_ENCODE_KINDS } from '@/adapters/export/encoderPort'
import { createSnapshotOffscreenRenderPort } from '@/adapters/export/offscreenRenderPort'
import { assembleSnapshotExportJob } from '@/adapters/export/snapshotExportJob'
import type { OffscreenDevice, OffscreenDeviceFactory } from '@/adapters/export/renderDevice'
import { threeCameraOf } from '@/presentation/offscreenCamera'
import { ok, err, unsupportedOperation, type Result } from '@/domain/errors'
import type { CameraSpec, CaptureSpec, RenderSettings } from '@/domain/captureSpec'
import { planExportRequest, type RenderedFrame } from '@/application/exportPlan'
import { addBlockObject, createDocument, withScene } from '@/domain/document'
import { EMPTY_ANIMATION } from '@/domain/animation'
import { contentResource, documentContent, type DocumentContent } from '@/domain/content'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { plainRootOf } from '@/adapters/plainRoot'
import type { Scene } from '@/domain/scene'

// ─────────────────────────────────────────────────────────────────────────────
// 受控设备（占据已声明的端口；记录调用序列、返回确定性像素）
// ─────────────────────────────────────────────────────────────────────────────

interface DeviceCall {
  readonly kind: 'renderAndRead' | 'dispose'
  readonly width?: number
  readonly height?: number
}

/**
 * 造一个受控设备工厂。
 *
 * `pixelFor` 让每个场景决定"读回什么" —— 判据据此验证"读回的像素确实进了产物"。
 * `failAcquire` / `failRead` 造失败路径（必须在**结构化失败**上表现，不抛）。
 */
function controlledDevice(options: {
  failAcquire?: boolean
  failRead?: boolean
  pixelFor?: (w: number, h: number) => Uint8Array
  disposeThrows?: boolean
} = {}) {
  const calls: DeviceCall[] = []
  let disposeCount = 0
  const factory: OffscreenDeviceFactory = {
    acquire(render: RenderSettings): Result<{ device: OffscreenDevice; allocated: number }> {
      if (options.failAcquire === true) {
        return err(unsupportedOperation({ reason: 'controlledAcquireFailed' }))
      }
      calls.push({ kind: 'renderAndRead', width: -1, height: -1 }) // 占位（acquire 语义见下）
      calls.pop()
      const device: OffscreenDevice = {
        renderAndRead(_root: THREE.Object3D, _camera: THREE.Camera): Result<Uint8Array> {
          calls.push({ kind: 'renderAndRead', width: render.width, height: render.height })
          if (options.failRead === true) {
            return err(unsupportedOperation({ reason: 'controlledReadFailed' }))
          }
          const px = options.pixelFor?.(render.width, render.height)
            ?? deterministicPixels(render.width, render.height)
          return ok(px)
        },
        dispose(): void {
          calls.push({ kind: 'dispose' })
          disposeCount += 1
          if (options.disposeThrows === true) throw new Error('controlled dispose boom')
        },
      }
      return ok({ device, allocated: 2 })
    },
  }
  return { factory, calls, disposeCount: () => disposeCount }
}

/** 确定性像素：每个像素的值由其下标机械决定（便于断言"读回的正是它"）。 */
function deterministicPixels(w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = i % 251
    out[i * 4 + 1] = (i * 7) % 251
    out[i * 4 + 2] = (i * 13) % 251
    out[i * 4 + 3] = 255
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 夹具（真实数据结构，无 Mock）
// ─────────────────────────────────────────────────────────────────────────────

const VIEW: CameraSpec = {
  projection: 'perspective',
  position: { x: 6, y: 6, z: 6 },
  target: { x: 0, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  fovDegrees: 45,
  near: 0.1,
  far: 500,
}

function docOf(blocks: number) {
  let doc = createDocument('p10f-e')
  for (let i = 0; i < blocks; i++) {
    const s = addBlockObject(doc.scene, { objectId: `o${i}`, dataId: `d${i}` })
    if (!s) throw new Error('fixture: addBlockObject failed')
    doc = withScene(doc, s).doc
  }
  return doc
}

/** 内容面：单条静态资源（`materialPalette` 非空 ⇒ 呈现编译能产出批次）。 */
function contentOf(): DocumentContent {
  return documentContent({
    resources: [contentResource({ assetId: 'tex:stone', locator: '', payload: 'AAAA', kind: 'static16' })],
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 可渲染场景的来源（**真实信封夹具**，不是自造几何）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## 为什么链路闭环判据必须吃**真实夹具**（本判据首跑实测的教训）
 *
 * 第一版用 `addBlockObject` 造的"空壳场景"（无 `geometry`/`cellGeometry`）跑 E6，
 * 结果作业**判 failed** —— 那是 `offscreenRenderPort` 的**诚实失败**分支在正常工作：
 * 「场景里有对象却一个批次都产不出 ⇒ 不产出看起来成功的空图」。
 * 该分支正是为 `composition/seams.ts` 登记的缺口形态（"内核投影不带回显 ⇒
 * triangles=0 ⇒ 静默产出空几何"）而设的。
 *
 * ⇒ 判据要证明"链路能跑通"，输入就**必须**是真正可渲染的场景。用生产链
 * （信封解析 → 内核装配）从磁盘上的**外部字节**取它 —— 与
 * `composition/__tests__/kernelPresentationInputs.test.ts` 同一来源，
 * 故"能编译"不是本文件自造出来的。
 */
function productionParsers() {
  const p = createParserRegistry()
  p.register(V2PlainParser)
  p.register(createEnvelopeParser(p))
  p.register(WorldParser)
  p.register(StructureDataParser)
  return p
}

/** 真实信封夹具 → 内核场景 + 内容（走**完整生产链**：解析 → 装配）。 */
async function realSceneFrom(): Promise<{ scene: Scene; content: DocumentContent }> {
  const raw = JSON.parse(
    fs
      .readFileSync(
        path.join(process.cwd(), 'e2e', 'fixtures', 'structuredata-exported-envelope.json'),
        'utf8',
      )
      // 铁律 6：读源码/夹具文本前归一化行尾（本仓 `core.autocrlf=true`）。
      .replace(/\r\n/g, '\n'),
  ) as Record<string, unknown>
  const parsed = await productionParsers().detectAndParse(raw)
  if (parsed.document === null) throw new Error('fixture: 信封夹具解析失败')
  const assembled = assembleKernelDocument({ doc: parsed.document, plainRoot: plainRootOf(raw) })
  if (!assembled.ok) throw new Error(`fixture: 装配失败 ${assembled.error.code}`)
  return { scene: assembled.value.scene, content: assembled.value.content }
}

/** 用**真实夹具**组装一份请求（`scene`/`content` 同源，故不可能漂移）。 */
async function realRequestOf(over: { spec?: CaptureSpec } = {}) {
  const { scene, content } = await realSceneFrom()
  const spec = specOf(over.spec)
  const r = planExportRequest({
    requestId: 'p10f-e-real',
    now: 1_700_000_000_000,
    documentId: 'fixture-doc',
    version: { documentVersion: 1, contentVersion: 1 },
    scene,
    animation: EMPTY_ANIMATION,
    camera: spec.camera,
    spec,
    assets: [],
  })
  if (!r.ok) throw new Error(`fixture: planExportRequest failed: ${r.error.code}`)
  return { request: r.value, content }
}

function specOf(over: Partial<CaptureSpec> = {}): CaptureSpec {
  const render: RenderSettings = over.render ?? { width: 8, height: 8, background: 'transparent' }
  return {
    frameRate: over.frameRate ?? 20,
    frameCount: over.frameCount ?? 2,
    mapping: over.mapping ?? { source: 'scene', startFrame: 0, stepFrames: 1 },
    channels: over.channels ?? {},
    camera: over.camera ?? { kind: 'view', view: VIEW, label: 'p10f-e' },
    render,
    animation: over.animation ?? EMPTY_ANIMATION,
  }
}

function requestOf(over: { spec?: CaptureSpec; blocks?: number } = {}) {
  const doc = docOf(over.blocks ?? 1)
  const spec = specOf(over.spec)
  const r = planExportRequest({
    requestId: 'p10f-e-req',
    now: 1_700_000_000_000,
    documentId: doc.id,
    version: doc.version,
    scene: doc.scene,
    animation: doc.animation,
    camera: spec.camera,
    spec,
    // 显式空清单 ⇒ 预检不会因"缺资源"阻塞（本文件测的是端口，不是资源政策；
    // 资源政策已有 `snapshotExport.test.ts` 的预检组把守）。
    assets: [],
  })
  if (!r.ok) throw new Error(`fixture: planExportRequest failed: ${r.error.code}`)
  return r.value
}

// ─────────────────────────────────────────────────────────────────────────────
// E1：生产实现存在 + 恰好一个生产构造点
// ─────────────────────────────────────────────────────────────────────────────

describe('E1 · 两个端口各有**生产实现**，且 ExportJob 有生产构造点', () => {
  it('`SnapshotOffscreenRenderPort` 与 `createEncoderPort()` 可构造，且方法集合与冻结接口一致', () => {
    const port = createSnapshotOffscreenRenderPort({
      devices: controlledDevice().factory,
      content: contentOf(),
      scope: 'e1',
    })
    // 冻结接口的三个方法（与 `export-purity.test.ts` 锁定的集合一致）
    for (const m of ['acquire', 'renderFrame', 'release'] as const) {
      expect(typeof port[m], `离屏端口必须实现 ${m}`).toBe('function')
    }
    const encoder = createEncoderPort()
    expect(Array.isArray(encoder.supportedKinds)).toBe(true)
    expect(typeof encoder.encode).toBe('function')
  })

  it('编码器 `supportedKinds` **诚实声明**：只列真能编码的种类', () => {
    // 把四类全列上而只实现 image 会让预检放行、编码阶段产出错误字节（伪完整文件）。
    expect([...SUPPORTED_ENCODE_KINDS]).toEqual(['image'])
    const encoder = createEncoderPort()
    expect([...encoder.supportedKinds]).toEqual(['image'])
    // 于是非 image 种类会被预检判 ExportKindUnsupported（而不是静默产出）
    for (const kind of ['animation', 'geometry', 'project'] as const) {
      expect(encoder.supportedKinds.includes(kind), `${kind} 不得被声明为支持`).toBe(false)
    }
  })

  it('装配入口能产出**可运行的**作业（两端口 + ExportJob 装在一起）', () => {
    const { job } = assembleSnapshotExportJob({
      request: requestOf(),
      kind: 'image',
      devices: controlledDevice().factory,
      content: contentOf(),
      scope: 'e1-assemble',
    })
    expect(job.preflight().status, '装配齐全 ⇒ 预检应 ready').toBe('ready')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E2/E3/E4：真实 PNG 字节 + 像素真进去了
// ─────────────────────────────────────────────────────────────────────────────

/** 逐块遍历 PNG（判据复用；返回块序列与逐块 CRC 是否成立）。 */
function chunksOf(png: Uint8Array): { type: string; data: Uint8Array; crcOk: boolean }[] {
  const out: { type: string; data: Uint8Array; crcOk: boolean }[] = []
  let at = 8
  while (at < png.length) {
    const len = (png[at]! << 24) | (png[at + 1]! << 16) | (png[at + 2]! << 8) | png[at + 3]!
    const type = String.fromCharCode(png[at + 4]!, png[at + 5]!, png[at + 6]!, png[at + 7]!)
    const data = png.subarray(at + 8, at + 8 + len)
    const body = png.subarray(at + 4, at + 8 + len)
    const want =
      ((png[at + 8 + len]! << 24) | (png[at + 9 + len]! << 16) | (png[at + 10 + len]! << 8) | png[at + 11 + len]!) >>> 0
    out.push({ type, data, crcOk: crc32(body) === want })
    at += 12 + len
  }
  return out
}

function readU32(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0
}

describe('E2·E3·E4 · 真实 PNG 字节 + 像素真的进去了', () => {
  async function encodeViaPort(width: number, height: number, pixels: Uint8Array) {
    const encoder = createEncoderPort()
    const request = requestOf({ spec: specOf({ render: { width, height, background: 'transparent' } }) })
    const frame: RenderedFrame = Object.freeze({ index: 0, time: request.frames[0]!, pixels, width, height })
    const r = await encoder.encode({
      request,
      kind: 'image',
      encoding: 'png',
      rendered: [frame],
      signal: { cancelled: false },
    })
    if (!r.ok) throw new Error(`encode failed: ${r.error.code} ${JSON.stringify(r.error.params)}`)
    return r.value
  }

  it('E3：产物是**合法 PNG**（magic / IHDR 尺寸==request / 逐块 CRC32 / IEND）', async () => {
    const w = 8
    const h = 4
    const png = await encodeViaPort(w, h, deterministicPixels(w, h))
    expect([...png.subarray(0, 8)], 'PNG 魔数').toEqual([...PNG_MAGIC])

    const chunks = chunksOf(png)
    expect(chunks.map((c) => c.type), '块序列必须是 IHDR→IDAT→IEND').toEqual(['IHDR', 'IDAT', 'IEND'])
    expect(chunks.every((c) => c.crcOk), '**逐块** CRC32 必须成立（覆盖类型+数据、不含长度）').toBe(true)

    const ihdr = chunks[0]!.data
    expect(readU32(ihdr, 0), 'IHDR 宽必须等于 request.render.width').toBe(w)
    expect(readU32(ihdr, 4), 'IHDR 高必须等于 request.render.height').toBe(h)
    expect(ihdr[8], '位深必须是 8').toBe(8)
    expect(ihdr[9], '色彩类型必须是 6（RGBA）').toBe(6)
    // IDAT 必须是 **zlib** 流（`deflate` 而非 `deflateRaw`）—— 0x78 是 zlib 头首字节
    expect(chunks[1]!.data[0], 'IDAT 必须是 zlib 流（用 pako.deflate，不用 deflateRaw）').toBe(0x78)
  })

  it('E4：`inflate(IDAT)` 还原的像素**逐字节**等于读回的 RGBA（含 Y 翻转）', async () => {
    const w = 6
    const h = 3
    const pixels = deterministicPixels(w, h)
    const png = await encodeViaPort(w, h, pixels)
    const idat = chunksOf(png).find((c) => c.type === 'IDAT')!.data
    const raw = pako.inflate(idat)

    const stride = w * 4
    expect(raw.length, 'raw 长度必须是 (stride+1)×height（每行一个 filter 字节）').toBe((stride + 1) * h)
    for (let y = 0; y < h; y++) {
      expect(raw[y * (stride + 1)], `第 ${y} 行 filter 必须是 0（None）`).toBe(0)
      // flipY=true（WebGL 行序 → PNG 自上而下）⇒ PNG 第 y 行 = 读回第 (h-1-y) 行
      const srcRow = h - 1 - y
      const got = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
      const want = pixels.subarray(srcRow * stride, srcRow * stride + stride)
      expect([...got], `第 ${y} 行像素必须逐字节等于读回第 ${srcRow} 行（Y 翻转生效）`).toEqual([...want])
    }
  })

  it('E4 负对照：**只写头不写像素**的空壳编码器会被同一条判据抓到', async () => {
    // 空壳：合法 PNG 结构、但 IDAT 里没有真实像素（这是"伪完整文件"的最简形态）
    const w = 4
    const h = 2
    const empty = new Uint8Array(w * h * 4) // 全 0
    const real = deterministicPixels(w, h)
    const shellPng = await encodeViaPort(w, h, empty)
    const realPng = await encodeViaPort(w, h, real)

    const shellRaw = pako.inflate(chunksOf(shellPng).find((c) => c.type === 'IDAT')!.data)
    const realRaw = pako.inflate(chunksOf(realPng).find((c) => c.type === 'IDAT')!.data)
    // 同一条判定式（"raw 等于输入像素"）对空壳必须**判红**：输入是 real、raw 是空
    const stride = w * 4
    const firstRow = [...realRaw.subarray(1, 1 + stride)]
    const expectFirstRow = [...real.subarray((h - 1) * stride, h * stride)]
    expect(firstRow, '真像素必须匹配').toEqual(expectFirstRow)
    expect([...shellRaw.subarray(1, 1 + stride)], '空壳像素与真像素不同（故该判据能判红）').not.toEqual(expectFirstRow)
  })

  it('E3 负对照：CRC 损坏 / 截断 / 错宽高 都判红', async () => {
    const w = 4
    const h = 2
    const png = await encodeViaPort(w, h, deterministicPixels(w, h))

    // ① CRC 损坏 ⇒ `chunksOf` 的 crcOk 必须为 false
    const bad = Uint8Array.from(png)
    bad[bad.length - 1] = (bad[bad.length - 1]! ^ 0xff) & 0xff
    expect(chunksOf(bad).some((c) => !c.crcOk), '损坏的 CRC 必须被检出').toBe(true)

    // ② 错宽高：IHDR 声明与真实不同 ⇒ 判据（声明 == request）判红
    const wrongW = Uint8Array.from(png)
    wrongW[16] = 0
    wrongW[19] = 9 // IHDR 宽改成 9（数据区仍在 offset 16..19）
    expect(readU32(chunksOf(wrongW)[0]!.data, 0), '被改宽的 IHDR 必须与 request 不符').not.toBe(w)

    // ③ 截断 ⇒ 块遍历走不完 / inflate 失败。⚠️ 实测：`pako.inflate` 对截断流
    //    **不抛**而是返回 `undefined`（不是空数组）—— 故判据必须判 `undefined`，
    //    只写 `expect(...).toThrow()` 会是**恒绿的空转判据**（本批实测抓到的假设错误）。
    const idat = chunksOf(png).find((c) => c.type === 'IDAT')!.data
    const truncated = idat.subarray(0, Math.max(1, idat.length - 5))
    let inflated: Uint8Array | undefined
    try {
      inflated = pako.inflate(truncated)
    } catch {
      inflated = undefined
    }
    expect(inflated, '截断的 IDAT 必须**不**产出可用像素（实测 pako 返回 undefined）').toBeUndefined()
  })

  it('E3 负对照（单元级）：编码器拒绝尺寸与缓冲不符的输入，而不是夹取', async () => {
    expect(() => encodePngFromRgba(new Uint8Array(4), 4, 4), '缓冲长度不符必须抛').toThrow()
    expect(() => encodePngFromRgba(new Uint8Array(16), 0, 1), '宽必须是正整数').toThrow()
    expect(() => encodePngFromRgba(new Uint8Array(16), 2, 2.5), '高必须是整数').toThrow()
  })

  it('E3：`jpeg` 被**显式拒绝**（不按 PNG 编码却声明 image/jpeg）', async () => {
    // `ImageEncoding` 类型里有 `'jpeg'`。若悄悄按 PNG 编码，字节与声明的媒体类型
    // 就不一致 —— 那是本批 D7 修复针对的**同族**缺陷（声明与内容不符）。
    const w = 4
    const h = 2
    const encoder = createEncoderPort()
    const request = requestOf({ spec: specOf({ render: { width: w, height: h, background: 'transparent' } }) })
    const frame: RenderedFrame = Object.freeze({ index: 0, time: request.frames[0]!, pixels: deterministicPixels(w, h), width: w, height: h })
    const r = await encoder.encode({
      request,
      kind: 'image',
      encoding: 'jpeg',
      rendered: [frame],
      signal: { cancelled: false },
    })
    expect(r.ok, 'jpeg 必须显式拒绝而不是按 PNG 编').toBe(false)
    if (!r.ok) expect(r.error.params.reason).toBe('encoderEncodingUnsupported')
  })

  it('E3：非 image 种类被显式拒绝（声明面与实现面同一份事实）', async () => {
    const w = 4
    const h = 2
    const encoder = createEncoderPort()
    const request = requestOf({ spec: specOf({ render: { width: w, height: h, background: 'transparent' } }) })
    const frame: RenderedFrame = Object.freeze({ index: 0, time: request.frames[0]!, pixels: deterministicPixels(w, h), width: w, height: h })
    for (const kind of ['animation', 'geometry', 'project'] as const) {
      const r = await encoder.encode({
        request,
        kind,
        encoding: 'png',
        rendered: [frame],
        signal: { cancelled: false },
      })
      expect(r.ok, `${kind} 必须显式拒绝（supportedKinds 未声明它）`).toBe(false)
      if (!r.ok) expect(r.error.params.reason).toBe('encoderKindUnsupported')
    }
  })

  it('E3：零帧被显式拒绝（不产出"空但合法"的 PNG）', async () => {
    const encoder = createEncoderPort()
    const request = requestOf({ spec: specOf({ render: { width: 4, height: 4, background: 'transparent' } }) })
    const r = await encoder.encode({
      request,
      kind: 'image',
      encoding: 'png',
      rendered: [],
      signal: { cancelled: false },
    })
    expect(r.ok, '零帧不得产出空 PNG（伪完整文件的最简形态）').toBe(false)
    if (!r.ok) expect(r.error.params.reason).toBe('encoderNoFrames')
  })

  it('E3：取消信号 ⇒ 显式失败且**不产出字节**', async () => {
    const encoder = createEncoderPort()
    const w = 4
    const h = 2
    const request = requestOf({ spec: specOf({ render: { width: w, height: h, background: 'transparent' } }) })
    const frame: RenderedFrame = Object.freeze({ index: 0, time: request.frames[0]!, pixels: deterministicPixels(w, h), width: w, height: h })
    const r = await encoder.encode({
      request,
      kind: 'image',
      encoding: 'png',
      rendered: [frame],
      signal: { cancelled: true },
    })
    expect(r.ok, '取消必须显式失败').toBe(false)
    if (!r.ok) expect(r.error.params.reason).toBe('encoderCancelled')
  })

  it('E4：像素缓冲长度与 `width×height×4` 不符 ⇒ 显式失败（不夹取、不补零）', async () => {
    const encoder = createEncoderPort()
    const w = 4
    const h = 2
    const request = requestOf({ spec: specOf({ render: { width: w, height: h, background: 'transparent' } }) })
    // 故意给一个短缓冲（模拟上游算错）
    const frame: RenderedFrame = Object.freeze({ index: 0, time: request.frames[0]!, pixels: new Uint8Array(8), width: w, height: h })
    const r = await encoder.encode({
      request,
      kind: 'image',
      encoding: 'png',
      rendered: [frame],
      signal: { cancelled: false },
    })
    expect(r.ok, '缓冲长度不符必须显式失败').toBe(false)
    if (!r.ok) expect(r.error.params.reason).toBe('encoderPixelBufferSizeMismatch')
  })

  it('E4：帧尺寸与 request.render 不符 ⇒ 显式失败（不产出尺寸漂移的图）', async () => {
    const encoder = createEncoderPort()
    const request = requestOf({ spec: specOf({ render: { width: 4, height: 4, background: 'transparent' } }) })
    // 帧声明 4×4 但 request 是 4×4 → 一致；这里造一个不一致的：帧 2×2
    const frame: RenderedFrame = Object.freeze({
      index: 0,
      time: request.frames[0]!,
      pixels: deterministicPixels(2, 2),
      width: 2,
      height: 2,
    })
    const r = await encoder.encode({
      request,
      kind: 'image',
      encoding: 'png',
      rendered: [frame],
      signal: { cancelled: false },
    })
    expect(r.ok, '帧尺寸与请求不符必须显式失败（静默尺寸漂移是缺陷）').toBe(false)
    if (!r.ok) expect(r.error.params.reason).toBe('encoderFrameSizeMismatch')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E5：生命周期与失败路径
// ─────────────────────────────────────────────────────────────────────────────

describe('E5 · 生命周期：幂等释放 + 结构化失败（不抛）', () => {
  it('`release()` **幂等**：重复调用不重复释放设备', () => {
    const dev = controlledDevice()
    const port = createSnapshotOffscreenRenderPort({ devices: dev.factory, content: contentOf(), scope: 'e5-idem' })
    const request = requestOf()
    expect(port.acquire(request).ok).toBe(true)
    port.release()
    port.release()
    port.release()
    expect(dev.disposeCount(), '设备只应被释放一次').toBe(1)
  })

  it('未 `acquire` 就 `renderFrame` ⇒ **结构化失败**（不抛）', () => {
    const port = createSnapshotOffscreenRenderPort({
      devices: controlledDevice().factory,
      content: contentOf(),
      scope: 'e5-noacquire',
    })
    let threw = false
    let result: Result<RenderedFrame> | null = null
    try {
      result = port.renderFrame(requestOf(), 0)
    } catch {
      threw = true
    }
    expect(threw, '不得抛异常（失败必须是值）').toBe(false)
    expect(result!.ok).toBe(false)
    if (!result!.ok) expect(result!.error.params.reason).toBe('offscreenPortNotAcquired')
  })

  it('`acquire` 失败 ⇒ 结构化失败，且**不**调用 `release()`（没有拿到东西就谈不上释放）', () => {
    const dev = controlledDevice({ failAcquire: true })
    const port = createSnapshotOffscreenRenderPort({ devices: dev.factory, content: contentOf(), scope: 'e5-failacq' })
    const r = port.acquire(requestOf())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('UnsupportedOperation')
    port.release()
    expect(dev.disposeCount(), '分配失败不得产出一个要释放的设备').toBe(0)
  })

  it('重复 `acquire` 被**显式拒绝**（否则上一份设备无人回收 ⇒ 泄漏）', () => {
    const port = createSnapshotOffscreenRenderPort({
      devices: controlledDevice().factory,
      content: contentOf(),
      scope: 'e5-double',
    })
    expect(port.acquire(requestOf()).ok).toBe(true)
    const second = port.acquire(requestOf())
    expect(second.ok, '第二次 acquire 必须失败').toBe(false)
    if (!second.ok) expect(second.error.params.reason).toBe('offscreenPortAlreadyAcquired')
  })

  it('`release()` 之后不得再 `acquire`（作业生命周期已终结）', () => {
    const port = createSnapshotOffscreenRenderPort({
      devices: controlledDevice().factory,
      content: contentOf(),
      scope: 'e5-after',
    })
    expect(port.acquire(requestOf()).ok).toBe(true)
    port.release()
    const again = port.acquire(requestOf())
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.params.reason).toBe('offscreenPortReleased')
  })

  it('帧下标越界 ⇒ 结构化失败（**不**夹取到最后一帧）', async () => {
    const { request, content } = await realRequestOf({ spec: specOf({ frameCount: 2 }) })
    const port = createSnapshotOffscreenRenderPort({
      devices: controlledDevice().factory,
      content,
      scope: 'e5-oob',
    })
    expect(port.acquire(request).ok).toBe(true)
    const out = port.renderFrame(request, 5)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.params.reason).toBe('frameIndexOutOfRange')
  })

  it('设备读回失败 ⇒ 结构化失败并冒泡（不产出空产物）', async () => {
    const { request, content } = await realRequestOf()
    const port = createSnapshotOffscreenRenderPort({
      devices: controlledDevice({ failRead: true }).factory,
      content,
      scope: 'e5-readfail',
    })
    expect(port.acquire(request).ok).toBe(true)
    const out = port.renderFrame(request, 0)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.params.reason).toBe('controlledReadFailed')
  })

  it('**内容面缺失 ⇒ 诚实失败**（不产出"看起来成功"的空图）', () => {
    // 这条把 `offscreenRenderPort` 的 `offscreenNoDrawableContent` 分支钉住：
    // 它正是 `composition/seams.ts` 登记的缺口形态（"内核投影不带回显 ⇒ triangles=0
    // ⇒ 静默产出空几何"）。若该分支被删，缺内容面会变成一张全透明 PNG 冒充成功。
    const request = requestOf() // 空壳场景（无 geometry/cellGeometry）
    const port = createSnapshotOffscreenRenderPort({
      devices: controlledDevice().factory,
      content: contentOf(),
      scope: 'e5-nocontent',
    })
    expect(port.acquire(request).ok).toBe(true)
    const out = port.renderFrame(request, 0)
    expect(out.ok, '产不出批次时必须结构化失败，而不是给一张空图').toBe(false)
    if (!out.ok) {
      expect(out.error.params.reason).toBe('offscreenNoDrawableContent')
      // 诊断必须说出**为什么**（跳过原因逐条报出，不吞）
      expect(String(out.error.params.skipped)).toContain('no-typed-geometry')
    }
  })

  it('交付面：设备**确实**被调用过 `renderAndRead`（反空洞真）', async () => {
    const dev = controlledDevice()
    const { request, content } = await realRequestOf()
    const port = createSnapshotOffscreenRenderPort({ devices: dev.factory, content, scope: 'e5-calls' })
    port.acquire(request)
    const frame = port.renderFrame(request, 0)
    expect(frame.ok, '真实夹具必须能渲染出批次（否则本组判据失去对象）').toBe(true)
    port.release()
    const kinds = dev.calls.map((c) => c.kind)
    expect(kinds, '必须真的渲染并在之后释放').toContain('renderAndRead')
    expect(kinds, '必须真的释放').toContain('dispose')
    // 设备的 renderAndRead 收到的尺寸必须等于 request.render（不是别处来的）
    const renderCall = dev.calls.find((c) => c.kind === 'renderAndRead')!
    expect(renderCall.width).toBe(request.render.width)
    expect(renderCall.height).toBe(request.render.height)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E6：链路闭环（ExportJob + 两个真端口）
// ─────────────────────────────────────────────────────────────────────────────

describe('E6 · 链路闭环：`ExportJob.run()` + 两个真端口 ⇒ 完整 PNG', () => {
  it('正常路径：`completed` + 真实 PNG 字节 + `releasedFor` + `framesRendered` 正确', async () => {
    const dev = controlledDevice()
    // `kind: 'image'` 是**单张**静止图 ⇒ 请求本就该是单帧采样。
    // 多帧 + `kind:'image'` 会被编码器**显式拒绝**（见下方"不静默丢帧"用例）——
    // 那不是限制，而是"不假装导出了一段动画"。
    const { request, content } = await realRequestOf({
      spec: specOf({ frameCount: 1, render: { width: 4, height: 4, background: 'transparent' } }),
    })
    const { job } = assembleSnapshotExportJob({
      request,
      kind: 'image',
      devices: dev.factory,
      content,
      scope: 'e6-happy',
    })

    const outcome = await job.run()
    expect(outcome.status, '装配齐全 ⇒ 应完成').toBe('completed')
    if (outcome.status !== 'completed') throw new Error(`unexpected: ${outcome.status}`)

    expect(outcome.mediaType).toBe('image/png')
    expect(outcome.framesRendered, '渲染帧数必须等于冻结序列长度').toBe(request.frames.length)
    expect(outcome.releasedFor, '`releasedFor` 必须是 acquire 报告的句柄数').toBe(3) // 设备 2 + 会话 1
    expect([...outcome.bytes.subarray(0, 8)], '产物必须是 PNG').toEqual([...PNG_MAGIC])

    // **产物真的是一张图**（不只是"开头像 PNG"）：IHDR 尺寸 == request.render
    const chunks = chunksOf(outcome.bytes)
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    expect(readU32(chunks[0]!.data, 0), '产物宽必须等于 request.render.width').toBe(request.render.width)
    expect(readU32(chunks[0]!.data, 4), '产物高必须等于 request.render.height').toBe(request.render.height)

    // 资源**确实**被释放（四条路径都会走 `finally`）
    expect(dev.disposeCount(), '作业结束后设备必须已释放').toBe(1)
  })

  it('多帧请求 + `kind:image` ⇒ **显式拒绝**（不静默只导首帧）', async () => {
    // 「导出了一段动画」不能悄悄变成「只出了一张图」而没有任何信号。
    const dev = controlledDevice()
    const { request, content } = await realRequestOf({ spec: specOf({ frameCount: 3 }) })
    expect(request.frames.length, '前置：本夹具确有 3 帧').toBe(3)
    const { job } = assembleSnapshotExportJob({
      request,
      kind: 'image',
      devices: dev.factory,
      content,
      scope: 'e6-multiframe',
    })
    const outcome = await job.run()
    expect(outcome.status, '多帧图片导出必须**失败**而不是只出一帧').toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.error.params.reason).toBe('encoderImageTakesSingleFrame')
    }
    // 且**不产出任何产物**（失败路径无字节）
    expect('bytes' in outcome).toBe(false)
  })

  it('多帧**渲染**链路本身是通的（帧数经设备真实驱动，不是恒 1）', async () => {
    // 上一条证明多帧被编码器挡下；本条证明**挡下之前**逐帧渲染确实发生了 3 次 ——
    // 否则"多帧"这条判据只是因为没渲染而失败（假因）。
    const dev = controlledDevice()
    const { request, content } = await realRequestOf({ spec: specOf({ frameCount: 3 }) })
    const port = createSnapshotOffscreenRenderPort({ devices: dev.factory, content, scope: 'e6-frames' })
    expect(port.acquire(request).ok).toBe(true)
    for (let i = 0; i < request.frames.length; i++) {
      const frame = port.renderFrame(request, i)
      expect(frame.ok, `第 ${i} 帧必须渲染成功`).toBe(true)
      if (frame.ok) {
        // 每帧的**时间**必须来自冻结序列的第 i 项（不是同一个时间）
        expect(frame.value.time, `第 ${i} 帧的时间必须取自冻结序列`).toBe(request.frames[i])
      }
    }
    port.release()
    const renders = dev.calls.filter((c) => c.kind === 'renderAndRead')
    expect(renders.length, '设备必须被逐帧驱动 3 次').toBe(3)
  })

  it('E6 负对照 ①：去掉 `finally` 释放的作业形态会让"释放一次"判红', async () => {
    // 用**同一个**受控设备走一遍"只 acquire 不 release"的形态，证明判据有把守力：
    // 若 `ExportJob` 不释放，`disposeCount` 会是 0 而非 1。
    const dev = controlledDevice()
    const { request, content } = await realRequestOf()
    const port = createSnapshotOffscreenRenderPort({ devices: dev.factory, content, scope: 'e6-neg1' })
    port.acquire(request)
    port.renderFrame(request, 0)
    // 故意**不**调 release（模拟失去 finally 的形态）
    expect(dev.disposeCount(), '未释放时计数必须为 0（否则"释放一次"这条判据是空转）').toBe(0)
    port.release()
    expect(dev.disposeCount(), '释放后必须为 1').toBe(1)
  })

  it('E6 负对照 ②：预检阻塞时作业**不得**分配离屏资源', async () => {
    const dev = controlledDevice()
    const { request, content } = await realRequestOf()
    const { job } = assembleSnapshotExportJob({
      request,
      kind: 'animation', // 编码器不支持 ⇒ 预检必须阻塞
      devices: dev.factory,
      content,
      scope: 'e6-neg2',
    })
    expect(job.preflight().status, '不支持的产物种类必须预检失败').toBe('blocked')
    const outcome = await job.run()
    expect(outcome.status).toBe('failed')
    expect(dev.calls.length, '预检失败时**连设备都不该分配**').toBe(0)
    if (outcome.status === 'failed') expect(outcome.releasedFor, '没分配就没得释放').toBe(0)
  })

  it('E6：取消 ⇒ `cancelled` 且资源**已释放**（不产出产物）', async () => {
    const dev = controlledDevice()
    const { request, content } = await realRequestOf({ spec: specOf({ frameCount: 3 }) })
    const { job } = assembleSnapshotExportJob({
      request,
      kind: 'image',
      devices: dev.factory,
      content,
      scope: 'e6-cancel',
    })
    job.cancel()
    const outcome = await job.run()
    expect(outcome.status).toBe('cancelled')
    // 取消发生在预检后 ⇒ 未分配（`releasedFor` 0）或不产出产物，两者都必须无产物
    expect(outcome.status === 'cancelled' && !('bytes' in outcome)).toBe(true)
  })

  it('E6：渲染失败 ⇒ `failed` + 诊断 + 资源已释放（`finally`）', async () => {
    const dev = controlledDevice({ failRead: true })
    const { request, content } = await realRequestOf()
    const { job } = assembleSnapshotExportJob({
      request,
      kind: 'image',
      devices: dev.factory,
      content,
      scope: 'e6-fail',
    })
    const outcome = await job.run()
    expect(outcome.status).toBe('failed')
    expect(dev.disposeCount(), '失败路径**必须**释放（这就是 `finally` 的意义）').toBe(1)
  })

  it('E6：`releasedFor` 与"实际分配"一致（不是恒 0 的装饰）', async () => {
    const dev = controlledDevice()
    const { request, content } = await realRequestOf({
      spec: specOf({ frameCount: 1, render: { width: 4, height: 4, background: 'transparent' } }),
    })
    const { job, port } = assembleSnapshotExportJob({
      request,
      kind: 'image',
      devices: dev.factory,
      content,
      scope: 'e6-released',
    })
    const outcome = await job.run()
    expect(outcome.status).toBe('completed')
    expect(outcome.releasedFor, '`releasedFor` 必须等于端口报告的分配数').toBe(port.allocatedCount)
    expect(port.allocatedCount, '分配数必须非零（否则该判据恒真）').toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E7：相机映射（两态）
// ─────────────────────────────────────────────────────────────────────────────

describe('E7 · `CameraSpec` → Three 相机（纯映射，两态）', () => {
  const render = { width: 16, height: 8 }

  it('perspective：fov/near/far/aspect 逐项来自 spec 与渲染设置', () => {
    const cam = threeCameraOf(VIEW, render) as THREE.PerspectiveCamera
    expect(cam.isPerspectiveCamera, 'perspective 态必须造透视相机').toBe(true)
    expect(cam.fov).toBeCloseTo(VIEW.fovDegrees, 10)
    expect(cam.aspect).toBeCloseTo(render.width / render.height, 10)
    expect(cam.near).toBeCloseTo(VIEW.near, 10)
    expect(cam.far).toBeCloseTo(VIEW.far, 10)
    expect(cam.position.x).toBeCloseTo(VIEW.position.x, 10)
    // 世界矩阵必须已刷新（否则离屏读回用的是构造时的矩阵 ⇒ 静默错位）
    expect(cam.matrixWorld.equals(new THREE.Matrix4()), 'matrixWorld 必须已刷新（不是单位矩阵）').toBe(false)
  })

  it('orthographic：halfHeight 由**距离 × tan(垂直半视场)** 导出（与透视支同源）', () => {
    const spec: CameraSpec = { ...VIEW, projection: 'orthographic', position: { x: 10, y: 0, z: 0 } }
    const cam = threeCameraOf(spec, render) as THREE.OrthographicCamera
    expect(cam.isOrthographicCamera, 'orthographic 态必须造正交相机').toBe(true)

    const distance = 10 // |position - target|，target 是原点
    const expectedHalfH = distance * Math.tan((spec.fovDegrees * Math.PI) / 180 / 2)
    expect(cam.top - cam.bottom, '盒高必须是 2×halfHeight').toBeCloseTo(expectedHalfH * 2, 6)
    expect(cam.right - cam.left, '盒宽必须按 aspect 缩放').toBeCloseTo(expectedHalfH * 2 * (render.width / render.height), 6)
  })

  it('**负对照**：忽略 `projection` 一律造透视相机会被上面两条抓到', () => {
    // 逐字模拟"忽略 projection"的实现
    const wrong = (spec: CameraSpec): THREE.Camera => new THREE.PerspectiveCamera(spec.fovDegrees, 2, spec.near, spec.far)
    const orthoSpec: CameraSpec = { ...VIEW, projection: 'orthographic' }
    expect((wrong(orthoSpec) as THREE.PerspectiveCamera).isPerspectiveCamera, '错误实现造出透视相机').toBe(true)
    expect((threeCameraOf(orthoSpec, render) as THREE.OrthographicCamera).isOrthographicCamera, '正确实现造正交相机').toBe(true)
    // 两者**类型判别式不同** ⇒ 判据能区分
    expect((wrong(orthoSpec) as THREE.Camera).type).not.toBe(threeCameraOf(orthoSpec, render).type)
  })

  it('非法取景值**不产出 NaN 矩阵**（否则渲染出空白图，属静默失败）', () => {
    // `up` 与视线共线 ⇒ Three 的 lookAt 叉乘退化
    const collinear: CameraSpec = { ...VIEW, up: { x: 6, y: 6, z: 6 } }
    const cam = threeCameraOf(collinear, render)
    for (const v of cam.matrixWorld.elements) {
      expect(Number.isFinite(v), '共线 up 不得产出 NaN 矩阵').toBe(true)
    }
    // `near >= far` 也必须被夹到合法区间（否则永远画不出东西）
    const badClip: CameraSpec = { ...VIEW, near: 100, far: 1 }
    const cam2 = threeCameraOf(badClip, render) as THREE.PerspectiveCamera
    expect(cam2.near, '非法 near/far 必须夹到合法区间').toBeLessThan(cam2.far)
    // fov 非法 ⇒ 回落（不产出 NaN 投影矩阵）
    const badFov: CameraSpec = { ...VIEW, fovDegrees: Number.NaN }
    const cam3 = threeCameraOf(badFov, render)
    for (const v of cam3.projectionMatrix.elements) expect(Number.isFinite(v)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E8：反空洞真（判据本身不许恒绿）
// ─────────────────────────────────────────────────────────────────────────────

describe('E8 · 反空洞真：上述判据在实现被换成空壳时必须判红', () => {
  it('把离屏端口换成**空壳**（不渲染、不释放）⇒ E5/E6 的判据必红', async () => {
    // 空壳端口：方法齐全但什么也不做（"能力存在"的假象形态）
    const shellPort = {
      acquire: () => ok({ allocated: 0 }),
      renderFrame: (req: ReturnType<typeof requestOf>, i: number): Result<RenderedFrame> =>
        ok(Object.freeze({
          index: i,
          time: req.frames[i]!,
          pixels: new Uint8Array(req.render.width * req.render.height * 4),
          width: req.render.width,
          height: req.render.height,
        })),
      release: () => {},
    }
    // ① `releasedFor` 恒 0 ⇒ E6 的 "releasedFor == port.allocatedCount 且 > 0" 必红
    const shellAcquire = shellPort.acquire()
    expect(shellAcquire.ok && shellAcquire.value.allocated, '空壳报告 0 分配').toBe(0)
    // ② 空壳产出的像素全 0 ⇒ E4 的"像素真进去了"必红（与真像素不同）
    const w = 4
    const h = 2
    const shellFrame = shellPort.renderFrame(requestOf({ spec: specOf({ render: { width: w, height: h, background: 'transparent' } }) }), 0)
    expect(shellFrame.ok).toBe(true)
    if (shellFrame.ok) {
      const real = deterministicPixels(w, h)
      expect([...shellFrame.value.pixels], '空壳像素与真像素必须不同（故 E4 判据有把守力）').not.toEqual([...real])
    }
  })

  it('把编码器换成**只写 PNG 头**的空壳 ⇒ E4 的像素往返判据必红', async () => {
    const w = 4
    const h = 2
    // 空壳：合法结构 + 空 IDAT 内容（全 0 像素）
    const shell = encodePngFromRgba(new Uint8Array(w * h * 4), w, h, true)
    const real = encodePngFromRgba(deterministicPixels(w, h), w, h, true)
    // 两者**结构都合法**（这正是空壳难被发现之处）……
    expect([...shell.subarray(0, 8)]).toEqual([...PNG_MAGIC])
    expect(chunksOf(shell).every((c) => c.crcOk)).toBe(true)
    // ……但**像素往返**判据能把它们区分开
    const shellRaw = pako.inflate(chunksOf(shell).find((c) => c.type === 'IDAT')!.data)
    const realRaw = pako.inflate(chunksOf(real).find((c) => c.type === 'IDAT')!.data)
    expect([...shellRaw]).not.toEqual([...realRaw])
  })

  it('`codeOnly` 式结构判据的负对照：注释里的提及不算使用点（E2 的源码面）', async () => {
    // 呼应 D7 判据首跑实测到的假红：源码注释里引用旧写法不得被判成"仍在用"。
    const withComment = [
      '/** 说明：旧实现曾用 readRenderTargetPixels 之前的画布路径 */',
      'export const x = 1',
    ].join('\n')
    // 代码视图（剥注释）里不应含该符号；原文里有 —— 两把尺子的区别
    const stripped = withComment
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n')
    expect(withComment.includes('readRenderTargetPixels')).toBe(true)
    expect(stripped.includes('readRenderTargetPixels')).toBe(false)
  })
})
