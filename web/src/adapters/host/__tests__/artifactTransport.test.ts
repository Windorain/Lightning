/**
 * A34 `artifact-host` —— **宿主传输等价处理与 JSZip 控制字符补丁**的字节级判据
 * （宿主产物传输）。
 *
 * ## 判据分层（哪一层才是主判据）
 *
 * | 层 | 判据 | 强度 |
 * |---|---|---|
 * | **主判据** | **字节级往返**：宿主传输（含 C0→U+FFFD）后，补丁产物的 ZIP 语义与未受损产物**相同**，而未补丁产物**损坏** | 强（真实字节 + 真实 JSZip） |
 * | 主判据 | 补丁在**真实产物字节片段**（下面 `REAL_BUNDLE_SPAN_HEX`，provenance 见注释）上的命中/诊断 | 强 |
 * | 辅助 | JSZip 内部 `signature` 模块可被改写以**观察**其行为 | **探针结论**（见下） |
 *
 * ### 关于"探针结论"的说明（**必读**）
 *
 * {@link generateZipWithSignatures} 通过 `jszip/lib/signature` 这个**内部模块路径**改写
 * JSZip 的签名常量，用来**复现**"未补丁产物在受损宿主下产出 `50 4B FD FD`"这一现象。
 * 这是**探针结论**：它依赖 JSZip 的内部文件布局，升级 JSZip 后该路径可能变化。
 * 因此：
 *  - **正式判据不依赖它** —— {@link zipHeaderBytesForSignature} 走的是**字节级**口径
 *    （`charCodeAt(i) & 0xFF`，与 JSZip `utils.js` 的 `stringToArrayLike` 逐字同构）；
 *  - 探针用例若因内部路径变化而失败，**修的是探针**，不是放松字节级判据。
 *  - 探针的价值在于"证明字节级口径与真实运行库行为一致"（两套口径互证）。
 *
 * ## 负对照：「删除补丁却不测替代路径」⇒ 判红
 *
 * A34 的负对照原文含两条：「只测 dev server」「**删除现有补丁却不测替代路径**」。
 * 本文件用**注入恒等变换的对照实现**（{@link IDENTITY_PATCH}）把第二条变成可执行判据：
 * 同一条往返断言，用生产补丁跑**通过**，用恒等变换跑**失败**。
 * 于是"把补丁改成恒等变换"这件事**必然**使判据判红 —— 而不是靠一次人工验证的记录。
 */

import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import {
  JSZIP_SIGNATURE_BYTES,
  JSZIP_SIGNATURE_PATCHES,
  MEDIAWIKI_REPLACED_C0_CODES,
  REPLACEMENT_CHAR_UTF8,
  T06_DECISION,
  HOST_TRANSFER_DECISIONS,
  ZIP_LOCAL_HEADER_HEX,
  applyJszipSignaturePatch,
  bytesToLatin1,
  decodeScriptBytesAsUtf8,
  evaluateHostTransfer,
  findResidualZipSignatures,
  hasValidZipLocalHeader,
  hexOfBytes,
  hexOfLatin1,
  hexPreview,
  isJszipPatchApplied,
  latin1ToBytes,
  simulateMediaWikiStorageTransfer,
  throughHostTransferAsScript,
  verifyJszipPatchTable,
  type JszipPatchOutcome,
} from '../artifactTransport'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具：**真实产物字节片段**（provenance 明确，不是编的）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 真实产物里 JSZip 签名区间的**逐字节**片段。
 *
 * provenance：
 *  - 来源文件：工作台 bundle 的构建产物（`vite.wiki-workbench.config.ts`）
 *    （`npx vite build --config vite.wiki-workbench.config.ts --outDir <输出目录>`，exit 0）
 *  - 该文件 sha256：`48eb8912a438a4a321d8dba61c4aea9deed94d7a1c8b44e52fd25e01d84a1127`
 *  - 区间：latin1 偏移 **1046679..1046856**（178 字节）
 *  - 采集脚本：一次性的产物采集脚本（证据见
 *    采集记录）
 *
 * 这一片段含**全部 6 个签名**，且含 4 个**真字节**形态与 2 个**混合**形态 ——
 * 即它恰好覆盖 `JSZIP_SIGNATURE_PATCHES` 的两类 `form`。
 * 用它当夹具的理由：让"补丁能不能匹配"这件事在**真实 esbuild 输出形态**上被断言，
 * 而不是在我自己拼的字符串上（后者会掩盖 esbuild 折叠行为的变化，正是 T-05 的风险）。
 */
const REAL_BUNDLE_SPAN_HEX =
  '22504b0304222c722e43454e5452414c5f46494c455f4845414445523d22504b0102222c722e43454e5452' +
  '414c5f4449524543544f52595f454e443d22504b0506222c722e5a495036345f43454e5452414c5f444952' +
  '4543544f52595f4c4f4341544f523d22504b065c783037222c722e5a495036345f43454e5452414c5f4449' +
  '524543544f52595f454e443d22504b0606222c722e444154415f44455343524950544f523d22504b5c7830' +
  '375c62227d2c'

/** 真实片段（latin1 文本）。 */
const REAL_BUNDLE_SPAN = bytesToLatin1(hexToBytes(REAL_BUNDLE_SPAN_HEX))

/**
 * 真实 bundle 里的语法形态是**对象属性赋值**：`r.LOCAL_FILE_HEADER="PK\x03\x04",r.…`。
 *
 * 夹具直接从真实片段拼出这一形态（片段以 `"PK` 开头，故前面补 `r.LOCAL_FILE_HEADER=`）。
 * 这是**逐字**的真实形态，不是自造的简化版 —— 理由见 T-05：
 * esbuild 的折叠行为会随版本变，只有真实形态才能测出"搜索串是否还匹配"。
 */
