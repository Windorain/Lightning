/**
 * **P0 判据：冻结的材质条目不得被"原地写 blend"**（#387 真入口失效的单元级守门）。
 *
 * ## 真入口的失效形态（本判据守的就是它）
 *
 * `e2e/c8-picture-takeover.spec.ts` 实测：
 * `[drw] buildMaterialLibrary failed TypeError: Cannot add property blend, object is not extensible`
 * → `loadStructureAndResources: failed to build textureCache` → 视口挂不出来（60s 超时）。
 *
 * 机制：内核材质面（`composition/kernelPresentationInputs#materialPaletteOf`，
 * 自 D3c `1529fd81` 起**刻意冻结**内核产物）在 `blend === null` 时**不写** `blend`；
 * 而旧 `hydrateMaterialBlendsInSceneDocument` **原地写** `entry.blend` ⇒ 抛。
 * 该暴露面由 G4 接线（`c66975a4`，DRW 首选输入改为内核面）引入，冻结本身是既有的。
 *
 * ## 五组（含可判红的负对照）
 *
 * | 组 | 断言 |
 * |---|---|
 * | ① | 生产装配出的**冻结**材质输入（真夹具）走 hydrate + registry **不抛**、产出条目 `blend` 有值 |
 * | ② | 同一份载荷上「原地写」**必然抛** `TypeError`（证明载荷真的冻结、旧形态确是失效源） |
 * | ③ | 输入**永不被改写**（无 `blend` 残留写入）+ 无需补全时返回**同一对象**（不制造无意义浅拷） |
 * | ①′ | （#387 同族批改写）**形态**是唯一变量的负对照：同一条目配两种 `textureBlobs` 契约形态 ⇒ 枚举结果逐条相同；修复前"只认数组"实现给出不同结果 |
 * | ④ | （#387 同族批新增）夹具 blob 元素形态 `{id,mime,dataBase64}` 的**内核侧后果**登记：`payload` 为 null + 诊断，换成裸 base64 ⇒ 有字节（这是 ①′ 那条"恒 0"旧断言的真因） |
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { plainRootOf } from '@/adapters/plainRoot'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { kernelRenderSourceFaceOf } from '@/composition/kernelPresentationInputs'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import {
  hydrateMaterialBlendsInSceneDocument,
  listPaletteTextureDataUrls,
} from '@/render/data/sceneDocumentMaterialHydrate'
import { buildMaterialRegistryFromSceneDocument } from '@/render/data/bundleResolve'
import type * as THREE from 'three'

function productionRegistry() {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

interface Entry {
  readonly blend?: string
  readonly textureBlobIndex?: number
}

function entriesOf(doc: unknown): readonly Entry[] {
  if (doc === null || typeof doc !== 'object') return []
  const pal = (doc as { materialPalette?: unknown }).materialPalette
  return Array.isArray(pal) ? (pal as readonly Entry[]) : []
}

const SINGLEBOX = 'parts-singlebox-mix.v2.json'

/**
 * 生产装配本夹具（可注入改写），返回内核侧的**内容资源 + 诊断**（组 ④ 用）。
 *
 * `mutate` 只为**负对照**存在：把 blob 元素换成裸 base64 串，其余一字不改。
 */
