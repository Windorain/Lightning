/**
 * **G4 · S2 第二半（帧为主半）**：DRW 渲染源面的**内核侧具名承载体**判据。
 *
 * ## 本文件证的三样（逐条对位旧读取点）
 *
 * | 本面字段 | 旧读取点（`runtime/drwMeshPipeline.ts`） | 本判据的口径 |
 * |---|---|---|
 * | `frameCount` | `:225 docRef.value?.frameCount` | 与装配面 `frameObjects.length` 同值 |
 * | `definitionAt(i)` | `:304-320`/`:344-361`（`doc.serialize()` → `resolveRenderBundle`） | 逐 quad 材质身份 == **文件槽位**（真信封 62 条 / 2165 quad，实测 0 不匹配；口径与 `materialIndexAlignment.test.ts` 同源） |
 * | `definitionAt(i).tooltipPalette` | `:314`/`:361 tooltipPalette.value = resolved.tooltipPalette` | 与文件根 `tooltipPalette` **集合相同**（池是内容去重 ⇒ 判据是"无丢失、无凭空"） |
 * | `materialInput` | `:178 buildMaterialLibrary(plain ?? doc.serialize())` | `materialPalette[i].locator` == 文件槽位 locator；`textureBlobs` 键 = **槽位**且只含有内嵌字节的条 |
 *
 * ## 负对照（缺一不可）
 *
 * - `definitionAt(越界/无供源)` ⇒ `null`（**不**回落旧文档、**不**造空定义）；
 * - 空 `frameObjects` ⇒ `frameCount === 0` 且 `definitionAt(0) === null`；
 * - 另一份真夹具（多方块 `multiblock-ebf-2ch`）上同样给出定义面 ⇒ 本面不是"信封特例"。
 *
 * 输入全部来自**生产解析 + 生产装配**（`detectAndParse` → `readEnvelopeLayers` →
 * `plainRootOf` → `assembleKernelDocument`），不是手工载荷。
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
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import type { RuntimeDocument } from '@/context/runtimeDocument'

function productionRegistry() {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

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
  return { doc: parsed.document as never as RuntimeDocument, value: assembled.value }
}

function faceOfAssembled(value: {
  scene: unknown
  content: unknown
  frameObjects: readonly string[]
}) {
  return kernelRenderSourceFaceOf({
    scene: value.scene as never,
    content: value.content as never,
    frameObjects: value.frameObjects,
  })
}

function locatorOf(entry: unknown): string {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return ''
  const v = (entry as Record<string, unknown>).locator
  return typeof v === 'string' ? v : ''
}

/** 与 `materialIndexAlignment.test.ts` 同源：逐 quad 检查 `palette[mi]` 是否等于文件槽位 locator。 */
function quadMismatches(
  palette: readonly unknown[],
  value: { scene: unknown; frameObjects: readonly string[] },
  truth: (mi: number) => string,
): number {
  const scene = value.scene as unknown as {
    objects: Record<string, { dataId: string }>
    data: Record<string, { payload: unknown }>
  }
  const objId = value.frameObjects[0]
  if (objId === undefined) return 0
  const obj = scene.objects[objId]
  if (obj === undefined) return 0
  const payload = scene.data[obj.dataId]?.payload as unknown as {
    geometry?: Record<string, { quads?: { materialIndex?: number }[] }>
    cellGeometry?: Record<string, string>
  }
  const assetIds = [...new Set(Object.values(payload.cellGeometry ?? {}))]
  let bad = 0
  for (const a of assetIds) {
    for (const q of payload.geometry?.[a]?.quads ?? []) {
      const mi = q.materialIndex
      if (!Number.isInteger(mi)) continue
      if (locatorOf(palette[mi as number]) !== truth(mi as number)) bad += 1
    }
  }
  return bad
}

