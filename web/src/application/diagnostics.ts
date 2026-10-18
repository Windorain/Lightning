/**
 * 结构化诊断契约（#249 §19.9；#259「`application/diagnostics` + runtime 有界记录」）。
 *
 * ## 本文件只做一件事：把"能被诊断关联的东西"定义成**类型化原因**
 *
 * #249 §19.9 要求运行时提供只读诊断：
 * 命令接收/结算原因、属性只读原因、求值节点失效来源与耗时、实际/目标呈现版本、
 * 资源拥有者与引用数、效果关联/取消状态、模块装配与裁剪原因。并明确：
 *
 * - **纯逻辑返回类型化原因和事实**；runtime 关联 `commandId`/`jobId`/`objectId`/版本
 *   并发出**有界**记录；
 * - 记录策略、环形缓冲或采样属**运行配置**，不让日志成为额外业务驱动源，
 *   也**不以无界日志缓存证明可观测**；
 * - 生产默认**最小信息**：不记录令牌、会话凭据或未经选择的完整文档内容；
 * - **UI 错误翻译与诊断数据分离**（翻译键不是诊断字段）；
 * - 验收读这些接口，而**不是**私自窥探 GPU 对象或 Vue 私有字段；
 * - **诊断接口本身无写权限**。
 *
 * ## 分层
 *
 * 本文件在 `application/diagnostics/`：纯类型 + 纯函数 + 一个显式输入的有界环形缓冲
 * 实现。不依赖 Vue / Three / DOM / IO（#249 §4 规则 1/2），由边界扫描的闸门规则检查。
 *
 * ## 为什么"无界日志"被结构性地堵住
 *
 * `DiagnosticRecorder` 的构造**必须**给出容量（`capacity`），且内部用固定长度环形数组。
 * 不存在"追加不设上限"的方法 —— 于是 A35 负对照里的"无限增长记录"不是靠纪律避免，
 * 而是在类型/结构上不可表达。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 类型化原因（纯逻辑产出；稳定、可序列化、与语言无关）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 稳定原因的代码集合。
 *
 * **不随语言变化**（#249 §19.7：「错误用稳定错误码与参数表达…不会因语言改变而改变
 * 命令逻辑或测试断言」）。UI 的本地化发生在**另一处**（`translateDiagnosticReason`），
 * 且只消费 `code` + `params` —— 诊断数据本身不含自然语言。
 */
export type DiagnosticReasonCode =
  // —— 命令接收/结算（#249 §19.9 第一项）——
  | 'command.received'
  | 'command.applied'
  | 'command.unchanged'
  | 'command.rejected'
  | 'command.wouldBlock'
  | 'command.unsupported'
  // —— 属性只读（§19.9 第二项）——
  | 'property.readOnly'
  // —— 求值节点失效（§19.9 第三项）——
  | 'evaluation.invalidated'
  | 'evaluation.stale'
  // —— 呈现版本（§19.9 第四项）——
  | 'presentation.version'
  // —— 资源归属（§19.9 第五项）——
  | 'resource.acquired'
  | 'resource.released'
  | 'resource.leaked'
  // —— 效果关联/取消（§19.9 第六项）——
  | 'effect.started'
  | 'effect.cancelRequested'
  | 'effect.cancelled'
  | 'effect.succeeded'
  | 'effect.failed'
  // —— 模块装配与裁剪（§19.9 第七项）——
  | 'module.assembled'
  | 'module.pruned'
  /** 内容边界拒绝外部内容中的危险构造（#259 / §19.6）。 */
  | 'content.rejected'
  // —— 导出（M6-4；SPEC §9「无法表达的语义必须诊断，不静默丢弃」）——
  /** 导出命令被接收（命令/作业身份随关联字段带出）。 */
  | 'export.requested'
  /** 导出完成（参数带产物形态/帧数/清单摘要/交付位置）。 */
  | 'export.completed'
  /** 导出失败（参数带稳定 reason 与领域错误码；不得只有 UI 文案）。 */
  | 'export.failed'
  /**
   * **目标格式表达不了**的语义（逐项；`objectId` / `reason` 结构化）。
   *
   * 与 `application/exportPlan#ExportCapabilityUnsupported` 同一事实的
   * 诊断通道形态：`params.category` / `params.reason` / `params.objectId`。
   */
  | 'export.capabilityUnsupported'
  /** 必需资源未就绪（预检 blocked 的原因，逐条）。 */
  | 'export.assetNotReady'
  /** 有损失但只有显式有损模式才允许产出。 */
  | 'export.requiresLossyMode'
  /** 声明时长与产物时长不一致（GIF 厘秒量化；已完成但有偏差）。 */
  | 'export.timeQuantized'
  /** 目标种类/编码没有可用的编码器（不产出伪完整文件）。 */
  | 'export.encodingNotConfigured'
  /** 场景为空 ⇒ 空的"完整导出"是假成功。 */
  | 'export.emptyScene'
  /** OBJ：竖条动画纹理只取首帧（多帧序列不可表达）。 */
  | 'export.firstFrameOnly'
  /** OBJ：无几何/解码失败的体素被跳过（此前只写注释行）。 */
  | 'export.geometrySkipped'
  /** OBJ：混合模式只能用 MTL 的 `d`/`illum` 近似（cutout/translucent 不精确）。 */
  | 'export.blendApproximated'

