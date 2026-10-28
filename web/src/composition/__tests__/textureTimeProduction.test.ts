/**
 * **纹理时间真的从生产声明走到呈现采样**。
 *
 * ## 为什么这一条是"最关键"的判据
 *
 * 纯采样器、纯派生函数、甚至 presenter 的采样段都可以用手搓的 `TextureBinding`
 * 喂成绿色 —— 而生产链可能**从不填** `ContentResource.animation`（D2 `gridInputOf`
 * 漏传 `cellPalette`、`gridPayload` 漏填尺寸列正是同族两连）。故本文件的输入
 * **只有**一份夹具 JSON：
 *
 * ```
 * e2e/fixtures/texture-strip-animated.v2.json
 *   → createParserRegistry + V2PlainParser + Envelope + World + StructureData（生产解析）
 *   → adoptLoadedDocument（生产装配）
 *   → doc.content.resources[0].animation（声明）
 *   → textureResourcesOf（解码 16×64 ⇒ 派生序列）
 *   → textureBindingsOf / bindTextures（唯一绑定生产点）
 *   → PresenterSession.applyKernelDocument（每帧 setSceneTime）
 *   → textureSamples()（真实读数）
 * ```
 *
 * 唯一被替身的是**解码器**（`createImageBitmap` 需要浏览器）与**纹理上传**
 * （用生产的 `createViewportTexturePort`，它的 `DataTexture` 构造不需要 GL）。
 *
 * ## 判据（对应设计 §5.2-④）
 *
 *  1. 绑定真的带 `animation`（格数/时长），且**不进**材质身份；
 *  2. 0.12s ⇒ frame 1 / offset .25；0.30s ⇒ frame 3；回 0.12s ⇒ frame 1（**倒退**）；
 *  3. 时间变而内容不变 ⇒ `applied === false` 且 `applies` 不增；文档版本变 ⇒ `applied === true`；
 *  4. 离屏同入口（`applyIfChanged` 冻结序列）同样逐帧变化；
 *  5. 负对照：把资源声明改回**静态**（`kind:'static16'` 且 `animation:null`）⇒ 绑定无动画、
 *     读数清空（证明动画**确实**来自生产声明，不是测试塞进去的）。
 *
 *     ⚠️ 与设计稿 §5.2-④ 的一处**有意偏差**：设计稿写"把 `animation` 置 null ⇒ 无动画"，
 *     但设计稿 §2.1-3 同时要求"`kind==='animated'` 且声明为 null ⇒ 按 MC 默认（frametime=1、
 *     顺序播放全部格）"。两条不能同时成立 —— 后者是 mcmeta 的真实语义（`.mcmeta` 可以只写
 *     `{"animation":{}}`），故实现按 §2.1-3 落地，负对照改用**kind** 承担"无动画"这条事实。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { KernelSession, KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID } from '@/runtime/kernelSession'
import { PresenterSession } from '@/composition/presenterSession'
import { createViewportTexturePort } from '@/composition/viewportTexturePort'
import { textureResourcesOf, type TextureDecoder } from '@/composition/kernelTextureResources'
import { materialIdentityOf } from '@/presentation/presenter'
import type { TexturePixels } from '@/presentation/textureBinding'
import type { Document } from '@/domain/document'
import { timeValue } from '@/domain/animation'
import type { TimeValue } from '@/domain/animation'

const FIXTURE = path.join(process.cwd(), 'e2e', 'fixtures', 'texture-strip-animated.v2.json')

/** 16×64 竖条像素（4 格）。像素内容无关：本文件断言"格数来自像素尺寸 + 采样读数"。 */
const stripDecoder: TextureDecoder = {
  decode: async (): Promise<TexturePixels | null> => ({ width: 16, height: 64, rgba: new Uint8Array(16 * 64 * 4) }),
}

/** 生产解析 + 生产装配（两条脊柱之一：`adoptLoadedDocument`）。 */
async function loadFixture(): Promise<{ kernel: KernelSession; doc: Document }> {
  const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n')) as Record<string, unknown>
  const registry = createParserRegistry()
  registry.register(V2PlainParser)
  registry.register(createEnvelopeParser(registry))
  registry.register(WorldParser)
  registry.register(StructureDataParser)
  const parsed = await registry.detectAndParse(raw)
  expect(parsed.document, '生产解析必须成功').not.toBeNull()
  const kernel = new KernelSession({ documentId: KERNEL_DOCUMENT_ID, contextId: KERNEL_CONTEXT_ID, capabilities: [] })
  const ok = adoptLoadedDocument({ kernel, log: { info: () => {}, warn: () => {} } }, parsed.document!, raw, FIXTURE)
  expect(ok, '生产装配必须成功').toBe(true)
  const doc = kernel.document()
  expect(doc, '装配后必须有内核文档').not.toBeNull()
  return { kernel, doc: doc! }
}

