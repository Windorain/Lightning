/**
 * `adapters/host/buildManifest` —— **构建 manifest**（适配器实现端口：构建产物清单）。
 *
 * ## 契约原文要求
 *
 * > 构建后 manifest 记录 **profile、模块集合、源码版本与资源哈希**，**不包含凭据**。
 *
 * 四个字段各自回答一个具体问题，缺一个都会让 manifest 变成"看起来有信息"的装饰：
 *
 * | 字段 | 回答的问题 | 缺了会怎样 |
 * |---|---|---|
 * | `profile` | 这份产物是给哪个宿主用的？ | 拿着 embed 产物去当 wiki-workbench 排查 |
 * | `modules` | 这份产物里**实际**有哪些模块？ | 无法回答"某个能力为什么不在产物里"（查看器裁剪判据） |
 * | `sourceVersion` | 从哪个提交/契约版本构建的？ | 证据与提交无法对账（铁律 5 的同类问题） |
 * | `assets` | 每个产物文件的字节身份是什么？ | "上传的是不是这份产物"无法核验 |
 *
 * ## 「不包含凭据」为什么必须是**结构性**的而不是"注意不要写"
 *
 * 结构化诊断的同类要求（生产诊断默认最小信息、不记录令牌/会话凭据）在
 * `application/diagnostics.ts` 里已经用**键名脱敏 + 值截断**做成结构性的：
 * 脱敏发生在**写入时**，因此连缓冲区里都不存在敏感副本。
 *
 * 本模块采用同一口径，但**更严**：manifest 是一个会被**上传/打印/存档**的产物，
 * 它的凭据泄漏面比诊断记录更大。故：
 *
 *  1. **键名脱敏**（与 `sanitizeParams` 同一张正则，含 `token`/`secret`/`password`/
 *     `credential`/`apikey`/`authorization`/`cookie`/`session`）；
 *  2. **值形态脱敏**：即使键名无害（`note`/`description`/`url`），值里出现
 *     `Bearer …`、`token=…`、`://user:pass@host`、长 base64 式串时也要脱敏 ——
 *     键名正则挡不住"凭据被塞进描述字段"；
 *  3. **白名单结构**：manifest 的字段是**逐个具名**的，不存在
 *     `Record<string, unknown>` 式的自由扩展位 —— 于是"不小心把整个 env dump 进去"
 *     在类型层面不可表达。
 *
 * 第 3 条是"结构性的"这一说法的关键：前两条是**过滤**（总能被绕过），
 * 第 3 条是**不可表达**（`BuildManifestInput` 没有那个位置）。
 *
 * ## 哈希算法的诚实说明（**不得**冒充安全哈希）
 *
 * 本模块用 FNV-1a 32 位（与 `domain/identity.contentDigest` 同族，避免第二套口径）。
 * 它**不是**密码学哈希：碰撞可被构造，**不能**用于签名或对抗性完整性校验。
 * 它的用途是"两份产物是不是同一份"这一**身份/对账**问题。
 * ⇒ manifest 里显式写出 `digestAlgorithm: 'fnv1a32'`，让消费方知道其边界；
 * 若将来需要抗碰撞（例如发布校验），**必须**换算法并同步更新该字段 ——
 * 而不是悄悄换个实现、让消费方以为还是原来的强度。
 *
 * ## 纯性
 *
 * 无 import、无 IO、无时钟、无全局读取。字节与字符串由调用方读好后传入。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 脱敏（结构性）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 敏感的**键名**正则 —— 与 `application/diagnostics.ts:121` 的 `SECRET_KEY_RE` **同一张表**。
 *
 * 刻意复制而不是 import：`application/` 是内核层，`adapters/` 不应为了一个正则
 * 反向依赖它（适配器实现端口，不夹带业务规则；层不得反向依赖）。
 * 若哪天这张表要改，两处必须同步修改 —— `artifact-host.test.ts` 有一条断言
 * **逐字比对**两处正则源文本，防止漂移。
 */
export const SECRET_KEY_PATTERN = /(token|secret|password|passwd|credential|apikey|api_key|authorization|cookie|session)/i

/** 脱敏占位（固定文本；不泄漏原值长度）。与 `diagnostics.ts` 的 `REDACTED` 同形。 */
export const MANIFEST_REDACTED = '«redacted»'

/** 字符串字段的最大长度（防"整份文档/整段 env"经无害键名旁路进入 manifest）。 */
export const MANIFEST_VALUE_MAX = 240

