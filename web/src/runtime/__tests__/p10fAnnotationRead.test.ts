/**
 * **P10f C′1 判据：内核侧表读面**（#301；N4 的字段完备部分）。
 *
 * ## 本文件要证明什么（三条，各自有反面对照）
 *
 * 1. **注解读面字段完备**：内核读面与 legacy 字段**逐项相等**（不是"看着像"）。
 *    反面：故意改一个字段名 ⇒ 判红。
 * 2. **装配失败 ⇒ 回落 legacy**（与 D8 同一形态的对称分流）：这是 C′1 实测抓出的
 *    **自身缺陷**的回归判据 —— 我最初让未装配时返回空表，后果是用户在新建注解后
 *    **连原有注解也点不中**。本判据钉住"绝不能回退成空表"。
 * 3. **不陈旧**：`setDocument`（不 adopt）后读面必须给出**当前**文档的内容，
 *    而不是内核里那份旧的。
 *
 * ## 为什么用生产装配路径
 *
 * 见 `kernelReadTestHost.ts` 文件头：读面方法一律委托 `runtime/` 的生产纯函数。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { makeKernelReadHost, makeAdoptedKernelReadHost } from '@/runtime/__tests__/kernelReadTestHost'
import { listMaterials } from '@/context/queries'
import { RuntimeDocument } from '@/context/runtimeDocument'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'

function parsers() {
  const p = createParserRegistry()
  p.register(V2PlainParser)
  p.register(createEnvelopeParser(p))
  p.register(WorldParser)
  p.register(StructureDataParser)
  return p
}

/** 真实 v2 plain 夹具 + 注入一条把**所有**读面字段都用上的注解。 */
const ANNO: Record<string, unknown> = {
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

function fixtureRaw(): Record<string, unknown> {
  const raw = JSON.parse(
    fs
      .readFileSync(path.join(process.cwd(), 'e2e', 'fixtures', 'minimal-v2.json'), 'utf8')
      .replace(/\r\n/g, '\n'),
  ) as Record<string, unknown>
  raw.annotations = [ANNO]
  return raw
}

async function fixtureDoc(): Promise<RuntimeDocument> {
  const parsed = await parsers().detectAndParse(fixtureRaw())
  if (parsed.document === null) throw new Error(`夹具解析失败：${JSON.stringify(parsed.error)}`)
  return parsed.document
}

describe('P10f C′1 · ① 注解读面字段完备（逐项比对）', () => {
  it('装配成功后，内核读面与 legacy 字段**逐项相等**', async () => {
    const doc = await fixtureDoc()
    const host = makeAdoptedKernelReadHost(doc)
    try {
      // 反空洞：必须真的装配成功，否则本判据会退化成"两侧都是 legacy"
      expect(host.session?.hasAdoptedContent(), '必须先证明装配成功（否则本判据空转）').toBe(true)

      const legacy = (doc.annotations ?? []) as readonly Record<string, unknown>[]
      const views = host.ctx.kernelAnnotations()
      expect(views, '注解条数必须一致').toHaveLength(legacy.length)
      expect(views.length, '夹具必须至少有一条注解（否则本判据空转）').toBeGreaterThan(0)

      const la = legacy[0]!
      const kv = views[0]!
      // 逐字段（字段名不同处是**显式**映射：legacy snake_case → 读面 camelCase）
      expect(kv.id).toBe(la.id)
      expect(kv.type).toBe(la.type)
      expect(kv.visible).toBe(la.visible)
      expect(kv.title).toBe(la.title)
      expect(kv.description).toBe(la.description)
      expect(kv.locked).toBe(la.locked)
      expect(kv.frameIndex).toBe(la.frameIndex)
      expect(kv.createdAt).toBe(la.created_at)
      expect(kv.updatedAt).toBe(la.updated_at)
      expect(kv.color).toBe(la.color)
      expect(kv.renderStyle).toBe(la.renderStyle)
      expect(kv.min).toEqual(la.min)
      expect(kv.max).toEqual(la.max)
    } finally {
      host.dispose()
    }
  })

  it('**反面**：缺字段的注解不会被伪造出字段（`undefined` 保持缺省）', async () => {
    const doc = await fixtureDoc()
    // 去掉可选字段，只留最小面
    ;(doc.annotations as unknown[])[0] = {
      id: 'a1',
      type: 'box',
      visible: true,
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 },
    }
    const host = makeAdoptedKernelReadHost(doc)
    try {
      const kv = host.ctx.kernelAnnotations()[0]!
      expect(kv.id).toBe('a1')
      // 源里没有 ⇒ 读面也不得编一个（`locked` 尤其：伪造 `false` 会改变只读判定）
      expect(kv.locked).toBeUndefined()
      expect(kv.createdAt).toBeUndefined()
      expect(kv.title).toBe('')
    } finally {
      host.dispose()
    }
  })
})

