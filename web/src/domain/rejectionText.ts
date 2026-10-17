/**
 * M4-3 R1 · **拒绝原因的成句映射**（纯层；#249 §19.7 错误用稳定码 + 参数表达）。
 *
 * ## 它解决什么
 *
 * 内核拒绝是**结构化值**（`DomainError{code, params}`，`domain/errors` 的八码封闭集）。
 * 用户看到的却是「界面没反应」：编辑器把拒绝压成布尔/日志，字段与底栏都没有成句原因
 * （S0 域 2 的结论：`.ux-field-problem` 只接无草稿控件，文本控件走输入端口后拒绝只进 trace）。
 * 本模块把「码 + 参数」翻成**一句中文/英文原因**，供字段级提示与底栏实时状态共用。
 *
 * ## 为什么是纯函数而不是组件内拼串
 *
 * - 同一份拒绝会同时出现在字段与底栏，两处各拼一次必然漂移；
 * - 判据要能对**每个已知码**逐条断言（`rejectionText.test.ts`），不必挂载组件；
 * - SPEC §19.7：文案可本地化，**逻辑不因语言改变**。
 *
 * ## 口径（与用户 2026-10-17 裁决一致）
 *
 * | 层 | 通道 | 形态 |
 * |---|---|---|
 * | 字段级 | `.ux-field-problem` | `<字段名>写入被拒：<原因>` |
 * | 底栏 | `LogCenter.liveStatus` | 同一条成句（`origin: 'rejection'`） |
 *
 * ## 不许吞
 *
 * - 已知码 + **未知原因** ⇒ 句子带原 `code` 与 `reason` 文本；
 * - **未知码**（运行期只可能来自外部注入/版本错配）⇒ 句子带原码文本。
 *
 * 吞掉原码会让「异常路径」在界面上与「已知拒绝」同形 —— 那正是本批要消除的
 * 「静默成功/静默失败」形态。
 */

import type { DomainError, DomainErrorCode } from './errors'
import type { Lang } from './i18n'

/**
 * 拒绝发生在**哪种操作**上。
 *
 * 只影响句首（「方块标识写入被拒」「移动被拒」…）—— 原因本身由码与参数决定，
 * 与调用点无关（同一 `outsideDeclaredGrid` 在移动与写入下是同一个事实）。
 */
export type RejectionOperation =
  | 'propertyWrite'
  | 'move'
  | 'annotationEdit'
  | 'metaEdit'
  | 'generic'

/** 参数记录（`DomainError.params` 的形状；只读）。 */
type Params = Readonly<Record<string, string | number>>

/** 一个原因条目的两种语言写法（`params` 作输入，不改它）。 */
type Entry = Readonly<{ zh: (p: Params) => string; en: (p: Params) => string }>

/** 取参数（缺失时给空串；**不**编造默认值）。 */
function p(params: Params, key: string): string {
  const v = params[key]
  return v === undefined ? '' : String(v)
}

/** `cell@x,y,z` → `x,y,z`（内核拒绝里格键的携带形式）；不是该形状则原样返回。 */
function cellLabel(raw: string): string {
  const at = raw.indexOf('@')
  return at === 0 ? raw.slice(1) : raw
}

/** 有坐标就写坐标，没有则退回对象 id。 */
function where(pms: Params): string {
  const x = p(pms, 'x')
  const y = p(pms, 'y')
  const z = p(pms, 'z')
  if (x !== '' && y !== '' && z !== '') return `(${x}, ${y}, ${z})`
  const id = p(pms, 'objectId')
  return id === '' ? '' : cellLabel(id)
}

/**
 * 已知 (code, reason) → 成句原因。
 *
 * 键是 `<code>:<reason>`：**reason 才是用户能据以行动的那一层**
 * （`InvalidValue` 既可能是「标识格式非法」也可能是「目标越界」）。
 *
 * 收录范围 = `submitPropertyWrite` 与它下游的内核命令
 * （`setCellIdentity`/`setCellTooltip`/`setProperty`/`setDocumentMeta`/`moveCells`）
 * 实际会返回的码与原因（全量盘点，见 R1 回报的表格）。
 */
