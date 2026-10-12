/**
 * **P10f D2 判据：保存/导出改吃内核投影**（#301）。
 *
 * ## 要证明什么
 *
 * 1. **等价**（本组核心）：对**真实夹具**，内核投影出的 plain 与 legacy
 *    `RuntimeDocument.serialize()` **逐键等价** ⇒ 迁移不改产物（能力不回退）；
 * 2. **全保真**：注解的 `locked`/`created_at`/`min`/`max`/`pos` 等经投影**不丢**
 *    （这是本批实测抓出的**能力回退风险**：渲染态投影只写 5 个字段）；
 * 3. **保真字段**：源文件的未知顶层字段经投影**写回产物**（G-6(c) 的落点）；
 * 4. **如实降级**：无会话 / 未装配 ⇒ 返回 `ok: false`（调用方回落 legacy），
 *    **不伪造**一份"看起来能用"的空产物。
 *
 * ## 为什么 1 是最强判据
 *
 * 迁移的正当性全部押在"投影产物 === 旧 serialize 产物"上。若两者不等，
 * 用户存出来的文件就变了 —— 那是**静默的数据变化**，比报错更难发现。
 * ⇒ 用真实夹具逐键比对，而不是"投影没抛错就算过"。
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { readJson, fixturePath } from '@/context/__tests__/multiblockFixtureIo.mjs'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { ALL_CAPABILITIES } from '@/application/commands'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { createDocument, withContent, withDocumentContent } from '@/domain/document'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { projectKernelSaveView } from '@/composition/saveProjection'

function productionParsers() {
  const p = createParserRegistry()
  p.register(V2PlainParser)
  p.register(createEnvelopeParser(p))
  p.register(WorldParser)
  p.register(StructureDataParser)
  return p
}

const NOOP_LOG = { info: () => {}, warn: () => {} }

/**
 * 读一份真实夹具的 raw。
 *
 * - `'envelope'` = 真实信封（与 `projectionFidelity.test.ts` **同一份**；
 *   它在 `e2e/fixtures/`，与多方块夹具不同目录）；
 * - 其余名字走多方块夹具目录。
 */
function rawOf(name: string): Record<string, unknown> {
  if (name === 'envelope') {
    return JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'e2e', 'fixtures', 'structuredata-exported-envelope.json'), 'utf8'),
    ) as Record<string, unknown>
  }
  return readJson(fixturePath(name)) as Record<string, unknown>
}

/** 装载一份真实夹具并返回（会话, legacy 文档）。`async`：`detectAndParse` 是异步的。 */
async function loaded(
  name: string,
): Promise<{ session: KernelSession; legacy: { serialize: () => Record<string, unknown> } }> {
  const raw = rawOf(name)
  const parsed = await productionParsers().detectAndParse(raw)
  // ⚠️ `=== null` 判据不够：初版漏了 `await` 时 `parsed` 是 Promise，
  // `parsed.document` 是 `undefined` ⇒ 守卫**没拦住**，缺陷以
  // `Cannot read properties of undefined (reading 'isMultiblock')` 的形式
  // 在下游四层之外爆出（难定位）。⇒ 判"**非文档即失败**"，而不是只判 `null`。
  if (parsed.document === null || parsed.document === undefined) throw new Error(`夹具 ${name} 解析失败`)
  const session = new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: ALL_CAPABILITIES,
  })
  // 走**生产装配路径**（不是手搓会话）—— 这样装配面/保真字段都由真代码填。
  const ok = adoptLoadedDocument({ kernel: session, log: NOOP_LOG }, parsed.document as never, raw, name)
  if (!ok) throw new Error(`夹具 ${name} 装配失败`)
  return { session, legacy: parsed.document as never }
}

describe('P10f D2 · ① 等价：内核投影产物 === legacy serialize 产物（真实夹具）', () => {
  // 两份形态各一的真实夹具：`envelope`（真实信封 = 帧为主）与
  // `multiblock-tier-only`（多方块）。两者走不同的投影分支（内层 body 重建 vs 帧展开）
  // ⇒ 都要判，否则"只覆盖一种形态"。
  for (const name of ['envelope', 'multiblock-tier-only']) {
    it(`**逐键等价**（${name}）：投影 plain 与 legacy serialize 的键集与值一致`, async () => {
      const { session, legacy } = await loaded(name)
      try {
        const projected = projectKernelSaveView(session)
        expect(projected.ok, '前提：该夹具必须装配成功').toBe(true)
        if (!projected.ok) return

        const fromKernel = projected.plain as Record<string, unknown>
        const fromLegacy = legacy.serialize() as Record<string, unknown>

        const keysK = Object.keys(fromKernel).sort()
        const keysL = Object.keys(fromLegacy).sort()
        // 键集差异**分开报**（只报"两个数组不等"无法定位是少还是多）。
        const onlyKernel = keysK.filter((k) => !keysL.includes(k))
        const onlyLegacy = keysL.filter((k) => !keysK.includes(k))
        expect(
          { onlyKernel, onlyLegacy },
          `顶层键集必须一致。仅内核有：${onlyKernel.join(',') || '(无)'}；仅 legacy 有：${onlyLegacy.join(',') || '(无)'}`,
        ).toEqual({ onlyKernel: [], onlyLegacy: [] })

        // 逐键比对；不等的键必须**显式列出**（而不是只报一个总数）。
        const diff: string[] = []
        for (const k of keysL) {
          const a = JSON.stringify(fromKernel[k])
          const b = JSON.stringify(fromLegacy[k])
          if (a !== b) diff.push(`${k}: kernel=${(a ?? '').slice(0, 200)} legacy=${(b ?? '').slice(0, 200)}`)
        }
        expect(diff, `以下键的投影产物与 legacy 不一致：\n${diff.join('\n')}`).toEqual([])
      } finally {
        session.dispose()
      }
    })
  }
})

