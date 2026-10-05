/**
 * MultiblockParser — 「多方块为主」文档（`documentShape === "multiblock"`）的反序列化。
 *
 * 契约：`docs/contracts/format-multiblock-doc.md`
 *  - §2.2 判别：只看文档级形态枚举量（信封 `meta.documentShape` 或裸体根级 `documentShape`）。
 *    **必须先于 V2Plain / World 判别**：多方块文档天然带 `format_version:"2.0" + frames`，
 *    会被按 format 泛匹配的 parser 抢走。注册顺序见 `parserRegistry.createParserRegistry()`。
 *  - §8.3 载荷分派：`base64(gzip(json))`（生产）与 `base64(json)`（fixture）**同一读取路径**
 *    —— 解 base64 → 先当 UTF-8 JSON 文本解析 → 失败再 gunzip。复用既有信封机制，不重做。
 *  - 解析阶段**不建 Grid**：`frames[]` 只映射为承载变体声明的 `RuntimeFrame`（`grid === null`）。
 *    网格是装配产物（T2.2 装配器按当前取值选择生成）。
 *
 * 失败即显式报错（`MultiblockParseError`，带原因），不静默退化为别的格式。
 */

import { RuntimeDocument } from '@/context/runtimeDocument'
import { isEnvelopeDocument, readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import type { DocumentParser } from '@/context/parserRegistry'
import { isMultiblockShapeDocument } from '@/context/parsers/multiblockDocument'

export const MultiblockParser: DocumentParser = {
  formatName: 'Multiblock',

  detect(raw: unknown): boolean {
    return isMultiblockShapeDocument(raw)
  },

  async parse(raw: unknown): Promise<RuntimeDocument | null> {
    // 信封形态：内层 body 是契约 JSON（含 multiblock/blockPalette/frames），
    // 原样交给 RuntimeDocument 保留（装配器输入），meta 合并后的 Plain 用于既有字段读取。
    if (isEnvelopeDocument(raw)) {
      const layers = await readEnvelopeLayers(raw)
      return RuntimeDocument.fromV2Plain(layers.plain, { multiblockSource: layers.inner })
    }
    // 裸体形态：根对象即内层 body（§2.1「缺省 = 帧为主」的对称面）。
    const inner = raw as Record<string, unknown>
    return RuntimeDocument.fromV2Plain(inner, { multiblockSource: inner })
  },
}
