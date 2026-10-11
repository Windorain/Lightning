/**
 * `adapters/files/documentBinding` —— **布局与个人偏好单独保存，经文档 ID 重新绑定**
 * （#249 §12 第 1 段末句；#260 交付范围第 1 项的后半句）。
 *
 * ## 本模块替代的旧机制
 *
 * 旧实现把工作环境状态与文档内容**混在同一个持久域**里：
 *
 * | 旧键（`localStorage`） | 存的什么 | 问题 |
 * |---|---|---|
 * | `lightning-wiki-recent-structures`（`wiki/wikiRecentStructures.ts:3-4`） | 最近打开的结构名 | 按**名字**索引，重命名即失联 |
 * | `lightning:stats:v1:*`（已废弃） | 统计面板的文档级配置 | 键里带的是**全局**前缀，同页两个文档互相覆盖 |
 * | 面板布局（`workbench/layout/panelLayoutStorage.ts`） | 面板尺寸 | 与"哪个文档"无关 ⇒ 切文档时布局跟着走（这是**对的**），但它与文档内容存在同一域里（这是**错的**） |
 *
 * `#249` §12 的要求是两件事，本模块逐条落地：
 *
 * 1. **单独保存** —— 布局/偏好**不进**工程文档（那条已由
 *    `projectFormat.RecoverableEditData` 的字段表在类型层挡住）；
 * 2. **经文档 ID 重新绑定** —— 持久键由**文档 ID**构成，于是：
 *    - 换文档 ⇒ 读到的是那份文档自己的布局；
 *    - 关掉再打开同一文档 ⇒ 布局回到原样（这就是"重新绑定"的可观测含义）。
 *
 * ## 键构造：复用 `domain/instanceSettings.preferenceKey`
 *
 * 不另造一套键方案。理由是可证伪性：`preferenceKey(namespace, instanceId, name)` 已有
 * 自己的测试与 A33 的隔离判据（`domain/__tests__/instanceSettings.test.ts`）；
 * 造第二套会让"命名空间/版本/实例身份"这三件事出现两个定义，而它们**恰好**是
 * 多实例隔离的判据所在。
 *
 * 用法是把**文档 ID** 放进 `instanceId` 位：
 *
 * ```
 * preferenceKey('workbench', docId, 'layout')   →  lk.workbench.v2.<docId>.layout
 * preferenceKey('workbench', docId, 'viewport') →  lk.workbench.v2.<docId>.viewport
 * ```
 *
 * 于是"经文档 ID 重新绑定"不是一句政策，而是**一个键字符串的性质** ——
 * 可由 `parsePreferenceKey` 反解、可被断言、可在诊断里打印。
 *
 * ## 哪些东西**不**按文档绑定（同一判断的另一半）
 *
 * 语言、主题、键位是**用户**偏好（#249 §19.7 的"用户持久偏好"域），
 * 换文档不该改变它们 ⇒ 它们用**实例身份**而不是文档身份：
 * `preferenceKey('shared', instanceId, 'lang')`。
 *
 * 两类的分界写在这里而不是散在调用点，因为"这个偏好到底该按文档还是按实例"
 * 是一个**政策**，散开之后必然出现两种答案。
 */

import { preferenceKey, parsePreferenceKey, type PreferenceNamespace } from '@/domain/instanceSettings'
import { invalidValue, type Result, ok, err } from '@/domain/errors'

/**
 * 按**文档 ID** 绑定的持久项（"重新绑定"的那一类）。
 *
 * 每项都有 `name`（进键名的偏好名）与一句"为什么按文档"——
 * 后者不是注释而是字段：它让"这一项为什么在这里"可以被测试逐项读出，
 * 而不是要人去读实现。
 */
export interface DocumentBoundPreference {
  readonly name: string
  readonly namespace: PreferenceNamespace
  readonly why: string
}

/**
 * 登记表本体。
 *
 * 判据（加入本表必须满足）：**换文档后它应该不同**。
 * 反例检验法：把「面板宽度」放进来的人会发现——同一个人在两个文档里希望面板宽度一致，
 * 故它属实例偏好而非文档偏好（它按**工作环境**绑定，那是第三种，见下）。
 */