/**
 * 敏感的**值形态**正则（键名无害但值里带凭据的情形）。
 *
 * 每一条都对应一种真实泄漏形态：
 *  - `Bearer <token>` —— HTTP 头被粘进描述；
 *  - `token=… / api_key=… / password=…` —— URL query 或 env 行被粘进来；
 *  - `://user:pass@host` —— 带凭据的 URL（本仓 remote URL 明令禁止内嵌账号/令牌）；
 *  - `ghp_… / gitea_… / glpat-…` 式前缀 token。
 *
 * ## 为什么最后一条的分隔符是 `[-_]` 而不是 `_`
 *
 * **实测教训**：初版写成 `\b(gh[pousr]|gitea|glpat)_[A-Za-z0-9_-]{12,}\b`，
 * 而 GitLab 的前缀是 **`glpat-`（连字符）**，于是 `glpat-abcdefghijklmnop`
 * **完全不匹配** ⇒ 原值直接进入 manifest。这条泄漏是被本文件的穷举负对照
 * （7 个字段 × 5 种形态）抓出来的，不是靠读代码看出来的。
 * ⇒ 前缀的**分隔符**必须同时接受 `_` 与 `-`；将来出现第三种分隔符时，
 *    对应的负对照会再次判红。
 */
export const SECRET_VALUE_PATTERNS: readonly RegExp[] = Object.freeze([
  /bearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /(token|secret|password|passwd|apikey|api_key|authorization)\s*[=:]\s*\S{6,}/i,
  /:\/\/[^/\s:@]+:[^/\s@]+@/,
  /\b(gh[pousr]|gitea|glpat)[-_][A-Za-z0-9_-]{12,}\b/,
])

/**
 * 脱敏一个字符串值（**纯**）。
 *
 * 顺序：先查值形态（命中即整值替换），再截断超长值。
 * 命中值形态时**不**做部分替换 —— 部分替换会留下"前缀 + 长度"这类可用于
 * 缩小搜索空间的信息，而 `«redacted»` 不留下任何东西（与 `sanitizeParams` 同口径）。
 */
export function sanitizeManifestString(value: string): string {
  for (const re of SECRET_VALUE_PATTERNS) {
    if (re.test(value)) return MANIFEST_REDACTED
  }
  return value.length > MANIFEST_VALUE_MAX ? `${value.slice(0, MANIFEST_VALUE_MAX)}…` : value
}

/** 脱敏一个具名条目（键名 + 值双重判定）。 */
export function sanitizeManifestEntry(key: string, value: string): string {
  if (SECRET_KEY_PATTERN.test(key)) return MANIFEST_REDACTED
  return sanitizeManifestString(value)
}

// ─────────────────────────────────────────────────────────────────────────────
// 输入结构（白名单；无自由扩展位）
// ─────────────────────────────────────────────────────────────────────────────

/** 一个模块的登记项（「查看器裁剪」想知道的就是这份清单）。 */
export interface ManifestModuleEntry {
  /** 模块 id（相对 `web/src/`，正斜杠，无扩展名）。 */
  readonly id: string
  /** 该模块在产物里的字节数（0 表示只有声明、没有代码）。 */
  readonly bytes: number
  /**
   * 该模块是否**被裁剪**（存在于源里但不在本 profile 的产物里）。
   * 与 `bytes === 0` 的区别：前者是"构建决策"，后者是"测量结果"。
   */
  readonly pruned?: boolean
  /** 裁剪原因（`pruned === true` 时必须非空 —— 见 `validateBuildManifest`）。 */
  readonly pruneReason?: string
}

/** 一个产物资源的哈希登记项。 */
export interface ManifestAssetEntry {
  /** 相对 `web/` 的产物路径（正斜杠）。 */
  readonly path: string
  /** 字节数。 */
  readonly bytes: number
  /** 内容摘要（算法见 `BuildManifest.digestAlgorithm`）。 */
  readonly digest: string
  /** 资源角色（判别"这个文件是不是字体/入口/CSS"）。 */
  readonly role: 'entry' | 'chunk' | 'style' | 'font' | 'other'
}

