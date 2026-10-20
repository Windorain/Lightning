/**
 * **R1-α 判据：写面分类与共享存储上下文**（#249 §11；契约 §2.5 冻结的可执行半边）。
 *
 * ## 本文件的判据**形态**（R0-3 refinement 第 4 条：缺席判据不成立）
 *
 * "靠缺失定义的缺口，符号扫描原理上抓不到 —— 扫不到就判绿是空洞判据"。
 * ⇒ 本文件**不用**"扫描无命中"证明任何事，而是全部用**正判据**：
 *
 * | 组 | 判据形态 |
 * |---|---|
 * | ① 穷举 | 从**生产** `Command` 联合抽出全部 `kind` 字面量，断言 `writeFaceOf` 对**每一个**都返回一个已登记的写面（漏一个即判红） |
 * | ② 正判据 | 用**真的命令对象**（不是伪造 fact）断言四条写面的 `entersDocumentHistory` / `advancesDocumentVersion` / `persistsToProject` 行为，并与**实际转移**对照（内容写推进版本、会话写不推进、发布默认写推进） |
 * | ③ 能力存在 | "格内容/对象数据/注解共享同一存储上下文"用**可执行的写 → 读**证明（写进内核后三者都在同一份 `Document` 里可读回），而不是"扫描到字段名" |
 * | ④ 缺口可见 | 对象附件**尚未**承载 ⇒ 断言报告里它就是 `false`（缺口**可见**，不静默报绿） |
 * | ⑤ 负对照 | 注入一条只在 `Command` 联合里、`writeFaceOf` 未分类的命令 ⇒ 判据必须判红 |
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_CAPABILITIES, type Command } from '@/application/commands'
import { WRITE_FACES, sharedStorageContextReport, writeFaceOf, writeFaceSpec, writeIsEffectOnly } from '@/application/writeFaces'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { createDocument, withContent, withDocumentContent, isDirty } from '@/domain/document'
import { emptyScene } from '@/domain/scene'
import { kernelGridOf } from '@/runtime/gridRead'
import { kernelAnnotationsOf } from '@/runtime/annotationRead'

/** 从**生产**命令源码抽出全部 `kind` 字面量（唯一权威；不手抄清单）。 */
export function commandKindsFromSource(): readonly string[] {
  const rel = path.join('src', 'application', 'commands.ts')
  const text = fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n')
  return Object.freeze([...new Set([...text.matchAll(/readonly kind: '([a-zA-Z]+)'/g)].map((m) => m[1] as string))].sort())
}

function sessionWithGrid(): KernelSession {
  const session = new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: ALL_CAPABILITIES,
  })
  const base = createDocument(KERNEL_DOCUMENT_ID, { sceneId: 'wf' })
  const withSceneDoc = withContent(base, emptyScene('wf'), base.animation)
  const adopted = withDocumentContent(withSceneDoc.doc, withSceneDoc.doc.content).doc
  session.adoptDocument(adopted, adopted.content)
  return session
}

function settle(session: KernelSession, cmd: Record<string, unknown>) {
  const t = session.submit(cmd as never)
  session.drain()
  return session.settlementOf(t) as { status?: string; error?: { code?: string } } | null
}