describe('G4 · S2 第二半：DRW 渲染源面（内核直出）', () => {
  it('① 真信封：frameCount / 定义面（逐 quad 槽位等价）/ 说明池集合 / 材质输入', async () => {
    const { doc, value } = await assembleRaw(
      readE2eFixture('structuredata-exported-envelope.json'),
      'envelope',
    )
    const face = faceOfAssembled(value)
    const filePlain = doc.serialize() as Record<string, unknown>
    const filePalette = filePlain.materialPalette as readonly unknown[]

    // frameCount 与装配面同源。
    expect(face.frameCount, 'frameCount = 装配面 frameObjects 长度').toBe(value.frameObjects.length)
    expect(face.frameCount).toBeGreaterThan(0)

    const at0 = face.definitionAt(0)
    expect(at0, '帧 0 必须给出定义面（不回落旧文档）').not.toBeNull()
    // 定义面的材质调色板 = 槽位序（逐 quad 与文件槽位等价；口径与 item 1 判据同源）。
    const defPalette = (at0!.definition as unknown as { materialPalette: readonly unknown[] })
      .materialPalette
    expect(defPalette.length, '定义面材质条数 = 文件声明条数').toBe(filePalette.length)
    expect(
      quadMismatches(defPalette, value, (mi) => locatorOf(filePalette[mi])),
      '逐 quad 材质身份必须等于文件槽位（0 不匹配）',
    ).toBe(0)

    // 说明池：装配把逐格文本归一进 `cellContent[].tooltip`，池因此是**被引用文本**的去重集
    // ⇒ 判据是两向可判的：①被引用文本**不丢**；②池里**不凭空**多出文件没有的文本。
    // （文件池里的**孤儿条目**——声明了却没有任何格引用——合法地不在内核池里，
    //  投影侧 `tooltipPoolOfPayloads` 是同一口径；故这里**不**用集合相等。）
    const filePool = (filePlain.tooltipPalette ?? []) as readonly string[]
    const fileGrid = filePlain.cellTooltipGrid as readonly (readonly (readonly number[])[])[] | undefined
    expect(filePool.length, '真信封的文件说明池为 16 条（R0 冻结读数同族）').toBe(16)
    expect(fileGrid, '真信封必须带逐格说明网格').toBeDefined()
    const referenced = new Set(
      fileGrid!
        .flat(2)
        .filter((i) => Number.isInteger(i) && i >= 0)
        .map((i) => filePool[i] as string | undefined)
        .filter((t): t is string => typeof t === 'string' && t !== ''),
    )
    expect(referenced.size, '前提：文件里确有被引用的说明文本').toBeGreaterThan(0)
    const kernelPool = new Set(at0!.tooltipPalette)
    for (const t of referenced) {
      expect(kernelPool.has(t), `被引用的说明文本不得丢失：${t}`).toBe(true)
    }
    for (const t of kernelPool) {
      expect(filePool.includes(t), `内核池不得凭空多出文件没有的文本：${t}`).toBe(true)
    }

    // #398 / M2-2：定义面必须携带逐格说明下标网格 —— 消费侧
    // `resolvePreviewTooltipText(def, palette, hover)` **只从定义**读 `cellTooltipGrid`。
    // 修前内核重建路径漏挂它 ⇒ 生产上逐格说明恒回退成宿主 NEI 名（工作台 + Wiki 预览同病）。
    const defGrid = (at0!.definition as unknown as { cellTooltipGrid?: number[][][] }).cellTooltipGrid
    expect(defGrid, '定义面必须携带 cellTooltipGrid（逐格说明的呈现输入）').toBeDefined()
    let matchedCells = 0
    for (let z = 0; z < fileGrid!.length; z++) {
      for (let row = 0; row < fileGrid![z]!.length; row++) {
        for (let col = 0; col < fileGrid![z]![row]!.length; col++) {
          const fileIdx = fileGrid![z]![row]![col]!
          if (fileIdx < 0) continue
          const defIdx = defGrid![z]?.[row]?.[col]
          expect(defIdx, `定义面网格必须在 (${z},${row},${col}) 有说明`).toBeGreaterThanOrEqual(0)
          expect(
            at0!.tooltipPalette[defIdx!],
            `定义面 (${z},${row},${col}) 的说明文本必须与文件原件一致`,
          ).toBe(filePool[fileIdx])
          matchedCells += 1
        }
      }
    }
    expect(matchedCells, '前提：文件里确有逐格说明（不是空网格）').toBeGreaterThan(0)

    // 材质输入：位置 = 槽位 + 纹理字节按槽位键。
    const mi = face.materialInput
    expect(mi.geometryPhase).toBe('baked')
    expect(mi.materialPalette.length).toBe(filePalette.length)
    for (let i = 0; i < filePalette.length; i++) {
      expect(locatorOf(mi.materialPalette[i]), `材质输入位置 ${i} 的身份`).toBe(locatorOf(filePalette[i]))
    }
    const slots = Object.keys(mi.textureBlobs).map((k) => Number(k))
    expect(slots.length, '真信封内嵌资源条数 > 0').toBeGreaterThan(0)
    expect(slots.every((s) => Number.isInteger(s) && s >= 0 && s < filePalette.length), '键必须是合法槽位').toBe(true)
  })

  it('② 负对照：越界 / 无供源 ⇒ null（不回落旧文档、不造空定义）', async () => {
    const { value } = await assembleRaw(
      readE2eFixture('structuredata-exported-envelope.json'),
      'envelope',
    )
    const face = faceOfAssembled(value)
    expect(face.definitionAt(face.frameCount), '越界必须回 null').toBeNull()
    expect(face.definitionAt(-1), '负下标必须回 null').toBeNull()
    const noSource = kernelRenderSourceFaceOf({
      scene: value.scene,
      content: value.content,
      frameObjects: [],
    })
    expect(noSource.frameCount, '无供源 ⇒ 帧数 0').toBe(0)
    expect(noSource.definitionAt(0), '无供源 ⇒ 定义面 null').toBeNull()
    // 同一份内容上材质输入仍可用（材质与帧结构无关）—— 证明"取不到定义"不等于"整面不可用"。
    expect(noSource.materialInput.materialPalette.length).toBeGreaterThan(0)
  })

  it('③ 另一份真夹具（多方块）：本面同样给出定义 ⇒ 不是信封特例', async () => {
    const { value } = await assembleRaw(
      readJson(fixturePath('multiblock-ebf-2ch')) as Record<string, unknown>,
      'ebf-2ch',
    )
    const face = faceOfAssembled(value)
    expect(face.frameCount).toBe(value.frameObjects.length)
    expect(face.frameCount).toBeGreaterThan(0)
    const at0 = face.definitionAt(0)
    expect(at0, '多方块夹具帧 0 必须给出定义面').not.toBeNull()
    expect((at0!.definition as unknown as { cellGrid: unknown[] }).cellGrid.length).toBeGreaterThan(0)
  })
})
