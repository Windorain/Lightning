/**
 * **G4（渲染链旧格式源终切 · S2 第一半）**：DRW 定义面的**内核侧直出承载体**判据。
 *
 * ## 本文件证的是什么
 *
 * 旧链路里"当帧定义"只能由**旧格式文档**解析出来：
 *
 * ```
 *  runtime/drwMeshPipeline.ts:304-320
 *    doc.serialize()                                  ← 有损中间层
 *    isWorldDocument(plain) && plain.frames.length>0  ← 单结构文档在此**永不解析出定义**
 *    resolveRenderBundle({document: plain}, idx)      ← 定义来自 frames[idx].structure
 * ```
 *
 * 现在承载在 `composition/kernelPresentationInputs#kernelDefinitionFaceOf`：
 * 定义来自**内核载荷**（`blockGrid`，同一份 `projectGridCells` 重建口径），
 * 帧下标 → 对象 id 由**装配面**显式给出。
 *
 * ## 判据的形状（缺一不可）
 *
 * 1. **直出是生产事实**：输入全部来自**生产解析 + 生产装配**
 *    （生产注册表 `detectAndParse` → `readEnvelopeLayers` → `plainRootOf` →
 *    `adoptLoadedDocument`／`assembleKernelDocument`），不是手搓载荷；
 * 2. **与旧 DRW 路径的定义面一致**（parity）：图标缓存真正吃的面
 *    （`blockPalette`）与 `resolveRenderBundle` 在同一下标给出的**逐项相同** ——
 *    否则"替代旧读取点"就是把画面改坏；
 * 3. **帧下标是有效的**：多帧文档逐帧给出定义，且**至少两帧不同**
 *    （证明它不是常数、也不是"永远取第一帧"）；
 * 4. **负对照判红**：去掉供源（`frameObjects: []`）或越界 ⇒ `face === null` 且
 *    `reason === 'frame-out-of-range'`，**同一条正判据当场为假**（有区分力）。
 */

import { describe, expect, it } from 'vitest'
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
import { resolveRenderBundle } from '@/render/data/bundleResolve'
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

/**
 * 走**生产装配**装载一份真实夹具。
 *
 * 两条装配路径都用同一次 `plainRootOf` 归一后的源根：
 *  - `adoptLoadedDocument`：生产链（会话侧装配面在这里置位）；
 *  - `assembleKernelDocument`：同一份装配核心，本判据用它取 `scene`/`content`/`frameObjects`
 *    （`adoptLoadedDocument` 只回布尔，而会话不暴露场景）。
 * 两者产出的 `frameObjects` 必须逐项相同 —— 下面 ① 组自检这一点，防止"判据装配面
 * 与生产装配面不是同一个"。
 */
async function assembleFixture(name: string) {
  const raw = readJson(fixturePath(name)) as Record<string, unknown>
  const parsed = await productionRegistry().detectAndParse(raw)
  if (parsed.document === null) throw new Error(`夹具 ${name} 解析失败`)
  const layers = await readEnvelopeLayers(raw as never)
  const plainRoot = plainRootOf(layers.plain as Record<string, unknown>)
  const session = new KernelSession({ documentId: `g4-${name}`, contextId: 'g4-ctx', capabilities: [] })
  const ok = adoptLoadedDocument({ kernel: session, log: NOOP_LOG }, parsed.document as never, plainRoot, name)
  if (!ok) throw new Error(`夹具 ${name} 生产装配失败`)
  const assembled = assembleKernelDocument({ doc: parsed.document as never, plainRoot })
  if (!assembled.ok) throw new Error(`夹具 ${name} 装配核心失败`)
  return {
    doc: parsed.document as never as RuntimeDocument,
    session,
    value: assembled.value,
  }
}

const FIXTURES = ['multiblock-ebf-2ch', 'multiblock-tier-only'] as const