/**
 * manifest 的输入（**白名单结构**）。
 *
 * 与 `DiagnosticParams`（`Record<string, string|number|boolean>`）不同，这里是
 * **逐个具名字段**：多一个敏感字段就必须改这个类型，而改类型是**显式**动作，
 * 不会像 `Record<string, unknown>` 那样"顺手多塞一个"。
 *
 * ## `builder` 字段的用途与风险
 *
 * `builder` 记"谁构建的"（CI job 名 / 本地标识）。它**可能**被人塞进凭据
 * （例如"我在这里放了触发 URL"）⇒ 它走 `sanitizeManifestEntry`，
 * 键名（`builder`）不敏感但**值形态**会被查。这是值形态脱敏的**真实用途**，
 * 不是为了"更安全"而堆的规则。
 */
export interface BuildManifestInput {
  /** 构建 profile id（对应 `HostProfileSpec.id`）。 */
  readonly profile: string
  /** 宿主契约版本（`HOST_CONTRACT_VERSION`）。 */
  readonly contractVersion: string
  /**
   * 源码版本。
   *
   * 由**调用方**注入（`git rev-parse --short HEAD` 或 CI 提供的提交 SHA）——
   * 纯函数不读 `.git`（那是 IO，纯性纪律禁止）。
   */
  readonly sourceVersion: string
  /** 源码树的**脏**标记（工作树有未提交改动时 `true`）。证据对账靠它。 */
  readonly sourceDirty: boolean
  /** 模块集合。 */
  readonly modules: readonly ManifestModuleEntry[]
  /** 资源哈希。 */
  readonly assets: readonly ManifestAssetEntry[]
  /** 构建工具版本（`vite 6.4.2` / `esbuild …`）—— 影响 esbuild 常量折叠形态。 */
  readonly buildTools: Readonly<Record<string, string>>
  /** 构建者标识（可能含凭据 ⇒ 走值形态脱敏）。 */
  readonly builder?: string
  /** 备注（可能含凭据 ⇒ 走值形态脱敏）。 */
  readonly note?: string
}

