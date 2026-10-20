/**
 * `composition/resolver` —— **纯装配解析与校验**（契约 §7；#249 §10）。
 *
 * ## 五类检测（#249 §10 明文，逐条落点）
 *
 * | 检测 | 函数 | 错误码 | 负对照 |
 * |---|---|---|---|
 * | **重复 ID** | `detectDuplicateIds` | `InvalidValue` | 两个模块同 id ⇒ 判红 |
 * | **循环依赖** | `detectCycles` | `InvalidValue` | A→B→A ⇒ 判红 |
 * | **缺失服务** | `detectMissingServices` | `MissingTarget` | 必需能力无提供者 ⇒ 判红 |
 * | **非法落点** | `computePruning` | （裁剪 + 原因） | 编辑器要求能力被裁剪 ⇒ 不在结果里 |
 * | **能力冲突** | `detectCapabilityConflicts` | `InvalidValue` | 两模块提供同一**排他**能力 ⇒ 判红 |
 *
 * ## 一个必须显式说清的取舍：能力冲突 vs 能力重复提供
 *
 * 「能力冲突」在本实现里**不是**"两个模块 provides 同一个能力 id" ——
 * 那太宽：契约 §7 要求"注册顺序不产生隐藏覆盖结果"，而多个模块提供同一**能力**
 * 在真实装配里是常态（`E` 与 `E2` 都提供 `evaluate`）。真正要拒绝的是
 * **同一 `provides` 集合的重复元素**、以及**同一具名落点的重复贡献**
 * （两个模块贡献同一个 `editorType` / `control.property` / `hostPort.portId`
 * / `shellLayout.shellId` / `objectType.type` / `command.commandId`
 * / `evaluationNode.nodeId`）—— 那些才是"后者胜出"的隐藏覆盖点。
 *
 * 这个取舍**必须**写清楚：含糊的"能力冲突"会让实现要么过宽（误伤正常装配）、
 * 要么过窄（放过真正的覆盖）。判据落在**具名落点**上，因为具名落点是
 * "谁是权威"的问题，而能力是"谁具备某本事"的问题（可多方具备）。
 *
 * ## 顺序不敏感（契约 §7 明文）
 *
 * 「解析结果对 `provides` 集合的**输入顺序不敏感**；冲突必须报错而非后者胜出」。
 * 实现方式：所有集合运算前先**排序**（`stableSort`），
 * 且 `resolveComposition` 的输出里所有数组顺序由 id 排序决定，不由输入顺序决定。
 * `resolveComposition` 的顺序不敏感性有专门断言（打乱输入 ⇒ 输出逐字节相同）。
 *
 * ## 裁剪记录（#257 H3「嵌入构建裁剪原因可查询」）
 *
 * `pruned` 是 `{ moduleId, reason, capability }[]` 的**有序**列表。
 * 它不是日志 —— 它是解析结果的一部分，可查询、可断言、可进诊断（#249 §19.9）。
 */

import { err, invalidValue, missingTarget, ok, unsupportedOperation, type DomainError, type Result } from '@/domain/errors'
import {
  CAPABILITY,
  type CapabilityId,
  type CommandContribution,
  type ControlContribution,
  type EditorContribution,
  type EvaluationNodeContribution,
  type HostPortContribution,
  type ModuleDecl,
  type ModuleId,
  type ObjectTypeContribution,
  type ProfileId,
  type ShellLayoutContribution,
} from './modules'

// ─────────────────────────────────────────────────────────────────────────────
// 解析结果
// ─────────────────────────────────────────────────────────────────────────────

/** 某模块被裁剪的原因（H3：可查询）。 */
export interface PruningRecord {
  readonly moduleId: ModuleId
  /** 结构化原因码（稳定，不随语言变化）。 */
  readonly reason: 'missingOptionalCapability' | 'missingRequiredCapability'
  /** 缺失的能力（`missingRequiredCapability` 时同时是失败原因，见 `failures`）。 */
  readonly capability: CapabilityId
}

/** 解析失败项（必需能力缺失等）。 */
export interface AssemblyFailure {
  readonly moduleId: ModuleId
  readonly reason: 'duplicateId' | 'cycle' | 'missingRequiredCapability' | 'capabilityConflict' | 'invalidLanding'
  readonly error: DomainError
  readonly detail: string
}