describe('G4 · DRW 定义面内核直出（kernelDefinitionFaceOf）', () => {
  it('① 生产装配 ⇒ 定义面直出：对象 id 来自装配面，定义面来自内核载荷', async () => {
    for (const name of FIXTURES) {
      const { session, value } = await assembleFixture(name)
      // 前提自检：本判据用的装配面**就是**生产链装配出来的那一份。
      const face = session.assemblyFaceOf()
      expect(face, `${name}：生产装配必须置位装配面`).not.toBeNull()
      expect(
        face?.frameObjects,
        `${name}：判据的 frameObjects 必须与生产装配面逐项相同（否则比的是两个世界）`,
      ).toEqual([...value.frameObjects])
      expect(value.frameObjects.length, `${name}：夹具必须至少有帧对象（否则本组是空转）`).toBeGreaterThan(0)

      const got = kernelDefinitionFaceOf({
        scene: value.scene,
        content: value.content,
        frameObjects: value.frameObjects,
        frameIndex: 0,
      })
      expect(got.reason, `${name}：生产装配产物必须能直出定义面（reason=${got.reason}）`).toBeNull()
      const def = got.face?.definition
      expect(def, `${name}：定义面必须在场`).toBeDefined()
      expect(got.face?.objectId, `${name}：对象 id 必须是装配面给出的那一个`).toBe(value.frameObjects[0])
      // 面本身必须有内容（否则"非 null"没有意义）。
      expect(
        (def?.blockPalette ?? []).length,
        `${name}：定义面的 blockPalette 必须非空（图标缓存吃这一面）`,
      ).toBeGreaterThan(0)
      expect(
        Object.keys(def?.cellGrid ?? {}).length,
        `${name}：定义面的 cellGrid 必须非空`,
      ).toBeGreaterThan(0)
    }
  })

  it('② 与旧 DRW 路径 parity：图标缓存真正吃的那一面逐项相同', async () => {
    for (const name of FIXTURES) {
      const { doc, value } = await assembleFixture(name)
      const got = kernelDefinitionFaceOf({
        scene: value.scene,
        content: value.content,
        frameObjects: value.frameObjects,
        frameIndex: 0,
      })
      // 旧路径：drwMeshPipeline.ts:308-313 的同一调用形态（有损 serialize）。
      const legacy = resolveRenderBundle({ document: doc.serialize() }, 0)
      expect(
        legacy.definition.blockPalette,
        `${name}：前提——旧路径确实解析出了 blockPalette（否则 parity 无区分力）`,
      ).toBeDefined()
      expect(
        got.face?.definition.blockPalette,
        `${name}：直出定义面的 blockPalette 必须与旧 DRW 路径逐项相同`,
      ).toEqual(legacy.definition.blockPalette)
      expect(
        got.face?.definition.materialPalette,
        `${name}：直出定义面的 materialPalette 必须与旧 DRW 路径逐项相同`,
      ).toEqual(legacy.definition.materialPalette)
    }
  })

  it('③ 帧下标有效：逐帧给出定义，且至少两帧不同（不是常数、不是永远第一帧）', async () => {
    const { value } = await assembleFixture('multiblock-ebf-2ch')
    expect(value.frameObjects.length, '前提：该夹具必须多帧（否则本组无区分力）').toBeGreaterThan(1)
    const faces = value.frameObjects.map((_, i) =>
      kernelDefinitionFaceOf({
        scene: value.scene,
        content: value.content,
        frameObjects: value.frameObjects,
        frameIndex: i,
      }),
    )
    for (const [i, f] of faces.entries()) {
      expect(f.reason, `帧 ${i} 必须能直出定义面`).toBeNull()
      expect(f.face?.objectId, `帧 ${i} 的对象 id 必须与装配面逐帧对应`).toBe(value.frameObjects[i])
    }
    const distinct = new Set(faces.map((f) => JSON.stringify(f.face?.definition.blockPalette)))
    expect(distinct.size, '至少两帧的定义面必须不同（否则"帧下标"没被用上）').toBeGreaterThan(1)
  })

  it('④ 负对照判红：去掉供源 / 越界 ⇒ face 为 null 且 reason 可判别', async () => {
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
