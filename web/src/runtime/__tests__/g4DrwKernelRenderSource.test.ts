/**
 * **G4 · S2 第二半接线判据**：DRW 真的**吃**内核渲染源面（不是"面造出来了但没人用"）。
 *
 * ## 为什么必须单独有一条（本项目的假绿形态）
 *
 * `g4KernelRenderSourceFace.test.ts` 只证"面能由生产装配造出来"。**能被造出来 ≠ 被消费**
 * ——立项单明文："新承载字段的判据必须至少有一条走生产装配"，且"接线判据的输入必须来自
 * 生产解析 + 装配，并附负对照（去掉字段 ⇒ 回落，证明有区分力）"。
 *
 * ## 本文件的口径
 *
 * | 组 | 输入 | 断言 |
 * |---|---|---|
 * | ① | `docRef = null`（**旧源缺席**）+ 生产装配出的内核面 | `applyWorldFrame`/`loadStructureAndResources` 产出 `structureDefinition`（真信封的 62 条材质）与说明池 |
 * | ② 负对照 | 同一份输入，但 `renderSourceRef = null` | 什么都产不出来（`structureDefinition` 保持 `null`）⇒ ①的绿**不是恒绿** |
 * | ③ | 面的帧下标越界 | 保留上一次结果（**不**改成空定义、**不**回落旧文档） |
 *
 * 输入走 `detectAndParse` → `readEnvelopeLayers` → `plainRootOf` → `assembleKernelDocument`
 * （与产品同一条装配），不是手工载荷。
 */
import { describe, expect, it } from 'vitest'
import { ref, shallowRef } from 'vue'
import fs from 'node:fs'
import path from 'node:path'
import { plainRootOf } from '@/adapters/plainRoot'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { kernelRenderSourceFaceOf } from '@/composition/kernelPresentationInputs'
import { createDrwMeshPipeline } from '@/runtime/drwMeshPipeline'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import type { LoadStatus } from '@/runtime/types'

function productionRegistry() {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

/** 真信封 → 生产装配 → 内核渲染源面（与产品同一条装配链）。 */
async function envelopeFace() {
  const p = path.join(process.cwd(), 'e2e', 'fixtures', 'structuredata-exported-envelope.json')
  const raw = JSON.parse(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')) as Record<string, unknown>
  const parsed = await productionRegistry().detectAndParse(raw)
  if (parsed.document === null) throw new Error('信封解析失败')
  const plainRoot = plainRootOf(
    (await readEnvelopeLayers(raw as never)).plain as Record<string, unknown>,
  )
  const assembled = assembleKernelDocument({ doc: parsed.document as never, plainRoot })
  if (!assembled.ok) throw new Error('信封装配失败')
  return kernelRenderSourceFaceOf({
    scene: assembled.value.scene,
    content: assembled.value.content,
    frameObjects: assembled.value.frameObjects,
  })
}

function makePipeline(input: {
  face: ReturnType<typeof kernelRenderSourceFaceOf> | null
}) {
  const structureDefinition = shallowRef<never | null>(null)
  const tooltipPalette = shallowRef<string[]>([])
  const loadStatus = ref<LoadStatus>('idle')
  const pipeline = createDrwMeshPipeline({
    // **旧源缺席**：本判据要证"只有内核面也够"。
    docRef: ref(null),
    renderSourceRef: ref(input.face),
    loadStatus,
    blockIconCache: shallowRef(null),
    tooltipPalette,
    structureDefinition: structureDefinition as never,
    sceneRef: shallowRef(null),
    worldFrameIndex: () => 0,
    layerWorldY: ref(0),
    blockIconCacheOptions: {},
    contentRefreshTickRef: ref(0),
  })
  return { pipeline, structureDefinition, tooltipPalette, loadStatus }
}

describe('G4 · S2 第二半接线：DRW 消费内核渲染源面（旧格式源缺席）', () => {
  it('① 旧源缺席 + 内核面在场 ⇒ 定义面/说明池由内核产出', async () => {
    const face = await envelopeFace()
    const h = makePipeline({ face })
    await h.pipeline.loadStructureAndResources()
    expect(h.loadStatus.value, '装载必须成功（否则下面的断言是空转）').toBe('ok')
    const def = h.structureDefinition.value as unknown as {
      materialPalette: readonly unknown[]
      cellGrid: unknown[]
    }
    expect(def, '内核面必须产出结构定义（旧源缺席也不例外）').not.toBeNull()
    expect(def.materialPalette.length, '真信封 62 条材质').toBe(62)
    expect(h.tooltipPalette.value.length, '说明池由逐格 tooltip 重聚').toBeGreaterThan(0)

    // 换帧路径同样吃内核面（帧为主文档此前在旧路径上**永不**解析出定义 —— 见 kernelDefinitionFaceOf 的文件头）。
    const h2 = makePipeline({ face })
    await h2.pipeline.applyWorldFrame(0)
    expect(
      (h2.structureDefinition.value as unknown as { materialPalette: readonly unknown[] } | null)
        ?.materialPalette.length,
      'applyWorldFrame 也走内核面',
    ).toBe(62)
  })

  it('② 负对照：去掉内核面（同一份输入）⇒ 什么都产不出来（证明①有区分力）', async () => {
    const h = makePipeline({ face: null })
    await h.pipeline.applyWorldFrame(0)
    expect(h.structureDefinition.value, '没有面、也没有旧源 ⇒ 定义面必须仍为 null').toBeNull()
    expect(h.tooltipPalette.value, '说明池必须仍为空').toEqual([])
    // 装载路径：无源 ⇒ 如实 `error`（不静默 `ok`）。
    await h.pipeline.loadStructureAndResources()
    expect(h.loadStatus.value, '装载路径无源 ⇒ 如实 error').toBe('error')
  })

  it('③ 帧下标越界 ⇒ 保留上一次结果（不改成空定义、不回落旧文档）', async () => {
    const face = await envelopeFace()
    const h = makePipeline({ face })
    await h.pipeline.applyWorldFrame(0)
    const before = h.structureDefinition.value
    expect(before).not.toBeNull()
    await h.pipeline.applyWorldFrame(99)
    expect(h.structureDefinition.value, '越界不得把定义清空').toBe(before)
  })
})
