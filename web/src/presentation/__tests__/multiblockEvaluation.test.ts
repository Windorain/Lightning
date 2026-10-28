/**
 * **D2 · 多方块求值节点的身份** 与 **生产求值点**判据。
 *
 * ## 本文件证什么
 *
 * 设计要求逐字要求：多方块**声明 + 通道取值是输入，网格是求值产物**；
 * 正确形态是求值节点「声明内容版本 + 通道取值版本 → 网格」（纯、可缓存、内容身份失效），
 * **不是**"通道一变就改写内核文档里的网格"（那会把求值结果写进文档内容，
 * 制造脏文档与幽灵历史 —— 与禁止的「动画输出反写手动取值」同族）。
 *
 * ## 旧的 evaluateMultiblock 已删，判据搬到**生产求值点**上
 *
 * 旧 presentation/multiblockEvaluation#evaluateMultiblock（注入式装配端口）与
 * evaluationNodeDependency 已随 M5_CLOSEOUT 删除 —— 它们在**生产零调用**，
 * 唯一消费者是本文件与对照测试。生产求值点只有一个：
 * composition/kernelMultiblockEvaluation#evaluateMultiblockPresentation。
 * 故本文件的分组变成：
 *
 * | 组 | 判据 | 违反的后果 |
 * |---|---|---|
 * | 身份 | 机位**不**进身份；取值/声明/帧**进**身份；键序不影响身份 | 转视角重算几何（A11 判红）/ 滑杆动了不重算（画面不跟手） |
 * | 失败不穿透 | 声明缺陷 ⇒ failed: true + 诊断，**不抛错**、不回落装载期场景 | 画面静默画回旧取值（旧通路复活） |
 * | 生产接线 | 视口走 kernelRenderViewFromFace；旧入口与旧构造器**不存在** | 第二份求值/构造实现复活 |
 *
 * A11 的"节点只读声明"（target: geometry / inputs: []）由
 * application/__tests__/evaluationInvalidation.test.ts 在**生产**节点形状上把守
 * —— 本文件不再为已删的 evaluationNodeDependency 保留一份"只能测死代码"的判据。
 */

import { describe, expect, it } from 'vitest'
import {
  evaluationIdentityOf,
  type MultiblockSelectionInput,
} from '@/presentation/multiblockEvaluation'
import * as kernelRenderViewModule from '@/composition/kernelRenderView'
import * as evaluationModule from '@/presentation/multiblockEvaluation'
import { evaluateMultiblockPresentation } from '@/composition/kernelMultiblockEvaluation'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { plainRootOf } from '@/adapters/plainRoot'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import { makeAdoptedKernelReadHost } from '@/runtime/__tests__/kernelReadTestHost'

import fs from 'node:fs'
import path from 'node:path'

import ebfFixture from '@/context/__tests__/fixtures/multiblock-ebf-2ch.json'

const SRC = path.join(process.cwd(), 'src')

/** 读源码并归一化行尾（铁律 6：CRLF 树上断言必须与工作树行尾无关）。 */
function readSource(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
}

/**
 * 剥注释（**行级**词法）：丢掉整行注释（双斜杠行或块注释的星号行）。
 *
 * 本文件只需要"注释里的名字不算调用"这一条区分力，行级剥离足够且**没有正则复杂度**；
 * 更完整的词法剥离由 application/__tests__/retirementRegistry.test.ts 的
 * stripNonCode 承担（那里是判据本尊）。
 */
function stripCommentLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trimStart()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')
}

const SEL_A: MultiblockSelectionInput = { totalTier: 1, values: { height: 0 }, runstate: 'idle' }
const SEL_B: MultiblockSelectionInput = { totalTier: 2, values: { height: 1 }, runstate: 'idle' }

function identityInput(over: Record<string, unknown> = {}) {
  return {
    sceneId: 'scene-1',
    declarationContent: { id: 'mb-1', channels: ['height'] },
    selection: SEL_A,
    frameIndex: 0,
    ...over,
  }
}

