/**
 * `adapters/files/envelopeCodec` —— **Envelope 信封的保真编解码**
 * （B1 §A.2 的 F-03/F-04/F-34/F-35，B1 §B 的 B-2；#260 A20）。
 *
 * ## 本模块替代的旧机制
 *
 * 旧实现把 Envelope 的**解包**放在 `render/data/compactSceneDocument.ts:110-180`，
 * 而把**打包**放在 `pure/envelope.ts:65-84`（`buildEnvelopePackage`）——
 * 两处对 `meta` 键集、`payloadEncoding` 取值、`meta` 与 inner 的分工各持一份理解。
 * 更关键的是旧 `buildEnvelopePackage` **拒绝 Envelope 入参**（`envelope.ts:69-71`），
 * 于是"读一份 Envelope、改一个 meta 字段、写回"这条最基本的路**没有实现**
 * （调用方必须先手写解包，再打包，两步的判据还可能不一致）。
 *
 * 本模块提供闭合的 `decode` / `encode`：读回写回走同一份 `meta` 键集定义。
 *
 * ## B-2 的保真等级：**语义等价**，且明确禁止逐字节
 *
 * > | B-2 | **Envelope 包装** | **语义等价**（gzip 头含 MTIME ⇒ 禁止逐字节） |
 *
 * 依据 `docs/contracts/format-scene-file.md:161-174`：gzip 头第 4..8 字节是 MTIME，
 * 同一份内容在不同时刻压缩得到**不同字节**。实测（本树 `pako`）：`header.time` 缺省时
 * 两次压缩结果不同；显式给 `header.time` 后确定。故：
 *
 * - 本模块的 `encodeEnvelope` **显式**把 `header.time` 钉为 {@link GZIP_MTIME_PINNED}
 *   ⇒ **本实现内部**是确定性的（同一输入恒得同一字节），这让"读→写→读"可复现；
 * - 但契约层面**仍然禁止**把 Envelope 的字节相等当判据 —— 别的实现（mod 侧 Java
 *   `GZIPOutputStream`）不钉 MTIME，跨实现的字节比较必然失败。⇒ 判据是
 *   **解包后的语义子树 canonical 摘要**（{@link envelopeSemanticDigest}）。
 *
 * 钉 MTIME 的另一个作用是让本批的往返测试能区分两种失败：
 * "gzip 头不同"（**不是**缺陷）与"payload 语义不同"（**是**缺陷）。
 * 不区分的话，任何一次 Envelope 往返都会红，而红色不指向任何真实问题。
 *
 * ## `meta` 是唯一元数据真源（F-35）
 *
 * `pure/envelopeMetaKeys.ts:7-15` 的 `ENVELOPE_META_KEYS` 是既有事实：
 * 这些键打进 `meta`、并从 payload 解压出的 JSON 根上**剔除**。
 * 本模块把它作为**必须显式传入**的参数（{@link EnvelopeCodecOptions.metaKeys}），
 * 并在缺省时用同一份清单 —— 于是"meta 键集"只有一处定义，且**可被调用方替换**
 * （fixture 与真实产物的键集确实不同，硬编码一份会让另一份读错）。
 */

import pako from 'pako'

import { invalidValue, type Result, ok, err } from '@/domain/errors'
import { canonicalize, digestOf } from '@/domain/identity'
import { classifyShape, type ShapeVerdict } from './legacyShape'

/** 生产载荷编码（F-04）。 */
export const COMPACT_PAYLOAD_ENCODING = 'gzip+base64' as const

/**
 * fixture 专用载荷编码：`base64(未压缩 JSON)`（F-04 的第二个合法取值）。
 *
 * 与生产形态**共用同一读取路径**（先当 UTF-8 JSON 试解析 → 失败再 gunzip），
 * 该取值只影响人工阅读/diff 的便利性，不影响任何解析分支。
 */
export const PLAIN_BASE64_PAYLOAD_ENCODING = 'base64(json)' as const

