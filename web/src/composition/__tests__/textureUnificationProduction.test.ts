/**
 * R1-β① C5 · **材质统一**的生产判据（接缝 `presenter-surface-dual-track` 的（甲）前置之一）。
 *
 * ## 这条判据保护什么（它抓的缺陷是**具体的**）
 *
 * `presentation/presenter#createMaterial` 只在 `binding.map !== undefined &&
 * textures !== undefined` 时才设 `params.map`（`presenter.ts:789`）。而在此之前
 * `TexturePort` **全树零实现** ⇒ 呈现会话的材质**永不带贴图** ⇒ 画面只有中性色/顶点色，
 * 比 legacy 渲染链平。那是可感知回退（禁止的能力回退），也是"画面终切"至今被阻塞的实质原因。
 *
 * ## 输入口径（完成判据：不得手搓载荷）
 *
 * 全程走**生产**链：
 * ```
 * 真实信封夹具 → 生产 parser registry.detectAndParse
 *              → 生产 adoptLoadedDocument（装配内核文档）
 *              → kernel doc.content.resources（真资源）
 *              → textureResourcesOf（五态）+ viewportTexturePort.sync + bindTextures
 * ```
 * 唯一的替身是**解码器**（`TextureDecoder` 是端口，DOM 解码在 vitest 里不可用）——
 * 该替身给的是**真实像素**（读夹具字节长度派生，见下），且它在生产里由
 * `adapters/textureDecode#createDomTextureDecoder` 占据同一位置。
 *
 * ## 判据结构：正判据 + 三条负对照（缺一不成立）
 *
 * | # | 断言 | 抓什么 |
 * |---|---|---|
 * | ① | 真实夹具 ⇒ 至少一个材质的 `map` **被设上**，且 `missingRequiredTextures === 0` | 正判据：贴图真的贴到了材质上 |
 * | ② | 同一身份第二次 `sync` ⇒ `uploaded === 0` | 复用（否则每帧重传一张纹理 = 泄漏 + 卡顿） |
 * | ③ | 资源表里身份消失 ⇒ `released > 0` 且 `size === 0` | 缓存清理（A19 资源释放） |
 * | ④ | `dispose()` 后 `textureFor` ⇒ `null`，`sync` 不再上传 | 释放后**不复活**（最难查的一类泄漏） |
 * | ⑤ | `bindTextures` 后**不**经过端口（等价于"没接材质统一"）⇒ `map` 缺席 | **负对照**：证明 ① 不是恒真 |
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import fs from 'node:fs'
import path from 'node:path'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { KernelSession } from '@/runtime/kernelSession'
import { createViewportTexturePort, type ViewportTexturePort } from '@/composition/viewportTexturePort'
import { PresenterSession } from '@/composition/presenterSession'
import { BatchedPresenter } from '@/presentation/presenter'
import { textureBindingsOf, textureResourcesOf, type TextureDecoder } from '@/composition/kernelTextureResources'
import type { TexturePixels } from '@/presentation/textureBinding'
import type { Document } from '@/domain/document'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID } from '@/runtime/kernelSession'
import { realFixtureText, withRealFixture } from '../../../e2e/real-fixture-vitest'

const MB_FIXTURE = path.join(process.cwd(), 'src', 'context', '__tests__', 'fixtures', 'multiblock-tier-only.json')

/** 真实夹具字节派生的**确定性**像素（尺寸随载荷长度变，不是"随手造一张"）。 */
function pixelDecoder(): TextureDecoder {
  return {
    async decode(payload: string): Promise<TexturePixels | null> {
      if (payload === '') return null
      const side = 1 + (payload.length % 4)
      const rgba = new Uint8Array(side * side * 4)
      for (let i = 0; i < rgba.length; i += 1) rgba[i] = (payload.charCodeAt(i % payload.length) + i) % 256
      return Object.freeze({ width: side, height: side, rgba })
    },
  }
}

/**
 * 走**生产** `PresenterSession`：apply 内核文档 → 资源 → （可选）端口上传 → 绑定。
 *
 * 观测面取自**真实挂载的材质**（遍历 `object3d` 读 `MeshBasicMaterial.map`）——
 * 而不是另取一个"看起来对"的中间值：要证明的是"贴图真的到了材质上"。
 */
function observeMaterials(doc: Document, port: ViewportTexturePort | null) {
  const session = new PresenterSession(
    port === null ? { scope: 'test:no-port' } : { scope: 'test:port', textures: port },
  )
  try {
    const applied = session.applyKernelDocument(doc, { frame: 0, fps: 20 })
    return { session, applied }
  } catch (e) {
    session.dispose()
    throw e
  }
}