/** manifest 的产物（**已脱敏**；可直接打印/上传）。 */
export interface BuildManifest {
  readonly manifestVersion: 'build-manifest/1'
  readonly profile: string
  readonly contractVersion: string
  readonly sourceVersion: string
  readonly sourceDirty: boolean
  /** 摘要算法（**显式**，见文件头"诚实说明"）。 */
  readonly digestAlgorithm: 'fnv1a32'
  /** 稳定排序的模块清单（排序保证两份 manifest 可逐字节对账）。 */
  readonly modules: readonly ManifestModuleEntry[]
  /** 稳定排序的资源清单。 */
  readonly assets: readonly ManifestAssetEntry[]
  readonly buildTools: Readonly<Record<string, string>>
  readonly builder?: string
  readonly note?: string
  /** 脱敏发生了多少次（>0 时消费方可见"这里本来有东西被拿掉了"）。 */
  readonly redactions: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 摘要
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 字节 → FNV-1a 32 位摘要（**纯**；与 `domain/identity.contentDigest` 同算法）。
 *
 * 对**字节**而不是字符串取摘要：产物是二进制（含真实控制字节），
 * 先转字符串再摘要会把"用哪个编码转"变成一个隐藏输入。
 */
export function digestBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5
  for (const b of bytes) {
    h ^= b & 0xff
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `fnv1a32:${(h >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * 文本 → 摘要。
 *
 * ## 铁律 6：先归一化行尾再摘要
 *
 * 本仓 `core.autocrlf=true` ⇒ 同一份源码在两台机器上可能读成 CRLF 或 LF。
 * 若摘要直接吃原始字节，**同一提交**会在不同检出上产生不同 manifest ——
 * 那时"manifest 与提交对账"就失效了（证据看起来像"产物不一致"，实际是检出差异）。
 * 故先把 CRLF 归一为 LF 再摘要，并把这个决定写在这里（而不是留给调用方"记得归一"）。
 */
export function digestText(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n')
  const bytes = new Uint8Array(normalized.length)
  for (let i = 0; i < normalized.length; i++) bytes[i] = normalized.charCodeAt(i) & 0xff
  return digestBytes(bytes)
}

// ─────────────────────────────────────────────────────────────────────────────
// 组装
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 组装构建 manifest（**纯**；脱敏在**写入时**完成）。
 *
 * 返回的 manifest 已经不含凭据：`redactions` 记录了几处被拿掉。
 * **不**提供"取回原值"的方法 —— 与 `DiagnosticsReadView` 同理：
 * 脱敏若可逆，就等于没脱敏（只是把凭据放到了另一个地方）。
 */
export function buildManifest(input: BuildManifestInput): BuildManifest {
  let redactions = 0
  const red = (key: string, value: string): string => {
    const out = sanitizeManifestEntry(key, value)
    if (out !== value) redactions++
    return out
  }

  const modules = [...input.modules]
    .map((m) => {
      const id = red('module', m.id)
      // 裁剪原因走**键名敏感 + 值形态**双查：原因文本里放 URL/凭据是常见事故。
      const reason = m.pruneReason === undefined ? undefined : red('pruneReason', m.pruneReason)
      const entry: ManifestModuleEntry = {
        id,
        bytes: m.bytes,
        ...(m.pruned === undefined ? {} : { pruned: m.pruned }),
        ...(reason === undefined ? {} : { pruneReason: reason }),
      }
      return entry
    })
    .sort((a, b) => a.id.localeCompare(b.id))

  const assets = [...input.assets]
    .map((a) => {
      const entry: ManifestAssetEntry = {
        path: red('path', a.path),
        bytes: a.bytes,
        digest: a.digest,
        role: a.role,
      }
      return entry
    })
    .sort((a, b) => a.path.localeCompare(b.path))

  const buildTools: Record<string, string> = {}
  for (const [k, v] of Object.entries(input.buildTools).sort(([a], [b]) => a.localeCompare(b))) {
    buildTools[k] = red(k, v)
  }

  const out: BuildManifest = {
    manifestVersion: 'build-manifest/1',
    profile: input.profile,
    contractVersion: red('contractVersion', input.contractVersion),
    sourceVersion: red('sourceVersion', input.sourceVersion),
    sourceDirty: input.sourceDirty,
    digestAlgorithm: 'fnv1a32',
    modules: Object.freeze(modules),
    assets: Object.freeze(assets),
    buildTools: Object.freeze(buildTools),
    ...(input.builder === undefined ? {} : { builder: red('builder', input.builder) }),
    ...(input.note === undefined ? {} : { note: red('note', input.note) }),
    redactions,
  }
  return Object.freeze(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// 校验
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 校验 manifest 的合规性（**纯**）。
 *
 * 规则：
 *  1. `profile` 必须是已知 profile（不猜）；
 *  2. `contractVersion` 必须等于 `expectedContractVersion`（构建产物与宿主契约必须同代）；
 *  3. 模块 id 与资源路径唯一（重复会让"清单"变成多重集，无法对账）；
 *  4. `pruned === true` ⇒ `pruneReason` 非空（裁剪**必须**有原因
 *     「可选落点被裁剪并记录原因」的同一条要求，在构建产物层面的对应物）；
 *  5. 资源 `digest` 形如 `fnv1a32:xxxxxxxx` 且 `bytes >= 0`；
 *  6. **脱敏后不得残留凭据**：把 manifest 序列化后再跑一遍值形态检查，
 *     命中即判违规。这条是宿主验收负对照（"把 token 塞进 manifest 输入 ⇒ 必须不出现原值"）
 *     的**判据本身** —— 它不依赖测试自己写的期望值，而是复用生产脱敏规则。
 */
export function validateBuildManifest(
  manifest: BuildManifest,
  options: { readonly expectedContractVersion: string; readonly knownProfiles: readonly string[] },
): readonly string[] {
  const out: string[] = []
  if (!options.knownProfiles.includes(manifest.profile)) {
    out.push(`profile ${manifest.profile} 不在已知 profile 集合内`)
  }
  if (manifest.contractVersion !== options.expectedContractVersion) {
    out.push(
      `contractVersion ${manifest.contractVersion} 与宿主契约 ${options.expectedContractVersion} 不同代`,
    )
  }
  const moduleIds = new Set<string>()
  for (const m of manifest.modules) {
    if (moduleIds.has(m.id)) out.push(`模块 id 重复：${m.id}`)
    moduleIds.add(m.id)
    if (m.pruned === true && (m.pruneReason ?? '').trim() === '') {
      out.push(`模块 ${m.id} 被裁剪但未写原因（裁剪必须记录原因）`)
    }
    if (m.bytes < 0) out.push(`模块 ${m.id} 的字节数为负`)
  }
  const assetPaths = new Set<string>()
  for (const a of manifest.assets) {
    if (assetPaths.has(a.path)) out.push(`资源路径重复：${a.path}`)
    assetPaths.add(a.path)
    if (!/^fnv1a32:[0-9a-f]{8}$/.test(a.digest)) out.push(`资源 ${a.path} 的 digest 形态非法：${a.digest}`)
    if (a.bytes < 0) out.push(`资源 ${a.path} 的字节数为负`)
  }
  const { hits } = scanForCredentials(manifest)
  for (const h of hits) out.push(`manifest 脱敏后仍含疑似凭据：${h}`)
  return Object.freeze(out)
}

/**
 * 在 manifest 的**全部字符串字段**上跑值形态检查（**纯**）。
 *
 * 返回命中的路径与形态名（**不**返回值本身 —— 报告里回显凭据等于又泄漏一次；
 * 这一点在 `diagnostics.ts` 的 `REDACTED` "不泄漏原值长度"同源）。
 */
export function scanForCredentials(manifest: BuildManifest): { readonly hits: readonly string[] } {
  const hits: string[] = []
  const check = (path: string, value: string): void => {
    for (const [i, re] of SECRET_VALUE_PATTERNS.entries()) {
      if (re.test(value)) hits.push(`${path}（形态 #${i}）`)
    }
    if (SECRET_KEY_PATTERN.test(value) && value !== MANIFEST_REDACTED && /[=:]/.test(value)) {
      hits.push(`${path}（键名式）`)
    }
  }
  check('profile', manifest.profile)
  check('contractVersion', manifest.contractVersion)
  check('sourceVersion', manifest.sourceVersion)
  if (manifest.builder !== undefined) check('builder', manifest.builder)
  if (manifest.note !== undefined) check('note', manifest.note)
  for (const [k, v] of Object.entries(manifest.buildTools)) check(`buildTools.${k}`, v)
  for (const m of manifest.modules) {
    check(`modules.${m.id}`, m.id)
    if (m.pruneReason !== undefined) check(`modules.${m.id}.pruneReason`, m.pruneReason)
  }
  for (const a of manifest.assets) check(`assets.${a.path}`, a.path)
  return Object.freeze({ hits: Object.freeze(hits) })
}