/** 两个合法 `payloadEncoding` 取值（F-04：未知取值**显式报错**，不静默退化）。 */
export const SUPPORTED_PAYLOAD_ENCODINGS: readonly string[] = Object.freeze([
  COMPACT_PAYLOAD_ENCODING,
  PLAIN_BASE64_PAYLOAD_ENCODING,
])

/**
 * 本实现钉死的 gzip MTIME（0 = "未设置"，gzip 规范允许）。
 *
 * 为什么是 0 而不是"当前时间"：本模块是**纯适配器**，读全局时钟会让同一输入在不同
 * 时刻产出不同字节，直接违反 `#249` §2.1（纯函数不读时钟）。0 是规范允许的取值，
 * 且是唯一不依赖任何外部状态的取值。
 */
export const GZIP_MTIME_PINNED = 0

/**
 * 默认 `meta` 键集（**逐字**取自 `pure/envelopeMetaKeys.ts:7-15` 的既有事实）。
 *
 * 为什么在这里**重复**列出而不是 import 旧模块：`adapters` 不得依赖旧层
 * （`#249` §4 规则 4 与 `tests/architecture/export-purity.test.ts` 的判据）。
 * 重复一份字面量是**边界成本**，不是疏忽 —— 且它被测试逐项钉住
 * （`envelopeCodec.test.ts` 断言本清单与旧清单逐字相等），于是漂移会被判红。
 */
export const ENVELOPE_META_KEYS: readonly string[] = Object.freeze([
  'id',
  'label',
  'author',
  'gtnhVersion',
  'structureId',
  'schemaVersion',
  'documentFormat',
])

