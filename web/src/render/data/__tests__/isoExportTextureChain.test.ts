/**
 * **等轴 PNG 导出链的纹理形态 · 生产装配判据**（#387 同族批，任务书第 2 项）。
 *
 * ## 守的是哪条链（逐跳点名）
 *
 * ```
 * operators/builtin/exportOperators.ts:135   ctx.plainForSave().plain
 *   → workbench/exportIsometricImage.ts#bakeIsometricStructurePngDataUrl
 *     → render/data/buildMaterialLibrary.ts:29  const fetchList = listPaletteTextureDataUrls(plainDoc)
 *       → render/data/sceneDocumentMaterialHydrate.ts#listPaletteTextureDataUrls
 * ```
 *
 * 修复前该函数第一件事是 `if (!Array.isArray(blobs)) return []`，而**真入口**喂进来的是
 * **槽位键对象**（帧为主文档的投影产物，实测 62 键）⇒ `fetchList = []`
 * ⇒ `preloaded` 空 ⇒ `SimpleMaterialLibrary` 的 `textureByMaterialId` 空 ⇒
 * `buildBlockMesh` 里 `simpleMaterialLibrary.ts:307`
 * `throw new Error('纹理未预取: ' + materialId)` ⇒ 该异常在
 * `ExportIsoPngOperator.exec` 的 `catch (e)` 里只落 `ctx.log.warn('导出', '等轴 PNG 导出失败: …')`
 * ⇒ **无产物、无 UI 报错**（用户只看到"点了没反应"）。
 *
 * ## 为什么这条判据必须走**生产装配**（而不是手写载荷）
 *
 * 手工载荷 `{'0': 'A'}` 会恒绿：它证明不了"真入口真的会喂对象形态"。
 * 本判据的输入是**真信封夹具**（`e2e/fixtures/structuredata-exported-envelope.json`）
 * 经生产解析器 + `adoptLoadedDocument` + `projectKernelSaveView(session).plain`
 * —— 与 `ExportIsoPngOperator` 拿到的是**同一个函数**的产物
 * （同一装配口径见 `workbench/export/__tests__/materialIndexEndToEnd.test.ts`，
 * 那里的 ⑤ 组已判"投影字节 = 文件槽位字节"；本判据只补**渲染侧相遇点**这一跳）。
 *
 * ## 四组（含能红负对照）
 *
 * | 组 | 断言 |
 * |---|---|
 * | A | 真投影产物确实是**对象形态**，且 `listPaletteTextureDataUrls` 枚举出 N>0 条、逐条字节 = 文件槽位真值 |
 * | B | 同一份 plain 把 `textureBlobs` 换成**等价数组** ⇒ 枚举结果逐条相同（相遇点形态无关） |
 * | C | 负对照：修复前"只认数组"的实现，在同一份真 plain 上 ⇒ **0 条** |
 * | D | 下游后果：非空枚举 ⇒ `getMaterialForBatch` 给材质；空枚举 ⇒ 抛 `纹理未预取`（等轴导出静默失败的失效形态） |
 */
import { beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { plainRootOf } from '@/adapters/plainRoot'
import { ALL_CAPABILITIES } from '@/application/commands'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { projectKernelSaveView } from '@/composition/saveProjection'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  StructureDataParser,
  V2PlainParser,
  WorldParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import { buildMaterialRegistryFromSceneDocument } from '@/render/data/bundleResolve'
import {
  hydrateMaterialBlendsInSceneDocument,
  listPaletteTextureDataUrls,
  type PaletteTextureDataUrlItem,
} from '@/render/data/sceneDocumentMaterialHydrate'
import type { BatchDescriptor } from '@/render/mesh/batchDescriptor'
import { SimpleMaterialLibrary } from '@/render/materials/simpleMaterialLibrary'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'

interface Plain {
  [k: string]: unknown
}

const NOOP_LOG = { info: () => {}, warn: () => {} }

/** `e2e/fixtures/` 下的真信封（`core.autocrlf=true` ⇒ 读入先归一化 CRLF，铁律 6）。 */
function readFixture(fileName: string): Record<string, unknown> {
  const p = path.join(process.cwd(), 'e2e', 'fixtures', fileName)
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')) as Record<string, unknown>
}

let plain: Plain
/** 文件槽位真值：`serialize().textureBlobs`（数组，**内容去重后**，`textureBlobIndex` 索引此表）。 */
let truthBlobs: readonly string[]
/** 文件槽位真值：`serialize().materialPalette`（与 `plain.materialPalette` 同序）。 */
let truthPalette: readonly { textureBlobIndex?: unknown }[]

beforeAll(async () => {
  const raw = readFixture('structuredata-exported-envelope.json')
  const layers = await readEnvelopeLayers(raw as never)
  const plainRoot = plainRootOf(layers.plain as Record<string, unknown>)
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  const parsed = await parsers.detectAndParse(raw)
  if (parsed.document === null) throw new Error('真信封夹具解析失败')
  const doc = parsed.document
  const session = new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: ALL_CAPABILITIES,
  })
  const adopted = adoptLoadedDocument(
    { kernel: session, log: NOOP_LOG },
    doc as never,
    plainRoot,
    'structuredata-exported-envelope.json',
  )
  if (!adopted) throw new Error('adoptLoadedDocument 失败（夹具未进内核会话）')
  const view = projectKernelSaveView(session)
  if (!view.ok) throw new Error(`projectKernelSaveView 失败：${view.reason}`)
  plain = view.plain as Plain
  const serialized = (doc as unknown as { serialize(): Plain }).serialize()
  truthBlobs = serialized.textureBlobs as readonly string[]
  truthPalette = serialized.materialPalette as readonly { textureBlobIndex?: unknown }[]
})

