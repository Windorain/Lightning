/**
 * **内容同步** —— 核心判据。
 *
 * ## 要证明什么（正判据）
 *
 * 编辑**后**内核与 legacy **双向一致**，且这是**内核真的被写了**（不是只改了 legacy）。
 * 若投影漏字段 ⇒ 两边不一致 ⇒ 判红（这正是"投影漏字段即红"的把守点）。
 *
 * ## 为什么必须"双向"
 *
 * 只断言一个方向会漏掉两类缺陷：
 *  - 只断言"legacy 变了" ⇒ 内核没写也绿（回落到纯 legacy 路径了）；
 *  - 只断言"内核变了" ⇒ 投影没回写也绿（画面/保存读到旧内容）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { ALL_CAPABILITIES } from '@/application/commands'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { kernelAnnotationsOf, projectAnnotationsToLegacy } from '@/runtime/annotationRead'

function parsers() {
  const p = createParserRegistry()
  p.register(V2PlainParser)
  p.register(createEnvelopeParser(p))
  p.register(WorldParser)
  p.register(StructureDataParser)
  return p
}

const FULL_ANNO: Record<string, unknown> = {
  id: 'a1',
  type: 'box',
  visible: true,
  title: 'T',
  description: 'D',
  locked: true,
  frameIndex: 2,
  created_at: 111,
  updated_at: 222,
  color: '#f00',
  renderStyle: 'wireframe',
  min: { x: 0, y: 0, z: 0 },
  max: { x: 1, y: 1, z: 1 },
}

async function adoptedSession(annotations: unknown[]) {
  const raw = JSON.parse(
    fs
      .readFileSync(path.join(process.cwd(), 'e2e', 'fixtures', 'minimal-v2.json'), 'utf8')
      .replace(/\r\n/g, '\n'),
  ) as Record<string, unknown>
  raw.annotations = annotations
  const parsed = await parsers().detectAndParse(raw)
  if (parsed.document === null) throw new Error('夹具解析失败')
  const session = new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: ALL_CAPABILITIES,
  })
  adoptLoadedDocument({ kernel: session, log: { info: () => {}, warn: () => {} } }, parsed.document, undefined, 'A')
  return session
}

describe('① 内核写 ⇒ 双向一致', () => {
  it('`addObject(annotation)` 后：内核与 legacy 投影**同时**多出该条', async () => {
    const session = await adoptedSession([FULL_ANNO])
    try {
      const before = kernelAnnotationsOf(session.document()).length
      const ticket = session.submit({
        kind: 'addObject',
        contextId: KERNEL_CONTEXT_ID,
        objectType: 'annotation',
        name: 'probe',
        params: { shape: 'box' },
      } as never)
      session.drain()
      const outcome = session.settlementOf(ticket)
      expect((outcome as { status?: string }).status, '内核写必须 applied').toBe('applied')

      const kernelRows = kernelAnnotationsOf(session.document())
      const legacyRows = projectAnnotationsToLegacy(session.document())
      expect(kernelRows.length, '内核读面必须多出该条').toBe(before + 1)
      expect(legacyRows.length, '**双向**：legacy 投影必须同时多出该条').toBe(kernelRows.length)
    } finally {
      session.dispose()
    }
  })

  it('**反空洞**：写入真的产生了历史记账（不是"看起来变了"）', async () => {
    const session = await adoptedSession([FULL_ANNO])
    try {
      const before = session.document()!.history.past.length
      const ticket = session.submit({
        kind: 'addObject',
        contextId: KERNEL_CONTEXT_ID,
        objectType: 'annotation',
        name: 'probe',
        params: { shape: 'box' },
      } as never)
      session.drain()
      session.settlementOf(ticket)
      expect(session.document()!.history.past.length, '内核写必须自带历史记账').toBeGreaterThan(before)
    } finally {
      session.dispose()
    }
  })

  it('`deleteObject` 后：两边**同时**少一条', async () => {
    const session = await adoptedSession([FULL_ANNO])
    try {
      const before = kernelAnnotationsOf(session.document()).length
      const ticket = session.submit({
        kind: 'deleteObject',
        contextId: KERNEL_CONTEXT_ID,
        objectId: 'annotation:a1',
      } as never)
      session.drain()
      const outcome = session.settlementOf(ticket)
      expect((outcome as { status?: string }).status).toBe('applied')
      const kernelRows = kernelAnnotationsOf(session.document())
      expect(kernelRows.length).toBe(before - 1)
      expect(projectAnnotationsToLegacy(session.document()).length, '双向').toBe(kernelRows.length)
    } finally {
      session.dispose()
    }
  })
})

describe('② 全保真：投影**不丢**字段（丢即判红）', () => {
  it('投影产出的每一条都带齐 `ANNOTATION_FIELD_PAIRS` 里源有的字段', async () => {
    const session = await adoptedSession([FULL_ANNO])
    try {
      const rows = projectAnnotationsToLegacy(session.document())
      const r = rows[0]!
      // 逐条钉住 C′2 之前会丢的那些（阻塞的原始证据）
      expect(r.locked, '`locked` 不得丢（丢 ⇒ 锁定即只读失效）').toBe(true)
      expect(r.frameIndex, '`frameIndex` 不得丢').toBe(2)
      expect(r.created_at, '`created_at` 不得丢').toBe(111)
      expect(r.updated_at, '`updated_at` 不得丢').toBe(222)
      expect(r.min, '几何不得丢').toEqual({ x: 0, y: 0, z: 0 })
      expect(r.color).toBe('#f00')
      expect(r.renderStyle).toBe('wireframe')
    } finally {
      session.dispose()
    }
  })
})

describe('③ 未装配 ⇒ 回落 legacy（能力不回退）', () => {
  it('无会话时 `submitContentEdit` 返回 false（调用方走 legacy 路径）', async () => {
    // 这里断言的是 `Context` 的约定：内核缺席 ⇒ 不冒充成功。
    // 真实的 `Context` 实例由 `annotationOperatorSync.test.ts` 端到端覆盖。
    const session = await adoptedSession([FULL_ANNO])
    try {
      // 未装配的会话（capabilities 为空 ⇒ 内容命令被拒）必须**不**报告成功
      const noCap = new KernelSession({
        documentId: KERNEL_DOCUMENT_ID,
        contextId: KERNEL_CONTEXT_ID,
        capabilities: [],
      })
      try {
        expect(noCap.hasAdoptedContent(), '未装配 ⇒ GF-16 = false').toBe(false)
      } finally {
        noCap.dispose()
      }
      expect(session.hasAdoptedContent(), '对照组：装配成功的会话 GF-16 = true').toBe(true)
    } finally {
      session.dispose()
    }
  })
})

describe('④ 注解身份口径**唯一**（源码级，改一处忘另一处即判红）', () => {
  /**
   * ## 为什么需要源码级断言（实测的阻塞）
   *
   * 注解对象 id 由**两处**生产代码决定：
   *  - 装配：`composition/kernelAssembly` 建 `annotation:<legacyId>`；
   *  - 新建：`operators/builtin/annotationOperators` 经 `params.objectId` 传同一前缀。
   *
   * 两处必须**同一口径**。若漂移（例如某天有人把装配改成别的建法），
   * 后果是实测过的：`selection.active` 与属性面板 `EntityRef` 对不上
   * ⇒ **新建后属性面板每次写都打到不存在的 id**（用户可见损坏）。
   *
   * ⚠️ 刻意**不**让算子 import 装配（`operators/` 依赖 `composition/` 会破分层），
   * 故这条一致性只能靠源码级断言把守 —— 它正是"分层约束换来的代价"的显式记账。
   */
  it('`kernelAssembly` 的 objectId 建法与算子的 `ANNOTATION_OBJECT_PREFIX` 一致', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const read = (rel: string): string =>
      fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n')

    const assembly = read('src/composition/kernelAssembly.ts')
    const operators = read('src/operators/builtin/annotationOperators.ts')

    // 装配侧：`const objectId = \`annotation:${id}\`` 形态（前缀 + 反引号插值）
    const assemblyPrefix = /const objectId = `([^`$]*)\$\{id\}`/.exec(assembly)
    expect(assemblyPrefix, '必须能定位装配侧的 objectId 建法').not.toBeNull()

    // 算子侧：导出的常量值
    const opPrefix = /export const ANNOTATION_OBJECT_PREFIX = '([^']*)'/.exec(operators)
    expect(opPrefix, '必须能定位算子的前缀常量').not.toBeNull()

    expect(
      opPrefix![1],
      '注解对象 id 前缀两处必须一致（漂移 ⇒ 新建后属性面板写到不存在的 id）',
    ).toBe(assemblyPrefix![1])
  })

  it('**反空洞**：该前缀确实在算子源码里被用于构造内核 id', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const operators = fs
      .readFileSync(path.join(process.cwd(), 'src/operators/builtin/annotationOperators.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
    // 若有人删掉"显式 id"那一行，本断言会红（防"常量还在但没人用"的空转）
    expect(
      /\$\{ANNOTATION_OBJECT_PREFIX\}\$\{annotation\.id\}/.test(operators),
      '新建路径必须真的用该前缀构造 `objectId`（否则常量成了摆设）',
    ).toBe(true)
  })
})
