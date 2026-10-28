/**
 * `domain/identity` —— **值语义的身份与版本**（冻结契约 §1）。
 *
 * 契约 §1 的原则：**对象和属性引用是值，不是裸对象指针**。任何跨边界的引用必须是
 * 可序列化、可比较、**不含运行时句柄**的纯数据 —— 这是「统一更新阶段 + 原子一致发布」
 * 的前提：如果引用里藏着对象指针，发布一致版本就无从谈起。
 *
 * ## 本模块的两处落地决定（不改冻结语义，只补齐辅助类型）
 *
 * ### 1. `Version.contentVersion` 用**内容摘要**，不是提交计数
 *
 * 契约 §1.4 冻结了 `Version = { documentVersion: number; contentVersion?: number }`，
 * 并同时要求两件看似冲突的事：
 *  - `documentVersion` **单调**，只因内容变化推进；
 *  - 「内容版本**不能**用单调提交计数代替」「`Version` 必须能与保存基线**比较相等**，
 *    不只是比较大小」（撤销回实际保存内容必须干净）。
 *
 * 单调计数无法同时满足后者：撤销回到上一次保存的内容时计数只增不减。故把两位分开：
 *  - `documentVersion` = 单调计数器，仅供失效/缓存世代使用；
 *  - `contentVersion` = **内容身份摘要**（`contentDigest`，FNV-1a 32 位，纯函数、无 IO），
 *    相同内容必得相同摘要，故"撤销回保存内容 ⇒ 与基线相等 ⇒ 干净"成立。
 *
 * 两者都保留在同一个 `Version` 值里，契约类型未变。摘要算法是纯的：不读全局时钟、
 * 不用随机数、不 import `node:crypto`（那会被边界闸门判为 IO 依赖，且破坏
 * 「相同显式输入返回相同结果」——crypto 的可用性与输出不是本领域能承诺的）。
 *
 * ### 2. `ElementRef` 只冻结**版本限定**这一必要成分
 *
 * 契约 §1.2 选择理由：只冻结两种实现路径都需要的那部分，把"顶点是否自带 ID"留给实现。
 * 故本模块只提供 `elementRef` 构造函数与 `isElementRefCurrent` 判定，不引入顶点表结构。
 */

/** 具名拥有者的种类。契约 §1.1 理由：显式 `kind`，不靠 ID 前缀编码。 */
export type EntityOwnerKind =
  | 'document'
  | 'scene'
  | 'object'
  | 'objectData'
  | 'editContext'
  | 'workspace'
  | 'asset'
  | 'evaluation'

/** 契约 §1.1。**不含**对象实例、Vue ref、Three 对象、DOM 节点。 */
export interface EntityRef {
  readonly kind: EntityOwnerKind
  /** 稳定 ID；跨保存/重开不变。 */
  readonly id: string
  /** 内容版本；用于判定引用是否过期（见 `StaleReference`）。 */
  readonly contentVersion?: number
}

/** 契约 §1.2 —— 稳定子元素身份 + 限定它的拓扑版本。 */
export interface ElementRef {
  /** 顶点/边/面的局部稳定身份（实现自选表示，契约不钉死）。 */
  readonly elementId: string
  /** 该数据当前拓扑版本；不匹配即 `StaleReference`。 */
  readonly topologyVersion: number
}

/** 注册于 RNA 的稳定属性 ID。 */
export type PropertyId = string

/** 契约 §1.3。是**值**：可比较、可序列化、不含 setter 闭包。 */
export interface PropertyRef {
  /** 文档/数据/编辑上下文等具名拥有者。 */
  readonly owner: EntityRef
  readonly property: PropertyId
  /** 稳定子元素身份及必要拓扑版本。 */
  readonly element?: ElementRef
  /** 向量/四元数的分量下标（契约 §1.3 选择理由：分量动画与标量动画共用寻址）。 */
  readonly component?: number
}

/**
 * 契约 §1.4。两位的含义见文件头「落地决定 1」。
 *
 * `contentVersion` 在契约里可选；本实现始终填充它（摘要恒可算），
 * 但保留可选标记以兼容尚未计算内容身份的中间态（例如仅推进失效世代）。
 */
export interface Version {
  /** 文档内容版本（单调、仅内容变化推进）。 */
  readonly documentVersion: number
  /** 内容身份摘要；用于与保存基线比较相等。 */
  readonly contentVersion?: number
}

/** 契约 §1.4 —— 实际发生变化的属性/对象的最小充分描述。 */
export interface ChangeSummary {
  readonly changedProperties: readonly PropertyRef[]
  readonly createdEntities: readonly EntityRef[]
  readonly removedEntities: readonly EntityRef[]
  /** 结构共享提示：true 表示候选状态与前一版本共享未变子树。 */
  readonly structurallyShared: boolean
}