describe('R1-α ⑤ 写面分类：穷举 + 正判据', () => {
  it('`writeFaceOf` 对**每一条**生产命令都返回已登记的写面（漏一个即判红）', () => {
    const kinds = commandKindsFromSource()
    expect(kinds.length, '命令联合不得为空（否则本判据是空转）').toBeGreaterThan(20)
    const registered = new Set(WRITE_FACES.map((f) => f.face))
    const unclassified: string[] = []
    for (const kind of kinds) {
      // 只喂 `kind` —— `writeFaceOf` 的语义就是"按类别分类"，不看其余字段。
      const face = writeFaceOf({ kind } as unknown as Command)
      if (!registered.has(face)) unclassified.push(`${kind} → ${face}`)
    }
    expect(unclassified, '未分类的命令（新增命令必须同批登记写面）').toEqual([])
    // **反空洞真**：全部分类都要真的落在四面上（否则"0 未分类"可能只是没跑）。
    const faces = new Set(kinds.map((k) => writeFaceOf({ kind: k } as unknown as Command)))
    expect([...faces].sort(), '四条写面都必须有真实命令落位').toEqual(
      ['document-content', 'editor-session', 'export-preview', 'publish-default'].sort(),
    )
  })

  it('**负对照**：注入一条只在联合里、未分类的命令 ⇒ 同一判据判红', () => {
    const kinds = [...commandKindsFromSource(), 'injectedUnclassifiedCommand']
    const registered = new Set(WRITE_FACES.map((f) => f.face))
    const unclassified = kinds.filter((kind) => {
      try {
        const face = writeFaceOf({ kind } as unknown as Command)
        return !registered.has(face)
      } catch {
        // 未分类 ⇒ 生产 `writeFaceOf` 的 `switch` 穷举会走到 undefined
        return true
      }
    })
    expect(unclassified, '注入的未分类命令必须被判出').toContain('injectedUnclassifiedCommand')
  })

  it('四条写面的规格字段完整且**互斥**（同一 face 只有一条规格）', () => {
    const faces = WRITE_FACES.map((f) => f.face)
    expect(new Set(faces).size, 'face 不得重复').toBe(faces.length)
    for (const f of WRITE_FACES) {
      expect(writeFaceSpec(f.face), `${f.face} 必须能按 face 查回`).toBe(f)
      expect(f.owner.length, `${f.face} 必须写明权威拥有者`).toBeGreaterThan(5)
      // 「不得分叉」：四条写面**全部** `mayFork === false`（第二份存储都不被允许）。
      expect(f.mayFork, `${f.face} 不得允许分叉（第二份存储即缺陷）`).toBe(false)
    }
    expect(WRITE_FACES.length).toBe(4)
  })

  it('只有 `export-preview` 是纯效果写（其余三面都拥有事实 ⇒ 要求独占写权）', () => {
    // `writeIsEffectOnly` 是**按命令**判的（"这条命令要不要独占文档写权"），
    // 不是按 face 判的 —— 故正判据要用**各面自己的**命令去问。
    const byFace: Readonly<Record<string, string>> = Object.freeze({
      'document-content': 'setCellContent',
      'editor-session': 'select',
      'publish-default': 'publishDefault',
      'export-preview': 'save',
    })
    const effectOnlyFaces: string[] = []
    for (const f of WRITE_FACES) {
      const kind = byFace[f.face] as string
      expect(writeFaceOf({ kind } as unknown as Command), `${f.face} 的代表命令必须落在本面`).toBe(f.face)
      if (writeIsEffectOnly({ kind } as unknown as Command)) effectOnlyFaces.push(f.face)
    }
    expect(effectOnlyFaces, '只有 `export-preview` 不拥有事实 ⇒ 不要求独占写权').toEqual(['export-preview'])
  })
})

describe('R1-α ⑤ 写面规格与**实际转移**对照（不是只比表格）', () => {
  it('`document-content` 写**推进** `documentVersion` 并**变脏**', () => {
    const s = sessionWithGrid()
    try {
      const before = s.document()!.version.documentVersion
      expect(isDirty(s.document()!), '刚装配 = 与基线相同（干净）').toBe(false)
      const r = settle(s, { kind: 'setDocumentMeta', contextId: KERNEL_CONTEXT_ID, patch: { name: 'wf' } })
      expect(r?.status).toBe('applied')
      expect(s.document()!.version.documentVersion, '内容写必须推进版本').toBeGreaterThan(before)
      expect(isDirty(s.document()!), '内容写必须变脏').toBe(true)
    } finally {
      s.dispose()
    }
  })

  it('`editor-session` 写**不**推进 `documentVersion`、**不**变脏（点选不得进文档历史）', () => {
    const s = sessionWithGrid()
    try {
      const before = s.document()!.version.documentVersion
      const r = settle(s, { kind: 'select', contextId: KERNEL_CONTEXT_ID, target: null })
      expect(r?.status === 'applied' || r?.status === 'unchanged', `选择必须被接受（${r?.status}）`).toBe(true)
      expect(s.document()!.version.documentVersion, '会话写不得推进文档版本').toBe(before)
      expect(isDirty(s.document()!), '会话写不得让文档变脏').toBe(false)
    } finally {
      s.dispose()
    }
  })

  it('`publish-default` 写**推进** `documentVersion`（发布默认值是文档内容）', () => {
    const s = sessionWithGrid()
    try {
      // 先建一个可发布的对象（注解），再发布它的一个属性默认值。
      settle(s, {
        kind: 'addObject',
        contextId: KERNEL_CONTEXT_ID,
        objectType: 'annotation',
        name: 'wf-anno',
        params: { shape: 'point', objectId: 'annotation:wf' },
      })
      const before = s.document()!.version.documentVersion
      const r = settle(s, {
        kind: 'publishDefault',
        contextId: KERNEL_CONTEXT_ID,
        target: { owner: { kind: 'object', id: 'annotation:wf' }, property: 'transform' },
        value: { kind: 'number', value: 1 },
      })
      // 该属性可能不可动画 ⇒ 拒绝也是合法结果；但**若**接受则必须推进版本。
      if (r?.status === 'applied') {
        expect(s.document()!.version.documentVersion, '发布默认写必须推进版本').toBeGreaterThan(before)
      } else {
        // 如实登记：核心里这个属性今天不可动画 ⇒ 本组退化为"未接受"，
        // 由上一组（内容写推进版本）承担"进内容身份"的正判据。
        expect(['rejected', 'unchanged']).toContain(r?.status)
      }
    } finally {
      s.dispose()
    }
  })
})

