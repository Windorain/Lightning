/**
 * **D2（#289 P10d）· 多方块网格求值节点**的判据。
 *
 * ## 本文件证什么
 *
 * Lead 裁决（#289 交办）逐字要求：多方块**声明 + 通道取值是输入，网格是求值产物**；
 * 正确形态是求值节点「声明内容版本 + 通道取值版本 → 网格」（纯、可缓存、内容身份失效），
 * **不是**"通道一变就改写内核文档里的网格"（那会把求值结果写进文档内容，
 * 制造脏文档与幽灵历史 —— 与 #249 禁止的「动画输出反写手动取值」同族）。
 *
 * 故本文件的判据分三组：
 *
 * | 组 | 判据 | 违反的后果 |
 * |---|---|---|
 * | 纯性 | 同输入 ⇒ 同输出（含身份） | 求值不可缓存、证据不可复现 |
 * | 身份 | 机位**不**进身份；取值/声明/帧**进**身份 | 转视角重算几何（A11 判红）/ 滑杆动了不重算（画面不跟手） |
 * | 失效 | 只有视图投影变化 ⇒ `geometry` 重算数 **0** | G1「改注解不重建几何」判红 |
 *
 * ## 为什么"机位不进身份"必须单独断言
 *
 * 这是 A11 的实现落点，也是最容易做错的一处：把机位（或任何非读集维度）
 * 计进身份，会让"转一下视角"重算全部方块几何。而身份是**唯一**的缓存键，
 * 故这条断言直接等价于 A11。
 */

import { describe, expect, it } from 'vitest'
import {
  evaluateMultiblock,
  evaluationIdentityOf,
  evaluationNodeDependency,
  type GridAssembler,
  type MultiblockSelectionInput,
} from '@/presentation/multiblockEvaluation'
import { computeInvalidation, NO_DIGESTS, recomputeCount, type NodeDependency } from '@/presentation/invalidationPlan'
import { TIME_ZERO, type EvaluationKey } from '@/presentation/evaluationKey'

import fs from 'node:fs'
import path from 'node:path'

const SRC = path.join(process.cwd(), 'src')

/** 读源码并归一化行尾（铁律 6）。 */
function readSource(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
}

/** 列出全部生产文件（排除 `__tests__`）。 */
function listProductionFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === '__tests__' || ent.name === 'node_modules') continue
        walk(full)
      } else if (/\.(ts|vue)$/.test(ent.name)) {
        out.push(path.relative(SRC, full).replace(/\\/g, '/'))
      }
    }
  }
  walk(SRC)
  return out
}


/** 一个确定的装配端口：把取值编码进"网格"（使"取值变了网格变了"可断言）。 */
const deterministicAssembler: GridAssembler = (sel) => ({
  grid: { cells: `${sel.totalTier}:${sel.runstate}:${JSON.stringify(sel.values)}` },
})

const SEL_A: MultiblockSelectionInput = { totalTier: 1, values: { height: 0 }, runstate: 'idle' }
const SEL_B: MultiblockSelectionInput = { totalTier: 2, values: { height: 1 }, runstate: 'idle' }

function inputOf(over: Partial<Parameters<typeof evaluateMultiblock>[0]> = {}) {
  return {
    sceneId: 'scene-1',
    declarationContent: { id: 'mb-1', channels: ['height'] },
    selection: SEL_A,
    frameIndex: 0,
    assemble: deterministicAssembler,
    ...over,
  }
}

