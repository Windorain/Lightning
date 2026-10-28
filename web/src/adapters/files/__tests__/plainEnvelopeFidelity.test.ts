/**
 * A20 —— **Plain / Envelope 保真编解码**（旧格式夹具 + 负对照 a / c）。
 *
 * ## 这个文件证明什么（逐条对 A20 原文）
 *
 * | A20 原文 | 本文件 |
 * |---|---|
 * | 「外部清单逐项通过」 | 对 `web/e2e/fixtures/` 的**真夹具**做往返：Plain 逐字节、Envelope 语义摘要 |
 * | 「不支持有诊断且无伪成功产物」 | 越界索引 / 未支持编码 / 非对象负载**全部**返回 `ok:false`，且断言"失败时没有产物" |
 * | 负对照「静默丢未知语义」 | 未知字段不进保真记录 ⇒ 判红（用**对照实现**证伪，不是自己 throw） |
 *
 * ## 铁律 6（CRLF）
 *
 * 本文件读夹具与源码都经 {@link readTextAsIs} / {@link readSource}：
 *   - **夹具**在"逐字节"断言里**必须原样读**（归一化行尾会直接破坏判据本身，
 *     而那正是"在工作树 LF 上写绿、新鲜检出 CRLF 上必红"的反面：
 *     这里若归一化，就会在两种检出上都"绿"，但绿的原因与产物无关）；
 *   - **源码**（用于结构断言的）经 `replace(/\r\n/g,'\n')` 归一化。
 *
 * 更具体地说：`encodePlain` 的逐字节判据**不依赖任何** `\n` 字面量
 * （它只做"在根花括号后插一段"），故它天然两种行尾都过 ——
 * 这一点由 {@link fixturesAreByteExactUnderBothEol} 直接测出来，
 * 而不是靠"恰好没写 `\n`"。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { RuntimeDocument } from '@/context/runtimeDocument'

import {
  decodePlain,
  encodePlain,
  isEnvelopeDocument,
  readDocumentFormat,
  readPlainText,
  readSceneMetaField,
  sceneStableStringIdFromDocument,
  plainTextToBytes,
  type PlainDocument,
} from '@/adapters/files/plainCodec'
import {
  canonicalSubtreeText,
  decodeEnvelope,
  encodeEnvelope,
  envelopeSemanticDigest,
  envelopeSemanticallyEqual,
  COMPACT_PAYLOAD_ENCODING,
  ENVELOPE_META_KEYS,
  PLAIN_BASE64_PAYLOAD_ENCODING,
  semanticSubtreeOf,
  SUPPORTED_PAYLOAD_ENCODINGS,
} from '@/adapters/files/envelopeCodec'
import { artifactKindOfKey, parseFidelityStoreKey } from '@/application/recovery'
import {
  captureFidelity,
  CORE_EXTRA_BAG_KEY,
  fidelityDigest,
  fidelityFieldNames,
  fidelityStorageKey,
  fidelityVerdictError,
  hasCoreExtraBag,
  hasFidelityFields,
  judgeFidelityAfterEdit,
  parseFidelity,
  serializeFidelity,
  type FidelityRecord,
} from '@/adapters/files/fidelityRecord'
import { realFixtureText, withRealFixture } from '../../../../e2e/real-fixture-vitest'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具与工具
// ─────────────────────────────────────────────────────────────────────────────

const WEB_ROOT = process.cwd()
const FIXTURES = path.join(WEB_ROOT, 'e2e', 'fixtures')
const STRUCTUREDATA_FIXTURE_KEY = 'structureDataExportedEnvelope'

/**
 * 仓内 Plain 件**原样读**（**不**归一化行尾）—— 逐字节判据的载体。
 * 外置 Envelope 经 `realFixtureText`（惰性读 + LF 归一化；其判据只比语义，不逐字节）。
 */
function readTextAsIs(name: string): string {
  if (name === ENVELOPE_FIXTURE) return realFixtureText(STRUCTUREDATA_FIXTURE_KEY)
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
}

/** 读源码并归一化行尾为 LF（铁律 6）。 */
function readSource(rel: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, 'src', rel), 'utf8').replace(/\r\n/g, '\n')
}

function parseAsIs(name: string): Record<string, unknown> {
  return JSON.parse(readTextAsIs(name)) as Record<string, unknown>
}

