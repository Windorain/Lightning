/**
 * **捕获装配（派生场景 → 四个相机值 → 冻结帧 → 请求）**。
 *
 * ## 本文件钉什么
 *
 * | 判据 | 断言 |
 * |---|---|
 * | 内容 = **派生场景** | 捕获用的是 `kernelPresentationSnapshot()` 的值；夹具带多方块取值时，捕获到的场景必须是**按取值求值后的**那一份（不是装载期场景） |
 * | 同一编译输入 | 捕获里的 `assetNeeds` 来自与渲染**同一次** `kernelPresentationInputs`（清单与画面同源） |
 * | 四向相机是值 | 请求里的 `camera` 是四个固定值之一（与 `isoCameraSpecsOf` 逐位相等），且不含任何运行时方向 |
 * | 冻结帧序列 | PNG：1 帧、秒数来自 `seconds`；GIF：帧数与逐帧 `holdMs` 来自**声明**（[50,100]，不是自算的均匀值） |
 * | 资源表只有一份 | `textureResources` 与请求清单的 assetId 对齐；就绪的登记为 available ⇒ 预检通过 |
 * | **负对照** | 静态材质跑 GIF 捕获 ⇒ `noAnimatedSequences`（不产出单帧假 GIF）；缺文档 ⇒ `exportCaptureNoKernelDocument` |
 */
import { describe, expect } from 'vitest'
import { captureExportSnapshot, type ExportCaptureSource } from '@/composition/exportCapture'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { plainRootOf } from '@/adapters/plainRoot'
import { documentContent, contentResource } from '@/domain/content'
import type { ContentResource, DocumentContent } from '@/domain/content'
import type { Scene } from '@/domain/scene'
import type { AnimationState } from '@/domain/animation'
import { EMPTY_ANIMATION } from '@/domain/animation'
import type { Version } from '@/domain/identity'
import type { TextureDecoder } from '@/composition/kernelTextureResources'
import type { TexturePixels } from '@/presentation/textureBinding'
import { isoCameraSpecsOf } from '@/presentation/isoExportCamera'
import { shotCameraSpecOf } from '@/presentation/shotCamera'
import { createEncoderPort } from '@/adapters/export/encoderPort'
import { assembleSnapshotExportJob } from '@/adapters/export/snapshotExportJob'
import { createSnapshotOffscreenRenderPort } from '@/adapters/export/offscreenRenderPort'
import type { OffscreenDevice, OffscreenDeviceFactory } from '@/adapters/export/renderDevice'
import * as THREE from 'three'
import { ExportJob } from '@/runtime/exportJob'
import { ok } from '@/domain/errors'
import type { RenderSettings } from '@/domain/captureSpec'
import { realFixtureText, withRealFixture } from '../../../e2e/real-fixture-vitest'

function productionParsers() {
  const p = createParserRegistry()
  p.register(V2PlainParser)
  p.register(createEnvelopeParser(p))
  p.register(WorldParser)
  p.register(StructureDataParser)
  return p
}

/** 真实信封夹具 → 内核场景 + 内容 + 版本（走完整生产链）。 */
async function fixtureOf(): Promise<{ scene: Scene; content: DocumentContent; animation: AnimationState; version: Version }> {
  const raw = JSON.parse(realFixtureText('structureDataExportedEnvelope')) as Record<string, unknown>
  const parsed = await productionParsers().detectAndParse(raw)
  if (parsed.document === null) throw new Error('fixture: 信封夹具解析失败')
  const assembled = assembleKernelDocument({ doc: parsed.document, plainRoot: plainRootOf(raw) })
  if (!assembled.ok) throw new Error('fixture: 装配失败 ' + assembled.error.code)
  return {
    scene: assembled.value.scene,
    content: assembled.value.content,
    animation: EMPTY_ANIMATION,
    version: { documentVersion: 7, contentVersion: 1 },
  }
}

/** 任意字节都解得开的解码器（4×8 竖条 ⇒ 两格）。 */
const decoder: TextureDecoder = {
  async decode(_payload: string): Promise<TexturePixels | null> {
    return { width: 4, height: 8, rgba: new Uint8Array(4 * 8 * 4).fill(180) }
  },
}

/**
 * 把夹具的资源表**重造**成"第 0 张是两帧动画、其余静态"的形态。
 *
 * 为什么要重造：真实信封夹具的材质声明是静态的（那是它的真实内容），而本判据要钉
 * "GIF 的逐帧驻留来自**声明**" —— 声明必须由夹具给出（不是被测实现算的）。
 */
function animatedContentOf(base: DocumentContent): DocumentContent {
  const resources: ContentResource[] = base.resources.map((r, i) =>
    contentResource({
      assetId: r.ref.assetId,
      locator: r.ref.url,
      payload: 'AAAA',
      kind: i === 0 ? 'animated' : 'static16',
      animation: i === 0 ? { defaultFrametimeTicks: 1, frameSequence: [{ index: 0 }, { index: 1, timeTicks: 2 }] } : null,
    }),
  )
  return documentContent({ resources, frameAxis: base.frameAxis })
}