/** 已解码的信封：`meta`（真源）+ 内层 body + 合并后的 Plain 视图。 */
export interface DecodedEnvelope {
  readonly format: 'Envelope'
  readonly payloadEncoding: string
  /** 信封元数据（**唯一**元数据真源）。 */
  readonly meta: Readonly<Record<string, unknown>>
  /**
   * payload 解出的**内层 body**（原样）。
   *
   * 与 `plain` 的区别：多方块为主文档要把 `inner` **原样**交给装配器
   * （`format-multiblock-doc.md:562-570`「两种载荷形态共用同一读取路径」），
   * 而普通消费者要的是合并后的 `plain`。
   */
  readonly inner: Readonly<Record<string, unknown>>
  /** `inner` 剔除 meta 键后与 `meta` 合并（meta 权威）的结果。 */
  readonly plain: Readonly<Record<string, unknown>>
  readonly shape: ShapeVerdict
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// ─────────────────────────────────────────────────────────────────────────────
// base64 / gzip 原语（纯；只用标准 Web API + pako）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * base64 字符串 → 字节。
 *
 * 用 `atob`（浏览器与 Node 18+ 全局均有）而不是手写解码表：
 * 手写表是"看起来能跑"的复制品，且 `atob` 的严格性（非法字符抛错）正是我们要的行为
 * —— 一份被截断的 base64 应当**显式失败**，不是解出半截字节。
 */
function base64ToBytes(b64: string): Result<Uint8Array> {
  try {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return ok(out)
  } catch {
    return err(invalidValue({ reason: 'envelopePayloadNotBase64' }))
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

/**
 * gzip（**同步**、MTIME 钉死）。
 *
 * 为什么不像旧实现那样用 `DecompressionStream`：那是**异步**的，会逼着整个
 * 适配器接口变成 `Promise`，于是"纯函数"这条约束要靠调用方自己维持。
 * 本模块用 `pako` 的同步 `gzip`/`ungzip`（`pako` 已是本仓依赖，
 * `pure/envelope.ts:4` 就在用它）—— 编码路径因此保持同步、可逐值断言。
 *
 * ## 为什么有一处 `as` 断言（不是绕过类型检查）
 *
 * `@types/pako` 把 `gzip()` 的选项声明成 `DeflateFunctionOptions`（**不含** `header`），
 * 而 `header` 只在 `DeflateOptions`（`Deflate` **类**的选项）里。运行时 `pako.gzip`
 * 确实接受 `header`（本树实测：`{header:{time:0}}` 产出 MTIME=0 的 gzip 头），
 * 且这正是 `Deflate` 类内部走同一条 `deflate` 实现。
 *
 * 三选一的取舍，逐个排除：
 *  - 改用 `new pako.Deflate({gzip:true, header:{time:0}})`：类型干净，但 `Deflate`
 *    是**流式** API，要 `push` + 检查 `err` + 取 `result`（类型是 `Uint8Array | string`），
 *    于是本函数多出两条错误分支 —— 而它们在本场景下**不可能**发生（内存缓冲、
 *    无字典、无窗口位设定），凭空加错误分支会让"编码失败"多出一个假信号；
 *  - 不钉 MTIME：那么同一输入两次编码字节不同（本树实测确认），
 *    "读→写→读"的确定性消失，往返测试将无法区分"gzip 头不同"（**不是**缺陷，
 *    见文件头 B-2）与"payload 语义不同"（**是**缺陷）。这条代价最大；
 *  - 断言（本选择）：把"类型声明比运行时窄"这件事**写在代码里**，
 *    且断言的类型是 `DeflateOptions`（**同一个包的更宽声明**），不是 `any`。
 */
function gzip(bytes: Uint8Array): Uint8Array {
  return pako.gzip(bytes, { header: { time: GZIP_MTIME_PINNED } } as pako.DeflateOptions)
}

function gunzip(bytes: Uint8Array): Uint8Array {
  return pako.ungzip(bytes)
}

/** 显式 try/catch 包裹的 gunzip（失败返回结构化错误，不抛到调用方）。 */
function gunzipResult(bytes: Uint8Array): Result<Uint8Array> {
  try {
    return ok(gunzip(bytes))
  } catch (e) {
    return err(invalidValue({ reason: 'envelopePayloadNotGzip', detail: e instanceof Error ? e.message : String(e) }))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 解码（F-04：先当 UTF-8 JSON → 失败再 gunzip，**两个取值共用一把钥匙**）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * payload → 内层 body（F-04 的"同一把钥匙"）。
 *
 * 顺序**是判据的一部分**：先当 UTF-8 JSON 试解析，失败再 gunzip。反过来（先 gunzip）
 * 会让 `base64(json)` 的 fixture 直接失败 —— 而两者共用同一路径正是 B-1 里
 * 「两种载荷形态共用同一读取路径」（`format-multiblock-doc.md:562-570`）的要求。
 */
export function decodeEnvelopePayload(payloadEncoding: unknown, payload: unknown): Result<Record<string, unknown>> {
  if (!SUPPORTED_PAYLOAD_ENCODINGS.includes(String(payloadEncoding))) {
    // 未知取值**显式报错**（F-04 原文），不静默退化成"当 Plain 解析"。
    return err(
      invalidValue({
        reason: 'envelopeUnsupportedPayloadEncoding',
        actual: String(payloadEncoding),
        supported: SUPPORTED_PAYLOAD_ENCODINGS.join('|'),
      }),
    )
  }
  if (typeof payload !== 'string' || payload.length === 0) {
    return err(invalidValue({ reason: 'envelopeMissingPayload' }))
  }
  const bytes = base64ToBytes(payload)
  if (!bytes.ok) return bytes

  const direct = tryParseUtf8Json(bytes.value)
  if (direct !== null) {
    if (!isPlainObject(direct)) return err(invalidValue({ reason: 'envelopePayloadNotObject', branch: 'plainJson' }))
    return ok(direct)
  }
  const unzipped = gunzipResult(bytes.value)
  if (!unzipped.ok) return unzipped
  const text = new TextDecoder('utf-8').decode(unzipped.value)
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return err(invalidValue({ reason: 'envelopePayloadNotJson', branch: 'gzip' }))
  }
  if (!isPlainObject(parsed)) return err(invalidValue({ reason: 'envelopePayloadNotObject', branch: 'gzip' }))
  return ok(parsed)
}

function tryParseUtf8Json(bytes: Uint8Array): unknown | null {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export interface EnvelopeCodecOptions {
  /** `meta` 键集（缺省 {@link ENVELOPE_META_KEYS}）。 */
  readonly metaKeys?: readonly string[]
}

/**
 * 解包信封。
 *
 * 三条分工（F-35：**meta 是唯一元数据真源**）：
 *  - `inner` = payload 解出的 JSON 根（原样）；
 *  - `meta` = 信封根上的元数据对象；
 *  - `plain` = `inner` 剔除 meta 键后与 `meta` **合并**（meta 胜出），
 *    并显式把 `documentFormat` 置为 `'Plain'`。
 *
 * 最后那一条是既有事实（`compactSceneDocument.ts:146-147` 的注释原文：
 * 「信封根上的 documentFormat: Envelope 会经 canonicalize 折入 meta；合并后须是
 * Plain 形，避免「下载 Plain」仍带 Envelope」）—— 不这么做，解出来的文档带着
 * `documentFormat:'Envelope'` 却已不是信封，再写回就会产出一份自相矛盾的文件。
 */
export function decodeEnvelope(doc: unknown, options: EnvelopeCodecOptions = {}): Result<DecodedEnvelope> {
  if (!isPlainObject(doc)) return err(invalidValue({ reason: 'envelopeNotObject' }))
  if (!isPlainObject(doc.meta)) return err(invalidValue({ reason: 'envelopeMissingMeta' }))
  const keys = options.metaKeys ?? ENVELOPE_META_KEYS

  const inner = decodeEnvelopePayload(doc.payloadEncoding, doc.payload)
  if (!inner.ok) return inner

  const meta = { ...doc.meta }
  const stripped: Record<string, unknown> = { ...inner.value }
  for (const k of keys) delete stripped[k]
  const plain: Record<string, unknown> = { ...stripped, ...meta, documentFormat: 'Plain' }

  return ok(
    Object.freeze({
      format: 'Envelope' as const,
      payloadEncoding: String(doc.payloadEncoding),
      meta: Object.freeze(meta),
      inner: Object.freeze(inner.value),
      plain: Object.freeze(plain),
      shape: classifyShape(plain),
    }),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 编码（`meta` 真源驱动；本实现内部确定性）
// ─────────────────────────────────────────────────────────────────────────────

export interface EncodeEnvelopeInput {
  /** 待打包的**明文**根（可以是裸结构，也可以是 World）。 */
  readonly plain: Readonly<Record<string, unknown>>
  /**
   * `meta` 覆盖。
   *
   * 缺省时从 `plain` 里 `pickEnvelopeMeta`（与旧 `buildEnvelopePackage` 同一口径）。
   * 显式给出时**以它为准** —— 这正是旧实现缺的那条路（读回 Envelope 改 meta 再写回）。
   */
  readonly meta?: Readonly<Record<string, unknown>>
  /** 载荷编码（缺省生产形态 `gzip+base64`）。 */
  readonly payloadEncoding?: string
}

/**
 * 打包信封 —— **语义等价**（不承诺逐字节；见文件头）。
 *
 * 实现要点（每条对应旧实现的一个缺口）：
 *  1. **接受任意 Plain 根**，包括"刚从一个 Envelope 解出来"的那份 ——
 *     旧 `buildEnvelopePackage` 会在这里抛错（`envelope.ts:69-71`）；
 *  2. `meta` 键从 body 里**剔除**（F-35），故 `meta` 与 body 不重复持有同一事实；
 *  3. gzip MTIME 钉死，于是本实现内部确定性；
 *  4. `base64(json)` 载荷**不**做 gzip（那是该取值的定义）。
 */
export function encodeEnvelope(input: EncodeEnvelopeInput, options: EnvelopeCodecOptions = {}): Result<Record<string, unknown>> {
  const keys = options.metaKeys ?? ENVELOPE_META_KEYS
  const encoding = input.payloadEncoding ?? COMPACT_PAYLOAD_ENCODING
  if (!SUPPORTED_PAYLOAD_ENCODINGS.includes(encoding)) {
    return err(invalidValue({ reason: 'envelopeUnsupportedPayloadEncoding', actual: String(encoding), supported: SUPPORTED_PAYLOAD_ENCODINGS.join('|') }))
  }
  const src = { ...input.plain }
  if (src.documentFormat === 'Envelope') {
    // 输入已经是信封形态 ⇒ 显式拒绝（而不是"顺手把信封塞进信封"）。
    // 调用方应当先 `decodeEnvelope`，这正是"闭合的读回写回"要防的用法错误。
    return err(invalidValue({ reason: 'envelopeInputAlreadyEnvelope' }))
  }
  const meta: Record<string, unknown> = input.meta !== undefined ? { ...input.meta } : {}
  const body: Record<string, unknown> = { ...src }
  if (input.meta === undefined) {
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(src, k)) meta[k] = src[k]
    }
  }
  for (const k of keys) delete body[k]

  const json = JSON.stringify(body)
  const utf8 = new TextEncoder().encode(json)
  let payload: string
  if (encoding === COMPACT_PAYLOAD_ENCODING) {
    payload = bytesToBase64(gzip(utf8))
  } else {
    payload = bytesToBase64(utf8)
  }
  return ok(
    Object.freeze({
      documentFormat: 'Envelope' as const,
      payloadEncoding: encoding,
      meta: Object.freeze(meta),
      payload,
    }),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 语义摘要（B-2 的判据载体）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Envelope 的**语义子树 canonical 摘要**（B-2 的判据）。
 *
 * 「语义子树」的定义沿用控制面 D2 的既有口径（`export-d2-compare.mjs:118-136`）：
 * 解包后的 body（World 形态即整个 inner；比对时剔除 `exportId`，
 * 因为它是**跨会话拼接**的来源标识，不是内容）。
 *
 * 为什么必须 canonical：`JSON.stringify` 的键序依赖插入顺序，
 * `gzip` 解出的对象键序由压缩端 `JSON.stringify` 顺序决定 —— 两个实现
 * （本模块 vs mod 侧 Gson）的键序天然不同。用 `canonicalize`（键序排序）后，
 * 「语义相同」不再要求「键序相同」。
 */
export function envelopeSemanticDigest(doc: unknown, options: EnvelopeCodecOptions = {}): Result<number> {
  const decoded = decodeEnvelope(doc, options)
  if (!decoded.ok) return decoded
  return ok(digestOf(semanticSubtreeOf(decoded.value.inner)))
}

/**
 * 语义子树的规范化形态（剔除 `exportId`；见上）。
 *
 * `exportId` 只由 cp 通道写出（B1 的 F-24/F-25），且**跨帧必须一致**。
 * 它在比对中的处置有既有判据（`export-acceptance.mjs:130-140`：
 * 「语义子树口径统一…并**剔除 `exportId`**」）—— 本函数是那条判据在本层的实现。
 */
export function semanticSubtreeOf(inner: Readonly<Record<string, unknown>>): unknown {
  const out: Record<string, unknown> = { ...inner }
  delete out.exportId
  if (Array.isArray(out.frames)) {
    out.frames = (out.frames as unknown[]).map((f) => {
      if (!isPlainObject(f)) return f
      const frame = { ...f }
      delete frame.exportId
      return frame
    })
  }
  return out
}

/** 两份文档的语义子树是否等价（**唯一**的 Envelope 相等判据）。 */
export function envelopeSemanticallyEqual(a: unknown, b: unknown, options: EnvelopeCodecOptions = {}): boolean {
  const da = envelopeSemanticDigest(a, options)
  const db = envelopeSemanticDigest(b, options)
  return da.ok && db.ok && da.value === db.value
}

/** canonical 字符串（供失败时给出可读证据；不参与相等判定本身）。 */
export function canonicalSubtreeText(inner: Readonly<Record<string, unknown>>): string {
  return canonicalize(semanticSubtreeOf(inner))
}
