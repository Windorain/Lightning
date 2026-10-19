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
  //
  // ⚠️ **M8-6 码表对账：两码已删除**（evaluation.invalidated / evaluation.stale）。
  //
  // 论证（不是"暂时没人用"，而是**结构上没有这个事实**）：
  //  - `runtime/evaluation#EvaluationInstance`（唯一产出"节点失效/过期接纳"的地方）在
  //    生产面**零实例化**（`src/runtime/kernelSession.ts:8` 自己登记了这条事实）；
  //  - 生产的多方块求值（`composition/kernelMultiblockEvaluation`）是**每次读面全量重算**：
  //    没有缓存 ⇒ 没有"失效"事件；没有异步节点接纳 ⇒ 没有"过期结果"事件。
  //  - 唯一形似的"上一份编译产物被替换"由 `presentation.version` 如实承载
  //    （实际/目标呈现版本），那是**呈现**事实，不是求值图事实。
  // ⇒ 两码若保留，只能靠"有人写了不存在的发射点"才绿 —— 那正是码表变许愿单的形态。
  // 求值图接线时（引入缓存与异步节点接纳）应按新事实重新立码并同批接发射点。
  // —— 呈现版本（§19.9 第四项）——
  | 'presentation.version'
  // —— 资源归属（§19.9 第五项）——
  | 'resource.acquired'
  | 'resource.released'
  | 'resource.leaked'
  // —— 效果关联/取消（§19.9 第六项）——
  //
  // ⚠️ **M8-6 码表对账：四个生命周期码已删除**（effect.started / effect.cancelRequested /
  // effect.cancelled / effect.succeeded）。
  //
  // 理由（S0-B §4.2 的零生产者清单 + M8-6 实测）：它们描述的作业状态机
  // （runtime/effects#JobState：queued → running → cancelRequested → succeeded|failed|cancelled）
  // 在**生产面零实例化**——全树 enqueueJob/applyJobEvent 只出现在定义与单测里，
  // 且生产没有任何 AbortController 发起取消。码表不是许愿单：一条只存在于类型里的码
  // 会让「按码聚合」的读面永远给出空集，并让后来者以为这条链已被观测覆盖。
  // 保留 effect.failed —— 它有 8 个生产发点（呈现链编译/注解失败；M8-5 已按等价替换钉过）。
  // 若日后真的接入作业取消协议（例如导出取消入口），按新事实**重新立码**并同批接发射点。
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
  /** OBJ：layered 模式的叠化规则不在产物里（多层 PNG 共享 UV，需调用方合成）。 */
  | 'export.layerStackUnexpressed'
  /** OBJ：混合模式只能用 MTL 的 `d`/`illum` 近似（cutout/translucent 不精确）。 */
  | 'export.blendApproximated'
  // —— 设备生命周期（M8-3；SPEC §7.5 / §6:206 的"设备代次"维度）——
  /**
   * WebGL 上下文丢失：呈现暂停、旧代次份额被**放弃**（不是回收）。
   *
   * 参数带放弃数与视口/代次关联字段 —— 多 Area 场景据此定位是谁丢了设备。
   */
  | 'device.lost'
  /** WebGL 上下文恢复：设备代次已推进，会话将按**当前有效状态**重建呈现资源。 */
  | 'device.restored'
  // —— 恢复副本（M8-4；SPEC §9:299）——
  /**
   * 写恢复副本失败（**三类不合并**，见 `params.cause`）。
   *
   * | `cause` | 含义 | 用户能做什么 |
   * |---|---|---|
   * | `quotaExceeded` | 存储配额不足 | 清理存储/降低份数后重试 |
   * | `unavailable` | 宿主拒绝/没有存储（隐私模式等） | 本环境不提供恢复副本；手动保存照常 |
   * | `failed` | 存储访问抛错（`params.code` 保留稳定码） | 保留诊断；不影响手动保存 |
   * | `serialization` | 来源快照自相矛盾/无法序列化（纯层拒绝） | 这是实现缺陷，内容与保存不受影响 |
   *
   * 写入失败**不**改变正式保存基线，也不阻断编辑（S0-B 承接 A31-3 的产品化）。
   */
  | 'recovery.writeFailed'
  /** 启动/刷新后检测到**可采纳**的未采纳恢复副本（参数带键/文档身份/写入时刻）。 */
  | 'recovery.detected'
  /** 已采纳一份恢复副本（参数带内容版本与"基线是否逐位未变"事实）。 */
  | 'recovery.adopted'
  /** 采纳**未完成**（副本有效但投影/落地失败）—— 当前有效内容必须原样保留。 */
  | 'recovery.adoptFailed'
  /** 已放弃（删除）一份/一族恢复副本（用户显式动作或正式保存后的作废）。 */
  | 'recovery.discarded'
  /** 存储里的恢复副本**校验失败**（参数带键/文档身份/结构化原因；不自动删除）。 */
  | 'recovery.corrupt'
  // —— 资源失败/降级/重试/恢复（M8-5；SPEC §7.4:252/256 + §8:284 + D7）——
  //
  // 屏上资源链（`composition/kernelTextureResources#textureResourcesOf` 的五态表）
  // 的四个结算事实。**不借 `effect.failed`**（D2：那种借用在"资源"这一族里
  // 信息更少、且与呈现链的编译/注解失败混在同一条通道里）。
  //
  // 每条都带 `params.assetId`（+ 有 locator 时带 `params.locator`）—— D7：
  // 只报"有 k 张失败"不是可定位的诊断（用户无法回答"哪一张"）。
  /**
   * 一项资源**请求失败**（解码失败/字节不是图像）。
   *
   * 参数：`assetId` / `locator` / `state` / `reason`（失败原因，供排障）。
   * 关联：`correlation.viewportId`（多 Area 时可定位是哪一侧的呈现受影响）。
   */
  | 'resource.failed'
  /**
   * 资源未就绪导致**呈现降级**（受影响图元以占位呈现；其余照常）。
   *
   * 参数：`degradedMaterials`（绑定指向未就绪资源的材质条数）、`missingRequired`、
   * `failed` / `total`（资源条数）、`attempt`（0 = 首次请求，>0 = 显式重试的第 n 次）。
   *
   * 它存在的前提是 Q1 的产品口径：**资源失败不夺视口**，受影响图元降级 ——
   * 于是"降级"本身必须是一个可查询事实（否则用户只看到画面变平却没有任何记录）。
   */
  | 'resource.degraded'
  /** 用户/系统发起了一次**显式重试**（新请求；旧请求不得覆盖它，SPEC §7.4:252）。 */
  | 'resource.retryRequested'
  /** 之前失败的一项资源在重试后**就绪**（占位恢复为正常呈现）。 */
  | 'resource.recovered'

