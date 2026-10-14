/**
 * **G6 ②/③：离散通道的「时间入口」判据**（A09「四类可动画属性在给定时间求值」的通道面）。
 *
 * ## 这个文件证明什么（以及它防的三类假绿）
 *
 * G6 ① 把播放时间经**既有纯采样器**接进通道取值（`channelStepTrack` →
 * `resolveChannelEffective`，零新增 tick）。本文件给那条接线加判据，三条防线：
 *
 * | 防线 | 判据 | 防什么 |
 * |---|---|---|
 * | 生产装配 | 输入来自**真夹具 → 生产解析器 → `adoptLoadedDocument` 真装配** | 防"手工拼一份带声明的载荷"（AGENTS #301 D3 ⑦：纯函数判据喂已带字段的载荷会恒绿，而生产装配可能从不填该字段） |
 * | 独立期望 | 期望值来自**声明本身**（`min + frame.stepIndex`，契约 §5.4），不是被测量的实现 | 防"把自我实现当期望来源" |
 * | 区分力 | 同一判据函数在**三条负对照**上必须判红 | 防恒绿判据（"跑一遍没抛错"不算判据） |
 *
 * ## 期望为什么是 `min + stepIndex`（不是从会话里读出来的数）
 *
 * 契约 §5.4 明文「尺寸型由 `frame.stepIndex` 完成」；解析器另有一条可执行判据
 * `sizeSteps.length === 通道 max − min + 1`（`context/parsers/multiblockDocument.ts:739`）
 * ⇒ 阶与取值一一对应，`min + stepIndex` 是**双射**。本文件把这条声明算术**在测试里
 * 独立算一遍**，再去和会话读面比 —— 而不是把会话的输出当期望。
 *
 * ## 时间源
 *
 * 只用生产入口：`setPlaying` / `frame(经过秒数)`（内核按帧注入，宿主不自己改状态）与
 * `seekFrame` / `seekTime`。测试**不持有**任何 tick，也不读墙钟。
 */

import { describe, expect, it } from 'vitest'
import { plainRootOf } from '@/adapters/plainRoot'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import { resolveEffectiveValue, type EffectiveValueLayer } from '@/domain/animation'
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

/** 装配面里与本判据有关的那部分（**输入**；期望从这里独立算出）。 */
interface DeclReadFace {
  readonly id: string
  readonly channels: readonly { readonly key: string; readonly kind: string; readonly min: number; readonly max: number }[]
  readonly frames: readonly { readonly stepIndex: number }[]
  readonly sizeChannel: string | null
}

interface Loaded {
  readonly name: string
  readonly session: KernelSession
  readonly doc: RuntimeDocument
  /** 装配面（生产唯一载体）；本判据用它当**期望来源**。 */
  readonly decl: DeclReadFace
  /** 账：`DocumentContent.multiblock.channels.length`（生产当前为 0，见"账 b3"）。 */
  readonly contentMultiblockChannels: number
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
  const session = new KernelSession({ documentId: `g6-${name}`, contextId: 'g6-ctx', capabilities: [] })
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
        readonly frames: readonly { readonly stepIndex: number }[]
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
      frames: mb.frames,
      sizeChannel: mb.declaration.backbone.sizeChannel === '' ? null : mb.declaration.backbone.sizeChannel,
    },
    contentMultiblockChannels: assembled.value.content.multiblock.channels.length,
  }
}

/** 期望（从**声明**独立算出）：尺寸型通道的值 = `min + stepIndex`（契约 §5.4 双射）。 */
interface Expectation {
  readonly sizeKey: string
  readonly min: number
  readonly max: number
  readonly steps: readonly number[]
}

