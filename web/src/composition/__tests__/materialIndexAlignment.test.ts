/**
 * **G4+G5 · item 1（S2 第二半的准入条件）**：`materialIndex` ↔ 内核材质调色板的**索引自洽**。
 *
 * ## 为什么单独立一条判据
 *
 * 几何四边形的 `materialIndex` 是**下标**，它指向根级材质调色盘
 * （`render/schema/types.ts:294`：「根级材质调色盘，所有帧共享；`BakedQuad.materialIndex`
 * 直接指向此数组」）。若内核侧交付的调色板顺序与几何的索引空间不一致，后果是
 * **静默贴错图**（不是缺图）—— `composition/kernelTextureResources.ts:182-190`
 * 把这条风险逐字登记过（"漂移的后果是**静默贴错纹理**（比'没有纹理'难查得多）"）。
 *
 * ## 两侧顺序的生产点（本判据的现场）
 *
 * | 侧 | 生产点 | 索引空间 |
 * |---|---|---|
 * | 几何 quad 的 `materialIndex` | **文件原值，全链无重映射**：`domain/blockGeometry.ts:144/253-256` 承载，装配把 `payload.geometry[assetId].quads` 原样递下去 | **文件槽位** |
 * | 内核材质调色板顺序 | `composition/kernelAssembly.ts:1358 resourcesFromLegacy`（保序，`assetId: material:${i}`）→ `:1742` 走 `domain/content.ts#normalizeResources` | 修复前＝身份串字典序；修复后＝**槽位数值** |
 *
 * 旧排序键是**整串** `localeCompare`，而身份键是 `` `${assetId}\u0000${contentVersion}` ``
 * ⇒ 槽位被当**字母**比：`material:10` 排在 `material:2` 之前。`localeCompare` 逐字符比较
 * ⇒ **槽位数 ≥ 10 时才发生置换**（单数字前缀恰好同序）——这正是"多方块夹具（4 条材质）
 * 永远看不出问题"的原因，也是本判据必须同时喂**一份 ≥10 条材质的真信封**的原因。
 *
 * ## 实测锚点（修复前 → 修复后，同一判据本尊）
 *
 * | 读数（真信封，62 条材质 / 2165 个四边形） | 修复前 | 修复后 |
 * |---|---|---|
 * | 资源**数组位置 ≠ 文件槽位**条数 | 61 / 62 | **0** |
 * | 逐 quad `palette[q.materialIndex].locator` ≠ 文件槽位 locator | 2051 / 2165 | **0** |
 *
 * ## 本文件四组（正判据 + 负对照）
 *
 * 1. **① 多方块真夹具（4 条）**：位置索引与文件槽位逐 quad 严格相等（证明判据本身能绿，
 *    且该夹具上两个索引空间确实重合）；
 * 2. **② 真信封（62 条）**：**逐 quad** 断言 `palette[q.materialIndex]` 的材质身份
 *    （`locator`）＝ 文件槽位 locator，mismatch **0**；
 * 3. **②的负对照**：把规范化退回**旧键**（整串 `localeCompare`）⇒ 同一条逐 quad 判据
 *    必须判红（实测 2051）—— 证明比较器是这条判据的载荷，不是装饰；
 * 4. **③ 不变量①（与输入顺序无关）**：同一份真清单做**合法置换**（交换 + 逆序）⇒
 *    `documentContent(...).resources` 的身份序列与清单摘要**完全相同**
 *    （`domain/content.ts:396` 依赖的性质，修复不得丢）。
 *
 * 输入全部来自**生产解析 + 生产装配**（`detectAndParse` → `readEnvelopeLayers` →
 * `plainRootOf` → `assembleKernelDocument`），不是手工载荷。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { plainRootOf } from '@/adapters/plainRoot'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { textureBindingsOf, textureResourcesOf } from '@/composition/kernelTextureResources'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'
import {
  documentContent,
  normalizeResources,
  resourceIdentity,
  resourceManifestDigest,
  type ContentResource,
  type DocumentContent,
} from '@/domain/content'
import { contentDigestOf } from '@/domain/document'
import { contentIdentityKey } from '@/presentation/assetIdentity'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import type { RuntimeDocument } from '@/context/runtimeDocument'

/** 生产解析器注册顺序（与 `runtime/host/workbenchHost` 同一份清单）。 */
function productionRegistry() {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

/** `e2e/fixtures/` 下的真夹具（`core.autocrlf=true` ⇒ 读入先归一化）。 */
function readE2eFixture(fileName: string): Record<string, unknown> {
  const p = path.join(process.cwd(), 'e2e', 'fixtures', fileName)
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')) as Record<string, unknown>
}

async function assembleRaw(raw: Record<string, unknown>, label: string) {
  const parsed = await productionRegistry().detectAndParse(raw)
  if (parsed.document === null) throw new Error(`${label} 解析失败`)
  const plainRoot = plainRootOf(
    (await readEnvelopeLayers(raw as never)).plain as Record<string, unknown>,
  )
  const assembled = assembleKernelDocument({ doc: parsed.document as never, plainRoot })
  if (!assembled.ok) throw new Error(`${label} 装配核心失败`)
  return {
    doc: parsed.document as never as RuntimeDocument,
    value: assembled.value,
  }
}

/** 装配产物里**全部**带 `materialIndex` 的四边形（几何资产的原始下标空间）。 */
function quadMaterialIndexes(value: {
  scene: unknown
  frameObjects: readonly string[]
}): number[] {
  const scene = value.scene as unknown as {
    objects: Record<string, { dataId: string }>
    data: Record<string, { payload: unknown }>
  }
  const objId = value.frameObjects[0]
  if (objId === undefined) return []
  const obj = scene.objects[objId]
  if (obj === undefined) return []
  const payload = scene.data[obj.dataId]?.payload as unknown as {
    geometry?: Record<string, { quads?: { materialIndex?: number }[] }>
    cellGeometry?: Record<string, string>
  }
  const assetIds = [...new Set(Object.values(payload.cellGeometry ?? {}))]
  const out: number[] = []
  for (const a of assetIds) {
    for (const q of payload.geometry?.[a]?.quads ?? []) {
      if (Number.isInteger(q.materialIndex)) out.push(q.materialIndex as number)
    }
  }
  return out
}

/** 调色板条目的一条可比较身份：文件声明的纹理位置（`locator`）。 */
function locatorOf(entry: unknown): string {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return ''
  const v = (entry as Record<string, unknown>).locator
  return typeof v === 'string' ? v : ''
}

/** **位置判据**：`palette[quad.materialIndex]` 的身份 ＝ 文件槽位 locator？回不匹配条数。 */
function positionalMismatches(
  palette: readonly unknown[],
  quads: readonly number[],
  truth: (mi: number) => string,
): number {
  let bad = 0
  for (const mi of quads) if (locatorOf(palette[mi]) !== truth(mi)) bad += 1
  return bad
}

/** 逐条 `ContentResource` → 调色板条目（与 `kernelPresentationInputs.materialPaletteOf` 同字段面）。 */
function paletteEntryOfResource(r: unknown): Record<string, unknown> {
  const res = r as {
    kind: string
    blend: unknown
    emissive: unknown
    animation: unknown
    atlas: unknown
    linear: unknown
    useMipmaps: unknown
    ref: { url: string }
  }
  const entry: Record<string, unknown> = { kind: res.kind, locator: res.ref.url }
  if (res.blend !== null) entry.blend = res.blend
  if (res.emissive !== null) entry.emissive = res.emissive
  if (res.animation !== null) entry.animation = res.animation
  if (res.atlas !== null) entry.atlas = res.atlas
  if (res.linear !== null) entry.linear = res.linear
  if (res.useMipmaps !== null) entry.useMipmaps = res.useMipmaps
  return entry
}

/** **负对照**：把规范化退回旧键（整串 `localeCompare`）产出的顺序。 */
function oldKeyOrder(resources: readonly ContentResource[]): ContentResource[] {
  const seen = new Map<string, ContentResource>()
  for (const r of resources) {
    const key = resourceIdentity(r)
    if (!seen.has(key)) seen.set(key, r)
  }
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v)
}

