/**
 * **P10f C′2 判据：注解算子的写路径分派**（#301）。
 *
 * ## 要证明什么
 *
 * 3 个注解算子（新建/更新/删除）在**装配成功**时走**内核命令 + 投影回写**
 * （裁决 1），且 legacy 拿到的是**内核投影**（不是它们自己 clone 的旧结构）。
 *
 * ## 为什么用真 `Context`（`Object.create(Context.prototype)`）
 *
 * C′1 的教训：测试宿主**复刻**被测算法会让判据**空转**
 * （把生产实现改坏，测试仍全绿）。⇒ 本文件让 `ctx` 是**真 Context**，
 * 于是 `ctx.submitContentEdit` / `ctx.syncLegacyFromKernel` 执行的是**生产实现本体**。
 *
 * ## 判据的核心（"双向一致 + 走的是内核"）
 *
 * 只断言"legacy 多了一条"是**假绿**：回落路径也会那样。
 * ⇒ 必须同时断言**内核**真的变了（`history.past` 增加 + 内核读面条数变）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { Context } from '@/runtime/context'
import { ref, type Ref } from 'vue'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { ALL_CAPABILITIES } from '@/application/commands'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { kernelAnnotationsOf } from '@/runtime/annotationRead'
import {
  AnnotationCreateOperator,
  AnnotationDeleteOperator,
  AnnotationUpdateOperator,
} from '@/operators/builtin/annotationOperators'

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
  created_at: 111,
  updated_at: 222,
  min: { x: 0, y: 0, z: 0 },
  max: { x: 1, y: 1, z: 1 },
}

interface Harness {
  ctx: Context
  session: KernelSession
  /**
   * **测试侧**对"被跟踪的 legacy 文档"的观测口（#301 P10f D3）。
   *
   * `getDoc()` 已退出生产 ⇒ 双轨判据的 legacy 侧只能从宿主观测
   *（宿主持有被生产代码替换过的那份 `docRef`），故"内核写了、legacy 没投影"
   * 这类缺陷**照样判红**。理由与手法见 `runtime/__tests__/kernelReadTestHost`。
   */
  legacyDocument(): RuntimeDocument | null
  dispose(): void
}

/** 真 `Context` + 真装配（走生产 `adoptLoadedDocument`）。 */
async function harness(annotations: unknown[], capabilities: readonly string[]): Promise<Harness> {
  const raw = JSON.parse(
    fs
      .readFileSync(path.join(process.cwd(), 'e2e', 'fixtures', 'minimal-v2.json'), 'utf8')
      .replace(/\r\n/g, '\n'),
  ) as Record<string, unknown>
  raw.annotations = annotations
  const parsed = await parsers().detectAndParse(raw)
  const doc = parsed.document!
  const docRef = ref(doc) as unknown as Ref<RuntimeDocument | null>
  const session = new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities,
  })
  adoptLoadedDocument({ kernel: session, log: { info: () => {}, warn: () => {} } }, doc, undefined, 'A')

  // 真 Context：只注入本算子用到的字段（`main.doc` / `kernel` / 选择集）
  const selected = ref<{ id: string } | null>(null)
  const ctx = Object.create(Context.prototype) as Context
  Object.assign(ctx as unknown as Record<string, unknown>, {
    main: { doc: docRef },
    kernel: session,
    getSelection: () => ({ active: selected, items: ref(new Set()) }),
    setDocument: (next: RuntimeDocument | null, intent: 'load' | 'content-sync' = 'load') =>
      // 复刻**唯一写者**的两段（镜像半边由 p10fDocumentLifecycle 把守）
      (Context.prototype as unknown as { setDocument: (n: RuntimeDocument | null, i: string) => void })
        .setDocument.call(ctx, next, intent),
  })
  // `main.replaceDoc` 生产里就是"写 Ref + bump 信号"
  Object.assign((ctx as unknown as { main: Record<string, unknown> }).main, {
    replaceDoc: (d: RuntimeDocument | null) => {
      docRef.value = d
    },
  })
  return {
    ctx,
    session,
    // 测试宿主的 legacy 观测口（见 `Harness#legacyDocument` 的说明）。
    legacyDocument: () => docRef.value,
    dispose: () => session.dispose(),
  }
}

