/**
 * **G4（渲染链旧格式源终切 · S2 第一半）**：DRW 定义面的**内核侧直出承载体**判据。
 *
 * ## 本文件证的是什么
 *
 * 旧链路里"当帧定义"只能由**旧格式文档**解析出来：
 *
 * ```
 *  runtime/drwMeshPipeline.ts:304-320（帧路径）
 *    doc.serialize()                                  ← 有损中间层
 *    isWorldDocument(plain) && plain.frames.length>0  ← 前提不成立就**早退**（不解析定义）
 *    resolveRenderBundle({document: plain}, idx)      ← 定义来自 frames[idx].structure
 *  runtime/drwMeshPipeline.ts:344-361（装载路径）无条件 resolveRenderBundle ⇒ 形态不符时**抛**
 * ```
 *
 * 现在承载在 `composition/kernelPresentationInputs#kernelDefinitionFaceOf`：
 * 定义来自**内核载荷**（`blockGrid`，与呈现编译同一份 `projectGridCells` 重建口径），
 * 帧下标 → 对象 id 由**装配面**显式给出。
 *
 * ## 判据的形状（缺一不可）
 *
 * 1. **直出是生产事实**：输入全部来自**生产解析 + 生产装配**（生产注册表
 *    `detectAndParse` → `readEnvelopeLayers` → `plainRootOf` → `adoptLoadedDocument`
 *    ＝ 生产链；`assembleKernelDocument` ＝ 同一装配核心，本判据用它取场景）；
 * 2. **旧链路取不到的形态**（实测缺口，INV-2）：**多方块为主**的文档上，帧路径的前提
 *    （`isWorldDocument && frames.length>0`）不成立 ⇒ **早退**；强行走 `resolveRenderBundle`
 *    则**抛错** `StructureData 须为 geometryPhase=baked 的终态`。而内核直出在这份
 *    装配产物上给出非空定义面 —— 这正是本承载体的存在理由，不是"换个调用形态"；
 * 3. **与旧 DRW 路径 parity**（在旧链路**确实解析得出**定义的形态上，真实帧为主信封）：
 *    口径是**实测校准**的，不是放宽 —— 旧面来自**有损往返**（`serialize()` 丢弃源里声明过的
 *    字段），故主张两条：① 内核面在旧面**声明过**的字段上逐项相同；② 差异**只**许是
 *    内核面多出来的（`renderMode` 的实测差异是"直出更完整"的正面证据）。
 *    **实测到的真缺口（如实登记）**：旧面声明的**纹理绑定**字段
 *    （`locator`/`textureBlobIndex`/`atlas`）内核定义面**没有** —— 承载在纹理端口
 *    （`presentation/textureBinding.ts`，G7 在制）。口径把允许缺失的字段**白名单钉死**为
 *    这一族，其余任何缺失判红；
 *    负对照 = 换一份真夹具，该 parity 谓词必须**判假**（证明比较有区分力，不是恒真）；
 * 4. **帧下标是有效的**：两份**真夹具**拼出的两帧世界文档（帧 0 = `minimal-v2` 的真帧、
 *    帧 1 = 真实信封解包后的 baked 结构）逐帧给出**不同**的定义面，且对象 id 逐帧
 *    对应装配面（证明它不是常数、也不是"永远取第一帧"）；
 * 5. **负对照判红**：去掉供源（`frameObjects: []`）或越界 ⇒ `face === null` 且
 *    `reason === 'frame-out-of-range'`，**同一条正判据当场为假**（有区分力）。
 *
 * ⚠️ 本文件**不**证明 `tooltipPalette` / 材质混合模式 / 图标缓存身份键已迁 —— 那三样是
 * S2 第二、三半的显式欠账（见 `kernelDefinitionFaceOf` 的文档）。
 */

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { plainRootOf } from '@/adapters/plainRoot'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { kernelDefinitionFaceOf } from '@/composition/kernelPresentationInputs'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'
import { isWorldDocument, resolveRenderBundle } from '@/render/data/bundleResolve'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import { KernelSession } from '@/runtime/kernelSession'
import type { RuntimeDocument } from '@/context/runtimeDocument'

