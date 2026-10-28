/**
 * RNA 的**唯一写路由** —— 受控属性命令（纯核心）。
 *
 * 依据：`docs/contracts/web-kernel-contracts.md` §3.1（写面）、§4.1（`CommandOutcome`）、
 * §4.3（多选原子性）、§2.1（读面清单）。
 *
 * ## 为什么「唯一」不是一句口号
 *
 * 内核契约 §4.1 的判据是**结构性的**：
 *
 * - 没有 JS `Proxy` 隐式截获赋值，没有 setter 旁路（本模块内不存在对目标对象的属性赋值）；
 * - 没有暴露任意字段 patch 的通用命令（`SetPropertyCommand` 的 `refs`/`value` 是**类型化**的，
 *   且每个 `ref` 必须经 `describeProperty` 命中注册的声明，否则拒绝）；
 * - 移动多对象、删除对象、插入关键帧等**保持具名命令**（本模块的 `routeCommand`
 *   对「不在目录里的命令」返回 `UnsupportedOperation`，因此不存在「用 patch 绕过
 *   跨属性不变量」的入口）；
 * - **调用方不传任意 setter 闭包**：真正的业务写入是**注册**在对象类型上的
 *   `PropertyWriteHandler`（`PropertyWritePorts.write`），由装配层注入一次，
 *   调用方只能给 `PropertyRef` + 值。
 *
 * 这条区分是关键的：旧实现的 `descriptor.set(owner, value)` 就是「调用方拿到一个闭包
 * 直接改内存」。注册式 handler 把「谁能写、写了要经过什么纯函数」变成装配期事实，
 * 而不是每次调用时由 UI 决定。
 *
 * ## 状态与 `Transition` 的对接（**已登记的集成点**）
 *
 * `applySetProperty(state: Readonly<ApplicationState>, …, env): Transition`
 * 中，`ApplicationState` 与 `Transition` 的**定义**属调用方（`domain/document` +
 * `runtime/execution`）。本模块**不**抢先定义它们（否则就是
 * 「发明本地版本再互相映射」）。
 *
 * 本模块因此对状态**泛型**：`applySetProperty<S>` 返回 `PropertyWriteTransition<S>`
 * （候选状态 + `CommandOutcome` + 效果描述）。调用方以 `S = ApplicationState`
 * 实例化并把 `transition.candidate` 接进它自己的 `Transition` 即可 ——
 * 语义（原子批次、三分支结算、错误分类）与契约逐条一致，无需改本模块。
 *
 * ## 多选原子性（内核契约 §4.3）
 *
 * 「一个目标不可改即整体拒绝并列明原因，不静默部分成功」的实现方式是
 * **先全量预检、再单次提交**：
 *  1. 每个目标单独求值（描述/可编辑性/值校验/过期引用）——任一步失败即**收集原因**；
 *  2. 任一目标失败 ⇒ 返回 `rejected`，`candidate` **就是输入状态本身**（引用相等，
 *     因此「部分失败整体不变」可以被断言成 `===`，不是「看起来相等」）；
 *  3. 全部通过 ⇒ 才逐个调用 handler 得到候选状态。
 *
 * 第 2 步用引用相等是刻意的：只比较内容相等会放过「重建了一个容器」的实现，
 * 而负对照正是「新建相同内容容器即记账」必须判红。
 *
 * ## 纯度
 *
 * 无 Vue/Three/DOM/IO；不读全局时钟（时间/身份进 `PropertyWriteEnv`）；
 * 不改输入（候选状态由 handler 返回，原状态只读）。允许内部使用不逃逸的临时可变结构
 */

import {
  type ChangeSummary,
  type CommandOutcome,
  type DomainError,
  type EntityOwnerKind,
  type PropertyId,
  type PropertyRef,
  type Result,
  type Version,
  appliedOutcome,
  domainError,
  err,
  ok,
  rejectedOutcome,
  unchangedOutcome,
} from './contracts'
import {
  type CommandCatalog,
  type Editability,
  type EffectiveSources,
  type MixedValue,
  type ObjectTypeDecl,
  type PropertyAccess,
  type PropertyDescriptor,
  type PropertyRegistry,
  type PropertyValue,
  type PropertyValueType,
  type ReadMode,
  MIXED_VALUE,
  dedupeRefs,
  diagnosticKeyOf,
  evaluateEditability,
  readProperty,
} from './properties'

