/**
 * A34 `artifact-host` —— **构建 manifest** 判据（宿主产物传输）。
 *
 * ## 契约原文
 *
 * > 构建后 manifest 记录 **profile、模块集合、源码版本与资源哈希**，**不包含凭据**。
 *
 * ## 主负对照（「负对照必须证明确实破坏了目标保证」）
 *
 * 「把 token 塞进 manifest 输入 ⇒ 必须**不出现原值**」。
 * 本文件的负对照不是"断言 `redactions > 0`"这种形式检查，而是：
 *  - 把 5 种真实凭据形态分别塞进**不同字段**（源码版本 / 模块 id / 裁剪原因 /
 *    构建工具表的键与值 / builder / note）；
 *  - 然后对 `JSON.stringify(manifest)` 做 `includes(原值)` 的**穷举**断言 ——
 *    只要任何一个原值出现在序列化结果里，判据就红。
 *
 * 另外还判：脱敏规则与 `application/diagnostics.ts` 的 `sanitizeParams` **同源**
 * （正则源文本逐字一致），防止两处口径漂移。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MANIFEST_REDACTED,
  MANIFEST_VALUE_MAX,
  SECRET_KEY_PATTERN,
  SECRET_VALUE_PATTERNS,
  buildManifest,
  classifyAssetRole,
  digestBytes,
  digestText,
  projectAssetSet,
  projectModuleSet,
  sanitizeManifestEntry,
  sanitizeManifestString,
  scanForCredentials,
  validateBuildManifest,
  type BuildManifestInput,
} from '../buildManifest'

const KNOWN_PROFILES = ['workbench', 'embed', 'wiki-workbench', 'headless']

/** 一份合规的最小输入（各用例在此基础上改一处）。 */
function baseInput(over: Partial<BuildManifestInput> = {}): BuildManifestInput {
  return {
    profile: 'wiki-workbench',
    contractVersion: 'host-contract/1',
    sourceVersion: '9dc1110',
    sourceDirty: false,
    modules: [
      { id: 'adapters/host/hostCapabilities', bytes: 39366 },
      { id: 'adapters/host/artifactTransport', bytes: 34057 },
      { id: 'adapters/host/buildManifest', bytes: 22330 },
    ],
    assets: [
      { path: 'dist-wiki-workbench/bundled/StructureWorkbench.bundle.js', bytes: 1205309, digest: 'fnv1a32:3c915368', role: 'entry' },
      { path: 'dist-wiki-workbench/bundled/StructureWorkbench.css', bytes: 65213, digest: 'fnv1a32:eb0743cd', role: 'style' },
    ],
    buildTools: { vite: '6.4.2', esbuild: '(bundled with vite)' },
    ...over,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、四个必填字段
// ─────────────────────────────────────────────────────────────────────────────

describe('A34 manifest：要求的四个字段都在且可核对', () => {
  it('profile / 模块集合 / 源码版本 / 资源哈希 四类字段齐备', () => {
    const m = buildManifest(baseInput())
    expect(m.profile).toBe('wiki-workbench')
    expect(m.modules.length).toBeGreaterThan(0)
    expect(m.sourceVersion).toBe('9dc1110')
    expect(m.assets.length).toBeGreaterThan(0)
    for (const a of m.assets) expect(a.digest).toMatch(/^fnv1a32:[0-9a-f]{8}$/)
  })

  it('摘要算法是**显式**字段（FNV-1a 32 不是密码学哈希 —— 消费方必须能看出来）', () => {
    const m = buildManifest(baseInput())
    expect(m.digestAlgorithm).toBe('fnv1a32')
  })

  it('模块与资源都**稳定排序** ⇒ 同一输入两次构建逐字节一致（可对账）', () => {
    const a = buildManifest(baseInput())
    const b = buildManifest(baseInput())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    // 故意打乱输入顺序，输出必须仍相同。
    const shuffled = buildManifest(
      baseInput({
        modules: [...baseInput().modules].reverse(),
        assets: [...baseInput().assets].reverse(),
      }),
    )
    expect(JSON.stringify(shuffled.modules)).toBe(JSON.stringify(a.modules))
    expect(JSON.stringify(shuffled.assets)).toBe(JSON.stringify(a.assets))
  })

  it('`sourceDirty` 被如实记录（证据与提交对账靠它）', () => {
    expect(buildManifest(baseInput({ sourceDirty: true })).sourceDirty).toBe(true)
    expect(buildManifest(baseInput({ sourceDirty: false })).sourceDirty).toBe(false)
  })

  it('合规输入 0 违规（`validateBuildManifest`）', () => {
    const m = buildManifest(baseInput())
    expect(validateBuildManifest(m, { expectedContractVersion: 'host-contract/1', knownProfiles: KNOWN_PROFILES })).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 二、**主负对照**：凭据不出现原值
// ─────────────────────────────────────────────────────────────────────────────

describe('A34 manifest 负对照：把 token 塞进输入 ⇒ 输出**不得出现原值**', () => {
  /** 5 种真实凭据形态（每一种都对应一种现实事故）。 */
  const SECRETS: ReadonlyArray<{ readonly what: string; readonly value: string; readonly field: string }> = [
    { what: 'GitHub PAT（Bearer 形态）', value: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', field: 'sourceVersion' },
    { what: '通用 token=（env 行形态）', value: 'token=abcdef123456789', field: 'note' },
    { what: '带凭据的 URL（本仓明令禁止的 remote 形态）', value: 'https://ci:sup3rsecret@ci.example.com/job/1', field: 'builder' },
    { what: 'Gitea/GitLab 前缀 token', value: 'glpat-abcdefghijklmnop', field: 'modules.pruneReason' },
    { what: 'api_key=（键值形态）', value: 'api_key=0123456789abcdef', field: 'modules.id' },
  ]

  /** 把某个凭据按 `field` 塞进输入。 */
  function inputWithSecret(field: string, value: string): BuildManifestInput {
    if (field === 'sourceVersion') return baseInput({ sourceVersion: value })
    if (field === 'note') return baseInput({ note: value })
    if (field === 'builder') return baseInput({ builder: value })
    if (field === 'modules.id') return baseInput({ modules: [{ id: value, bytes: 1 }] })
    if (field === 'modules.pruneReason') {
      return baseInput({ modules: [{ id: 'some/module', bytes: 0, pruned: true, pruneReason: value }] })
    }
    if (field.startsWith('buildTools.')) {
      const key = field.slice('buildTools.'.length)
      return baseInput({ buildTools: { [key]: value } })
    }
    if (field.startsWith('assets.path')) {
      return baseInput({ assets: [{ path: value, bytes: 1, digest: 'fnv1a32:00000001', role: 'other' }] })
    }
    throw new Error(`未处理的字段：${field}`)
  }

  it.each(SECRETS)('$what 塞进 $field ⇒ 序列化结果里**不含**原值', ({ value, field }) => {
    const m = buildManifest(inputWithSecret(field, value))
    const serialized = JSON.stringify(m)
    expect(serialized.includes(value), `原值泄漏到 manifest：${value}`).toBe(false)
    // 也不得出现原值的**关键片段**（防止"部分替换"这种半吊子脱敏）。
    const core = value.replace(/^[a-z_]+[=:]/, '').replace(/^https:\/\//, '')
    expect(serialized.includes(core), `原值片段泄漏：${core}`).toBe(false)
    // 脱敏必须**可见**（不能既不出现原值也不留痕迹 —— 那样等于静默丢字段）。
    expect(m.redactions).toBeGreaterThan(0)
    expect(serialized).toContain(MANIFEST_REDACTED)
  })

  it('**穷举**：6 个字段位置 × 5 种凭据形态，全部不泄漏原值', () => {
    const fields = [
      'sourceVersion',
      'note',
      'builder',
      'modules.id',
      'modules.pruneReason',
      'buildTools.vite',
      'assets.path',
    ]
    const leaked: string[] = []
    for (const s of SECRETS) {
      for (const f of fields) {
        const m = buildManifest(inputWithSecret(f, s.value))
        const serialized = JSON.stringify(m)
        if (serialized.includes(s.value)) leaked.push(`${s.what} @ ${f}`)
      }
    }
    expect(leaked, `以下组合泄漏了原值：\n${leaked.join('\n')}`).toEqual([])
  })

  it('`scanForCredentials` 在脱敏后的 manifest 上 0 命中（判据复用生产规则，不靠测试自写期望）', () => {
    for (const s of SECRETS) {
      const m = buildManifest(inputWithSecret(s.field, s.value))
      const scan = scanForCredentials(m)
      expect(scan.hits, `${s.what} 在 ${s.field}：${scan.hits.join('; ')}`).toEqual([])
    }
  })

  it('**负对照的反向证明**：脱敏前的输入值**确实**会被 `scanForCredentials` 抓到（判据非恒绿）', () => {
    // 构造一份**绕过 buildManifest** 的 manifest（模拟"有人手写了一份 manifest"）。
    const handWritten = {
      manifestVersion: 'build-manifest/1' as const,
      profile: 'wiki-workbench',
      contractVersion: 'host-contract/1',
      sourceVersion: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      sourceDirty: false,
      digestAlgorithm: 'fnv1a32' as const,
      modules: [],
      assets: [],
      buildTools: {},
      redactions: 0,
    }
    const { hits } = scanForCredentials(handWritten)
    expect(hits.length, '未脱敏的 manifest 必须被判据抓到（否则上一条是空转）').toBeGreaterThan(0)
    const v = validateBuildManifest(handWritten, {
      expectedContractVersion: 'host-contract/1',
      knownProfiles: KNOWN_PROFILES,
    })
    expect(v.join('\n')).toContain('疑似凭据')
  })

  it('键名敏感（`registry-token`）与值形态敏感（`Bearer …`）**两条路径都生效**', () => {
    // 键名路径
    const byKey = buildManifest(baseInput({ buildTools: { 'registry-token': 'anything-at-all' } }))
    expect(JSON.stringify(byKey)).not.toContain('anything-at-all')
    expect(byKey.buildTools['registry-token']).toBe(MANIFEST_REDACTED)
    // 值形态路径（键名无害 `note`）
    const byValue = buildManifest(baseInput({ note: 'see Bearer abcdefghijklmnop for access' }))
    expect(byValue.note).toBe(MANIFEST_REDACTED)
  })

  it('超长值被截断（防"整份文档/整段 env"经无害键名旁路进入 manifest）', () => {
    const long = 'x'.repeat(MANIFEST_VALUE_MAX + 500)
    const m = buildManifest(baseInput({ note: long }))
    expect(m.note!.length).toBeLessThanOrEqual(MANIFEST_VALUE_MAX + 1)
    expect(m.note!.endsWith('…')).toBe(true)
    expect(m.redactions).toBeGreaterThan(0)
  })

  it('脱敏在**写入时**发生：manifest 里不存在敏感副本（不是读取时才过滤）', () => {
    const secret = 'token=abcdef123456789'
    const m = buildManifest(baseInput({ sourceVersion: secret }))
    // 遍历 manifest 的所有字符串值，逐条断言不含密钥片段。
    const strings: string[] = []
    const walk = (v: unknown): void => {
      if (typeof v === 'string') strings.push(v)
      else if (Array.isArray(v)) v.forEach(walk)
      else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk)
    }
    walk(m)
    const drive = secret.replace(/^token=/, '')
    expect(strings.some((s) => s.includes(drive)), '存在含凭据的字符串值').toBe(false)
  })

  it('`redactions` 计数与"被替换的字段数"一致（不是随口一个数）', () => {
    const m = buildManifest(
      baseInput({
        sourceVersion: 'token=aaaaaaaaaaaa',
        builder: 'Bearer bbbbbbbbbbbb',
        note: 'api_key=cccccccccccc',
      }),
    )
    expect(m.redactions).toBe(3)
    expect(m.sourceVersion).toBe(MANIFEST_REDACTED)
    expect(m.builder).toBe(MANIFEST_REDACTED)
    expect(m.note).toBe(MANIFEST_REDACTED)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 三、脱敏规则与 diagnostics 同源（防两处口径漂移）
// ─────────────────────────────────────────────────────────────────────────────

describe('A34 manifest：脱敏口径与 `application/diagnostics.ts` 同源', () => {
  it('键名正则**逐字**一致（两处必须同批改）', () => {
    const diagPath = path.join(process.cwd(), 'src/application/diagnostics.ts')
    const text = fs.readFileSync(diagPath, 'utf8').replace(/\r\n/g, '\n')
    const m = /const SECRET_KEY_RE = (\/.*?\/[a-z]*)/.exec(text)
    expect(m, 'diagnostics.ts 里必须仍能定位 SECRET_KEY_RE').not.toBeNull()
    expect(SECRET_KEY_PATTERN.source, '两处键名正则需要同源').toBe(new RegExp(m![1].slice(1, m![1].lastIndexOf('/'))).source)
    expect(SECRET_KEY_PATTERN.flags).toBe('i')
  })

  it('脱敏占位与 diagnostics 的 `REDACTED` 同形（一条规则，两个消费方）', () => {
    const diagPath = path.join(process.cwd(), 'src/application/diagnostics.ts')
    const text = fs.readFileSync(diagPath, 'utf8')
    expect(text).toContain("export const REDACTED = '«redacted»'")
    expect(MANIFEST_REDACTED).toBe('«redacted»')
  })

  it('`SECRET_VALUE_PATTERNS` 每条都真的能命中其目标形态（不是摆设）', () => {
    const samples = [
      'Bearer abcdefghijklmnop',
      'token=abcdef123456',
      'https://user:pass@host/x',
      'ghp_ABCDEFGHIJKLMNOPQRSTUV',
    ]
    for (const [i, re] of SECRET_VALUE_PATTERNS.entries()) {
      expect(re.test(samples[i]), `形态 #${i} 未能命中样本 ${samples[i]}`).toBe(true)
    }
  })

  it('值形态判据不误伤正常值（否则 manifest 会被脱敏到没有信息）', () => {
    for (const ok of ['6.4.2', 'host-contract/1', '9dc1110', 'dist/bundled/x.js', '(bundled with vite)']) {
      expect(sanitizeManifestString(ok), `正常值被误脱敏：${ok}`).toBe(ok)
    }
    expect(sanitizeManifestEntry('vite', '6.4.2')).toBe('6.4.2')
  })

  it('`sanitizeManifestEntry`：键名命中即脱敏，**不看值**（与 sanitizeParams 同口径）', () => {
    expect(sanitizeManifestEntry('mySecretValue', 'plain')).toBe(MANIFEST_REDACTED)
    expect(sanitizeManifestEntry('sessionId', 'abc')).toBe(MANIFEST_REDACTED)
    expect(sanitizeManifestEntry('normal', 'plain')).toBe('plain')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 四、校验规则（裁剪原因、唯一性、同代性）
// ─────────────────────────────────────────────────────────────────────────────

describe('A34 manifest 校验：裁剪必须有原因；id 唯一；与宿主契约同代', () => {
  it('被裁剪模块**必须**写原因（「可选落点被裁剪并记录原因」的产物层对应物）', () => {
    const m = buildManifest(baseInput({ modules: [{ id: 'x/y', bytes: 0, pruned: true }] }))
    const v = validateBuildManifest(m, { expectedContractVersion: 'host-contract/1', knownProfiles: KNOWN_PROFILES })
    expect(v.join('\n')).toContain('未写原因')
  })

  it('未知 profile ⇒ 违规（不猜）', () => {
    const m = buildManifest(baseInput({ profile: 'bogus' }))
    const v = validateBuildManifest(m, { expectedContractVersion: 'host-contract/1', knownProfiles: KNOWN_PROFILES })
    expect(v.join('\n')).toContain('不在已知 profile 集合内')
  })

  it('契约版本不同代 ⇒ 违规（产物与宿主契约必须同代）', () => {
    const m = buildManifest(baseInput({ contractVersion: 'host-contract/0' }))
    const v = validateBuildManifest(m, { expectedContractVersion: 'host-contract/1', knownProfiles: KNOWN_PROFILES })
    expect(v.join('\n')).toContain('不同代')
  })

  it('模块/资源 id 重复 ⇒ 违规（重复会让清单退化成多重集，无法对账）', () => {
    const m = buildManifest(
      baseInput({
        modules: [
          { id: 'a/b', bytes: 1 },
          { id: 'a/b', bytes: 2 },
        ],
      }),
    )
    // 注意：`buildManifest` 会排序但**不**去重 —— 去重会掩盖"输入本来就有重复"这一事实。
    const v = validateBuildManifest(m, { expectedContractVersion: 'host-contract/1', knownProfiles: KNOWN_PROFILES })
    expect(v.join('\n')).toContain('重复')
  })

  it('digest 形态非法 ⇒ 违规', () => {
    const m = buildManifest(
      baseInput({ assets: [{ path: 'x.js', bytes: 1, digest: 'md5:abc', role: 'chunk' }] }),
    )
    const v = validateBuildManifest(m, { expectedContractVersion: 'host-contract/1', knownProfiles: KNOWN_PROFILES })
    expect(v.join('\n')).toContain('digest 形态非法')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 五、摘要与投影（纯函数）
// ─────────────────────────────────────────────────────────────────────────────

describe('A34 manifest：摘要与投影是纯函数', () => {
  it('`digestBytes` 确定性 + 对字节敏感（改一个字节即变）', () => {
    const a = digestBytes(Uint8Array.from([1, 2, 3]))
    const b = digestBytes(Uint8Array.from([1, 2, 3]))
    const c = digestBytes(Uint8Array.from([1, 2, 4]))
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^fnv1a32:[0-9a-f]{8}$/)
  })

  it('`digestText` **先归一化 CRLF**（铁律 6：同一提交在不同检出上必须同摘要）', () => {
    const lf = 'line1\nline2\n'
    const crlf = 'line1\r\nline2\r\n'
    expect(digestText(crlf), 'CRLF 与 LF 必须得到同一摘要（否则 manifest 与提交无法对账）').toBe(digestText(lf))
    expect(digestText('line1\nline2\n')).not.toBe(digestText('line1\nline3\n'))
  })

  it('`projectModuleSet`：不在白名单里的模块标记 pruned 且**带原因**', () => {
    const entries = projectModuleSet(
      { 'domain/scene': 100, 'workbench/export/bundleMeshAssembly': 5000 },
      { included: ['domain/scene'], pruneReason: 'embed profile 不含导出器' },
    )
    const pruned = entries.find((e) => e.id === 'workbench/export/bundleMeshAssembly')
    expect(pruned?.pruned).toBe(true)
    expect(pruned?.bytes).toBe(0)
    expect(pruned?.pruneReason).toBe('embed profile 不含导出器')
    const kept = entries.find((e) => e.id === 'domain/scene')
    expect(kept?.pruned).toBe(false)
    expect(kept?.pruneReason).toBeUndefined()
  })

  it('`classifyAssetRole`：字体/样式/入口/分块分类与产物命名契约一致（B-01/B-04/B-05）', () => {
    expect(classifyAssetRole('bundled/StructureWorkbench.woff2')).toBe('font')
    expect(classifyAssetRole('bundled/JetBrainsMono-Regular-V6pRDFza.woff2')).toBe('font')
    expect(classifyAssetRole('bundled/StructureWorkbench.css')).toBe('style')
    expect(classifyAssetRole('bundled/StructureWorkbench.bundle.js')).toBe('entry')
    expect(classifyAssetRole('dist/StructureRender.js')).toBe('entry')
    expect(classifyAssetRole('index.html')).toBe('other')
    expect(classifyAssetRole('bundled/vendor-abc123.js')).toBe('chunk')
  })

  it('`projectAssetSet`：摘要由**字节**算出（不由调用方提供），路径归一为 `/`', () => {
    const assets = projectAssetSet({
      'bundled\\a.js': Uint8Array.from([1, 2, 3]),
      'bundled/b.woff2': Uint8Array.from([4, 5]),
    })
    expect(assets.map((a) => a.path)).toEqual(['bundled/a.js', 'bundled/b.woff2'])
    expect(assets[0].digest).toBe(digestBytes(Uint8Array.from([1, 2, 3])))
    expect(assets[0].role).toBe('chunk')
    expect(assets[1].role).toBe('font')
  })

  it('manifest **无自由扩展位**（防"顺手把整份 env dump 进去"）', () => {
    // 输入类型只有具名字段；运行时也不得因为输入多带了键而把它们带进输出。
    const extra = { ...baseInput(), token: 'should-not-appear', env: { SECRET: 'x' } } as BuildManifestInput
    const m = buildManifest(extra)
    const serialized = JSON.stringify(m)
    expect(serialized).not.toContain('should-not-appear')
    expect(serialized).not.toContain('"env"')
  })
})