/**
 * 装配解析结果。
 *
 * `modules` 是**已通过校验并裁剪**的模块集合；`capabilities` 是它们的 `provides` 并集
 * （**排序后**，故顺序不敏感）。
 *
 * `pruned` 记录"哪些模块的哪些**可选**依赖缺失 ⇒ 被裁剪"。
 * 注意：可选依赖缺失只裁剪**该能力对应的落点**，不裁剪整个模块 ——
 * 否则一个可选依赖会连带弄掉模块的核心能力，那是过宽。
 * 本实现把这一层细化到**落点**：`prunedLandings` 列出被摘掉的具体落点。
 */
export interface Assembly {
  readonly profileId: ProfileId
  readonly modules: readonly ModuleDecl[]
  readonly capabilities: readonly CapabilityId[]
  /** 被采纳的七类贡献（已合并、已排序）。 */
  readonly contributions: ResolvedContributions
  readonly pruned: readonly PruningRecord[]
  /** 被摘掉的具体落点（H3：裁剪原因可查询到落点粒度）。 */
  readonly prunedLandings: readonly PrunedLanding[]
}

export interface PrunedLanding {
  readonly kind: 'editor' | 'shellLayout' | 'command'
  readonly id: string
  readonly moduleId: ModuleId
  readonly missingCapability: CapabilityId
}

export interface ResolvedContributions {
  readonly objectTypes: readonly { readonly moduleId: ModuleId; readonly contribution: ObjectTypeContribution }[]
  readonly evaluationNodes: readonly { readonly moduleId: ModuleId; readonly contribution: EvaluationNodeContribution }[]
  readonly commands: readonly { readonly moduleId: ModuleId; readonly contribution: CommandContribution }[]
  readonly editors: readonly { readonly moduleId: ModuleId; readonly contribution: EditorContribution }[]
  readonly controls: readonly { readonly moduleId: ModuleId; readonly contribution: ControlContribution }[]
  readonly hostPorts: readonly { readonly moduleId: ModuleId; readonly contribution: HostPortContribution }[]
  readonly shellLayouts: readonly { readonly moduleId: ModuleId; readonly contribution: ShellLayoutContribution }[]
}

/** 解析的**失败**结果（含全部失败项，不只第一条）。 */
export interface AssemblyError {
  readonly failures: readonly AssemblyFailure[]
}

/**
 * 装配解析结果。
 *
 * **为什么不复用 `Result<T>`**：`Result<T>` 的错误分支是单个 `DomainError`
 * （契约 §0 记号），而装配失败**天然是一组** —— 缺一个能力会同时影响多个模块。
 * 把它压成单个 `DomainError` 会丢掉"还有哪些模块也坏了"，
 * 而那正是装配诊断最有用的部分（#249 §19.9）。
 * 故本函数用自己的 `AssemblyResult`，并且每个 `AssemblyFailure` **内部**都带一个
 * 标准 `DomainError`（错误码仍是冻结的八码之一，不发明本地错误码）。
 */
export type AssemblyResult = { readonly ok: true; readonly value: Assembly } | { readonly ok: false; readonly error: AssemblyError }

// ─────────────────────────────────────────────────────────────────────────────
// 单个检测器（每个都能独立跑 + 独立做负对照）
// ─────────────────────────────────────────────────────────────────────────────

/** 稳定排序：全部顺序由 id 文本序决定，与输入顺序无关。 */
export function stableSort<T>(items: readonly T[], key: (t: T) => string): readonly T[] {
  return Object.freeze([...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)))
}

/** 检测 1：**重复 ID**。 */
export function detectDuplicateIds(modules: readonly ModuleDecl[]): readonly AssemblyFailure[] {
  const seen = new Map<ModuleId, number>()
  const out: AssemblyFailure[] = []
  for (const m of stableSort(modules, (x) => x.id)) {
    const n = (seen.get(m.id) ?? 0) + 1
    seen.set(m.id, n)
    if (n === 2) {
      out.push(
        Object.freeze({
          moduleId: m.id,
          reason: 'duplicateId' as const,
          error: invalidValue({ reason: 'duplicateModuleId', moduleId: m.id }),
          detail: `模块 id ${m.id} 出现多次（第 ${n} 次起报）。重复 id 会让"哪个是权威"变成注册顺序的函数。`,
        }),
      )
    }
  }
  return Object.freeze(out)
}