describe('D2 · 求值节点：纯性与身份', () => {
  it('同输入 ⇒ 同输出（含身份）—— 可缓存、可复现', () => {
    const a = evaluateMultiblock(inputOf())
    const b = evaluateMultiblock(inputOf())
    expect(a.identity).toBe(b.identity)
    expect(a.grid).toEqual(b.grid)
    expect(a.declared).toBe(true)
  })

  it('**取值变化 ⇒ 身份必变**（否则滑杆动了不重算 —— 画面不跟手）', () => {
    const a = evaluateMultiblock(inputOf({ selection: SEL_A }))
    const b = evaluateMultiblock(inputOf({ selection: SEL_B }))
    expect(a.identity).not.toBe(b.identity)
    expect(a.grid).not.toEqual(b.grid)
  })

  it('**声明内容变化 ⇒ 身份必变**', () => {
    const a = evaluateMultiblock(inputOf())
    const b = evaluateMultiblock(inputOf({ declarationContent: { id: 'mb-1', channels: ['height', 'glass'] } }))
    expect(a.identity).not.toBe(b.identity)
  })

  it('**帧下标变化 ⇒ 身份必变**（它决定注入哪一帧）', () => {
    const a = evaluateMultiblock(inputOf({ frameIndex: 0 }))
    const b = evaluateMultiblock(inputOf({ frameIndex: 3 }))
    expect(a.identity).not.toBe(b.identity)
  })

  it('**A11 负对照：机位不参与身份** —— 身份函数根本不接受机位参数', () => {
    // 判据是**类型级 + 行为级**双重的：
    //  ① 身份函数的入参里没有机位/选择/布局（结构上不可能受影响）；
    //  ② 同一个 (声明, 取值, 帧) 反复求值恒得同一身份。
    // 这条断言直接等价于 A11「机位变化 ⇒ 方块几何重建数 0」。
    const id = evaluationIdentityOf({
      sceneId: 'scene-1',
      declarationContent: { id: 'mb-1' },
      selection: SEL_A,
      frameIndex: 0,
    })
    for (let i = 0; i < 5; i++) {
      expect(
        evaluationIdentityOf({ sceneId: 'scene-1', declarationContent: { id: 'mb-1' }, selection: SEL_A, frameIndex: 0 }),
      ).toBe(id)
    }
    // 且身份函数的形参名里不含机位族词汇（防"偷偷加一个参数"）
    const src = evaluationIdentityOf.toString()
    for (const forbidden of ['camera', 'viewProjection', 'localDisplay', 'yaw', 'elevation']) {
      expect(src.includes(forbidden), `身份函数不得读 ${forbidden}（那会让转视角重算几何）`).toBe(false)
    }
  })

  it('取值键序不影响身份（同一取值两种枚举顺序 ⇒ 同身份）', () => {
    const a = evaluateMultiblock(inputOf({ selection: { totalTier: 1, values: { height: 0, glass: 0 }, runstate: 'idle' } }))
    const b = evaluateMultiblock(inputOf({ selection: { totalTier: 1, values: { glass: 0, height: 0 }, runstate: 'idle' } }))
    expect(a.identity, '集合枚举顺序不构成内容差异').toBe(b.identity)
  })
})

describe('D2 · 求值节点：装配失败不穿透（保留上次可渲染结果）', () => {
  it('装配端口返回 `null` ⇒ `grid: null` + 提示，**不抛错**', () => {
    const r = evaluateMultiblock(inputOf({ assemble: () => null }))
    expect(r.grid).toBeNull()
    expect(r.declared).toBe(false)
    expect(r.notices.length, '必须显式报告"装配不出"').toBeGreaterThan(0)
  })

  it('装配端口**抛错** ⇒ 同样捕获（旧实现同取舍：异常不穿透到 UI）', () => {
    const r = evaluateMultiblock(
      inputOf({
        assemble: () => {
          throw new Error('声明缺陷')
        },
      }),
    )
    expect(r.grid).toBeNull()
    expect(r.notices.join('')).toContain('装配失败')
  })

  it('身份在装配失败时**仍**由输入派生（调用方据此判断"要不要重试"）', () => {
    const ok = evaluateMultiblock(inputOf())
    const bad = evaluateMultiblock(inputOf({ assemble: () => null }))
    expect(bad.identity, '身份只由输入决定，不由装配成功与否决定').toBe(ok.identity)
  })
})

