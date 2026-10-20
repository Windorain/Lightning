/**
 * R2-1a 第 4 件 —— **声明进内容权威**的生产装配判据。
 *
 * ## 为什么必须过生产装配（AGENTS.md 第 ⑦ 条）
 *
 * 纯函数判据喂"已带字段"的手工载荷会**恒绿**：它证明的是"函数能装下这个值"，
 * 不是"生产装配真的填了它"（本项目已有 `gridInputOf` 漏传 `cellPalette`、
 * `gridPayload` 漏填尺寸列两连）。故本文件走**完整生产链**：
 *
 *   仓库真实夹具 → `registry.detectAndParse`（生产解析）→ `RuntimeDocument`
 *   → `assembleKernelDocument`（生产装配）→ `AssembledDocument.content.multiblock`
 *
 * 接线前的事实（父代理核过、G6 的账 b3 记着）：`kernelAssembly` 的
 * `documentContent({ metadata, frameAxis, resources })` **不传 `multiblock`**
 * ⇒ 生产里 `content.multiblock` 恒为空声明，声明只在**装配面/旧载体**上。
 *
 * ## 负对照（区分力）
 *
 * 第 3 条故意按**接线前**的写法重造一次内容（不带 `multiblock`），断言它
 * ①`multiblock` 回落空声明；②**内容身份改变** ⇒ 第 1 条"内容身份 = 带声明的那个"
 * 在接线前必然判红。不是靠测试主动抛错。
 */
import { describe, it, expect } from 'vitest'

import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { createParserRegistry } from '@/context/parserRegistry'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'
import { multiblockDeclarationOf } from '@/adapters/files/multiblockDeclaration'
import { EMPTY_MULTIBLOCK_DECLARATION, multiblockDeclDigest } from '@/domain/multiblockDocument'
import { documentContent, type DocumentContent } from '@/domain/content'
import { createDocument } from '@/domain/document'
import { unwrap } from '@/domain/errors'

/** 多方块为主的夹具（与 `composition/__tests__/kernelAssembly.test.ts` 同一清单）。 */
const MULTIBLOCK_FIXTURES = ['multiblock-tier-only', 'multiblock-ebf-2ch', 'multiblock-lsc-overlap'] as const

async function assembleFixture(name: string) {
  const registry = createParserRegistry()
  const envelope = readJson(fixturePath(name)) as Record<string, unknown>
  const parsed = await registry.detectAndParse(envelope)
  expect(parsed.document, `${name} 应能被生产解析器解析`).not.toBeNull()
  const assembled = unwrap(assembleKernelDocument({ doc: parsed.document! }))
  return { doc: parsed.document!, content: assembled.content }
}

function contentVersionOf(content: DocumentContent): number {
  const contentVersion = createDocument('r2-content-authority', { content }).version.contentVersion
  if (contentVersion === undefined) throw new Error('createDocument 必须给出 contentVersion（否则内容身份判据无对象）')
  return contentVersion
}

describe('R2-1a 第 4 件 · 多方块声明进内容权威（生产装配）', () => {
  for (const name of MULTIBLOCK_FIXTURES) {
    it(`${name}：生产装配后 \`content.multiblock\` **非空**且等于类型化适配器的输出`, async () => {
      const { doc, content } = await assembleFixture(name)

      // ① 内容权威**不是**空声明（接线前这里恒为 `EMPTY_MULTIBLOCK_DECLARATION`）。
      expect(content.multiblock, `${name}: 生产装配必须把声明填进内容权威`).not.toBe(EMPTY_MULTIBLOCK_DECLARATION)
      expect(content.multiblock.multiblockCount).toBe(1)

      // ② 值 == 类型化适配器对**同一个**真实解析结果的输出（不是旧载体换个存放位置：
      //    适配器产出的是内核承载 —— `decl` 摊平、去 `raw`、逐层冻结）。
      const adapted = multiblockDeclarationOf(doc.multiblock).declaration
      expect(content.multiblock).toEqual(adapted)

      // ③ 与解析侧形状**不同物**：解析侧有 `decl`/`raw` 这些内核承载里不存在的字段。
      expect(content.multiblock as unknown as Record<string, unknown>).not.toHaveProperty('decl')
      expect(content.multiblock as unknown as Record<string, unknown>).not.toHaveProperty('raw')

      // ④ 声明摘要稳定（同一份真实声明 ⇒ 同一摘要；内容权威里的那份与适配器输出同摘要）。
      expect(multiblockDeclDigest(content.multiblock)).toBe(multiblockDeclDigest(adapted))
    })
  }

  // 为什么**没有**"帧为主文档 ⇒ 显式空声明"这一条走生产装配：
  // `fixturePath` 下只有三份夹具，**全部是多方块为主**（本文件首行实测：目录里只有
  // `multiblock-*.json`）。要造一份帧为主的信封就得手拼载荷 —— 而手拼恰好是本文件
  // 要避免的形态。该断言因此落在两处**不需要**夹具的地方：
  //   ①适配器判据（`multiblockDeclarationOf(null).declaration === EMPTY`）；
  //   ②本文件第 3 条负对照（`documentContent` 缺省 ⇒ `EMPTY_MULTIBLOCK_DECLARATION`）。

  it('负对照：按接线前的写法重造内容（不带 `multiblock`）⇒ 回落空声明 **且** 内容身份改变', async () => {
    const { content } = await assembleFixture('multiblock-tier-only')

    // 带声明：重造一次必须**幂等**（否则"身份"判据本身不稳）。
    const withDeclaration = documentContent({
      metadata: content.metadata,
      frameAxis: content.frameAxis,
      resources: content.resources,
      multiblock: content.multiblock,
    })
    expect(contentVersionOf(withDeclaration)).toBe(contentVersionOf(content))

    // 不带声明（= `composition/kernelAssembly.ts` 接线前的 `documentContent` 实参形状）：
    const preWiring = documentContent({
      metadata: content.metadata,
      frameAxis: content.frameAxis,
      resources: content.resources,
    })
    expect(preWiring.multiblock, '缺省 ⇒ 显式空声明（不是 undefined）').toBe(EMPTY_MULTIBLOCK_DECLARATION)
    // 这条就是区分力所在：接线前 `content.multiblock` 是空的 ⇒ 第 1 条的"非空"判红，
    // 且内容身份与真实产物**不同**（漏填会让同一份文档得到两个摘要）。
    expect(contentVersionOf(preWiring), '不填 multiblock 必须改变内容身份').not.toBe(contentVersionOf(content))
  })
})