function expectationOf(loaded: Loaded): Expectation {
  const sizeKey = loaded.decl.sizeChannel
  expect(sizeKey, `${loaded.name}：骨架必须有尺寸型通道键（否则本判据空转）`).not.toBeNull()
  const ch = loaded.decl.channels.find((c) => c.key === sizeKey)
  expect(ch, `${loaded.name}：骨架尺寸型通道必须在 channels 里声明（否则"时间入口"不存在）`).toBeDefined()
  expect(loaded.decl.frames.length, `${loaded.name}：夹具必须多帧（否则阶跃无区分力）`).toBeGreaterThan(1)
  const steps = loaded.decl.frames.map((f) => f.stepIndex)
  expect(
    new Set(steps).size,
    `${loaded.name}：夹具的 stepIndex 必须至少两种取值（否则"阶跃"与"常数"不可辨）`,
  ).toBeGreaterThan(1)
  return { sizeKey: sizeKey!, min: ch!.min, max: ch!.max, steps }
}

/** 判据核心：`channelValues()[sizeKey]` 在给定会话/时刻下应当是什么（声明算术）。 */
function expectedValueAt(exp: Expectation, frameIndex: number): number {
  const step = exp.steps[frameIndex]
  if (step === undefined) throw new Error(`帧下标 ${frameIndex} 超出声明的帧清单（${exp.steps.length} 帧）`)
  return exp.min + step
}

/**
 * **正向不变式**（同一函数服务正向判据与负对照 ⇒ 负对照能证明它有区分力）。
 *
 * 沿生产时间源推进 60 次（0.025 s/次 ⇒ 1.5 s，对这些夹具的周期是多圈），每次检查：
 *
 * 1. `channelValues()[sizeKey] === min + steps[frameIndex()]`（**同轴**：帧读面与通道读面
 *    必须指同一帧；这也是"取模两处同式"的钉合点，见"账 b2"）；
 * 2. 同一个帧下标在**多圈里每次被读到都必须给同一个值**（相位等价）；
 * 3. 观测到的取值序列**不是常数**（否则"时间入口没驱动取值"，判据必须有区分力）。
 *
 * 返回违例清单；空数组 = 绿。**不抛异常**，以便负对照断言"它确实非空"。
 */
function timeEntryViolations(session: KernelSession, exp: Expectation): string[] {
  const violations: string[] = []
  const valueByFrame = new Map<number, number>()
  const observed = new Set<number>()
  let wrapped = 0
  let previous = session.frameIndex()
  session.setPlaying(true)
  for (let i = 0; i < 60; i++) {
    session.frame(0.025)
    const frameIndex = session.frameIndex()
    if (frameIndex < previous) wrapped += 1
    previous = frameIndex
    const expected = expectedValueAt(exp, frameIndex)
    const got = session.channelValues()[exp.sizeKey]
    if (got === undefined) {
      violations.push(`步 ${i}：帧下标 ${frameIndex} 时读面没有 ${exp.sizeKey}（期望 ${expected}）`)
      continue
    }
    observed.add(got)
    if (got !== expected) violations.push(`步 ${i}：帧下标 ${frameIndex} 期望 ${expected}，读面 ${got}`)
    const seen = valueByFrame.get(frameIndex)
    if (seen !== undefined && seen !== got) {
      violations.push(`帧下标 ${frameIndex} 两圈取值不同（${seen} vs ${got}）：相位不等价`)
    }
    valueByFrame.set(frameIndex, got)
  }
  if (observed.size < 2) violations.push(`60 次时间推进里通道取值只有 ${observed.size} 种：时间入口未驱动取值`)
  if (wrapped < 2) violations.push(`60 次推进只回卷 ${wrapped} 次：未覆盖多圈相位（判据覆盖不足）`)
  return violations
}

// ─────────────────────────────────────────────────────────────────────────────
// ② 正向判据（生产装配 + 生产时间源 + 独立期望）
// ─────────────────────────────────────────────────────────────────────────────