/** 遍历挂载树，数"带 `map` 的材质"与材质总数。 */
function mapStats(root: THREE.Object3D): { readonly total: number; readonly withMap: number } {
  let total = 0
  let withMap = 0
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    const mat = Array.isArray(mesh.material) ? undefined : (mesh.material as THREE.MeshBasicMaterial | undefined)
    if (mat === undefined || mat === null) return
    total += 1
    if (mat.map !== null && mat.map !== undefined) withMap += 1
  })
  return { total, withMap }
}

/**
 * 真实信封夹具：**材质组数 39 > `maxBatches`(32)** ⇒ 必然触发合并批次（逐成员身份那条路）。
 *
 * 该件是**仓外** StructureData 真实夹具（`realFixtureText` 惰性解析；此常量只作口径标记）。
 */
const ENVELOPE_FIXTURE = 'structuredata-exported-envelope.json'

async function kernelSetup(fixture: string = MB_FIXTURE) {
  const raw =
    fixture === ENVELOPE_FIXTURE
      ? (JSON.parse(realFixtureText('structureDataExportedEnvelope')) as Record<string, unknown>)
      : (JSON.parse(fs.readFileSync(fixture, 'utf8').replace(/\r\n/g, '\n')) as Record<string, unknown>)
  const registry = createParserRegistry()
  registry.register(V2PlainParser)
  registry.register(createEnvelopeParser(registry))
  registry.register(WorldParser)
  registry.register(StructureDataParser)
  const parsed = await registry.detectAndParse(raw)
  expect(parsed.document, '生产解析必须成功').not.toBeNull()
  const session = new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: [],
  })
  const ok = adoptLoadedDocument({ kernel: session, log: { info: () => {}, warn: () => {} } }, parsed.document!, raw, fixture)
  expect(ok, '生产装配必须成功（GF-16 = true）').toBe(true)
  const doc = session.document()!
  return { session, doc }
}