async function assembleSinglebox(mutate?: (raw: Record<string, unknown>) => void): Promise<{
  readonly resources: readonly { readonly payload: string | null }[]
  readonly diagnostics: readonly { readonly code: string }[]
  readonly scene: Parameters<typeof kernelRenderSourceFaceOf>[0]['scene']
  readonly content: Parameters<typeof kernelRenderSourceFaceOf>[0]['content']
  readonly frameObjects: readonly string[]
}> {
  const p = path.join(process.cwd(), 'e2e', 'fixtures', SINGLEBOX)
  const raw = JSON.parse(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')) as Record<string, unknown>
  mutate?.(raw)
  const parsed = await productionRegistry().detectAndParse(raw)
  expect(parsed.document, '前提：夹具必须能被生产解析器读入').not.toBeNull()
  const assembled = assembleKernelDocument({
    doc: parsed.document as never,
    plainRoot: plainRootOf(raw),
  })
  if (!assembled.ok) throw new Error(`前提失败：夹具必须能被生产装配（${SINGLEBOX}）`)
  return {
    resources: assembled.value.content.resources,
    diagnostics: assembled.value.diagnostics,
    scene: assembled.value.scene,
    content: assembled.value.content,
    frameObjects: assembled.value.frameObjects,
  }
}

/** 生产链：真夹具（c8 用的那份：材质调色板无 `blend`）→ 解析 → 装配 → 内核材质面。 */
async function frozenMaterialInputFromFixture(): Promise<{
  materialInput: Record<string, unknown>
  entries: readonly Entry[]
  frozen: boolean
}> {
  const fileNameForError = 'parts-singlebox-mix.v2.json'
  const p = path.join(process.cwd(), 'e2e', 'fixtures', fileNameForError)
  const raw = JSON.parse(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')) as Record<string, unknown>
  const parsed = await productionRegistry().detectAndParse(raw)
  expect(parsed.document, '前提：夹具必须能被生产解析器读入').not.toBeNull()
  const assembled = assembleKernelDocument({ doc: parsed.document as never, plainRoot: plainRootOf(raw) })
  if (!assembled.ok) throw new Error(`前提失败：夹具必须能被生产装配（${fileNameForError}）`)
  const face = kernelRenderSourceFaceOf({
    scene: assembled.value.scene,
    content: assembled.value.content,
    frameObjects: assembled.value.frameObjects,
  })
  const materialInput = face.materialInput as unknown as Record<string, unknown>
  return {
    materialInput,
    entries: entriesOf(materialInput),
    frozen: Object.isFrozen(materialInput.materialPalette as object),
  }
}

describe('P0 · 冻结的材质条目：补全 blend 必须产出新条目（不得原地写）', () => {
  it('① 生产装配的冻结材质输入 ⇒ hydrate + registry 不抛、blend 有值', async () => {
    const { materialInput, entries, frozen } = await frozenMaterialInputFromFixture()
    expect(entries.length, '前提：夹具确有材质调色板条目').toBeGreaterThan(0)
    expect(frozen, '前提：内核材质面是冻结的（D3c 起的防线）').toBe(true)
    expect(
      Array.isArray(materialInput.textureBlobs),
      '前提：内核材质面按**数组**形态产 textureBlobs（`composition/kernelPresentationInputs.ts#textureBlobsOfContent`）',
    ).toBe(true)
    expect(
      materialInput.textureBlobs,
      '前提（实测）：本夹具的 blob 元素是 `{id,mime,dataBase64}` 对象 ⇒ 内核取不到裸字节 ⇒ 池为**空**数组'
        + '（成因与后果是组 ④ 的判据；它也是旧版"对象形态 ⇒ 枚举 0 条"那条断言恒真的真因）',
    ).toEqual([])
    expect(
      entries.some((e) => e.blend === undefined),
      '前提：至少一条**缺** blend（否则本判据是空转）',
    ).toBe(true)

    // 走 `buildMaterialLibrary` 里 hydrate 之后的那一步（不含 DOM 纹理解码）。
    const preloaded = new Map<string, THREE.Texture>()
    const hydrated = hydrateMaterialBlendsInSceneDocument(materialInput, preloaded)
    expect(() => buildMaterialRegistryFromSceneDocument(hydrated), '建 registry 必须不抛').not.toThrow()
    const hydratedEntries = entriesOf(hydrated)
    expect(hydratedEntries.length).toBe(entries.length)
    for (const e of hydratedEntries) {
      expect(e.blend, '每条补全后的条目都必须有 blend').toBeDefined()
    }

    // ── ①′ 形态负对照（2026-10-15 #387 同族批改写；原断言与改写理由逐字留痕）──────────
    //
    // 【原断言】`const asObject = { ...materialInput, textureBlobs: { '0': 'AAAA' } }`
    //          `expect(listPaletteTextureDataUrls(asObject).length, '对象形态 ⇒ 枚举 0 条').toBe(0)`
    //
    // 【它当时**确实**恒 0，但成因不是形态】本夹具（`parts-singlebox-mix.v2.json`）的 blob
    // 元素是 `{id,mime,dataBase64}` 对象，内核取不到裸 base64
    // （`composition/kernelAssembly.ts#resourcesFromLegacy:1407`
    // `const payload = typeof blob === 'string' ? blob : null`）⇒
    // `content.resources[0].payload === null` ⇒ `materialPaletteOf` 产 `[{ kind: 'static16' }]`
    // （**没有 `textureBlobIndex`**）⇒ `listPaletteTextureDataUrls` 无论什么形态都在
    // `if (typeof idx !== 'number') continue` 处跳过。实测（同一个 materialInput）：
    // 数组形态 **0** 条、对象形态 **0** 条 —— 该断言对"形态"**没有区分力**（恒真），
    // 等于把"该夹具的 blob 元素形态不被内核理解"这一缺陷固化成了"数组是必需的"。
    // 组 ④ 就是这条成因的机械判据。
    //
    // 【为什么改】① 修复后（相遇点已收敛到 `render/data/textureBlobPool.ts` 唯一归一化点）
    // "对象形态 ⇒ 0 条"是**错的期望**；② 形态判据必须让**形态**成为唯一变量。
    //
    // 【改后断言什么】调色板换成**显式带 `textureBlobIndex`** 的同一条目，只在两种契约形态
    // 之间切换 ⇒ 两种形态枚举结果**逐条相同**、且都**不是** 0 条；并保留能红的负对照
    // （修复前"只认数组"的相遇点给出不同结果）。
    const slotPalette = Object.freeze([
      Object.freeze({ kind: 'static16' as const, textureBlobIndex: 0 }),
    ])
    const asArray = { ...materialInput, materialPalette: slotPalette, textureBlobs: ['AAAA'] }
    const asObject = { ...materialInput, materialPalette: slotPalette, textureBlobs: { '0': 'AAAA' } }

    expect(listPaletteTextureDataUrls(asArray), '前提：数组形态枚举 1 条').toHaveLength(1)
    expect(
      listPaletteTextureDataUrls(asObject),
      '对象形态必须枚举出**同一条**（修复前这里是 0 条）',
    ).toEqual(listPaletteTextureDataUrls(asArray))

    /** 相遇点的**修复前**实现（`sceneDocumentMaterialHydrate.ts` 修复前第一步，逐字）。 */
    const legacyArrayOnly = (doc: { textureBlobs?: unknown }): string[] =>
      Array.isArray(doc.textureBlobs) ? (doc.textureBlobs as string[]) : []
    expect(legacyArrayOnly(asObject), '修复前：对象形态整表取不到').toEqual([])
    expect(
      legacyArrayOnly(asArray),
      '同一负对照在数组形态上有读数 ⇒ 它只对**形态**敏感（不是恒空）',
    ).toEqual(['AAAA'])
  })

  it('② 负对照：同一份冻结载荷上「原地写 blend」必然抛 TypeError（旧形态的失效源）', async () => {
    const { entries } = await frozenMaterialInputFromFixture()
    const first = entries[0]!
    expect(first.blend, '前提：首条缺 blend').toBeUndefined()
    expect(
      () => {
        ;(first as { blend?: string }).blend = 'opaque'
      },
      '冻结条目上原地写必须抛 —— 这就是 c8 真入口的失效形态',
    ).toThrow(TypeError)
  })

  it('③ 输入永不被改写；无需补全时返回同一对象', async () => {
    const { materialInput, entries } = await frozenMaterialInputFromFixture()
    const preloaded = new Map<string, THREE.Texture>()
    const before = entries.map((e) => e.blend)
    hydrateMaterialBlendsInSceneDocument(materialInput, preloaded)
    expect(
      entries.map((e) => e.blend),
      'hydrate 不得改写输入（缺 blend 的仍缺）',
    ).toEqual(before)

    // 已全部有 blend ⇒ 返回输入本身（同一性，不制造无意义浅拷）。
    const already = Object.freeze({
      geometryPhase: 'baked' as const,
      materialPalette: Object.freeze([Object.freeze({ textureBlobIndex: 0, blend: 'opaque' })]),
      textureBlobs: Object.freeze({ '0': 'AAAA' }),
    })
    expect(hydrateMaterialBlendsInSceneDocument(already, preloaded)).toBe(already)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 组 ④：夹具 blob 元素形态 `{id,mime,dataBase64}` 的**内核侧**后果（#387 同族批登记）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## 为什么这条判据必须存在
 *
 * `{id,mime,dataBase64}` **不是**本仓任何生产者的输出（来源核查见
 * `render/data/__tests__/textureBlobPool.shapeContract.test.ts` 判据 ⑤：
 * Java `TextureBlobEmbedder` 产裸 base64 串、proto 声明 `bytes texture_png`、
 * 文档契约写 `"textureBlobs": [ … ]`；该元素形态最早出自手写夹具 `minimal-v2.json`，
 * commit `2566f59f`，后由 `b4be5627` 复制到两份 parts 夹具）。
 *
 * 它出现在**多份判据的输入**里（本文件、`isoExportTextureChain`、
 * `composition/__tests__/cellContentCarriage`、多份 `context/__tests__`、
 * `adapters/files/__tests__/*`…），所以它的语义**不能悬空**：要么被正常消费，
 * 要么被显式登记为"内核视作外链（无内嵌字节）"。本判据把它钉成机械读数。
 *
 * ## 登记 + 能红的负对照
 *
 * 同一个装配路径，只把 blob 元素换成裸 base64 串 ⇒ `payload` 从 `null` 变 string、
 * 诊断 `resourceWithoutPayloadOrLocator` 消失、材质面从"无 `textureBlobIndex` + 空池"
 * 变成"有下标 + 非空池"。⇒ ① 后果**确实**由该形态造成（有区分力）；
 * ② 谁要改夹具形态，本判据当场给出该改哪些读数。
 *
 * ## 退出条件
 *
 * 若决定把该夹具（或 e2e 归一化口径）统一成契约形态（裸 base64 串数组），
 * 本组的"登记"断言（`payload === null` / 无 `textureBlobIndex`）**必须一并翻转**为
 * 契约形态的期望；`e2e/helpers/parts/fixtures.ts:40-56` 的
 * `normalizeTextureBlobsForRender` 亦可随之退役（本批 `e2e/**` 只读，未动）。
 */
describe('组 ④：夹具 blob 元素 `{id,mime,dataBase64}` ⇒ 内核视作"无内嵌字节"（登记）', () => {
  /** 负对照改写：blob 元素 → 裸 base64 串（其余一字不改）。 */
  function toBareBase64(raw: Record<string, unknown>): void {
    const blobs = raw.textureBlobs as readonly { dataBase64?: string }[]
    raw.textureBlobs = blobs.map((b) => b.dataBase64 ?? '')
  }

  it('登记：同形态 ⇒ `payload === null` + 诊断；换裸 base64 ⇒ `payload` 是 string、诊断消失', async () => {
    const asIs = await assembleSinglebox()
    const flipped = await assembleSinglebox(toBareBase64)

    expect(asIs.resources.length, '前提：夹具确有材质资源').toBeGreaterThan(0)
    expect(asIs.resources.length, '两种形态的资源条数必须相同（只换字节写法）').toBe(
      flipped.resources.length,
    )
    expect(
      asIs.resources[0]!.payload,
      '登记：非裸串的 blob 元素 ⇒ 无内嵌字节（`resourcesFromLegacy:1407` 只接受 string）',
    ).toBeNull()
    expect(
      typeof flipped.resources[0]!.payload,
      '能红负对照：同一装配路径喂裸 base64 ⇒ 有字节（证明后果由**形态**造成）',
    ).toBe('string')
    expect(asIs.diagnostics.map((d) => d.code)).toContain('resourceWithoutPayloadOrLocator')
    expect(flipped.diagnostics.map((d) => d.code)).not.toContain('resourceWithoutPayloadOrLocator')
  })

  it('登记：后果传到材质面 ⇒ 条目**无** `textureBlobIndex`、池为**空**（旧版"对象形态 ⇒ 0 条"的真因）', async () => {
    const faceOf = (
      a: Awaited<ReturnType<typeof assembleSinglebox>>,
    ): { materialPalette: readonly Record<string, unknown>[]; textureBlobs: readonly unknown[] } =>
      kernelRenderSourceFaceOf({
        scene: a.scene,
        content: a.content,
        frameObjects: a.frameObjects,
      }).materialInput as unknown as {
        materialPalette: readonly Record<string, unknown>[]
        textureBlobs: readonly unknown[]
      }

    const asIs = faceOf(await assembleSinglebox())
    expect(asIs.materialPalette.length, '前提：材质条目非空').toBeGreaterThan(0)
    expect(
      asIs.materialPalette.every((e) => e.textureBlobIndex === undefined),
      '登记：无内嵌字节 ⇒ 材质面不落下标 ⇒ `listPaletteTextureDataUrls` 对**任何**形态都枚举 0 条',
    ).toBe(true)
    expect(asIs.textureBlobs, '登记：无内嵌字节 ⇒ 池为空').toEqual([])

    const flipped = faceOf(await assembleSinglebox(toBareBase64))
    expect(
      flipped.materialPalette.some((e) => typeof e.textureBlobIndex === 'number'),
      '能红负对照：裸 base64 ⇒ 材质面落下标（同一份夹具，只换了写法）',
    ).toBe(true)
    expect(flipped.textureBlobs.length, '能红负对照：裸 base64 ⇒ 池非空').toBeGreaterThan(0)
  })
})
