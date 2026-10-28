/**
 * 「通道」面板的纯逻辑 + **渲染路径确实吃装配产物**。
 *
 * 关键命题（硬约束）：多方块文档的 `frame.grid` 恒为 `null`，
 * 故"当前取值 → 装配 → 当前帧网格"必须让**渲染解析路径**（`doc.serialize()` → `resolveRenderBundle`）
 * 拿到装配出的网格。这里不 mock 渲染层，直接走真实 `bundleResolve`，
 * 并把解析出的 `definition.cellGrid` 与**唯一求值点**的装配产物逐格比对
 * （按方块签名，调色板编号重排不影响判定）。
 *
 * ## 旧文档装配簇已退役（判据改为生产链 + 冻结期望）
 *
 * 旧入口 `assembleForSelection` / `buildMultiblockRenderView` / `buildChannelPanelModel`
 * （形参都是旧格式 `RuntimeDocument`）已删除。本文件改为**生产链**：
 *
 * ```
 * fixture 原文 → 生产解析 → 生产装载（adoptLoadedDocument，真 Context + 真 KernelSession）
 *   → Context#kernelMultiblockEvaluation（唯一求值点 evaluateMultiblockPresentation）
 *   → Context#kernelRenderViewInputs + kernelRenderViewFromFace（内核面渲染视图）
 *   → resolveRenderBundle → 逐格签名
 * ```
 *
 * 期望值不再来自旧入口的返回值，而是**测试内冻结常量**（变体键 / 尺寸 / 提示文案 / 单调性）；
 * 面板模型由 `productionPanelModelOf`（与 `useKernelChannels#panel` 同一派生）给出。
 *
 * fixture：`./fixtures/multiblock-{ebf-2ch,tier-only}.json`（内容勿改）+ 帧为主回归样例 `e2e/fixtures/minimal-v2.json`
 */
import { describe, expect, it } from 'vitest'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { isWorldDocument, resolveRenderBundle } from '@/render/data/bundleResolve'
import {
  channelSliderSpecs,
  clampChannelValue,
  formatChannelValue,
  initialMultiblockSelection,
  snapTierToSample,
  tierSampleValues,
  type MultiblockSelectionState,
} from '@/shared/viewport/multiblockChannelUi'
import { availableDockTabs, defaultDockTab, resolveDockTab } from '@/shared/viewport/dockTabs'
import { kernelRenderViewFromFace } from '@/composition/kernelRenderView'
import { plainRootOf } from '@/adapters/plainRoot'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import {
  makeAdoptedKernelReadHost,
  productionPanelModelOf,
  type KernelReadHost,
} from '@/runtime/__tests__/kernelReadTestHost'

import ebfFixture from './fixtures/multiblock-ebf-2ch.json'
import tierOnlyFixture from './fixtures/multiblock-tier-only.json'
import lscOverlapFixture from './fixtures/multiblock-lsc-overlap.json'
import minimalV2 from '../../../e2e/fixtures/minimal-v2.json'

type Json = Record<string, unknown>

/** 与 host 一致的注册顺序（Multiblock 由 createParserRegistry 预置表头）。 */
function productionRegistry() {
  const registry = createParserRegistry()
  registry.register(V2PlainParser)
  registry.register(createEnvelopeParser(registry))
  registry.register(WorldParser)
  registry.register(StructureDataParser)
  return registry
}

async function parse(raw: unknown): Promise<RuntimeDocument> {
  const res = await productionRegistry().detectAndParse(raw)
  if (!res.document) throw new Error(`fixture 解析失败：${res.error}`)
  return res.document
}

/** 生产链宿主：fixture 原文 → 生产解析 → 生产装载（真 Context + 真 KernelSession）。 */
async function makeHost(raw: unknown): Promise<KernelReadHost> {
  const parsed = await productionRegistry().detectAndParse(raw)
  if (!parsed.document) throw new Error('fixture 解析失败')
  // 夹具有两种形态：信封（`payloadEncoding` 在场）与裸 plain（帧为主回归样例）。
  const isEnvelope = typeof (raw as Json).payloadEncoding === 'string'
  const plain = isEnvelope
    ? ((await readEnvelopeLayers(raw as never)).plain as Record<string, unknown>)
    : (raw as Record<string, unknown>)
  return makeAdoptedKernelReadHost(parsed.document as never, plainRootOf(plain))
}