/** 原因的可选结构化参数（**值**只允许标量；不塞对象图）。 */
export type DiagnosticParams = Readonly<Record<string, string | number | boolean>>

/**
 * 关联身份 —— runtime 把纯逻辑产出的事实挂到具体运行实体上（#249 §19.9）。
 *
 * 全部字段可选：纯逻辑层产出的原因可能还没有命令/作业身份。
 */
export interface DiagnosticCorrelation {
  readonly commandId?: string
  readonly jobId?: string
  readonly objectId?: string
  /** 内容版本（推进过的语义版本，不是"提交计数"）。 */
  readonly documentVersion?: number
  /** 呈现版本：实际已发布 / 目标（#249 §19.9「实际/目标呈现版本」）。 */
  readonly actualPresentationVersion?: number
  readonly targetPresentationVersion?: number
}

/** 一条诊断记录。`at` 由**注入的**时钟给出（纯核心不读墙钟）。 */
export interface DiagnosticRecord {
  /** 单调递增序号（同一 recorder 内稳定，供 e2e 顺序对账）。 */
  readonly seq: number
  /** 注入时钟给出的时间戳（毫秒）；生产用真实时钟，测试用固定时钟。 */
  readonly at: number
  readonly code: DiagnosticReasonCode
  readonly params: DiagnosticParams
  readonly correlation: DiagnosticCorrelation
  /** 产生该记录的通道（`command` / `property` / `evaluation` / `resource` / …）。 */
  readonly channel: DiagnosticChannel
}

/** 诊断通道（供"按通道查询"与采样策略分组）。 */
export type DiagnosticChannel =
  | 'command'
  | 'property'
  | 'evaluation'
  | 'presentation'
  | 'resource'
  | 'effect'
  | 'module'
  | 'content'
  /** 导出通道（M6-4）：能力损失/不可表达语义/作业结算。 */
  | 'export'

// ─────────────────────────────────────────────────────────────────────────────
// 脱敏（#259：生产不记录凭据或完整文档）
// ─────────────────────────────────────────────────────────────────────────────

/** 参数键名的脱敏规则：命中即整值替换为 `REDACTED`，**不看**值。 */
const SECRET_KEY_RE = /(token|secret|password|passwd|credential|apikey|api_key|authorization|cookie|session)/i

/** 脱敏后的占位符（固定文本；不泄漏原值长度）。 */
export const REDACTED = '«redacted»'

/** 单个字符串参数的最大长度（防"完整文档"经参数旁路进入诊断）。 */
export const PARAM_VALUE_MAX = 200

