/**
 * `adapters/host` —— **宿主能力矩阵与启动/销毁契约**（#249 §19.8；#260 A34 `artifact-host`）。
 *
 * ## 本文件解决什么问题
 *
 * #249 §19.8 原文要求：
 *
 * > profile 生成产物需要公开**启动/销毁接口、资源基址、版本和必需宿主能力**。
 * > 浏览器、WebGL、文件/剪贴板等支持范围形成**显式矩阵**；**可选能力缺失可降级并说明**，
 * > **核心必需能力缺失则启动失败**。**不能把类型编译通过当宿主支持证明**。
 *
 * 最后一句是本批必须落地的**负对照**：`TypeScript` 的类型只能证明"调用方按签名传参了"，
 * 它**不能**证明运行该产物的浏览器里有 `WebGL2RenderingContext`、有 `Blob`、有
 * `indexedDB`。那三件事只有**运行期探测**能证明。故本模块把二者分开：
 *
 * | 层 | 能证明什么 | 不能证明什么 |
 * |---|---|---|
 * | `HostProfileSpec`（本文件的静态声明） | 产物**声明**要什么能力 | 宿主**是否真有**这些能力 |
 * | `probeHostCapabilities(env)`（纯函数探测） | 某个宿主环境**实际**有哪些能力 | 该能力是否工作正常（只判存在与形状） |
 * | `assertHostRequirements(...)`（判定） | 必需缺失 ⇒ 启动失败；可选缺失 ⇒ 降级 | —— |
 *
 * ## 为什么是"显式矩阵"而不是 `if (window.X)` 散布在启动代码里
 *
 * 若探测散落在三个 entry 的启动路径上，就出现三种后果：
 *  1. 同一个能力在 A profile 判为必需、在 B profile 判为可选，**无人能一眼看出差异**；
 *  2. 缺能力时的行为退化成"某个组件静默不渲染"，而不是**结构化诊断**（§19.9）；
 *  3. A34 的验收无处下断言 —— 它只能去跑 e2e，而 #249 §14 明确"只测 dev server 不算"。
 *
 * ⇒ 矩阵必须是**数据**（可被测试逐条断言），判定必须是**纯函数**（可对任意宿主环境重放）。
 *
 * ## 本模块的纯性
 *
 * 不读 `window` / `navigator` / `document` 全局，不读时钟，不改输入。宿主环境以
 * `HostEnvironment` 值的形式**显式传入**（#249 §2.1：「需要时间、身份分配、能力、
 * 随机种子时，作为输入或状态传入」）。判定只取决于 `(profileSpec, capabilityReport)`
 * 这一对显式输入，因此 A34 可以在 Node 里对"假想的 Wiki 宿主"重放。
 *
 * 接线层（`entries/` 与 `runtime/host/*` 的既有实现）负责从真实全局采集环境并调用本模块。
 */

// ─────────────────────────────────────────────────────────────────────────────
// profile 身份
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 本仓的四个构建 profile（#249 §19.8「各 profile 产物」；B1 §A.3 B-01..B-12）。
 *
 * 与 `vite.*.config.ts` 一一对应，**不是**新造的分类：
 *
 * | profile | 配置文件 | 产物（B1 编号） |
 * |---|---|---|
 * | `workbench` | `vite.workbench.config.ts` | `dist-workbench/`（B-04） |
 * | `embed` | `vite.embed.config.ts` | `dist/StructureRender.js` + `.css`（B-01/B-02） |
 * | `wiki-workbench` | `vite.wiki-workbench.config.ts` | `dist-wiki-workbench/bundled/StructureWorkbench.bundle.js`（B-05） |
 * | `headless` | 无独立 config（宿主内嵌调用） | 无独立产物；工具的宿主无关内核 |
 *
 * `headless` 的存在理由：导出/批量处理只要内核，不要外壳。它不是"未来的空 profile"——
 * `runtime/exportJob.ts`（P9 同批）就是它的三个真实消费者之一（离屏渲染端口不依赖 DOM 外壳）。
 */
export type HostProfileId = 'workbench' | 'embed' | 'wiki-workbench' | 'headless'

/** 四个 profile 的稳定顺序（诊断与测试断言用；不随输入顺序变化）。 */
export const HOST_PROFILE_IDS: readonly HostProfileId[] = Object.freeze([
  'workbench',
  'embed',
  'wiki-workbench',
  'headless',
])

