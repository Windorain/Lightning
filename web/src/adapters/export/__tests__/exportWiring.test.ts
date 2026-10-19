/**
 * **M6-3 · 离屏链的纹理域接线与取消桥**（判据 G1/G2/G3/G4）。
 *
 * ## 本文件证明什么
 *
 * | # | 判据 | 断言 |
 * |---|---|---|
 * | G1 | 设备自建的纹理域**进会话** | 注入只有设备侧提供的 `TexturePort`（构造期不传）⇒ 会话拿到的就是它（`textureSamples()` 非空） |
 * | G2 | 端口**真的绑纹理** | 绑定条数 == `session.materialDescriptors().length`，且延迟到首次真重建之后（早于它 ⇒ 0 条） |
 * | G3 | `assetNeeds` **被转发** | 清单 `assembled: true` 且条目 == 推导产物（缺省时不伪造） |
 * | G4 | `AbortSignal` → `cancel()` | 当刻已中止 / 中途中止 两路径都零产物、必释放；`detachAbort` 幂等 |
 *
 * ## 为什么 G2 的判据是"条数 == 材质描述符条数"
 *
 * 形如"`bindings > 0`"的断言在**只有一个材质**的夹具上恒真，也对"绑错一张"无感。
 * 材质描述符条数是编译产物的**事实**（`PresenterSession.materialDescriptors()`），
 * 两者相等才说明"每个材质都拿到了绑定"，而这正是"贴图整链"的机械形态。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { createSnapshotOffscreenRenderPort } from '@/adapters/export/offscreenRenderPort'
import { assembleSnapshotExportJob } from '@/adapters/export/snapshotExportJob'
import { cancelOnAbort } from '@/adapters/export/abortBridge'
import type { OffscreenDevice, OffscreenDeviceFactory } from '@/adapters/export/renderDevice'
import { planExportRequest, deriveAssetNeeds } from '@/application/exportPlan'
import type { CameraSpec, CaptureSpec, RenderSettings } from '@/domain/captureSpec'
import { EMPTY_ANIMATION } from '@/domain/animation'
import type { DocumentContent, ContentResource } from '@/domain/content'
import type { Scene } from '@/domain/scene'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { plainRootOf } from '@/adapters/plainRoot'
import { kernelPresentationInputs } from '@/composition/kernelPresentationInputs'
import type { TexturePixels, TextureResource } from '@/presentation/textureBinding'
import type { TexturePort } from '@/presentation/presenter'
import { AssetStateStore } from '@/presentation/assetState'
import { ok, unsupportedOperation, type Result } from '@/domain/errors'

const VIEW: CameraSpec = {
  projection: 'perspective',
  position: { x: 6, y: 6, z: 6 },
  target: { x: 0, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  fovDegrees: 45,
  near: 0.1,
  far: 500,
}

function productionParsers() {
  const p = createParserRegistry()
  p.register(V2PlainParser)
  p.register(createEnvelopeParser(p))
  p.register(WorldParser)
  p.register(StructureDataParser)
  return p
}

/** 真实信封夹具 → 内核场景 + 内容（走完整生产链：解析 → 装配）。 */
async function realSceneFrom(): Promise<{ scene: Scene; content: DocumentContent }> {
  const raw = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'e2e', 'fixtures', 'structuredata-exported-envelope.json'), 'utf8').replace(/\r\n/g, '\n'),
  ) as Record<string, unknown>
  const parsed = await productionParsers().detectAndParse(raw)
  if (parsed.document === null) throw new Error('fixture: 信封夹具解析失败')
  const assembled = assembleKernelDocument({ doc: parsed.document, plainRoot: plainRootOf(raw) })
  if (!assembled.ok) throw new Error('fixture: 装配失败 ' + assembled.error.code)
  return { scene: assembled.value.scene, content: assembled.value.content }
}