// ─────────────────────────────────────────────────────────────────────────────
// 从真实模块图/产物目录构造输入（接线层用；此处只给**纯**的投影辅助）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从"源文件字节数"表投影出模块清单（**纯**）。
 *
 * 输入是 `{ 模块 id → 源字节数 }`，以及本 profile 的模块 id 白名单。
 * 输出中**不在**白名单里的模块标记为 `pruned`（并带原因）。
 *
 * 为什么需要这个投影：查看器裁剪判据要求"内容编辑 handlers/操纵工具不在可达模块图"。
 * 那份可达模块图由**接线层**（构建插件 / Node 脚本）从真实 import 图算出；
 * 本函数只做"算出之后如何登记进 manifest"这一步，因此它可被纯测试覆盖。
 */
export function projectModuleSet(
  sourceByteCounts: Readonly<Record<string, number>>,
  options: { readonly included: readonly string[]; readonly pruneReason: string },
): readonly ManifestModuleEntry[] {
  const included = new Set(options.included)
  return Object.freeze(
    Object.entries(sourceByteCounts)
      .map(([id, bytes]): ManifestModuleEntry => {
        const isIn = included.has(id)
        return {
          id,
          bytes: isIn ? bytes : 0,
          pruned: !isIn,
          ...(isIn ? {} : { pruneReason: options.pruneReason }),
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id)),
  )
}

/**
 * 依据文件扩展名判定资源角色（**纯**；用于避免每个调用方各写一份分类）。
 *
 * `entry` 判定含"名字里带 index/StructureRender/StructureWorkbench"这一族 ——
 * 它是产物命名契约的机器可读形式，
 * 而不是"随便认几个名字"。
 */
export function classifyAssetRole(path: string): ManifestAssetEntry['role'] {
  const lower = path.toLowerCase()
  if (/\.(woff2?|ttf|otf|eot)$/.test(lower)) return 'font'
  if (lower.endsWith('.css')) return 'style'
  if (/(index|structurerender|structureworkbench)[^/]*\.js$/.test(lower)) return 'entry'
  if (lower.endsWith('.js')) return 'chunk'
  return 'other'
}

/** 从 `{路径 → 字节}` 表构造资源清单（**纯**；摘要由字节算出，不由调用方提供）。 */
export function projectAssetSet(
  assets: Readonly<Record<string, Uint8Array>>,
): readonly ManifestAssetEntry[] {
  return Object.freeze(
    Object.entries(assets)
      .map(([path, bytes]): ManifestAssetEntry => ({
        path: path.replace(/\\/g, '/'),
        bytes: bytes.length,
        digest: digestBytes(bytes),
        role: classifyAssetRole(path),
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  )
}