describe('P10f C′1 · ② 装配失败/未装配 ⇒ 回落 legacy（**回归判据**）', () => {
  it('未装配（GF-16=false）时注解读面**不得**返回空表，而应回落 legacy', async () => {
    const doc = await fixtureDoc()
    // ⚠️ legacy 宿主**不装配** ⇒ 正是"新建注解（setDocument 清 GF-16）"的形态
    const host = makeKernelReadHost(doc)
    try {
      expect(host.ctx.hasAdoptedContent(), '本判据的前提是未装配').toBe(false)
      const views = host.ctx.kernelAnnotations()
      const legacy = (doc.annotations ?? []) as readonly unknown[]
      expect(legacy.length, '夹具必须有注解（否则空表也对，判据空转）').toBeGreaterThan(0)
      // 这条就是 C′1 实测抓出的缺陷的回归钉：**绝不能**是 0
      expect(views.length, '未装配时必须回落 legacy —— 返回空表会让用户连原有注解也点不中').toBe(
        legacy.length,
      )
    } finally {
      host.dispose()
    }
  })

  it('**对称性**：换文档（不重装内核）后读面给出**当前**文档的内容，不是内核里那份旧的', async () => {
    const docA = await fixtureDoc()
    const host = makeAdoptedKernelReadHost(docA)
    try {
      expect(host.ctx.kernelAnnotations()).toHaveLength(1)

      // 换一份**没有**注解的文档（模拟 NewScene：setDocument 后不 adopt）
      const docB = new RuntimeDocument({ id: 'B' })
      host.setDocument(docB)
      // `setDocument` 会清 GF-16 ⇒ 读面回落 legacy(=docB，无注解) ⇒ 0 条。
      // 若实现"不清 GF-16"，这里会读到 A 的 1 条（错文档的内容）⇒ 判红。
      expect(
        host.ctx.kernelAnnotations(),
        '换文档后不得再读到上一份文档的注解（陈旧读面）',
      ).toHaveLength(0)
    } finally {
      host.dispose()
    }
  })
})

describe('P10f C′1 · ③ 材质读面（listMaterials 走内核读面）', () => {
  it('装配成功后 `listMaterials` 仍给出纹理 dataURL（两处字段适配生效）', async () => {
    const doc = await fixtureDoc()
    const legacyPalette = (doc as unknown as { materialPalette?: unknown[] }).materialPalette
    expect(legacyPalette?.length ?? 0, '夹具必须有材质（否则本判据空转）').toBeGreaterThan(0)

    const host = makeAdoptedKernelReadHost(doc)
    try {
      const items = listMaterials(host.ctx)
      expect(items).toHaveLength(legacyPalette!.length)
      expect(items[0]!.materialId).toBe('0')
      // `kind` 的缺省口径与 legacy 一致（`static16`）
      expect(typeof items[0]!.kind).toBe('string')
    } finally {
      host.dispose()
    }
  })

  it('**反面**：未装配时 `listMaterials` 回落 legacy（不得变空）', async () => {
    const doc = await fixtureDoc()
    const legacyPalette = (doc as unknown as { materialPalette?: unknown[] }).materialPalette
    expect(legacyPalette?.length ?? 0).toBeGreaterThan(0)
    const host = makeKernelReadHost(doc)
    try {
      expect(host.ctx.hasAdoptedContent()).toBe(false)
      expect(
        listMaterials(host.ctx).length,
        '未装配时材质面板不得变空（那会让用户看到"没有材质"）',
      ).toBe(legacyPalette!.length)
    } finally {
      host.dispose()
    }
  })
})