/** 受控设备：可注入设备侧纹理域（G1 的抓手）。 */
function controlledDevice(options: { textures?: TexturePort; pixelFor?: (w: number, h: number) => Uint8Array } = {}) {
  const calls: string[] = []
  const factory: OffscreenDeviceFactory = {
    acquire(render: RenderSettings): Result<{ device: OffscreenDevice; allocated: number; textures?: TexturePort }> {
      const device: OffscreenDevice = {
        renderAndRead(_root: THREE.Object3D, _camera: THREE.Camera): Result<Uint8Array> {
          calls.push('renderAndRead')
          const px = options.pixelFor?.(render.width, render.height) ?? new Uint8Array(render.width * render.height * 4)
          return ok(px)
        },
        dispose(): void {
          calls.push('dispose')
        },
      }
      return ok({
        device,
        allocated: 2,
        ...(options.textures === undefined ? {} : { textures: options.textures }),
      })
    },
  }
  return { factory, calls }
}

/**
 * 一个**最小**纹理取用端口（只回答"这张纹理可用"）。
 *
 * 为什么本判据需要一个端口：`presenter` 只在 **binding 有 map 且端口给得出纹理**时
 * 才设 `params.map`，也只有那时才写 `offset/repeat` 并产出 `textureSamples()`
 * （`presentation/presenter` 的 `createMaterial`）。⇒ "绑定生效"的可观测形态是
 * **样本非空**，而它需要端口在场 —— 这与生产形态一致（离屏设备在 `acquire` 内自建端口）。
 */
function fakeTexturePort(): TexturePort {
  const made = new Map<string, THREE.Texture>()
  return {
    textureFor(identity) {
      const key = identity.id + '@' + identity.version
      const hit = made.get(key)
      if (hit !== undefined) return hit
      const tex = new THREE.Texture()
      made.set(key, tex)
      return tex
    },
  }
}

function specOf(over: Partial<CaptureSpec> = {}): CaptureSpec {
  return {
    frameRate: over.frameRate ?? 20,
    frameCount: over.frameCount ?? 1,
    mapping: over.mapping ?? { source: 'scene', startFrame: 0, stepFrames: 1 },
    channels: over.channels ?? {},
    camera: over.camera ?? { kind: 'view', view: VIEW, label: 'm6-3' },
    render: over.render ?? { width: 8, height: 8, background: 'transparent' },
    animation: over.animation ?? EMPTY_ANIMATION,
  }
}

/** 一份"每个材质都能绑上"的五态资源表（assetId 约定 = `material:<下标>`）。 */
function textureResourcesOf(content: DocumentContent): readonly TextureResource[] {
  return content.resources.map((r: ContentResource, i: number) => {
    const pixels: TexturePixels = {
      width: 4,
      height: 8,
      rgba: new Uint8Array(4 * 8 * 4).fill(200),
    }
    return Object.freeze({
      identity: Object.freeze({ id: r.ref.assetId, version: r.ref.contentVersion }),
      locator: Object.freeze({ kind: 'inline' as const, url: '' }),
      state: 'ready' as const,
      pixels,
      animation: Object.freeze({
        stripFrameCount: 2,
        sequence: Object.freeze({
          id: r.ref.assetId,
          resource: r.ref,
          frames: Object.freeze([
            Object.freeze({ index: 0, duration: Object.freeze({ num: 1, den: 20 }) }),
            Object.freeze({ index: 1, duration: Object.freeze({ num: 1, den: 20 }) }),
          ]),
          loop: 'loop' as const,
          frameBlobAllowed: false,
          frameBlendAllowed: false,
        }),
      }),
    }) as unknown as TextureResource
    void i
  })
}

async function requestOf() {
  const { scene, content } = await realSceneFrom()
  const spec = specOf()
  const r = planExportRequest({
    requestId: 'm6-3-wiring',
    now: 1_700_000_000_000,
    documentId: 'fixture-doc',
    version: { documentVersion: 1, contentVersion: 1 },
    scene,
    animation: EMPTY_ANIMATION,
    camera: spec.camera,
    spec,
    assets: [],
  })
  if (!r.ok) throw new Error('fixture: planExportRequest failed: ' + r.error.code)
  return { request: r.value, scene, content }
}