/**
 * 清洗参数：按键名脱敏 + 截断字符串值。
 *
 * 这是"生产默认最小信息"的**结构性**落地：即使调用方误传了凭据或整份文档，
 * 记录里也不会出现原值。脱敏发生在**写入时**（不是读取时），
 * 因此环形缓冲里也不存在敏感副本。
 */
export function sanitizeParams(params: DiagnosticParams | undefined): DiagnosticParams {
  if (!params) return {}
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(params)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = REDACTED
      continue
    }
    if (typeof v === 'string' && v.length > PARAM_VALUE_MAX) {
      out[k] = `${v.slice(0, PARAM_VALUE_MAX)}…`
      continue
    }
    out[k] = v
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 有界记录器（环形缓冲；容量是构造期必填）
// ─────────────────────────────────────────────────────────────────────────────

/** 记录策略（属运行配置，#249 §19.9）。 */
export interface DiagnosticRecorderOptions {
  /** **必填**：环形缓冲容量。无界在结构上不可表达。 */
  readonly capacity: number
  /** 注入时钟（毫秒）。纯核心不读 `Date.now()`，由调用方提供。 */
  readonly now: () => number
  /**
   * 采样：仅当 `sample(record) === true` 时记录。缺省全记。
   *
   * 采样是"记录策略"的一部分；它**不**改变业务行为（诊断不驱动业务，
   * #249 §19.9「不让日志成为额外业务驱动源」）。
   */
  readonly sample?: (candidate: Omit<DiagnosticRecord, 'seq' | 'at'>) => boolean
}

/**
 * 只读诊断读面（#249 §19.9「诊断接口本身无写权限」）。
 *
 * **只有查询方法**：没有任何 `add`/`record`/`clear` 之类的写方法暴露在这里。
 * 写入能力只存在于 `DiagnosticRecorder.record`（内部接线用），
 * 并且刻意**不**出现在本接口上 —— 于是"验收经诊断接口取证"不可能顺手改状态。
 */
export interface DiagnosticsReadView {
  readonly capacity: number
  /** 已记录条数（含被环形缓冲覆盖掉的），供"有界"对账。 */
  readonly totalRecorded: number
  /** 当前有效条数（≤ capacity）。 */
  size(): number
  /** 全部有效记录（按 `seq` 升序）。 */
  all(): readonly DiagnosticRecord[]
  /** 按通道过滤。 */
  byChannel(channel: DiagnosticChannel): readonly DiagnosticRecord[]
  /** 按稳定原因码过滤。 */
  byCode(code: DiagnosticReasonCode): readonly DiagnosticRecord[]
  /** 按关联身份过滤（任一字段命中）。 */
  byCorrelation(correlation: DiagnosticCorrelation): readonly DiagnosticRecord[]
  /** 快照（返回只读副本，调用方无法借此写回）。 */
  snapshot(): readonly DiagnosticRecord[]
}

/** 记录器 = 只读读面 + 内部写入口（写入口**不**在 `DiagnosticsReadView` 上）。 */
export interface DiagnosticRecorder extends DiagnosticsReadView {
  /** 记录一条（写入口；`seq`/`at` 由记录器分配）。 */
  record(entry: Omit<DiagnosticRecord, 'seq' | 'at'>): DiagnosticRecord
}

/**
 * 把记录器收窄成**运行期真的只读**的读面（#259 A35 J1）。
 *
 * ## 为什么不能只靠 TypeScript 的类型标注
 *
 * `Context.getDiagnostics(): DiagnosticsReadView` 的标注会让**编译器**拒绝
 * `ctx.getDiagnostics().record(...)`，但运行期返回的仍是同一个
 * `DiagnosticRecorder` 对象 —— 属性还在，`typeof d.record === 'function'` 为真。
 * 于是任何 `as any` / JS 调用方（含 e2e 的 `page.evaluate`、宿主页面脚本）
 * 都能顺手写诊断。而 #249 §19.9 的原话是「**诊断接口本身无写权限**」——
 * 那是一条**运行期**性质，不是类型标注性质。
 *
 * 本批 e2e（真实浏览器）正是靠"断言运行期形态"抓出了这个差距：
 * `诊断接口只读：返回对象上无 record/clear 等写方法` 一度判红。
 *
 * ## 实现
 *
 * 返回一个**新对象**，只搬运查询方法，完全不携带 `record`。
 * `capacity`/`totalRecorded` 用 getter 转发 ⇒ 读面是**活视图**
 * （后续写入仍可见），不是快照拷贝。
 */