/** 生产写通路（与面板同一个 setter：`setChannelValue` 命令的内核镜像）。 */
function writeSelection(host: KernelReadHost, sel: MultiblockSelectionState): void {
  const session = host.session
  if (session === null) throw new Error('前提：会话必须在场')
  session.setTotalTier(sel.totalTier)
  for (const [k, v] of Object.entries(sel.values)) session.setChannelValue(k, v)
  const decl = host.ctx.kernelMultiblockDeclaration()
  if (decl === null) throw new Error('前提：声明必须在场')
  const idx = decl.runstates.findIndex((r) => r.id === sel.runstate)
  if (idx >= 0) session.setRunstateIndex(idx)
}

/** 生产渲染视图文档（`useKernelChannels#renderDoc` 同一入口 + 同一读面）。 */
function renderDocOf(host: KernelReadHost): RuntimeDocument {
  const inputs = host.ctx.kernelRenderViewInputs()
  if (inputs === null) throw new Error('前提：内核渲染视图输入必须在场')
  const rv = kernelRenderViewFromFace({ ...inputs, frameIndex: 0 })
  if (rv.doc === null) throw new Error(`渲染视图必须产出：${rv.diagnostics.join(' | ')}`)
  return rv.doc
}

type SigDefinition = { cellGrid: number[][][]; blockPalette: readonly Record<string, unknown>[] }

/** DRW 定义面（内核呈现链的另一份生产读面；与渲染视图同源于唯一求值点）。 */
function faceDefinitionOf(host: KernelReadHost): SigDefinition {
  const face = host.ctx.kernelRenderSourceFace()
  if (face === null) throw new Error('前提：DRW 定义面必须在场')
  const hit = face.definitionAt(0)
  if (hit === null) throw new Error('前提：定义必须存在')
  return hit.definition as unknown as SigDefinition
}

/** 唯一求值点的装配尺寸（面板与画面同源）。 */
function dimsOf(host: KernelReadHost): { w: number; h: number; d: number } {
  const evaluation = host.ctx.kernelMultiblockEvaluation()
  if (evaluation === null || evaluation.assembly === null) throw new Error('前提：装配必须产出')
  return evaluation.assembly.report.dims
}

const ebfRaw = ebfFixture as unknown as Json
const tierOnlyRaw = tierOnlyFixture as unknown as Json
const lscRaw = lscOverlapFixture as unknown as Json
const frameRaw = minimalV2 as unknown as Json

/** 逐格"方块签名"（`name:meta`，`air` → `''`）：与调色板编号无关，用于跨调色板重排比对。 */
function signatureGrid(cellGrid: number[][][], palette: readonly Record<string, unknown>[]): string[][][] {
  const names = palette.map((e) => {
    const rid = typeof e.registryId === 'string' ? e.registryId : ''
    const colon = rid.indexOf(':')
    const name = colon >= 0 ? rid.slice(colon + 1) : rid
    if (name === '' || name === 'air' || name === 'Air') return ''
    return `${name}:${String(e.meta ?? 0)}`
  })
  return cellGrid.map((slice) =>
    slice.map((row) => row.map((idx) => names[idx] ?? `?${String(idx)}`)),
  )
}

function diffSignatures(a: string[][][], b: string[][][], dims: { w: number; h: number; d: number }): string[] {
  const out: string[] = []
  for (let z = 0; z < dims.d; z++) {
    for (let y = 0; y < dims.h; y++) {
      for (let x = 0; x < dims.w; x++) {
        const av = a[z]?.[y]?.[x]
        const bv = b[z]?.[y]?.[x]
        if (av !== bv && out.length < 6) out.push(`(${x},${y},${z}) 装配=${av} 渲染=${bv}`)
      }
    }
  }
  return out
}

