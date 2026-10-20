/**
 * **M5-1 ①：多方块通道取值的读面判据**（生产装配路径）。
 *
 * ## 这个文件证明什么（断点①的修复面）
 *
 * 用户裁决（2026-10-18）：多方块文档的「Frame」概念作废，由 Blender「Scene」语义取代 ——
 * **帧清单 = 变体配置集合（场景）**，与时间轴无关、**永不参与播放**；播放/动画是
 * 通用关键帧+插值系统，场景切换 ≠ 动画。
 *
 * 对应地，本文件钉住三件事：
 *
 * | # | 判据 | 防什么 |
 * |---|---|---|
 * | ① | 生产装配出的 `content.frameAxis` 对多方块文档**恒为空**，`frameCount()===0` | 防"432 个场景被 `stripTimeline` 的 0→1ms 归一化伪装成 432ms 动画"（断点①的帮凶） |
 * | ② | `channelValues()` 只投影手动层：初始为空表；手动写值逐字可见 | 防"轨道层压住手动值"（SPEC §3.7:109 静默成功却不可见） |
 * | ③ | **负对照**：若仍合成轨道，帧 k 的读面必为 `min + stepIndex_k` —— 实测不成立 | 防判据恒绿（必须能区分"修好"与"没修"） |
 *
 * 输入全部走**生产装配**（真夹具 → 生产解析器 → `adoptLoadedDocument`），
 * 不是手工拼一份带声明的载荷（AGENTS #301 D3 ⑦）。
 */

import { describe, expect, it } from 'vitest'
import { plainRootOf } from '@/adapters/plainRoot'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import type { FrameAxis } from '@/domain/content'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { KernelSession } from '@/runtime/kernelSession'

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

/** 判据需要的声明事实（**输入**；期望从这里独立算出）。 */
interface DeclReadFace {
  readonly id: string
  readonly channels: readonly { readonly key: string; readonly kind: string; readonly min: number; readonly max: number }[]
  /** 声明的**场景清单**（每项一个 `stepIndex`；来自生产装配面的格式投影）。 */
  readonly sceneSteps: readonly number[]
  readonly sizeChannel: string | null
}

interface Loaded {
  readonly name: string
  readonly session: KernelSession
  readonly doc: RuntimeDocument
  readonly decl: DeclReadFace
  /** 生产装配出的内核帧轴（多方块文档必须为空）。 */
  readonly frameAxis: FrameAxis
}

/**
 * 走**生产装配**装载一份真实夹具（真解析器 → `adoptLoadedDocument` → 会话）。
 *
 * `assembleKernelDocument` 只用来读装配产物的内容面（`adoptLoadedDocument` 只回布尔），
 * 与生产链同一次 `plainRootOf` 归一 —— G4 已就此裁定，本文件沿用同一手法。
 */
async function loadProduction(name: string): Promise<Loaded> {
  const raw = readJson(fixturePath(name)) as Record<string, unknown>
  const parsed = await productionRegistry().detectAndParse(raw)
  if (parsed.document === null) throw new Error(`夹具 ${name} 生产解析失败：${parsed.error}`)
  const layers = await readEnvelopeLayers(raw as never)
  const plainRoot = plainRootOf(layers.plain as Record<string, unknown>)
  const session = new KernelSession({ documentId: `m5-${name}`, contextId: 'm5-ctx', capabilities: [] })
  const adopted = adoptLoadedDocument({ kernel: session, log: NOOP_LOG }, parsed.document as never, plainRoot, name)
  if (!adopted) throw new Error(`夹具 ${name} 生产装配失败`)
  const assembled = assembleKernelDocument({ doc: parsed.document as never, plainRoot })
  if (!assembled.ok) throw new Error(`夹具 ${name} 装配核心失败`)
  const face = session.assemblyFaceOf()
  const mb = face?.multiblock as
    | {
        readonly id: string
        readonly declaration: {
          readonly channels: readonly { key: string; kind: string; min: number; max: number }[]
          readonly backbone: { readonly sizeChannel: string }
        }
        readonly scenes: readonly { readonly stepIndex: number }[]
      }
    | null
    | undefined
  if (mb === null || mb === undefined) throw new Error(`夹具 ${name} 的装配面没有多方块投影`)
  return {
    name,
    session,
    doc: parsed.document as never as RuntimeDocument,
    decl: {
      id: mb.id,
      channels: mb.declaration.channels,
      sceneSteps: mb.scenes.map((f) => f.stepIndex),
      sizeChannel: mb.declaration.backbone.sizeChannel === '' ? null : mb.declaration.backbone.sizeChannel,
    },
    frameAxis: assembled.value.content.frameAxis,
  }
}

/** 尺寸型通道的声明算术：`min + stepIndex`（旧轨道合成的取值 —— 只作为**负对照期望**）。 */
interface Counterfactual {
  readonly sizeKey: string
  readonly min: number
  readonly max: number
  readonly steps: readonly number[]
}

function counterfactualOf(loaded: Loaded): Counterfactual {
  const sizeKey = loaded.decl.sizeChannel
  expect(sizeKey, `${loaded.name}：骨架必须有尺寸型通道键（否则本判据空转）`).not.toBeNull()
  const ch = loaded.decl.channels.find((c) => c.key === sizeKey)
  expect(ch, `${loaded.name}：骨架尺寸型通道必须在 channels 里声明`).toBeDefined()
  expect(loaded.decl.sceneSteps.length, `${loaded.name}：夹具必须多场景（否则阶跃无区分力）`).toBeGreaterThan(1)
  const steps = loaded.decl.sceneSteps
  expect(
    new Set(steps).size,
    `${loaded.name}：场景清单的 stepIndex 必须至少两种取值（否则"阶跃"与"常数"不可辨）`,
  ).toBeGreaterThan(1)
  return { sizeKey: sizeKey!, min: ch!.min, max: ch!.max, steps }
}