/** 展开 `composes`（profile 作组合模块）：返回扁平模块集合。 */
export function expandComposition(modules: readonly ModuleDecl[]): Result<readonly ModuleDecl[]> {
  const byId = new Map<ModuleId, ModuleDecl>()
  for (const m of modules) if (!byId.has(m.id)) byId.set(m.id, m)
  const out: ModuleDecl[] = []
  const visiting = new Set<ModuleId>()
  const done = new Set<ModuleId>()
  let cycle: string | null = null

  const visit = (id: ModuleId, path: readonly ModuleId[]): void => {
    if (done.has(id)) return
    if (visiting.has(id)) {
      if (cycle === null) cycle = [...path, id].join(' → ')
      return
    }
    const m = byId.get(id)
    // 未提供的组合成员：不是"静默跳过"—— 记为一次显式失败（见下）
    if (!m) {
      out.push(
        Object.freeze({ id, provides: Object.freeze([]), note: `composes 引用了未提供的模块 ${id}` }),
      )
      return
    }
    visiting.add(id)
    for (const child of stableSort(m.composes ?? [], (x) => x)) visit(child, [...path, id])
    visiting.delete(id)
    done.add(id)
    out.push(m)
  }

  for (const id of stableSort([...byId.keys()], (x) => x)) visit(id, [])
  if (cycle !== null) {
    return err(invalidValue({ reason: 'compositionCycle', path: cycle }))
  }
  return ok(Object.freeze(out))
}

/**
 * 检测 2：**循环依赖**。
 *
 * ## 依赖边怎么建（本实现的一处关键判定）
 *
 * `requires` / `optionalRequires` 的元素是**能力 id**，不是模块 id；
 * `composes` 的元素才是模块 id。故"模块 A 依赖模块 B"的边必须由
 * **能力 → 提供者**的映射导出：
 *
 * ```
 * 边(A → B)  ⟺  ∃c ∈ requires(A) ∪ optionalRequires(A) ∪ composes(A):
 *                c ∈ provides(B)  或  c === B.id
 * ```
 *
 * 若漏掉这一步（直接把 `requires` 里的字符串当模块 id 查表），
 * 环检测会在**任何**使用能力名的装配上静默返回空 —— 那是典型的假绿
 * （本批实测过一次：A→B→C→A 的循环返回 0 个环）。这条注释就是为了防止它被改回去。
 *
 * ## 报告完整环路
 *
 * 三色 DFS，报出**环路路径**而不只是"有环"：只报"有环"会让调用方无法定位，
 * 而装配错误通常需要人读（#249 §19.9 诊断关联）。
 */
export function detectCycles(modules: readonly ModuleDecl[]): readonly AssemblyFailure[] {
  const byId = new Map<ModuleId, ModuleDecl>()
  for (const m of modules) if (!byId.has(m.id)) byId.set(m.id, m)

  /** 能力 id → 提供它的模块 id 集合（多提供者取全部，因为任一条边都可能成环）。 */
  const providers = new Map<string, ModuleId[]>()
  for (const m of stableSort(modules, (x) => x.id)) {
    for (const c of m.provides) {
      const list = providers.get(c)
      if (list) list.push(m.id)
      else providers.set(c, [m.id])
    }
  }

  const deps = (m: ModuleDecl): readonly ModuleId[] => {
    const out = new Set<ModuleId>()
    for (const c of [...(m.requires ?? []), ...(m.optionalRequires ?? [])]) {
      // `requires` 里若写的是模块 id（`composes` 风格），也算一条边
      if (byId.has(c)) out.add(c)
      for (const p of providers.get(c) ?? []) if (p !== m.id) out.add(p)
    }
    for (const c of m.composes ?? []) if (byId.has(c) && c !== m.id) out.add(c)
    return stableSort([...out], (x) => x)
  }

  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<ModuleId, number>()
  const seen = new Set<string>()
  const out: AssemblyFailure[] = []

  const dfs = (id: ModuleId, stack: readonly ModuleId[]): void => {
    color.set(id, GRAY)
    const m = byId.get(id)
    const next = m ? deps(m) : []
    for (const dep of next) {
      const c = color.get(dep) ?? WHITE
      if (c === GRAY) {
        const at = stack.indexOf(dep)
        const path = [...(at >= 0 ? stack.slice(at) : stack), dep]
        const key = path.join('→')
        if (!seen.has(key)) {
          seen.add(key)
          out.push(
            Object.freeze({
              moduleId: dep,
              reason: 'cycle' as const,
              error: invalidValue({ reason: 'dependencyCycle', path: key }),
              detail: `循环依赖：${path.join(' → ')}`,
            }),
          )
        }
      } else if (c === WHITE && byId.has(dep)) {
        dfs(dep, [...stack, dep])
      }
    }
    color.set(id, BLACK)
  }

  for (const id of stableSort([...byId.keys()], (x) => x)) {
    if ((color.get(id) ?? WHITE) === WHITE) dfs(id, [id])
  }
  return Object.freeze(out)
}