// ─────────────────────────────────────────────────────────────────────────────
// 宿主能力
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 宿主能力标识（**显式矩阵的行**）。
 *
 * 每一条都对应一段**真实代码路径**或**真实产物需求**，不是为凑矩阵而列：
 *
 * | 能力 | 谁需要它 |
 * |---|---|
 * | `dom` | 三个有外壳的 profile 都要挂载点（`index*.html` 的 `#app` / `#wsr-workbench-app`） |
 * | `webgl2` | 视口绘制（`presentation/` 的呈现装配；`WebGLRenderer` 需要 WebGL2 上下文） |
 * | `blob` | `downloadBlob()` 下载 ZIP/PNG/GIF（B1 F-38..F-41）；无 `Blob` 则导出**无产物** |
 * | `url.createObjectURL` | 同上——`Blob` 存在但没有可下载 URL 时，产物仍到不了磁盘 |
 * | `atob` | B-21 ZIP 补丁产物里的 `atob('UEsDBA==')` 表达式**求值**需要它（`jszip` 签名注入） |
 * | `textEncoder` | `pako` gzip 的 UTF-8 编码路径（`buildEnvelopePackage`） |
 * | `indexedDB` | 恢复副本（A31）；缺失 ⇒ 该能力降级为"不提供自动恢复"，**不阻塞编辑** |
 * | `clipboard` | 复制 JSON/文本（`copyTextToClipboard`）；缺失 ⇒ 降级为提示用户手工复制 |
 * | `fileSystemAccess` | 宿主提供的"另存为"直写通道；缺失 ⇒ 降级为浏览器下载 |
 *
 * ## 为什么 `atob` 被单列成能力
 *
 * 它是**唯一**由构建后处理（JSZip 控制字符补丁，B-21/T-01..T-06）**新引入**的运行时依赖。
 * 若把这个依赖藏在"反正浏览器都有 `atob`"的假设里，那么补丁的**前置条件**就不可测：
 * 换了宿主（例如某些嵌入式 JS 引擎或非浏览器宿主）之后，产物会在**第一次导出**时才炸，
 * 而构建与类型检查全绿。单列之后，`assertHostRequirements` 会在**启动时**就给出诊断。
 */
export type HostCapabilityId =
  | 'dom'
  | 'webgl2'
  | 'blob'
  | 'url.createObjectURL'
  | 'atob'
  | 'textEncoder'
  | 'indexedDB'
  | 'clipboard'
  | 'fileSystemAccess'

/** 全部能力标识（稳定顺序；供"矩阵不得有拼错的键"这类断言使用）。 */
export const HOST_CAPABILITY_IDS: readonly HostCapabilityId[] = Object.freeze([
  'dom',
  'webgl2',
  'blob',
  'url.createObjectURL',
  'atob',
  'textEncoder',
  'indexedDB',
  'clipboard',
  'fileSystemAccess',
])

/**
 * 能力缺失时的处置。
 *
 * - `required`：**启动失败**（结构化诊断）。不是"渲染少一块"，而是这个产物在缺它的宿主上
 *   **没有意义**——例如无 `webgl2` 时视口画不出来，用户面对的是一个空框。
 * - `optional`：**显式降级**，降级说明必须能说清"用户会失去什么"，而不是一句"不支持"。
 */
export type CapabilityRequirement = 'required' | 'optional'

/** 某 profile 对某能力的声明。 */
export interface CapabilityDeclaration {
  readonly id: HostCapabilityId
  readonly requirement: CapabilityRequirement
  /**
   * 该能力被哪个**具体代码路径**需要（证据指针，供复核者直查）。
   * 空字符串是**非法**的：无证据指针的声明无法核对，等同"我说需要就需要"。
   */
  readonly because: string
  /**
   * 可选能力缺失时的降级说明（`optional` 必填；`required` 必须缺席）。
   *
   * 强制它非空是为了堵住 §19.8 里的「可选能力缺失可降级并说明」被简化为"忽略"：
   * 只有把"失去什么"写下来，降级才是**显式**的。
   */
  readonly degradation?: string
}

/**
 * 资源基址规则（#249 §19.8「资源基址」；B1 B-07）。
 *
 * 三个有产物的 profile 都必须是**相对基址**（`base: './'`）：它们的产物都从**非站点根**
 * 路径加载（Wiki 零件页、mod JAR 内 `assets/lightning/web/`）——绝对基址会 404。
 * 故这里不是"记一个字符串"，而是把"为什么必须相对"写成可断言的结构。
 */
export interface ResourceBaseRule {
  /** 构建配置里的 `base` 值。 */
  readonly buildBase: './' | '/'
  /**
   * 运行时基址来源。
   *
   * - `'document-base'`：由宿主页面的 URL 决定（`<script src>` 所在目录）——Wiki 与 mod 内嵌。
   * - `'explicit'`：由调用方显式传入（headless 工具链）。
   */
  readonly runtimeOrigin: 'document-base' | 'explicit'
  /**
   * 产物内资源引用的形态（B1 B-05 实测：wiki bundle 的 CSS 用 `url(./StructureWorkbench.woff2)`）。
   * `'relative'` 表示引用相对于产物自身目录；`'none'` 表示该 profile 不产出外链资源。
   */
  readonly assetReference: 'relative' | 'none'
  /** 该规则为何成立（含实测/契约指针）。 */
  readonly because: string
}