describe('R1-β① C5 · 材质统一：`TexturePort` 生产实现把贴图接到 `PresenterSession`', () => {
  it('① 正判据（端口侧）：真实夹具的**全部**就绪资源都可按内容身份取到 GPU 纹理', async () => {
    const { session, doc } = await kernelSetup()
    try {
      expect(doc.content.resources.length, '真实夹具必须带内嵌纹理资源').toBeGreaterThan(0)
      const resources = await textureResourcesOf(doc.content.resources, pixelDecoder())
      const ready = resources.filter((r) => r.state === 'ready')
      expect(ready.length, '至少一条资源必须解码就绪').toBeGreaterThan(0)

      const port = createViewportTexturePort('test:viewport')
      try {
        const synced = port.sync(resources)
        expect(synced.uploaded).toBe(ready.length)
        expect(synced.readyWithoutPixels, '不得出现"就绪但无像素"（那是实现缺陷）').toBe(0)
        for (const r of ready) {
          expect(port.textureFor(r.identity), `身份 ${r.identity.id} 必须可取到纹理`).not.toBeNull()
        }
      } finally {
        port.dispose()
      }
    } finally {
      session.dispose()
    }
  })

  it('①b **接线侧**：视口装配确实把端口与解码器给了呈现会话，且绑定按编译材质逐一产出', async () => {    const { session, doc } = await kernelSetup()
    try {
      const resources = await textureResourcesOf(doc.content.resources, pixelDecoder())
      const port = createViewportTexturePort('test:wiring')
      const observed = observeMaterials(doc, port)
      const surface = observed.session
      try {
        port.sync(resources)
        const bound = surface.bindTextures(resources)
        // 绑定的键必须**就是**编译产物的材质 id（否则绑定挂不到批次上）。
        const compiledMaterialIds = new Set(surface.materialDescriptors().map((m) => m.id))
        expect(bound.bindings, '必须为每个编译材质产出一条绑定').toBe(compiledMaterialIds.size)
        expect(compiledMaterialIds.size, '编译产物必须真的有材质').toBeGreaterThan(0)
        // 前置于生产装配：资源全就绪 ⇒ 不得记"必需贴图缺失"。
        expect(bound.missingRequired).toBe(0)
      } finally {
        surface.dispose()
        port.dispose()
      }
    } finally {
      session.dispose()
    }
  })

  it('①c **正判据（C6 翻转）**：网格几何按 `material:<下标>` 分组 ⇒ 挂载的材质**真的**带上了 `map`', async () => {
    const { session, doc } = await kernelSetup()
    try {
      const resources = await textureResourcesOf(doc.content.resources, pixelDecoder())
      const port = createViewportTexturePort('test:convention')
      const observed = observeMaterials(doc, port)
      const surface = observed.session
      try {
        port.sync(resources)
        surface.bindTextures(resources)
        const stats = mapStats(surface.object3d)
        const ids = surface.materialDescriptors().map((m) => m.id)
        /**
         * C5 时本处是**反证式**的阻断点登记（材质 id 恒 `'structure'` ⇒ 永远无贴图）。
         * C6 接通后按当时的预告翻成正判据：**至少一个**编译材质符约定。
         */
        expect(ids.length, '编译产物必须有材质').toBeGreaterThan(0)
        expect(
          ids.some((id) => id.startsWith('material:')),
          `C6 起网格材质必须按 material:<下标> 分组，实得 ${JSON.stringify(ids)}`,
        ).toBe(true)
        /**
         * **观测面是挂载后的真实材质**（`surface.object3d` 遍历 `MeshBasicMaterial.map`），
         * 不是"端口被调用/字段被赋值"。画面级取证见 `web/e2e`（真浏览器截图，见附件）。
         */
        expect(stats.total, '必须有材质挂在树上').toBeGreaterThan(0)
        expect(
          stats.withMap,
          '`material:<下标>` 命中绑定 ⇒ 至少一个挂载材质必须带 `map`（否则贴图仍断路）',
        ).toBeGreaterThan(0)
      } finally {
        surface.dispose()
        port.dispose()
      }
    } finally {
      session.dispose()
    }
  })

  /**
   * **负对照**：只把材质 id 退回 C5 的 `'structure'` 形态（其余全不变）⇒ 挂载材质必须**无** `map`。
   *
   * 为什么不加一个"材质 id 注入"参数到生产里：那是为判据开的旁路（白名单的另一种形式）。
   * 本控制改成在**编译产物的纯数据**上做一次单变量改写，然后走**同一个** `BatchedPresenter`
   * 与**同一个** `textureBindingsOf` —— 被改的只有"绑定键符不符约定"这一个变量。
   */
  it('①d **负对照**：材质 id 退回 `structure` ⇒ 挂载材质**无** `map`（证明 ①c 有区分力）', async () => {
    const { session, doc } = await kernelSetup()
    try {
      const resources = await textureResourcesOf(doc.content.resources, pixelDecoder())
      const port = createViewportTexturePort('test:revert-id')
      const presenter = new BatchedPresenter({ scope: 'test:revert-id', textures: port })
      try {
        const { kernelPresentationInputs } = await import('@/composition/kernelPresentationInputs')
        const { compileScene } = await import('@/presentation/compileScene')
        const produced = kernelPresentationInputs({ layerWorldY: null,
          scene: doc.scene,
          content: doc.content,
          key: {
            documentVersion: doc.version.documentVersion,
            scene: doc.scene.id,
            time: { frame: 0, fps: 20 },
            parameterVersion: 0,
            contentResourceVersions: [],
          } as never,
        })
        const compiled = compileScene(produced.inputs)
        expect(compiled.ok, '生产输入必须可编译').toBe(true)
        if (!compiled.ok) throw new Error('narrow')
        // **单变量改写**：只把材质 id 换回旧形态。
        const reverted = {
          ...compiled.value,
          payloads: compiled.value.payloads.map((p) => ({
            ...p,
            material: { ...p.material, id: 'structure' },
          })),
        }
        presenter.apply(reverted)
        port.sync(resources)
        const bindings = textureBindingsOf({
          materials: reverted.payloads.map((p) => p.material) as never,
          resources,
        })
        presenter.setTextureBindings(new Map(bindings.map((b) => [b.materialId, b])))
        const stats = mapStats(presenter.object3d)
        expect(stats.total, '材质仍应挂着（只是没贴图）').toBeGreaterThan(0)
        expect(
          stats.withMap,
          '退回旧材质 id 形态 ⇒ 绑定键 `material:<下标>` 命不中 ⇒ 必须一张贴图都没有',
        ).toBe(0)
      } finally {
        presenter.dispose()
        port.dispose()
      }
    } finally {
      session.dispose()
    }
  })

  /**
   * **合并批次**（材质组数 > `maxBatches`）：批次级材质只是代表值 ⇒ 呈现必须**逐成员**
   * 取材质，否则"B 的方块贴 A 的图"（静默贴错纹理）。这条用真实信封夹具（39 个材质组）
   * 把那条路真的走一遍 —— 否则"逐成员"这段代码在判据里从未被执行。
   */
  withRealFixture(
    'structureDataExportedEnvelope',
    '①e **合并批次**：真实信封（39 材质组 > 32 预算）⇒ 挂载材质数 = 编译材质数，且全部带 `map`',
    async () => {
    const { session, doc } = await kernelSetup(ENVELOPE_FIXTURE)
    try {
      const resources = await textureResourcesOf(doc.content.resources, pixelDecoder())
      const port = createViewportTexturePort('test:merged')
      const observed = observeMaterials(doc, port)
      const surface = observed.session
      try {
        port.sync(resources)
        surface.bindTextures(resources)
        const ids = surface.materialDescriptors().map((m) => m.id)
        expect(ids.length, '信封夹具必须有 >32 个材质组（否则本判据覆盖不到合并批次）').toBeGreaterThan(32)
        const stats = mapStats(surface.object3d)
        expect(
          stats.total,
          '逐成员材质 ⇒ 挂载的材质数必须与编译材质数一致（用代表值会少一批）',
        ).toBe(ids.length)
        expect(stats.withMap, '全部编译材质都必须带上 `map`').toBeGreaterThan(0)
        expect(stats.withMap, '全部编译材质都必须带上 `map`').toBe(stats.total)
      } finally {
        surface.dispose()
        port.dispose()
      }
    } finally {
      session.dispose()
    }
    },
  )

  it('④ **接通（C6 翻转）**：`structureMaterialGroups` 按 `materialIndex` **恰好划分**真实夹具的四边形，且生产**逐组**消费它', async () => {
    const { session, doc } = await kernelSetup()
    try {
      // 与生产 `kernelPresentationInputs` 同一份装配产物（不手搓定义）。
      const { kernelPresentationInputs } = await import('@/composition/kernelPresentationInputs')
      const { structureMaterialGroups } = await import('@/runtime/presentationAdapter')
      const { projectGridCells } = await import('@/composition/kernelProjection')
      const { collectStructureGeometryPiecesPure } = await import('@/render/mesh/structureGeometryCore')

      const payload = Object.values(doc.scene.data)
        .map((d) => d.payload)
        .find((x) => x.kind === 'blockGrid')
      expect(payload, '夹具必须带 blockGrid 载荷').toBeDefined()
      const projected = projectGridCells({
        cells: (payload as never as { cells: never }).cells,
        geometry: (payload as never as { geometry: never }).geometry,
        cellGeometry: (payload as never as { cellGeometry: never }).cellGeometry,
        cellPalette: (payload as never as { cellPalette: never }).cellPalette,
        palette: (payload as never as { palette: never }).palette,
        cellContent: (payload as never as { cellContent: never }).cellContent,
      })
      const definition = {
        geometryPhase: 'baked',
        cellGrid: projected.cellGrid,
        blockPalette: projected.blockPalette,
        materialPalette: doc.content.resources.map((r) => ({ kind: r.kind })),
      } as never
      const all = collectStructureGeometryPiecesPure(definition).pieces
      const groups = structureMaterialGroups({ definition, layerPreview: 'all' })

      const covered = groups.reduce(
        (n, g) => n + all.filter((x) => x.materialIndex === g.materialIndex).length,
        0,
      )
      expect(covered, '各组必须恰好覆盖全部四边形（无重复、无遗漏）').toBe(all.length)
      expect(new Set(groups.map((g) => g.materialId)).size, '材质 id 必须逐组唯一').toBe(groups.length)
      expect(new Set(groups.map((g) => g.geometryId)).size, '几何 id 必须逐组唯一（同 id 会互相覆盖）').toBe(groups.length)
      for (const g of groups) {
        expect(g.materialId, '约定：`material:<下标>`').toBe(`material:${g.materialIndex}`)
        expect(g.attributes.triangleCount, '每组的三角形数必须与点位自洽').toBe(g.attributes.positions.length / 9)
        expect(g.attributes.cellMap!.length, '每组的格表长度必须等于三角形数').toBe(g.attributes.triangleCount)
      }
      // 与生产当前形态的**差异**是可判定的：生产只给一个图元、材质 id 不是该约定。
      const produced = kernelPresentationInputs({ layerWorldY: null,
        scene: doc.scene,
        content: doc.content,
        key: { documentVersion: doc.version.documentVersion, scene: doc.scene.id, time: { frame: 0, fps: 20 }, parameterVersion: 0, contentResourceVersions: [] } as never,
      })
      expect(groups.length, '按材质分组必须给出至少一组').toBeGreaterThan(0)
      expect(groups.length, '夹具必须真的多材质（否则本判据只覆盖单组路径）').toBeGreaterThan(1)
      // C5 时这里记的是"生产当前是单图元（阻断点）"；C6 起生产**逐组**消费现成件。
      expect(produced.inputs.primitives.length, '生产必须逐材质组产出一个图元').toBe(groups.length)
      expect(
        produced.inputs.primitives.map((p) => p.material.id),
        '生产材质 id 必须逐组等于现成件的 id',
      ).toEqual(groups.map((g) => g.materialId))
      // **对象身份不被材质分组拆散**：同一对象的所有组共享 objectId。
      expect(new Set(produced.inputs.primitives.map((p) => p.objectId)).size, '分组不得改变对象身份').toBe(1)
      // 几何身份逐组不同（同 id 会让属性袋互相覆盖）
      expect(new Set(produced.inputs.primitives.map((p) => p.geometry.id)).size).toBe(groups.length)
    } finally {
      session.dispose()
    }
  })

  it('⑤ **负对照**：不接端口（等价于"没做材质统一"）⇒ `map` 缺席', async () => {
    const { session, doc } = await kernelSetup()
    try {
      const resources = await textureResourcesOf(doc.content.resources, pixelDecoder())
      const observed = observeMaterials(doc, null)
      const surface = observed.session
      try {
        void surface.bindTextures(resources)
        const stats = mapStats(surface.object3d)
        expect(stats.total, '材质仍应挂着（只是没贴图）').toBeGreaterThan(0)
        expect(
          stats.withMap,
          '没有 `TexturePort` ⇒ `createMaterial` 的短路命中 ⇒ 材质不得带 `map`（这正是 C5 之前的生产形态）',
        ).toBe(0)
      } finally {
        surface.dispose()
      }
    } finally {
      session.dispose()
    }
  })
})
  it('② 复用：同一身份第二次 `sync` ⇒ `uploaded === 0`（不是每帧重传）', async () => {
    const { session, doc } = await kernelSetup()
    try {
      const resources = await textureResourcesOf(doc.content.resources, pixelDecoder())
      const port = createViewportTexturePort('test:reuse')
      try {
        const first = port.sync(resources)
        const second = port.sync(resources)
        expect(first.uploaded).toBeGreaterThan(0)
        expect(second.uploaded, '同身份必须复用，不重传').toBe(0)
        expect(second.released).toBe(0)
        expect(second.ready).toBe(first.ready)
      } finally {
        port.dispose()
      }
    } finally {
      session.dispose()
    }
  })

  it('③ 清理：资源表里身份消失 ⇒ 释放（`released > 0`、`size === 0`）', async () => {
    const { session, doc } = await kernelSetup()
    try {
      const resources = await textureResourcesOf(doc.content.resources, pixelDecoder())
      const port = createViewportTexturePort('test:prune')
      try {
        port.sync(resources)
        expect(port.size).toBeGreaterThan(0)
        const after = port.sync([])
        expect(after.released, '身份不在表里 ⇒ 必须释放').toBeGreaterThan(0)
        expect(port.size, '释放后不得残留').toBe(0)
      } finally {
        port.dispose()
      }
    } finally {
      session.dispose()
    }
  })

  it('④ 释放后**不复活**：`dispose()` ⇒ `textureFor` 答 `null`、`sync` 不再上传', async () => {
    const { session, doc } = await kernelSetup()
    try {
      const resources = await textureResourcesOf(doc.content.resources, pixelDecoder())
      const port = createViewportTexturePort('test:dispose')
      const first = port.sync(resources)
      expect(first.uploaded).toBeGreaterThan(0)
      const identity = resources.find((r) => r.state === 'ready')!.identity
      expect(port.textureFor(identity)).not.toBeNull()

      port.dispose()
      expect(port.textureFor(identity), '释放后不得再交出纹理').toBeNull()
      expect(port.size).toBe(0)
      const after = port.sync(resources)
      expect(after.uploaded, '释放后不得复活').toBe(0)
      expect(port.size).toBe(0)
    } finally {
      session.dispose()
    }
  })

  it('⑤-old 已并入上方 ⑤（重复块删除）', () => {})