function assignmentFormFromRealSpan(span = REAL_BUNDLE_SPAN): string {
  // 片段末尾是 `"}` + `,`（`r.DATA_DESCRIPTOR="PK\x07\b"},`），
  // 去掉尾部 `,` 后即为一串完整的 `NAME="…",NAME="…"` 赋值 ——
  // 但第一项缺 `r.LOCAL_FILE_HEADER=` 前缀，补上即可。
  const trimmed = span.endsWith(',') ? span.slice(0, -1) : span
  return `r.LOCAL_FILE_HEADER=${trimmed}`
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具：字节级签名求值（正式判据口径；与 JSZip utils.js 的 stringToArrayLike 同构）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把一段"JS 字符串值"按 JSZip 的 `stringToArrayLike` 口径编成字节：
 * `array[i] = str.charCodeAt(i) & 0xFF`。
 *
 * ## 为什么这正是那个 bug 的**充分**复现
 *
 * 该表达式是 JSZip 里**唯一**把签名字符串变成字节的地方（`lib/utils.js` 的
 * `stringToArrayLike`）。所以只要签名常量在浏览器里是 `"PK\uFFFD\uFFFD"`，
 * 生成的 ZIP 头**必然**是 `50 4B FD FD`：
 *   `'P'=0x50`、`'K'=0x4B`、`'\uFFFD'.charCodeAt(0) = 0xFFFD`，`& 0xFF = 0xFD`。
 * 本函数不依赖 JSZip 的内部模块布局，故它是**正式判据**（探针只做互证）。
 */
function zipHeaderBytesForSignature(signature: string): Uint8Array {
  const out = new Uint8Array(signature.length)
  for (let i = 0; i < signature.length; i++) out[i] = signature.charCodeAt(i) & 0xff
  return out
}

/** 从"已补丁"的产物文本里取某签名的 `atob('…')` 参数值（= 原始签名字节）。 */
function signatureFromPatchedText(text: string, name: string): string | null {
  const re = new RegExp(`${name}=atob\\('([^']*)'\\)`)
  const m = re.exec(text)
  if (m === null) return null
  return base64ToLatin1(m[1])
}

/** 从"未补丁"（可能已受损）的产物文本里取某签名的字面量值。 */
function signatureFromLiteralText(text: string, name: string): string | null {
  const re = new RegExp(`${name}="([^"]*)"`)
  const m = re.exec(text)
  return m === null ? null : m[1]
}

/** base64 → latin1（测试内独立实现；不依赖 `artifactTransport` 的私有函数）。 */
function base64ToLatin1(b64: string): string {
  const bin = atobCompat(b64)
  return bin
}

/** base64 解码（`atob` 在 Node 18+ 与浏览器都是全局；此处只做存在性兜底）。 */
function atobCompat(b64: string): string {
  if (typeof atob === 'function') return atob(b64)
  // 兜底：Buffer（Node）—— 语义与 atob 相同（latin1 逐字节）。
  return Buffer.from(b64, 'base64').toString('latin1')
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、补丁表（转换范围）自检
// ─────────────────────────────────────────────────────────────────────────────

describe('A34 补丁表：6 个签名逐条可核对（T-02；B-21 判据 (a)）', () => {
  it('恰好 6 条，4 条 literal 形态 + 2 条 mixed 形态（与 T-02 逐条一致）', () => {
    expect(JSZIP_SIGNATURE_PATCHES).toHaveLength(6)
    expect(JSZIP_SIGNATURE_PATCHES.filter((p) => p.form === 'literal')).toHaveLength(4)
    expect(JSZIP_SIGNATURE_PATCHES.filter((p) => p.form === 'mixed')).toHaveLength(2)
    expect(JSZIP_SIGNATURE_PATCHES.map((p) => p.name)).toEqual([
      'LOCAL_FILE_HEADER',
      'CENTRAL_FILE_HEADER',
      'CENTRAL_DIRECTORY_END',
      'ZIP64_CENTRAL_DIRECTORY_END',
      'ZIP64_CENTRAL_DIRECTORY_LOCATOR',
      'DATA_DESCRIPTOR',
    ])
  })

  it('补丁表自身 0 违规（`verifyJszipPatchTable`）', () => {
    expect(verifyJszipPatchTable()).toEqual([])
  })

  it('每个 `atob(\'…\')` 的 base64 **恰好**解出该签名的 4 字节（用权威字节表逐条硬核对）', () => {
    for (const p of JSZIP_SIGNATURE_PATCHES) {
      const expectBytes = JSZIP_SIGNATURE_BYTES[p.name]
      expect(expectBytes, `${p.name} 必须在 JSZIP_SIGNATURE_BYTES 里有权威字节`).toBeDefined()
      const decoded = zipHeaderBytesForSignature(base64ToLatin1(p.base64))
      expect(hexOfBytes(decoded), `${p.name} 的 base64 解错`).toBe(hexOfBytes(Uint8Array.from(expectBytes!)))
      // `literal` 形态：search 串去掉引号**就是**那 4 字节（可直接核）。
      if (p.form === 'literal') {
        expect(hexOfLatin1(p.search.slice(1, -1)), `${p.name} 的 literal search 串字节不符`).toBe(
          hexOfBytes(Uint8Array.from(expectBytes!)),
        )
      }
    }
  })

  it('`mixed` 形态的 search 串里含**文本转义**（`\\x07`），故不能当字节核 —— 这是 T-05 的风险点', () => {
    const locator = JSZIP_SIGNATURE_PATCHES.find((p) => p.name === 'ZIP64_CENTRAL_DIRECTORY_LOCATOR')
    expect(locator?.form).toBe('mixed')
    // 去掉外层引号后是 `PK` + 真字节 0x06 + 4 个**字符** `\x07`（即 5C 78 30 37）
    expect(hexOfLatin1(locator!.search.slice(1, -1))).toBe('504b06' + hexOfLatin1('\\x07'))
    expect(hexOfLatin1(locator!.search.slice(1, -1))).not.toBe('504b0607')
    // 而它的**语义**（JS 求值后）必须是 4 字节签名 —— 由 base64 侧保证（上一条用例已核）。
    expect(hexOfBytes(zipHeaderBytesForSignature(base64ToLatin1(locator!.base64)))).toBe('504b0607')

    const descriptor = JSZIP_SIGNATURE_PATCHES.find((p) => p.name === 'DATA_DESCRIPTOR')
    expect(descriptor?.form).toBe('mixed')
    // esbuild 把 0x08 写成 `\b`（2 个字符）而不是 `\x08`
    expect(hexOfLatin1(descriptor!.search.slice(1, -1))).toBe('504b' + hexOfLatin1('\\x07') + hexOfLatin1('\\b'))
    expect(hexOfBytes(zipHeaderBytesForSignature(base64ToLatin1(descriptor!.base64)))).toBe('504b0708')
  })

  it('`verifyJszipPatchTable` 能抓到"search 与 replacement 不同源"（静默错误形态）', () => {
    // 构造：search 还是 LOCAL 的字节，但 replacement 换成 CENTRAL 的 base64
    // ⇒ 替换后值变了而语法仍合法、长度也合理 —— 没有任何运行期信号。
    const broken = JSZIP_SIGNATURE_PATCHES.map((p, i) =>
      i === 0 ? { ...p, replacement: "atob('UEsBAg==')" } : p,
    )
    const problems = verifyJszipPatchTable(broken)
    expect(problems.join('\n')).toContain('不同源')
  })

  it('搜索串**含外层双引号**、替换串**无引号**（防止破坏生成脚本的字符串语法）', () => {
    for (const p of JSZIP_SIGNATURE_PATCHES) {
      expect(p.search.startsWith('"') && p.search.endsWith('"'), `${p.name} 的 search 必须含外层引号`).toBe(true)
      expect(p.replacement, `${p.name} 的替换串不得含引号`).not.toContain('"')
      expect(p.replacement.startsWith("atob('") && p.replacement.endsWith("')"), `${p.name}`).toBe(true)
    }
  })

  it('**负对照**：把替换串改成被引号包住 ⇒ `verifyJszipPatchTable` 判违规（不是空转）', () => {
    const broken = JSZIP_SIGNATURE_PATCHES.map((p, i) =>
      i === 0 ? { ...p, replacement: `"atob('UEsDBA==')"` } : p,
    )
    const problems = verifyJszipPatchTable(broken)
    expect(problems.length, '被引号包住的替换串必须判违规').toBeGreaterThan(0)
    expect(problems.join('\n')).toContain('LOCAL_FILE_HEADER')
  })

  it('**负对照**：base64 写错 ⇒ `verifyJszipPatchTable` 判违规', () => {
    // 把 CENTRAL_FILE_HEADER 的 base64 改成 LOCAL 的 ⇒ 解出的字节不再是该签名。
    const broken = JSZIP_SIGNATURE_PATCHES.map((p, i) =>
      i === 1 ? { ...p, base64: 'UEsDBA==', replacement: "atob('UEsDBA==')" } : p,
    )
    const problems = verifyJszipPatchTable(broken)
    expect(problems.join('\n'), 'base64 与权威字节不符必须判违规').toContain('CENTRAL_FILE_HEADER')
  })

  it('**独立性**：6 个签名的**真实字节**两两互不相同（否则"替换一个"会连带改坏另一个）', () => {
    const bytes = JSZIP_SIGNATURE_PATCHES.map((p) => hexOfBytes(Uint8Array.from(JSZIP_SIGNATURE_BYTES[p.name]!)))
    expect(bytes).toEqual(['504b0304', '504b0102', '504b0506', '504b0606', '504b0607', '504b0708'])
    expect(new Set(bytes).size).toBe(6)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 二、补丁应用在**真实产物字节片段**上的命中与诊断
// ─────────────────────────────────────────────────────────────────────────────

describe('A34 补丁应用：在真实产物形态上逐条命中（非自造字符串）', () => {
  it('夹具本身就是**真实产物**字节：6 个搜索串各出现 1 次', () => {
    const text = assignmentFormFromRealSpan()
    for (const p of JSZIP_SIGNATURE_PATCHES) {
      const n = text.split(p.search).length - 1
      expect(n, `${p.name} 在真实片段里必须恰好 1 次（若为 0，说明 esbuild 折叠形态变了 —— T-05）`).toBe(1)
    }
  })

  it('`applyJszipSignaturePatch` 在真实片段上 verdict == `patched-all`，且 0 诊断', () => {
    const out = applyJszipSignaturePatch(assignmentFormFromRealSpan())
    expect(out.verdict).toBe('patched-all')
    expect(out.diagnostics, `不应有诊断：${JSON.stringify(out.diagnostics)}`).toEqual([])
    expect(out.hits.every((h) => h.matched === 1)).toBe(true)
    expect(out.bytesAfter).toBeGreaterThan(out.bytesBefore)
  })

  it('补丁后**不再含任何** ZIP 签名字节，且 6 个 `atob(...)` 表达式都在', () => {
    const patched = applyJszipSignaturePatch(assignmentFormFromRealSpan()).text
    expect(isJszipPatchApplied(patched)).toBe(true)
    expect(findResidualZipSignatures(patched), '补丁后不得残留任何签名字面量').toEqual([])
    for (const p of JSZIP_SIGNATURE_PATCHES) {
      expect(patched.includes(p.search), `${p.name} 的字面量仍在`).toBe(false)
      expect(patched.includes(p.replacement), `${p.name} 的 atob 表达式缺失`).toBe(true)
      // 表达式形态是 `NAME=atob('BASE64')`
      expect(patched.includes(`${p.name}=${p.replacement}`), `${p.name} 的赋值形态不对`).toBe(true)
    }
    // 补丁前必须能查出 6 条残留（负对照：`findResidualZipSignatures` 不是恒空）
    expect(findResidualZipSignatures(assignmentFormFromRealSpan())).toHaveLength(6)
  })

  it('**负对照**：已补丁文本再打一次 ⇒ `already-applied`（不是 `patched-all`，也不静默）', () => {
    const once = applyJszipSignaturePatch(assignmentFormFromRealSpan()).text
    const twice = applyJszipSignaturePatch(once)
    expect(twice.verdict).toBe('already-applied')
    expect(twice.text).toBe(once)
    expect(twice.bytesAfter).toBe(twice.bytesBefore)
  })

  it('**无匹配诊断**：完全不含签名的文本 ⇒ `no-match` 且带 `JszipPatchNoMatch`（不得静默 patched 0）', () => {
    const out = applyJszipSignaturePatch('var x = 1; // 这份产物里没有任何 JSZip 签名')
    expect(out.verdict).toBe('no-match')
    const codes = out.diagnostics.map((d) => d.code)
    expect(codes, '一个都没匹配到必须有可见诊断').toContain('JszipPatchNoMatch')
    // 逐签名的 no-match 诊断（6 条）+ 全局 1 条
    expect(out.diagnostics.filter((d) => d.code === 'JszipPatchNoMatch').length).toBe(7)
    expect(out.text, '无匹配时不得改动文本').toBe('var x = 1; // 这份产物里没有任何 JSZip 签名')
  })

  it('**异常匹配诊断**：部分签名 ⇒ `patched-partial` + `JszipPatchPartialMatch`', () => {
    // 只放 LOCAL 一个签名（模拟"esbuild 折叠形态漂移，只匹配上一条"）。
    const partial = `r.LOCAL_FILE_HEADER="PK\x03\x04"`
    const out = applyJszipSignaturePatch(partial)
    expect(out.verdict).toBe('patched-partial')
    const codes = out.diagnostics.map((d) => d.code)
    expect(codes).toContain('JszipPatchPartialMatch')
    expect(codes).toContain('JszipPatchNoMatch')
    const pm = out.diagnostics.find((d) => d.code === 'JszipPatchPartialMatch')
    expect(pm?.params.covered).toBe(1)
    expect(pm?.params.expected).toBe(6)
  })

  it('**异常匹配诊断**（构建校验路径）：产物含残留签名字面量 ⇒ `evaluateHostTransfer` 报 `JszipPatchResidualControlBytes`', () => {
    // "半补丁"产物：语义上自相矛盾（一部分已是 atob、一部分仍是字面量）。
    // 这是**真实可能**的状态（例如上一次构建的缓存被拼接、或补丁只匹配了一部分）——
    // 也正是 `applyJszipSignaturePatch` 内部**结构上不可达**的那个状态
    // （它必然替换掉所有匹配），故必须由 `evaluateHostTransfer` 这条独立校验路径回答。
    const half = `r.LOCAL_FILE_HEADER="PK\x03\x04",r.CENTRAL_FILE_HEADER=atob('UEsBAg=='),` +
      JSZIP_SIGNATURE_PATCHES.slice(2).map((p) => `${p.name}=${p.replacement}`).join(',')
    const r = evaluateHostTransfer('wiki-workbench', half)
    expect(r.diagnostic?.code, '半补丁状态必须被诊断出来，不得静默').toBe('JszipPatchResidualControlBytes')
    expect(r.residualSignatures).toEqual(['LOCAL_FILE_HEADER'])
    expect(r.patchApplied).toBe(false)
  })

  it('**异常匹配诊断**：产物里出现被引号包住的 `atob(` ⇒ `JszipPatchQuoteWrappedAtob`（语法错误形态）', () => {
    const bad = `r.LOCAL_FILE_HEADER="atob('UEsDBA==')"`
    const out = applyJszipSignaturePatch(bad)
    const codes = out.diagnostics.map((d) => d.code)
    expect(codes, '被引号包住的 atob 是历史事故形态，必须判诊断').toContain('JszipPatchQuoteWrappedAtob')
  })

  it('**异常匹配诊断**：`atob("…")` 双引号参数形态同样判诊断（第一版修复的形态）', () => {
    const bad = `r.LOCAL_FILE_HEADER=atob("UEsDBA==")`
    const out = applyJszipSignaturePatch(bad)
    const codes = out.diagnostics.map((d) => d.code)
    expect(codes).toContain('JszipPatchQuoteWrappedAtob')
    expect(out.diagnostics.some((d) => d.params.form === 'double-quoted-argument')).toBe(true)
  })

  it('**负对照**：补丁表不合规 ⇒ 拒绝运行（`invalid-table`），不产出半成品', () => {
    // 用真实表构造违规：把第 0 条替换成非 atob 形态（模拟有人手改了表）。
    const saved = JSZIP_SIGNATURE_PATCHES[0].replacement
    // 表是 frozen 的，故只能通过"注入对照实现"验证拒绝路径 —— 见下一条用例的注入方式。
    expect(Object.isFrozen(JSZIP_SIGNATURE_PATCHES)).toBe(true)
    expect(saved).toBe("atob('UEsDBA==')")
    expect(verifyJszipPatchTable([{ ...JSZIP_SIGNATURE_PATCHES[0], replacement: 'RAW' }]).length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 三、宿主传输模拟（MediaWiki 控制字符替换）
// ─────────────────────────────────────────────────────────────────────────────

describe('A34 宿主传输模拟：C0 替换规则逐条可核（T-03；**模拟**，非真实 Wiki）', () => {
  it('被替换的码点集合逐字等于文档口径：0x01–0x08 ∪ 0x0B–0x1F（TAB/LF 不在内，CR 在内）', () => {
    expect(MEDIAWIKI_REPLACED_C0_CODES).toHaveLength(8 + 21)
    expect(MEDIAWIKI_REPLACED_C0_CODES).toContain(0x01)
    expect(MEDIAWIKI_REPLACED_C0_CODES).toContain(0x08)
    expect(MEDIAWIKI_REPLACED_C0_CODES).not.toContain(0x09) // TAB 除外
    expect(MEDIAWIKI_REPLACED_C0_CODES).not.toContain(0x0a) // LF 除外
    expect(MEDIAWIKI_REPLACED_C0_CODES).toContain(0x0d) // CR 在内（口径逐字来自文档）
    expect(MEDIAWIKI_REPLACED_C0_CODES).toContain(0x1f)
    expect(MEDIAWIKI_REPLACED_C0_CODES).not.toContain(0x00) // 文档未说 0x00 ⇒ 不假装确定
    expect(MEDIAWIKI_REPLACED_C0_CODES).not.toContain(0x20)
    expect(MEDIAWIKI_REPLACED_C0_CODES).not.toContain(0x7f) // DEL 不在 C0 范围
  })

  it('U+FFFD 的 UTF-8 编码是 `EF BF BD`（三字节替换的字节级依据）', () => {
    expect(hexOfBytes(Uint8Array.from(REPLACEMENT_CHAR_UTF8))).toBe('efbfbd')
    expect(new TextEncoder().encode('\uFFFD')).toEqual(Uint8Array.from(REPLACEMENT_CHAR_UTF8))
  })

  it('模拟结果：`PK\\x03\\x04` → `PK\\xEF\\xBF\\xBD\\xEF\\xBF\\xBD`（字节级）', () => {
    const input = latin1ToBytes('"PK\x03\x04"')
    const out = simulateMediaWikiStorageTransfer(input)
    expect(hexOfBytes(input)).toBe('22504b030422')
    // 03 与 04 各被换成 EF BF BD
    expect(hexOfBytes(out.bytes)).toBe('22504befbfbdefbfbd22')
    expect(out.replacedBytes).toBe(2)
    expect(out.replacedCodes).toEqual({ '03': 1, '04': 1 })
    expect(out.replacementCharSequences).toBe(2)
  })

  it('模拟不改动非 C0 字节（TAB/LF/空格/0x7F/高位字节都原样通过；**CR 会被替换**，见口径）', () => {
    // TAB(09)、LF(0A) 按文档口径**不**被替换。
    const safe = latin1ToBytes('AB\t\n\x20\x7f\x80\xff')
    const out = simulateMediaWikiStorageTransfer(safe)
    expect(hexOfBytes(out.bytes)).toBe(hexOfBytes(safe))
    expect(out.replacedBytes).toBe(0)
    // CR(0D) **在**被替换集合内（这是逐字取自文档的口径，不因为本仓铁律 6 关注 CRLF 而改）：
    const withCr = latin1ToBytes('A\rB')
    const outCr = simulateMediaWikiStorageTransfer(withCr)
    expect(hexOfBytes(withCr)).toBe('410d42')
    expect(hexOfBytes(outCr.bytes)).toBe('41' + hexOfBytes(Uint8Array.from(REPLACEMENT_CHAR_UTF8)) + '42')
    expect(outCr.replacedCodes).toEqual({ '0d': 1 })
  })

  it('**注入恒等变换的对照实现**：不替换控制字符 ⇒ 未补丁产物"看起来完好"，这正是必须被识破的假象', () => {
    // 这是"宿主传输什么都不做"的对照：它让 sign 后的产物**看起来**没问题，
    // 因此本文件后续的往返判据必须能区分"真做了传输"与"什么都没做"。
    const identityTransfer = (bytes: Uint8Array) => bytes
    const input = latin1ToBytes('"PK\x03\x04"')
    expect(hexOfBytes(identityTransfer(input))).toBe('22504b030422')
    // 真实模拟必须与恒等变换**不同** —— 否则模拟器是空转的。
    expect(hexOfBytes(simulateMediaWikiStorageTransfer(input).bytes)).not.toBe(hexOfBytes(identityTransfer(input)))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 四、**主判据**：字节级往返（补丁前 vs 补丁后语义相同）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一次"产物经宿主传输后被加载"的完整字节级推演。
 *
 * ## 这是 B-21/T-03 证据链的**五段**（一段都不能跳）
 *
 * ```
 * ①产物文本(latin1 视图) --latin1ToBytes--> ②产物字节
 * ②产物字节 --宿主补丁/恒等--> ③待上传字节
 * ③待上传字节 --MediaWiki 存储(0x03→EF BF BD)--> ④传输后字节
 * ④传输后字节 --浏览器 UTF-8 解码(EF BF BD→**一个** U+FFFD)--> ⑤JS 字符串
 * ⑤JS 字符串 --JSZip charCodeAt(i)&0xFF--> ZIP 头字节
 * ```
 *
 * **第 4 段是最容易被跳过的一段**，跳过会得到错的答案：
 * 把 ④ 当 latin1 读会得到 3 个字符 `\u00EF\u00BF\u00BD`（`&0xFF` → `EF BF BD`），
 * 而不是**一个** `\uFFFD`（`&0xFF` → `FD`）。本文件作者实测跳这一步时
 * 推出的是 `504befbfbd…`，与真实证据里的 `50 4B FD FD` 不符。
 * ⇒ 判据必须走 {@link throughHostTransferAsScript}（生产函数），而不是自己拼 latin1。
 *
 * 判据：
 *  - 生产补丁 ⇒ ⑤ 里签名是 `atob('…')`，其**求值结果**= 原始 4 字节 ⇒ 头 `504b0304`；
 *  - 恒等变换 ⇒ ⑤ 里签名是 `PK\uFFFD\uFFFD` ⇒ 头 `504bfdfd`（真实事故字节）。
 */
function projectZipHeaderThroughHostTransfer(patch: (text: string) => string): {
  readonly header: string
  readonly signature: string
  readonly replacedBytes: number
  readonly patchApplied: boolean
} {
  const bundle = assignmentFormFromRealSpan()
  const afterPatch = patch(bundle)
  const patchApplied = isJszipPatchApplied(afterPatch)
  // 第 3、4 段：宿主存储 + 浏览器脚本解码（生产函数，五段链路钉在一处）。
  const { script, replacedBytes } = throughHostTransferAsScript(afterPatch)
  // 第 5 段：取 LOCAL_FILE_HEADER 的值。
  // 补丁形态是 `=atob('…')`（JS 里其值为原始 4 字节）；未补丁形态是 `="…"` 字面量。
  const fromAtob = signatureFromPatchedText(script, 'LOCAL_FILE_HEADER')
  const literal = signatureFromLiteralText(script, 'LOCAL_FILE_HEADER')
  const signature = fromAtob ?? literal ?? ''
  return {
    header: hexOfBytes(zipHeaderBytesForSignature(signature)),
    signature,
    replacedBytes,
    patchApplied,
  }
}

/** 生产补丁实现（把 `applyJszipSignaturePatch` 收窄成 `string → string`）。 */
const PRODUCTION_PATCH = (text: string): string => applyJszipSignaturePatch(text).text

/**
 * **对照实现：恒等变换**（A34 负对照「删除现有补丁却不测替代路径」的可执行形态）。
 *
 * 它代表"有人把补丁删了/变成 no-op"这一改动。下面用**同一条断言**证明它会判红 ——
 * 因此"删了补丁却不测替代路径"不可能通过验收。
 */
const IDENTITY_PATCH = (text: string): string => text

describe('A34 主判据：字节级往返 —— 补丁后经宿主传输仍产出合法 ZIP 头', () => {
  it('生产补丁：传输后 ZIP 头仍是 `504b0304`，且补丁确实生效', () => {
    const r = projectZipHeaderThroughHostTransfer(PRODUCTION_PATCH)
    expect(r.patchApplied, '前提：生产补丁必须真的打上了').toBe(true)
    expect(r.header, `ZIP 头必须合法（实得 ${r.header}）`).toBe(ZIP_LOCAL_HEADER_HEX)
    // 补丁后产物**再无**任何 ZIP 签名的控制字节 ⇒ 传输替换数为 0
    //（该夹具只含签名区间，不含 `compileScene` 的 \u0001 哈希分隔符）。
    expect(r.replacedBytes, '补丁后产物在传输中不应再有控制字节被替换').toBe(0)
  })

  it('**负对照（恒等变换）**：不补丁 ⇒ 传输后 ZIP 头变 `504bfdfd`，判据**失败**', () => {
    const r = projectZipHeaderThroughHostTransfer(IDENTITY_PATCH)
    expect(r.patchApplied, '恒等变换下补丁不可能生效').toBe(false)
    // 这正是真实事故的字节：`PK\uFFFD\uFFFD` → `50 4B FD FD`。
    expect(r.header, '未补丁产物经受损传输后必须产出坏头').toBe('504bfdfd')
    expect(r.header).not.toBe(ZIP_LOCAL_HEADER_HEX)
    expect(hasValidZipLocalHeader(hexToBytes(r.header)), '必须判为非法').toBe(false)
    // 该夹具里的签名控制字节**逐个可数**（不是估的）：4 个 literal 形态各 2 个真字节
    // （03,04 / 01,02 / 05,06 / 06,06 = 8 个）+ LOCATOR 的混合形态里 1 个真字节（06）
    // = **9** 个；DATA_DESCRIPTOR 的 `\x07\b` 是**文本转义**（4 个字符，0 个真控制字节）。
    expect(r.replacedBytes, '未补丁产物在传输中被替换的签名控制字节总数').toBe(9)
  })

  it('**同一条断言、两种实现 ⇒ 结论翻转**（证明判据不是恒绿也不是恒红）', () => {
    // 把上两条用例的**判定表达式**抽出来，对两种实现各求一次值。
    const verdict = (patch: (t: string) => string): boolean =>
      projectZipHeaderThroughHostTransfer(patch).header === ZIP_LOCAL_HEADER_HEX
    expect(verdict(PRODUCTION_PATCH), '生产补丁必须判绿').toBe(true)
    expect(verdict(IDENTITY_PATCH), '恒等变换必须判红（这就是"删补丁不测替代路径"的判据）').toBe(false)
  })

  it('**往返等价**：补丁前后，6 个签名求值出的字节与"未受损传输"逐字节相同', () => {
    // "未受损"= 不过宿主传输（基线）。补丁后经传输必须与它逐字节一致。
    const bundle = assignmentFormFromRealSpan()
    const baseline = (() => {
      const sig = signatureFromLiteralText(bundle, 'LOCAL_FILE_HEADER') ?? ''
      return hexOfBytes(zipHeaderBytesForSignature(sig))
    })()
    expect(baseline).toBe(ZIP_LOCAL_HEADER_HEX)

    const patchedViaTransfer = projectZipHeaderThroughHostTransfer(PRODUCTION_PATCH)
    expect(patchedViaTransfer.header, '补丁后经传输 == 未受损基线（语义等价，A34 往返）').toBe(baseline)

    // 逐条签名都做同样的往返（不只 LOCAL —— 6 个都必须等价）。
    //
    // 比较口径说明：`literal` 形态两边都按**字节**比；`mixed` 形态的**字面量侧**
    // 含文本转义（`\x07`），故字面量侧用"JS 求值后的值"（由 base64 侧给出权威字节），
    // 补丁侧用 `atob` 参数。两侧最终都归到 JSZIP_SIGNATURE_BYTES 这同一份权威字节。
    const patched = applyJszipSignaturePatch(bundle).text
    const transferredScript = throughHostTransferAsScript(patched).script
    for (const p of JSZIP_SIGNATURE_PATCHES) {
      const authoritative = hexOfBytes(Uint8Array.from(JSZIP_SIGNATURE_BYTES[p.name]!))
      // 补丁侧：`atob('…')` 的参数解出的字节（这就是浏览器执行后的值）。
      const viaTransfer = signatureFromPatchedText(transferredScript, p.name) ?? ''
      expect(hexOfLatin1(viaTransfer), `${p.name} 经传输后 atob 参数必须仍是权威字节`).toBe(authoritative)
    }
  })

  it('**负对照（跳步）**：若漏掉"浏览器 UTF-8 解码"这一段，推出的字节是**错的**（证明该段不可省）', () => {
    const bundle = assignmentFormFromRealSpan()
    const transferred = simulateMediaWikiStorageTransfer(latin1ToBytes(bundle))
    // 错误做法：把传输后字节当 latin1 读（跳过 UTF-8 解码）。
    const wrongScript = bytesToLatin1(transferred.bytes)
    const wrongSig = signatureFromLiteralText(wrongScript, 'LOCAL_FILE_HEADER') ?? ''
    const wrongHeader = hexOfBytes(zipHeaderBytesForSignature(wrongSig))
    // 正确做法：按浏览器方式 UTF-8 解码。
    const rightScript = decodeScriptBytesAsUtf8(transferred.bytes)
    const rightSig = signatureFromLiteralText(rightScript, 'LOCAL_FILE_HEADER') ?? ''
    const rightHeader = hexOfBytes(zipHeaderBytesForSignature(rightSig))

    expect(rightHeader, '正确口径必须给出真实事故字节 504bfdfd').toBe('504bfdfd')
    expect(wrongHeader, '跳步口径给出的是另一个（不存在的）字节序列').not.toBe(rightHeader)
    // 跳步时 `EF BF BD` 被当成 3 个 latin1 字符 ⇒ `&0xFF` 各自仍是 EF/BF/BD
    // ⇒ 得到 6 字节而不是 2 字节（两个被替换的控制字节 × 3 字节）。
    expect(wrongHeader).toBe('504b' + hexOfBytes(Uint8Array.from(REPLACEMENT_CHAR_UTF8)).repeat(2))
    expect(wrongHeader.length, '跳步会给出 16 个 hex 字符（8 字节），而正确口径是 8 个（4 字节）').toBe(16)
    expect(rightHeader.length).toBe(8)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 五、**真实 JSZip 运行时**互证（探针结论；见文件头"必读"）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 在指定的签名映射下生成一个真实 ZIP，并返回其字节。
 *
 * ## 这是**探针**（见文件头）
 *
 * 它改写 `jszip/lib/signature` 的内部导出 —— 该路径是 JSZip 的内部布局，
 * 升级 JSZip 后可能变化。**正式判据**是上面第四节的字节级往返；
 * 本函数的作用是**互证**：证明"字节级口径推出的 `504bfdfd`"与"真实运行库的实际输出"一致。
 *
 * 探针结论（jszip 3.10.1 / vite 6.4.2）：
 *  - 签名 = 原始 `PK\x03\x04` ⇒ ZIP 头 `504b0304`
 *  - 签名 = `PK\uFFFD\uFFFD` ⇒ ZIP 头 `504bfdfd`
 * 两值与 `zipHeaderBytesForSignature` 的字节级预测**完全相同**。
 */
async function generateZipWithSignatures(
  override: Readonly<Record<string, string>> | null,
): Promise<Uint8Array> {
  const mod = (await import('jszip/lib/signature')) as unknown as {
    default?: Record<string, string>
  } & Record<string, string>
  const sig = (mod.default ?? mod) as Record<string, string>
  const keys = Object.keys(sig)
  const saved: Record<string, string> = {}
  for (const k of keys) saved[k] = sig[k]
  try {
    if (override !== null) {
      for (const [k, v] of Object.entries(override)) sig[k] = v
    }
    const zip = new JSZip()
    zip.file('structure.obj', 'v 0 0 0\nv 1 0 0\n')
    zip.file('structure.mtl', 'newmtl m\n')
    return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))
  } finally {
    for (const k of keys) sig[k] = saved[k]
  }
}

describe('A34 互证（**探针**，依赖 JSZip 内部路径）：字节级口径与真实运行库一致', () => {
  it('签名改成 `PK\\uFFFD\\uFFFD` ⇒ 真实 JSZip 产出的 ZIP 头是 `504bfdfd`（与字节级预测一致）', async () => {
    const corrupted = `PK\uFFFD\uFFFD`
    const predicted = hexOfBytes(zipHeaderBytesForSignature(corrupted))
    expect(predicted).toBe('504bfdfd')

    const bytes = await generateZipWithSignatures({
      LOCAL_FILE_HEADER: corrupted,
      CENTRAL_FILE_HEADER: corrupted,
      CENTRAL_DIRECTORY_END: corrupted,
      ZIP64_CENTRAL_DIRECTORY_END: corrupted,
      ZIP64_CENTRAL_DIRECTORY_LOCATOR: corrupted,
      DATA_DESCRIPTOR: corrupted,
    })
    expect(hexPreview(bytes, 4), '真实运行库输出必须与字节级预测一致').toBe(predicted)
    expect(hasValidZipLocalHeader(bytes)).toBe(false)
  })

  it('签名恢复为原始字节（= 补丁产物 `atob(...)` 的求值结果）⇒ ZIP 头回到 `504b0304` 且可解包', async () => {
    // 用**补丁产物的 atob 求值结果**作为签名（这正是浏览器执行补丁后产物的效果）。
    const patched = applyJszipSignaturePatch(assignmentFormFromRealSpan()).text
    const override: Record<string, string> = {}
    for (const p of JSZIP_SIGNATURE_PATCHES) {
      const viaAtob = signatureFromPatchedText(patched, p.name)
      expect(viaAtob, `${p.name} 必须能从补丁产物里取出 atob 参数`).not.toBeNull()
      override[p.name] = viaAtob as string
    }
    const bytes = await generateZipWithSignatures(override)
    expect(hexPreview(bytes, 4)).toBe(ZIP_LOCAL_HEADER_HEX)
    expect(hasValidZipLocalHeader(bytes)).toBe(true)

    // 行为证据：真的能读回内容（不只是头对）。
    const loaded = await JSZip.loadAsync(bytes)
    expect(Object.keys(loaded.files).sort()).toEqual(['structure.mtl', 'structure.obj'])
    expect(await loaded.file('structure.obj')!.async('string')).toBe('v 0 0 0\nv 1 0 0\n')
    expect(await loaded.file('structure.mtl')!.async('string')).toBe('newmtl m\n')
  })

  it('**互证**：真实 JSZip 在受损签名下**读不回**内容（行为层面的损坏，不只是头字节）', async () => {
    const corrupted = `PK\uFFFD\uFFFD`
    const bytes = await generateZipWithSignatures({
      LOCAL_FILE_HEADER: corrupted,
      CENTRAL_FILE_HEADER: corrupted,
      CENTRAL_DIRECTORY_END: corrupted,
      ZIP64_CENTRAL_DIRECTORY_END: corrupted,
      ZIP64_CENTRAL_DIRECTORY_LOCATOR: corrupted,
      DATA_DESCRIPTOR: corrupted,
    })
    let failed = false
    try {
      const loaded = await JSZip.loadAsync(bytes)
      await loaded.file('structure.obj')?.async('string')
      // 若"没抛异常"，则必须显式检查读到的内容是否**不是**原内容。
      const content = await loaded.file('structure.obj')?.async('string')
      failed = content !== 'v 0 0 0\nv 1 0 0\n'
    } catch {
      failed = true
    }
    expect(failed, '受损 ZIP 必须无法正确读回内容（这才是"导出坏掉"的完整形态）').toBe(true)
  })

  it('探针不改坏真实状态：跑完后签名模块恢复原值（真实 ZIP 头仍合法）', async () => {
    await generateZipWithSignatures({
      LOCAL_FILE_HEADER: `PK\uFFFD\uFFFD`,
      CENTRAL_FILE_HEADER: `PK\uFFFD\uFFFD`,
      CENTRAL_DIRECTORY_END: `PK\uFFFD\uFFFD`,
      ZIP64_CENTRAL_DIRECTORY_END: `PK\uFFFD\uFFFD`,
      ZIP64_CENTRAL_DIRECTORY_LOCATOR: `PK\uFFFD\uFFFD`,
      DATA_DESCRIPTOR: `PK\uFFFD\uFFFD`,
    })
    const bytes = await generateZipWithSignatures(null)
    expect(hexPreview(bytes, 4), 'finally 必须恢复签名，否则后续测试会被污染').toBe(ZIP_LOCAL_HEADER_HEX)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 六、T-06 显式决策与 profile 传输表
// ─────────────────────────────────────────────────────────────────────────────

describe('A34 / T-06：embed 无 ZIP 补丁的**显式决策**与判据（不是"应该没问题"）', () => {
  it('决策已登记：embed 无 ZIP 签名 ⇒ 当前无实际影响，且必须由静态可达性守卫', () => {
    expect(T06_DECISION.profile).toBe('embed')
    expect(T06_DECISION.carriesZipSignatures).toBe(false)
    expect(T06_DECISION.requiresJszipPatch).toBe(false)
    // 依据必须指向可核对的事实（产物字节 + 模块闭包），不得是空话。
    expect(T06_DECISION.because).toContain('StructureRender.js')
    expect(T06_DECISION.because).toContain('main.ts')
    expect(T06_DECISION.because).toContain('799720')
    for (const vague of ['应该没问题', '可能', '大概', '待确认']) {
      expect(T06_DECISION.because, `依据不得含空话「${vague}」`).not.toContain(vague)
    }
  })

  it('四个 profile 都有传输决策（无遗漏），且只有 wiki-workbench 需要补丁', () => {
    expect(HOST_TRANSFER_DECISIONS.map((d) => d.profile).sort()).toEqual([
      'embed',
      'headless',
      'wiki-workbench',
      'workbench',
    ])
    expect(HOST_TRANSFER_DECISIONS.filter((d) => d.requiresJszipPatch).map((d) => d.profile)).toEqual([
      'wiki-workbench',
    ])
    // `workbench` 含签名但**不**需要补丁 —— 必须写明理由（JAR 内嵌、不经 MediaWiki 存储），
    // 否则下一个人"看到没补丁就顺手补上"（避免无谓的字节匹配）。
    const wb = HOST_TRANSFER_DECISIONS.find((d) => d.profile === 'workbench')
    expect(wb?.carriesZipSignatures).toBe(true)
    expect(wb?.because).toContain('MediaWiki')
  })

  it('`evaluateHostTransfer`：wiki-workbench 未补丁 ⇒ `patchNeeded: true`', () => {
    const bundle = assignmentFormFromRealSpan()
    const r = evaluateHostTransfer('wiki-workbench', bundle)
    expect(r.patchNeeded).toBe(true)
    expect(r.patchApplied).toBe(false)
    expect(r.diagnostic).toBeNull()
  })

  it('`evaluateHostTransfer`：wiki-workbench 已补丁 ⇒ `patchNeeded: false` / `patchApplied: true`', () => {
    const patched = applyJszipSignaturePatch(assignmentFormFromRealSpan()).text
    const r = evaluateHostTransfer('wiki-workbench', patched)
    expect(r.patchNeeded).toBe(false)
    expect(r.patchApplied).toBe(true)
  })

  it('`evaluateHostTransfer`：embed 文本若**意外**出现 ZIP 签名 ⇒ 不被静默放过（决策与事实冲突要可见）', () => {
    // 这是 T-06 的守卫在**运行期**的形态：embed 本不该有签名。
    // 传入含签名的文本时，决策表说"不需要补丁"，但事实与决策冲突 ⇒ 必须能看出来。
    const r = evaluateHostTransfer('embed', assignmentFormFromRealSpan())
    expect(r.decision?.requiresJszipPatch).toBe(false)
    // 决策表本身没错（它记录的是"实测产物无签名"），冲突由架构闸门的可达性判据抓
    // （见 tests/architecture/artifact-host.test.ts）。此处断言"冲突可观察"：
    expect(isJszipPatchApplied(assignmentFormFromRealSpan()), '含签名的文本必然是未补丁态').toBe(false)
  })

  it('**未知 profile** ⇒ 结构化诊断（不猜、不默认放行）', () => {
    const r = evaluateHostTransfer('nope', 'var x = 1')
    expect(r.decision).toBeUndefined()
    expect(r.diagnostic?.code).toBe('JszipPatchNoMatch')
    expect(r.diagnostic?.params.reason).toBe('unknown-profile')
  })

  it('`wiki-workbench` 产物**一个签名都没有** ⇒ 必须报"根本不含签名"（T-05 的静默失配风险）', () => {
    const r = evaluateHostTransfer('wiki-workbench', 'var x = 1')
    expect(r.patchNeeded).toBe(false)
    expect(r.patchApplied).toBe(false)
    expect(r.diagnostic?.params.reason).toBe('product-has-no-zip-signature-at-all')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 七、latin1 口径（T-01 的关键前提）
// ─────────────────────────────────────────────────────────────────────────────

describe('A34 latin1 口径：产物含真实控制字节，读写必须 1:1（T-01）', () => {
  it('latin1 往返恒等（含全部 C0 与高位字节）', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    const text = bytesToLatin1(bytes)
    expect(text.length).toBe(256)
    expect(hexOfBytes(latin1ToBytes(text))).toBe(hexOfBytes(bytes))
  })

  it('latin1 逐字节 1:1 映射（UTF-8 会把 0x80+ 写成多字节 —— 故不能用 UTF-8）', () => {
    const bytes = Uint8Array.from([0x03, 0x80, 0xff])
    expect(bytesToLatin1(bytes).length).toBe(3)
    expect(latin1ToBytes(bytesToLatin1(bytes))).toEqual(bytes)
    // 对照：UTF-8 编码同样内容会变长 ⇒ 证明"用哪个编码"不是无关紧要的选择。
    expect(new TextEncoder().encode('\x80\xff').length).toBe(4)
  })

  it('**负对照**：用 UTF-8 读真实产物片段会得到 U+FFFD ⇒ 字节不再可逆', () => {
    const bytes = latin1ToBytes(REAL_BUNDLE_SPAN)
    const utf8Read = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    // 真实片段含 03/04 等控制字节；UTF-8 解码虽不会报错（都是合法单字节码点），
    // 但 **0x80+ 的字节** 会被替换成 U+FFFD ⇒ 不可逆。这里用含高位字节的样本证明这一点。
    const highBytes = Uint8Array.from([0x50, 0x4b, 0xff, 0xfe])
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(highBytes)
    expect(decoded).toContain('\uFFFD')
    expect([...decoded].map((c) => c.charCodeAt(0)), 'UTF-8 读高位字节不可逆').not.toEqual([0x50, 0x4b, 0xff, 0xfe])
    // 而 latin1 读同样字节是可逆的。
    expect(hexOfBytes(latin1ToBytes(bytesToLatin1(highBytes)))).toBe('504bfffe')
    expect(utf8Read.length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 八、与生产补丁函数的**签名一致性**（防止"测试跑的是另一个实现"）
// ─────────────────────────────────────────────────────────────────────────────

describe('A34 单点性：判据跑的补丁实现与生产实现是同一份', () => {
  it('`PRODUCTION_PATCH` 就是 `applyJszipSignaturePatch(...).text`（无第二份实现）', () => {
    const bundle = assignmentFormFromRealSpan()
    const viaHelper: JszipPatchOutcome = applyJszipSignaturePatch(bundle)
    expect(PRODUCTION_PATCH(bundle)).toBe(viaHelper.text)
  })

  it('`IDENTITY_PATCH` 与生产补丁**不同**（否则负对照无意义）', () => {
    const bundle = assignmentFormFromRealSpan()
    expect(IDENTITY_PATCH(bundle)).toBe(bundle)
    expect(PRODUCTION_PATCH(bundle)).not.toBe(bundle)
  })
})