/** 调色板第 i 条的槽位下标（`textureBlobIndex`；缺失/非法 ⇒ null）。 */
function slotOf(paletteIndex: number): number | null {
  const pal = plain.materialPalette as readonly { textureBlobIndex?: unknown }[] | undefined
  const idx = pal?.[paletteIndex]?.textureBlobIndex
  return typeof idx === 'number' && Number.isFinite(idx) ? Math.floor(idx) : null
}

/** 相遇点的**修复前**实现（`sceneDocumentMaterialHydrate.ts` 修复前第一步，逐字）。 */
function legacyArrayOnly(doc: Plain): string[] {
  const blobs = (doc as { textureBlobs?: unknown }).textureBlobs
  if (!Array.isArray(blobs)) return []
  return blobs as string[]
}

function base64OfDataUrl(url: string): string {
  const i = url.indexOf('base64,')
  return i < 0 ? url : url.slice(i + 7)
}

/**
 * 复刻 `buildMaterialLibrary` 在"解码之后"的那一步（不含 DOM 解码，node 里跑不了
 * `THREE.TextureLoader`）：按 `listPaletteTextureDataUrls` 的条目造纹理表 →
 * hydrate → registry → `SimpleMaterialLibrary`。
 */
function libraryFrom(items: readonly PaletteTextureDataUrlItem[]): SimpleMaterialLibrary {
  const preloaded = new Map<string, THREE.Texture>()
  for (const it of items) {
    const tex = new THREE.Texture()
    // `configureTextureForEntry` 会读 `tex.image` 的宽高（node 里没有真图 ⇒ 给 16×16，
    // 与真夹具的 blob 尺寸一致；无 `naturalWidth` 走 `width/height` 分支）。
    tex.image = { width: 16, height: 16 } as unknown as THREE.Texture['image']
    preloaded.set(it.materialId, tex)
  }
  const hydrated = hydrateMaterialBlendsInSceneDocument(plain, preloaded)
  const registry = buildMaterialRegistryFromSceneDocument(hydrated)
  return new SimpleMaterialLibrary(registry, preloaded)
}

function descriptorFor(materialId: string): BatchDescriptor {
  return { materialId, blend: 'opaque', tint: new THREE.Color(0xffffff) }
}