// ─────────────────────────────────────────────────────────────────────────────
// 1. 写入端口（注册式，非调用方闭包）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一次属性写的**显式环境**（需要时间/身份/能力时作为输入传入）。
 *
 * `facts` / `capabilities` / 原始值读面都由 `PropertyAccess` 提供（读写**共用同一份**），
 * 本结构只补写面特有的两项：起点版本与效果收集器。
 */
export type PropertyWriteEnv = Readonly<{
  /** 提交所依据的起点版本；与当前版本不符 ⇒ `VersionConflict`（内核契约 §4.2）。 */
  readonly baseVersion: Version
  /** 当前版本（= `access.version`，单列以便起点校验自明）。 */
  readonly currentVersion: Version
  /**
   * 效果描述收集器：纯函数**不隐式发事件**，
   * 只把「需要发出的效果」写成描述返回；发起归 runtime。
   */
  readonly recordEffect?: (effect: PropertyEffect) => void
}>

/** 效果描述（纯数据；由执行器发起，不由纯函数直接执行）。 */
export type PropertyEffect = Readonly<{
  kind: 'propertyChanged'
  refs: readonly PropertyRef[]
  objectId: string
}>

/**
 * 业务写入的**纯函数**（按对象类型注册）。
 *
 * 契约：显式输入、**不改输入**（返回新状态）、不依赖 Vue/Three/DOM/时钟/IO。
 * 返回的候选状态在**全部目标都通过后**才被采纳。
 */
export type PropertyWriteHandler<S> = (
  state: Readonly<S>,
  ref: PropertyRef,
  value: PropertyValue,
  context: Readonly<{ descriptor: PropertyDescriptor; env: PropertyWriteEnv }>,
) => Result<S>

/** 写入端口表：对象类型 ID → 写入纯函数。 */
export interface PropertyWritePorts<S> {
  write(objectTypeId: string, handler: PropertyWriteHandler<S>): void
  handler(objectTypeId: string): PropertyWriteHandler<S> | undefined
  objectTypeIds(): readonly string[]
}