describe('通道面板：忠实反映文件声明', () => {
  it('EBF：3 条滑杆（Height/Coil/Glass，顺序 = 声明顺序）+ Tier 1..14 + 双运行态', async () => {
    const doc = await parse(ebfRaw)
    const decl = doc.multiblock!.decl
    const specs = channelSliderSpecs(decl)

    expect(doc.isMultiblock).toBe(true)
    expect(specs.map((s) => s.key)).toEqual(['height', 'coil', 'glass'])
    expect(specs.map((s) => s.name)).toEqual(['Height', 'Coil', 'Glass'])
    expect(specs.map((s) => s.kind)).toEqual(['size', 'replace', 'replace'])
    // 范围 0..声明取值域上界
    expect(specs.map((s) => s.hi)).toEqual([5, 3, 2])
    // size 型的有效取值区间单独带出（仅观测/提示用）
    expect(specs[0]!.min).toBe(1)
    expect(specs[0]!.max).toBe(5)

    expect(decl.totalTierDomain.min).toBe(1)
    expect(decl.totalTierDomain.max).toBe(14)
    expect(tierSampleValues(decl)).toEqual([1, 2, 14])
    expect(decl.runstates.map((r) => r.name)).toEqual(['Idle', 'Running'])
  })

  it('tier-only：无具名通道之外的轴，滑杆 1 条 + 单运行态', async () => {
    const doc = await parse(tierOnlyRaw)
    const decl = doc.multiblock!.decl
    const specs = channelSliderSpecs(decl)
    expect(specs.map((s) => s.key)).toEqual(['structTier'])
    expect(specs[0]!.name).toBe('Structure Tier')
    expect(decl.runstates.length).toBe(1)
  })

  it('初始取值：Tier = default（吸附抽样）、通道全 Not set、运行态 = 声明首项', async () => {
    const doc = await parse(ebfRaw)
    const state = initialMultiblockSelection(doc.multiblock!.decl)
    expect(state.totalTier).toBe(2)
    expect(state.values).toEqual({ height: 0, coil: 0, glass: 0 })
    expect(state.runstate).toBe('idle')

    // 默认态必然命中声明组合（契约 §5.2）—— 生产面板模型上冻结为：
    // 变体键 = 声明初值，且**没有**"组合未声明"提示。
    const host = await makeHost(ebfRaw)
    try {
      const model = productionPanelModelOf(host)!
      expect(model.variantKey).toBe('height:0|coil:0|glass:0|tt:2|runstate:idle')
      expect(model.notices.some((n) => n.includes('未声明')), '默认态命中声明组合').toBe(false)
      expect(host.ctx.kernelMultiblockEvaluation()?.assembly, '默认态必须装配得出').not.toBeNull()
    } finally {
      host.dispose()
    }
  })

  it('0 显示 Not set；Tier 吸附到已声明抽样；滑杆域外取值被夹取', async () => {
    const doc = await parse(ebfRaw)
    const decl = doc.multiblock!.decl
    expect(formatChannelValue(0)).toBe('Not set')
    expect(formatChannelValue(3)).toBe('3')
    expect(snapTierToSample([1, 2, 14], 7)).toBe(2)
    expect(snapTierToSample([1, 2, 14], 13)).toBe(14)
    expect(snapTierToSample([1, 2, 14], 2)).toBe(2)
    expect(clampChannelValue(decl, 'coil', 99)).toBe(3)
    expect(clampChannelValue(decl, 'coil', -4)).toBe(0)
    expect(clampChannelValue(decl, 'nope', 1)).toBeNull()
  })
})

