/**
 * 形态契约 ⑦：**生产调用点**的资源身份必须与池形态无关。
 *
 * ## 这条判据补的那一格
 *
 * `render/data/__tests__/textureBlobPool.shapeContract.test.ts` 判据 ⑥ 证的是**配方**
 * （"先判形态再归一化"⇒ 两形摘要相同）与 **`resourceDigestOf` 本体仍形态敏感**（登记的本体缺陷）。
 * 但配方法在**调用点是否真的被用上**，⑥ 判不了 —— 它在纯函数上直接调配方。
 * 生产调用点是 `runtime/presentationAdapter.ts` 的 `resourceIdentityInputOf`，唯一入口是
 * `readContentIdentity()`（生产读取面，`presentation/contentSignal.ts:88-89` 的驱动源）。
 *
 * 本判据把**真夹具**（`e2e/fixtures/minimal-v2.json`，其余字段全是盘上的产物）经
 * **生产解析**（`V2PlainParser` 经注册表）喂进去，只换 `textureBlobs` 的形态：
 *
 *  - 形态 A（数组，内核材质面/多方块）：`['AAAA','BBBB']`
 *  - 形态 B（槽位键对象，帧为主投影 `plainForSave().plain`）：`{'0':'AAAA','1':'BBBB'}`
 *
 * 断言 `ContentIdentity.resources` 相同、`diffContentIdentity().documentChanged === false`
 * ⇒ 不再触发无谓的**全量重建**（`planContentRebuild` 全 false）。
 *
 * ## 负对照（三条，都必须能红）
 *
 * 1. **旧调用点 ⇒ 判据必红**（`oldCallSite` 是修复前那一行的逐字副本）：
 *    `resourceDigestOf(doc.textureBlobs)` 直接吃对象形态 ⇒ 两形摘要不同（实测
 *    `c:7f364cd1` vs `c:ee985e1c`）。
 * 2. **盲归一化 ⇒ 判据必红**：同一键、不同内容的**非池**资源 `{stone:'AAAA'}` / `{stone:'BBBB'}`
 *    必须给出**不同**摘要、`documentChanged === true`；盲归一化把两者都压成 `[]` ⇒ 摘要碰撞
 *    （A28/A36「同键不同内容不得静默复用」塌陷）。
 * 3. **前提（防蒙对）**：生产解析必须**保留**注入的字段（否则形态差异根本传不到读取面，
 *    第 1 条会"因为字段丢了而恰好相同"）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  StructureDataParser,
  V2PlainParser,
  WorldParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { createParserRegistry } from '@/context/parserRegistry'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { diffContentIdentity, planContentRebuild, resourceDigestOf } from '@/presentation/contentIdentity'
import { normalizeTextureBlobPool } from '@/domain/textureBlobPool'
import { readContentIdentity } from '@/runtime/presentationAdapter'

const FIXTURE = path.join(process.cwd(), 'e2e', 'fixtures', 'minimal-v2.json')

/** 与宿主一致的注册顺序（`src/runtime/host/workbenchHost.ts`）。 */
function productionRegistry() {
  const registry = createParserRegistry()
  registry.register(V2PlainParser)
  registry.register(createEnvelopeParser(registry))
  registry.register(WorldParser)
  registry.register(StructureDataParser)
  return registry
}

/** 走**生产解析**（不是直接 new；文档形态由解析器判定）。 */
async function parse(raw: Record<string, unknown>): Promise<RuntimeDocument> {
  const res = await productionRegistry().detectAndParse(raw)
  if (!res.document) throw new Error(`夹具解析失败：${res.error}`)
  return res.document
}