/** 「什么都没变」的变更摘要。`unchanged` 分支用它表达"保持未改分支身份"。 */
export const NO_CHANGE: ChangeSummary = Object.freeze({
  changedProperties: Object.freeze([]) as readonly PropertyRef[],
  createdEntities: Object.freeze([]) as readonly EntityRef[],
  removedEntities: Object.freeze([]) as readonly EntityRef[],
  structurallyShared: true,
})

/** 初始版本：内容为空文档。 */
export const VERSION_ZERO: Version = Object.freeze({ documentVersion: 0, contentVersion: contentDigest('') })

// ─────────────────────────────────────────────────────────────────────────────
// 构造
// ─────────────────────────────────────────────────────────────────────────────

/** 造一个 `EntityRef`。`contentVersion` 省略即"不参与过期判定"。 */
export function entityRef(kind: EntityOwnerKind, id: string, contentVersion?: number): EntityRef {
  return contentVersion === undefined ? Object.freeze({ kind, id }) : Object.freeze({ kind, id, contentVersion })
}

/** 文档拥有者引用。 */
export function documentRef(id: string, contentVersion?: number): EntityRef {
  return entityRef('document', id, contentVersion)
}

/** 对象拥有者引用。 */
export function objectRef(id: string, contentVersion?: number): EntityRef {
  return entityRef('object', id, contentVersion)
}

/** 对象数据拥有者引用（数据与对象分离）。 */
export function objectDataRef(id: string, contentVersion?: number): EntityRef {
  return entityRef('objectData', id, contentVersion)
}

/** 编辑上下文拥有者引用。 */
export function editContextRef(id: string): EntityRef {
  return entityRef('editContext', id)
}

/** 造一个 `ElementRef`。 */
export function elementRef(elementId: string, topologyVersion: number): ElementRef {
  return Object.freeze({ elementId, topologyVersion })
}

/** 造一个 `PropertyRef`。 */
export function propertyRef(
  owner: EntityRef,
  property: PropertyId,
  extra?: { element?: ElementRef; component?: number },
): PropertyRef {
  const out: { owner: EntityRef; property: PropertyId; element?: ElementRef; component?: number } = { owner, property }
  if (extra?.element) out.element = extra.element
  if (extra?.component !== undefined) out.component = extra.component
  return Object.freeze(out)
}

/** 造一个 `Version`。 */
export function version(documentVersion: number, contentVersion: number): Version {
  return Object.freeze({ documentVersion, contentVersion })
}