describe('D2 · 失效：声明该节点只读什么（G1/A11 的落点）', () => {
  const node: NodeDependency = evaluationNodeDependency({
    nodeId: 'mb-grid',
    declarationMembers: ['ch:height', 'ch:glass'],
    identity: 'e:abc',
  })

  it('节点声明 `target: geometry` 且 **`inputs` 为空**（尤其不含 `documentVersion`）', () => {
    expect(node.target, '它产出几何 ⇒ A11 读 recomputeCounts.geometry').toBe('geometry')
    expect(node.inputs, '不得声明任何求值键维度').toEqual([])
    // 这条是 G1 的关键：若声明 `documentVersion`，改一个注解文字就会让网格重算。
    expect(node.inputs.includes('documentVersion' as never), 'G1：改注解不得重建方块几何').toBe(false)
  })

  it('**只有视图投影变化 ⇒ geometry 重算数 0**（A11 主判据）', () => {
    const keyA: EvaluationKey = { documentVersion: 1, scene: 's1', time: TIME_ZERO, parameterVersion: 0, contentResourceVersions: {} }
    const keyB: EvaluationKey = { ...keyA, viewProjection: { camera: 'c2', localDisplay: 'all' } }
    const plan = computeInvalidation(keyA, keyB, [node], NO_DIGESTS)
    expect(recomputeCount(plan, 'geometry'), 'A11：机位变化 ⇒ 方块几何重建数为 0').toBe(0)
    expect(plan.viewProjectionChanged, '前提：确实只有投影变了').toBe(true)
  })

  it('**声明内容摘要变化 ⇒ geometry 重算 1**（反空洞真：上一条不是恒真）', () => {
    const keyA: EvaluationKey = { documentVersion: 1, scene: 's1', time: TIME_ZERO, parameterVersion: 0, contentResourceVersions: {} }
    const changed = evaluationNodeDependency({ nodeId: 'mb-grid', declarationMembers: ['ch:height', 'ch:glass'], identity: 'e:CHANGED' })
    const plan = computeInvalidation(keyA, keyA, [changed], {
      collections: { 'mb-grid:declaration': 'm:0:2' },
      nodes: { 'mb-grid': 'e:abc' },
    })
    expect(recomputeCount(plan, 'geometry'), '内容摘要变了 ⇒ 必须重算').toBe(1)
  })

  it('内容与成员都没变 ⇒ 复用（`no-input-changed`）', () => {
    const keyA: EvaluationKey = { documentVersion: 1, scene: 's1', time: TIME_ZERO, parameterVersion: 0, contentResourceVersions: {} }
    const plan = computeInvalidation(keyA, keyA, [node], {
      collections: { 'mb-grid:declaration': node.collections![0]!.membersDigest },
      nodes: { 'mb-grid': 'e:abc' },
    })
    expect(recomputeCount(plan, 'geometry'), '什么都没变 ⇒ 复用').toBe(0)
    expect(plan.verdicts[0]!.action).toBe('reuse')
  })
})

describe('D2 · 生产接线：渲染视图走内核求值（不是 legacy 构造器）', () => {
  it('`useKernelChannels` 的渲染文档来自 `kernelRenderViewOf`，且**不再**调 legacy 构造器', () => {
    const src = readSource('shared/viewport/useKernelChannels.ts')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
    expect(src, '渲染视图必须走内核求值').toContain('kernelRenderViewOf(')
    expect(src, '不得再调 legacy 构造器（那是切换前的参照实现，生产零调用点）').not.toContain('buildMultiblockRenderView(')
  })

  it('`kernelRenderViewOf` 确实走内核装配 + 投影（`renderView` 模式）', () => {
    const src = readSource('composition/kernelRenderView.ts')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
    expect(src, '必须走内核装配').toContain('assembleKernelDocument(')
    expect(src, '必须以 renderView 模式投影（网格注入帧）').toContain('renderView:')
    expect(src, '不得把求值结果写回文档内容').not.toMatch(/replaceDoc|adoptDocument/)
  })

  it('**负对照**：legacy 构造器仍存在且仅被对照测试消费（保留参照，不是"半成品"）', () => {
    // 生产零调用点，而对照测试必须能用它 —— 两件事都要成立。
    //
    // ⚠️ 必须**剥注释与字符串**：本仓散文大量引用旧函数名（说明"替代了什么"），
    // 那是文档价值而非调用。与 `boundary-scan.test.ts` 的 `codeOnly` 同一把尺子
    // （"提到某函数名" ≠ "调用它"；不剥会让判据因自己的说明而恒红）。
    const codeOnly = (rel: string): string =>
      readSource(rel)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    const prod = listProductionFiles().filter((rel) => rel !== 'shared/viewport/multiblockChannelUi.ts')
    const callers = prod.filter((rel) => codeOnly(rel).includes('buildMultiblockRenderView('))
    expect(callers, `生产不得再调 legacy 构造器，实测：${callers.join(', ')}`).toEqual([])
    // 定义处本身仍在（否则"参照"这个说法不成立）
    expect(codeOnly('shared/viewport/multiblockChannelUi.ts'), '参照实现必须仍存在').toContain('buildMultiblockRenderView(')
    // 对照测试必须仍用它（否则对齐失去意义）
    const parity = readSource('composition/__tests__/renderCutoverParity.test.ts')
    expect(parity, '对照测试必须仍用 legacy 构造器作参照').toContain('buildMultiblockRenderView(')
  })
})