/** 真夹具 + 注入的 `textureBlobs`。读入口**先归一化行尾**（铁律 6 / `crlf-hygiene` 元闸门）。 */
function plainWith(textureBlobs: unknown): Record<string, unknown> {
  const base = JSON.parse(fs.readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n')) as Record<string, unknown>
  return { ...base, textureBlobs }
}

/** 生产读取面（`definition: null` 与本判据无关：资源身份只取文档字段）。 */
function identityOf(doc: RuntimeDocument) {
  return readContentIdentity({ doc, frameIndex: 0, layerPreview: 'all', definition: null })
}

/** **修复前**的调用点（`runtime/presentationAdapter.ts:150` 那一行的逐字副本）。 */
function oldCallSite(doc: RuntimeDocument): string {
  return resourceDigestOf(doc.textureBlobs ?? doc.materialPalette ?? undefined)
}

/** **错误配方**（负对照用）：盲归一化 —— 不判形态就喂身份函数。 */
function blindCallSite(doc: RuntimeDocument): string {
  return resourceDigestOf(normalizeTextureBlobPool(doc.textureBlobs ?? doc.materialPalette ?? undefined))
}

const AS_ARRAY = ['AAAA', 'BBBB'] as const
const AS_OBJECT = { '0': 'AAAA', '1': 'BBBB' } as Readonly<Record<string, string>>

describe('形态 ⑦：资源身份在**生产调用点**与池形态无关', () => {
  it('前提（防蒙对）：生产解析保留注入的 `textureBlobs`，两种形态都保留', async () => {
    const arr = await parse(plainWith(AS_ARRAY))
    const obj = await parse(plainWith(AS_OBJECT))
    expect(arr.textureBlobs, '数组形态必须活着穿过生产解析').toEqual(AS_ARRAY)
    expect(obj.textureBlobs, '对象形态必须活着穿过生产解析').toEqual(AS_OBJECT)
  })

  it('正：同一逻辑资源的两种形态 ⇒ `resources` 相同（同一份内容不再被判成两个资源）', async () => {
    const arr = await parse(plainWith(AS_ARRAY))
    const obj = await parse(plainWith(AS_OBJECT))
    const idArr = identityOf(arr)
    const idObj = identityOf(obj)
    expect(
      idObj.resources,
      '帧为主投影的对象形态与内核材质面的数组形态是同一份内容 ⇒ 资源摘要必须相同',
    ).toBe(idArr.resources)
    // 与实测读数对齐（同一组夹具）：数组形态的摘要是这个值。
    expect(idArr.resources).toBe('c:7f364cd1')
  })

  it('正：两形之间**没有**内容变化 ⇒ `documentChanged === false`、重建计划全 false', async () => {
    const arr = await parse(plainWith(AS_ARRAY))
    const obj = await parse(plainWith(AS_OBJECT))
    const change = diffContentIdentity(identityOf(arr), identityOf(obj))
    expect(change.documentChanged, '缺陷形态：两形之间恒真 ⇒ 每次读身份都无谓全量重建').toBe(false)
    expect(change.structureChanged).toBe(false)
    const plan = planContentRebuild(change)
    expect(plan.reloadResources).toBe(false)
    expect(plan.resolveStructure).toBe(false)
    expect(plan.rebuildGeometry).toBe(false)
    expect(plan.syncAnnotations).toBe(false)
  })

  it('**负对照（能红）**：修复前的调用点 ⇒ 两形摘要不同（这就是本判据要拦住的东西）', async () => {
    const arr = await parse(plainWith(AS_ARRAY))
    const obj = await parse(plainWith(AS_OBJECT))
    // 旧调用点的读数与实测一致：
    expect(oldCallSite(arr)).toBe('c:7f364cd1')
    expect(oldCallSite(obj), '旧调用点：对象形态被直接哈希 ⇒ 摘要分叉').toBe('c:ee985e1c')
    expect(oldCallSite(arr)).not.toBe(oldCallSite(obj))
    // 而生产读取面（调用点已修）必须相同 —— 同一断言在旧实现下必红：
    expect(identityOf(arr).resources).toBe(identityOf(obj).resources)
    expect(identityOf(arr).resources).not.toBe(oldCallSite(obj))
  })

  it('**负对照（能红）**：盲归一化 ⇒ 不同内容的非池资源摘要**碰撞**（A28/A36 塌陷）', async () => {
    const a = await parse(plainWith({ stone: 'AAAA' }))
    const b = await parse(plainWith({ stone: 'BBBB' }))
    // ① 盲归一化：`{stone:…}` 不是池（键不是数值下标）⇒ 被压成 `[]` ⇒ 两个不同内容同一摘要。
    expect(blindCallSite(a), '盲归一化的碰撞（这就是"必须先判形态"的原因）').toBe(blindCallSite(b))
    // ② 生产读取面：必须继续可分辨（否则"换纹理"被判成"什么都没变"）。
    expect(identityOf(a).resources, '同键不同内容必须可分辨（A28/A36）').not.toBe(identityOf(b).resources)
    expect(identityOf(a).resources).toBe('c:50b7e1fc')
    expect(identityOf(b).resources).toBe('c:33d05e48')
    // ③ 且真的升级成"文档变化"（资源变了 ⇒ 必须重载资源）。
    const change = diffContentIdentity(identityOf(a), identityOf(b))
    expect(change.documentChanged, '资源变化属于文档/资源整体变化').toBe(true)
    expect(planContentRebuild(change).reloadResources).toBe(true)
  })

  it('正：非池值**不得**被归一化改写 ⇒ 摘要恒等于身份函数对原值的读数', async () => {
    const a = await parse(plainWith({ stone: 'AAAA' }))
    expect(identityOf(a).resources).toBe(resourceDigestOf({ stone: 'AAAA' }))
  })
})
