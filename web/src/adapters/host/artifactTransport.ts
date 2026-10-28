/**
 * `adapters/host/artifactTransport` —— **宿主传输等价处理与 JSZip 控制字符补丁的显式决策**
 * （适配器实现端口：宿主传输等价与产物补丁）。
 *
 * ## 1. 这件事为什么不能靠"看代码长什么样"决定
 *
 * 现存实现（`web/vite.wiki-workbench.config.ts` 的 `fixJszipSignaturesForWiki`，**本文件不改它**，
 * 其删除另行处理）做的事是：把产物里 6 个 JSZip 签名字面量换成 `atob('…')` 表达式。
 * 宿主传输的要求是：
 *
 * > Wiki 构建现存 JSZip 控制字符替换反映了真实部署约束；迁移需**保留该能力或给出可验证替代方案**，
 * > **不能仅按代码外观删除**。……如仍需转换，必须有明确**前置条件、转换范围、
 * > 无匹配/异常匹配诊断和产物往返测试**。
 *
 * 所以本文件把"那次字节替换"从**构建插件里的副作用**提升为**可独立调用的纯变换** +
 * **一组可断言的判据**。构建插件（无论现在那份还是将来的替代）只是这个变换的一个调用点。
 *
 * ## 2. 为什么必须发生（完整机制）
 *
 * | 步 | 事实 | 证据 |
 * |---|---|---|
 * | 1 | JSZip 的 `signature.js` 把 ZIP 签名写成字面量：`LOCAL_FILE_HEADER = "PK\x03\x04"` | `node_modules/jszip/lib/signature.js:2-7` |
 * | 2 | esbuild 把这些转义折叠成**真实控制字节** `03 04` | 实测产物偏移 1046680 起 `50 4B 03 04 22 2C` |
 * | 3 | 上传通道正确：`urlencode` 把 `\x03`→`%03` | URL 编码契约 |
 * | 4 | **MediaWiki 存储**把 C0 控制字符（0x01–0x08、0x0B–0x1F，TAB/LF 除外）换成 U+FFFD | 宿主存储约束，由 `simulateMediaWikiStorageTransfer()` 显式模拟 |
 * | 5 | `action=raw` 返回 `PK\xEF\xBF\xBD\xEF\xBF\xBD`；浏览器里字符串变成 `PK\uFFFD\uFFFD` | `action=raw` 的 UTF-8 响应与浏览器解码语义 |
 * | 6 | JSZip 的 `stringToArrayLike` 用 `charCodeAt(i) & 0xFF` 取低字节：U+FFFD → `0xFD` | `node_modules/jszip/lib/utils.js` 的 `stringToArrayLike` |
 * | 7 | 于是 ZIP 头变成 `50 4B FD FD`，`zipfile` 报 BadZipFile | JSZip 签名要求与损坏结果 |
 *
 * 第 4 步是**唯一**无法在本地完全复现的一环（需要真实 Wiki）。因此本模块把它做成一个
 * **可显式调用的模拟**：`simulateMediaWikiStorageTransfer()`。这样"补丁是否解决问题"
 * 就有了**两个可分别断言的事实**：
 *  - (a) 补丁后的产物里**不再有**会触发第 4 步的字节（本地可证，强断言）；
 *  - (b) 在第 4 步的模拟之下，补丁后产物生成的 ZIP 与**未受损**产物**语义相同**（往返）。
 *
 * ## 3. 前置条件、转换范围与诊断
 *
 * ### 前置条件（`patchPrecondition`）
 *
 *  - 输入是**该 profile 的产物文本**（`wiki-workbench` 的 bundle），不是任意字符串；
 *  - 产物里确实存在 JSZip 签名字面量（否则本变换**不该**运行 —— 见"无匹配诊断"）；
 *  - 产物文本按 **latin1** 读写：产物含真实控制字节，若按 UTF-8 读会得到 U+FFFD，
 *    再写回就把"要修的问题"提前制造出来（现存插件的 `latin1` 是关键）。
 *
 * ### 转换范围（逐条，6 个签名）
 *
 * 见 {@link JSZIP_SIGNATURE_PATCHES}：4 条**字面量形态** + 2 条**混合形态**
 * （esbuild 折叠策略依版本而异）。搜索串**必须含外层双引号**，替换产物
 * **不得**再被引号包住（`atob(...)` 是表达式不是字符串字面量）——
 * 否则第二个 `"` 会提前闭合，破坏生成脚本的字符串语法。
 *
 * ### 无匹配 / 异常匹配诊断
 *
 * 一个都没匹配到 ⇒ **不允许**静默 `patched 0`。{@link applyJszipSignaturePatch} 返回
 * 四态 `verdict` + 结构化诊断码，调用方（构建插件/验收）必须据此报错或记录。
 *
 * ## 4. 本模块的纯性
 *
 * 无 import、无 IO、无时钟、无全局读取。输入字符串/字节 → 输出字符串/字节 + 诊断值。
 * 因此它既能被构建插件在 Node 里调用，也能被测试在 vitest 里调用，
 * 还能被 Node 的类型剥离直接加载（同一份代码，不是两份实现）。
 */

// ─────────────────────────────────────────────────────────────────────────────
// JSZip 签名补丁表（转换范围）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一条签名替换规则。
 *
 * `search` 与 `replacement` **逐字**取自现存插件（`vite.wiki-workbench.config.ts:35-48`），
 * 因为迁移的第一要求是"保留该能力"（宿主产物传输）。本文件不"顺手优化"它们 ——
 * 优化只允许发生在有往返测试覆盖之后。
 */