describe('P10f D2 · ② 全保真：注解字段经投影**不丢**（本批实测的能力回退风险）', () => {
  it('**注入式**：内核里有 `locked`/`created_at` 时，投影产物必须带上它们', () => {
    const session = new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: ALL_CAPABILITIES,
    })
    try {
      const base = createDocument(KERNEL_DOCUMENT_ID, { sceneId: 'annot-scene' })
      // 一个带**全字段**几何的注解对象。
      const obj = {
        id: 'annotation:ann-1',
        type: 'annotation' as const,
        name: 'ann-1',
        visible: true,
        dataId: 'annotation:ann-1:data',
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      }
      const data = {
        id: 'annotation:ann-1:data',
        source: 'document' as const,
        payload: {
          kind: 'annotation' as const,
          shape: 'box',
          text: 'T\n\nD',
          geometry: {
            min: { x: 0, y: 0, z: 0 },
            max: { x: 1, y: 1, z: 1 },
            color: '#ff0000',
            renderStyle: 'solid',
            locked: true,
            frameIndex: 2,
            createdAt: 111,
            updatedAt: 222,
          },
        },
      }
      const scene = { id: 'annot-scene', objects: { [obj.id]: obj }, data: { [data.id]: data }, collections: {}, order: [obj.id] }
      const withSceneDoc = withContent(base, scene as never, base.animation)
      const adopted = withDocumentContent(withSceneDoc.doc, withSceneDoc.doc.content).doc
      session.adoptDocument(adopted, adopted.content)
      // 装配面：本用例手工造会话 ⇒ 显式给出帧映射（否则投影按 scene.order 推导，
      // 而这里有注解对象 ⇒ 会把注解当帧！⇒ 必须显式给）。
      session.setAssemblyFace({ frameObjects: [], multiblock: null })

      const projected = projectKernelSaveView(session)
      expect(projected.ok, '投影必须成功').toBe(true)
      if (!projected.ok) return
      const rows = (projected.plain as Record<string, unknown>).annotations as Record<string, unknown>[]
      expect(rows.length, '必须投出 1 条注解').toBe(1)
      const row = rows[0]!
      // 渲染态投影**只会**给这 5 个字段；下面每一个"额外"字段都是全保真的证据。
      expect(row.id).toBe('ann-1')
      expect(row.type).toBe('box')
      expect(row.visible).toBe(true)
      expect(row.title).toBe('T')
      expect(row.description).toBe('D')
      expect(row.locked, '`locked` = "锁定即只读"的判定依据，丢了会**静默可写**').toBe(true)
      expect(row.frameIndex, '`frameIndex` 丢了会让注解跑到错误的帧上').toBe(2)
      expect(row.created_at, '蛇形命名是**格式约定**（正向映射的另一半）').toBe(111)
      expect(row.updated_at).toBe(222)
      expect(row.color).toBe('#ff0000')
      expect(row.renderStyle).toBe('solid')
      expect(row.min).toEqual({ x: 0, y: 0, z: 0 })
      expect(row.max).toEqual({ x: 1, y: 1, z: 1 })
    } finally {
      session.dispose()
    }
  })
})

describe('P10f D2 · ③ 如实降级（不伪造产物）', () => {
  it('**无会话 ⇒ `ok: false`**（调用方回落 legacy；不返回空产物）', () => {
    const r = projectKernelSaveView(null)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('no-session')
  })

  it('**未装配 ⇒ `ok: false`**（GF-16：内核不是权威）', () => {
    const s = new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: ALL_CAPABILITIES,
    })
    try {
      const r = projectKernelSaveView(s)
      expect(r.ok, '未装配必须如实失败 —— 返回空产物会让用户存下**空文件**').toBe(false)
      if (r.ok) return
      expect(r.reason).toBe('not-adopted')
    } finally {
      s.dispose()
    }
  })
})