/** 一个 profile 的对外契约（A34 逐条断言的对象）。 */
export interface HostProfileSpec {
  readonly id: HostProfileId
  /**
   * 产物版本。与 package.json 的 `version` **不是**同一个东西——后者是 npm 包版本，
   * 前者是"这份产物按哪个宿主契约构建"。本批统一为契约版本，由 `HOST_CONTRACT_VERSION` 给出。
   */
  readonly artifactVersion: string
  /** 构建产物路径（相对 `web/`）；`headless` 为空数组（无独立产物）。 */
  readonly artifacts: readonly string[]
  /** 公开的**启动**入口名（宿主页面/调用方唯一应当使用的符号）。 */
  readonly startEntry: string
  /** 启动入口所在模块（相对 `web/`）。 */
  readonly startModule: string
  /**
   * 公开的**销毁**入口。
   *
   * `null` 表示**本 profile 当前没有公开销毁入口** —— 这不是"漏写"，而是必须显式登记的
   * 缺口（见 `HostProfileSpec.lifecycleGap`）。用 `null` 而不是一个空字符串，
   * 是为了让"忘了填"在类型层面不可表达。
   */
  readonly destroyEntry: string | null
  /** `destroyEntry === null` 时必须写明的缺口说明与归属（`destroyEntry !== null` 时必须缺席）。 */
  readonly lifecycleGap?: string
  /** 资源基址规则。 */
  readonly resourceBase: ResourceBaseRule
  /** 宿主能力声明（每个 profile 至少一条**必需**）。 */
  readonly capabilities: readonly CapabilityDeclaration[]
  /**
   * 该 profile **不做**的事（负面清单）。
   *
   * 为什么它属于契约：A34 的判据之一是"各 profile 经宿主传输变换后加载"。
   * 若一个 profile 不被声明"不做 ZIP"，那么"它的产物里有没有 ZIP 签名"就成了
   * 一个**碰运气**的问题（B1 T-06 的不对称正是这种问题的实例）。
   * 写进负面清单后，T-06 的判据变成可执行的：**产物扫描必须与该清单一致**。
   */
  readonly notCapableOf: readonly string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// 宿主环境与探测（纯）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 宿主环境描述（**显式输入**，非全局读取）。
 *
 * 字段故意都是"布尔或缺失"，而不是直接塞 `window` 对象：这样
 *  - 探测结果可序列化（能进诊断、能写进 A34 证据）；
 *  - 判定是纯函数（同一个环境描述恒得同一个判定）；
 *  - 测试可以构造"Wiki 宿主"「无 indexedDB 的受限宿主」等**真实存在的**宿主形态。
 */
export interface HostEnvironment {
  /** 是否存在 DOM 挂载点能力（`document.querySelector` 可用）。 */
  readonly hasDom: boolean
  /** `WebGL2RenderingContext` 是否存在（**不**尝试创建上下文——那需要真实 GPU）。 */
  readonly hasWebGL2: boolean
  /** `Blob` 构造器是否存在。 */
  readonly hasBlob: boolean
  /** `URL.createObjectURL` 是否存在。 */
  readonly hasCreateObjectURL: boolean
  /** `atob` 全局函数是否存在。 */
  readonly hasAtob: boolean
  /** `TextEncoder` 是否存在。 */
  readonly hasTextEncoder: boolean
  /** `indexedDB` 是否存在。 */
  readonly hasIndexedDB: boolean
  /** `navigator.clipboard` 是否存在。 */
  readonly hasClipboard: boolean
  /** 宿主提供的文件直写通道是否存在。 */
  readonly hasFileSystemAccess: boolean
}

/** 全部能力都缺席的宿主（A34 的**负对照基线**：必需缺失必须判红）。 */
export const BARE_HOST_ENVIRONMENT: HostEnvironment = Object.freeze({
  hasDom: false,
  hasWebGL2: false,
  hasBlob: false,
  hasCreateObjectURL: false,
  hasAtob: false,
  hasTextEncoder: false,
  hasIndexedDB: false,
  hasClipboard: false,
  hasFileSystemAccess: false,
})

/**
 * 能力探测结果（逐能力"有/无"）。
 *
 * 用 `Record<HostCapabilityId, boolean>` 而不是一个 `Set<string>`：前者在类型层面
 * 保证**每条能力都被回答过**——`Set` 里"没探测"与"探测为无"不可区分。
 */
export type HostCapabilityReport = Readonly<Record<HostCapabilityId, boolean>>

/**
 * 把宿主环境描述投影成能力报告（**纯函数**）。
 *
 * ## 为什么"存在性"就是本函数能证明的全部
 *
 * `hasWebGL2` 只回答"这个全局构造器在不在"。它**不**回答"能不能真的创建一个上下文"
 * （那需要 GPU/驱动，且会带来副作用）。这个边界必须写清，否则矩阵会冒充比它实际更多的保证：
 * 本函数的输出语义是「**能力位可用**」，不是「**能力可用且工作正常**」。
 * 后者属于 A34 的运行时加载验收（真实浏览器里真的导出一次 ZIP），不在本纯函数内。
 */
export function probeHostCapabilities(env: HostEnvironment): HostCapabilityReport {
  return Object.freeze({
    dom: env.hasDom,
    webgl2: env.hasWebGL2,
    blob: env.hasBlob,
    'url.createObjectURL': env.hasCreateObjectURL,
    atob: env.hasAtob,
    textEncoder: env.hasTextEncoder,
    indexedDB: env.hasIndexedDB,
    clipboard: env.hasClipboard,
    fileSystemAccess: env.hasFileSystemAccess,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 判定
// ─────────────────────────────────────────────────────────────────────────────

/** 一条降级记录（可选能力缺失的**显式**后果）。 */
export interface HostDegradation {
  readonly capability: HostCapabilityId
  /** 用户会失去什么（来自 `CapabilityDeclaration.degradation`，不是运行时拼的文案）。 */
  readonly effect: string
}

/** 一条缺失的必需能力。 */
export interface HostMissingRequirement {
  readonly capability: HostCapabilityId
  /** 需要它的代码路径（来自 `because`）。 */
  readonly because: string
}

/** 必须由宿主提供的诊断码（稳定、语言无关 —— #249 §19.7）。 */
export type HostDiagnosticCode =
  | 'HostCapabilityMissing'
  | 'HostProfileUnknown'
  | 'HostArtifactVersionMismatch'

/** 结构化诊断项（与 `application/diagnostics` 的"类型化原因"同口径）。 */
export interface HostDiagnostic {
  readonly code: HostDiagnosticCode
  readonly profile: string
  readonly params: Readonly<Record<string, string | number>>
}

/** 启动许可判定结果（三态，**不是** `boolean`）。 */
export type HostLaunchDecision =
  | {
      readonly status: 'launchable'
      readonly profile: HostProfileId
      /** 已降级的可选能力（可能为空）。 */
      readonly degradations: readonly HostDegradation[]
      /** 可选缺失**不**产生诊断（它是设计内的降级）；但会把事实留在 `degradations` 里。 */
      readonly diagnostics: readonly HostDiagnostic[]
    }
  | {
      readonly status: 'blocked'
      readonly profile: HostProfileId
      readonly missing: readonly HostMissingRequirement[]
      readonly diagnostics: readonly HostDiagnostic[]
    }
  | {
      readonly status: 'unknown-profile'
      readonly profile: string
      readonly diagnostics: readonly HostDiagnostic[]
    }

/**
 * 判定某 profile 在某宿主环境下能否启动（**纯函数**）。
 *
 * ## 语义（#249 §19.8 逐字落地）
 *
 *  - **必需能力缺失 ⇒ 启动失败**（`status: 'blocked'`），且失败是**结构化诊断**：
 *    带稳定码 `HostCapabilityMissing` + 逐条缺失能力及其代码路径。
 *  - **可选能力缺失 ⇒ 显式降级并说明**（`degradations`）：启动**继续**，
 *    但调用方拿到"失去了什么"的清单，而不是静默。
 *  - 未知 profile ⇒ `unknown-profile`（不猜、不退化成默认 profile）。
 *
 * ## 为什么返回三态而不是 `Result<void>`
 *
 * `unknown-profile` 与 `blocked` 的**处置不同**：前者是**调用方拼错了 profile 名**
 * （编程错误，应当修代码），后者是**宿主环境不满足**（部署问题，应当换宿主或降级）。
 * 合并成一个 `false` 会让两者的诊断混在一起，运维看不出该改哪一边。
 * 这也符合契约 §3.2 的口径：错误是**值**，且不同码对应不同恢复策略。
 */
export function assertHostRequirements(
  spec: HostProfileSpec | undefined,
  report: HostCapabilityReport,
  options: { readonly requestedProfile: string; readonly artifactVersion?: string },
): HostLaunchDecision {
  if (spec === undefined) {
    return Object.freeze({
      status: 'unknown-profile',
      profile: options.requestedProfile,
      diagnostics: Object.freeze([
        Object.freeze({
          code: 'HostProfileUnknown' as const,
          profile: options.requestedProfile,
          params: Object.freeze({ requested: options.requestedProfile }),
        }),
      ]),
    })
  }

  const diagnostics: HostDiagnostic[] = []
  const missing: HostMissingRequirement[] = []
  const degradations: HostDegradation[] = []

  for (const decl of spec.capabilities) {
    const present = report[decl.id] === true
    if (present) continue
    if (decl.requirement === 'required') {
      missing.push(Object.freeze({ capability: decl.id, because: decl.because }))
    } else {
      // `degradation` 由 `validateHostProfileSpec` 保证存在；这里只在它缺席时兜底，
      // 且兜底文本**不**是"不支持"这类空话 —— 它指明"未登记后果"这一事实本身。
      degradations.push(
        Object.freeze({
          capability: decl.id,
          effect: decl.degradation ?? '未登记降级后果（profile 声明不合规）',
        }),
      )
    }
  }

  if (options.artifactVersion !== undefined && options.artifactVersion !== spec.artifactVersion) {
    diagnostics.push(
      Object.freeze({
        code: 'HostArtifactVersionMismatch' as const,
        profile: spec.id,
        params: Object.freeze({ expected: spec.artifactVersion, actual: options.artifactVersion }),
      }),
    )
  }

  if (missing.length > 0) {
    for (const m of missing) {
      diagnostics.push(
        Object.freeze({
          code: 'HostCapabilityMissing' as const,
          profile: spec.id,
          params: Object.freeze({ capability: m.capability, because: m.because }),
        }),
      )
    }
    return Object.freeze({
      status: 'blocked',
      profile: spec.id,
      missing: Object.freeze(missing),
      diagnostics: Object.freeze(diagnostics),
    })
  }

  return Object.freeze({
    status: 'launchable',
    profile: spec.id,
    degradations: Object.freeze(degradations),
    diagnostics: Object.freeze(diagnostics),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 契约版本与校验
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 宿主契约版本（产物版本）。
 *
 * 为什么不用 `package.json` 的 `version`：那个值现在是 `0.0.0`（见 B1 与 package.json），
 * 它对"宿主该提供什么"**零信息**。改用它会让"产物版本"退化成"随便一个字符串"。
 * 本版本号在**宿主契约变化时**递增（新增必需能力、改动启动/销毁入口、改动基址规则）。
 */
export const HOST_CONTRACT_VERSION = 'host-contract/1'

/** 一条声明不合规的事实（供测试与诊断报告）。 */
export interface HostSpecViolation {
  readonly profile: string
  readonly rule: string
  readonly detail: string
}

/**
 * 校验 profile 声明集合自身的合规性（**纯函数**）。
 *
 * 这些规则是矩阵能当"契约"用的前提；不校验它们，矩阵就只是四个对象字面量。
 *
 * 规则：
 *  1. 四个 profile 齐备，无重复、无多余；
 *  2. 每个 profile **至少一条必需能力**（全是可选 ⇒ "必需能力缺失则启动失败"永不触发，
 *     该 profile 的强约束面为 0 —— 这正是 A34 要防的"空洞真"）；
 *  3. 每条 `because` 非空（无证据指针的声明不可核对）；
 *  4. `optional` 必须有 `degradation`；`required` **不得**有（有则语义矛盾）；
 *  5. 同一 profile 内能力 id 不重复（重复会让"最后一条胜出"，即隐藏覆盖）；
 *  6. `destroyEntry === null` ⇔ `lifecycleGap` 存在；
 *  7. 有产物的 profile 必须 `buildBase === './'`（B1 B-07：非站点根加载）；
 *  8. `artifacts` 非空 ⇔ profile 不是 `headless`。
 */
export function validateHostProfileSpec(specs: readonly HostProfileSpec[]): readonly HostSpecViolation[] {
  const out: HostSpecViolation[] = []
  const seen = new Set<string>()
  for (const s of specs) {
    if (seen.has(s.id)) out.push({ profile: s.id, rule: 'unique-id', detail: 'duplicate profile id' })
    seen.add(s.id)
  }
  for (const id of HOST_PROFILE_IDS) {
    if (!seen.has(id)) out.push({ profile: id, rule: 'complete-set', detail: 'missing profile declaration' })
  }
  for (const id of seen) {
    if (!(HOST_PROFILE_IDS as readonly string[]).includes(id)) {
      out.push({ profile: id, rule: 'complete-set', detail: '未在 HOST_PROFILE_IDS 中登记的 profile' })
    }
  }

  for (const s of specs) {
    if (s.artifactVersion !== HOST_CONTRACT_VERSION) {
      out.push({ profile: s.id, rule: 'artifact-version', detail: `产物版本必须是 ${HOST_CONTRACT_VERSION}` })
    }
    if (s.startEntry.trim() === '' || s.startModule.trim() === '') {
      out.push({ profile: s.id, rule: 'start-entry', detail: '启动入口名与模块都必须非空' })
    }
    const hasDestroy = s.destroyEntry !== null && s.destroyEntry.trim() !== ''
    if (hasDestroy && s.lifecycleGap !== undefined) {
      out.push({ profile: s.id, rule: 'lifecycle-gap', detail: '有销毁入口时不得再写缺口说明' })
    }
    if (!hasDestroy && (s.lifecycleGap ?? '').trim() === '') {
      out.push({ profile: s.id, rule: 'lifecycle-gap', detail: '无销毁入口必须写明缺口与归属' })
    }
    const requiredCount = s.capabilities.filter((c) => c.requirement === 'required').length
    if (requiredCount === 0) {
      out.push({
        profile: s.id,
        rule: 'at-least-one-required',
        detail: '至少一条必需能力（否则"必需缺失则启动失败"永不触发，强约束面为 0）',
      })
    }
    const ids = new Set<string>()
    for (const c of s.capabilities) {
      if (ids.has(c.id)) {
        out.push({ profile: s.id, rule: 'unique-capability', detail: `能力 ${c.id} 重复声明（后者会隐藏覆盖前者）` })
      }
      ids.add(c.id)
      if (c.because.trim() === '') {
        out.push({ profile: s.id, rule: 'capability-evidence', detail: `能力 ${c.id} 缺 because（无法核对）` })
      }
      if (c.requirement === 'optional' && (c.degradation ?? '').trim() === '') {
        out.push({ profile: s.id, rule: 'optional-degradation', detail: `可选能力 ${c.id} 必须写明降级后果` })
      }
      if (c.requirement === 'required' && c.degradation !== undefined) {
        out.push({ profile: s.id, rule: 'required-no-degradation', detail: `必需能力 ${c.id} 不得声明降级后果` })
      }
    }
    const expectsArtifacts = s.id !== 'headless'
    if (expectsArtifacts && s.artifacts.length === 0) {
      out.push({ profile: s.id, rule: 'artifacts-nonempty', detail: '有产物的 profile 必须登记产物路径' })
    }
    if (!expectsArtifacts && s.artifacts.length > 0) {
      out.push({ profile: s.id, rule: 'artifacts-nonempty', detail: 'headless 无独立产物，不得登记产物路径' })
    }
    if (expectsArtifacts && s.resourceBase.buildBase !== './') {
      out.push({
        profile: s.id,
        rule: 'relative-base',
        detail: '产物从非站点根加载（B1 B-07），base 必须为 ./',
      })
    }
    if ((s.lifecycleGap ?? '').includes('待定') || (s.lifecycleGap ?? '').includes('TODO')) {
      out.push({ profile: s.id, rule: 'lifecycle-gap-substantive', detail: '缺口说明不得是空话，必须点名归属批次' })
    }
  }
  return Object.freeze(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// 四个 profile 的声明（矩阵本体）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 资源基址规则 —— 三个有产物的 profile 共用同一条（B1 B-07 两处 `base: './'` 实测）。
 *
 * 之所以能共用是**实测结论**，不是假设：见 A34 证据文件里 `wiki-nopatch/index-wiki-workbench.html`
 * 与 workbench `index-workbench.html` 的产物内引用均为 `./bundled/...`。
 */
const RELATIVE_BASE_WITH_ASSETS: ResourceBaseRule = Object.freeze({
  buildBase: './',
  runtimeOrigin: 'document-base',
  assetReference: 'relative',
  because:
    'B1 B-07：Wiki 零件页与 mod JAR 内嵌（assets/lightning/web/）都在非站点根路径加载产物；' +
    '绝对基址会 404。A34 实测产物 HTML 内引用为 ./bundled/...（见 temp/p09 证据）',
})

/** 某能力在**所有** profile 下的公共需求（避免四份重复文字漂移）。 */
const CAP: Readonly<Record<HostCapabilityId, { readonly because: string; readonly degradation?: string }>> =
  Object.freeze({
    dom: { because: '三个外壳 profile 都要挂载点（index*.html 的 #app / #wsr-workbench-app）' },
    webgl2: { because: '视口绘制需要 WebGL2 上下文（presentation/ 的呈现装配）' },
    blob: { because: 'exportOperators 的 downloadBlob 用 Blob 承载 ZIP/PNG/GIF 产物（B1 F-38..F-41）' },
    'url.createObjectURL': {
      because: 'downloadBlob 把 Blob 变成可下载 URL；只有 Blob 而无它时产物仍到不了磁盘',
    },
    atob: {
      because:
        'B-21 补丁后的产物含 atob(\'UEsDBA==\') 等表达式（替换 JSZip 的 C0 控制字符签名）；' +
        '缺 atob 则第一次导出 ZIP 时炸，而构建与类型检查全绿',
    },
    textEncoder: { because: 'pako gzip 的 UTF-8 编码路径（buildEnvelopePackage）' },
    indexedDB: {
      because: 'A31 恢复副本的宿主存储实现（adapters/storage）',
      degradation: '不提供自动恢复副本：崩溃/刷新后未保存修改丢失，手动保存不受影响',
    },
    clipboard: {
      because: 'copyTextToClipboard（复制 Plain/Envelope JSON 文本）',
      degradation: '复制按钮不可用：改为提示用户在文本框中手工选取复制',
    },
    fileSystemAccess: {
      because: '宿主文件直写通道（另存为）',
      degradation: '改用浏览器下载（Blob + a[download]）落盘',
    },
  })

/**
 * 四个 profile 的对外契约矩阵（**本批交付的核心数据**）。
 *
 * ## 必需 vs 可选的划界依据
 *
 * 判据只有一条：**缺了它，这个 profile 的核心用途是否还成立**。
 *  - `workbench`：无 `webgl2` ⇒ 视口是空框 ⇒ 工作台**不是工作台**，故必需。
 *    无 `indexedDB` ⇒ 只是没有自动恢复，编辑与保存照常 ⇒ 可选。
 *  - `embed`：它的全部用途是"在 Wiki 页面里画出来"。无 `dom`（找不到挂载点）或
 *    无 `webgl2` ⇒ 什么都不显示 ⇒ **必需**。它**不做**导出（见 `notCapableOf`），
 *    故 `blob` / `url.createObjectURL` 对它**不是必需**——这正是 T-06 的静态依据。
 *  - `wiki-workbench`：`workbench` 的超集加发布能力 ⇒ 导出链必需，故 `blob`、
 *    `url.createObjectURL`、`atob` 全部**必需**（补丁后的 ZIP 生成依赖 `atob`）。
 *  - `headless`：无外壳（`dom` 不是必需）、无下载（`blob` 不是必需）；但要读文件字节
 *    （`blob` 用于内部构造? 不——它用 `Uint8Array`），故只要求 `atob`（ZIP 写出路径同源）
 *    与 `textEncoder`。
 */
export const HOST_PROFILE_SPECS: readonly HostProfileSpec[] = Object.freeze([
  Object.freeze<HostProfileSpec>({
    id: 'workbench',
    artifactVersion: HOST_CONTRACT_VERSION,
    artifacts: ['dist-workbench/index.html', 'dist-workbench/bundled/'],
    startEntry: 'createWorkbenchHost',
    startModule: 'web/src/runtime/host/workbenchHost.ts',
    destroyEntry: 'WorkbenchHost.destroy',
    resourceBase: RELATIVE_BASE_WITH_ASSETS,
    capabilities: Object.freeze([
      Object.freeze({ id: 'dom', requirement: 'required', ...CAP.dom }),
      Object.freeze({ id: 'webgl2', requirement: 'required', ...CAP.webgl2 }),
      Object.freeze({ id: 'blob', requirement: 'required', ...CAP.blob }),
      Object.freeze({ id: 'url.createObjectURL', requirement: 'required', ...CAP['url.createObjectURL'] }),
      Object.freeze({ id: 'atob', requirement: 'required', ...CAP.atob }),
      Object.freeze({ id: 'textEncoder', requirement: 'required', ...CAP.textEncoder }),
      Object.freeze({ id: 'indexedDB', requirement: 'optional', ...CAP.indexedDB }),
      Object.freeze({ id: 'clipboard', requirement: 'optional', ...CAP.clipboard }),
      Object.freeze({ id: 'fileSystemAccess', requirement: 'optional', ...CAP.fileSystemAccess }),
    ]),
    notCapableOf: Object.freeze(['wiki-publish（发布到灰机）——那是 wiki-workbench 的能力']),
  }),
  Object.freeze<HostProfileSpec>({
    id: 'embed',
    artifactVersion: HOST_CONTRACT_VERSION,
    artifacts: ['dist/StructureRender.js', 'dist/StructureRender.css'],
    startEntry: 'LightningEmbed.mount',
    startModule: 'web/src/main.ts',
    // 库形态：调用方自己持有 Vue app；本产物**不**公开 unmount。
    destroyEntry: null,
    lifecycleGap:
      'embed 是 IIFE 库，mount() 内部 createApp(...).mount(el) 的 app 句柄未返回给调用方 ⇒ ' +
      '调用方无法销毁（重复 mount 会叠挂 Vue 实例，P6/P10 的「同页多实例及销毁」需要它）。' +
      '归属：P6（#257）Area 生命周期 + P10（#261）生产接线；本批只登记为缺口，不伪造一个销毁接口。',
    resourceBase: RELATIVE_BASE_WITH_ASSETS,
    capabilities: Object.freeze([
      Object.freeze({ id: 'dom', requirement: 'required', ...CAP.dom }),
      Object.freeze({ id: 'webgl2', requirement: 'required', ...CAP.webgl2 }),
      Object.freeze({ id: 'textEncoder', requirement: 'required', ...CAP.textEncoder }),
      Object.freeze({ id: 'clipboard', requirement: 'optional', ...CAP.clipboard }),
      Object.freeze({ id: 'fileSystemAccess', requirement: 'optional', ...CAP.fileSystemAccess }),
    ]),
    notCapableOf: Object.freeze([
      // T-06 的显式决策（见 artifactTransport.ts 的 T06_DECISION）
      'zip-export（OBJ/MTL ZIP）——实测 dist/StructureRender.js 不含 JSZip 签名，B1 T-06 据此登记为"暂无实际影响的不对称"',
      'gif-export（GIF89a）——实测产物不含 GIF89a 字面量',
      'isometric-png-export',
      'wiki-publish',
    ]),
  }),
  Object.freeze<HostProfileSpec>({
    id: 'wiki-workbench',
    artifactVersion: HOST_CONTRACT_VERSION,
    artifacts: [
      'dist-wiki-workbench/bundled/StructureWorkbench.bundle.js',
      'dist-wiki-workbench/bundled/StructureWorkbench.css',
      'dist-wiki-workbench/index.html',
    ],
    startEntry: 'bootWikiWorkbench',
    startModule: 'web/src/runtime/host/wikiWorkbenchBoot.ts',
    destroyEntry: 'WorkbenchHost.destroy',
    resourceBase: RELATIVE_BASE_WITH_ASSETS,
    capabilities: Object.freeze([
      Object.freeze({ id: 'dom', requirement: 'required', ...CAP.dom }),
      Object.freeze({ id: 'webgl2', requirement: 'required', ...CAP.webgl2 }),
      Object.freeze({ id: 'blob', requirement: 'required', ...CAP.blob }),
      Object.freeze({ id: 'url.createObjectURL', requirement: 'required', ...CAP['url.createObjectURL'] }),
      Object.freeze({ id: 'atob', requirement: 'required', ...CAP.atob }),
      Object.freeze({ id: 'textEncoder', requirement: 'required', ...CAP.textEncoder }),
      Object.freeze({ id: 'indexedDB', requirement: 'optional', ...CAP.indexedDB }),
      Object.freeze({ id: 'clipboard', requirement: 'optional', ...CAP.clipboard }),
      Object.freeze({ id: 'fileSystemAccess', requirement: 'optional', ...CAP.fileSystemAccess }),
    ]),
    notCapableOf: Object.freeze([]),
  }),
  Object.freeze<HostProfileSpec>({
    id: 'headless',
    artifactVersion: HOST_CONTRACT_VERSION,
    artifacts: Object.freeze([]),
    startEntry: 'ExportJob.run',
    startModule: 'web/src/runtime/exportJob.ts',
    destroyEntry: 'ExportJob.cancel',
    resourceBase: Object.freeze({
      buildBase: './',
      runtimeOrigin: 'explicit',
      assetReference: 'none',
      because: '无产物；资源基址由调用方显式传入（工具链自己决定去哪读纹理/产物）',
    }),
    capabilities: Object.freeze([
      Object.freeze({ id: 'atob', requirement: 'required', ...CAP.atob }),
      Object.freeze({ id: 'textEncoder', requirement: 'required', ...CAP.textEncoder }),
      Object.freeze({
        id: 'blob',
        requirement: 'optional',
        because: '工具链可以把产物交给宿主下载（`File`/`Blob`），但不是必需 —— 也可回写文件系统',
        degradation: '无法直接构造 Blob 产物：改为把 Uint8Array 交给调用方自己落盘',
      }),
      Object.freeze({ id: 'clipboard', requirement: 'optional', ...CAP.clipboard }),
    ]),
    notCapableOf: Object.freeze([
      'dom-shell（无外壳；不挂载 index*.html）',
      'interactive-viewport（无实时视口；离屏渲染端口只给固定帧）',
      'wiki-publish',
    ]),
  }),
])

/** 按 id 取声明（找不到返回 `undefined`，由 `assertHostRequirements` 转成结构化诊断）。 */
export function hostProfileSpec(id: string): HostProfileSpec | undefined {
  return HOST_PROFILE_SPECS.find((s) => s.id === id)
}

// ─────────────────────────────────────────────────────────────────────────────
// 启动/销毁会话（接线层用；本模块只提供**可判定**的骨架）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一次启动会话的公开面（宿主唯一应当持有的句柄）。
 *
 * ## 为什么 `destroy` 是**幂等**且必须显式返回结局
 *
 * A34 判据之一是"**同页多实例及销毁**"。若 `destroy` 不幂等，宿主在 `beforeunload`
 * 与组件卸载两处各调一次就会重复释放（A19 的"少一次 dispose 或提前释放"正是这一族）。
 * 返回 `{ destroyed: boolean }` 而不是 `void`：调用方能区分"我真的销毁了"与
 * "它已经销毁过"——后者不该被当成失败，但**必须可见**。
 */
export interface HostSession {
  readonly profile: HostProfileId
  /** 已降级的可选能力（启动时确定，不随后续环境变化）。 */
  readonly degradations: readonly HostDegradation[]
  /** 销毁；**幂等**。第二次调用返回 `{ destroyed: false, reason: 'already-destroyed' }`。 */
  destroy(): HostDestroyOutcome
  /** 是否已销毁（宿主/验收可查询）。 */
  isDestroyed(): boolean
}

/** 销毁结局（三态：真销毁 / 重复销毁 / 销毁前已失败）。 */
export interface HostDestroyOutcome {
  readonly destroyed: boolean
  readonly reason: 'destroyed' | 'already-destroyed'
}

/**
 * 由启动判定结果创建会话句柄（**纯**：不触碰 DOM/GPU/计时器）。
 *
 * 真正的资源释放由调用方传入的 `release` 回调承担（本模块不引入 IO）。
 * 这么切分之后，A34 可以在 Node 里断言"销毁幂等 + 降级清单存在"，
 * 而那两件事恰恰是宿主最容易做错的部分。
 */
export function createHostSession(
  decision: HostLaunchDecision,
  release: () => void,
): HostSession | { readonly blocked: readonly HostMissingRequirement[]; readonly diagnostics: readonly HostDiagnostic[] } {
  if (decision.status !== 'launchable') {
    return {
      blocked: decision.status === 'blocked' ? decision.missing : Object.freeze([]),
      diagnostics: decision.diagnostics,
    }
  }
  let destroyed = false
  const session: HostSession = {
    profile: decision.profile,
    degradations: decision.degradations,
    destroy(): HostDestroyOutcome {
      if (destroyed) return Object.freeze({ destroyed: false, reason: 'already-destroyed' as const })
      destroyed = true
      release()
      return Object.freeze({ destroyed: true, reason: 'destroyed' as const })
    },
    isDestroyed: () => destroyed,
  }
  return Object.freeze(session)
}

/** 判定某对象是否是"启动被拒"的结果（`createHostSession` 的两态收窄）。 */
export function isBlockedLaunch(
  v: HostSession | { readonly blocked: readonly HostMissingRequirement[] },
): v is { readonly blocked: readonly HostMissingRequirement[]; readonly diagnostics: readonly HostDiagnostic[] } {
  return (v as { readonly blocked?: unknown }).blocked !== undefined
}