/** 若轨道仍被合成，场景 k 的读面值（旧公式；负对照的期望）。 */
function synthesizedValueAt(c: Counterfactual, sceneIndex: number): number {
  const step = c.steps[sceneIndex]
  if (step === undefined) throw new Error(`场景下标 ${sceneIndex} 超出声明清单（${c.steps.length} 项）`)
  return c.min + step
}

describe('M5-1 ①：多方块场景清单不进时间轴（生产装配）', () => {
  it('生产装配出的 `content.frameAxis` 恒为空：场景不是帧、frameCount()===0', async () => {
    for (const name of ['multiblock-ebf-2ch', 'multiblock-tier-only']) {
      const loaded = await loadProduction(name)
      expect(
        loaded.frameAxis.frames.length,
        `${name}：多方块文档的帧轴必须为空（场景清单 ≠ 时间轴）`,
      ).toBe(0)
      expect(loaded.session.frameCount(), `${name}：内核帧数必须为 0（无可播放帧）`).toBe(0)
      expect(loaded.session.frameIndex(), `${name}：帧下标恒 0`).toBe(0)
      // 反空洞真：夹具确实声明了多场景（否则"空帧轴"可能只是夹具没帧）。
      expect(loaded.decl.sceneSteps.length, `${name}：夹具必须声明多场景`).toBeGreaterThan(1)
    }
  })

  it('播放/跳帧不改变通道读面：场景切换 ≠ 动画', async () => {
    const loaded = await loadProduction('multiblock-ebf-2ch')
    const c = counterfactualOf(loaded)
    loaded.session.setChannelValue(c.sizeKey, 4)
    const before = loaded.session.channelValues()[c.sizeKey]
    expect(before).toBe(4)
    loaded.session.setPlaying(true)
    loaded.session.frame(0.2)
    loaded.session.seekFrame(Math.min(5, c.steps.length - 1))
    loaded.session.setPlaying(false)
    expect(loaded.session.frameIndex(), '跳帧不得把场景清单当时间轴（帧下标仍 0）').toBe(0)
    expect(loaded.session.channelValues()[c.sizeKey], '时间推进不得改写手动值').toBe(before)
  })
})

describe('M5-1 ②：通道读面只投影手动层', () => {
  it('初始读面为空表（未设置 ≠ 伪造 0）；声明的 0 由面板按声明初值给出', async () => {
    const loaded = await loadProduction('multiblock-ebf-2ch')
    const c = counterfactualOf(loaded)
    expect(loaded.session.channelValues(), '未手动设置时读面不得凭空多出通道取值').toEqual({})
    expect(
      loaded.session.channelValues()[c.sizeKey],
      '尺寸型通道在初始时刻必须没有"轨道采样值"（断点①的本体）',
    ).toBeUndefined()
  })

  it('手动写通道值 ⇒ 读面逐字返回（手动值即有效值）', async () => {
    const loaded = await loadProduction('multiblock-ebf-2ch')
    const c = counterfactualOf(loaded)
    const manual = c.min + 1
    loaded.session.setChannelValue(c.sizeKey, manual)
    expect(loaded.session.channelValues()[c.sizeKey], '手动写入必须夺回读面（轨道层已不存在）').toBe(manual)
    // 非尺寸型通道同理（防止"只修了尺寸轴"）。
    const other = loaded.decl.channels.find((x) => x.key !== c.sizeKey)
    expect(other, '夹具必须有第二条通道（否则本判据空转）').toBeDefined()
    loaded.session.setChannelValue(other!.key, 2)
    expect(loaded.session.channelValues()[other!.key]).toBe(2)
    // 保留键同理。
    loaded.session.setTotalTier(2)
    loaded.session.setRunstateIndex(1)
    expect(loaded.session.totalTier()).toBe(2)
    expect(loaded.session.runstateIndex()).toBe(1)
  })

  it('**负对照**：若仍合成轨道，帧 k 必为 min + stepIndex_k —— 实测不成立', async () => {
    const loaded = await loadProduction('multiblock-ebf-2ch')
    const c = counterfactualOf(loaded)
    const sampled = [0, 1, Math.floor(c.steps.length / 2), c.steps.length - 1]
    const counterfactualValues = new Set(sampled.map((k) => synthesizedValueAt(c, k)))
    // 前提：旧公式在抽样上给出不止一种取值（否则"不相等"可能只是因为值恰好相同）。
    expect(counterfactualValues.size, '负对照前提：旧公式在抽样上必须给出可区分的变化').toBeGreaterThan(1)
    const observed: (number | undefined)[] = []
    for (const k of sampled) {
      loaded.session.seekFrame(k)
      const got = loaded.session.channelValues()[c.sizeKey]
      observed.push(got)
      expect(got, `场景 k=${k}：读面不得是旧轨道公式的 ${synthesizedValueAt(c, k)}`).not.toBe(
        synthesizedValueAt(c, k),
      )
    }
    expect(new Set(observed), '抽样上读面必须恒为"未设置"（同一个 undefined），而不是随场景变化').toEqual(
      new Set([undefined]),
    )
  })
})