describe('接线：当前取值 → 装配 → 当前帧网格（渲染路径真的吃装配产物）', () => {
  it('EBF：渲染解析结果与装配结果逐格一致（含首帧顶层展开）', async () => {
    const host = await makeHost(ebfRaw)
    try {
      writeSelection(host, { totalTier: 14, values: { height: 5, coil: 3, glass: 2 }, runstate: 'active' })
      const evaluation = host.ctx.kernelMultiblockEvaluation()!
      expect(evaluation.failed, '前提：再装配必须成功').toBe(false)
      expect(evaluation.assembly, '前提：装配产物必须在场').not.toBeNull()

      const plain = renderDocOf(host).serialize()
      // 多方块文档本体仍是 V2（非 World），渲染解析走 `loadStructureData`（顶层展开）
      expect(isWorldDocument(plain)).toBe(false)

      const { definition } = resolveRenderBundle({ document: plain }, 0)
      const want = evaluation.assembly!.report.dims
      expect(definition.cellGrid.length).toBe(want.d)
      expect(definition.cellGrid[0]!.length).toBe(want.h)
      expect(definition.cellGrid[0]![0]!.length).toBe(want.w)

      const got = signatureGrid(definition.cellGrid, definition.blockPalette as unknown as Record<string, unknown>[])
      // "装配结果" = 唯一求值点的装配产物（DRW 定义面是同一份载荷的生产投影）。
      const face = faceDefinitionOf(host)
      const expected = signatureGrid(face.cellGrid, face.blockPalette)
      expect(diffSignatures(got, expected, want)).toEqual([])
      // 渲染调色板必须是"装配网格里实际出现的方块"（不得混入并集调色板，那会让下标错位）
      expect(definition.blockPalette.length).toBeLessThan(
        host.ctx.kernelMultiblockDeclaration()!.blockPalette.length,
      )
    } finally {
      host.dispose()
    }
  })

  it('渲染路径的调色板必须与装配网格自洽（并集调色板注入会立刻暴露）', async () => {
    const host = await makeHost(ebfRaw)
    try {
      const union = host.ctx.kernelMultiblockDeclaration()!.blockPalette
      writeSelection(host, { totalTier: 1, values: { height: 0, coil: 0, glass: 0 }, runstate: 'idle' })
      const plain = renderDocOf(host).serialize()
      const rootPalette = plain.blockPalette as Record<string, unknown>[]
      // 顶层不得出现"多方块并集调色板"（那正是帧为主形态的根级展开约定，多方块文档禁止）
      expect(rootPalette).not.toBe(union)
      expect(Array.isArray(plain.multiblock)).toBe(false)
      expect('multiblock' in plain).toBe(false)
      const { definition } = resolveRenderBundle({ document: plain }, 0)
      const dims = dimsOf(host)
      const got = signatureGrid(definition.cellGrid, definition.blockPalette as unknown as Record<string, unknown>[])
      const face = faceDefinitionOf(host)
      const expected = signatureGrid(face.cellGrid, face.blockPalette)
      expect(diffSignatures(got, expected, dims)).toEqual([])
    } finally {
      host.dispose()
    }
  })

  it('等级/尺寸通道升高 → 结构变大（滑杆拖动方向正确）', async () => {
    const host = await makeHost(ebfRaw)
    try {
      const dimsAt = (state: MultiblockSelectionState) => {
        writeSelection(host, state)
        return dimsOf(host)
      }

      const tier1 = dimsAt({ totalTier: 1, values: { height: 0, coil: 0, glass: 0 }, runstate: 'idle' })
      const tier2 = dimsAt({ totalTier: 2, values: { height: 0, coil: 0, glass: 0 }, runstate: 'idle' })
      const tier14 = dimsAt({ totalTier: 14, values: { height: 0, coil: 0, glass: 0 }, runstate: 'idle' })
      expect(tier2.h).toBeGreaterThan(tier1.h)
      expect(tier14.h).toBeGreaterThan(tier2.h)

      // 尺寸型通道（height）自己的滑杆：1 → 5 逐级变高（Tier 固定 1，避免与回落耦合）
      const h1 = dimsAt({ totalTier: 1, values: { height: 1, coil: 0, glass: 0 }, runstate: 'idle' })
      const h5 = dimsAt({ totalTier: 1, values: { height: 5, coil: 0, glass: 0 }, runstate: 'idle' })
      expect(h5.h).toBeGreaterThan(h1.h)

      // 运行态（只承诺纹理/材质层）不得改变几何
      const idle = dimsAt({ totalTier: 2, values: { height: 3, coil: 3, glass: 1 }, runstate: 'idle' })
      const active = dimsAt({ totalTier: 2, values: { height: 3, coil: 3, glass: 1 }, runstate: 'active' })
      expect(active).toEqual(idle)
    } finally {
      host.dispose()
    }
  })

  it('仅总 Tier 的 fixture：Tier 滑杆直接决定结构高度（等级越高越大）', async () => {
    const host = await makeHost(tierOnlyRaw)
    try {
      const heights = [1, 2, 3].map((tier) => {
        writeSelection(host, { totalTier: tier, values: { structTier: 0 }, runstate: 'idle' })
        return dimsOf(host).h
      })
      expect(heights[1]!).toBeGreaterThan(heights[0]!)
      expect(heights[2]!).toBeGreaterThan(heights[1]!)
    } finally {
      host.dispose()
    }
  })

  it('未声明组合：守卫先判、装配器回落、UI 只提示（异常不穿透）', async () => {
    const host = await makeHost(ebfRaw)
    try {
      // tt:3 不在 tierSample（1/2/14）里 ⇒ 变体键未声明；滑杆吸附不会产生该值，此处直接写。
      writeSelection(host, { totalTier: 3, values: { height: 0, coil: 0, glass: 0 }, runstate: 'idle' })
      const model = productionPanelModelOf(host)!
      expect(model.notices.some((n) => n.includes('未声明')), '未声明组合必须只提示、不拒绝').toBe(true)
      // 软约束（文件 notes）只提示、不参与装配
      expect(model.notices.some((n) => n.includes('提示（文件声明）'))).toBe(true)
      const evaluation = host.ctx.kernelMultiblockEvaluation()!
      expect(evaluation.failed, '装配异常不得穿透（失败才是异常）').toBe(false)
      expect(evaluation.assembly, '未声明组合必须由装配器回落出结果').not.toBeNull()
    } finally {
      host.dispose()
    }
  })

  it('面板模型：观测字段（variant/dims）随取值刷新', async () => {
    const host = await makeHost(ebfRaw)
    try {
      writeSelection(host, { totalTier: 1, values: { height: 0, coil: 0, glass: 0 }, runstate: 'idle' })
      const low = productionPanelModelOf(host)!
      writeSelection(host, { totalTier: 14, values: { height: 5, coil: 3, glass: 2 }, runstate: 'active' })
      const high = productionPanelModelOf(host)!

      expect(low.variantKey).toBe('height:0|coil:0|glass:0|tt:1|runstate:idle')
      expect(high.variantKey).toBe('height:5|coil:3|glass:2|tt:14|runstate:active')
      expect(low.dims).not.toBe(high.dims)
      expect(high.channels.length).toBe(3)
      expect(low.notices.length).toBeGreaterThan(0)
    } finally {
      host.dispose()
    }
  })

  it('三份 fixture 的滑杆可取值组合全部能装配（面板不存在"走到就报错"的位置）', async () => {
    const cases: Array<[string, Json]> = [
      ['ebf-2ch', ebfRaw],
      ['tier-only', tierOnlyRaw],
      ['lsc-overlap', lscRaw],
    ]
    for (const [name, raw] of cases) {
      const host = await makeHost(raw)
      try {
        const decl = host.ctx.kernelMultiblockDeclaration()
        if (decl === null) throw new Error(`${name}: 前提——声明必须在场`)
        const specs = channelSliderSpecs(decl)
        const tiers = tierSampleValues(decl)
        const runstates = decl.runstates.map((r) => r.id)
        let combos = 0
        for (const tier of tiers) {
          for (const runstate of runstates) {
            // 每通道取 0 与域上界（滑杆两端）
            for (const pick of [0, specs.length]) {
              const values: Record<string, number> = {}
              for (const c of decl.channels) values[c.key] = 0
              specs.forEach((s, i) => { values[s.key] = i < pick ? s.hi : 0 })
              writeSelection(host, { totalTier: tier, values, runstate })
              const evaluation = host.ctx.kernelMultiblockEvaluation()
              expect(evaluation?.failed, `${name} tier=${tier} runstate=${runstate} pick=${pick}`).toBe(false)
              expect(evaluation?.assembly, `${name} tier=${tier} runstate=${runstate} pick=${pick}`).not.toBeNull()
              combos++
            }
          }
        }
        expect(combos, name).toBeGreaterThan(0)
      } finally {
        host.dispose()
      }
    }
  })

  it('帧为主文档：通道面板不出现，渲染文档仍可解析（行为零变化）', async () => {
    const doc = await parse(frameRaw)
    expect(doc.isMultiblock).toBe(false)
    expect(doc.multiblock).toBeNull()
    expect(doc.multiblockChannels).toEqual([])

    const host = await makeHost(frameRaw)
    try {
      // 装配守卫：无多方块声明 ⇒ 无面板模型、求值不伪造装配产物。
      expect(host.ctx.kernelMultiblockDeclaration()).toBeNull()
      expect(productionPanelModelOf(host)).toBeNull()
      const evaluation = host.ctx.kernelMultiblockEvaluation()!
      expect(evaluation.assembly).toBeNull()
      expect(evaluation.failed).toBe(false)
      expect(evaluation.identity, '帧为主文档的求值身份为空串（与切换前逐字相同）').toBe('')
      expect(evaluation.scene, '帧为主文档：求值场景就是内核场景').toBe(host.session!.document()!.scene)

      // 渲染视图（DRW 消费的那份）仍产出可读回的文档 —— 换帧不会静默失效。
      const viewDoc = renderDocOf(host)
      expect(viewDoc.frameCount).toBe(doc.frameCount)
      const { definition } = resolveRenderBundle({ document: viewDoc.serialize() }, 0)
      expect(definition.cellGrid.length).toBeGreaterThan(0)
    } finally {
      host.dispose()
    }
  })
})