describe('D2 · 求值身份：纯性与读集', () => {
  it('同输入 ⇒ 同身份 —— 可缓存、可复现', () => {
    expect(evaluationIdentityOf(identityInput())).toBe(evaluationIdentityOf(identityInput()))
  })

  it('**取值变化 ⇒ 身份必变**（否则滑杆动了不重算 —— 画面不跟手）', () => {
    expect(evaluationIdentityOf(identityInput({ selection: SEL_A }))).not.toBe(
      evaluationIdentityOf(identityInput({ selection: SEL_B })),
    )
  })

  it('**声明内容变化 ⇒ 身份必变**', () => {
    expect(evaluationIdentityOf(identityInput())).not.toBe(
      evaluationIdentityOf(
        identityInput({ declarationContent: { id: 'mb-1', channels: ['height', 'glass'] } }),
      ),
    )
  })

  it('**帧下标变化 ⇒ 身份必变**（它决定注入哪一帧）', () => {
    expect(evaluationIdentityOf(identityInput({ frameIndex: 0 }))).not.toBe(
      evaluationIdentityOf(identityInput({ frameIndex: 3 })),
    )
  })

  it('**A11 负对照：机位不参与身份** —— 身份函数根本不接受机位参数', () => {
    // 判据是**类型级 + 行为级**双重的：
    //  ① 身份函数的入参里没有机位/选择/布局（结构上不可能受影响）；
    //  ② 同一个 (声明, 取值, 帧) 反复求值恒得同一身份。
    // 这条断言直接等价于 A11「机位变化 ⇒ 方块几何重建数 0」。
    const id = evaluationIdentityOf(identityInput())
    for (let i = 0; i < 5; i++) {
      expect(evaluationIdentityOf(identityInput())).toBe(id)
    }
    // 且身份函数的形参名里不含机位族词汇（防"偷偷加一个参数"）
    const src = evaluationIdentityOf.toString()
    for (const forbidden of ['camera', 'viewProjection', 'localDisplay', 'yaw', 'elevation']) {
      expect(src.includes(forbidden), '身份函数不得读机位族参数（那会让转视角重算几何）').toBe(false)
    }
  })

  it('取值键序不影响身份（同一取值两种枚举顺序 ⇒ 同身份）', () => {
    const a = evaluationIdentityOf(
      identityInput({ selection: { totalTier: 1, values: { height: 0, glass: 0 }, runstate: 'idle' } }),
    )
    const b = evaluationIdentityOf(
      identityInput({ selection: { totalTier: 1, values: { glass: 0, height: 0 }, runstate: 'idle' } }),
    )
    expect(a, '集合枚举顺序不构成内容差异').toBe(b)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 生产求值点（唯一）：evaluateMultiblockPresentation
// ─────────────────────────────────────────────────────────────────────────────

/** 生产链宿主（真 Context + 真 KernelSession；输入全部来自生产解析 + 生产装载）。 */
async function makeHost() {
  const registry = createParserRegistry()
  registry.register(V2PlainParser)
  registry.register(createEnvelopeParser(registry))
  registry.register(WorldParser)
  registry.register(StructureDataParser)
  const raw = ebfFixture as unknown as Record<string, unknown>
  const parsed = await registry.detectAndParse(raw)
  if (!parsed.document) throw new Error('夹具解析失败')
  const plainRoot = plainRootOf((await readEnvelopeLayers(raw as never)).plain as Record<string, unknown>)
  return makeAdoptedKernelReadHost(parsed.document as never, plainRoot)
}

describe('生产求值点：装配失败不穿透（保留上次可渲染结果）', () => {
  it('声明缺陷（scenes 清空）⇒ failed: true + 诊断 + assembly: null，**不抛错**', async () => {
    const host = await makeHost()
    try {
      const doc = host.session!.document()!
      const body = host.session!.multiblockBodyOf()!
      const face = host.session!.assemblyFaceOf()!
      const corruptBody = { declaration: { ...body.declaration, scenes: [] }, sceneGridEvidence: [] }
      const out = evaluateMultiblockPresentation({
        scene: doc.scene,
        content: doc.content,
        frameObjects: face.frameObjects,
        multiblockDeclaration: (face.multiblock ?? null) as never,
        body: corruptBody as never,
        selection: { totalTier: 1, values: {}, runstate: 'idle' },
        frameIndex: 0,
      })
      expect(out.failed, '装配不出 ⇒ 必须显式失败（不得静默回落装载期场景）').toBe(true)
      expect(out.assembly, '失败时 assembly 必须为 null（消费方据此保留上一次结果）').toBeNull()
      expect(out.diagnostics.length, '失败必须带可显示诊断').toBeGreaterThan(0)
      expect(out.diagnostics.join(''), '诊断必须说出"保留上一次可渲染结果"').toContain('保留上一次可渲染结果')
      expect(out.identity, '身份仍由输入派生（调用方据此判断要不要重试）').toMatch(/^e:/)
    } finally {
      host.dispose()
    }
  })

  it('身份在装配失败时**仍**与成功时相同（身份只由输入决定，不由装配成功与否决定）', async () => {
    const host = await makeHost()
    try {
      const doc = host.session!.document()!
      const body = host.session!.multiblockBodyOf()!
      const face = host.session!.assemblyFaceOf()!
      const base = {
        scene: doc.scene,
        content: doc.content,
        frameObjects: face.frameObjects,
        multiblockDeclaration: (face.multiblock ?? null) as never,
        selection: { totalTier: 1, values: {}, runstate: 'idle' },
        frameIndex: 0,
      }
      const ok = evaluateMultiblockPresentation({ ...base, body })
      const bad = evaluateMultiblockPresentation({
        ...base,
        body: { declaration: { ...body.declaration, scenes: [] }, sceneGridEvidence: [] } as never,
      })
      expect(ok.failed).toBe(false)
      expect(bad.identity, '身份 = 读集摘要，与装配成败无关').toBe(ok.identity)
    } finally {
      host.dispose()
    }
  })

  it('帧为主文档（body === null）⇒ 原样返回内核场景、身份为空串、不算失败', async () => {
    const host = await makeHost()
    try {
      const doc = host.session!.document()!
      const face = host.session!.assemblyFaceOf()!
      const out = evaluateMultiblockPresentation({
        scene: doc.scene,
        content: doc.content,
        frameObjects: face.frameObjects,
        multiblockDeclaration: null,
        body: null,
        selection: { totalTier: 1, values: {}, runstate: 'idle' },
        frameIndex: 0,
      })
      expect(out.failed).toBe(false)
      expect(out.assembly).toBeNull()
      expect(out.scene, '帧为主 ⇒ 求值场景就是内核场景（行为零变化）').toBe(doc.scene)
      expect(out.identity, '帧为主身份为空串（与切换前逐字相同）').toBe('')
    } finally {
      host.dispose()
    }
  })
})

describe('生产接线：视口走内核面渲染视图（旧入口已删）', () => {
  it('useKernelChannels 的渲染文档来自**内核面协调入口**，且**不再**调 legacy 构造器', () => {
    const src = stripCommentLines(readSource('shared/viewport/useKernelChannels.ts'))
    expect(src, '渲染视图必须走内核面协调入口').toContain('kernelRenderViewFromFace(')
    expect(src, '不得再调 legacy 构造器（该入口已删除）').not.toContain('buildMultiblockRenderView(')
    expect(src, '不得再调旧文档求值入口（该入口已删除）').not.toContain('kernelRenderViewOf(')
  })

  it('旧入口在生产导出里**不存在**（防回流：删掉的不是调用、是符号本身）', () => {
    expect('kernelRenderViewOf' in kernelRenderViewModule, 'kernelRenderViewOf 必须已删除').toBe(false)
    expect('evaluateMultiblock' in evaluationModule, 'evaluateMultiblock 必须已删除').toBe(false)
    expect('evaluationNodeDependency' in evaluationModule, 'evaluationNodeDependency 必须已删除').toBe(false)
    // 反空洞真：两个模块仍导出它们该有的东西（不是"整个模块被删了"）。
    expect('kernelRenderViewFromFace' in kernelRenderViewModule).toBe(true)
    expect('evaluationIdentityOf' in evaluationModule).toBe(true)
  })

  it('**负对照**：源码文本断言不是恒真（注释里的名字不算，真调用必被抓住）', () => {
    const prod = readSource('shared/viewport/useKernelChannels.ts')
    expect(stripCommentLines(prod)).not.toContain('kernelRenderViewOf(')
    expect(
      stripCommentLines(prod + '\nconst probe = kernelRenderViewOf({})'),
      '注入一行真调用必须被抓住',
    ).toContain('kernelRenderViewOf(')
    expect(
      stripCommentLines(prod + '\n// kernelRenderViewOf({})'),
      '注释里的名字不算调用（否则判据会被自己的说明判红）',
    ).not.toContain('kernelRenderViewOf(')
  })
})