/** 检测 3：**缺失服务**（必需能力无提供者）。 */
export function detectMissingServices(modules: readonly ModuleDecl[]): readonly AssemblyFailure[] {
  const provided = new Set<CapabilityId>()
  for (const m of modules) for (const c of m.provides) provided.add(c)
  const out: AssemblyFailure[] = []
  for (const m of stableSort(modules, (x) => x.id)) {
    for (const c of stableSort(m.requires ?? [], (x) => x)) {
      if (provided.has(c)) continue
      out.push(
        Object.freeze({
          moduleId: m.id,
          reason: 'missingRequiredCapability' as const,
          error: missingTarget({ moduleId: m.id, capability: c, kind: 'required' }),
          detail: `模块 ${m.id} 的**必需**能力 ${c} 无任何提供者 ⇒ 启动失败（契约 §7）。`,
        }),
      )
    }
  }
  return Object.freeze(out)
}

/** 七类具名落点的键提取（供冲突检测与合并）。 */
function landingKeys(m: ModuleDecl): readonly { readonly kind: PrunedLanding['kind'] | 'objectType' | 'evaluationNode' | 'control' | 'hostPort'; readonly id: string }[] {
  const c = m.contributes
  const out: { kind: 'objectType' | 'evaluationNode' | 'command' | 'editor' | 'control' | 'hostPort' | 'shellLayout'; id: string }[] = []
  for (const x of c?.objectTypes ?? []) out.push({ kind: 'objectType', id: x.type })
  for (const x of c?.evaluationNodes ?? []) out.push({ kind: 'evaluationNode', id: x.nodeId })
  for (const x of c?.commands ?? []) out.push({ kind: 'command', id: x.commandId })
  for (const x of c?.editors ?? []) out.push({ kind: 'editor', id: x.editorType })
  for (const x of c?.controls ?? []) out.push({ kind: 'control', id: x.property })
  for (const x of c?.hostPorts ?? []) out.push({ kind: 'hostPort', id: x.portId })
  for (const x of c?.shellLayouts ?? []) out.push({ kind: 'shellLayout', id: x.shellId })
  return out
}

/**
 * 检测 4：**能力冲突 / 非法落点**。
 *
 * 两类，都报 `InvalidValue`：
 *  a. **同一模块的 `provides` 里有重复项** —— 重复项会让"能力计数"失真，
 *     且它是"注册顺序产生隐藏结果"的一种形态。
 *  b. **同一具名落点被多个模块贡献** —— 这才是真正的"后者胜出"隐藏覆盖点。
 *     （能力可多方提供，见文件头取舍说明。）
 *
 * 另外检测"模块自己 provides 又 requires 同一能力" —— 那不是错误（自足模块），
 * 但**报为非法落点**会让判据过宽，故不检测。
 */