export function createPropertyWritePorts<S>(): PropertyWritePorts<S> {
  const handlers = new Map<string, PropertyWriteHandler<S>>()
  return {
    write(objectTypeId, handler) {
      handlers.set(objectTypeId, handler)
    },
    handler: (objectTypeId) => handlers.get(objectTypeId),
    objectTypeIds: () => [...handlers.keys()],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. SetProperty 命令（类型化；唯一通用属性写）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 通用属性写命令。
 *
 * `value` 允许 `'mixed'`：在**写**面上它的含义是「不做**值**校验的批次」——
 * 但本实现**拒绝**它（见 `applySetProperty`）。理由：`'mixed'` 是**读面**表达
 * 「多选值不同」的显式哨兵，把它当写值会让「保持各自原值」变成一次隐式写入，
 * 而跨属性不变量必须在命令层显式表达（那是具名命令的职责）。
 * 拒绝而不是猜测，符合「实现不得依赖未冻结语义」。
 */
export type SetPropertyCommand = Readonly<{
  kind: 'setProperty'
  refs: readonly PropertyRef[]
  value: PropertyValue | MixedValue
  /** 诊断关联。 */
  commandId?: string
}>

/** 具名命令的**已知**种类（已登记的具名命令；其余通道由贡献方声明）。 */
export type NamedCommandKind =
  | 'moveObjects'
  | 'deleteObjects'
  | 'insertKeyframe'
  | 'removeKeyframe'
  | 'setTracksEnabled'
  | (string & {})

/**
 * 具名命令（**保持具名**）。
 *
 * 具名命令的 `payload` 由**命令描述**（`CommandCatalog`）声明参数域，
 * 因此「任意字段 patch」没有入口：参数不在描述里 ⇒ `UnsupportedOperation`。
 */
export type NamedCommand = Readonly<{
  kind: 'named'
  id: string
  params: Readonly<Record<string, PropertyValue>>
  commandId?: string
}>

export type PropertyCommand = SetPropertyCommand | NamedCommand

/** 命令路由结果（纯）。 */
export type CommandRoute =
  | Readonly<{ route: 'propertyWrite'; command: SetPropertyCommand }>
  | Readonly<{ route: 'named'; command: NamedCommand }>
  | Readonly<{ route: 'rejected'; error: DomainError }>

/**
 * 命令路由 —— **唯一**入口判定（「菜单/按钮/快捷键/命令搜索共用同一命令 ID
 * 与参数描述」；未知命令**不得**落到「通用字段写」上）。
 *
 * 判据：
 *  1. `setProperty` ⇒ 属性写路由（仍需逐 ref 的描述解析才能写入）；
 *  2. `named` 且目录中登记 ⇒ 具名路由（参数域由目录声明）；
 *  3. `named` 但未登记 ⇒ `UnsupportedOperation`（**不**降级为字段 patch）；
 *  4. 其它形态 ⇒ `UnsupportedOperation`（不存在隐式通路）。
 */
export function routeCommand(catalog: CommandCatalog, command: unknown): CommandRoute {
  if (!isRecord(command)) {
    return { route: 'rejected', error: domainError('UnsupportedOperation', { reason: 'malformed-command' }) }
  }
  if (command.kind === 'setProperty') {
    const refs = command.refs
    if (!Array.isArray(refs)) {
      return {
        route: 'rejected',
        error: domainError('UnsupportedOperation', { reason: 'malformed-command', detail: 'refs' }),
      }
    }
    return { route: 'propertyWrite', command: command as unknown as SetPropertyCommand }
  }
  if (command.kind === 'named') {
    const id = typeof command.id === 'string' ? command.id : ''
    const desc = catalog.get(id)
    if (!desc) {
      return {
        route: 'rejected',
        error: domainError('UnsupportedOperation', { reason: 'unknown-command', command: id }),
      }
    }
    if (desc.genericPropertyWrite === true) {
      return {
        route: 'rejected',
        error: domainError('UnsupportedOperation', { reason: 'generic-write-must-use-setProperty', command: id }),
      }
    }
    return { route: 'named', command: command as unknown as NamedCommand }
  }
  return {
    route: 'rejected',
    error: domainError('UnsupportedOperation', {
      reason: 'unknown-command-kind',
      kind: String((command as { kind?: unknown }).kind ?? 'undefined'),
    }),
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 转移结果
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 属性命令的转移结果：候选状态 + 结算 + 效果描述。
 *
 * `applied` ⇒ `candidate` 是新状态；`unchanged` / `rejected` ⇒ `candidate`
 * **就是输入状态本身**（引用相等），因此「拒绝后文档/历史/脏状态不变」是可断言的。
 */
export type PropertyWriteTransition<S> = Readonly<{
  candidate: Readonly<S>
  outcome: CommandOutcome
  effects: readonly PropertyEffect[]
}>

// ─────────────────────────────────────────────────────────────────────────────
// 4. 逐目标判定（预检，不产生任何写入）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一个目标的写入判定 —— 就是「多选一个失败则整体拒绝**并列明**的原因」那一项。
 *
 * 原因分两处保留：
 *  - `error`：**第一手**失败原因（可编辑性给出的结构化 `DomainError`，
 *    或值校验 / 描述解析失败）；
 *  - `editability`：**完整**可编辑性求值结果（含 `because` 动态事实清单），
 *    供诊断面与「静态 readonly 开关」负对照使用。
 */
export type WriteProbe = Readonly<{
  ref: PropertyRef
  descriptor: PropertyDescriptor | null
  editability: Editability
  currentValue: Result<PropertyValue>
  accepted: boolean
  error: DomainError | null
}>

/**
 * 求值一个目标的写入可行性（**纯**，不写任何东西）。
 *
 * 顺序：描述解析 → 可编辑性（动态）→ 值校验 → 有效值冲突检查。
 * 与 `readAuthoredValue` 共用同一份事实与校验路径，因此**读写同构**
 * （旧实现里 get/set 是各自独立的闭包，读写不同构）。
 */
export function probeWrite(
  registry: PropertyRegistry,
  ref: PropertyRef,
  value: PropertyValue,
  access: PropertyAccess,
): WriteProbe {
  const editability = evaluateEditability(registry, ref, access)
  const base: Omit<WriteProbe, 'descriptor' | 'currentValue' | 'accepted' | 'error'> = { ref, editability }

  const desc = registry.descriptor(ref.property)
  if (!desc) {
    return {
      ...base,
      descriptor: null,
      currentValue: err(domainError('MissingTarget', { reason: 'property-not-registered', property: ref.property })),
      accepted: false,
      error: editability.reason ?? domainError('MissingTarget', { reason: 'property-not-registered', property: ref.property }),
    }
  }

  const currentValue = readProperty(registry, ref, 'authored', access)
  if (!editability.editable) {
    return { ...base, descriptor: desc, currentValue, accepted: false, error: editability.reason }
  }

  const handler = registry.valueTypeHandler(desc.valueType)
  if (!handler) {
    return {
      ...base,
      descriptor: desc,
      currentValue,
      accepted: false,
      error: domainError('UnsupportedOperation', {
        reason: 'unknown-value-type',
        valueType: desc.valueType,
        property: desc.id,
      }),
    }
  }

  // 值校验：分量寻址时只针对该分量（其余分量保持各自现值 —— 「不把任意小数
  // 写成非法取值」的同构要求：不因为改一个分量而重写另外两个）。
  const validation = validateIncoming(registry, desc, value, ref)
  if (!validation.ok) {
    return { ...base, descriptor: desc, currentValue, accepted: false, error: validation.error }
  }
  return { ...base, descriptor: desc, currentValue, accepted: true, error: null }
}

/**
 * 校验传入值：整体值与「分量写」两条路径。
 *
 * 分量写（`ref.component !== undefined`）要求传入的是**单个数值**，
 * 其余分量由 handler 保持 —— 这是「分量动画与标量动画共用寻址」在写面的含义
 * （契约 §1.3 选择理由）。
 */
function validateIncoming(
  registry: PropertyRegistry,
  desc: PropertyDescriptor,
  value: PropertyValue,
  ref: PropertyRef,
): Result<PropertyValue> {
  // `null` 的受理权在**描述**，不在值类型 handler。
  // 理由：`null` 有没有意义是**属性**的性质（`linkedAnnotationId = null` 有意义，
  // `pos = null` 无意义），不是值类型的性质。未声明 `nullable` 的属性被置空时
  // 返回 `InvalidValue`（**值域**问题）而非 `UnsupportedOperation`（能力/实现问题）——
  // 这个区分让调用方的分支稳定：值错就改值，能力缺就换 profile。
  if (value === null) {
    if (!desc.nullable) {
      return err(
        domainError('InvalidValue', {
          reason: 'not-nullable',
          property: desc.id,
          valueType: desc.valueType,
        }),
      )
    }
    if (ref.component !== undefined) {
      return err(
        domainError('InvalidValue', { reason: 'component-of-null', property: desc.id, component: ref.component }),
      )
    }
    return ok(null)
  }
  const handler = registry.valueTypeHandler(desc.valueType)
  if (!handler) {
    return err(domainError('UnsupportedOperation', { reason: 'unknown-value-type', valueType: desc.valueType }))
  }
  const ctx = {
    ...(desc.domain ? { domain: desc.domain } : {}),
    ...(desc.unit ? { unit: desc.unit } : {}),
    display: desc.display,
  }
  if (ref.component !== undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return err(
        domainError('InvalidValue', {
          reason: 'component-requires-number',
          property: desc.id,
          component: ref.component,
        }),
      )
    }
    return ok(value)
  }
  return handler.validate(value, ctx)
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. applySetProperty —— 多选原子批次
// ─────────────────────────────────────────────────────────────────────────────

export type ApplySetPropertyArgs<S> = Readonly<{
  registry: PropertyRegistry
  ports: PropertyWritePorts<S>
  state: Readonly<S>
  command: SetPropertyCommand
  /** 写面特有的显式输入（起点版本、效果收集器）。 */
  env: PropertyWriteEnv
  /**
   * 读写**共用**的访问面：原始值、动态事实、能力、语言、一致版本。
   *
   * 读写共用同一份 `PropertyAccess` 是刻意的 —— 旧实现里 `get`/`set` 是各自独立的
   * 闭包（读写不同构），本设计让「同一目标、
   * 同一版本下读到的东西」与「写入要过的判据」出自同一组事实。
   */
  access: PropertyAccess
  /** 有效值来源（暂存/预览/轨道采样）—— 仅用于**读面**判定，不改变写入语义。 */
  effective?: (ref: PropertyRef) => EffectiveSources
}>

/**
 * 通用属性写：**唯一的**属性写路由。
 *
 * 结算语义（逐条对契约）：
 *  - 起点版本不符 ⇒ `rejected` + `VersionConflict`（不越序应用）；
 *  - 命令值 `'mixed'` ⇒ `rejected` + `UnsupportedOperation`（见 `SetPropertyCommand` 注释）；
 *  - `refs` 为空 ⇒ `unchanged`（没有目标是**无业务变化**，不是错误）；
 *  - 任一目标不可写 / 值非法 / 引用过期 ⇒ `rejected`，`candidate === state`，
 *    且**列明每个目标的**结构化原因；
 *  - 全部目标合法但**值未变** ⇒ `unchanged`（无业务变化返回 unchanged）；
 *  - 至少一个目标确实变化 ⇒ `applied`，`changes.changedProperties` 只列**真正变化**的引用，
 *    `structurallyShared` 表示候选是否与输入共享未变子树。
 */
export function applySetProperty<S>(args: ApplySetPropertyArgs<S>): PropertyWriteTransition<S> {
  const { registry, ports, state, command, env, access } = args
  const version = access.version

  if (!sameVersion(env.baseVersion, version)) {
    return reject(
      state,
      domainError('VersionConflict', {
        reason: 'stale-base-version',
        expected: version.documentVersion,
        base: env.baseVersion.documentVersion,
        commandId: command.commandId ?? '',
      }),
    )
  }

  const refs = dedupeRefs(command.refs)
  if (refs.length === 0) return unchanged(state, version)

  if (command.value === MIXED_VALUE) {
    return reject(
      state,
      domainError('UnsupportedOperation', {
        reason: 'mixed-value-is-read-only-sentinel',
        commandId: command.commandId ?? '',
      }),
    )
  }
  const value = command.value as PropertyValue

  // ── ① 全量预检（不产生任何写入）──
  const probes = refs.map((ref) => probeWrite(registry, ref, value, access))
  const failures = probes.filter((p) => !p.accepted)
  if (failures.length > 0) {
    return reject(state, aggregateFailure(failures, refs.length, command.commandId))
  }

  // ── ② 无业务变化 ⇒ unchanged（保持未改分支身份：candidate 就是 state）──
  const changed: PropertyRef[] = []
  for (const p of probes) {
    if (!p.descriptor) continue
    const handler = registry.valueTypeHandler(p.descriptor.valueType)
    if (!handler) continue
    const target = incomingFor(p, value)
    const normalizedIncoming = handler.normalize ? handler.normalize(target, valueCtxOf(p.descriptor)) : target
    if (!p.currentValue.ok) {
      changed.push(p.ref) // 现值读不到但目标可写：本次写入是变化（不掩盖缺失）
      continue
    }
    if (!valuesEqual(registry, p.descriptor, p.currentValue.value, normalizedIncoming, p.ref)) {
      changed.push(p.ref)
    }
  }
  if (changed.length === 0) return unchanged(state, version)

  // ── ③ 单次提交：逐个调用注册的纯业务函数 ──
  let candidate: Readonly<S> = state
  const changedRefs: PropertyRef[] = []
  for (const p of probes) {
    if (!p.descriptor) continue
    if (!changed.some((c) => sameRef(c, p.ref))) continue
    const handler = ports.handler(p.descriptor.objectTypeId)
    if (!handler) {
      return reject(
        state,
        domainError('UnsupportedOperation', {
          reason: 'no-write-handler',
          objectType: p.descriptor.objectTypeId,
          property: p.descriptor.id,
          commandId: command.commandId ?? '',
        }),
      )
    }
    const written = handler(candidate, p.ref, incomingFor(p, value), { descriptor: p.descriptor, env })
    if (!written.ok) {
      // handler 内部失败：**整体拒绝**（候选状态被丢弃，返回输入状态本身）
      return reject(state, written.error)
    }
    candidate = written.value
    changedRefs.push(p.ref)
  }

  const changes: ChangeSummary = {
    changedProperties: changedRefs,
    createdEntities: [],
    removedEntities: [],
    structurallyShared: candidate === state,
  }
  const effects: PropertyEffect[] = []
  const byObject = new Map<string, PropertyRef[]>()
  for (const ref of changedRefs) {
    const list = byObject.get(ref.owner.id) ?? []
    list.push(ref)
    byObject.set(ref.owner.id, list)
  }
  for (const [objectId, list] of byObject) {
    effects.push({ kind: 'propertyChanged', refs: list, objectId })
  }
  if (env.recordEffect) for (const e of effects) env.recordEffect(e)

  return { candidate, outcome: appliedOutcome(version, changes), effects }
}

function incomingFor(p: WriteProbe, value: PropertyValue): PropertyValue {
  return p.ref.component !== undefined ? value : value
}

function valuesEqual(
  registry: PropertyRegistry,
  desc: PropertyDescriptor,
  current: PropertyValue,
  incoming: PropertyValue,
  ref: PropertyRef,
): boolean {
  const handler = registry.valueTypeHandler(desc.valueType)
  if (!handler) return false
  if (ref.component !== undefined) {
    // 分量比较：整体值取出该分量后与传入值比。
    const name = ['x', 'y', 'z', 'w'][ref.component]
    if (name === undefined) return false
    const cur = (current as unknown as Record<string, number>)[name]
    return cur === incoming
  }
  return handler.equals(current, incoming)
}

function valueCtxOf(desc: PropertyDescriptor) {
  return {
    ...(desc.domain ? { domain: desc.domain } : {}),
    ...(desc.unit ? { unit: desc.unit } : {}),
    display: desc.display,
  }
}

function sameVersion(a: Version, b: Version): boolean {
  return a.documentVersion === b.documentVersion && a.contentVersion === b.contentVersion
}

function sameRef(a: PropertyRef, b: PropertyRef): boolean {
  if (a.property !== b.property || a.component !== b.component) return false
  if (a.owner.kind !== b.owner.kind || a.owner.id !== b.owner.id) return false
  if (a.element === undefined || b.element === undefined) return a.element === b.element
  return a.element.elementId === b.element.elementId && a.element.topologyVersion === b.element.topologyVersion
}

function reject<S>(state: Readonly<S>, error: DomainError): PropertyWriteTransition<S> {
  return { candidate: state, outcome: rejectedOutcome(error), effects: [] }
}

function unchanged<S>(state: Readonly<S>, version: Version): PropertyWriteTransition<S> {
  return { candidate: state, outcome: unchangedOutcome(version), effects: [] }
}

/**
 * 把多个目标的失败聚合成**一个**错误，同时把逐目标原因保留在 `params`（「列明原因」）。
 *
 * 聚合规则（确定性，可断言）：
 *  - 全部同码同原因 ⇒ 返回该错误 + `targets` 计数；
 *  - 否则 `code` 取**第一个**失败目标的码（顺序 = 命令里的 refs 顺序，可重现），
 *    `params.reasons` 是稳定的 `ref → 诊断键` 摘要串。
 *
 * 为什么不用「错误数组」当返回值：内核契约 §4.1 的 `rejected` 携带**一个** `DomainError`，
 * 而 `DomainError` 的分类是冻结的八项。多原因是**诊断**，进 `params`；
 * 分类保持稳定 —— 否则调用方的重试/呈现分支要处理「一个列表的错误码」。
 */
export function aggregateFailure(
  failures: readonly WriteProbe[],
  totalTargets: number,
  commandId?: string,
): DomainError {
  const first = failures[0]!.error ?? domainError('InvalidValue', { reason: 'unknown' })
  const reasons = failures
    .map((f) => `${f.ref.owner.kind}:${f.ref.owner.id}.${f.ref.property}=${diagnosticKeyOf(f.error)}`)
    .join(';')
  const sameCode = failures.every((f) => (f.error ?? first).code === first.code)
  return domainError(
    first.code,
    {
      ...first.params,
      failedTargets: failures.length,
      totalTargets,
      reasons,
      homogeneous: sameCode ? 1 : 0,
    },
    commandId ? { commandId } : {},
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. 混合值读面（多选）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 多选混合值读面（**显式** `'mixed'`，不用 `null` 兼表）。
 *
 * 返回：
 *  - 全部目标读不到 ⇒ 第一个错误（结构化）；
 *  - 目标之间值不同 ⇒ `'mixed'`；
 *  - 全相同 ⇒ 该值。
 *
 * 混合判定用 handler 的 `equals`（不是 `===`），因此「结构相同但对象不同」
 * 不会被误报为混合（对照负对照「新建相同内容容器即记账」）。
 */
export type MultiReadResult =
  | Readonly<{ kind: 'value'; value: PropertyValue }>
  | Readonly<{ kind: 'mixed'; refs: readonly PropertyRef[] }>
  | Readonly<{ kind: 'error'; error: DomainError }>

export function readMultiValue(
  registry: PropertyRegistry,
  refs: readonly PropertyRef[],
  mode: ReadMode,
  access: PropertyAccess,
  sources?: (ref: PropertyRef) => EffectiveSources | undefined,
): MultiReadResult {
  const unique = dedupeRefs(refs)
  if (unique.length === 0) {
    return { kind: 'error', error: domainError('MissingTarget', { reason: 'no-targets' }) }
  }
  let shared: PropertyValue | null = null
  let sharedDesc: PropertyDescriptor | null = null
  const mixedRefs: PropertyRef[] = []
  let firstError: DomainError | null = null

  for (const ref of unique) {
    const src = sources?.(ref)
    const read = readProperty(registry, ref, mode, access, src)
    if (!read.ok) {
      if (firstError === null) firstError = read.error
      continue
    }
    const desc = registry.descriptor(ref.property)
    if (!desc) continue
    if (shared === null) {
      shared = read.value
      sharedDesc = desc
      continue
    }
    const handler = registry.valueTypeHandler(desc.valueType)
    if (!sharedDesc || sharedDesc.valueType !== desc.valueType || !handler) {
      mixedRefs.push(ref)
      continue
    }
    if (!handler.equals(shared, read.value)) mixedRefs.push(ref)
  }

  if (shared === null) {
    return { kind: 'error', error: firstError ?? domainError('MissingTarget', { reason: 'no-readable-targets' }) }
  }
  if (mixedRefs.length > 0) return { kind: 'mixed', refs: mixedRefs }
  return { kind: 'value', value: shared }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. 对象类型注册的写入侧便利封装
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一次性注册「对象类型声明 + 它的写入纯函数」——装配层用。
 *
 * 把两者绑定在同一处是刻意的：声明（可写什么）与业务写入（怎么写）**必须成对**，
 * 否则会出现「声明了可写但没有 handler」（运行时 `UnsupportedOperation`）
 * 或「有 handler 但没声明」（不存在，因为 `ref` 必须先命中描述）。
 */
export function registerWritableObjectType<S>(
  registry: PropertyRegistry,
  ports: PropertyWritePorts<S>,
  decl: ObjectTypeDecl,
  handler: PropertyWriteHandler<S>,
): Result<ObjectTypeDecl> {
  const registered = registry.registerObjectType(decl)
  if (!registered.ok) return registered
  ports.write(decl.id, handler)
  return registered
}

/** 拥有者种类 → 可写对象类型 ID（诊断/覆盖度查询用）。 */
export function writableObjectTypesForOwner(
  registry: PropertyRegistry,
  kind: EntityOwnerKind,
): readonly string[] {
  return registry.describeOwnerKind(kind).map((d) => d.objectTypeId).filter((v, i, a) => a.indexOf(v) === i)
}

/** 属性 ID → 是否可被通用 `SetProperty` 合法写入（**不含**动态状态求值）。 */
export function isPropertyWritable(registry: PropertyRegistry, propertyId: PropertyId, valueType?: PropertyValueType): boolean {
  const desc = registry.descriptor(propertyId)
  if (!desc) return false
  if (desc.readOnly) return false
  if (valueType !== undefined && desc.valueType !== valueType) return false
  return true
}