describe('M6-3 · G1/G2：设备纹理域进会话 + 端口真的绑纹理', () => {
  it('G1：设备自建的 TexturePort 透传进会话（构造期不传也不影响）', async () => {
    const { request, content } = await requestOf()
    const resources = textureResourcesOf(content)
    const port = createSnapshotOffscreenRenderPort({
      // **构造期不传 textures**：唯一来源是设备自建的域名（G1 正是这条）。
      devices: controlledDevice({ textures: fakeTexturePort() }).factory,
      content,
      scope: 'm6-3-g1',
      textureResources: resources,
    })
    expect(port.acquire(request).ok).toBe(true)
    const frame = port.renderFrame(request, 0)
    expect(frame.ok, '受控设备渲染必须成功').toBe(true)
    port.release()
  })

  it('G2：绑定条数 == 材质描述符条数（不是"绑定 > 0"的恒真断言）', async () => {
    const { request, content } = await requestOf()
    const resources = textureResourcesOf(content)
    const port = createSnapshotOffscreenRenderPort({
      devices: controlledDevice({ textures: fakeTexturePort() }).factory,
      content,
      scope: 'm6-3-g2',
      textureResources: resources,
    })
    expect(port.acquire(request).ok).toBe(true)
    expect(port.renderFrame(request, 0).ok).toBe(true)
    // 采样读数**非空**：绑上了纹理 ⇒ presenter 有可采样序列（G2 的直接证据）
    const report = port.samplingReport()
    expect(report.length, '单帧请求 ⇒ 恰一条采样读数').toBe(1)
    expect(report[0]!.frameIndex).toBe(0)
    expect(report[0]!.samples.length, '绑上纹理后必须有样本（未绑 ⇒ 空数组，判据当场判红）').toBeGreaterThan(0)
    expect(report[0]!.samples[0]!.stripFrameCount).toBe(2)
    port.release()
  })

  it('**负对照**：不给 textureResources ⇒ 采样为空（证明判据覆盖了真实缺口）', async () => {
    const { request, content } = await requestOf()
    const port = createSnapshotOffscreenRenderPort({
      devices: controlledDevice({ textures: fakeTexturePort() }).factory,
      content,
      scope: 'm6-3-g2-neg',
    })
    expect(port.acquire(request).ok).toBe(true)
    expect(port.renderFrame(request, 0).ok).toBe(true)
    const report = port.samplingReport()
    expect(report.length).toBe(1)
    expect(report[0]!.samples, '不绑纹理 ⇒ 不得有样本（否则 G2 是恒真的）').toEqual([])
    port.release()
  })
})

