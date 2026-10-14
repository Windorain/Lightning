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
 * ## 三组（含可判红的负对照）
 *
 * | 组 | 断言 |
 * |---|---|
 * | ① | 生产装配出的**冻结**材质输入（真夹具）走 hydrate + registry **不抛**、产出条目 `blend` 有值 |
 * | ② | 同一份载荷上「原地写」**必然抛** `TypeError`（证明载荷真的冻结、旧形态确是失效源） |
 * | ③ | 输入**永不被改写**（无 `blend` 残留写入）+ 无需补全时返回**同一对象**（不制造无意义浅拷） |
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
      '前提：textureBlobs 必须是**数组**（对象形态会让 `listPaletteTextureDataUrls` 一张都枚举不出来）',
    ).toBe(true)
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

    // **形态负对照**：同一份调色板配对象形态的 textureBlobs ⇒ 枚举结果为 0
    // （证明"数组"这条要求有区分力，不是可选的风格问题）。
    const asObject = { ...materialInput, textureBlobs: { '0': 'AAAA' } }
    expect(listPaletteTextureDataUrls(asObject).length, '对象形态 ⇒ 枚举 0 条').toBe(0)
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