/** 走生产端口把资源交给呈现器，并按当前材质编译产物绑定（顺序与视口接线一致）。 */
async function wire(doc: Document): Promise<{ surface: PresenterSession; port: ReturnType<typeof createViewportTexturePort> }> {
  const port = createViewportTexturePort('test:texture-time-production')
  const surface = new PresenterSession({ scope: 'test:texture-time-production', textures: port })
  surface.applyKernelDocument(doc, timeValue(0, 20))
  const resources = await textureResourcesOf(doc.content.resources, stripDecoder)
  port.sync(resources)
  surface.bindTextures(resources)
  return { surface, port }
}

function disposeAll(surface: PresenterSession, port: { dispose(): void }): void {
  surface.dispose()
  port.dispose()
}

describe('生产装配：声明 → 绑定 → 每帧采样', () => {
  it('① 生产声明派生出的绑定带序列（4 格、时长 [0.1,0.15,0.05,0.1]），且**不进**材质身份', async () => {
    const { doc } = await loadFixture()
    const resources = await textureResourcesOf(doc.content.resources, stripDecoder)
    expect(resources, '夹具必须有一条资源').toHaveLength(1)
    const resource = resources[0]!
    expect(resource.state, '就绪：声明必须来自夹具的 materialPalette.animation').toBe('ready')
    expect(resource.animation, '生产派生必须产出序列').toBeDefined()
    expect(resource.animation!.stripFrameCount).toBe(4)
    expect(resource.animation!.sequence.frames.map((f) => f.duration.num / f.duration.den)).toEqual([
      0.1, 0.15, 0.05, 0.1,
    ])

    const { surface, port } = await wire(doc)
    try {
      const samples = surface.textureSamples()
      expect(samples, '接线后必须已有读数（空数组即"纹理时间未接线"）').toHaveLength(1)
      expect(samples[0]!.assetId).toBe('material:0')
      // 材质身份**不含**动画：同一 map 的"有动画/无动画"两个绑定必须是同一材质身份
      const descriptor = surface.materialDescriptors().find((m) => m.id === 'material:0')
      expect(descriptor, '编译产物必须有 material:0').toBeDefined()
      const a = materialIdentityOf(descriptor!, {
        materialId: descriptor!.id,
        materialVersion: descriptor!.version,
        map: resource.identity,
        sampling: { filter: 'nearest', wrap: 'clamp', flipY: false, mipmaps: false, anisotropy: 0 },
        missingRequired: false,
      })
      const b = materialIdentityOf(descriptor!, {
        materialId: descriptor!.id,
        materialVersion: descriptor!.version,
        map: resource.identity,
        sampling: { filter: 'nearest', wrap: 'clamp', flipY: false, mipmaps: false, anisotropy: 0 },
        missingRequired: false,
        animation: resource.animation,
      })
      expect(b.id, '动画声明不得改变材质身份（否则换播放速度会触发重编）').toBe(a.id)
    } finally {
      disposeAll(surface, port)
    }
  })

  it('② 时间 → 样本：0.12s ⇒ frame 1；0.30s ⇒ frame 3；回 0.12s ⇒ frame 1（倒退）', async () => {
    const { doc } = await loadFixture()
    const { surface, port } = await wire(doc)
    try {
      surface.applyKernelDocument(doc, timeValue(2.4, 20))
      expect(surface.textureSamples()[0], '读数必须随 applyKernelDocument 的时间走').toMatchObject({
        seconds: 0.12,
        frame: 1,
        offsetY: 0.25,
        repeatY: 0.25,
      })

      surface.applyKernelDocument(doc, timeValue(6, 20))
      expect(surface.textureSamples()[0]).toMatchObject({ seconds: 0.3, frame: 3, offsetY: 0.75 })

      // **倒退**：累加器实现没有这条通路（样本会停在 frame 3）
      surface.applyKernelDocument(doc, timeValue(2.4, 20))
      expect(surface.textureSamples()[0]).toMatchObject({ seconds: 0.12, frame: 1, offsetY: 0.25 })
    } finally {
      disposeAll(surface, port)
    }
  })

  it('②b 有理帧率：seconds 来自 sceneClockOf（1@30000/1001 ⇒ 1001/30000，不是各自 frame/fps 的重算）', async () => {
    const { doc } = await loadFixture()
    const { surface, port } = await wire(doc)
    try {
      surface.applyKernelDocument(doc, timeValue(1, { num: 30000, den: 1001 }))
      const seconds = surface.textureSamples()[0]!.seconds
      expect(Math.abs(seconds - 1001 / 30000)).toBeLessThan(1e-15)
    } finally {
      disposeAll(surface, port)
    }
  })

  it('③ 时间变而内容不变 ⇒ applied=false 且 applies 不增；文档版本变 ⇒ applied=true（负对照）', async () => {
    const { doc } = await loadFixture()
    const { surface, port } = await wire(doc)
    try {
      const base = surface.statsSnapshot()
      const a = surface.applyKernelDocument(doc, timeValue(2.4, 20))
      const b = surface.applyKernelDocument(doc, timeValue(6, 20))
      const c = surface.applyKernelDocument(doc, timeValue(2.4, 20))
      expect([a.applied, b.applied, c.applied], '时间不是结构身份 ⇒ 三次都不得重编').toEqual([false, false, false])
      expect(surface.statsSnapshot().applies, 'applies 不得增长（播放期零全量重编）').toBe(base.applies)
      expect(surface.statsSnapshot().materialBuilds).toBe(base.materialBuilds)
      expect(surface.statsSnapshot().batchBuilds).toBe(base.batchBuilds)
      // 但样本必须真的在变（否则上面三条会因为"根本没接线"而恒真）
      expect(surface.textureSamples()[0]!.frame).toBe(1)

      const versioned: Document = {
        ...doc,
        version: { ...doc.version, documentVersion: doc.version.documentVersion + 1 },
      }
      const d = surface.applyKernelDocument(versioned, timeValue(2.4, 20))
      expect(d.applied, '负对照：文档版本变 ⇒ 必须重编（不是"永远不重编"）').toBe(true)
      expect(surface.statsSnapshot().applies).toBe(base.applies + 1)
    } finally {
      disposeAll(surface, port)
    }
  })

  it('④ 离屏同一入口：applyIfChanged 的冻结时间序列逐帧给出不同样本', async () => {
    const { doc } = await loadFixture()
    const { surface, port } = await wire(doc)
    try {
      // 与 `adapters/export/offscreenRenderPort` 的调用形态逐字一致（scene/content/key）。
      const keyAt = (t: TimeValue) => ({
        documentVersion: doc.version.documentVersion,
        scene: doc.scene.id,
        time: { seconds: t.frame / (typeof t.fps === 'number' ? t.fps : 20), numerator: t.frame, denominator: 20 },
        parameterVersion: 0,
        contentResourceVersions: {},
      })
      const frozen = [
        { frame: 2.4, fps: 20 },
        { frame: 6, fps: 20 },
        { frame: 2.4, fps: 20 },
      ]
      const frames: number[] = []
      for (const t of frozen) {
        const out = surface.applyIfChanged({ scene: doc.scene, content: doc.content, key: keyAt(t) })
        expect(out.compileError).toBeNull()
        frames.push(surface.textureSamples()[0]!.frame)
      }
      expect(frames, '离屏冻结节拍：frame 1 → 3 → 1（同一时间同一样本）').toEqual([1, 3, 1])
    } finally {
      disposeAll(surface, port)
    }
  })

  it('⑤ 负对照：资源声明改回静态（kind=static16、animation=null）⇒ 绑定无动画、读数清空', async () => {
    const { doc } = await loadFixture()
    // 只改**输入声明**（不动任何绑定）：证明动画来自生产声明，而不是测试手塞。
    const stripped: Document = {
      ...doc,
      content: {
        ...doc.content,
        resources: doc.content.resources.map((r) => ({ ...r, kind: 'static16' as const, animation: null })),
      },
    }
    const { surface, port } = await wire(stripped)
    try {
      const resources = await textureResourcesOf(stripped.content.resources, stripDecoder)
      expect(resources[0]!.state, '贴图本身仍就绪').toBe('ready')
      expect(resources[0]!.animation, '没有声明 ⇒ 不派生序列').toBeUndefined()
      expect(surface.textureSamples(), '没有动画 ⇒ 无读数（不得残留上一份文档的样本）').toEqual([])
      // 画面仍在（贴图照样贴上）：这是"静态贴图"而不是"资源坏了"
      surface.applyKernelDocument(stripped, timeValue(2.4, 20))
      expect(surface.textureSamples()).toEqual([])
      expect(surface.statsSnapshot().batchObjects).toBeGreaterThan(0)
    } finally {
      disposeAll(surface, port)
    }
  })
})