const NOOP_LOG = { info: () => {}, warn: () => {} }

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

/**
 * 走**生产装配**装载一份真夹具。
 *
 * 两条装配路径都用同一次 `plainRootOf` 归一后的源根：
 *  - `adoptLoadedDocument`：生产链（会话侧装配面在这里置位）；
 *  - `assembleKernelDocument`：**同一份装配核心**，本判据用它取 `scene`/`content`/`frameObjects`
 *    （`adoptLoadedDocument` 只回布尔，而会话不暴露场景）。
 * ① 组自检两者的 `frameObjects` 逐项相同 —— 防止"判据装配面与生产装配面不是同一个"。
 */
async function assembleRaw(
  raw: Record<string, unknown>,
  label: string,
  mode: 'envelope' | 'plain' = 'envelope',
) {
  const parsed = await productionRegistry().detectAndParse(raw)
  if (parsed.document === null) throw new Error(`${label} 解析失败`)
  // Plain 文档（`minimal-v2` 等）没有信封层，直接就是源根；信封则走生产解包器。
  const plainRoot =
    mode === 'plain'
      ? plainRootOf(raw)
      : plainRootOf((await readEnvelopeLayers(raw as never)).plain as Record<string, unknown>)
  const session = new KernelSession({ documentId: `g4-${label}`, contextId: 'g4-ctx', capabilities: [] })
  const ok = adoptLoadedDocument({ kernel: session, log: NOOP_LOG }, parsed.document as never, plainRoot, label)
  if (!ok) throw new Error(`${label} 生产装配失败`)
  const assembled = assembleKernelDocument({ doc: parsed.document as never, plainRoot })
  if (!assembled.ok) throw new Error(`${label} 装配核心失败`)
  return {
    doc: parsed.document as never as RuntimeDocument,
    session,
    value: assembled.value,
  }
}

/** 多方块为主的真夹具（`src/context/__tests__/fixtures/`）。 */
async function assembleFixture(name: string) {
  return assembleRaw(readJson(fixturePath(name)) as Record<string, unknown>, name)
}

/** 帧为主的真信封（`e2e/fixtures/`，payload 为 base64(gzip) 由生产解包器解）。 */
async function assembleEnvelope() {
  return assembleRaw(readE2eFixture('structuredata-exported-envelope.json'), 'envelope')
}

/** 内核直出：某一帧的定义面。 */
function faceOf(value: { scene: never; content: never; frameObjects: readonly string[] }, i: number) {
  return kernelDefinitionFaceOf({
    scene: value.scene,
    content: value.content,
    frameObjects: value.frameObjects,
    frameIndex: i,
  })
}

/**
 * **旧 DRW 读取点**能取到的定义面（`drwMeshPipeline.ts:304-320` 的同一形态）；
 * 取不到时回 `null`（帧路径早退），抛错时也回 `null`（装载路径的形态不符）。
 */
function oldDrwDefinitionOf(doc: RuntimeDocument, frameIndex: number) {
  const plain = doc.serialize()
  if (!isWorldDocument(plain) || plain.frames.length === 0) return null
  try {
    return resolveRenderBundle({ document: plain }, frameIndex).definition
  } catch {
    return null
  }
}

/**
 * 调色板 parity 的**口径**（实测校准，不是放宽）：旧链路的面来自**有损往返**
 * （`RuntimeDocument.serialize()`），它**丢弃**了源里声明过的一些字段；内核面从内核内容
 * 直出，保留它们。故 parity 的正确主张是"**内核面在每个旧面声明过的字段上逐项相同**"
 * ＋"差异**只**是内核面多出来的（旧面 `undefined` 而内核面有值）"。
 *
 * @returns 旧面声明过但两面对不上的字段清单（空 = parity 成立）
 */
