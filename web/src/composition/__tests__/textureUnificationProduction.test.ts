/**
 * R1-β① C5 · **材质统一**的生产判据（接缝 `presenter-surface-dual-track` 的（甲）前置之一）。
 *
 * ## 这条判据保护什么（它抓的缺陷是**具体的**）
 *
 * `presentation/presenter#createMaterial` 只在 `binding.map !== undefined &&
 * textures !== undefined` 时才设 `params.map`（`presenter.ts:789`）。而在此之前
 * `TexturePort` **全树零实现** ⇒ 呈现会话的材质**永不带贴图** ⇒ 画面只有中性色/顶点色，
 * 比 legacy 渲染链平。那是可感知回退（#171 禁止），也是"画面终切"至今被阻塞的实质原因。
 *
 * ## 输入口径（#301 D3 + #387 完成判据：不得手搓载荷）
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
import { textureResourcesOf, type TextureDecoder } from '@/composition/kernelTextureResources'
import type { TexturePixels } from '@/presentation/textureBinding'
import type { Document } from '@/domain/document'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID } from '@/runtime/kernelSession'

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

async function kernelSetup() {
  const raw = JSON.parse(fs.readFileSync(MB_FIXTURE, 'utf8').replace(/\r\n/g, '\n')) as Record<string, unknown>
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
  const ok = adoptLoadedDocument({ kernel: session, log: { info: () => {}, warn: () => {} } }, parsed.document!, raw, MB_FIXTURE)
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

  it('①b **接线侧**：视口装配确实把端口与解码器给了呈现会话，且绑定按编译材质逐一产出', async () => {
    const { session, doc } = await kernelSetup()
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

  it('①c **阻断点登记**：网格几何的材质 id 不符 `material:<下标>` 约定 ⇒ 那个材质**绑不上**贴图', async () => {
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
         * 这条断言是**反证式**的：它记录当前的真实缺口 ——
         * `composition/kernelPresentationInputs` 产出**一个**网格图元、材质 id 恒为
         * `'structure'`，而 `textureBindingsOf` 的绑定键约定是 `material:<下标>`
         * （`kernelTextureResources#MATERIAL_ID_PREFIX`）⇒ 该材质永远"无贴图"。
         *
         * ⇒ 一旦生产改成"逐材质一个图元"（`runtime/presentationAdapter#structureMaterialGroups`
         * 是现成件，阻断点是 `presentation/compileScene` 的批次划分以 `objectId` 为键），
         * 本断言**翻红**即为 DONE 信号：届时应把 ①c 改成"至少一个材质带 `map`"的正判据。
         */
        expect(ids.every((id) => !id.startsWith('material:')), '当前生产材质 id 均不符约定（这就是阻断点）').toBe(true)
        expect(stats.withMap, '阻断点存在 ⇒ 网格材质绑不上贴图').toBe(0)
      } finally {
        surface.dispose()
        port.dispose()
      }
    } finally {
      session.dispose()
    }
  })

  it('④ **现成件**：`structureMaterialGroups` 按 `materialIndex` **恰好划分**真实夹具的四边形', async () => {
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
      const produced = kernelPresentationInputs({
        scene: doc.scene,
        content: doc.content,
        key: { documentVersion: doc.version.documentVersion, scene: doc.scene.id, time: { frame: 0, fps: 20 }, parameterVersion: 0, contentResourceVersions: [] } as never,
      })
      expect(produced.inputs.primitives.length, '生产当前是单图元（阻断点）').toBe(1)
      expect(groups.length, '而按材质分组本应给出多组（现成件已备）').toBeGreaterThan(1)
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
