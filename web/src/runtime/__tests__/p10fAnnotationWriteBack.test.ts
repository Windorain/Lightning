/**
 * **P10f C′2 判据：回写投影的全保真与互逆**（#301）。
 *
 * ## 本文件要证明什么
 *
 * C′2 的写路径是"内核写 → **投影回 legacy**"（裁决 3 单权威）。
 * 投影若漏字段，用户每次编辑注解都会**静默丢数据** —— 实测
 * `kernelProjection#projectKernelDocument` 就漏（只写 5 个字段）。
 * 故本文件把"专用回写投影"钉在两条性质上：
 *
 *  1. **全保真**：与 C′1 读面**逐字段互逆**（同一张 `ANNOTATION_FIELD_PAIRS` 表驱动）；
 *  2. **不伪造**：源里没有的字段不得被补成默认值（`locked` 尤其 ——
 *     补 `false` 会让"锁定即只读"失效）。
 *
 * ## 为什么用"同一张表"断言
 *
 * 若读面加了字段而回写忘了加，逐字段测**各自**都会绿（各自内部自洽），
 * 只有"同一张表双向"能抓出来。这正是 C′1 两处空转缺陷的教训的应用。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  ANNOTATION_FIELD_PAIRS,
  kernelAnnotationsOf,
  projectAnnotationsToLegacy,
} from '@/runtime/annotationRead'
import { makeAdoptedKernelReadHost } from '@/runtime/__tests__/kernelReadTestHost'
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

/** 把全部读写字段都用上的注解（缺一个字段，"全保真"就测不到它）。 */
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

async function fixtureWith(annotations: unknown[]) {
  const raw = JSON.parse(
    fs
      .readFileSync(path.join(process.cwd(), 'e2e', 'fixtures', 'minimal-v2.json'), 'utf8')
      .replace(/\r\n/g, '\n'),
  ) as Record<string, unknown>
  raw.annotations = annotations
  const parsed = await parsers().detectAndParse(raw)
  if (parsed.document === null) throw new Error(`夹具解析失败：${JSON.stringify(parsed.error)}`)
  return parsed.document
}

describe('P10f C′2 · ① 回写投影**全保真**（逐字段互逆）', () => {
  it('读面与回写在同一张字段表上逐项相等', async () => {
    const doc = await fixtureWith([FULL_ANNO])
    const host = makeAdoptedKernelReadHost(doc)
    try {
      // 反空洞：必须真的装配成功，否则本判据退化
      expect(host.session?.hasAdoptedContent(), '必须先证明装配成功').toBe(true)

      const views = kernelAnnotationsOf(host.session!.document())
      const rows = projectAnnotationsToLegacy(host.session!.document())
      expect(rows, '条数必须一致').toHaveLength(views.length)
      expect(views.length, '夹具必须至少一条注解').toBeGreaterThan(0)

      const view = views[0]! as unknown as Record<string, unknown>
      const row = rows[0]!
      // **同一张表**驱动：任一字段不等即判红（而不是各自内部自洽）
      for (const [kernelKey, legacyKey] of ANNOTATION_FIELD_PAIRS) {
        expect(
          row[legacyKey],
          `字段 ${kernelKey} → ${legacyKey} 在投影中丢失或被改写（回写桥会导致丢数据）`,
        ).toEqual(view[kernelKey])
      }
    } finally {
      host.dispose()
    }
  })

  it('**反面**：字段表覆盖了全部非空字段（漏登记即判红）', async () => {
    const doc = await fixtureWith([FULL_ANNO])
    const host = makeAdoptedKernelReadHost(doc)
    try {
      const views = kernelAnnotationsOf(host.session!.document())
      const view = views[0]! as unknown as Record<string, unknown>
      const rows = projectAnnotationsToLegacy(host.session!.document())
      const row = rows[0]!
      // 读面实际给出的字段集 ⊆ 表（否则说明加了字段却没进表 ⇒ 回写会漏它）
      const declaredKernel = new Set(ANNOTATION_FIELD_PAIRS.map(([k]) => k))
      const actualKernel = Object.keys(view).filter((k) => view[k] !== undefined)
      const undeclared = actualKernel.filter((k) => !declaredKernel.has(k))
      expect(undeclared, '读面暴露了未登记的字段 ⇒ 回写不会写它（丢数据）').toEqual([])
      // 回写实际产出的字段集 ⊆ 表
      const declaredLegacy = new Set(ANNOTATION_FIELD_PAIRS.map(([, l]) => l))
      const actualLegacy = Object.keys(row)
      expect(actualLegacy.filter((k) => !declaredLegacy.has(k)), '回写产出了未登记的字段').toEqual([])
    } finally {
      host.dispose()
    }
  })

  it('**反面**：源里没有的字段**不得**被补成默认值（`locked` 尤其）', async () => {
    const minimal = {
      id: 'a1',
      type: 'box',
      visible: true,
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 },
    }
    const doc = await fixtureWith([minimal])
    const host = makeAdoptedKernelReadHost(doc)
    try {
      const row = projectAnnotationsToLegacy(host.session!.document())[0]!
      expect(row.id).toBe('a1')
      // 源里没有 ⇒ 回写也不得有（补 `false` 会让"锁定即只读"失效）
      expect(row.locked, '`locked` 缺席时不得伪造为 false').toBeUndefined()
      expect(row.created_at, '`created_at` 缺席时不得伪造').toBeUndefined()
      expect(row.frameIndex).toBeUndefined()
    } finally {
      host.dispose()
    }
  })

  it('**确定性**：同一内核 ⇒ 逐字节相同的 legacy 片段（字段顺序固定）', async () => {
    const doc = await fixtureWith([FULL_ANNO])
    const host = makeAdoptedKernelReadHost(doc)
    try {
      const a = JSON.stringify(projectAnnotationsToLegacy(host.session!.document()))
      const b = JSON.stringify(projectAnnotationsToLegacy(host.session!.document()))
      expect(a, '两次投影必须逐字节相同（否则"投影稳定"不可断言）').toBe(b)
    } finally {
      host.dispose()
    }
  })
})

describe('P10f C′2 · ② 回写投影**优于**渲染投影（本批阻塞的回归钉）', () => {
  it('渲染投影确实只写 5 字段（记录本批为何另建回写投影）', async () => {
    const doc = await fixtureWith([FULL_ANNO])
    const host = makeAdoptedKernelReadHost(doc)
    try {
      const kdoc = host.session!.document()!
      const { projectToRuntimeDocument } = await import('@/composition/kernelProjection')
      const rendered = projectToRuntimeDocument({ scene: kdoc.scene, content: kdoc.content })
      const r = (rendered.doc.annotations as Record<string, unknown>[])[0]!
      // 渲染投影**故意**只带够画的字段 —— 这条不是缺陷，是精度分离的依据。
      // 若将来有人把它"顺手补全"，本断言会红，提醒他先读 §回写精度分离的说明。
      expect(r.locked, '渲染投影不带 `locked`（本批据此另建全保真回写投影）').toBeUndefined()
      expect(r.min, '渲染投影不带几何（几何在渲染侧另有来源）').toBeUndefined()
      // 而全保真回写**必须**带上它们
      const w = projectAnnotationsToLegacy(kdoc)[0]!
      expect(w.locked).toBe(true)
      expect(w.min).toEqual({ x: 0, y: 0, z: 0 })
    } finally {
      host.dispose()
    }
  })
})