describe('下方栏 tab：两端共用的可用性/默认/回落逻辑', () => {
  it('帧为主文档：通道 tab 不可用，默认帧控制（多帧）/ 分层预览（单帧）', () => {
    const multi = { showFrameTab: true, hasWorldMultiFrame: true, showLayerTab: true, showChannelsTab: false }
    expect(availableDockTabs(multi)).toEqual(['frame', 'layer'])
    expect(defaultDockTab(multi)).toBe('frame')
    const single = { ...multi, hasWorldMultiFrame: false }
    expect(availableDockTabs(single)).toEqual(['layer'])
    expect(defaultDockTab(single)).toBe('layer')
  })

  it('多方块文档：默认落在「通道」，其余 tab 仍在（互不干扰）', () => {
    const avail = { showFrameTab: true, hasWorldMultiFrame: true, showLayerTab: true, showChannelsTab: true }
    expect(availableDockTabs(avail)).toEqual(['channels', 'frame', 'layer'])
    expect(defaultDockTab(avail)).toBe('channels')
    // Embed 关掉帧控制/分层预览时，通道 tab 仍必须可用（嵌入只读查看器也能切通道）
    const embedOnly = { showFrameTab: false, hasWorldMultiFrame: true, showLayerTab: false, showChannelsTab: true }
    expect(availableDockTabs(embedOnly)).toEqual(['channels'])
    expect(defaultDockTab(embedOnly)).toBe('channels')
  })

  it('文档形态切换：首选 tab 不可用时回落到当前可用项，不残留空 panel', () => {
    const frameDoc = availableDockTabs({ showFrameTab: true, hasWorldMultiFrame: true, showLayerTab: true, showChannelsTab: false })
    expect(resolveDockTab('channels', frameDoc)).toBe('frame')
    expect(resolveDockTab('layer', frameDoc)).toBe('layer')
    const mbDoc = availableDockTabs({ showFrameTab: false, hasWorldMultiFrame: true, showLayerTab: true, showChannelsTab: true })
    expect(mbDoc).toEqual(['channels', 'layer'])
    expect(resolveDockTab('channels', mbDoc)).toBe('channels')
    // 帧控制不可用（如 Embed 关掉 frameControls）时，首选 'frame' 回落到可用列表首位
    expect(resolveDockTab('frame', mbDoc)).toBe('channels')
  })
})