export function detectCapabilityConflicts(modules: readonly ModuleDecl[]): readonly AssemblyFailure[] {
  const out: AssemblyFailure[] = []

  for (const m of stableSort(modules, (x) => x.id)) {
    const dups = duplicates(m.provides)
    for (const d of dups) {
      out.push(
        Object.freeze({
          moduleId: m.id,
          reason: 'capabilityConflict' as const,
          error: invalidValue({ reason: 'duplicateProvides', moduleId: m.id, capability: d }),
          detail: `模块 ${m.id} 的 provides 里 ${d} 重复出现。`,
        }),
      )
    }
  }

  const owners = new Map<string, { moduleId: ModuleId; kind: string }>()
  for (const m of stableSort(modules, (x) => x.id)) {
    for (const k of stableSort(landingKeys(m), (x) => `${x.kind}:${x.id}`)) {
      const key = `${k.kind}:${k.id}`
      const prev = owners.get(key)
      if (prev === undefined) {
        owners.set(key, { moduleId: m.id, kind: k.kind })
        continue
      }
      if (prev.moduleId === m.id) {
        out.push(
          Object.freeze({
            moduleId: m.id,
            reason: 'capabilityConflict' as const,
            error: invalidValue({ reason: 'duplicateLandingWithinModule', landing: key, moduleId: m.id }),
            detail: `模块 ${m.id} 内部重复贡献落点 ${key}。`,
          }),
        )
        continue
      }
      out.push(
        Object.freeze({
          moduleId: m.id,
          reason: 'capabilityConflict' as const,
          error: invalidValue({ reason: 'landingConflict', landing: key, first: prev.moduleId, second: m.id }),
          detail: `落点 ${key} 被 ${prev.moduleId} 与 ${m.id} **同时**贡献 ⇒ 拒绝（契约 §7：冲突必须报错而非后者胜出）。`,
        }),
      )
    }
  }
  return Object.freeze(out)
}

function duplicates(items: readonly string[]): readonly string[] {
  const count = new Map<string, number>()
  for (const i of items) count.set(i, (count.get(i) ?? 0) + 1)
  return [...count.entries()].filter(([, n]) => n > 1).map(([k]) => k).sort()
}

// ─────────────────────────────────────────────────────────────────────────────
// 裁剪（可选落点被裁剪并记录原因 —— 契约 §7）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 计算**裁剪**：某编辑器/外壳布局/命令声明的能力在本装配里不存在 ⇒ 该**落点**被摘掉，
 * 并留下可查询的原因。
 *
 * 精细度是刻意的：只摘**落点**，不摘整个模块 ——
 * 否则一个可选依赖会连带弄掉模块的核心能力（过宽）。
 */