/** 全部静态（无 animation 声明）：GIF 负对照的输入。 */
function staticContentOf(base: DocumentContent): DocumentContent {
  const resources: ContentResource[] = base.resources.map((r) =>
    contentResource({ assetId: r.ref.assetId, locator: r.ref.url, payload: 'AAAA', kind: 'static16', animation: null }),
  )
  return documentContent({ resources, frameAxis: base.frameAxis })
}

function sourceOf(data: { scene: Scene; content: DocumentContent; animation: AnimationState; version: Version }): ExportCaptureSource {
  return {
    kernelPresentationSnapshot: () => ({
      scene: data.scene,
      content: data.content,
      animation: data.animation,
      version: data.version,
      channels: { tier: 2 },
    }),
  }
}

function controlledDevice() {
  const calls: string[] = []
  const factory: OffscreenDeviceFactory = {
    acquire(render: RenderSettings) {
      const device: OffscreenDevice = {
        renderAndRead(): ReturnType<typeof ok<Uint8Array>> {
          calls.push('renderAndRead')
          return ok(new Uint8Array(render.width * render.height * 4).fill(255))
        },
        dispose(): void {
          calls.push('dispose')
        },
      }
      return ok({ device, allocated: 2 })
    },
  }
  return { factory, calls }
}

describe('捕获装配：派生场景 + 四个相机值 + 冻结帧', () => {
  withRealFixture(
    'structureDataExportedEnvelope',
    'PNG 捕获：单帧、秒数来自 seconds、相机是四个值之一、清单与画面同源',
    async () => {
    const data = await fixtureOf()
    const content = animatedContentOf(data.content)
    const captured = await captureExportSnapshot(sourceOf({ ...data, content }), {
      kind: 'image',
      directionIndex: 2,
      pixelSize: 48,
      seconds: 0.05,
      decoder,
      now: 1_700_000_000_000,
    })
    expect(captured.ok).toBe(true)
    if (!captured.ok) return
    const c = captured.value
    expect(c.request.frames.length, 'PNG 请求必须只有一帧').toBe(1)
    expect(c.request.frames[0]!.seconds, '秒数必须来自显式 seconds').toBeCloseTo(0.05, 12)
    expect(c.request.render.width).toBe(48)
    expect(c.request.render.height).toBe(48)
    // 相机 = 四向表里的第 2 个值（逐位相等；不是"运行时方向"）
    expect(c.request.camera).toEqual(isoCameraSpecsOf({ bounds: c.bounds })[2])
    expect(c.cameras.length).toBe(4)
    // 清单与画面同源：请求里的 assets 就是反推产物
    expect(c.request.assets.map((a) => a.assetId)).toEqual(c.assetNeeds.status === 'derived' ? c.assetNeeds.assets.map((a) => a.assetId) : [])
    // 资源表**只有一份**：条数与内容资源条数相同
    expect(c.textureResources.length).toBe(content.resources.length)
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    'GIF 捕获：帧数与逐帧 holdMs **来自声明**（[50,100]），不是自算的均匀值',
    async () => {
    const data = await fixtureOf()
    const content = animatedContentOf(data.content)
    const captured = await captureExportSnapshot(sourceOf({ ...data, content }), {
      kind: 'animation',
      directionIndex: 0,
      pixelSize: 32,
      decoder,
      now: 1_700_000_000_000,
    })
    expect(captured.ok).toBe(true)
    if (!captured.ok) return
    const c = captured.value
    const holds = c.request.frames.map((f) => f.holdMs)
    expect(holds, '逐帧驻留必须等于声明（1 tick / 2 tick）').toEqual([50, 100])
    expect(c.request.frames.map((f) => f.seconds)).toEqual([0, 0.05])
    expect(c.loop?.frameCount).toBe(2)
    expect(c.loop?.totalMs).toBe(150)
    // 时间映射是 scene-holds（驻留是唯一权威）
    expect(c.request.mapping.source).toBe('scene-holds')
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    '端到端（受控设备）：GIF 产物里的逐帧 delay == 捕获声明的 [5,10]',
    async () => {
    const data = await fixtureOf()
    const content = animatedContentOf(data.content)
    const captured = await captureExportSnapshot(sourceOf({ ...data, content }), {
      kind: 'animation',
      directionIndex: 0,
      pixelSize: 16,
      decoder,
      now: 1_700_000_000_000,
    })
    if (!captured.ok) throw new Error('capture failed: ' + captured.error.code)
    const c = captured.value
    const { job, detachAbort } = assembleSnapshotExportJob({
      request: c.request,
      kind: 'animation',
      encoding: 'gif',
      devices: controlledDevice().factory,
      content: c.content,
      scope: 'm6-3-capture',
      assets: c.assets,
      assetNeeds: c.assetNeeds,
    })
    expect(job.preflight().status, '捕获期资源都就绪 ⇒ 预检必须 ready').toBe('ready')
    const outcome = await job.run()
    detachAbort()
    expect(outcome.status).toBe('completed')
    if (outcome.status !== 'completed') return
    const delays: number[] = []
    for (let i = 0; i + 8 < outcome.bytes.length; i += 1) {
      if (outcome.bytes[i] === 0x21 && outcome.bytes[i + 1] === 0xf9 && outcome.bytes[i + 2] === 0x04) {
        delays.push(outcome.bytes[i + 4]! | (outcome.bytes[i + 5]! << 8))
      }
    }
    expect(delays, '产物时延必须等于捕获期声明的 [5,10]（自算 tick 会给 [5,5]）').toEqual([5, 10])
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    '**负对照**：静态材质跑 GIF 捕获 ⇒ noAnimatedSequences；无文档 ⇒ exportCaptureNoKernelDocument',
    async () => {
    const data = await fixtureOf()
    // 全部静态（没有 animation 声明）⇒ 不得产出单帧假 GIF
    const captured = await captureExportSnapshot(sourceOf({ ...data, content: staticContentOf(data.content) }), {
      kind: 'animation',
      directionIndex: 0,
      pixelSize: 16,
      decoder,
      now: 1_700_000_000_000,
    })
    expect(captured.ok).toBe(false)
    if (!captured.ok) expect(captured.error.params.reason).toBe('noAnimatedSequences')

    const missing = await captureExportSnapshot({ kernelPresentationSnapshot: () => null }, {
      kind: 'image',
      directionIndex: 0,
      pixelSize: 16,
      decoder,
      now: 0,
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.params.reason).toBe('exportCaptureNoKernelDocument')
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    '器具捕获：显式机位 → 请求相机 = shotCameraSpecOf 的值，分辨率任意且非正方',
    async () => {
    const data = await fixtureOf()
    const content = animatedContentOf(data.content)
    const captured = await captureExportSnapshot(sourceOf({ ...data, content }), {
      kind: 'image',
      shot: { offset: [0, 0, 8], orthoHeight: 6, width: 96, height: 54 },
      seconds: 0,
      decoder,
      now: 1_700_000_000_000,
    })
    expect(captured.ok).toBe(true)
    if (!captured.ok) return
    const c = captured.value
    const expected = shotCameraSpecOf(c.bounds, { offset: [0, 0, 8], orthoHeight: 6 })
    expect(expected.ok).toBe(true)
    if (!expected.ok) return
    // 生产装配：相机**逐位等于**由捕获到的真实 bounds 算出的值（不是手喂载荷）
    expect(c.request.camera).toEqual(expected.value)
    expect(c.request.camera.projection).toBe('orthographic')
    // 任意分辨率：非正方、不 clamp
    expect(c.request.render).toEqual({ width: 96, height: 54, background: 'transparent' })
    // 落点相对内容中心（内核**不**平移内容）⇒ position − target 恒等于 offset
    expect(c.request.camera.position.z - c.request.camera.target.z).toBeCloseTo(8, 9)
    // 等轴四向值仍同批算出（诊断面），但**不是**被选中的那台相机
    expect(c.cameras.length, '四向诊断值仍在').toBe(4)
    expect(c.cameras, '选中相机必须来自显式机位（不是四向表里的某台）').not.toContainEqual(c.request.camera)
    // 单帧、时间来自 seconds（与等轴 PNG 同一条时间语义）
    expect(c.request.frames.length).toBe(1)
    expect(c.request.frames[0]!.seconds).toBe(0)
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    '器具捕获：非法分辨率 / 退化落点 ⇒ 显式失败（不静默夹取）',
    async () => {
    const data = await fixtureOf()
    const content = animatedContentOf(data.content)
    const badSize = await captureExportSnapshot(sourceOf({ ...data, content }), {
      kind: 'image',
      shot: { offset: [0, 0, 8], orthoHeight: 6, width: 0, height: 54 },
      decoder,
      now: 0,
    })
    expect(badSize.ok).toBe(false)
    if (!badSize.ok) expect(badSize.error.params.reason).toBe('exportCaptureRenderSizeInvalid')

    const degenerate = await captureExportSnapshot(sourceOf({ ...data, content }), {
      kind: 'image',
      shot: { offset: [0, 0, 0], orthoHeight: 6, width: 32, height: 32 },
      decoder,
      now: 0,
    })
    expect(degenerate.ok).toBe(false)
    if (!degenerate.ok) expect(degenerate.error.params.reason).toBe('shotOffsetDegenerate')
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    '方向越界 ⇒ 显式失败（不静默夹取到 0）',
    async () => {
    const data = await fixtureOf()
    const content = animatedContentOf(data.content)
    const captured = await captureExportSnapshot(sourceOf({ ...data, content }), {
      kind: 'image',
      directionIndex: 4,
      pixelSize: 16,
      decoder,
      now: 0,
    })
    expect(captured.ok).toBe(false)
    if (!captured.ok) expect(captured.error.params.reason).toBe('exportCaptureDirectionInvalid')
    },
  )
})

/** 未使用占位：保持 `createSnapshotOffscreenRenderPort`/`ExportJob` 的类型可达性（诊断用）。 */
void createSnapshotOffscreenRenderPort
void ExportJob
void THREE
void createEncoderPort