export const DOCUMENT_BOUND_PREFERENCES: readonly DocumentBoundPreference[] = Object.freeze([
  Object.freeze({
    name: 'viewport',
    namespace: 'workbench' as const,
    why: '观察视角/局部显示属 3D 编辑器实例，但"哪个文档的哪个视角"需要文档身份才能重绑（#249 §3.4 所有权表：观察视角 → 工作环境存储）',
  }),
  Object.freeze({
    name: 'regionLayout',
    namespace: 'workbench' as const,
    why: 'Area 分割树与编辑器类型按文档恢复："上次在这份结构上把视口切成三块"是文档相关的编辑上下文（#249 §12 的"布局单独保存"+ §3.4 的 Workspace 行）',
  }),
  Object.freeze({
    name: 'recovery',
    namespace: 'shared' as const,
    why: '未保存内容的恢复副本按文档隔离（#249 §19.5「副本与偏好按应用/用户范围、**文档身份**和必要实例身份隔离」）',
  }),
])

/** 登记表里的项（缺项 ⇒ `null`，由调用方决定是拒绝还是用缺省）。 */
export function findDocumentBoundPreference(name: string): DocumentBoundPreference | null {
  return DOCUMENT_BOUND_PREFERENCES.find((p) => p.name === name) ?? null
}

/**
 * 构造**按文档绑定**的持久键。
 *
 * 未登记的 `name` **显式拒绝**（而不是"顺手给个键"）：一个没登记的偏好名意味着
 * 有人绕过登记表新增了一项，而"它该按文档还是按实例"这个政策问题没被回答过。
 * 静默生成键会让这类未决政策以"看起来能用"的形态沉淀下来。
 */
export function documentPreferenceKey(documentId: string, name: string): Result<string> {
  if (documentId.trim() === '') return err(invalidValue({ reason: 'documentIdRequired' }))
  const entry = findDocumentBoundPreference(name)
  if (entry === null) {
    return err(invalidValue({ reason: 'preferenceNotDocumentBound', name, registered: DOCUMENT_BOUND_PREFERENCES.map((p) => p.name).join('|') }))
  }
  return ok(preferenceKey(entry.namespace, documentId, name))
}

/**
 * 构造**按实例**绑定的持久键（语言/主题/键位；#249 §19.7 的"用户持久偏好"域）。
 *
 * 与 {@link documentPreferenceKey} 并列存在是**有意**的：把两者放在一起，
 * "这一项按文档还是按实例"就必须被显式选择一次。只有一个函数时，
 * 调用方会"用最近的那个" —— 那正是 A33 负对照
 * 「模块级 activeLang 或全局存储键覆盖所有实例」的成因。
 */
export function instancePreferenceKey(instanceId: string, name: string): string {
  return preferenceKey('shared', instanceId, name)
}

/** 一个持久键的绑定目标（供诊断与断言）。 */
export interface PreferenceBinding {
  readonly key: string
  readonly namespace: PreferenceNamespace
  readonly version: number
  /** 文档 ID 或实例 ID —— 由构造方决定语义，键本身只看 `instanceId` 位。 */
  readonly boundTo: string
  readonly name: string
}

/**
 * 反解持久键（"重新绑定"的**可执行**判据）。
 *
 * 用途：给出一个键，回答"它绑在谁身上"。于是"换文档后读到不同布局"可以被机械验证：
 * 两份文档的键反解出的 `boundTo` 必须不同，且各自等于对应文档 ID。
 *
 * 反解不匹配本方案时返回 `null`（不是抛错）：键可能来自宿主页面自己的存储。
 */
export function readPreferenceBinding(key: string): PreferenceBinding | null {
  const parsed = parsePreferenceKey(key)
  if (parsed === null) return null
  return Object.freeze({
    key,
    namespace: parsed.namespace,
    version: parsed.version,
    boundTo: parsed.instanceId,
    name: parsed.name,
  })
}

/**
 * 判定"两份文档的绑定是否**互相隔离**"（A33 同族判据在文档面上的形态）。
 *
 * 三条缺一即 false：
 *  1. 两边都必须能反解（键方案一致）；
 *  2. `boundTo` 必须**不同**（否则切文档会互相污染）;
 *  3. `boundTo` 必须分别等于各自的文档 ID（否则"按文档绑定"是假的 ——
 *     例如误把 `name` 放进了 `boundTo` 位）。
 */
export function documentBindingsAreIsolated(a: { documentId: string; key: string }, b: { documentId: string; key: string }): boolean {
  const pa = readPreferenceBinding(a.key)
  const pb = readPreferenceBinding(b.key)
  if (pa === null || pb === null) return false
  if (pa.boundTo === pb.boundTo) return false
  return pa.boundTo === a.documentId && pb.boundTo === b.documentId
}

/** 同一份文档两次取出同一键 ⇒ **稳定**（"重开同一文档布局回到原样"的前提）。 */
export function documentPreferenceKeyIsStable(documentId: string, name: string): boolean {
  const a = documentPreferenceKey(documentId, name)
  const b = documentPreferenceKey(documentId, name)
  return a.ok && b.ok && a.value === b.value
}