/**
 * 调色板条目在本判据里**只按字典访问**（只做键/值相等比较，不依赖具体条目类型）——
 * 故形参收 `readonly object[]`，取值走 `Reflect.get`：这样 `MaterialPaletteEntry[]` /
 * `BakedModelPaletteEntry[]` 都能直接传入，**不需要**为了过编译而放宽任何断言。
 */
function legacyCoverageDiff(
  kernelPalette: readonly object[],
  legacyPalette: readonly object[],
  keys?: readonly string[],
): string[] {
  if (kernelPalette.length !== legacyPalette.length) return [`长度 ${kernelPalette.length}≠${legacyPalette.length}`]
  const diffs: string[] = []
  legacyPalette.forEach((l, i) => {
    for (const k of keys ?? Object.keys(l)) {
      if (!(k in l)) continue
      const kv = Reflect.get(kernelPalette[i], k)
      const lv = Reflect.get(l, k)
      if (JSON.stringify(kv) !== JSON.stringify(lv)) {
        diffs.push(`[${i}].${k}: 内核=${JSON.stringify(kv)} 旧=${JSON.stringify(lv)}`)
      }
    }
  })
  return diffs
}

/**
 * 旧面**声明过**、内核面**从不**声明的字段（去重，**与顺序无关**）。
 *
 * 为什么按"字段全集"而不是按下标比较：两面的**索引约定不同**（同一集合、不同顺序，
 * 见 ③ 的实测日志），按下标比会把"顺序差异"误报成"字段缺失"。逐条目的等价性由
 * `MATERIAL_CARRIED_KEYS` 的集合比较把守（那一层是顺序无关的）。
 *
 * 本判据把**允许缺失**的字段白名单钉死为**纹理绑定/采样器族**（承载在纹理端口，
 * 属 G7 写面 / S2 第二半的显式欠账），其余任何缺失都必须**判红**。
 */
function missingKeysOf(
  kernelPalette: readonly object[],
  legacyPalette: readonly object[],
): string[] {
  const declared = (m: readonly object[]) =>
    new Set(m.flatMap((e) => Object.keys(e).filter((k) => Reflect.get(e, k) !== undefined)))
  const kernelKeys = declared(kernelPalette)
  return [...declared(legacyPalette)].filter((k) => !kernelKeys.has(k))
}

/** 定义面本身承载的材质字段（内核内容 `DocumentContent.resources` 有对应的那些）。 */
const MATERIAL_CARRIED_KEYS = ['kind', 'blend', 'emissive', 'animation'] as const
/** 允许缺失的字段族：纹理绑定与采样器属性（承载在纹理端口，G7 在制）。 */
const TEXTURE_BINDING_KEYS = ['locator', 'textureBlobIndex', 'atlas', 'linear', 'useMipmaps'] as const

/** 内核面**多**出来的字段（旧面 `undefined`、内核面有值）——即"旧往返有损"的逐项证据。 */
function kernelOnlyFields(
  kernelPalette: readonly object[],
  legacyPalette: readonly object[],
): string[] {
  const out: string[] = []
  kernelPalette.forEach((k, i) => {
    const l = legacyPalette[i] ?? {}
    for (const key of Object.keys(k)) {
      if (Reflect.get(k, key) !== undefined && Reflect.get(l, key) === undefined) out.push(`[${i}].${key}`)
    }
  })
  return out
}

const MULTIBLOCK_FIXTURES = ['multiblock-ebf-2ch', 'multiblock-tier-only'] as const