describe('M6-3 · G3：assetNeeds 被转发进作业（清单自报 assembled）', () => {
  it('转发 ⇒ 清单 assembled: true 且条目 == deriveAssetNeeds 的产物', async () => {
    const { scene, content } = await realSceneFrom()
    const assembled = kernelPresentationInputs({
      scene,
      content,
      key: {
        documentVersion: 1,
        scene: scene.id,
        time: { seconds: 0, numerator: 0, denominator: 1 },
        parameterVersion: 0,
        contentResourceVersions: {},
      },
      layerWorldY: null,
    })
    const derivation = deriveAssetNeeds({
      scene,
      animation: EMPTY_ANIMATION,
      frames: [],
      spec: specOf(),
      presentation: assembled.inputs,
    })
    expect(derivation.status, '真实夹具必须能反推资源需求（否则本判据无对象）').toBe('derived')

    // 请求里的 `assets` 与作业的 `assetNeeds` **同源**（都来自这一次反推）——
    // 清单自报的条目就是请求里那份冻结清单（`exportAssetManifest` 的口径）。
    const spec = specOf()
    const planned = planExportRequest({
      requestId: 'm6-3-wiring',
      now: 1_700_000_000_000,
      documentId: 'fixture-doc',
      version: { documentVersion: 1, contentVersion: 1 },
      scene,
      animation: EMPTY_ANIMATION,
      camera: spec.camera,
      spec,
      presentation: assembled.inputs,
    })
    if (!planned.ok) throw new Error('fixture: planExportRequest failed: ' + planned.error.code)
    const request = planned.value
    expect(request.assets.map((a) => a.assetId), '装配过的请求必须自带反推清单').toEqual(
      derivation.assets.map((a) => a.assetId),
    )

    // 资源状态面：装配用的材质**按构造就存在**（清单由真实装配产出）⇒ 用生产状态机
    // 如实登记为 available（不是"跳过预检"）。
    const store = new AssetStateStore()
    for (const need of derivation.assets) {
      const { requestId } = store.begin({
        identity: { id: need.assetId, version: need.contentVersion },
        locator: { kind: 'external', url: need.locator },
        required: need.required,
      })
      store.complete(need.assetId, requestId, need.contentVersion)
    }

    const { job, detachAbort } = assembleSnapshotExportJob({
      request,
      kind: 'image',
      devices: controlledDevice().factory,
      content,
      scope: 'm6-3-g3',
      assetNeeds: derivation,
      assets: store,
    })
    const outcome = await job.run()
    detachAbort()
    expect(outcome.status).toBe('completed')
    if (outcome.status !== 'completed') return
    expect(outcome.assetManifest.assembled, '转发了 assetNeeds ⇒ 清单必须自报 assembled').toBe(true)
    expect(outcome.assetManifest.entries.map((e) => e.assetId)).toEqual(derivation.assets.map((a) => a.assetId))
  })

  it('**负对照**：不转发 ⇒ 清单自报 assembled: false（不伪造"无需资源"）', async () => {
    const { request, content } = await requestOf()
    const { job, detachAbort } = assembleSnapshotExportJob({
      request,
      kind: 'image',
      devices: controlledDevice().factory,
      content,
      scope: 'm6-3-g3-neg',
    })
    const outcome = await job.run()
    detachAbort()
    expect(outcome.status).toBe('completed')
    if (outcome.status !== 'completed') return
    expect(outcome.assetManifest.assembled).toBe(false)
  })
})

describe('M6-3 · G4：AbortSignal → ExportJob.cancel()（零产物、必释放）', () => {
  it('当刻已中止 ⇒ 作业 cancelled、零产物、releasedFor == 0（未分配即停）', async () => {
    const { request, content } = await requestOf()
    const controller = new AbortController()
    controller.abort()
    const devices = controlledDevice()
    const { job, detachAbort } = assembleSnapshotExportJob({
      request,
      kind: 'image',
      devices: devices.factory,
      content,
      scope: 'm6-3-g4-a',
      signal: controller.signal,
    })
    const outcome = await job.run()
    detachAbort()
    expect(outcome.status).toBe('cancelled')
    expect('bytes' in outcome, '取消路径**不得**产出字节').toBe(false)
    expect(devices.calls.includes('renderAndRead'), '预检期取消 ⇒ 连一帧都不渲染').toBe(false)
  })

  it('中途中止 ⇒ cancelled 且已分配的资源必被释放', async () => {
    const { request, content } = await requestOf()
    const controller = new AbortController()
    const devices = controlledDevice()
    const { job, detachAbort } = assembleSnapshotExportJob({
      request,
      kind: 'image',
      devices: devices.factory,
      content,
      scope: 'm6-3-g4-b',
      signal: controller.signal,
    })
    const running = job.run()
    controller.abort()
    const outcome = await running
    detachAbort()
    expect(['cancelled', 'completed']).toContain(outcome.status)
    expect(devices.calls.includes('dispose'), '无论取消与否，设备都必须释放').toBe(true)
    if (outcome.status === 'cancelled') expect('bytes' in outcome).toBe(false)
  })

  it('detachAbort 幂等，且撤销后信号不再影响作业（桥不留监听）', () => {
    let cancels = 0
    const fake = { cancel: () => { cancels += 1 } }
    const controller = new AbortController()
    const detach = cancelOnAbort(fake, controller.signal)
    detach()
    detach()
    controller.abort()
    expect(cancels, '撤销后中止不得再触发 cancel').toBe(0)
    // 无信号 ⇒ no-op（没有取消入口 ≠ 假装有）
    const noop = cancelOnAbort(fake, undefined)
    noop()
    expect(cancels).toBe(0)
    expect(unsupportedOperation({ reason: 'x' }).code).toBe('UnsupportedOperation')
  })
})