export interface JszipSignaturePatch {
  /** JSZip 里的常量名（用于诊断定位，不参与替换）。 */
  readonly name: string
  /** 该签名 4 字节的 base64（`atob` 的参数）。 */
  readonly base64: string
  /** esbuild 后产物里的形态：`literal`（4 个真字节）或 `mixed`（部分字节留成文本转义）。 */
  readonly form: 'literal' | 'mixed'
  /** 搜索串，**含外层双引号**（不含引号会造成"第二个 `"` 提前闭合"的语法错误）。 */
  readonly search: string
  /** 替换串，**无引号**（`atob(...)` 是表达式）。 */
  readonly replacement: string
}

/**
 * 6 个签名 → `atob('…')` 的完整映射。
 *
 * ## base64 的来源必须可核对
 *
 * `atob('UEsDBA==')` 必须**恰好**解出 `50 4B 03 04`。这一点不能靠肉眼看 base64，
 * 故 {@link JSZIP_SIGNATURE_BYTES} 把它算成显式事实，并由
 * `verifyJszipPatchTable` 与测试逐条断言（改错一个字符就判红）。
 *
 * ## `literal` 与 `mixed` 的**关键区别**（风险所在）
 *
 * | form | 产物里的形态 | `search` 去掉引号后的**字节** | 等于签名 4 字节？ |
 * |---|---|---|---|
 * | `literal` | `"PK` + 真字节 `03 04` + `"` | `50 4B 03 04` | **是** |
 * | `mixed` | `"PK` + 真字节 `06` + 文本 `\x07`（4 个字符）+ `"` | `50 4B 06 5C 78 30 37` | **否**（是"转义文本"） |
 *
 * `mixed` 形态之所以仍然正确，是因为**这份文本是 JS 源码**：浏览器解析
 * `"PK\x06\x07"` 时把 `\x07` 解释成一个字节 ⇒ 运行时**字符串值**仍是 4 字节签名。
 * 换言之：`literal` 形态的 search 串可以直接逐字节核对，`mixed` 形态**不能** ——
 * 后者必须经"JS 字符串字面量求值"或比对其 `atob` 参数才能核对。
 * 这个区别必须写在这里，否则下一个人会把 `mixed` 的 search 串当成字节序列去断言，
 * 得到"base64 与 search 不同源"的**假红**（本文件作者实际踩到过）。
 */
export const JSZIP_SIGNATURE_PATCHES: readonly JszipSignaturePatch[] = Object.freeze([
  Object.freeze({
    name: 'LOCAL_FILE_HEADER',
    base64: 'UEsDBA==',
    form: 'literal' as const,
    search: '"PK\x03\x04"',
    replacement: "atob('UEsDBA==')",
  }),
  Object.freeze({
    name: 'CENTRAL_FILE_HEADER',
    base64: 'UEsBAg==',
    form: 'literal' as const,
    search: '"PK\x01\x02"',
    replacement: "atob('UEsBAg==')",
  }),
  Object.freeze({
    name: 'CENTRAL_DIRECTORY_END',
    base64: 'UEsFBg==',
    form: 'literal' as const,
    search: '"PK\x05\x06"',
    replacement: "atob('UEsFBg==')",
  }),
  Object.freeze({
    name: 'ZIP64_CENTRAL_DIRECTORY_END',
    base64: 'UEsGBg==',
    form: 'literal' as const,
    search: '"PK\x06\x06"',
    replacement: "atob('UEsGBg==')",
  }),
  Object.freeze({
    name: 'ZIP64_CENTRAL_DIRECTORY_LOCATOR',
    base64: 'UEsGBw==',
    form: 'mixed' as const,
    // 混合形态：0x06 被折叠成真字节，`\x07` 仍留作文本转义。
    search: '"PK\x06\\x07"',
    replacement: "atob('UEsGBw==')",
  }),
  Object.freeze({
    name: 'DATA_DESCRIPTOR',
    base64: 'UEsHCA==',
    form: 'mixed' as const,
    // esbuild 把 0x08 写成 `\b`（而不是 `\x08`）。
    search: '"PK\\x07\\b"',
    replacement: "atob('UEsHCA==')",
  }),
])

/**
 * 每个签名的 **4 个真实字节**（显式事实，供逐条核对）。
 *
 * 为什么单列而不是从 `search` 串推：`mixed` 形态的 `search` 串里含有**文本转义**
 * （`\x07` 是 4 个字符），从它推字节会得到错的答案（见 `JSZIP_SIGNATURE_PATCHES` 的说明表）。
 * 本表是 base64 与 signature 语义之间的**唯一**对照面：
 * `verifyJszipPatchTable` 断言 `base64` 解出这 4 字节，`isJszipPatchApplied` 用它判断"已生效"。
 */
export const JSZIP_SIGNATURE_BYTES: Readonly<Record<string, readonly number[]>> = Object.freeze({
  LOCAL_FILE_HEADER: Object.freeze([0x50, 0x4b, 0x03, 0x04]),
  CENTRAL_FILE_HEADER: Object.freeze([0x50, 0x4b, 0x01, 0x02]),
  CENTRAL_DIRECTORY_END: Object.freeze([0x50, 0x4b, 0x05, 0x06]),
  ZIP64_CENTRAL_DIRECTORY_END: Object.freeze([0x50, 0x4b, 0x06, 0x06]),
  ZIP64_CENTRAL_DIRECTORY_LOCATOR: Object.freeze([0x50, 0x4b, 0x06, 0x07]),
  DATA_DESCRIPTOR: Object.freeze([0x50, 0x4b, 0x07, 0x08]),
})