describe('P10f C′2 · 注解算子走内核写（装配成功时）', () => {
  it('**新建**：内核与 legacy 同时多一条，且内核有历史记账', async () => {
    const h = await harness([FULL_ANNO], ALL_CAPABILITIES)
    try {
      const kernelBefore = kernelAnnotationsOf(h.session.document()).length
      const pastBefore = h.session.document()!.history.past.length

      AnnotationCreateOperator.exec!(h.ctx as never, {
        annotation: {
          id: 'a2',
          type: 'box',
          visible: true,
          title: 'NEW',
          description: '',
          min: { x: 2, y: 0, z: 0 },
          max: { x: 3, y: 1, z: 1 },
        },
      } as never)

      const kernelRows = kernelAnnotationsOf(h.session.document())
      expect(kernelRows.length, '**内核**必须多出该条（否则只是回落 legacy）').toBe(kernelBefore + 1)
      expect(
        h.session.document()!.history.past.length,
        '内核写必须产生历史记账（这是"真的走了内核"的机械证据）',
      ).toBeGreaterThan(pastBefore)
      // legacy 侧：投影产物必须也含该条（回写生效）
      // #301 P10f D3：`getDoc()` 已退出生产 ⇒ legacy 侧经**测试宿主的观测口**
      //（它持有那份被替换过的 `docRef`）。⚠️ 这仍然证明"两侧都有"：
      // `h.legacyDocument()` 拿的是**生产回写投影**替换后的那一份（不是输入副本），
      // 故"内核写了、legacy 没投影"（#333 同族）在这里**照样判红**。
      const legacy = (h.legacyDocument()?.annotations ?? []) as Record<string, unknown>[]
      expect(legacy.length, '**双向**：legacy 也必须多出该条（投影回写生效）').toBe(kernelRows.length)
      expect(legacy.some((a) => a.id === 'a2'), 'legacy 里必须有刚建的那条').toBe(true)
    } finally {
      h.dispose()
    }
  })

  it('**删除**：两边同时少一条', async () => {
    const h = await harness([FULL_ANNO], ALL_CAPABILITIES)
    try {
      const kernelBefore = kernelAnnotationsOf(h.session.document()).length
      AnnotationDeleteOperator.exec!(h.ctx as never, { id: 'a1' } as never)
      const kernelRows = kernelAnnotationsOf(h.session.document())
      expect(kernelRows.length, '内核必须少一条').toBe(kernelBefore - 1)
      // #301 P10f D3：`getDoc()` 已退出生产 ⇒ legacy 侧经**测试宿主的观测口**
      //（它持有那份被替换过的 `docRef`）。⚠️ 这仍然证明"两侧都有"：
      // `h.legacyDocument()` 拿的是**生产回写投影**替换后的那一份（不是输入副本），
      // 故"内核写了、legacy 没投影"（#333 同族）在这里**照样判红**。
      const legacy = (h.legacyDocument()?.annotations ?? []) as Record<string, unknown>[]
      expect(legacy.length, '双向：legacy 也必须少一条').toBe(kernelRows.length)
    } finally {
      h.dispose()
    }
  })

  it('**更新 title**：内核与 legacy 的 title 同时变成新值', async () => {
    const h = await harness([FULL_ANNO], ALL_CAPABILITIES)
    try {
      AnnotationUpdateOperator.exec!(h.ctx as never, { id: 'a1', patch: { title: 'RENAMED' } } as never)
      const kernelRows = kernelAnnotationsOf(h.session.document())
      expect(kernelRows[0]!.title, '内核侧 title 必须更新').toBe('RENAMED')
      // #301 P10f D3：`getDoc()` 已退出生产 ⇒ legacy 侧经**测试宿主的观测口**
      //（它持有那份被替换过的 `docRef`）。⚠️ 这仍然证明"两侧都有"：
      // `h.legacyDocument()` 拿的是**生产回写投影**替换后的那一份（不是输入副本），
      // 故"内核写了、legacy 没投影"（#333 同族）在这里**照样判红**。
      const legacy = (h.legacyDocument()?.annotations ?? []) as Record<string, unknown>[]
      expect(legacy[0]!.title, '双向：legacy 侧 title 也必须更新').toBe('RENAMED')
      // 全保真：更新 title **不得**顺手丢掉其它字段
      expect(legacy[0]!.locked, '更新时不得丢 `locked`（全保真回写）').toBe(true)
      expect(legacy[0]!.created_at, '更新时不得丢 `created_at`').toBe(111)
      expect(legacy[0]!.min, '更新时不得丢几何').toEqual({ x: 0, y: 0, z: 0 })
    } finally {
      h.dispose()
    }
  })

  it('**更新非内核字段**（如 `description` 之外的补丁）⇒ 整体回落 legacy（不部分写）', async () => {
    const h = await harness([FULL_ANNO], ALL_CAPABILITIES)
    try {
      // `renderStyle` 不在本批迁移的字段集里（内核写端口未实现它）
      AnnotationUpdateOperator.exec!(h.ctx as never, { id: 'a1', patch: { renderStyle: 'translucent' } } as never)
      // #301 P10f D3：`getDoc()` 已退出生产 ⇒ legacy 侧经**测试宿主的观测口**
      //（它持有那份被替换过的 `docRef`）。⚠️ 这仍然证明"两侧都有"：
      // `h.legacyDocument()` 拿的是**生产回写投影**替换后的那一份（不是输入副本），
      // 故"内核写了、legacy 没投影"（#333 同族）在这里**照样判红**。
      const legacy = (h.legacyDocument()?.annotations ?? []) as Record<string, unknown>[]
      expect(legacy[0]!.renderStyle, '回落路径必须生效（legacy 真的被改了）').toBe('translucent')
    } finally {
      h.dispose()
    }
  })
})

describe('P10f C′2 · 回落：无内容编辑能力时走 legacy', () => {
  it('`VIEWER_CAPABILITIES`（无 content.add）⇒ 内核拒绝 ⇒ legacy 路径生效', async () => {
    const h = await harness([FULL_ANNO], ['interaction.begin'])
    try {
      const kernelBefore = kernelAnnotationsOf(h.session.document()).length
      AnnotationCreateOperator.exec!(h.ctx as never, {
        annotation: { id: 'a9', type: 'box', visible: true, title: 'X', min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      } as never)
      // 能力不足 ⇒ 内核拒绝 ⇒ 不得谎报成功；legacy 走原路径（能力不回退）
      expect(kernelAnnotationsOf(h.session.document()).length, '能力不足时内核不得变').toBe(kernelBefore)
      // #301 P10f D3：`getDoc()` 已退出生产 ⇒ legacy 侧经**测试宿主的观测口**
      //（它持有那份被替换过的 `docRef`）。⚠️ 这仍然证明"两侧都有"：
      // `h.legacyDocument()` 拿的是**生产回写投影**替换后的那一份（不是输入副本），
      // 故"内核写了、legacy 没投影"（#333 同族）在这里**照样判红**。
      const legacy = (h.legacyDocument()?.annotations ?? []) as Record<string, unknown>[]
      expect(legacy.some((a) => a.id === 'a9'), '回落路径必须让 legacy 拿到该条（能力不回退）').toBe(true)
    } finally {
      h.dispose()
    }
  })
})
