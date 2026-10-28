/**
 * 回归测试（E2E 擒获的生产 bug 锁定）：RuntimeDocument 被放进 Vue **深响应式 ref** 后，
 * serialize()/clone()/undo 快照路径不得抛 DataCloneError。
 *
 * 背景：生产 `runtime/main.ts` 以 `ref(null)`（深响应式）持有 doc——doc 内部数组/对象经 Proxy
 * 访问时是 reactive proxy，而 `structuredClone()` 不能克隆 Proxy。含部件文档曾因此在渲染管线
 * （serialize）、导出、保存、undo（clone）全部生产表面崩溃；单测此前手工 new RuntimeDocument
 * 未经响应式 ref，是盲区。修复 = `pure/deepCopy.ts` 的 Proxy 安全深拷贝替换全部 structuredClone 调用点。
 */
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { RuntimeDocument } from '@/context/runtimeDocument'
import type { PartList } from '@/pure/partTypes'

import ae2Fixture from '../../../e2e/fixtures/parts-ae2-multibox.v2.json'
import singleboxFixture from '../../../e2e/fixtures/parts-singlebox-mix.v2.json'

function productionRegistry() {
  const registry = createParserRegistry()
  registry.register(V2PlainParser)
  registry.register(createEnvelopeParser(registry))
  registry.register(WorldParser)
  registry.register(StructureDataParser)
  return registry
}

async function parseToDoc(raw: unknown): Promise<RuntimeDocument> {
  const result = await productionRegistry().detectAndParse(raw)
  expect(result.document).toBeInstanceOf(RuntimeDocument)
  return result.document as RuntimeDocument
}

describe('响应式 ref 持有的部件文档（生产场景回归）', () => {
  it('serialize() 在深 ref 代理下不抛且产出 cellPartsGrid/partLists（去重下标保持）', async () => {
    const docRef = ref<RuntimeDocument | null>(null)
    docRef.value = await parseToDoc(singleboxFixture) // 深响应式：此后 doc 内部皆为 Proxy

    const doc = docRef.value!
    const out = doc.serialize() // ← 修复前在此抛 DataCloneError
    const frames = out.frames as Record<string, unknown>[]
    const structure = frames[0]!.structure as Record<string, unknown>
    expect(structure.cellPartsGrid).toEqual([[[0, 0, 1, -1, 2]]])
    const partLists = structure.partLists as PartList[]
    expect(partLists).toHaveLength(3)
    // 代理读取不影响五要素内容
    expect(partLists[2]![0]!.typeKey).toBe('minecraft:fence:0')
    expect(partLists[2]![0]!.boxes.map(b => b.kind)).toEqual(['visual', 'collision'])
  })

  it('clone()（undo 快照路径）在深 ref 代理下不抛且部件随帧深拷贝', async () => {
    const docRef = ref<RuntimeDocument | null>(null)
    docRef.value = await parseToDoc(ae2Fixture)

    const cloned = docRef.value!.clone() // ← 修复前在此抛 DataCloneError
    const parts = cloned.partsAt(0, { x: 0, y: 0, z: 0 })
    expect(parts).not.toBeNull()
    expect(parts!.map(p => p.localId)).toEqual(['ae2:UNKNOWN', 'ae2:NORTH', 'ae2:UP'])
    // 深拷贝独立性：改克隆产物不影响原文档
    const out = cloned.serialize()
    const frames = out.frames as Record<string, unknown>[]
    expect((frames[0]!.structure as Record<string, unknown>).partLists).toBeDefined()
  })

  it('serialize→再解析→再 serialize（全程经深 ref）round-trip 稳定', async () => {
    const docRef = ref<RuntimeDocument | null>(null)
    docRef.value = await parseToDoc(singleboxFixture)

    const once = docRef.value!.serialize()
    docRef.value = await parseToDoc(once)
    const twice = docRef.value!.serialize()

    const s1 = (once.frames as Record<string, unknown>[])[0]!.structure as Record<string, unknown>
    const s2 = (twice.frames as Record<string, unknown>[])[0]!.structure as Record<string, unknown>
    expect(s2.cellPartsGrid).toEqual(s1.cellPartsGrid)
    expect(s2.partLists).toEqual(s1.partLists)
  })
})