describe('等轴 PNG 导出链 · 形态判据（生产装配输入）', () => {
  it('A 正：真投影产物是**对象形态**，相遇点枚举出 N>0 条且逐条字节 = 文件槽位真值', () => {
    const rawBlobs = plain.textureBlobs
    expect(
      Array.isArray(rawBlobs),
      '前提：帧为主投影把 textureBlobs 写成槽位键对象（这正是修复前被静默丢掉的那一形）',
    ).toBe(false)
    expect(rawBlobs !== null && typeof rawBlobs === 'object').toBe(true)
    const keys = Object.keys(rawBlobs as Record<string, unknown>)
    expect(keys.length, '对象形态的槽位数').toBeGreaterThan(0)
    expect(keys.every((k) => /^\d+$/.test(k)), '键是数值槽位').toBe(true)

    const items = listPaletteTextureDataUrls(plain)
    expect(items.length, '等轴导出链首步（buildMaterialLibrary 的 fetchList）必须非空').toBeGreaterThan(0)

    const obj = rawBlobs as Record<string, string>
    const pal = plain.materialPalette as readonly { textureBlobIndex?: unknown }[]
    for (const item of items) {
      const paletteIndex = Number(item.materialId)
      const slot = slotOf(paletteIndex)
      expect(slot, `调色板 ${item.materialId} 必须有 textureBlobIndex`).not.toBeNull()
      expect(
        item.dataUrl,
        `materialId=${item.materialId} 的字节必须来自**该调色板条目的槽位**`,
      ).toBe(`data:image/png;base64,${obj[String(slot)]}`)
    }

    // ## 两套下标空间（本轮实测登记；此前无判据写明，容易踩）
    //
    // | 表示 | `textureBlobs` | `materialPalette[i].textureBlobIndex` |
    // |---|---|---|
    // | 投影产物 `plainForSave().plain` | 槽位键对象，**62 键**（按调色板槽位**展开**，共享贴图复制多份） | = `i`（**展开池**下标 0..61） |
    // | 文件槽位真值 `serialize()` | 数组，**57 条**（按内容**去重**） | 各自指向**去重池**（0..56，5 条共享） |
    //
    // ⇒ **同一个 `textureBlobIndex` 在两套表示里指向的不是同一格**：拿投影侧的
    // `textureBlobIndex` 直接去索引 `serialize().textureBlobs` 会取到旁边一格
    // （本轮实测：投影的最大槽位下标 61 ≥ 文件池长度 57）。故对账只能**逐条经各自的下标**，
    // 或对**字节集合**对账 —— 位置对账必然假红。
    const projectSlot = (i: number): number => {
      const v = pal[i]?.textureBlobIndex
      return typeof v === 'number' ? Math.floor(v) : -1
    }
    const fileBlobIndex = (i: number): number => {
      const v = truthPalette[i]?.textureBlobIndex
      return typeof v === 'number' ? Math.floor(v) : -1
    }
    expect(obj, '投影侧确实按**展开池**落下标').toHaveProperty(String(pal.length - 1))
    expect(projectSlot(pal.length - 1), '投影槽位下标 = 调色板下标（展开池 0..61）').toBe(
      pal.length - 1,
    )
    expect(
      projectSlot(pal.length - 1),
      '投影的展开池大于文件的去重池（否则两套下标空间其实是一套）',
    ).toBeGreaterThanOrEqual(truthBlobs.length)
    expect(truthBlobs.length, '文件形态按**内容去重**：条数少于槽位数（共享贴图）').toBeLessThan(
      pal.length,
    )
    expect(items.length, '枚举条数 = 有槽位下标的调色板条数').toBe(pal.length)

    // 逐条经**各自的下标**对到文件槽位真值 —— 这是本判据与真值的接头处。
    for (const item of items) {
      const i = Number(item.materialId)
      const fi = fileBlobIndex(i)
      expect(fi, `文件槽位 ${i} 必须有 textureBlobIndex`).toBeGreaterThanOrEqual(0)
      expect(
        base64OfDataUrl(item.dataUrl),
        `paletteIndex=${i}：投影展开池[${projectSlot(i)}] 的字节必须 = 文件去重池[${fi}] 的字节`,
      ).toBe(truthBlobs[fi])
    }

    // 字节**集合**也对一遍：不丢不换（不依赖任何下标空间）。
    const itemBytes = [...new Set(items.map((it) => base64OfDataUrl(it.dataUrl)))].sort()
    expect(itemBytes, '枚举出的字节集合（去重）= 文件池的字节集合（去重）').toEqual(
      [...new Set(truthBlobs)].sort(),
    )
  })

  it('B 正：同一份 plain 换成**等价数组** ⇒ 枚举结果逐条相同（相遇点形态无关）', () => {
    const obj = plain.textureBlobs as Record<string, string>
    const maxIdx = Math.max(...Object.keys(obj).map(Number))
    const asArray: string[] = []
    for (let i = 0; i <= maxIdx; i++) asArray[i] = obj[String(i)] ?? ''
    const asArrayPlain: Plain = { ...plain, textureBlobs: asArray }

    expect(
      listPaletteTextureDataUrls(asArrayPlain),
      '两种契约形态在同一份生产输入上必须给出同一条目表',
    ).toEqual(listPaletteTextureDataUrls(plain))
  })

  it('C 负对照（能红）：修复前"只认数组"的实现 ⇒ 同一份真 plain 枚举 **0** 条', () => {
    expect(legacyArrayOnly(plain).length, '修复前：对象形态在第一步就被丢掉').toBe(0)
    expect(
      listPaletteTextureDataUrls(plain).length,
      '修复后：同一份 plain 必须枚举到（否则本判据无区分力）',
    ).toBeGreaterThan(0)
  })

  it('D 正：枚举到字节 ⇒ 材质库能给出材质（不抛 `纹理未预取`）', async () => {
    const items = listPaletteTextureDataUrls(plain)
    const lib = libraryFrom(items)
    const materialId = items[0]!.materialId
    // 前提：该 materialId 真的在 registry 里（否则纹理不会被登记，判据会假红）
    expect(
      buildMaterialRegistryFromSceneDocument(
        hydrateMaterialBlendsInSceneDocument(plain, new Map()),
      ).materials[materialId],
      `前提：materialId=${materialId} 必须在 registry 里`,
    ).toBeDefined()
    await expect(lib.getMaterialForBatch(descriptorFor(materialId))).resolves.toBeInstanceOf(
      THREE.MeshBasicMaterial,
    )
    lib.dispose()
  })

  it('D 负对照（能红）：修复前的空枚举 ⇒ 同一调用抛 `纹理未预取`（等轴导出静默失败的形态）', async () => {
    const emptyItems = legacyArrayOnly(plain) // 修复前 buildMaterialLibrary 的 fetchList
    expect(emptyItems).toEqual([])
    const lib = libraryFrom([])
    await expect(
      lib.getMaterialForBatch(descriptorFor('0')),
      '这就是 bakeIsometricStructurePngDataUrl → buildBlockMesh 在真入口上的报错'
        + '（被 ExportIsoPngOperator 的 catch 降级成 log.warn，用户看不到）',
    ).rejects.toThrow('纹理未预取')
    lib.dispose()
  })
})