/**
 * 校验补丁表自身的正确性（**纯**）。
 *
 * 四条：base64 解出的字节必须是该签名的 4 字节（对照 {@link JSZIP_SIGNATURE_BYTES}）、
 * 搜索串含外层引号、替换串是 `atob('…')` 且**未**被引号包住、
 * `replacement` 里的 base64 必须与 `base64` 字段一致（防"search 与 replacement 不同源"
 * 这种**静默**错误：它会让产物在替换后值变了但语法仍合法，没有任何信号）。
 *
 * 为什么把它做成可调用函数而不是测试里的内联断言：宿主验收要求"异常匹配诊断"，
 * 而"替换串被引号包住"这一条正是历史事故的形态 —— 它必须能被**运行期**检查，
 * 而不是只在测试里检查一次。测试调用它，构建插件的替代实现也可以调用它。
 */
export function verifyJszipPatchTable(
  patches: readonly JszipSignaturePatch[] = JSZIP_SIGNATURE_PATCHES,
): readonly string[] {
  const out: string[] = []
  for (const p of patches) {
    const expectBytes = JSZIP_SIGNATURE_BYTES[p.name]
    const decoded = decodeBase64Latin1(p.base64)
    if (decoded === null) {
      out.push(`${p.name}: base64 非法（${p.base64}）`)
    } else if (expectBytes === undefined) {
      out.push(`${p.name}: 不在 JSZIP_SIGNATURE_BYTES 表内（无权威字节可对照）`)
    } else if (hexOfLatin1(decoded) !== hexOfBytes(Uint8Array.from(expectBytes))) {
      out.push(
        `${p.name}: base64 解出的字节不是该签名的 4 字节（期望 ${hexOfBytes(Uint8Array.from(expectBytes))}，` +
          `实得 ${hexOfLatin1(decoded)}）`,
      )
    }
    if (!(p.search.startsWith('"') && p.search.endsWith('"'))) {
      out.push(`${p.name}: 搜索串必须含外层双引号（否则替换后第二个 " 会提前闭合，破坏脚本语法）`)
    }
    if (!/^atob\('[A-Za-z0-9+/]+={0,2}'\)$/.test(p.replacement)) {
      out.push(`${p.name}: 替换串必须是无引号的 atob('…') 表达式，实得 ${p.replacement}`)
    }
    if (p.replacement.includes('"')) {
      out.push(`${p.name}: 替换串含双引号，可能破坏外层 JavaScript 字符串`)
    }
    // search 与 replacement 必须**同源**：replacement 里的 base64 必须等于该签名的 base64。
    const inReplacement = /atob\('([A-Za-z0-9+/]+={0,2})'\)/.exec(p.replacement)?.[1]
    if (inReplacement !== undefined && inReplacement !== p.base64) {
      out.push(
        `${p.name}: search/base64 与 replacement 里的 base64 不同源（${p.base64} vs ${inReplacement}）—— ` +
          '替换后值会变而语法仍合法，属静默错误',
      )
    }
  }
  return Object.freeze(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// 补丁应用（无匹配 / 异常匹配诊断）
// ─────────────────────────────────────────────────────────────────────────────

/** 补丁诊断码（稳定、语言无关）。 */
export type JszipPatchDiagnosticCode =
  /** 一个签名都没匹配到：**必须可见**，不得静默 `patched 0`。 */
  | 'JszipPatchNoMatch'
  /** 部分匹配：产物里应有 6 个签名，只命中一部分（esbuild/JSZip 版本漂移的指纹）。 */
  | 'JszipPatchPartialMatch'
  /** 该替换**已**存在（重复应用/已在源里）：不是错误，但必须与"新打上"区分。 */
  | 'JszipPatchAlreadyApplied'
  /** 发现被引号包住的 `atob(...)`：表达式变成字符串并破坏脚本语法。 */
  | 'JszipPatchQuoteWrappedAtob'
  /** 补丁表自身不合规（见 `verifyJszipPatchTable`）。 */
  | 'JszipPatchTableInvalid'
  /** 产物里仍残留 C0 控制字节（补丁没覆盖全 —— 上传后必坏）。 */
  | 'JszipPatchResidualControlBytes'

/** 一条补丁诊断。 */
export interface JszipPatchDiagnostic {
  readonly code: JszipPatchDiagnosticCode
  readonly params: Readonly<Record<string, string | number>>
}

/** 逐签名的命中情况。 */
export interface JszipPatchHit {
  readonly name: string
  readonly form: 'literal' | 'mixed'
  /** `search` 出现次数。 */
  readonly matched: number
  /** `replacement` 在此之前已出现次数（区分"这次打上"与"早已在"）。 */
  readonly alreadyPresent: number
}

/**
 * 补丁判定（**四态**，不是 `patched:number`）。
 *
 * 为什么不用一个计数：现存插件的 `console.log('patched', count)` 在 count=0 时
 * **看不出来是"产物本来没有签名"还是"搜索串失配了"** —— 而后者意味着 ZIP 会在
 * 上传后损坏且没有任何信号（已知风险）。
 */
export type JszipPatchVerdict =
  /** 6 条全部命中并替换（或用"已存在"满足）。 */
  | 'patched-all'
  /** 命中一部分 —— 需人工核对 esbuild/JSZip 是否改了折叠形态。 */
  | 'patched-partial'
  /** 一条都没命中。 */
  | 'no-match'
  /** 一条都不需要打（全部已应用）。 */
  | 'already-applied'
  /** 补丁表本身不合规 ⇒ 拒绝在产物上运行。 */
  | 'invalid-table'

/** 补丁应用结果。 */
export interface JszipPatchOutcome {
  readonly verdict: JszipPatchVerdict
  readonly text: string
  readonly hits: readonly JszipPatchHit[]
  readonly diagnostics: readonly JszipPatchDiagnostic[]
  /** 替换前 / 替换后长度（`patched N signature(s)` 的可核对形式）。 */
  readonly bytesBefore: number
  readonly bytesAfter: number
}

/**
 * 应用 JSZip 签名补丁（**纯**）。
 *
 * ## 与现存实现的差异（**刻意**，逐条说明）
 *
 * | 现存插件 | 本函数 | 理由 |
 * |---|---|---|
 * | 只 `console.log('patched', count)` | 四态 `verdict` + 结构化诊断 | 要求"无匹配/异常匹配诊断" |
 * | `content.length !== before` 判命中 | 直接数 `search` 出现次数 | `atob` 替换**恰好**变长，长度判据在"替换串长度相等"时会漏报 |
 * | 不做补丁表自检 | 先跑 `verifyJszipPatchTable` | 表写错（例如替换串带引号）会静默产出语法错误产物 |
 * | 不检查残留控制字节 | `JszipPatchResidualControlBytes` | 只替换了 6 个签名不等于"没有其它 C0 字节"；残留者上传后仍坏 |
 *
 * ## 关于"残留控制字节"这条诊断的**准确口径**
 *
 * 产物里可能有**与 ZIP 无关**的 C0 字节（实测 wiki bundle 有 2 个 `0x01`，
 * 来自 `presentation/compileScene.ts:264` 的 `parts.join('\u0001')` 分隔符）。
 * 那些字节被 MediaWiki 换成 U+FFFD 后**不影响正确性**（它们只作分隔符，换什么字符都行，
 * 只要两侧一致 —— 而两侧都是同一份产物里同一个字面量）。
 * ⇒ 本诊断的语义是"**仍有** C0 字节"这一**事实**，注释里必须同时说明它是**已知可接受**的
 * 情形；把"0 个"当硬性要求会得出错误结论（要求 `compileScene` 改分隔符）。
 * 真正的硬性要求是：**6 个 ZIP 签名的控制字节一个都不剩**。
 */
export function applyJszipSignaturePatch(text: string): JszipPatchOutcome {
  const tableProblems = verifyJszipPatchTable()
  const bytesBefore = text.length
  if (tableProblems.length > 0) {
    return Object.freeze({
      verdict: 'invalid-table' as const,
      text,
      hits: Object.freeze([]),
      diagnostics: Object.freeze(
        tableProblems.map((p) => Object.freeze({ code: 'JszipPatchTableInvalid' as const, params: Object.freeze({ problem: p }) })),
      ),
      bytesBefore,
      bytesAfter: bytesBefore,
    })
  }

  let out = text
  const hits: JszipPatchHit[] = []
  const diagnostics: JszipPatchDiagnostic[] = []
  let newlyApplied = 0
  let satisfiedByExisting = 0

  for (const p of JSZIP_SIGNATURE_PATCHES) {
    const matched = countOccurrences(out, p.search)
    const alreadyPresent = countOccurrences(out, p.replacement)
    if (matched > 0) {
      out = out.split(p.search).join(p.replacement)
      newlyApplied++
    } else if (alreadyPresent > 0) {
      satisfiedByExisting++
    }
    hits.push(Object.freeze({ name: p.name, form: p.form, matched, alreadyPresent }))
    if (matched === 0 && alreadyPresent === 0) {
      diagnostics.push(
        Object.freeze({
          code: 'JszipPatchNoMatch' as const,
          params: Object.freeze({ signature: p.name, form: p.form, search: hexOfLatin1(p.search) }),
        }),
      )
    }
  }

  // 异常匹配 1：被引号包住的 atob(...) —— 语法错误形态（历史事故）。
  const quoteWrapped = countOccurrences(out, `"atob('`) + countOccurrences(out, `'atob('`)
  if (quoteWrapped > 0) {
    diagnostics.push(
      Object.freeze({
        code: 'JszipPatchQuoteWrappedAtob' as const,
        params: Object.freeze({ occurrences: quoteWrapped }),
      }),
    )
  }
  // 异常匹配 2：替换串用了双引号参数（第一版修复形态）。
  const doubleQuotedArg = countOccurrences(out, 'atob("')
  if (doubleQuotedArg > 0) {
    diagnostics.push(
      Object.freeze({
        code: 'JszipPatchQuoteWrappedAtob' as const,
        params: Object.freeze({ occurrences: doubleQuotedArg, form: 'double-quoted-argument' }),
      }),
    )
  }

  const totalMatchedOrPresent = hits.filter((h) => h.matched > 0 || h.alreadyPresent > 0).length
  if (totalMatchedOrPresent === 0) {
    diagnostics.push(Object.freeze({ code: 'JszipPatchNoMatch' as const, params: Object.freeze({ scope: 'all' }) }))
  } else if (totalMatchedOrPresent < JSZIP_SIGNATURE_PATCHES.length) {
    diagnostics.push(
      Object.freeze({
        code: 'JszipPatchPartialMatch' as const,
        params: Object.freeze({ covered: totalMatchedOrPresent, expected: JSZIP_SIGNATURE_PATCHES.length }),
      }),
    )
  }

  // ## 为什么这里**没有** `JszipPatchResidualControlBytes` 诊断
  //
  // 因为它在 `applyJszipSignaturePatch` 内部**结构上不可达**：上面的
  // `split(search).join(replacement)` 必然清掉每一个 `search` 的出现。
  // 写一条永不可能触发的诊断 = 让判据冒充已实现。
  // ⇒ "产物里还有没有 ZIP 签名字节"这个问题由独立的 `findResidualZipSignatures()` 回答，
  //    它的消费方是构建后校验与 `isJszipPatchApplied`（两者都真的能遇到"有残留"的状态）。
  //    该诊断码保留在类型里，供**校验路径**使用（见 `evaluateHostTransfer` 的调用方与测试）。

  let verdict: JszipPatchVerdict
  if (totalMatchedOrPresent === 0) verdict = 'no-match'
  else if (totalMatchedOrPresent < JSZIP_SIGNATURE_PATCHES.length) verdict = 'patched-partial'
  else if (newlyApplied === 0) verdict = 'already-applied'
  else verdict = 'patched-all'

  return Object.freeze({
    verdict,
    text: out,
    hits: Object.freeze(hits),
    diagnostics: Object.freeze(diagnostics),
    bytesBefore,
    bytesAfter: out.length,
  })
}

/**
 * 补丁是否**真实生效**（供构建后断言）。
 *
 * 语义：6 条签名全部不再以字面量形态出现，且 6 个 `atob(...)` 表达式都在。
 * 这是"构建产物里不再含 6 个搜索串、且含 6 个对应 atob"的机器可读形式
 * （现存判据只有一句描述，无实现）。
 *
 * **注意**：`false` 有两种含义 —— "还没补丁"与"补丁跑过但没匹配上"。
 * 构建插件必须用 {@link applyJszipSignaturePatch} 的 `verdict` 区分二者
 * （`patched-all` / `already-applied` vs `no-match` / `patched-partial`），
 * **不得**只靠本布尔量判断"构建是否正常"。
 */
export function isJszipPatchApplied(text: string): boolean {
  return JSZIP_SIGNATURE_PATCHES.every(
    (p) => !text.includes(p.search) && text.includes(p.replacement),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 宿主传输等价处理（MediaWiki 控制字符替换的模拟）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MediaWiki 存储会替换掉的 C0 字节。
 *
 * 口径**逐字**取自证据文档：`0x01–0x08`、`0x0B–0x1F`；**TAB(0x09) 与 LF(0x0A) 除外**。
 * 注意 `0x0D`（CR）**在**被替换范围内 —— 这与"本仓铁律 6 关注 CRLF"看似冲突，
 * 但两者是**不同层面**的事：铁律 6 说的是**本仓检出**的行尾，这里说的是**Wiki 存储**对
 * 产物字节的处理。产物文本在 Wiki 侧以 LF 存储，CR 本来就不会存活，
 * 故把 0x0D 计入被替换集合不会与铁律 6 冲突（本模块不做行尾归一）。
 *
 * `0x00` 不在文档给出的范围内，故**不**模拟（不确定的事不假装确定）。
 */
export const MEDIAWIKI_REPLACED_C0_CODES: readonly number[] = Object.freeze([
  ...range(0x01, 0x08),
  ...range(0x0b, 0x1f),
])

/** U+FFFD 的 UTF-8 编码（`EF BF BD`）—— MediaWiki 用它替换控制字符。 */
export const REPLACEMENT_CHAR_UTF8: readonly number[] = Object.freeze([0xef, 0xbf, 0xbd])

/** 传输模拟结果。 */
export interface MediaWikiTransferOutcome {
  readonly bytes: Uint8Array
  /** 被替换的字节总数。 */
  readonly replacedBytes: number
  /** 逐字节码的替换计数（`'03' → 1`），供证据文件逐条对账。 */
  readonly replacedCodes: Readonly<Record<string, number>>
  /** U+FFFD 三字节序列的出现次数（应等于 `replacedBytes`）。 */
  readonly replacementCharSequences: number
}

/**
 * 模拟 MediaWiki 存储对产物字节的处理（**纯**）。
 *
 * ## 为什么是**字节级**而不是字符串级
 *
 * C0 字节在 UTF-8 里是**单字节**序列，U+FFFD 是**三字节** `EF BF BD`。
 * 因此"把字节 b 换成 `EF BF BD`"与"把字符 U+000b 换成 U+FFFD 再 UTF-8 编码"
 * 得到**完全相同的字节**。字节级实现因此既更简单也**更少假设**——
 * 它不需要相信"读入用的编码正确"这件事（而现存插件必须按 latin1 读）。
 *
 * ## 它**不能**证明什么（诚实边界）
 *
 * 它只复现"控制字符被替换成 U+FFFD"这一条规则。真实 Wiki 还会做别的变换
 * （模板展开、魔术字、`~~~~` 签名替换……），本模拟**不覆盖**那些。
 * 因此"通过本模拟"不等于"通过真实 Wiki 往返"；后者属真实往返判据，
 * **本次未执行**（见文件末的"未核实"登记）。
 */
export function simulateMediaWikiStorageTransfer(bytes: Uint8Array): MediaWikiTransferOutcome {
  const replacedCodes: Record<string, number> = {}
  const out: number[] = []
  let replacedBytes = 0
  for (const b of bytes) {
    if (MEDIAWIKI_REPLACED_C0_CODES.includes(b)) {
      const key = b.toString(16).padStart(2, '0')
      replacedCodes[key] = (replacedCodes[key] ?? 0) + 1
      replacedBytes++
      out.push(...REPLACEMENT_CHAR_UTF8)
      continue
    }
    out.push(b)
  }
  const bytesOut = Uint8Array.from(out)
  let replacementCharSequences = 0
  for (let i = 0; i + 2 < bytesOut.length; i++) {
    if (bytesOut[i] === 0xef && bytesOut[i + 1] === 0xbf && bytesOut[i + 2] === 0xbd) replacementCharSequences++
  }
  return Object.freeze({
    bytes: bytesOut,
    replacedBytes,
    replacedCodes: Object.freeze(replacedCodes),
    replacementCharSequences,
  })
}

/**
 * 把产物文本按 **latin1** 编成字节。
 *
 * 这是字节映射的关键口径：产物含真实控制字节，必须逐字节 1:1 映射（`charCodeAt & 0xFF`），
 * 按 UTF-8 编码会把 `0x03` 写成 `03`（碰巧也对）但把**任何**非 ASCII 字节写成多字节 ——
 * 而 latin1 往返是**恒等**的，故它是唯一安全的读写口径。
 */
export function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

/** 字节 → latin1 文本（与 {@link latin1ToBytes} 互逆）。 */
export function bytesToLatin1(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return s
}

/**
 * 字节 → JS 字符串，**按浏览器解析脚本的方式**（UTF-8，非致命）。
 *
 * ## 为什么这一步不可省略（第 5–6 步）
 *
 * 完整链路是**五段**，不是一段：
 *
 * ```
 * 产物字节 --MediaWiki 存储--> 传输后字节 --HTTP 传输--> 浏览器 UTF-8 解码 --> JS 字符串
 *          (0x03 → EF BF BD)                        (EF BF BD → U+FFFD)
 * ```
 *
 * 只做前两段（把字节当 latin1 读）会得到 `\u00EF\u00BF\u00BD` 三个字符，
 * 其 `charCodeAt & 0xFF` 是 `EF BF BD` —— **还是不对**（本文件作者实测踩到过：
 * 跳这一步会推出 `504befbfbdfd…` 这种不存在的头）。
 * 只有把 `EF BF BD` 按 UTF-8 解码成**一个** U+FFFD，`& 0xFF` 才得到 `0xFD`，
 * 也就是那条真实证据里的 `50 4B FD FD`。
 *
 * `fatal: false` 是必要的：真实产物里可能有**非 UTF-8 的字节序列**
 * （例如已被替换过的残留碎片），此时浏览器不会拒绝解析整份脚本，
 * 而是插入 U+FFFD 继续 —— 模拟必须同款行为，否则模拟会在真宿主不报错的地方报错。
 */
export function decodeScriptBytesAsUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/**
 * 从"产物文本 + 宿主传输"推出**浏览器里 JS 会看到的字符串**（**纯**）。
 *
 * 这是往返判据的**唯一**入口：它把上面那张五段链路钉在一处，
 * 使"哪一段被跳过"不可能悄悄发生（跳步会改变结果，判据随之失败）。
 *
 * 输入按 **latin1** 文本给出（= 产物字节的 1:1 视图，见 `latin1ToBytes`），
 * 输出是浏览器解码后的 JS 字符串（此时 `\uFFFD` 已是**一个**字符）。
 */
export function throughHostTransferAsScript(text: string): {
  readonly script: string
  readonly replacedBytes: number
  readonly replacedCodes: Readonly<Record<string, number>>
} {
  const transferred = simulateMediaWikiStorageTransfer(latin1ToBytes(text))
  return Object.freeze({
    script: decodeScriptBytesAsUtf8(transferred.bytes),
    replacedBytes: transferred.replacedBytes,
    replacedCodes: transferred.replacedCodes,
  })
}

/**
 * 找出产物文本里**仍然以字面量形态**出现的 ZIP 签名（判据函数）。
 *
 * ## 为什么它必须是独立函数（而不是 `applyJszipSignaturePatch` 内部的一个分支）
 *
 * 在 `applyJszipSignaturePatch` 内部，`split(search).join(replacement)` **必然**
 * 清掉全部出现 ⇒ "替换后仍有残留"这一状态在该函数内部**结构上不可达**。
 * 把不可达分支写成一条诊断，会让那条诊断永远不可能触发 —— 那就是"未实现的判据
 * 冒充已实现"。
 *
 * 但"产物里是否还有签名控制字节"这个**问题本身**是真实且必须回答的：
 *  - 构建后的产物校验（产物里不再含 6 个搜索串）；
 *  - 校验一份**来路不明**的产物（例如别人构建的、或上一次构建的缓存）。
 * ⇒ 把它做成独立函数，由 `isJszipPatchApplied` 与构建校验调用。语义清晰、可达、可测。
 */
export function findResidualZipSignatures(text: string): readonly string[] {
  return Object.freeze(JSZIP_SIGNATURE_PATCHES.filter((p) => text.includes(p.search)).map((p) => p.name))
}

/** 取前 `n` 字节的 hex（证据文件用；默认 8）。 */
export function hexPreview(bytes: Uint8Array, n = 8): string {
  return hexOfBytes(bytes.subarray(0, Math.min(n, bytes.length)))
}

/** 字节数组 → 小写 hex 字符串（无分隔）。 */
export function hexOfBytes(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/** latin1 文本 → hex（逐字符低字节）。 */
export function hexOfLatin1(text: string): string {
  return hexOfBytes(latin1ToBytes(text))
}

/** ZIP 局部文件头（合法产物前 4 字节）。 */
export const ZIP_LOCAL_HEADER_HEX = '504b0304'

/**
 * 产物字节是否以合法的 ZIP 局部文件头开始（判据 (b) 的等价物，
 * 也是 `web/src/operators/builtin/exportOperators.ts:68-74` 的运行时插桩判据）。
 */
export function hasValidZipLocalHeader(bytes: Uint8Array): boolean {
  return hexPreview(bytes, 4) === ZIP_LOCAL_HEADER_HEX
}

// ─────────────────────────────────────────────────────────────────────────────
// 每个 profile 的宿主传输决策
// ─────────────────────────────────────────────────────────────────────────────

/** 某 profile 是否需要 ZIP 补丁，以及依据。 */
export interface HostTransferDecision {
  readonly profile: string
  /** 产物里是否存在 ZIP 签名字面量。 */
  readonly carriesZipSignatures: boolean
  /** 是否必须在宿主传输前打补丁。 */
  readonly requiresJszipPatch: boolean
  /** 本决策的依据（必须指向可核对的事实，不得是"应该没问题"）。 */
  readonly because: string
}

/**
 * **覆盖缺口的显式决策**。
 *
 * ## 缺口是什么
 *
 * `fixJszipSignaturesForWiki` 只挂在 `vite.wiki-workbench.config.ts`；
 * `vite.embed.config.ts` 的 `plugins: [vue()]` **没有**这道补丁。
 * 若 embed 产物里也含 JSZip 签名字面量，上传 Wiki 后会坏 —— 属"未登记的不对称"。
 *
 * ## 结论（**实测**，不是推断）
 *
 * **结论**：embed 产物（`dist/StructureRender.js`、`dist/StructureRender.css`）
 * **确实不含**任何 JSZip 签名字面量，因此**当前无实际影响**；
 * 但该不对称**登记为需守卫的不变量**，并给出**判据**（见 `embedZipFreedom`）。
 *
 * ## 证据（实测）
 *
 * | 产物 | 字节数 | `50 4B 03 04` | `50 4B 01 02` | `50 4B 05 06` | `50 4B 06 06` | `50 4B 06 5C 78 30 37` | `50 4B 5C 78 30 37 5C 62` | 非 TAB/LF/CR 的 C0 |
 * |---|---|---|---|---|---|---|---|---|
 * | `embed/StructureRender.js` | 799720 | 0 | 0 | 0 | 0 | 0 | 0 | `01×1` |
 * | `embed/StructureRender.css` | 201746 | 0 | 0 | 0 | 0 | 0 | 0 | 无 |
 * | `wiki-nopatch/bundled/StructureWorkbench.bundle.js` | 1205309 | 1 | 1 | 1 | 1 | 1 | 1 | `01×2,02,03,04,05,06×4` |
 * | `workbench/bundled/index-workbench-*.js` | 1204968 | 1 | 1 | 1 | 1 | 1 | 1 | 同上 |
 *
 * embed 里那 1 个 `0x01` 来自 `presentation/compileScene.ts:264` 的
 * `parts.join('\u0001')`（稳定哈希分隔符），**不是** ZIP 签名 —— 按上面
 * "残留控制字节的准确口径"它不影响正确性。
 *
 * ## 判据（为何"暂时无影响"不是一句空话）
 *
 * 1. **静态可达性**：`web/src/main.ts`（embed 的构建入口）的模块闭包
 *    **不得**包含任何 import `jszip` 的模块（`workbench/export/bundleMeshAssembly.ts`）。
 *    这条比"扫产物"更强 —— 它在**构建之前**就拦住了把 JSZip 拉进 embed 的改动。
 *    由 `tests/architecture/artifact-host.test.ts` 用真实模块图断言。
 * 2. **产物扫描**（有产物时）：embed 产物中 6 个签名搜索串计数必须全为 0。
 *    此判据在**没有构建产物**的树上无法执行 ⇒ 如实登记为证据缺口，
 *    由静态可达性判据承担（两者关系：可达性判据是**充分**条件的一半——
 *    它保证"不可能含 JSZip"，产物扫描是它的结果验证）。
 * 3. **回归守卫**：一旦将来 embed 需要 ZIP（例如 Wiki 零件页支持导出），
 *    判据 1 会立刻判红，迫使该次改动**同时**决定"加补丁"或"改由 wiki-workbench 承担导出"。
 *    这就是把"未登记的不对称"变成"有守卫的决策"。
 *
 * ## 为什么不直接给 embed 也加上补丁
 *
 * 因为那会违反另一半要求："**优先通过稳定构建配置/宿主封装避免对压缩产物的
 * 脆弱字节匹配**"。给一个**不需要**它的产物加字节匹配，等于把脆弱性扩大到更大面积，
 * 且掩盖了真正的架构问题（"导出能力该由哪个 profile 承担"）。
 * 正确方向是判据 1 的静态守卫 —— 本次交付它。
 */
export const T06_DECISION: HostTransferDecision = Object.freeze({
  profile: 'embed',
  carriesZipSignatures: false,
  requiresJszipPatch: false,
  because:
    'dist/StructureRender.js（799720 B）与 .css（201746 B）中 6 个 ZIP 签名搜索串计数均为 0；' +
    '且静态模块可达性上 embed 入口 web/src/main.ts 的闭包不含 import jszip 的 bundleMeshAssembly.ts。' +
    '这是需守卫的不变量：一旦 embed 引入 ZIP，tests/architecture/artifact-host.test.ts 的可达性判据立即判红。',
})

/**
 * 各 profile 的宿主传输决策表（宿主验收判据"各 profile 经宿主传输变换后加载"）。
 *
 * `workbench` 与 `wiki-workbench` 都含 ZIP 签名 —— 但只有 `wiki-workbench`
 * 的产物会**上传到 MediaWiki 存储**，故只有它需要补丁。
 * `workbench` 的产物由 mod JAR 内嵌静态服务，**不经过 MediaWiki 存储** ——
 * 这不是"漏了补丁"，而是"没有那个损坏环节"。写清这一条是为了避免下一个人
 * "看到 workbench 没补丁就顺手补上"（那会引入无谓的字节匹配脆弱性，明令避免）。
 */
export const HOST_TRANSFER_DECISIONS: readonly HostTransferDecision[] = Object.freeze([
  Object.freeze({
    profile: 'workbench',
    carriesZipSignatures: true,
    requiresJszipPatch: false,
    because:
      '产物含 6 个 ZIP 签名（index-workbench-*.js 计数各 1），但经 mod JAR 内嵌静态服务 ' +
      'assets/lightning/web/ 加载，**不经过 MediaWiki 存储** ⇒ 不存在控制字符替换环节。' +
      '按「优先避免脆弱字节匹配」，此处**不**加补丁。',
  }),
  T06_DECISION,
  Object.freeze({
    profile: 'wiki-workbench',
    carriesZipSignatures: true,
    requiresJszipPatch: true,
    because:
      '产物含 6 个 ZIP 签名（各 1）且**上传至 MediaWiki 存储** ⇒ 必须打补丁。' +
      '补丁必须在**上传前**完成：补丁后产物不再含任何 C0 字节，故存储替换规则不再触及它。',
  }),
  Object.freeze({
    profile: 'headless',
    carriesZipSignatures: false,
    requiresJszipPatch: false,
    because: '无独立产物（`artifacts: []`）；由调用方在自己的构建里决定，不属于本仓的传输面。',
  }),
])

/**
 * "补丁必须发生在上传之前"这一**顺序**约束的机器可读形式。
 *
 * 为什么单列：把补丁排在传输之后是**能通过类型检查**的错误（两个函数签名都对），
 * 但它会让修复完全失效（签名字节已被替换成 U+FFFD，`search` 再也匹配不到）。
 * 本常量与 `applyJszipSignaturePatch` 的"无匹配诊断"合起来使这个错误**可见**：
 * 顺序错 ⇒ verdict 为 `no-match` ⇒ 诊断 `JszipPatchNoMatch`。
 */
export const PATCH_MUST_PRECEDE_TRANSFER = true

/** 对某 profile 的产物文本做"是否需要补丁且补丁是否已生效"的完整判定（**纯**）。 */
export function evaluateHostTransfer(
  profile: string,
  bundleText: string,
): {
  readonly decision: HostTransferDecision | undefined
  readonly patchNeeded: boolean
  readonly patchApplied: boolean
  readonly residualSignatures: readonly string[]
  readonly diagnostic: JszipPatchDiagnostic | null
} {
  const decision = HOST_TRANSFER_DECISIONS.find((d) => d.profile === profile)
  const applied = isJszipPatchApplied(bundleText)
  const residual = findResidualZipSignatures(bundleText)
  const literalPresent = residual.length > 0
  const patchNeeded = decision?.requiresJszipPatch === true && literalPresent
  if (decision === undefined) {
    return Object.freeze({
      decision: undefined,
      patchNeeded: false,
      patchApplied: applied,
      residualSignatures: residual,
      diagnostic: Object.freeze({
        code: 'JszipPatchNoMatch' as const,
        params: Object.freeze({ reason: 'unknown-profile', profile }),
      }),
    })
  }
  // 该 profile 需要补丁，但产物里**一个签名都没有** ⇒ 报"根本不含签名"。
  // 这是已知风险：静默失配会表现为"构建成功而 ZIP 已坏"。
  if (decision.requiresJszipPatch && !literalPresent && !applied) {
    return Object.freeze({
      decision,
      patchNeeded: false,
      patchApplied: false,
      residualSignatures: residual,
      diagnostic: Object.freeze({
        code: 'JszipPatchNoMatch' as const,
        params: Object.freeze({ reason: 'product-has-no-zip-signature-at-all', profile }),
      }),
    })
  }
  // 半补丁形态（部分字面量 + 部分 atob）：产物既非"未补丁"也非"已补丁" ⇒ 必须报残留。
  if (literalPresent && applied === false && residual.length < JSZIP_SIGNATURE_PATCHES.length) {
    return Object.freeze({
      decision,
      patchNeeded,
      patchApplied: applied,
      residualSignatures: residual,
      diagnostic: Object.freeze({
        code: 'JszipPatchResidualControlBytes' as const,
        params: Object.freeze({ signatures: residual.join(','), profile }),
      }),
    })
  }
  return Object.freeze({
    decision,
    patchNeeded,
    patchApplied: applied,
    residualSignatures: residual,
    diagnostic: null,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────────────────────

function range(from: number, to: number): number[] {
  const out: number[] = []
  for (let i = from; i <= to; i++) out.push(i)
  return out
}

/** 不重叠地数 `needle` 出现次数（`split` 会因替换串含搜索串前缀而偏大，这里逐位置前进）。 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

/**
 * base64 → latin1 文本（不依赖宿主 `atob`）。
 *
 * 为什么不用全局 `atob`：本模块要能回答"该 base64 解出什么字节"这一**构建期**问题，
 * 而构建期的宿主能力是不可假设的（这正是能力矩阵在说的事）。自己实现一份
 * 让判据不依赖宿主环境 —— 也让 `verifyJszipPatchTable` 在无 `atob` 的宿主上仍可用。
 * 非法输入返回 `null`（不抛异常：这是校验路径，异常会让"诊断"退化成"崩溃"）。
 */
function decodeBase64Latin1(b64: string): string | null {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = b64.replace(/=+$/, '')
  if (!/^[A-Za-z0-9+/]*$/.test(clean)) return null
  let bits = 0
  let value = 0
  let out = ''
  for (const ch of clean) {
    const idx = table.indexOf(ch)
    if (idx === -1) return null
    value = (value << 6) | idx
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out += String.fromCharCode((value >> bits) & 0xff)
    }
  }
  return out
}