describe('G4 · item 1：materialIndex ↔ 内核调色板槽位自洽', () => {
  it('① 多方块真夹具（4 条材质）：位置索引与文件槽位一致 —— 逐 quad 严格相等', async () => {
    const { doc, value } = await assembleRaw(
      readJson(fixturePath('multiblock-ebf-2ch')) as Record<string, unknown>,
      'ebf-2ch',
    )
    const resources = value.content.resources
    const filePalette = (doc.serialize() as Record<string, unknown>).materialPalette as readonly unknown[]
    const quads = quadMaterialIndexes(value)
    // 先立"有源可判"：资源条数、调色板条数、quad 条数三者都非空。
    expect(resources.length, '夹具必须带资源').toBe(4)
    expect(filePalette.length, '旧文档必须先声明调色板').toBe(resources.length)
    expect(quads.length, '夹具必须真有四边形').toBeGreaterThan(0)
    // 槽位数 < 10 ⇒ 新旧键同序（本夹具是"两口径重合"的那一支）。
    const slotDiff = resources.filter((r, i) => r.ref.assetId !== `material:${i}`).length
    expect(slotDiff, '4 条材质时位置应等于槽位').toBe(0)
    expect(
      positionalMismatches(resources.map(paletteEntryOfResource), quads, (mi) => locatorOf(filePalette[mi])),
      '位置判据在本夹具上必须 0 不匹配',
    ).toBe(0)
  })

  it('② 真信封（62 条材质）：逐 quad 断言位置索引＝文件槽位（mismatch 0）', async () => {
    const { doc, value } = await assembleRaw(
      readE2eFixture('structuredata-exported-envelope.json'),
      'envelope',
    )
    const resources = value.content.resources
    const filePalette = (doc.serialize() as Record<string, unknown>).materialPalette as readonly unknown[]
    const quads = quadMaterialIndexes(value)
    expect(resources.length).toBe(62)
    expect(filePalette.length, '旧文档声明同一批材质').toBe(resources.length)
    expect(quads.length).toBe(2165)
    // 读数 1：数组位置 ＝ 文件槽位（修复前 61/62 不等）。
    const slotDiff = resources.filter((r, i) => r.ref.assetId !== `material:${i}`).length
    expect(slotDiff, '位置 ≠ 槽位的条数（修复后必须为 0）').toBe(0)
    // 读数 2：逐 quad 的材质身份（locator）＝ 文件槽位 locator（修复前 2051/2165 不等）。
    const bad = positionalMismatches(
      resources.map(paletteEntryOfResource),
      quads,
      (mi) => locatorOf(filePalette[mi]),
    )
    expect(bad, '逐 quad 绑错材质的条数（修复后必须为 0）').toBe(0)
    // 具体锚点（可人工复核）：`mi=13` 的文件真值必须出现在位置 13。
    expect(locatorOf(filePalette[13]), 'mi=13 的文件真值').toBe(
      'gregtech:iconsets/GRAVITON_TOP_BOTTOM',
    )
    expect(locatorOf(resources.map(paletteEntryOfResource)[13]), '位置 13 的值').toBe(
      locatorOf(filePalette[13]),
    )
  })

  it('②负对照：规范化退回旧键（整串 localeCompare）⇒ 同一条逐 quad 判据判红', async () => {
    const { doc, value } = await assembleRaw(
      readE2eFixture('structuredata-exported-envelope.json'),
      'envelope',
    )
    const filePalette = (doc.serialize() as Record<string, unknown>).materialPalette as readonly unknown[]
    const truth = (mi: number) => locatorOf(filePalette[mi])
    const quads = quadMaterialIndexes(value)
    // 旧键产出的**新**顺序（负对照的输入），其余一切与正判据相同。
    const viaOldKey = normalizeResources(value.content.resources) // 正口径（现为槽位序）
    expect(positionalMismatches(viaOldKey.map(paletteEntryOfResource), quads, truth)).toBe(0)
    const viaOldComparator = oldKeyOrder(value.content.resources)
    expect(
      positionalMismatches(viaOldComparator.map(paletteEntryOfResource), quads, truth),
      '旧键必须判红（实测 2051 —— 旧键是这条判据的载荷）',
    ).toBe(2051)
    // 同时证明"顺序真的被换了"，而不是判据恒红：两条序列至少一条不同。
    expect(viaOldComparator.map((r) => r.ref.assetId).join(',')).not.toBe(
      viaOldKey.map((r) => r.ref.assetId).join(','),
    )
  })

  it('③ 不变量：同一份真清单做合法置换 ⇒ 内容身份序列与清单摘要完全相同', async () => {
    const { value } = await assembleRaw(
      readE2eFixture('structuredata-exported-envelope.json'),
      'envelope',
    )
    const base = value.content.resources
    const swapped = [...base]
    const one = swapped[1]!
    swapped[1] = swapped[2]!
    swapped[2] = one
    const reversed = [...base].reverse()
    const idsOf = (rs: readonly ContentResource[]) =>
      documentContent({ resources: rs }).resources.map(resourceIdentity)
    expect(idsOf(base).length).toBe(62)
    expect(idsOf(swapped), '交换 1↔2 后身份序列不变').toEqual(idsOf(base))
    expect(idsOf(reversed), '整表逆序后身份序列不变').toEqual(idsOf(base))
    // 摘要（自带 sort）与规范化产出的身份序列都不得受排列影响。
    expect(resourceManifestDigest(swapped)).toBe(resourceManifestDigest(base))
    expect(normalizeResources(reversed).map(resourceIdentity)).toEqual(
      normalizeResources(base).map(resourceIdentity),
    )
  })

  it('④ 绑定侧（爆炸半径 P2）：`material:<mi>` 的位置解析落到**同一槽位**的那条资源', async () => {
    const { value } = await assembleRaw(
      readE2eFixture('structuredata-exported-envelope.json'),
      'envelope',
    )
    const base = value.content.resources
    const quads = quadMaterialIndexes(value)
    const distinct = [...new Set(quads)].sort((a, b) => a - b)
    expect(distinct.length, '夹具必须真的有多个材质分组').toBeGreaterThan(1)
    // 生产解码器（全 null 即可：身份/位置与解码状态无关），身份由 `textureResourcesOf` 造。
    const tex = await textureResourcesOf(base, { decode: async () => null })
    const bindings = textureBindingsOf({
      materials: distinct.map((mi) => ({
        id: `material:${mi}`,
        version: 'v1',
        blend: 'opaque' as const,
        tint: 0xffffff,
        useVertexColor: true,
      })),
      resources: tex,
    })
    expect(bindings.length).toBe(distinct.length)
    for (let i = 0; i < distinct.length; i++) {
      const mi = distinct[i]!
      expect(base[mi]!.ref.assetId, `位置 ${mi} 必须是槽位 ${mi}`).toBe(`material:${mi}`)
      expect(
        contentIdentityKey(bindings[i]!.map!),
        `material:${mi} 必须绑到位置 ${mi} 的资源`,
      ).toBe(contentIdentityKey(tex[mi]!.identity))
    }
    // 负对照（同一条判据退回旧键顺序 ⇒ 位置解析当场错位）。
    const viaOld = oldKeyOrder(base)
    expect(
      viaOld.some((r, i) => r.ref.assetId !== `material:${i}`),
      '旧键顺序下位置必然错位（证明本组对顺序敏感）',
    ).toBe(true)
  })

  it('⑤ 涟漪账（实测）：清单摘要不变；内容身份只在 ≥10 条材质上变', async () => {
    const env = await assembleRaw(
      readE2eFixture('structuredata-exported-envelope.json'),
      'envelope',
    )
    const base = env.value.content.resources
    const oldOrder = oldKeyOrder(base)
    const fresh = documentContent({ resources: base })
    // "修复前的装配产物" = 同样的内容、但资源数组按**旧键**顺序
    // （不能再喂 `documentContent` —— 它会再规范化一次，把旧顺序抹平，测量就失效）。
    const legacy: DocumentContent = Object.freeze({ ...fresh, resources: Object.freeze(oldOrder) })
    // `resourceManifestDigest` 自带 `.sort()` ⇒ 不受清单排列影响（主张复核为实测）。
    // 实测读数（供涟漪账对照）：清单摘要 2254232072（两种顺序相同）；
    // 内容身份 new(槽位序) = 1513787328 / old(旧键序) = 3317157096（**必变**）。
    expect(resourceManifestDigest(fresh.resources)).toBe(resourceManifestDigest(legacy.resources))
    // 内容身份**会**变：资源数组顺序进入 `contentOf`（`canonicalize` 只排对象键、**不排数组**）
    // —— 涟漪如实入账，不静默重标基线。
    expect(
      contentDigestOf(env.value.scene, env.value.animation, fresh),
      '62 条材质上内容身份必变（涟漪如实入账）',
    ).not.toBe(contentDigestOf(env.value.scene, env.value.animation, legacy))
    // 多方块真夹具（4 条 ⇒ 槽位 <10）：新旧键同序 ⇒ 内容身份**不变**。
    const mb = await assembleRaw(
      readJson(fixturePath('multiblock-ebf-2ch')) as Record<string, unknown>,
      'ebf-2ch',
    )
    const mbBase = mb.value.content.resources
    expect(oldKeyOrder(mbBase).map((r) => r.ref.assetId)).toEqual(
      normalizeResources(mbBase).map((r) => r.ref.assetId),
    )
    const mbFresh = documentContent({ resources: mbBase })
    const mbLegacy: DocumentContent = Object.freeze({
      ...mbFresh,
      resources: Object.freeze(oldKeyOrder(mbBase)),
    })
    expect(
      contentDigestOf(mb.value.scene, mb.value.animation, mbLegacy),
      '≤9 条材质上内容身份不变（多方块冻结读数不受影响）',
    ).toBe(contentDigestOf(mb.value.scene, mb.value.animation, mbFresh))
  })
})