export function asReadOnlyDiagnostics(recorder: DiagnosticRecorder): DiagnosticsReadView {
  return Object.freeze({
    get capacity() { return recorder.capacity },
    get totalRecorded() { return recorder.totalRecorded },
    size: () => recorder.size(),
    all: () => recorder.all(),
    byChannel: (channel: DiagnosticChannel) => recorder.byChannel(channel),
    byCode: (code: DiagnosticReasonCode) => recorder.byCode(code),
    byCorrelation: (correlation: DiagnosticCorrelation) => recorder.byCorrelation(correlation),
    snapshot: () => recorder.snapshot(),
  })
}

/**
 * 创建有界诊断记录器。
 *
 * 环形缓冲语义：写满后新记录覆盖最旧记录；`totalRecorded` 持续增长（用于证明
 * "写入很多条、占用恒定"），`size()` 恒 ≤ `capacity`。
 */
export function createDiagnosticRecorder(options: DiagnosticRecorderOptions): DiagnosticRecorder {
  const capacity = Math.max(1, Math.floor(options.capacity))
  const buffer: DiagnosticRecord[] = []
  let nextSeq = 1
  let total = 0

  const record = (entry: Omit<DiagnosticRecord, 'seq' | 'at'>): DiagnosticRecord => {
    const candidate = {
      code: entry.code,
      params: sanitizeParams(entry.params),
      correlation: entry.correlation,
      channel: entry.channel,
    }
    if (options.sample && !options.sample(candidate)) {
      // 被采样丢弃：不计入 totalRecorded（避免"采样后仍声称全量"）
      return { ...candidate, seq: -1, at: options.now() }
    }
    const full: DiagnosticRecord = { ...candidate, seq: nextSeq++, at: options.now() }
    total++
    if (buffer.length >= capacity) buffer.shift()
    buffer.push(full)
    return full
  }

  const all = (): readonly DiagnosticRecord[] => buffer.slice()

  return {
    capacity,
    get totalRecorded() { return total },
    size: () => buffer.length,
    all,
    byChannel: (channel) => buffer.filter((r) => r.channel === channel),
    byCode: (code) => buffer.filter((r) => r.code === code),
    byCorrelation: (correlation) =>
      buffer.filter((r) => {
        const keys = Object.keys(correlation) as (keyof DiagnosticCorrelation)[]
        return keys.some((k) => correlation[k] !== undefined && r.correlation[k] === correlation[k])
      }),
    snapshot: () => buffer.slice(),
    record,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UI 翻译与诊断数据分离（#249 §19.7 / §19.9）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 原因码 → 翻译**键**（不是自然语言）。
 *
 * 本函数返回的是键，UI 再用实例语言去查字典 —— 于是"诊断数据"与"UI 文案"
 * 是两份东西：改变语言**不**改变任何断言对象，也不改变命令逻辑。
 */
export function diagnosticReasonKey(code: DiagnosticReasonCode): string {
  return `diagnostic.${code}`
}

/**
 * 供 UI 展示的一行摘要 —— 显式要求调用方传入翻译函数。
 *
 * 刻意**不**内置默认文案：内置默认文案会让"忘了翻译"静默退化成英文/中文硬编码，
 * 于是测试断言与语言绑定。要求显式传入，把"翻译责任"钉在调用点。
 */
export function formatDiagnosticRecord(
  record: DiagnosticRecord,
  translate: (key: string, params: DiagnosticParams) => string,
): string {
  return translate(diagnosticReasonKey(record.code), record.params)
}