/**
 * **码表作为数据**（M8-6：让「每码都有生产发射点」可被机械核对）。
 *
 * ## 为什么需要它
 *
 * 码表此前只是**联合类型** —— 类型层数得出 30+ 条码，但没有任何运行时清单，
 * 于是「哪些码只有类型、没有生产者」只能靠人肉 grep（S0-B §4.2 就是这么数出 18 个的，
 * 而且每次扩码都要重数一遍）。本常量把码表变成**可在测试里遍历的数据**：
 * `src/runtime/__tests__/diagnosticCodeProducers.test.ts` 逐码扫描生产源文件，
 * 要求每码要么有 `code: '<码>'` 发射点，要么从本表消失。
 *
 * ## 为什么不会与联合类型漂移
 *
 * 映射表的键类型是 `Record<DiagnosticReasonCode, true>`：
 * 少一个键 = 编译错误；多一个不存在的键 = 编译错误。
 * ⇒ 「加码不加表」在类型上不可表达。
 */
const DIAGNOSTIC_CODE_TABLE: Readonly<Record<DiagnosticReasonCode, true>> = Object.freeze({
  'command.received': true,
  'command.applied': true,
  'command.unchanged': true,
  'command.rejected': true,
  'command.wouldBlock': true,
  'command.unsupported': true,
  'property.readOnly': true,
  'presentation.version': true,
  'resource.acquired': true,
  'resource.released': true,
  'resource.leaked': true,
  'effect.failed': true,
  'module.assembled': true,
  'module.pruned': true,
  'content.rejected': true,
  'export.requested': true,
  'export.completed': true,
  'export.failed': true,
  'export.capabilityUnsupported': true,
  'export.assetNotReady': true,
  'export.requiresLossyMode': true,
  'export.timeQuantized': true,
  'export.encodingNotConfigured': true,
  'export.emptyScene': true,
  'export.firstFrameOnly': true,
  'export.geometrySkipped': true,
  'export.layerStackUnexpressed': true,
  'export.blendApproximated': true,
  'device.lost': true,
  'device.restored': true,
  'recovery.writeFailed': true,
  'recovery.detected': true,
  'recovery.adopted': true,
  'recovery.adoptFailed': true,
  'recovery.discarded': true,
  'recovery.corrupt': true,
  'resource.failed': true,
  'resource.degraded': true,
  'resource.retryRequested': true,
  'resource.recovered': true,
})