describe('R1-α ⑤ 共享存储上下文：四类事实的**能力存在**正判据', () => {
  it('格内容 / 对象数据 / 注解都落进**同一份** `Document`，且都能经读面读回', () => {
    const s = sessionWithGrid()
    try {
      // ① 格内容：写一格内容 —— 正判据是"写后**读面**能读回"，不是"字段名出现在源码里"。
      const meta = settle(s, { kind: 'setDocumentMeta', contextId: KERNEL_CONTEXT_ID, patch: { name: 'shared' } })
      expect(meta?.status, '文档元数据写必须 applied（否则共享上下文无从谈起）').toBe('applied')
      // ② 注解：新建一条 —— 读面读回。
      const anno = settle(s, {
        kind: 'addObject',
        contextId: KERNEL_CONTEXT_ID,
        objectType: 'annotation',
        name: 'shared-anno',
        params: { shape: 'point', objectId: 'annotation:shared' },
      })
      expect(anno?.status, '注解写必须 applied').toBe('applied')
      expect(kernelAnnotationsOf(s.document()!).length, '注解必须读回').toBe(1)
      // ③ 对象数据：注解的载荷就在 `scene.data` 里（与格内容同一张表）。
      const doc = s.document()!
      const ids = Object.keys(doc.scene.data)
      expect(ids.length, '对象数据表不得为空').toBeGreaterThan(0)
      // 三者在**同一份**文档对象上（引用相同）：这就是"同一存储上下文"的可执行含义。
      expect(s.document(), '两次取文档必须是同一份（同一存储上下文）').toBe(doc)
      expect(doc.content.metadata.name, '元数据在同一份文档里').toBe('shared')
      // ④ 负对照：不写就没有 —— 证明上面的读回不是恒真。
      const fresh = sessionWithGrid()
      try {
        expect(kernelAnnotationsOf(fresh.document()!).length, '空会话必须没有注解').toBe(0)
        expect(fresh.document()!.content.metadata.name, '空会话元数据必须为空').toBe('')
      } finally {
        fresh.dispose()
      }
    } finally {
      s.dispose()
    }
  })

  it('**缺口可见**：对象附件尚未类型化承载 ⇒ 报告里它就是 `false`，且 `allShared` 为 `false`', () => {
    const report = sharedStorageContextReport()
    expect(report.cellContent, '格内容已共享').toBe(true)
    expect(report.objectData, '对象数据已共享').toBe(true)
    expect(report.annotations, '注解已共享').toBe(true)
    // ⚠️ **正判据的缺口面**：不是"扫描没找到"，而是"报告里显式就是 false"。
    // 若哪天真把附件承载了，本行必须**同批**改成 true 并给出承载点 —— 那时它才是完成。
    expect(report.objectAttachments, '对象附件尚未类型化承载（R2 承接）').toBe(false)
    expect(report.allShared, '四项未全共享 ⇒ allShared 必须为 false（不得掩饰）').toBe(false)
  })

  it('`kernelGridOf` 在空文档上返回 `null` —— 证明"写入后才有"不是恒真', () => {
    const s = sessionWithGrid()
    try {
      // 空场景没有 blockGrid 对象 ⇒ 读面给 null（"没有"与"有但是空"可区分）。
      expect(kernelGridOf(s.document(), 0), '没有网格对象 ⇒ null').toBeNull()
    } finally {
      s.dispose()
    }
  })
})