const REASONS: Readonly<Record<string, Entry>> = Object.freeze({
  // ── InvalidValue ──────────────────────────────────────────────────────────
  'InvalidValue:malformed-block-id': {
    zh: (q) => (p(q, 'meta') === ''
      ? '方块标识格式不合法（应为 namespace:path[:meta]）'
      : `方块标识的 meta 不合法（${p(q, 'meta')}）`),
    en: (q) => (p(q, 'meta') === ''
      ? 'malformed block id (expected namespace:path[:meta])'
      : `malformed block meta (${p(q, 'meta')})`),
  },
  'InvalidValue:malformed-cell-owner-id': {
    zh: () => '目标格的坐标无法解析（面板寻址 x,y,z 不成立）',
    en: () => 'the target cell address cannot be parsed (x,y,z)',
  },
  'InvalidValue:duplicateCells': {
    zh: (q) => `同一次编辑里有重复的格（${p(q, 'count')} 项），无法确定先后`,
    en: (q) => `duplicate cells in one edit (${p(q, 'count')} entries)`,
  },
  'InvalidValue:emptyBlockName': {
    zh: () => '方块注册名为空',
    en: () => 'empty block name',
  },
  'InvalidValue:emptyPaletteRef': {
    zh: () => '调色板引用为空（该格说不出是哪个方块）',
    en: () => 'empty palette reference',
  },
  'InvalidValue:outsideDeclaredGrid': {
    zh: (q) => {
      const at = where(q)
      return at === '' ? '目标格超出声明网格范围' : `目标格 ${at} 超出声明网格范围`
    },
    en: (q) => {
      const at = where(q)
      return at === '' ? 'target cell is outside the declared grid' : `target cell ${at} is outside the declared grid`
    },
  },
  'InvalidValue:mixedHasNoConcreteValue': {
    zh: () => '多选目标是混合值：请先给出一个具体值',
    en: () => 'mixed selection: provide one concrete value',
  },
  'InvalidValue:noTargets': {
    zh: () => '没有可写的目标',
    en: () => 'no writable targets',
  },
  'InvalidValue:emptyMetadataPatch': {
    zh: () => '元数据补丁为空（没有要改的字段）',
    en: () => 'empty metadata patch',
  },
  'InvalidValue:interactionAlreadyActive': {
    zh: () => '已有进行中的交互（同一上下文只允许一个修改事务）',
    en: () => 'another interaction is already active',
  },
  'InvalidValue:notFinite': {
    zh: (q) => `值不是有限数（${p(q, 'value')}）`,
    en: (q) => `not a finite number (${p(q, 'value')})`,
  },

  // ── ReadOnly ──────────────────────────────────────────────────────────────
  'ReadOnly:declared-read-only': {
    zh: () => '该属性按声明只读',
    en: () => 'property is declared read-only',
  },
  'ReadOnly:generated-owner': {
    zh: () => '该对象是生成物，不可直接编辑',
    en: () => 'the object is generated and cannot be edited',
  },
  'ReadOnly:animation-driven': {
    zh: () => '该属性由动画轨道驱动，不能直接改',
    en: () => 'property is driven by an animation track',
  },
  'ReadOnly:locked': {
    zh: () => '目标已锁定',
    en: () => 'target is locked',
  },
  'ReadOnly:no-modification-lease': {
    zh: () => '当前上下文没有该文档的修改权',
    en: () => 'this context does not hold the modification lease',
  },

  // ── MissingTarget ─────────────────────────────────────────────────────────
  'MissingTarget:no-document': {
    zh: () => '还没有打开文档',
    en: () => 'no document is open',
  },
  'MissingTarget:no-targets': {
    zh: () => '没有选中的目标',
    en: () => 'no selected target',
  },
  'MissingTarget:no-selection': {
    zh: () => '没有选中目标，字段无落点',
    en: () => 'no selection for this field',
  },
  'MissingTarget:property-not-registered': {
    zh: (q) => `属性未在内核注册表登记（${p(q, 'property')}）`,
    en: (q) => `property is not registered in the kernel registry (${p(q, 'property')})`,
  },
  'MissingTarget:unknownPropertyControl': {
    zh: (q) => `未知的控件属性（${p(q, 'property')}）`,
    en: (q) => `unknown control property (${p(q, 'property')})`,
  },
  'MissingTarget:target-missing': {
    zh: () => '目标不存在（可能已被删除）',
    en: () => 'target does not exist (it may have been deleted)',
  },

  // ── UnsupportedOperation ──────────────────────────────────────────────────
  'UnsupportedOperation:identity-not-in-palette': {
    zh: () => '该标识不在本文档调色板中（或同一注册名对应多条内容键，无法唯一确定）',
    en: () => 'the identity is not in this document palette (or several content keys share that name)',
  },
  'UnsupportedOperation:no-write-path': {
    zh: (q) => `该字段没有写入路径（${p(q, 'property')}）`,
    en: (q) => `no write path for this property (${p(q, 'property')})`,
  },
  'UnsupportedOperation:kernel-not-adopted': {
    zh: () => '内核编辑会话未装配，本次写入未执行',
    en: () => 'the kernel edit session is not adopted; nothing was written',
  },
  'UnsupportedOperation:capability-missing': {
    zh: (q) => `本外壳缺少写能力（${p(q, 'capability')}）`,
    en: (q) => `missing capability (${p(q, 'capability')})`,
  },
  'UnsupportedOperation:kernel-registry-invalid': {
    zh: (q) => `内核属性注册表不合法（${p(q, 'detail')}）`,
    en: (q) => `invalid kernel property registry (${p(q, 'detail')})`,
  },
  'UnsupportedOperation:propertyNotAnimatable': {
    zh: (q) => `该属性不可动画（${p(q, 'property')}）`,
    en: (q) => `property is not animatable (${p(q, 'property')})`,
  },

  // ── DocumentBusy / VersionConflict / StaleReference / WouldBlock ─────────
  'DocumentBusy:unknown': {
    zh: (q) => {
      const holder = p(q, 'holder')
      return holder === '' ? '文档已被另一个上下文占用修改权' : `文档已被另一个上下文占用修改权（持有者：${holder}）`
    },
    en: (q) => {
      const holder = p(q, 'holder')
      return holder === '' ? 'the document is held by another context' : `the document is held by another context (${holder})`
    },
  },
  'VersionConflict:unknown': {
    zh: (q) => `文档版本已变化（期望 ${p(q, 'expected')}，实际 ${p(q, 'actual')}）`,
    en: (q) => `document version changed (expected ${p(q, 'expected')}, actual ${p(q, 'actual')})`,
  },
  'StaleReference:unknown': {
    zh: (q) => `引用已过期（${p(q, 'elementId')} 的拓扑版本已变）`,
    en: (q) => `stale reference (${p(q, 'elementId')})`,
  },
  'WouldBlock:busy': {
    zh: () => '执行器正忙，稍后重试',
    en: () => 'the executor is busy; retry later',
  },
  'WouldBlock:reentrant': {
    zh: () => '发布订阅中不能重入提交',
    en: () => 're-entrant submit during publish is not allowed',
  },
  'WouldBlock:incompatibleQueued': {
    zh: () => '队列里有不兼容的命令',
    en: () => 'an incompatible command is queued',
  },
})