/** 只推进失效世代、不改内容身份（用于"非内容版本不得冒充内容变化"的对偶情形）。 */
export function bumpGeneration(v: Version): Version {
  return version(v.documentVersion + 1, v.contentVersion ?? 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// 比较（引用是值 ⇒ 必须可比较）
// ─────────────────────────────────────────────────────────────────────────────

/** 两个 `EntityRef` 是否指同一实体（不比内容版本）。 */
export function sameEntity(a: EntityRef, b: EntityRef): boolean {
  return a.kind === b.kind && a.id === b.id
}

/** 两个 `ElementRef` 是否指同一元素（含拓扑版本）。 */
export function sameElement(a: ElementRef | undefined, b: ElementRef | undefined): boolean {
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined) return false
  return a.elementId === b.elementId && a.topologyVersion === b.topologyVersion
}

/** 两个 `PropertyRef` 是否指同一属性（含元素与分量）。 */
export function samePropertyRef(a: PropertyRef, b: PropertyRef): boolean {
  return sameEntity(a.owner, b.owner) && a.property === b.property && sameElement(a.element, b.element) && a.component === b.component
}

/**
 * 内容版本是否相同。
 *
 * 注意这里比的是 `contentVersion`（内容身份），**不是** `documentVersion`（单调计数）——
 * 「撤销回保存内容变干净」依赖这一条。
 */
export function sameContent(a: Version, b: Version): boolean {
  return (a.contentVersion ?? 0) === (b.contentVersion ?? 0)
}

/** 严格相同（两位都相同）。 */
export function sameVersion(a: Version, b: Version): boolean {
  return a.documentVersion === b.documentVersion && sameContent(a, b)
}

/**
 * `ElementRef` 在其拓扑版本下是否仍然有效。契约 §1.2：
 * 拓扑变化后旧引用必须返回 `StaleReference`，**不得静默猜配**。
 */
export function isElementRefCurrent(ref: ElementRef, currentTopologyVersion: number): boolean {
  return ref.topologyVersion === currentTopologyVersion
}

/** `EntityRef` 的内容版本是否与当前一致（无 `contentVersion` 者视为"不参与判定"）。 */
export function isEntityRefCurrent(ref: EntityRef, currentContentVersion: number): boolean {
  return ref.contentVersion === undefined || ref.contentVersion === currentContentVersion
}

// ─────────────────────────────────────────────────────────────────────────────
// 内容身份（纯摘要）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把值规范化成**键序稳定**的字符串。
 *
 * 为什么必须自己写：`JSON.stringify` 的键序依赖对象插入顺序，同一份语义内容用不同
 * 构造路径得到的字符串不同 ⇒ 摘要不同 ⇒ 撤销回保存内容后被判"仍脏"。
 * 规范化是内容身份可比较的前提。
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'number') {
    const n = value as number
    if (Number.isNaN(n)) return 'NaN'
    if (n === Infinity) return 'Infinity'
    if (n === -Infinity) return '-Infinity'
    return Object.is(n, -0) ? '0' : String(n)
  }
  if (t === 'string') return JSON.stringify(value)
  if (t === 'boolean') return value ? 'true' : 'false'
  if (t === 'undefined') return 'undefined'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (t === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`
  }
  // 函数/符号等不应出现在被摘要的领域值里；出现即视为不可序列化，显式标记而非静默忽略。
  return `«unserializable:${t}»`
}

/**
 * 内容身份摘要：FNV-1a 32 位。
 *
 * 纯函数（无 IO、无随机、无时钟），相同规范化输入恒得相同输出。
 * 32 位对"内容身份比较"足够：它只回答"是不是同一份内容"，
 * 不承担抗碰撞的安全职责（安全边界是内容边界的事）。
 */
export function contentDigest(serialized: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < serialized.length; i++) {
    h ^= serialized.charCodeAt(i) & 0xff
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** 对任意领域值取内容身份。 */
export function digestOf(value: unknown): number {
  return contentDigest(canonicalize(value))
}

// ─────────────────────────────────────────────────────────────────────────────
// 身份分配（**作为输入传入**，不在纯函数里凭空造身份）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 身份分配状态（**纯**）。
 *
 * 「需要时间、身份分配、能力、随机种子时，作为输入或状态传入」。
 *
 * 为什么是"状态 + 纯转移"而不是一个带计数器的可变分配器对象：
 * 对象式分配器在 `reduceCommand` 里 `next()` 会**修改输入**，直接违反
 * 「不改输入」的正断言，并把"执行器推进到哪一步"藏进了一个不参与版本比较的
 * 可变单例里 —— 那正是要消除的旧形态。做成状态后：
 * 同一 `(state, command, env)` 恒得同一 `(id 序列, 转移结果)`，重放自然成立。
 */
export interface IdState {
  readonly prefix: string
  /** 已分配数量；下一个 id 的序号是 `counter + 1`。 */
  readonly counter: number
}

export function idState(prefix: string, counter = 0): IdState {
  return Object.freeze({ prefix, counter })
}

/** 分配一个 id，返回 id 与推进后的分配状态（不修改入参）。 */
export function allocateId(s: IdState, kind: string): { readonly id: string; readonly next: IdState } {
  const ordinal = s.counter + 1
  return Object.freeze({
    id: `${s.prefix}-${kind}-${ordinal}`,
    next: Object.freeze({ prefix: s.prefix, counter: ordinal }),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 变更摘要
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 造变更摘要。契约 §1.4：仅创建了新容器**不**等于内容变化 ——
 * 那由调用方（`reduceCommand`）通过"内容身份是否改变"判定，不由本函数猜测。
 */
export function changeSummary(parts: {
  changedProperties?: readonly PropertyRef[]
  createdEntities?: readonly EntityRef[]
  removedEntities?: readonly EntityRef[]
  structurallyShared?: boolean
}): ChangeSummary {
  return Object.freeze({
    changedProperties: Object.freeze([...(parts.changedProperties ?? [])]) as readonly PropertyRef[],
    createdEntities: Object.freeze([...(parts.createdEntities ?? [])]) as readonly EntityRef[],
    removedEntities: Object.freeze([...(parts.removedEntities ?? [])]) as readonly EntityRef[],
    structurallyShared: parts.structurallyShared ?? false,
  })
}

/** 变更摘要是否为空（无任何属性/实体变化）。 */
export function isEmptyChange(c: ChangeSummary): boolean {
  return c.changedProperties.length === 0 && c.createdEntities.length === 0 && c.removedEntities.length === 0
}