/** 码表的运行时清单（顺序 = 上面的声明顺序；只读）。 */
export const DIAGNOSTIC_CODES: readonly DiagnosticReasonCode[] = Object.freeze(
  Object.keys(DIAGNOSTIC_CODE_TABLE) as DiagnosticReasonCode[],
)
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
  /**
   * 视口 region id（M8-3）：设备事件的**定位**字段（双 Area 判得出是谁丢了设备）。
   *
   * 它只用于关联，不是内容身份 —— 与 `objectId` 同一性质。
   */
  readonly viewportId?: string
  /**
   * 设备代次（M8-3；SPEC §6:206）：该事件发生在/推进到第几次**有效设备生命周期**。
   *
   * ⚠️ 与 `actualPresentationVersion`（呈现版本，内容侧）**不同空间**，不得互相赋值。
   */
  readonly deviceGeneration?: number
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
  /** 设备生命周期通道（M8-3）：丢失/恢复/重建（不放 effect 通道里冒充）。 */
  | 'device'
  /** 恢复副本通道（M8-4）：写入失败/检测/采纳/放弃/损坏（不借 resource/effect 冒充）。 */
  | 'recovery'

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
  /**
   * **投影观察者**（M8-6）：每写一条记录后，把**同一条记录**交给调用方去投影成
   * 其它可读面（人读日志条目、底栏实时状态）。
   *
   * ## 为什么是"观察者"而不是第二个写入口
   *
   * C1（本记录器）是**唯一结构化诊断面**；C2（`LogCenter`）/C3（`liveStatus`）
   * 只允许是它的**投影** —— 于是"同一事实两条通道"不可能再各自演化：
   * 任何投影都必须能由 `record` 的 `code` + `params` 推导出来。
   *
   * ## 约束（都有单测钉）
   *
   * 1. **只读**：观察者拿到的记录是只读的，不得借此写回诊断或业务状态；
   * 2. **不驱动业务**：观察者抛错不得让 `record()` 抛错、更不得改变业务结果
   *    （见 `diagnosticProjection.test.ts` 的负对照）；
   * 3. **不改变记录**：返回值仍是那条记录；采样丢弃时不调用观察者（没有记录就没有投影）。
   */
  readonly observe?: (record: Readonly<DiagnosticRecord>) => void
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
    // 投影（M8-6）：记录**落地之后**才通知，且观察者失败不影响记录/业务。
    // 这里刻意吞掉异常：观察者是读面（日志/底栏），它坏掉不该让"一次诊断"
    // 变成"一次业务失败"；但它也不得静默改变返回值（返回的仍是 full）。
    if (options.observe !== undefined) {
      try {
        options.observe(full)
      } catch {
        // 投影失败：诊断本身仍然有效（C1 是权威，C2/C3 是投影）。
      }
    }
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