/** 生产解析链的注册顺序（与 `workbenchHost`/`embedHost` 逐字一致）。 */
function productionParsers() {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

/** 真夹具清单（四个都有明确角色，不是"随便挑几个文件"）。 */
const V2_PLAIN_FIXTURES = ['minimal-v2.json', 'parts-ae2-multibox.v2.json', 'parts-singlebox-mix.v2.json'] as const
const ENVELOPE_FIXTURE = 'structuredata-exported-envelope.json'
const BASELINE_FIXTURE = 'b2-item-index-baseline-no-parts.json'

// ─────────────────────────────────────────────────────────────────────────────
// 一、B-1：Plain **逐字节**
// ─────────────────────────────────────────────────────────────────────────────

describe('B-1 Plain 明文：逐字节往返（旧格式夹具的 Plain 面）', () => {
  it('反空洞真：仓内 Plain 真夹具存在且非空（否则下面的"逐字节相等"可能只是没读到东西）', () => {
    for (const name of [...V2_PLAIN_FIXTURES, BASELINE_FIXTURE]) {
      const p = path.join(FIXTURES, name)
      expect(fs.existsSync(p), `${name} 必须存在（逐字节判据依赖真夹具）`).toBe(true)
      expect(fs.statSync(p).size, `${name} 不得为空`).toBeGreaterThan(100)
    }
  })

  withRealFixture(
    STRUCTUREDATA_FIXTURE_KEY,
    '反空洞真：外置 Envelope 真夹具存在且非空（>100KB）',
    () => {
      // Envelope 夹具是 204KB 级的真产物 —— 用大小把它与"手写小样本"区分开。
      expect(
        Buffer.byteLength(realFixtureText(STRUCTUREDATA_FIXTURE_KEY), 'utf8'),
        'Envelope 夹具应为真导出产物（>100KB）',
      ).toBeGreaterThan(100_000)
    },
  )

  it('**命令通道口径**的 Plain 产物（已带 documentFormat）逐字节恒等 —— 对每个真夹具', () => {
    for (const name of V2_PLAIN_FIXTURES) {
      const text = readTextAsIs(name)
      // 造一份"命令通道口径"的产物：mod 侧 serialize(raw=true) 会写 documentFormat。
      const commandChannel = injectDocumentFormat(text)
      const decoded = decodePlain(commandChannel)
      expect(decoded.ok, `${name}: 应当解得出`).toBe(true)
      if (!decoded.ok) continue
      const written = encodePlain(decoded.value)
      expect(written.ok, `${name}: 应当写得出`).toBe(true)
      if (!written.ok) continue
      expect(written.value === commandChannel, `${name}: 写出必须与输入逐字节相同`).toBe(true)
      // 反向也断言一次"字节"（不只是字符串），因为契约的措辞是"逐字节"。
      expect([...plainTextToBytes(written.value)], `${name}: UTF-8 字节也必须相同`).toEqual([...plainTextToBytes(commandChannel)])
    }
  })

  it('写出的字节与 `plainTextToBytes(readPlainText(bytes))` 一致（读取侧零变换）', () => {
    const text = injectDocumentFormat(readTextAsIs('minimal-v2.json'))
    const bytes = plainTextToBytes(text)
    expect(readPlainText(bytes)).toBe(text)
  })

  it('已带 `documentFormat` 的输入 ⇒ 写出**原样返回**（幂等，一个字符都不动）', () => {
    const text = injectDocumentFormat(readTextAsIs('minimal-v2.json'))
    const d = decodePlain(text)
    expect(d.ok).toBe(true)
    if (!d.ok) return
    const once = encodePlain(d.value)
    expect(once.ok).toBe(true)
    if (!once.ok) return
    expect(once.value).toBe(text)
    // 幂等的第二相：对写出结果再解再写，仍然不变。
    const d2 = decodePlain(once.value)
    expect(d2.ok).toBe(true)
    if (!d2.ok) return
    const twice = encodePlain(d2.value)
    expect(twice.ok).toBe(true)
    if (!twice.ok) return
    expect(twice.value).toBe(text)
  })

  it('**逐字节判据不依赖行尾**：CRLF 与 LF 两种口径都恒等（铁律 6）', () => {
    // 这是"恰好安全"与"被证明安全"的分界：本断言**真的**把同一份内容按两种行尾各写一遍。
    const lf = injectDocumentFormat(readTextAsIs('minimal-v2.json')).replace(/\r\n/g, '\n')
    const crlf = lf.replace(/\n/g, '\r\n')
    for (const [label, text] of [['LF', lf], ['CRLF', crlf]] as const) {
      const d = decodePlain(text)
      expect(d.ok, `${label}: 应当解得出`).toBe(true)
      if (!d.ok) continue
      const w = encodePlain(d.value)
      expect(w.ok, `${label}: 应当写得出`).toBe(true)
      if (!w.ok) continue
      expect(w.value === text, `${label}: 行尾必须原样保留（逐字节）`).toBe(true)
    }
  })

  it('缺 `documentFormat` 的旧文件：**首次**写出规范化补键，**其后**逐字节稳定', () => {
    // 诚实边界（见 plainCodec 文件头）：历史手写夹具没有该键，第一次写出必然多一个键。
    // 本断言把这个事实写成可核对的两相，而不是含糊地说"支持往返"。
    const legacy = readTextAsIs('minimal-v2.json')
    expect(legacy.includes('"documentFormat"'), '该夹具确实没有 documentFormat（这就是"旧文件"的定义）').toBe(false)
    const d1 = decodePlain(legacy)
    expect(d1.ok).toBe(true)
    if (!d1.ok) return
    const w1 = encodePlain(d1.value)
    expect(w1.ok).toBe(true)
    if (!w1.ok) return
    expect(w1.value.startsWith('{"documentFormat":"Plain",'), '补键位置固定在根对象起始处').toBe(true)
    // 其余内容逐字未动：去掉插入项应当还原成原文。
    expect(w1.value.replace('{"documentFormat":"Plain",', '{')).toBe(legacy)
    // 第二相：稳定。
    const d2 = decodePlain(w1.value)
    expect(d2.ok).toBe(true)
    if (!d2.ok) return
    const w2 = encodePlain(d2.value)
    expect(w2.ok).toBe(true)
    if (!w2.ok) return
    expect(w2.value).toBe(w1.value)
  })

  withRealFixture(
    STRUCTUREDATA_FIXTURE_KEY,
    '**负对照**：`decodePlain` 拒绝 Envelope 输入（不会"解出一份空文档"当成功）',
    () => {
    const env = readTextAsIs(ENVELOPE_FIXTURE)
    const d = decodePlain(env)
    expect(d.ok, '拿错解码器必须显式失败').toBe(false)
    if (d.ok) return
    expect(d.error.code).toBe('InvalidValue')
    expect(d.error.params.reason).toBe('plainWrongFormat')
    expect(d.error.params.actual).toBe('Envelope')
  })

  it('**负对照**：`encodePlain` 在"文本与结构化值不一致"时拒绝，不静默按结构化值重写', () => {
    const d = decodePlain(injectDocumentFormat(readTextAsIs('minimal-v2.json')))
    expect(d.ok).toBe(true)
    if (!d.ok) return
    const tampered: PlainDocument = Object.freeze({ ...d.value, document: Object.freeze({ ...d.value.document, documentFormat: 'Envelope' }) })
    const w = encodePlain(tampered)
    expect(w.ok).toBe(false)
    if (w.ok) return
    expect(w.error.params.reason).toBe('plainDocumentFormatMismatch')
  })
})

/** 把 `documentFormat: "Plain"` 插到根对象起始处（模拟 mod 侧 `serialize(raw=true)` 的口径）。 */
function injectDocumentFormat(text: string): string {
  const brace = text.indexOf('{')
  return `${text.slice(0, brace + 1)}"documentFormat":"Plain",${text.slice(brace + 1)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// 二、B-2：Envelope **语义等价**（禁止逐字节）
// ─────────────────────────────────────────────────────────────────────────────

describe('B-2 Envelope：语义子树 canonical 摘要相等（旧格式夹具的 Envelope 面）', () => {
  withRealFixture(
    STRUCTUREDATA_FIXTURE_KEY,
    '真 Envelope 夹具可解包；内层含发布所需的 geometry / palette / texture',
    () => {
    const env = parseAsIs(ENVELOPE_FIXTURE)
    expect(readDocumentFormat(env)).toBe('Envelope')
    expect(isEnvelopeDocument(env)).toBe(true)
    const d = decodeEnvelope(env)
    expect(d.ok, '真 Envelope 必须解得出').toBe(true)
    if (!d.ok) return
    expect(d.value.payloadEncoding).toBe(COMPACT_PAYLOAD_ENCODING)
    expect(Array.isArray(d.value.inner.cellGrid), '内层 body 必须有 cellGrid').toBe(true)
    expect(Array.isArray(d.value.inner.blockPalette), '内层 body 必须有 blockPalette').toBe(true)
    expect(Array.isArray(d.value.inner.textureBlobs), '内层 body 必须有 textureBlobs').toBe(true)
    // meta 是元数据真源：id 在 meta 里，不在 body 里。
    expect(typeof d.value.meta.id).toBe('string')
    expect(d.value.inner.id, 'meta 键必须已从 body 剔除（F-35）').toBeUndefined()
  })

  withRealFixture(
    STRUCTUREDATA_FIXTURE_KEY,
    '解包 → 打包 → 再解包：**语义摘要相等**（B-2 的判据载体）',
    () => {
    const env = parseAsIs(ENVELOPE_FIXTURE)
    const d1 = decodeEnvelope(env)
    expect(d1.ok).toBe(true)
    if (!d1.ok) return
    const repacked = encodeEnvelope({ plain: d1.value.plain, meta: d1.value.meta })
    expect(repacked.ok).toBe(true)
    if (!repacked.ok) return
    const digestA = envelopeSemanticDigest(env)
    const digestB = envelopeSemanticDigest(repacked.value)
    expect(digestA.ok && digestB.ok).toBe(true)
    if (!digestA.ok || !digestB.ok) return
    expect(digestB.value, '往返后语义子树摘要必须相等').toBe(digestA.value)
    expect(envelopeSemanticallyEqual(env, repacked.value)).toBe(true)
  })

  withRealFixture(
    STRUCTUREDATA_FIXTURE_KEY,
    '**负对照**：Envelope **禁止**逐字节 —— 同一内容两处 gzip MTIME 不同 ⇒ 字节不同但语义相等',
    () => {
    // 这条是 B-2 那句「gzip 头含 MTIME ⇒ 禁止逐字节」的可执行形式：
    // 构造两份**语义相同、字节不同**的信封，断言"逐字节相等"为 false 而"语义相等"为 true。
    // 若有人把判据写成逐字节，这一条立刻暴露它。
    const env = parseAsIs(ENVELOPE_FIXTURE) as Record<string, unknown>
    const d = decodeEnvelope(env)
    expect(d.ok).toBe(true)
    if (!d.ok) return
    const a = encodeEnvelope({ plain: d.value.plain, meta: d.value.meta })
    const b = encodeEnvelope({ plain: d.value.plain, meta: d.value.meta })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    // 本实现内部钉死 MTIME ⇒ 确定性（这是"本实现可复现"的断言，不是 B-2 的判据）。
    expect(a.value.payload, '本实现钉死 MTIME ⇒ 同一输入字节相同').toBe(b.value.payload)

    // 与**原夹具**比较：原产物的 MTIME 由 mod 侧 Gson/Java 决定，与本实现不同 ⇒ 字节必然不同。
    expect(a.value.payload === env.payload, '跨实现的 gzip 字节不同（这正是禁止逐字节的原因）').toBe(false)
    // 而语义仍然相等：这才是判据。
    expect(envelopeSemanticallyEqual(a.value, env), '语义必须相等（字节不同不影响）').toBe(true)
  })

  it('语义子树**剔除 `exportId`**（跨会话拼接标识不是内容；沿用控制面 D2 口径）', () => {
    const inner = { id: 'x', exportId: 'run-a', frames: [{ index: 0, exportId: 'run-a', structure: { geometryPhase: 'baked' } }] }
    const other = { id: 'x', exportId: 'run-b', frames: [{ index: 0, exportId: 'run-b', structure: { geometryPhase: 'baked' } }] }
    expect(canonicalSubtreeText(inner)).toBe(canonicalSubtreeText(other))
    const s = semanticSubtreeOf(inner) as Record<string, unknown>
    expect(s.exportId).toBeUndefined()
    expect((s.frames as Record<string, unknown>[])[0]!.exportId).toBeUndefined()
  })

  withRealFixture(
    STRUCTUREDATA_FIXTURE_KEY,
    '**负对照**：语义子树的**内容**不同则摘要不同（证明摘要不是恒等常量）',
    () => {
    const env = parseAsIs(ENVELOPE_FIXTURE)
    const d = decodeEnvelope(env)
    expect(d.ok).toBe(true)
    if (!d.ok) return
    // 用**非 meta 键**做变异：`label` 是 ENVELOPE_META_KEYS 成员，会被 `encodeEnvelope`
    // 搬进 meta 并从 body 剔除 —— 于是摘要不变是**正确**行为（meta 不是语义子树）。
    // 这条注释本身就是一处判据说明：变异必须落在语义子树上，否则这个负对照测的是别的东西。
    const mutated = { ...d.value.inner, viewerExtensionNote: 'mutated-by-negative-control' }
    expect(ENVELOPE_META_KEYS.includes('viewerExtensionNote'), '变异键不得是 meta 键（否则它不进语义子树）').toBe(false)
    const a = envelopeSemanticDigest(env)
    const b = envelopeSemanticDigest({ ...env, payload: repackPayloadObject(mutated, String(env.payloadEncoding)) })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(b.value, '内容变了摘要必须变').not.toBe(a.value)
  })

  withRealFixture(
    STRUCTUREDATA_FIXTURE_KEY,
    '未知 `payloadEncoding` **显式报错**（F-04），不静默退化',
    () => {
    const env = parseAsIs(ENVELOPE_FIXTURE)
    const bad = { ...env, payloadEncoding: 'lzma+base64' }
    const d = decodeEnvelope(bad)
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.error.params.reason).toBe('envelopeUnsupportedPayloadEncoding')
    expect(String(d.error.params.supported)).toBe(SUPPORTED_PAYLOAD_ENCODINGS.join('|'))
  })

  it('两个合法 `payloadEncoding` 取值都支持，且 `base64(json)` 走同一读取路径', () => {
    const plainFixture = parseAsIs('minimal-v2.json')
    const built = encodeEnvelope({ plain: plainFixture, payloadEncoding: PLAIN_BASE64_PAYLOAD_ENCODING })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const back = decodeEnvelope(built.value)
    expect(back.ok, 'base64(json) 必须能被同一路径解开').toBe(true)
    if (!back.ok) return
    expect(back.value.payloadEncoding).toBe(PLAIN_BASE64_PAYLOAD_ENCODING)
    // `id` 是 meta 键（F-35）⇒ 打包时进 `meta`、从 body 剔除；解包后仍在 `meta` 里。
    // 断言"元数据真源"这一条：`id` 必须能从 `meta` 读到，且 body 里没有它。
    expect(back.value.meta.id).toBe('e2e-minimal')
    expect(back.value.inner.id, 'meta 键必须已从 body 剔除（F-35）').toBeUndefined()
  })

  withRealFixture(
    STRUCTUREDATA_FIXTURE_KEY,
    '**负对照**：`encodeEnvelope` 拒绝 Envelope 入参（不把信封塞进信封）',
    () => {
    const env = parseAsIs(ENVELOPE_FIXTURE)
    const r = encodeEnvelope({ plain: env })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.params.reason).toBe('envelopeInputAlreadyEnvelope')
  })

  it('B-2 的 meta 键集与旧层既有一致（逐项；漂移即判红）', () => {
    // 本模块不得 import 旧层（边界闸门判据），故清单在这里重复了一份字面量。
    // 重复的代价由本断言抵偿：旧清单改了就判红。
    const legacySource = readSource('pure/envelopeMetaKeys.ts')
    const m = /export const ENVELOPE_META_KEYS = \[([\s\S]*?)\] as const/.exec(legacySource)
    expect(m, '旧清单必须仍可被解析（否则本断言失效）').not.toBeNull()
    const legacyKeys = [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1])
    expect(legacyKeys.length).toBeGreaterThan(0)
    expect([...ENVELOPE_META_KEYS]).toEqual(legacyKeys)
  })

  it('P-07..P-10：Plain 格式判别 / 元数据读取 / 稳定 id 的语义逐条成立', () => {
    // Plain 只读根。
    const plain = parseAsIs('minimal-v2.json')
    expect(readDocumentFormat(plain), '缺 documentFormat ⇒ 视为 Plain（兼容旧 JSON）').toBeUndefined()
    expect(readSceneMetaField(plain, 'id')).toBe('e2e-minimal')
    expect(sceneStableStringIdFromDocument({}), '无 id ⇒ 回退 scene（逐字保留）').toBe('scene')
    // 结构性判定：`documentFormat` 被折入 meta 的情形仍识别为 Envelope。
    expect(isEnvelopeDocument({ payloadEncoding: COMPACT_PAYLOAD_ENCODING, payload: 'e30=', meta: {} })).toBe(true)
  })

  withRealFixture(
    STRUCTUREDATA_FIXTURE_KEY,
    'P-07..P-10：真 Envelope 的格式判别 / 元数据读取 / 稳定 id 语义成立',
    () => {
      const env = parseAsIs(ENVELOPE_FIXTURE)
      expect(readDocumentFormat(env)).toBe('Envelope')
      // Envelope 只读 meta（**不**回落根）。
      expect(readSceneMetaField(env, 'id')).toBe(String((env.meta as Record<string, unknown>).id))
      expect(readSceneMetaField(env, 'definitely-not-present')).toBe('')
      expect(sceneStableStringIdFromDocument(env)).toBe(String((env.meta as Record<string, unknown>).id))
    },
  )
})

/** 用当前实现重新打包一份任意 inner（负对照用）。 */
function repackPayloadObject(inner: Record<string, unknown>, payloadEncoding: string): string {
  const built = encodeEnvelope({ plain: inner, meta: {}, payloadEncoding })
  if (!built.ok) throw new Error(`negative-control repack 失败：${built.error.code}`)
  return String(built.value.payload)
}

// ─────────────────────────────────────────────────────────────────────────────
// 三、未知字段 ⇒ 保真记录（**不塞核心 `_extra`**）；负对照 a
// ─────────────────────────────────────────────────────────────────────────────

/** 本适配器能解释的顶层键（其余进保真记录）。清单与 `legacyFields` 的透传表同源。 */
const KNOWN_PLAIN_KEYS = [
  'format_version',
  'id',
  'label',
  'author',
  'gtnhVersion',
  'gtVersion',
  'structureId',
  'description',
  'meta',
  'frames',
  'annotations',
  'labels',
  'materialPalette',
  'blockPalette',
  'textureBlobs',
  'tooltipPalette',
  'cellTooltipGrid',
  'cellPartsGrid',
  'partLists',
  'partIconTextures',
  'itemIndex',
  'playback',
  'statsTemplate',
  'statsOverride',
  'geometryPhase',
  'cellGrid',
  'captureWorld',
  'documentShape',
  'documentFormat',
  'schemaVersion',
] as const

describe('未知字段 ⇒ 带源格式/源版本的保真记录（A20 负对照 a）', () => {
  it('未知顶层字段被采集进记录，**带**源格式与源版本', () => {
    const raw = { format_version: '2.0', id: 'x', frames: [], totallyUnknownField: { a: 1 }, anotherOne: 'y' }
    const rec = captureFidelity({ sourceFormat: 'V2Plain', sourceVersion: '2.0', raw, knownKeys: KNOWN_PLAIN_KEYS })
    expect(rec.ok).toBe(true)
    if (!rec.ok) return
    expect(rec.value.sourceFormat).toBe('V2Plain')
    expect(rec.value.sourceVersion).toBe('2.0')
    expect(fidelityFieldNames(rec.value)).toEqual(['anotherOne', 'totallyUnknownField'])
    expect(hasFidelityFields(rec.value)).toBe(true)
  })

  it('**负对照 a**：不把未知字段写进记录 ⇒ 同一判据判红（用对照实现证伪，不是自己 throw）', () => {
    const raw = { format_version: '2.0', id: 'x', frames: [], totallyUnknownField: { a: 1 }, anotherOne: 'y' }
    const real = captureFidelity({ sourceFormat: 'V2Plain', sourceVersion: '2.0', raw, knownKeys: KNOWN_PLAIN_KEYS })
    expect(real.ok).toBe(true)
    if (!real.ok) return

    /**
     * **对照实现**：只"看起来"做了保真 —— 它建了记录对象，但 `fields` 恒为空。
     * 这正是"静默丢未知语义"的形态：没有报错、没有警告，产物看起来也正常。
     */
    const naiveCapture = (): FidelityRecord => Object.freeze({ sourceFormat: 'V2Plain', sourceVersion: '2.0', fields: Object.freeze({}) })

    /** 判据（与正向断言**同一个**函数）：记录的字段集必须覆盖全部未知键。 */
    const lostFields = (r: FidelityRecord, unknown: readonly string[]): readonly string[] =>
      unknown.filter((k) => !Object.prototype.hasOwnProperty.call(r.fields, k))

    const unknownKeys = ['anotherOne', 'totallyUnknownField']
    // 正向：真实实现无丢失。
    expect(lostFields(real.value, unknownKeys), '真实实现不得丢任何未知字段').toEqual([])
    // 负对照：对照实现必须被判红 —— 这就是"静默丢未知语义 ⇒ 判红"。
    expect(lostFields(naiveCapture(), unknownKeys), '静默丢未知语义必须判红').toEqual(unknownKeys)
  })

  withRealFixture(
    STRUCTUREDATA_FIXTURE_KEY,
    '**负对照 a（端到端）**：真夹具里的未知字段若被丢弃，往返摘要必变',
    () => {
    // 更强的形态：不合成输入，而是给真夹具**加**一个未知字段，验证"它必须活过往返"。
    const env = parseAsIs(ENVELOPE_FIXTURE)
    const d = decodeEnvelope(env)
    expect(d.ok).toBe(true)
    if (!d.ok) return
    const withUnknown = { ...d.value.plain, vendorSpecificBlock: { note: '来自别家的扩展' } }
    const rec = captureFidelity({ sourceFormat: 'Envelope', sourceVersion: String(env.payloadEncoding), raw: withUnknown, knownKeys: KNOWN_PLAIN_KEYS })
    expect(rec.ok).toBe(true)
    if (!rec.ok) return
    // 判据不是"只有这一个未知键"，而是"这个未知键**在**记录里"。
    // `mode` / `source` / `scanBounds` 等由 meta 合并进来的键也在未知集里
    // （它们不在 `KNOWN_PLAIN_KEYS` 里）—— 那恰好说明记录是**完整**的，
    // 而不是只挑了显眼的那一个。
    expect(fidelityFieldNames(rec.value), '未知字段必须进记录').toContain('vendorSpecificBlock')

    // 真实往返：把未知字段随 plain 一起打包 ⇒ 摘要保持不变（它确实被保留了）。
    const repacked = encodeEnvelope({ plain: withUnknown, meta: d.value.meta })
    expect(repacked.ok).toBe(true)
    if (!repacked.ok) return
    const back = decodeEnvelope(repacked.value)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.value.inner.vendorSpecificBlock, '未知字段必须原样往返').toEqual({ note: '来自别家的扩展' })

    // 对照：**丢掉**未知字段再打包 ⇒ 摘要变了（证明摘要真的覆盖它）。
    const dropped: Record<string, unknown> = { ...withUnknown }
    delete dropped.vendorSpecificBlock
    const repackedDropped = encodeEnvelope({ plain: dropped, meta: d.value.meta })
    expect(repackedDropped.ok).toBe(true)
    if (!repackedDropped.ok) return
    const digestFull = envelopeSemanticDigest(repacked.value)
    const digestDropped = envelopeSemanticDigest(repackedDropped.value)
    expect(digestFull.ok && digestDropped.ok).toBe(true)
    if (!digestFull.ok || !digestDropped.ok) return
    expect(digestDropped.value, '丢了未知字段 ⇒ 语义摘要必须不同（判据真的看得见它）').not.toBe(digestFull.value)
  })

  it('「不塞核心 `_extra`」：采集器**不**把 `_extra` 当未知字段收集，且能检出它的存在', () => {
    const raw = { [CORE_EXTRA_BAG_KEY]: { old: true }, honestUnknown: 1 }
    const rec = captureFidelity({ sourceFormat: 'Plain', sourceVersion: '1', raw, knownKeys: [] })
    expect(rec.ok).toBe(true)
    if (!rec.ok) return
    expect(fidelityFieldNames(rec.value), '`_extra` 不是"未知字段"，它是旧机制的名字').toEqual(['honestUnknown'])
    expect(hasCoreExtraBag(raw), '核心字段袋必须可被检出（核心无字段袋的判据面）').toBe(true)
    expect(hasCoreExtraBag({ frames: [] })).toBe(false)
  })

  it('**负对照**：读取一份"含 `_extra` 的保真记录"必须显式拒绝（不让旧机制经存储层回来）', () => {
    const text = JSON.stringify({ sourceFormat: 'Plain', sourceVersion: '1', fields: { [CORE_EXTRA_BAG_KEY]: { old: true } } })
    const parsed = parseFidelity(text)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.params.reason).toBe('fidelityRecordContainsExtraBag')
  })

  it('记录的序列化往返：逐字段保留，且摘要稳定', () => {
    const raw = { unknownA: [1, 2, 3], unknownB: { nested: true } }
    const rec = captureFidelity({ sourceFormat: 'X', sourceVersion: '9', raw, knownKeys: [] })
    expect(rec.ok).toBe(true)
    if (!rec.ok) return
    const round = parseFidelity(serializeFidelity(rec.value))
    expect(round.ok).toBe(true)
    if (!round.ok) return
    expect(round.value.fields).toEqual(rec.value.fields)
    expect(fidelityDigest(round.value)).toBe(fidelityDigest(rec.value))
  })

  it('存储键按**文档 ID** 命名（与"经文档 ID 重新绑定"同一思路）', () => {
    // ## 键口径已并入 recovery/save 家族
    //
    // 原先这三条断言的是**游离**方案的字面量 `lk.fidelity.v1.<id>.record`
    // （缺 scope/instance 段、无解析器、不被 `artifactKindOfKey` 识别）。
    // D1(b) 把它并入同族 ⇒ 键形状改变，故本条按**新契约**改写
    // （不是"为了让测试变绿"：新形状本身是 D1(b) 的交付内容）。
    // 键口径的权威判据在 `application/__tests__`（含解析器与分类器），
    // 本条只钉"本转发函数确实走权威构造器且区分文档"。
    expect(fidelityStorageKey('doc-a')).toBe('lk.fidelity.v1.workbench.default.doc-a')
    expect(fidelityStorageKey('doc-a')).not.toBe(fidelityStorageKey('doc-b'))
    expect(fidelityStorageKey('   '), '空 id 不产生一个会撞车的空段').toBe(
      'lk.fidelity.v1.workbench.default.unnamed',
    )
    // 且新键**可解析**（旧方案结构上不可逆 —— 那是本段要消灭的性质）
    const parsed = parseFidelityStoreKey(fidelityStorageKey('doc-a'))
    expect(parsed, 'D1(b)：保真键必须可解析（旧方案无解析器）').not.toBeNull()
    expect(parsed!.documentId).toBe('doc-a')
    expect(artifactKindOfKey(fidelityStorageKey('doc-a')), 'D1(b)：必须被制品分类器识别').toBe(
      'fidelity-record',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 四、编辑后的有效性判断
// ─────────────────────────────────────────────────────────────────────────────

describe('编辑后对保真记录的**显式**有效性判断（「编辑发生后对其有效性作明确判断」）', () => {
  const record = (): FidelityRecord => {
    const r = captureFidelity({ sourceFormat: 'V2Plain', sourceVersion: '2.0', raw: { cellNotesExt: [[-1]], otherExt: 7 }, knownKeys: [] })
    if (!r.ok) throw new Error('fixture record 构造失败')
    return r.value
  }

  it('未编辑 ⇒ `valid`（**唯一**可以原样写回的状态）', () => {
    const v = judgeFidelityAfterEdit(record(), { removedRootKeys: [], indexSpaceKeys: [] })
    expect(v.status).toBe('valid')
    expect(fidelityVerdictError(v, 'V2Plain')).toBeNull()
  })

  it('字段被编辑移除 ⇒ `dropped`（**不得**再写回，否则复活已删除内容）', () => {
    const v = judgeFidelityAfterEdit(record(), { removedRootKeys: ['otherExt'], indexSpaceKeys: [] })
    expect(v.status).toBe('dropped')
    if (v.status !== 'dropped') return
    expect(v.removedFields).toEqual(['otherExt'])
    expect(v.reason).toBe('fieldRemovedByEdit')
    const e = fidelityVerdictError(v, 'V2Plain')
    expect(e?.code).toBe('InvalidValue')
    expect(e?.params.reason).toBe('fidelityFieldRemovedByEdit')
  })

  it('索引空间被改动 ⇒ `stale` 且**保守地**把全部字段列为风险项（未知字段没人懂）', () => {
    const v = judgeFidelityAfterEdit(record(), { removedRootKeys: [], indexSpaceKeys: ['cellGrid'] })
    expect(v.status).toBe('stale')
    if (v.status !== 'stale') return
    expect(v.keys).toEqual(['cellGrid'])
    expect(v.atRiskFields, '不得声称"这个字段不受影响"（那是一次无人能证伪的猜测）').toEqual(fidelityFieldNames(record()))
    const e = fidelityVerdictError(v, 'V2Plain')
    expect(e?.code, '能力不足 ⇒ UnsupportedOperation（不是 InvalidValue）').toBe('UnsupportedOperation')
    expect(e?.params.reason).toBe('fidelityIndexSpaceMoved')
  })

  it('判定**顺序**是判据的一部分：既删字段又动索引 ⇒ 报 `dropped`（确定性优先）', () => {
    const v = judgeFidelityAfterEdit(record(), { removedRootKeys: ['cellNotesExt'], indexSpaceKeys: ['cellGrid'] })
    expect(v.status, '已被删除的字段不该先被报成 stale（那会让调用方去"重新解释"不存在的东西）').toBe('dropped')
  })

  it('**负对照**：`stale` 与 `dropped` 必须互斥 —— 把两者压成一个布尔就判红', () => {
    // 对照实现：只返回布尔。
    const naiveVerdict = (removed: readonly string[]): boolean => removed.length === 0
    const staleCase = judgeFidelityAfterEdit(record(), { removedRootKeys: [], indexSpaceKeys: ['cellGrid'] })
    const droppedCase = judgeFidelityAfterEdit(record(), { removedRootKeys: ['otherExt'], indexSpaceKeys: [] })
    // 真实实现把两者分开。
    expect(staleCase.status).not.toBe(droppedCase.status)
    // 对照实现把两者压成同一个 `true` ⇒ 调用方无法区分"要重新解释"与"不必动"。
    expect(naiveVerdict([]), '对照实现给出 true').toBe(true)
    expect(staleCase.status === 'valid', '真实实现对 stale 给的不是 valid').toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 五、基线夹具（字节指纹）—— 用真夹具的元数据断言，不重复其内容
// ─────────────────────────────────────────────────────────────────────────────

describe('B-1 基线指纹夹具：本次读取不改变它的语义（b2-item-index-baseline-no-parts.json）', () => {
  it('夹具登记的两条指纹都在，且各自指向一个真实存在的夹具', () => {
    const baseline = parseAsIs(BASELINE_FIXTURE) as { entries: Record<string, { sha256: string; bytes: number }> }
    expect(Object.keys(baseline.entries).sort()).toEqual(['minimal-v2', 'structuredata-exported-envelope'])
    for (const [name, entry] of Object.entries(baseline.entries)) {
      expect(entry.sha256, `${name}: 指纹必须是 64 位 hex`).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.bytes, `${name}: 字节数必须为正`).toBeGreaterThan(0)
    }
  })

  it('基线声明的"无部件"性质在 minimal-v2 上仍成立（无 `itemIndex` / 无 `hostItem` / 无 `cellPartsGrid`）', () => {
    // 基线的用途是"无部件文档字节必须不变"。它的 `entries` **只**登记两份夹具
    // （`minimal-v2` 与 `structuredata-exported-envelope`）—— 故本断言**只**对这两份成立。
    // 若拿全部 V2 夹具去断言会得出假结论：`parts-*.v2.json` 是**含部件**的
    // （它们有 `cellPartsGrid`/`partLists`），而它们**不在**基线登记里，这正是一致的事实。
    const baseline = parseAsIs(BASELINE_FIXTURE) as { entries: Record<string, unknown> }
    expect(Object.keys(baseline.entries).sort()).toEqual(['minimal-v2', 'structuredata-exported-envelope'])

    const minimal = parseAsIs('minimal-v2.json')
    expect(minimal.itemIndex, 'minimal-v2: 基线前提是无部件').toBeUndefined()
    const frame = (minimal.frames as Record<string, unknown>[])[0]!
    const struct = frame.structure as Record<string, unknown>
    expect(struct.cellPartsGrid, 'minimal-v2: 基线前提是无部件').toBeUndefined()
    expect(struct.partLists, 'minimal-v2: 基线前提是无部件').toBeUndefined()
    expect((struct.blockPalette as Record<string, unknown>[]).some((e) => e.hostItem !== undefined), 'minimal-v2: 不得有 hostItem').toBe(false)

    // 对照组（证明上面的断言不是"随便哪个夹具都过"）：两个含部件夹具**确实**有部件字段。
    for (const name of ['parts-ae2-multibox.v2.json', 'parts-singlebox-mix.v2.json']) {
      const doc = parseAsIs(name)
      const f = (doc.frames as Record<string, unknown>[])[0]!
      const s = f.structure as Record<string, unknown>
      expect(Array.isArray(s.cellPartsGrid), `${name}: 含部件夹具必须有 cellPartsGrid（负对照）`).toBe(true)
    }
  })

  withRealFixture(
    STRUCTUREDATA_FIXTURE_KEY,
    '基线声明的"无部件"性质在 structuredata-exported-envelope 上仍成立（无 `itemIndex` / 无 `hostItem` / 无 `cellPartsGrid`）',
    () => {
      const env = parseAsIs(ENVELOPE_FIXTURE)
      const d = decodeEnvelope(env)
      expect(d.ok).toBe(true)
      if (!d.ok) return
      expect(d.value.inner.cellPartsGrid, 'envelope: 基线前提是无部件').toBeUndefined()
      expect(d.value.inner.partLists, 'envelope: 基线前提是无部件').toBeUndefined()
      expect(
        (d.value.inner.blockPalette as Record<string, unknown>[]).some((e) => e.hostItem !== undefined),
        'envelope: 不得有 hostItem',
      ).toBe(false)
    },
  )

  it('**G-4 复算**：minimal-v2 的 sha256 与字节数必须与夹具登记逐位一致', async () => {
    // ## 这条断言替代了什么（G-4 收口）
    //
    // 登记 G-4 时的原文是：「`b2-item-index-baseline-no-parts.json` 的
    // sha256 **未复算**（需旧解析链）」——当时的适配器层没有那条"解析 → `serialize()`"
    // 的管线，故只能把缺口写成机器可读的**诚实登记**。
    //
    // 现在那条管线在生产里**已经存在**：`context/parserRegistry` 的
    // `RuntimeDocument.fromV2Plain` 仍是生产解析链的产物类型，且
    // `runtime/host/workbenchHost` 的注册顺序（V2Plain → Envelope → World →
    // StructureData）就是夹具 `howToRegenerate` 逐字要求的那个顺序。
    // ⇒ 复算不再需要任何新实现，故本断言把"未复算"翻成"已复算"。
    //
    // ## 为什么这条判据重要（不是形式主义）
    //
    // 基线夹具的用途是「无部件文档的导出字节**必须不变**」（部件契约 §1 的向后兼容口径）。
    // 指纹一旦漂移，就说明有人改动了"解析 → `serialize()`"这条链的字节输出 ——
    // 而那正是 B-2 立这条基线的理由。**不真的复算**等于让这条硬约束失去守卫。
    //
    // ## 与 `howToRegenerate` 的关系
    //
    // 断言里仍然读 `howToRegenerate`/`generatedFrom`，但用途变了：
    // 前者用来**证明复算方法与本实现同源**（都指向 `serialize()`），
    // 后者用来**证明基线的历史来源**（B-2 改动前）。两者不再是"不复算的依据"。
    const baseline = parseAsIs(BASELINE_FIXTURE) as {
      entries: Record<string, { sha256: string; bytes: number }>
      howToRegenerate: string
      generatedFrom: string
    }
    expect(typeof baseline.howToRegenerate, '复算方法必须仍指向生产解析链的 serialize()').toBe('string')
    expect(String(baseline.howToRegenerate), '本断言的复算实现必须与夹具自述同源').toContain('serialize()')
    expect(String(baseline.generatedFrom), '基线来自 B-2 改动前的实现').toContain('B-2')

    const entry = baseline.entries['minimal-v2']!
    const parsed = await productionParsers().detectAndParse(parseAsIs('minimal-v2.json'))
    expect(parsed.document, 'minimal-v2: 生产解析链必须能解析该夹具').not.toBeNull()
    const json = JSON.stringify(parsed.document!.serialize())
    const sha256 = createHash('sha256').update(json, 'utf8').digest('hex')
    const bytes = Buffer.byteLength(json, 'utf8')
    expect(bytes, 'minimal-v2: UTF-8 字节数必须与基线一致（部件契约 §1 无部件字节不变）').toBe(entry.bytes)
    expect(sha256, 'minimal-v2: sha256 必须与基线一致（解析→serialize() 的字节输出漂移了）').toBe(entry.sha256)
  })

  withRealFixture(
    STRUCTUREDATA_FIXTURE_KEY,
    '**G-4 复算**：structuredata-exported-envelope 的 sha256 与字节数必须与夹具登记逐位一致',
    async () => {
      const baseline = parseAsIs(BASELINE_FIXTURE) as {
        entries: Record<string, { sha256: string; bytes: number }>
      }
      const entry = baseline.entries['structuredata-exported-envelope']!
      const parsed = await productionParsers().detectAndParse(parseAsIs(ENVELOPE_FIXTURE))
      expect(parsed.document, 'structuredata-exported-envelope: 生产解析链必须能解析该夹具').not.toBeNull()
      const json = JSON.stringify(parsed.document!.serialize())
      const sha256 = createHash('sha256').update(json, 'utf8').digest('hex')
      const bytes = Buffer.byteLength(json, 'utf8')
      expect(bytes, 'structuredata-exported-envelope: UTF-8 字节数必须与基线一致（部件契约 §1 无部件字节不变）').toBe(entry.bytes)
      expect(sha256, 'structuredata-exported-envelope: sha256 必须与基线一致（解析→serialize() 的字节输出漂移了）').toBe(entry.sha256)
    },
  )

  it('**负对照**：基线指纹确实在守卫字节（改动一个字段即判红）', () => {
    // 证明上一条不是恒真：把 `serialize()` 的产物动一个字段，指纹必然变。
    // 用真实夹具走同一条链，再对一个已知字段做最小篡改。
    const baseline = parseAsIs(BASELINE_FIXTURE) as { entries: Record<string, { sha256: string }> }
    const entry = baseline.entries['minimal-v2']!

    const plain = parseAsIs('minimal-v2.json')
    const parsed = RuntimeDocument.fromV2Plain(plain)
    expect(parsed, '前提：该夹具可被 V2Plain 反序列化').not.toBeNull()
    const good = JSON.stringify(parsed!.serialize())
    const goodSha = createHash('sha256').update(good, 'utf8').digest('hex')
    expect(goodSha, '前提：未篡改时指纹命中基线').toBe(entry.sha256)

    // 篡改：改一个**确实参与 `serialize()`** 的字段。
    //
    // ## 为什么不用根级 `label`（本探针实测抓出的事实，值得记下来）
    //
    // 首版负对照篡改 `plain.label`，结果指纹**没变** —— 因为 `label` 正是
    // 实测登记的"有损中间层"：`RuntimeDocument.fromV2Plain` 的 `known`
    // 集合列了 `label`/`author`/`description`/`gtnhVersion`/… 七个根级键，
    // 却**从不读它们**，同时又把它们排除在 `_extra` 之外 ⇒ 它们既不在 `meta`、
    // 也不在 `_extra`、更不在 `serialize()` 里。故"改 label ⇒ 指纹不变"是**正确行为**，
    // 不是守卫失效。
    //
    // 用它当负对照会得出错误结论（"指纹没在守卫字节"），故改用帧时长 ——
    // 它是 `serialize()` 真实写出的字段（`frames[].durationMs`）。
    const frames = plain.frames as Record<string, unknown>[]
    const tamperedPlain = {
      ...plain,
      frames: frames.map((f, i) => (i === 0 ? { ...f, durationMs: 12345 } : f)),
    }
    const tampered = RuntimeDocument.fromV2Plain(tamperedPlain)
    expect(tampered, '前提：篡改后仍可解析').not.toBeNull()
    const tamperedSha = createHash('sha256').update(JSON.stringify(tampered!.serialize()), 'utf8').digest('hex')
    expect(tamperedSha, '篡改一个参与序列化的字段 ⇒ 指纹必须变（否则这条守卫是恒真的）').not.toBe(entry.sha256)
  })

  it('**实测登记**：根级 `label` 不参与 `serialize()`（有损中间层；本断言的守卫面据此收窄）', () => {
    // 这条把上一条负对照的实验事实变成**可执行的登记**：若哪天 `fromV2Plain`
    // 开始读 `label`（即把有损中间层补全），本断言会判红，逼同批更新上面那条
    // 负对照的篡改字段选择（`label` 届时**可以**用作负对照）。
    const plain = parseAsIs('minimal-v2.json')
    const base = RuntimeDocument.fromV2Plain(plain)
    expect(base, '前提：该夹具可被 V2Plain 反序列化').not.toBeNull()
    const tampered = RuntimeDocument.fromV2Plain({ ...plain, label: 'DIFFERENT-LABEL' })
    expect(tampered, '前提：篡改后仍可解析').not.toBeNull()
    const sha = (d: RuntimeDocument): string =>
      createHash('sha256').update(JSON.stringify(d.serialize()), 'utf8').digest('hex')
    expect(
      sha(tampered!),
      '根级 `label` 目前**不**进 `serialize()`（P10b 实测的有损中间层）。' +
        '若本断言判红，说明中间层已补全 ⇒ 请同步更新上一条负对照的篡改字段说明。',
    ).toBe(sha(base!))
  })
})
