/**
 * `adapters/files/plainCodec` —— **Plain 明文形态的保真编解码**。
//
 *
 * ## 本模块替代的旧机制
 *
 * 旧 `render/data/compactSceneDocument.ts` 把两件事混在一个文件里：**Envelope 信封
 * 解包**（`decodeEnvelopePayload` / `readEnvelopeLayers`）与**格式判别 / 元数据读取**
 * （`readDocumentFormat` / `isEnvelopeDocument` / `readSceneMetaField` /
 * `sceneStableStringIdFromDocument`）。后者与前者的失败模式毫无关系，却共享一个
 * 模块的修改面 —— 逐条记录显示这四件事属于"适配器重新接入"。
 *
 * 本模块接管 **Plain 半边**，且把 B-1 的保真等级写进代码：
 *
 * > | B-1 | **Plain 明文形态**（根级 `documentFormat:"Plain"`） | **逐字节**（命令通道产物） |
 *
 * ## 「逐字节」在这里靠什么成立
 *
 * 命令通道产物由 mod 侧 `ExportSceneWriter.serialize(document, raw=true)` 写出：
 *
 * ```java
 * plain.addProperty("documentFormat", "Plain");
 * return GSON.toJson(plain).getBytes(StandardCharsets.UTF_8);
 * ```
 *
 * 即 **紧凑 JSON（无缩进）、无尾换行、UTF-8**。于是"逐字节往返"的机械判据是：
 *
 * ```
 * encode(decode(bytes)) === bytes      // 同一份字符串，一个码点都不差
 * ```
 *
 * 关键在 {@link encodePlain} **不重新序列化**：它对**原始文本**只做"插入/替换
 * `documentFormat`"这一处编辑，其余字符原样搬运。理由不是性能，而是**键序**：
 * `JSON.parse` → `JSON.stringify` 的往返会按 JS 对象插入顺序重排键，
 * 而既有产物的键序由 Gson 的 `JsonObject`（`LinkedTreeMap`，插入序）决定。
 * 重排之后语义相同、**字节不同** ⇒ B-1 直接判红。
 *
 * 这也是为什么本模块**必须**同时持有 `text`（原始文本）与 `document`（解析结果）：
 * 「读」需要结构化值，「写回」需要原始字节。任何一处以为"再序列化一次就行"的实现
 * 都会在第一次遇到非默认键序的文件时静默降级 —— 而**恰好手写夹具的键序与
 * `JSON.stringify` 一致**，所以这种缺陷在自造夹具上永远不出现。
 */

import { invalidValue, type Result, ok, err } from '@/domain/errors'
import { classifyShape, type ShapeVerdict } from './legacyShape'

/** 契约里唯一的两个明文形态判别值（`render/schema/types.ts:78`）。 */
export type DocumentFormat = 'Plain' | 'Envelope'

/** 根级形态键名（逐字固定；Wiki gadget 也读它）。 */
export const DOCUMENT_FORMAT_FIELD = 'documentFormat'

/** B-1：命令通道产物的序列化口径 —— **紧凑、无尾换行**。 */
export const PLAIN_SERIALIZATION = Object.freeze({
  /** 缩进：`undefined` = 紧凑（Gson `toJson` 的默认形态）。 */
  indent: undefined as string | undefined,
  /** 尾换行：命令通道**不写**（`ExportSceneWriter.serialize` 无 `\n`）。 */
  trailingNewline: false,
})

/**
 * 一份已解析的明文文档：**结构化值 + 原始文本**并存。
 *
 * `text` 是"逐字节"的载体，`document` 是"语义"的载体。两者必须来自**同一次**
 * 解码（{@link decodePlain}），不能一个从文件读、一个从别处构造 ——
 * 那样 `text` 就不再是 `document` 的那份文本。
 */
export interface PlainDocument {
  readonly format: 'Plain'
  /** 原始文本（**未归一化行尾**：字节保真的载体）。 */
  readonly text: string
  readonly document: Readonly<Record<string, unknown>>
  readonly shape: ShapeVerdict
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 解析明文文档。
 *
 * `documentFormat` **缺省视为 Plain**（P-07 原文：「缺省视为 Plain（兼容旧 JSON）」）——
 * 这条兼容是历史事实（早期产物没有该键），不是宽松：`documentFormat: 'Envelope'`
 * 会被显式拒绝（走 {@link decodePlain} 的 `wrongFormat` 分支），于是"拿错解码器"
 * 不会表现为"解出一份空文档"。
 */
export function decodePlain(text: string): Result<PlainDocument> {
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    return err(invalidValue({ reason: 'plainNotJson' }))
  }
  if (!isPlainObject(raw)) return err(invalidValue({ reason: 'plainNotObject' }))

  const declared = raw[DOCUMENT_FORMAT_FIELD]
  if (declared !== undefined && declared !== 'Plain') {
    return err(invalidValue({ reason: 'plainWrongFormat', actual: String(declared) }))
  }
  return ok(
    Object.freeze({
      format: 'Plain' as const,
      text,
      document: raw,
      shape: classifyShape(raw),
    }),
  )
}