describe('G4 · DRW 定义面内核直出（kernelDefinitionFaceOf）', () => {
  it('① 生产装配 ⇒ 定义面直出：对象 id 来自装配面，定义面来自内核载荷', async () => {
    const cases: { label: string; load: () => Promise<Awaited<ReturnType<typeof assembleRaw>>> }[] = [
      ...MULTIBLOCK_FIXTURES.map((name) => ({ label: name, load: () => assembleFixture(name) })),
      { label: 'envelope', load: async () => await assembleEnvelope() },
    ]
    for (const c of cases) {
      const { session, value } = await c.load()
      // 前提自检：本判据用的装配面**就是**生产链装配出来的那一份。
      const face = session.assemblyFaceOf()
      expect(face, `${c.label}：生产装配必须置位装配面`).not.toBeNull()
      expect(
        face?.frameObjects,
        `${c.label}：判据的 frameObjects 必须与生产装配面逐项相同（否则比的是两个世界）`,
      ).toEqual([...value.frameObjects])
      expect(value.frameObjects.length, `${c.label}：夹具必须至少有帧对象（否则本组是空转）`).toBeGreaterThan(0)

      const got = faceOf(value as never, 0)
      expect(got.reason, `${c.label}：生产装配产物必须能直出定义面（reason=${got.reason}）`).toBeNull()
      const def = got.face?.definition
      expect(def, `${c.label}：定义面必须在场`).toBeDefined()
      expect(got.face?.objectId, `${c.label}：对象 id 必须是装配面给出的那一个`).toBe(value.frameObjects[0])
      expect(
        (def?.blockPalette ?? []).length,
        `${c.label}：定义面的 blockPalette 必须非空（图标缓存吃这一面）`,
      ).toBeGreaterThan(0)
      expect(Object.keys(def?.cellGrid ?? {}).length, `${c.label}：定义面的 cellGrid 必须非空`).toBeGreaterThan(0)
    }
  })

  it('② 旧链路在多方块形态上**取不到**定义面（实测缺口）——内核直出给得出', async () => {
    for (const name of MULTIBLOCK_FIXTURES) {
      const { doc, value } = await assembleFixture(name)
      // 旧帧路径的前提（drwMeshPipeline.ts:309）：不成立 ⇒ 早退，定义面**永不**被解析。
      const plain = doc.serialize()
      const framePremise = isWorldDocument(plain) && plain.frames.length > 0
      expect(
        framePremise,
        `${name}：前提——旧帧路径在本形态上必须**不成立**（否则本组证明不了缺口）`,
      ).toBe(false)
      // 旧装载路径（:350-361）无条件调 resolveRenderBundle ⇒ 本形态下抛错（如实记录原文）。
      let thrown: string | null = null
      try {
        resolveRenderBundle({ document: plain }, 0)
      } catch (e) {
        thrown = (e as Error).message
      }
      expect(thrown, `${name}：旧装载路径必须**抛错**（这是缺口的一半，不能静默）`).not.toBeNull()
      expect(thrown ?? '', `${name}：抛错原文须是"非 baked 终态"这一条`).toContain('geometryPhase=baked')
      // 旧链路整体取不到定义面。
      expect(oldDrwDefinitionOf(doc, 0), `${name}：旧链路整体必须给不出定义面`).toBeNull()
      // 而内核直出在同一份装配产物上给得出（非空洞：面里真的有方块）。
      const got = faceOf(value as never, 0)
      expect(got.reason, `${name}：内核直出必须给得出定义面`).toBeNull()
      expect(
        (got.face?.definition.blockPalette ?? []).length,
        `${name}：内核直出的定义面必须有内容（否则"给得出"是空话）`,
      ).toBeGreaterThan(0)
    }
  })

  it('③ 与旧 DRW 路径 parity（旧链路解析得出的形态）+ 变体判假（比较有区分力）', async () => {
    const { doc, value } = await assembleEnvelope()
    const legacy = resolveRenderBundle({ document: doc.serialize() }, 0)
    // 前提：旧链路在这个形态上**确实**解析出了定义面（否则 parity 是空转）。
    expect(
      (legacy.definition.blockPalette ?? []).length,
      '前提——旧链路必须解析出非空 blockPalette',
    ).toBeGreaterThan(0)
    const got = faceOf(value as never, 0)
    expect(got.reason, '内核直出必须给得出定义面').toBeNull()
    // 口径：旧面**声明过**的字段逐项相同（差异只许是内核面多出来的，见上面的实测校准）。
    expect(
      legacyCoverageDiff(got.face?.definition.blockPalette ?? [], legacy.definition.blockPalette ?? []),
      '直出定义面的 blockPalette 必须覆盖旧 DRW 路径声明过的每一个字段',
    ).toEqual([])
    // **材质面**：实测旧面与内核面是**同一集合、不同顺序**（索引约定不同）——
    // 故 parity 的不变量不是"逐下标相同"，而是①同一材质集合②缺失字段只许是纹理绑定族。
    // 实测的顺序差异如实打印，不静默。
    const kMat = got.face?.definition.materialPalette ?? []
    const lMat = legacy.definition.materialPalette ?? []
    expect(kMat.length, '材质面条目数必须与旧面相同').toBe(lMat.length)
    const pick = (m: readonly object[], keys: readonly string[]) =>
      m
        .map((e) => JSON.stringify(keys.filter((k) => k in e).map((k) => [k, Reflect.get(e, k)])))
        .sort()
    expect(
      pick(kMat, MATERIAL_CARRIED_KEYS),
      '直出定义面的材质面必须与旧 DRW 路径在"定义面自己承载的字段"上是**同一集合**（顺序差异见下条日志）',
    ).toEqual(pick(lMat, MATERIAL_CARRIED_KEYS))
    const orderDiffs = legacyCoverageDiff(kMat, lMat, MATERIAL_CARRIED_KEYS)
    console.log(
      `[G4] 材质面顺序差异 ${orderDiffs.length} 处（同集合、不同索引约定）；` +
        `示例：${orderDiffs.slice(0, 3).join(' / ') || '（无）'}`,
    )
    // 实测缺口（**如实登记，不静默**）：旧面声明的**纹理绑定**字段内核定义面**没有** ——
    // 它们的承载在纹理端口（`presentation/textureBinding.ts`，G7 在制）。
    // 口径收紧：缺失字段**只许**是这一族；其它任何缺失都判红（缺口不许被顺带放行）。
    const missing = missingKeysOf(kMat, lMat)
    console.log(`[G4] materialPalette 内核面缺失的字段：${missing.join(', ') || '（无）'}`)
    expect(
      missing.filter((k) => !(TEXTURE_BINDING_KEYS as readonly string[]).includes(k)),
      '**除纹理绑定族外，内核定义面不得缺失旧面声明过的材质字段**（缺失即真缺口）',
    ).toEqual([])
    // 实测的有损差异（**不是**放宽：这是"内核直出比旧往返更完整"的正面证据）。
    console.log(
      `[G4] blockPalette 内核面多出的字段：${kernelOnlyFields(
        got.face?.definition.blockPalette ?? [],
        legacy.definition.blockPalette ?? [],
      ).join(', ') || '（无）'}`,
    )
    // **负对照（区分力）**：换一份真夹具，同一个 parity 谓词必须判假 ——
    // 否则"逐项相同"可能只是所有定义面都长一样（恒真）。
    const other = await assembleFixture('multiblock-ebf-2ch')
    const otherFace = faceOf(other.value as never, 0)
    expect(
      otherFace.face?.definition.blockPalette,
      '**负对照**：另一份真夹具的定义面必须**不**等于信封的定义面（否则 parity 无区分力）',
    ).not.toEqual(got.face?.definition.blockPalette)
  })

  it('④ 帧下标有效：两帧世界文档（两份真夹具拼帧）逐帧给出**不同**定义面', async () => {
    // ## 为什么必须拼帧（如实记录的夹具缺口）
    //
    // 仓里**帧为主**的真夹具（`minimal-v2` / `parts-*`）都恰好只有 1 帧，而**多方块为主**
    // 的真夹具装配出的网格对象恰好 1 个（`kernelAssembly.test.ts:118` 钉住）——
    // 即"多帧 → 多对象"这条映射**没有任何真夹具覆盖**。这里的构造只有**一处**：
    // 把两份真夹具的**真结构**各放一帧（帧 0 = `minimal-v2` 的帧 0，帧 1 = 真信封解包后的
    // baked 结构），其余全部走生产解析 + 生产装配。
    const minimal = readE2eFixture('minimal-v2.json')
    const envelopePlain = (await readEnvelopeLayers(readE2eFixture('structuredata-exported-envelope.json') as never))
      .plain as Record<string, unknown>
    const minimalFrames = minimal.frames as Record<string, unknown>[]
    expect(minimalFrames.length, '前提：minimal-v2 必须有帧').toBeGreaterThan(0)
    const twoFrame: Record<string, unknown> = {
      ...minimal,
      frames: [minimalFrames[0], { index: 1, label: 'g4-second', durationMs: 120, structure: envelopePlain }],
    }
    const { value } = await assembleRaw(twoFrame, 'two-frame', 'plain')
    expect(value.frameObjects.length, '两帧世界文档必须装配出两个网格对象').toBe(2)
    expect(value.frameObjects, '帧对象映射须逐帧对应（装配命名约定）').toEqual([
      'structure:frame-0',
      'structure:frame-1',
    ])
    const f0 = faceOf(value as never, 0)
    const f1 = faceOf(value as never, 1)
    expect(f0.reason, '帧 0 必须给得出定义面').toBeNull()
    expect(f1.reason, '帧 1 必须给得出定义面').toBeNull()
    expect(f0.face?.objectId, '帧 0 的对象 id 必须是装配面第 0 项').toBe(value.frameObjects[0])
    expect(f1.face?.objectId, '帧 1 的对象 id 必须是装配面第 1 项').toBe(value.frameObjects[1])
    // **本条是核心**：下标真的被用上了（不是常数、不是永远第 0 帧）。
    expect(
      JSON.stringify(f1.face?.definition.blockPalette),
      '两帧的定义面必须不同（否则"帧下标"没接进去）',
    ).not.toBe(JSON.stringify(f0.face?.definition.blockPalette))
    // **负对照**：越界下标必须红（证明上面的"不同"不是"随便给一份都行"）。
    expect(faceOf(value as never, 2).face, '**负对照**：越界下标不得给出定义面').toBeNull()
    expect(faceOf(value as never, 2).reason, '越界的 reason 必须是 frame-out-of-range').toBe(
      'frame-out-of-range',
    )
  })

  it('⑤ 负对照判红：去掉供源 / 悬空 id ⇒ face 为 null 且 reason 可判别', async () => {
    const { value } = await assembleFixture('multiblock-ebf-2ch')
    const positive = (frameObjects: readonly string[], frameIndex: number): boolean => {
      const r = kernelDefinitionFaceOf({
        scene: value.scene,
        content: value.content,
        frameObjects,
        frameIndex,
      })
      return r.face !== null && (r.face.definition.blockPalette ?? []).length > 0
    }
    // 正：有供源时该谓词为真（前提，否则下面的红无意义）。
    expect(positive(value.frameObjects, 0), '前提：有供源时正判据为真').toBe(true)
    // 负对照一：去掉供源。
    const noSupply = kernelDefinitionFaceOf({
      scene: value.scene,
      content: value.content,
      frameObjects: [],
      frameIndex: 0,
    })
    expect(noSupply.face, '**负对照**：没有供源 ⇒ 不得给出定义面').toBeNull()
    expect(noSupply.reason, '**负对照**：没有供源 ⇒ reason 必须是 frame-out-of-range').toBe(
      'frame-out-of-range',
    )
    expect(positive([], 0), '**负对照判红**：同一条正判据必须当场为假').toBe(false)
    // 负对照二：下标越界。
    expect(positive(value.frameObjects, value.frameObjects.length), '**负对照判红**：越界必须判假').toBe(false)
    // 负对照三：对象 id 不在场景里（供源存在但指向悬空）。
    const dangling = kernelDefinitionFaceOf({
      scene: value.scene,
      content: value.content,
      frameObjects: ['structure:does-not-exist'],
      frameIndex: 0,
    })
    expect(dangling.face, '**负对照**：悬空 id 不得给出定义面').toBeNull()
    expect(dangling.reason, '悬空 id 的 reason 必须是 object-missing').toBe('object-missing')
  })
})