export function computePruning(
  modules: readonly ModuleDecl[],
  capabilities: ReadonlySet<CapabilityId>,
): { readonly pruned: readonly PruningRecord[]; readonly prunedLandings: readonly PrunedLanding[]; readonly kept: readonly ModuleDecl[] } {
  const pruned: PruningRecord[] = []
  const landings: PrunedLanding[] = []
  const kept: ModuleDecl[] = []

  for (const m of stableSort(modules, (x) => x.id)) {
    const missingOptional = stableSort(m.optionalRequires ?? [], (x) => x).filter((c) => !capabilities.has(c))
    for (const c of missingOptional) {
      pruned.push(Object.freeze({ moduleId: m.id, reason: 'missingOptionalCapability' as const, capability: c }))
    }
    const missingSet = new Set(missingOptional)

    // 摘落点：只摘"其 requires 命中缺失可选能力"的那几个
    const c = m.contributes
    const keptEditors = (c?.editors ?? []).filter((e) => {
      const miss = e.requires.find((r) => missingSet.has(r))
      if (miss === undefined) return true
      landings.push(Object.freeze({ kind: 'editor' as const, id: e.editorType, moduleId: m.id, missingCapability: miss }))
      return false
    })
    const keptShells = (c?.shellLayouts ?? []).filter((sh) => {
      const miss = sh.regions.find((r) => missingSet.has(r))
      if (miss === undefined) return true
      landings.push(Object.freeze({ kind: 'shellLayout' as const, id: sh.shellId, moduleId: m.id, missingCapability: miss }))
      return false
    })
    const keptCommands = (c?.commands ?? []).filter((cmd) => {
      const miss = cmd.requires.find((r) => missingSet.has(r))
      if (miss === undefined) return true
      landings.push(Object.freeze({ kind: 'command' as const, id: cmd.commandId, moduleId: m.id, missingCapability: miss }))
      return false
    })

    kept.push(
      Object.freeze({
        ...m,
        contributes: Object.freeze({
          ...(c ?? {}),
          ...(c?.editors ? { editors: Object.freeze(keptEditors) } : {}),
          ...(c?.shellLayouts ? { shellLayouts: Object.freeze(keptShells) } : {}),
          ...(c?.commands ? { commands: Object.freeze(keptCommands) } : {}),
        }),
      }),
    )
  }
  return Object.freeze({
    pruned: Object.freeze(pruned),
    prunedLandings: Object.freeze(landings),
    kept: Object.freeze(kept),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 解析（唯一入口）
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolveInput {
  readonly profileId: ProfileId
  /** 全部可用模块（静态装配：一次给全，不做运行期加载）。 */
  readonly modules: readonly ModuleDecl[]
}

/**
 * 解析一次装配。
 *
 * 顺序（**先便宜后昂贵、先全局后局部**）是刻意的：
 *  1. 重复 id（全局结构错误，必须先报 —— 它会让后续所有按 id 的查表歧义）；
 *  2. 组合展开（`composes`）+ 环检测；
 *  3. 缺失必需能力；
 *  4. 能力/落点冲突；
 *  5. 裁剪可选落点。
 *
 * **失败即返回全部失败项**（不只第一条）：只报第一条会让调用方修一个跑一次，
 * 而装配错误通常是成批的（例如某能力整个缺失会一次影响多个模块）。
 */
export function resolveComposition(input: ResolveInput): AssemblyResult {
  const failures: AssemblyFailure[] = []

  failures.push(...detectDuplicateIds(input.modules))
  if (failures.length > 0) return { ok: false, error: Object.freeze({ failures: Object.freeze(failures) }) }

  const expanded = expandComposition(input.modules)
  if (!expanded.ok) {
    failures.push(
      Object.freeze({
        moduleId: '<composition>',
        reason: 'cycle' as const,
        error: expanded.error,
        detail: `组合展开失败：${expanded.error.code} ${JSON.stringify(expanded.error.params)}`,
      }),
    )
    return { ok: false, error: Object.freeze({ failures: Object.freeze(failures) }) }
  }

  // 组合展开会产出重复（子模块同时被 profile 与另一 profile 引用）⇒ 去重并保持稳定顺序
  const flat = dedupeById(expanded.value)

  failures.push(...detectCycles(flat))
  if (failures.length > 0) return { ok: false, error: Object.freeze({ failures: Object.freeze(failures) }) }

  failures.push(...detectMissingServices(flat))
  if (failures.length > 0) return { ok: false, error: Object.freeze({ failures: Object.freeze(failures) }) }

  failures.push(...detectCapabilityConflicts(flat))
  if (failures.length > 0) return { ok: false, error: Object.freeze({ failures: Object.freeze(failures) }) }

  const capabilities = Object.freeze(stableSort([...new Set(flat.flatMap((m) => [...m.provides]))], (x) => x))
  const capSet = new Set(capabilities)
  const { pruned, prunedLandings, kept } = computePruning(flat, capSet)

  return {
    ok: true,
    value: Object.freeze({
      profileId: input.profileId,
      modules: stableSort(kept, (m) => m.id),
      capabilities,
      contributions: mergeContributions(kept),
      pruned,
      prunedLandings,
    }),
  }
}

function dedupeById(modules: readonly ModuleDecl[]): readonly ModuleDecl[] {
  const seen = new Set<ModuleId>()
  const out: ModuleDecl[] = []
  for (const m of modules) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
  }
  return Object.freeze(out)
}

/** 合并七类贡献（合并后按 id 排序 ⇒ 顺序由 id 决定，不由注册顺序决定）。 */
function mergeContributions(modules: readonly ModuleDecl[]): ResolvedContributions {
  const objectTypes: { moduleId: ModuleId; contribution: ObjectTypeContribution }[] = []
  const evaluationNodes: { moduleId: ModuleId; contribution: EvaluationNodeContribution }[] = []
  const commands: { moduleId: ModuleId; contribution: CommandContribution }[] = []
  const editors: { moduleId: ModuleId; contribution: EditorContribution }[] = []
  const controls: { moduleId: ModuleId; contribution: ControlContribution }[] = []
  const hostPorts: { moduleId: ModuleId; contribution: HostPortContribution }[] = []
  const shellLayouts: { moduleId: ModuleId; contribution: ShellLayoutContribution }[] = []

  for (const m of stableSort(modules, (x) => x.id)) {
    const c = m.contributes
    for (const x of c?.objectTypes ?? []) objectTypes.push({ moduleId: m.id, contribution: x })
    for (const x of c?.evaluationNodes ?? []) evaluationNodes.push({ moduleId: m.id, contribution: x })
    for (const x of c?.commands ?? []) commands.push({ moduleId: m.id, contribution: x })
    for (const x of c?.editors ?? []) editors.push({ moduleId: m.id, contribution: x })
    for (const x of c?.controls ?? []) controls.push({ moduleId: m.id, contribution: x })
    for (const x of c?.hostPorts ?? []) hostPorts.push({ moduleId: m.id, contribution: x })
    for (const x of c?.shellLayouts ?? []) shellLayouts.push({ moduleId: m.id, contribution: x })
  }

  return Object.freeze({
    objectTypes: Object.freeze(stableSort(objectTypes, (x) => `${x.contribution.type}@${x.moduleId}`)),
    evaluationNodes: Object.freeze(stableSort(evaluationNodes, (x) => `${x.contribution.nodeId}@${x.moduleId}`)),
    commands: Object.freeze(stableSort(commands, (x) => `${x.contribution.commandId}@${x.moduleId}`)),
    editors: Object.freeze(stableSort(editors, (x) => `${x.contribution.editorType}@${x.moduleId}`)),
    controls: Object.freeze(stableSort(controls, (x) => `${x.contribution.property}@${x.moduleId}`)),
    hostPorts: Object.freeze(stableSort(hostPorts, (x) => `${x.contribution.portId}@${x.moduleId}`)),
    shellLayouts: Object.freeze(stableSort(shellLayouts, (x) => `${x.contribution.shellId}@${x.moduleId}`)),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 从装配结果派生运行输入（A15 的核心）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **可达模块图**（A15「构建查看器并检查构建模块图」的判定面）。
 *
 * 定义：从 `entryModuleIds` 出发，沿 `requires`/`optionalRequires`/`composes`
 * 反向（**被依赖**方向）不可达、但**实际被采纳**的模块集合。
 *
 * 为什么需要它：A15 要求「内容编辑 handlers/操纵工具**不在可达模块图**」。
 * 一个只隐藏按钮的实现会仍然 import 编辑模块 ⇒ 它在可达图里 ⇒ 判红。
 * 本函数是那条判据的**执行面**：它只看声明与解析结果，不看 DOM、不看运行时。
 */
export function reachableModules(assembly: Assembly, entryModuleIds: readonly ModuleId[]): readonly ModuleId[] {
  // 静态装配下"可达" = 在采纳集合里、且被 entry（或 entry 的组合成员）经由
  // requires/optionalRequires/composes 引用，或自己就是 entry。
  const byId = new Map(assembly.modules.map((m) => [m.id, m]))
  const out = new Set<ModuleId>()
  const stack = [...entryModuleIds]
  while (stack.length > 0) {
    const id = stack.pop() as ModuleId
    const m = byId.get(id)
    if (!m) continue
    if (out.has(id)) continue
    out.add(id)
    for (const dep of [...(m.composes ?? []), ...(m.requires ?? []), ...(m.optionalRequires ?? [])]) stack.push(dep)
  }
  return Object.freeze(stableSort([...out], (x) => x))
}

/**
 * 从装配结果派生**运行时能力集合**（`ExecutionInputs.capabilities` 的真源）。
 *
 * 这是 A15「运行时绕 UI 发编辑命令被拒绝」的接线点：
 * 查看器 profile 的装配结果里没有 `content.edit` ⇒ `reduceCommand` 的能力闸门
 * 直接返回 `UnsupportedOperation`（契约 §3.2）。
 * **不是** UI 隐藏按钮，而是执行器根本不具备该能力。
 */
export function capabilitiesOf(assembly: Assembly): readonly CapabilityId[] {
  return assembly.capabilities
}

/** 该项能力是否存在于装配（供接线层与测试查询）。 */
export function hasCapability(assembly: Assembly, capability: CapabilityId): boolean {
  return assembly.capabilities.includes(capability)
}

/**
 * 装配结果里的**内容编辑可达性**（A15 主判据的装配面）。
 *
 * 返回 `true` 表示"这个构建具备内容编辑能力"；查看器构建必须返回 `false`。
 */
export function hasContentEditing(assembly: Assembly): boolean {
  if (hasCapability(assembly, CAPABILITY.CONTENT_EDIT)) return true
  return assembly.contributions.editors.some((e) => e.contribution.contentEditing)
}

/** 编辑器落点清单（裁剪后）。 */
export function editorLandings(assembly: Assembly): readonly EditorContribution[] {
  return Object.freeze(assembly.contributions.editors.map((e) => e.contribution))
}

/** 未使用的类型出口占位（保持契约类型可达）。 */
export type { ModuleDecl, ProfileId, DomainError }
export { unsupportedOperation }