/**
 * 写出明文文档 —— **逐字节**（B-1）。
 *
 * 三条实现纪律（每条对应一个已知的失败模式）：
 *
 *  1. **不重新序列化**：只在原始文本上改 `documentFormat` 一处。重新 `JSON.stringify`
 *     会重排键序（见文件头），于是"语义一样、字节不一样"。
 *  2. **幂等**：文本里已有 `"documentFormat"` 时**原样返回**原始文本，一个字符都不动。
 *     这条让"读→写"（无编辑）成为恒等映射，也就是逐字节往返判据的实现。
 *  3. **最小且确定性的插入**：缺 `documentFormat` 时只在根对象花括号之后插入
 *     `"documentFormat":"Plain",`——**其余字符（含前导空白、缩进、行尾、尾换行）
 *     逐字搬运**。选"最前"而不是"最后"是因为插入位置必须不依赖任何运行时状态。
 *
 * ## 关于"缺 `documentFormat` 的旧文件"（诚实边界）
 *
 * B-1 的逐字节判据对象是**命令通道产物**，而 `ExportSceneWriter.serialize(raw=true)`
 * 无条件写 `documentFormat:"Plain"`。历史手写夹具（`e2e/fixtures/minimal-v2.json` 等）
 * **没有**这个键 —— 对它们，第一次写出必然多一个键（这是格式定义要求的规范化，
 * 不是失真）；从**第二次**起逐字节稳定。测试对两种情形分别断言，
 * 并在对照表里如实登记（见契约对照说明的 B-1 行）。
 *
 * 若 `document.documentFormat` 已被调用方改成非 `Plain`（即"文本与结构化值不一致"），
 * 本函数以**文本为准**并返回 `InvalidValue` —— 静默按结构化值重写会输出一份
 * "看起来对"却丢了原始字节的文件。
 */
export function encodePlain(doc: PlainDocument): Result<string> {
  const declared = doc.document[DOCUMENT_FORMAT_FIELD]
  if (declared !== undefined && declared !== 'Plain') {
    return err(invalidValue({ reason: 'plainDocumentFormatMismatch', actual: String(declared) }))
  }
  const brace = doc.text.indexOf('{')
  if (brace < 0) return err(invalidValue({ reason: 'plainRootNotObjectText' }))

  // 只匹配**根对象起始处**的该键（`^\{\s*"documentFormat"`），不做全文搜索：
  // 全文搜索会把嵌套对象里的同名键误当成根级声明，于是"已在根上但顺序靠后"
  // 的文件被重复插入一个键。
  const afterBrace = doc.text.slice(brace + 1)
  if (/^\s*"documentFormat"\s*:/.test(afterBrace)) {
    return ok(doc.text)
  }
  const head = doc.text.slice(0, brace + 1)
  // 插入项 + 分隔符。空对象（`{}`）不加逗号。
  const sep = afterBrace.trimStart().startsWith('}') ? '' : ','
  return ok(`${head}"documentFormat":"Plain"${sep}${afterBrace}`)
}

/**
 * 读形状判别（P-07/P-08 的语义）。
 *
 * `isEnvelopeDocument` 的旧判据（P-08）是**两条**：`documentFormat === 'Envelope'`
 * **或**结构性判定（`payloadEncoding` 合法 + 非空 `payload` + `meta` 是对象）。
 * 后者是为了兼容"根上 `documentFormat` 被折进 meta"的中间形态。
 * 本函数保留这两条 —— 收紧它会让一批既有文件解不开。
 */
export function readDocumentFormat(doc: unknown): DocumentFormat | undefined {
  if (!isPlainObject(doc)) return undefined
  const v = doc[DOCUMENT_FORMAT_FIELD]
  if (v === 'Envelope' || v === 'Plain') return v
  return isEnvelopeStructural(doc) ? 'Envelope' : undefined
}

function isEnvelopeStructural(doc: Record<string, unknown>): boolean {
  return (
    typeof doc.payloadEncoding === 'string' &&
    typeof doc.payload === 'string' &&
    doc.payload.length > 0 &&
    isPlainObject(doc.meta)
  )
}

/** 是否为 Envelope 信封（P-08 的双条件）。 */
export function isEnvelopeDocument(doc: unknown): boolean {
  return readDocumentFormat(doc) === 'Envelope'
}

/**
 * 读展示用元数据（P-09）。
 *
 * 「Envelope 只读 `meta`；Plain 只读根 ⇒ 元数据**单一真源**」。
 * 本函数保留这条分工：**不**在 Envelope 缺 meta 键时回落到根
 * （那会让"这份文件的标题到底在哪"变成不可预测的行为）。
 */
export function readSceneMetaField(doc: unknown, key: string): string {
  if (!isPlainObject(doc)) return ''
  if (isEnvelopeDocument(doc)) {
    const meta = doc.meta
    if (isPlainObject(meta) && meta[key] != null) return String(meta[key])
    return ''
  }
  return doc[key] != null ? String(doc[key]) : ''
}

/** 稳定场景 id；无则 `'scene'`（P-10，被导出文件名使用，逐字保留）。 */
export function sceneStableStringIdFromDocument(doc: unknown): string {
  const id = readSceneMetaField(doc, 'id')
  return id.length > 0 ? id : 'scene'
}

/**
 * 原样读一份**明文**产物字节（不做任何归一化）。
 *
 * 存在的理由：B-1 的判据是**逐字节**，故"读出文本"这个动作本身必须是
 * 零变换的。若调用方顺手 `.trim()` 或归一化行尾，逐字节断言就失去意义。
 * 本函数把"零变换"变成一个具名入口。
 */
export function readPlainText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/** 文本 → UTF-8 字节（写出用；与 {@link readPlainText} 对称）。 */
export function plainTextToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}