describe('G6 ②：离散通道的时间入口（生产装配路径）', () => {
  it('正向：播放推进 ⇒ 通道取值按 min + stepIndex 阶跃，且与帧读面同轴（多圈相位等价）', async () => {
    const loaded = await loadProduction('multiblock-ebf-2ch')
    const exp = expectationOf(loaded)
    // 前提（不是断言对象，但缺了它结论无意义）：装配面确实带了多帧声明与实通道。
    expect(loaded.decl.channels.length, 'ebf 夹具必须声明通道').toBeGreaterThan(0)
    expect(loaded.decl.frames.length, 'ebf 夹具必须多帧').toBeGreaterThan(1)
    expect(timeEntryViolations(loaded.session, exp), '正向判据必须全绿').toEqual([])
  })

  it('正向（跳帧）：seekFrame(k) ⇒ 取值就是该帧读面所在帧声明的 min + stepIndex_k', async () => {
    const loaded = await loadProduction('multiblock-ebf-2ch')
    const exp = expectationOf(loaded)
    const sampled = [0, 1, 2, 3, Math.floor(exp.steps.length / 2)]
    const values: number[] = []
    for (const k of sampled) {
      loaded.session.seekFrame(k)
      expect(loaded.session.frameIndex(), `seekFrame(${k}) 后帧读面必须就是 ${k}`).toBe(k)
      const got = loaded.session.channelValues()[exp.sizeKey]
      expect(got, `seekFrame(${k})：期望 ${expectedValueAt(exp, k)}`).toBe(expectedValueAt(exp, k))
      values.push(got!)
    }
    // 末帧是**既有浮点边界**的现场（与本批无关，见本用例末尾说明）：
    // `seekFrame(n-1)` 走 `ms→秒→time.frame→再除回秒` 的两次换算，`floor` 在此丢 1 帧。
    // 判据只断言**同轴不变式**（通道取值 = 该帧读面所在帧的声明值），不掩盖它也不依赖它。
    const last = exp.steps.length - 1
    loaded.session.seekFrame(last)
    const lastFrame = loaded.session.frameIndex()
    expect(lastFrame, '既有边界：末帧定位的帧读面允许早一帧（浮点 floor）').toBeGreaterThanOrEqual(last - 1)
    expect(lastFrame).toBeLessThanOrEqual(last)
    expect(
      loaded.session.channelValues()[exp.sizeKey],
      '同轴不变式：取值必须等于帧读面所在帧的声明值（不因边界 artifact 而错帧）',
    ).toBe(expectedValueAt(exp, lastFrame))
    // 同一 stepIndex 的两帧必须给同一取值（阶跃，不是逐帧漂移）。
    // 抽样口径：每个 stepIndex 取**前两个**帧下标（全配对是 432² 次定位，判据不必那么贵）。
    const framesByStep = new Map<number, number[]>()
    exp.steps.forEach((step, frame) => {
      const list = framesByStep.get(step) ?? []
      if (list.length < 2) list.push(frame)
      framesByStep.set(step, list)
    })
    const pairable = [...framesByStep.values()].filter((list) => list.length === 2)
    expect(pairable.length, '夹具必须有至少一个 stepIndex 出现 ≥2 次（否则"同阶同值"不可判）').toBeGreaterThan(0)
    for (const [a, b] of pairable) {
      loaded.session.seekFrame(a!)
      const va = loaded.session.channelValues()[exp.sizeKey]
      loaded.session.seekFrame(b!)
      const vb = loaded.session.channelValues()[exp.sizeKey]
      expect(va, `stepIndex 相同的帧 ${String(a)}/${String(b)} 必须同值（阶跃）`).toBe(vb)
    }
    expect(new Set(values).size, '抽样的帧必须给出不止一种取值（否则判据无区分力）').toBeGreaterThan(1)
  })

  it('正向（阶跃语义）：帧内任意时刻同值，边界取下一帧（半开区间）', async () => {
    const loaded = await loadProduction('multiblock-ebf-2ch')
    const exp = expectationOf(loaded)
    // 找到一个"相邻两帧 stepIndex 不同"的位置，才有边界可判。
    let boundary = -1
    for (let i = 1; i < exp.steps.length; i += 1) {
      if (exp.steps[i] !== exp.steps[i - 1]) {
        boundary = i
        break
      }
    }
    expect(boundary, '夹具里必须存在 stepIndex 变化的相邻帧（否则边界无区分力）').toBeGreaterThan(0)
    loaded.session.seekFrame(boundary)
    const atStart = loaded.session.channelValues()[exp.sizeKey]
    expect(atStart, '帧起点（边界）必须取**下一帧**的值').toBe(expectedValueAt(exp, boundary))
    expect(atStart, '边界两侧必须真的不同（否则该点不是阶跃边界）').not.toBe(expectedValueAt(exp, boundary - 1))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ② 负对照（三条；同一判据函数必须判红）
// ─────────────────────────────────────────────────────────────────────────────

describe('G6 ② 负对照：去掉时间入口 / 换静态来源 ⇒ 同一判据必须判红', () => {
  it('负对照 a1：手工绑定帧轴但**不采纳声明**（只有手动层）⇒ 时间推进不改通道取值', () => {
    const session = new KernelSession({ documentId: 'g6-neg-a1', contextId: 'g6-neg-a1-ctx', capabilities: [] })
    const durations = Array.from({ length: 40 }, () => 25)
    session.bindFrameSource({ count: () => durations.length, durationsMs: () => durations })
    session.setChannelValue('height', 3)
    const exp: Expectation = { sizeKey: 'height', min: 1, max: 5, steps: durations.map((_, i) => i % 5) }
    expect(session.channelValues()['height'], '前提：手动层必须读得到').toBe(3)
    expect(
      timeEntryViolations(session, exp).length,
      '去掉声明（时间入口的唯一载体）后，正向判据必须判红 —— 否则它测的不是时间入口',
    ).toBeGreaterThan(0)
  })

  it('负对照 a2：生产装载后 `markUnloaded()` 清掉载体 ⇒ 时间推进不再改通道取值', async () => {
    const loaded = await loadProduction('multiblock-ebf-2ch')
    const exp = expectationOf(loaded)
    expect(timeEntryViolations(loaded.session, exp), '前提：装载后正向判据必须先是绿的').toEqual([])
    loaded.session.markUnloaded()
    expect(
      timeEntryViolations(loaded.session, exp).length,
      '卸载清掉声明后必须判红：证明取值由**时间入口**驱动，而不是"帧轴自己动的"',
    ).toBeGreaterThan(0)
  })

  it('负对照 a3：真实夹具 multiblock-tier-only（`sizeChannel=totalTier` 非声明通道）⇒ 无时间入口 ⇒ 判红', async () => {
    const loaded = await loadProduction('multiblock-tier-only')
    // 该夹具的骨架通道是保留键 totalTier，**不在** channels 里 ⇒ 求值半查不到通道
    // ⇒ 如实没有时间入口（不伪造一个"总档位轨道"）。
    expect(loaded.decl.sizeChannel, 'tier-only 的骨架通道必须是保留键 totalTier').toBe('totalTier')
    expect(
      loaded.decl.channels.some((c) => c.key === 'totalTier'),
      '前提：totalTier 不是声明通道（否则本负对照与 a1 重复）',
    ).toBe(false)
    const exp: Expectation = {
      sizeKey: 'structTier',
      min: 1,
      max: 3,
      steps: loaded.decl.frames.map((f) => f.stepIndex),
    }
    expect(
      timeEntryViolations(loaded.session, exp).length,
      '未声明的骨架通道必须没有时间入口（判红 = 如实回落，而不是猜一条轨道）',
    ).toBeGreaterThan(0)
    expect(loaded.session.channelValues(), '无时间入口时读面不得凭空多出通道取值').toEqual({})
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ 优先级 / 覆盖（只有一个定义点）
// ─────────────────────────────────────────────────────────────────────────────

describe('G6 ③：时间驱动值与手动层的优先级只有一处定义点', () => {
  it('③a：轨道层高于手动层，且会话的裁决与 `resolveEffectiveValue` 的层表逐点一致', async () => {
    const loaded = await loadProduction('multiblock-ebf-2ch')
    const exp = expectationOf(loaded)
    loaded.session.seekFrame(0)
    const trackValue = loaded.session.channelValues()[exp.sizeKey]
    expect(trackValue, '前提：第 0 帧有轨道采样值').toBe(expectedValueAt(exp, 0))
    // 手动写一个**不同于**轨道值的合法值（域内取另一个成员）。
    const span = exp.max - exp.min + 1
    const manual = exp.min + ((exp.steps[0]! + 1) % span)
    expect(manual, '前提：手动值必须与轨道值不同（否则本判据无区分力）').not.toBe(trackValue)
    loaded.session.setChannelValue(exp.sizeKey, manual)
    const afterManual = loaded.session.channelValues()[exp.sizeKey]
    expect(afterManual, '有轨道时手动写入不得夺走读面（trackSample > manualPreview）').toBe(trackValue)
    // 同一裁决必须**等于**纯层表的结果（会话不得自带第二套优先级）。
    const pureLayers: EffectiveValueLayer[] = [
      { kind: 'manualPreview', value: manual },
      { kind: 'trackSample', value: trackValue! },
    ]
    const pure = resolveEffectiveValue(pureLayers)
    expect(pure.ok, '层表必须能裁决这两层').toBe(true)
    if (pure.ok) expect(afterManual, '会话的裁决必须与层表逐点一致').toBe(pure.value.value)
  })

  it('③b：不反写 —— 清掉时间入口后手动值原样仍在（手动层未被赢家覆盖）', async () => {
    const loaded = await loadProduction('multiblock-ebf-2ch')
    const exp = expectationOf(loaded)
    loaded.session.seekFrame(0)
    const manual = exp.min + 1
    expect(manual, '前提：手动值必须与第 0 帧的轨道值不同').not.toBe(expectedValueAt(exp, 0))
    loaded.session.setChannelValue(exp.sizeKey, manual)
    expect(loaded.session.channelValues()[exp.sizeKey], '前提：轨道层仍然赢').toBe(expectedValueAt(exp, 0))
    loaded.session.markUnloaded()
    expect(
      loaded.session.channelValues()[exp.sizeKey],
      '清掉时间入口后读面必须**逐字**给出当初手动写的值 ⇒ 赢家没有反写手动层',
    ).toBe(manual)
  })

  it('③c：无时间入口时手动层即读面（同一判据在另一半上也成立）', async () => {
    const loaded = await loadProduction('multiblock-tier-only')
    loaded.session.setChannelValue('structTier', 2)
    expect(loaded.session.channelValues()['structTier']).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ② 负对照 b：把 ① 的余项变成**判据看到的可见事实**（机械记账，不靠注释）
// ─────────────────────────────────────────────────────────────────────────────

describe('G6 ② 负对照 b：余项机械记账', () => {
  it('账 b1：保留键 `$totalTier`/`$runstate` 仍**没有**时间入口（只有手动层）', async () => {
    const loaded = await loadProduction('multiblock-ebf-2ch')
    const exp = expectationOf(loaded)
    // 时间轴推进**不**碰保留键：读面里除尺寸型通道外不得多出任何键。
    loaded.session.setPlaying(true)
    loaded.session.frame(0.2)
    const keys = Object.keys(loaded.session.channelValues()).sort()
    expect(keys, '时间入口只驱动声明的尺寸型通道；保留键必须仍不可见（无入口）').toEqual([exp.sizeKey])
    // 手动写保留键后，**时间推进不得改写它**（没有轨道 = 没有覆盖）。
    loaded.session.setTotalTier(1)
    loaded.session.setRunstateIndex(0)
    const before = { tier: loaded.session.totalTier(), run: loaded.session.runstateIndex() }
    for (let i = 0; i < 12; i += 1) loaded.session.frame(0.05)
    expect(
      { tier: loaded.session.totalTier(), run: loaded.session.runstateIndex() },
      '保留键仍只有手动层：时间推进不得改写它们（若将来接上时间入口，本行必须**显式**改判）',
    ).toEqual(before)
    // 尺寸型通道同时仍在随时间走 ⇒ 证明"没被改写"不是因为时间轴整个停了。
    const frameIndex = loaded.session.frameIndex()
    expect(loaded.session.channelValues()[exp.sizeKey]).toBe(expectedValueAt(exp, frameIndex))
  })

  it('账 b2：取模在两处同式 ⇒ 用"帧读面 ≡ 通道读面"把两处钉在一起（多圈）', async () => {
    const loaded = await loadProduction('multiblock-ebf-2ch')
    const exp = expectationOf(loaded)
    // `domain/materials#sampleStripFrameAt` 内部取模（帧读面）与
    // `KernelSession#channelSampleTime` 的折返（通道读面）是**两处**同式表达。
    // 本判据不给"两处都在"，而是给**更强的不变式**：同一相位在多圈上必须得到
    // 同一个 `(帧下标, 通道取值)` 对。任一处改了取模口径（或新增第三处解释），本行判红。
    //
    // 一圈的长度**从生产时间源观测**（`seekFrame(0)` 与 `seekFrame(1)` 的时间差 = 一帧的
    // 时间值），不在这里复刻 `stripTimeline` 的毫秒归一化 —— 否则判据自带第二套轴换算。
    loaded.session.seekFrame(0)
    const t0 = loaded.session.playback().time
    loaded.session.seekFrame(1)
    const t1 = loaded.session.playback().time
    const framesPerFrame = t1.frame - t0.frame
    expect(framesPerFrame, '观测到的一帧时间值必须为正（否则无法构造多圈时刻）').toBeGreaterThan(0)
    const periodFrames = exp.steps.length * framesPerFrame
    for (const k of [0, 1, 7, Math.floor(exp.steps.length / 3), exp.steps.length - 1]) {
      const observations: string[] = []
      for (const loop of [0, 1, 2]) {
        // 取该帧的**帧中**（不是帧起点）：帧中远离边界，浮点 floor 不会在两圈之间跳帧，
        // 于是"同一相位"这件事可以被逐字比较。
        const at = (k + 0.5) * framesPerFrame + loop * periodFrames
        loaded.session.seekTime({ frame: at, fps: t0.fps })
        const frameIndex = loaded.session.frameIndex()
        const got = loaded.session.channelValues()[exp.sizeKey]
        observations.push(`${frameIndex}:${String(got)}`)
      }
      expect(
        new Set(observations).size,
        `帧 ${k} 在三圈上必须给出同一个 (帧下标, 取值)；实测 ${observations.join(' / ')}`,
      ).toBe(1)
      expect(
        observations[0],
        `且它必须精确等于声明算术：帧 ${k} ⇒ ${k}:${expectedValueAt(exp, k)}（实测 ${observations[0]}）`,
      ).toBe(`${k}:${expectedValueAt(exp, k)}`)
    }
  })

  it('账 b3：生产装配今天**不填** `DocumentContent.multiblock`（声明走装配面）', async () => {
    const loaded = await loadProduction('multiblock-ebf-2ch')
    // ⚠️ 这是一条**缺口记账**（不是"应当如此"的设计断言）：
    // `composition/kernelAssembly.ts:1739-1743` 组装 content 时只给 metadata/frameAxis/resources，
    // 故 `content.multiblock` 恒为空声明，而声明（channels/frames/stepIndex）在装配面上。
    // G6 ① 的时间入口因此以**装配面**为载体（`KernelSession#rebindChannelTimeSource` 的唯一选择点）。
    // 一旦 C 区把声明补进 content（R2 正在动 `domain/content.ts`），本行会判红 ⇒
    // 那是**故意的 fail-loud**：届时必须显式重审载体优先级，而不是让两个载体静默并存。
    expect(
      loaded.contentMultiblockChannels,
      '账：生产 content.multiblock 仍为空（声明只在装配面）——若此处变红，说明载体已补齐，请重审优先级',
    ).toBe(0)
    expect(
      loaded.decl.channels.length,
      '账的另一半：装配面**确实**带着声明（否则 ① 的时间入口在生产里无从可达）',
    ).toBeGreaterThan(0)
  })
})