/**
 * 已知码的**兜底**句式（原因未知，或该码没有专门条目）。
 *
 * 例：`InvalidValue` + 未知 reason ⇒ 「拒绝原因 InvalidValue（原因 xxx）」——
 * 原码与原因文本都在，读日志的人能据此定位。
 */
const CODE_FALLBACK: Readonly<Record<DomainErrorCode, Entry>> = Object.freeze({
  InvalidValue: {
    zh: (q) => failZh('值不合法', q),
    en: (q) => failEn('invalid value', q),
  },
  ReadOnly: {
    zh: (q) => failZh('目标只读', q),
    en: (q) => failEn('read-only', q),
  },
  MissingTarget: {
    zh: (q) => failZh('目标不存在', q),
    en: (q) => failEn('missing target', q),
  },
  StaleReference: {
    zh: (q) => failZh('引用已过期', q),
    en: (q) => failEn('stale reference', q),
  },
  DocumentBusy: {
    zh: (q) => failZh('文档忙', q),
    en: (q) => failEn('document busy', q),
  },
  VersionConflict: {
    zh: (q) => failZh('版本冲突', q),
    en: (q) => failEn('version conflict', q),
  },
  UnsupportedOperation: {
    zh: (q) => failZh('不支持的操作', q),
    en: (q) => failEn('unsupported operation', q),
  },
  WouldBlock: {
    zh: (q) => failZh('当前不能执行', q),
    en: (q) => failEn('blocked right now', q),
  },
})

/** 兜底句式：**原因**在句尾保留原文（不许吞）。 */
function failZh(label: string, params: Params): string {
  const reason = p(params, 'reason')
  return reason === '' ? label : `${label}（${reason}）`
}

function failEn(label: string, params: Params): string {
  const reason = p(params, 'reason')
  return reason === '' ? label : `${label} (${reason})`
}

/** 句首（操作名）。`subject` 给了就用它（如「方块标识」），否则用操作名。 */
function headLabel(op: RejectionOperation, lang: Lang, subject: string | undefined): string {
  if (lang === 'en') {
    switch (op) {
      case 'propertyWrite': return 'Property write'
      case 'move': return 'Move'
      case 'annotationEdit': return 'Annotation edit'
      case 'metaEdit': return 'Metadata write'
      default: return subject ?? 'Operation'
    }
  }
  if (op === 'move') return '移动'
  if (op === 'generic') return subject ?? '操作'
  const base = op === 'annotationEdit' ? '编辑' : '写入'
  return subject === undefined || subject === '' ? defaultHead(op) : `${subject}${base}`
}

function defaultHead(op: RejectionOperation): string {
  switch (op) {
    case 'propertyWrite': return '属性写入'
    case 'annotationEdit': return '注解编辑'
    case 'metaEdit': return '元数据写入'
    case 'move': return '移动'
    default: return '操作'
  }
}

/** 原因从句（纯；未知码/未知原因都保留原文本）。 */
export function rejectionReason(error: DomainError, lang: Lang): string {
  const reason = p(error.params, 'reason')
  const entry = reason === '' ? undefined : REASONS[`${error.code}:${reason}`]
  if (entry) return (entry[lang] ?? entry.zh)(error.params)
  // 已知码但没有专门条目（含 `reason` 缺省的码级拒绝，如 `DocumentBusy`/版本冲突）。
  const byCode = REASONS[`${error.code}:unknown`] ?? CODE_FALLBACK[error.code]
  if (byCode) return (byCode[lang] ?? byCode.zh)(error.params)
  // 未知码（运行期：外部注入/版本错配）⇒ **带原码**，不吞。
  return lang === 'en'
    ? `unrecognized rejection code ${String(error.code)}`
    : `未识别的拒绝码 ${String(error.code)}`
}

/**
 * 一条完整的成句拒绝原因。
 *
 * @param error   内核/边界给出的结构化错误（八码封闭集；运行期可能有未知码）
 * @param lang    本实例语言（`ctx.getShellSettings().lang.value`）
 * @param op      拒绝发生在哪种操作上（只影响句首）
 * @param subject 操作对象的**具体名称**（如「方块标识」）；缺省用操作名
 */
export function rejectionSentence(
  error: DomainError,
  lang: Lang,
  op: RejectionOperation = 'generic',
  subject?: string,
): string {
  const reason = rejectionReason(error, lang)
  const head = headLabel(op, lang, subject)
  return lang === 'en' ? `${head} rejected: ${reason}` : `${head}被拒：${reason}`
}

/** 已知 (code, reason) 键清单（供测试对账「每个已知条目都有断言」）。 */
export const REJECTION_REASON_KEYS: readonly string[] = Object.freeze(Object.keys(REASONS))
