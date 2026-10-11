/**
 * `presentation/multiblockEvaluation` —— **多方块网格求值节点**（#289 P10d 的 D2）。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | `buildMultiblockRenderView(doc, outcome, frameIndex)` —— 在**视口层**构造渲染视图文档 | `shared/viewport/multiblockChannelUi.ts` | 同一语义升格为**求值节点**：显式输入（声明 + 取值）、纯、可缓存、由内容身份驱动失效 |
 * | `useKernelChannels.renderDoc` 每次取值变化重算 + `contentRefreshTick` 手动请求重读 | `shared/viewport/useKernelChannels.ts` | 求值产物带**版本化身份**；失效由 `computeInvalidation` 的节点声明判定，不由调用方声明 |
 *
 * ## 为什么它是"求值节点"而不是"文档变更"（#249 §3.3/§7 的边界）
 *
 * Lead 裁决（#289 交办）逐字要求：多方块**声明 + 通道取值是输入，网格是求值产物**。
 * 故正确形态是：
 *
 * ```
 * 求值节点「声明内容版本 + 通道取值版本 → 网格」
 * ```
 *
 * 而**不是**"通道一变就改写内核文档里的网格"。后者会把求值结果写进文档内容，
 * 制造**脏文档**与**幽灵历史** —— 与 #249 禁止的「动画输出反写手动取值」同族。
 *
 * 本模块因此**只读**输入、只产出**值**（渲染视图文档 + 身份），不碰 `Document`。
 *
 * ## 纯性（#249 §2.1）
 *
 * 无 IO、无 DOM、无时钟、无 Vue、无全局：同一 `(declaration, selection, frameIndex)`
 * 必然得到同一结果。故它可在 vitest 里直接断言（无需宿主），也天然可缓存。
 *
 * ## 节点身份与失效（G1/A11 的落点）
 *
 * {@link evaluationNodeDependency} 声明该节点**真正读**的东西：
 *  - `collections`：声明对象的成员（变了 ⇒ 重算）；
 *  - `contentDigest`：声明内容 + 取值 + 帧下标的摘要（变了 ⇒ 重算）；
 *  - **不**声明 `documentVersion` —— 否则"改一个注解文字"会让网格重算，
 *    而 G1 明文要求那种改动**不**重建方块几何（见 `invalidationPlan` 文件头）。
 */

import { contentDigestOf, type NodeDependency } from './invalidationPlan'

/** 通道取值选择（与 `context/multiblock` 的 `MultiblockSelection` 同形）。 */
export interface MultiblockSelectionInput {
  readonly totalTier: number
  readonly values: Readonly<Record<string, number>>
  readonly runstate: string
}

/**
 * 求值输入：**声明内容**（由装配产物承载的类型化声明）+ **取值** + **帧下标**。
 *
 * ## 为什么"声明"用不透明值而不是 `MultiblockDecl`
 *
 * 本层（`presentation/`）不得依赖 `context/`（旧层）—— 那正是 §15「新门面包旧核心」
 * 要防的。故声明以 `unknown` 传入，**只用于摘要**（`contentDigestOf` 是结构稳定的
 * 纯哈希，不读具体字段）。真正需要读懂声明的是**装配**那一步，它在
 * `composition/` 层（装配根可 import 全部层），由调用方注入为 {@link GridAssembler}。
 *
 * 这条分工让"求值节点"与"装配实现"解耦：节点负责**判定与身份**，
 * 装配实现负责**读懂声明并算出网格**。
 */
export interface MultiblockEvaluationInput {
  /** 文档/场景身份（进摘要；换文档必然重算）。 */
  readonly sceneId: string
  /** 类型化声明的**内容**（进摘要；不在此层解读）。 */
  readonly declarationContent: unknown
  /** 当前取值。 */
  readonly selection: MultiblockSelectionInput
  /** 当前帧下标（影响注入哪一帧）。 */
  readonly frameIndex: number
  /**
   * 装配实现（**注入**；返回 `null` = 该取值装配不出网格）。
   *
   * 注入而非 import：本层不能依赖 `composition/`（那会形成
   * `presentation → composition → presentation` 的环）。
   */
  readonly assemble: GridAssembler
}

/**
 * 装配端口：给定声明内容与取值，产出"网格"（不透明值）+ 一条可选提示。
 *
 * 返回 `null` ⇒ 该取值装配不出网格（未声明组合且回落失败等）。
 * 调用方据此**保留上一次可渲染结果**（与旧 `assembleForSelection` 的取舍一致：
 * 装配异常不穿透到 UI）。
 */
export type GridAssembler = (
  selection: MultiblockSelectionInput,
) => { readonly grid: unknown; readonly notice?: string } | null

/**
 * 求值产物。
 *
 * ## `identity` 的用途（A11/G1 的机械判据面）
 *
 * 它是"这份网格是谁"的**内容派生**身份：同输入 ⇒ 同身份。于是：
 *  - 机位变化**不**改它（机位不进摘要）⇒ 几何重建数为 0；
 *  - 取值变化**改**它 ⇒ 网格重算；
 *  - 声明内容变化**改**它 ⇒ 网格重算。
 *
 * 三个判据都能由 `identity` 的相等性直接读出，不需要读任何渲染状态。
 */
export interface MultiblockEvaluationResult {
  /** 内容派生的求值身份（`e:<hash>`）。 */
  readonly identity: string
  /** 装配出的网格（不透明值；`null` = 本次装配不出，调用方保留上次结果）。 */
  readonly grid: unknown
  /** 提示（未声明组合 / 夹取 / 文件软约束）；逐条可显示。 */
  readonly notices: readonly string[]
  /** 该取值是否命中**已声明**的组合（契约 §5.2 推论 3 的判定面）。 */
  readonly declared: boolean
}

/**
 * 求值身份：由**读集**机械派生（`sceneId` + 声明内容 + 取值 + 帧下标）。
 *
 * **不含机位/选择/布局** —— 那些不是本节点的读集（它们属视图投影节点）。
 * 这条区分是 A11 的实现落点：把机位计进身份会让"转视角"重算几何。
 */
export function evaluationIdentityOf(input: {
  readonly sceneId: string
  readonly declarationContent: unknown
  readonly selection: MultiblockSelectionInput
  readonly frameIndex: number
}): string {
  return `e:${contentDigestOf([
    input.sceneId,
    input.declarationContent,
    // 取值按**键序稳定**序列化（`contentDigestOf` 内部走 `stableStringify`）
    input.selection.values,
    input.selection.totalTier,
    input.selection.runstate,
    input.frameIndex,
  ])}`
}

/**
 * **求值**：声明 + 取值 → 网格 + 身份 + 提示。
 *
 * 纯函数。装配失败**不抛错**：返回 `grid: null` + 一条提示，由调用方保留上一次
 * 可渲染结果（与旧 `assembleForSelection` 同一取舍 —— "装配异常不穿透到 UI"）。
 */
export function evaluateMultiblock(input: MultiblockEvaluationInput): MultiblockEvaluationResult {
  const identity = evaluationIdentityOf({
    sceneId: input.sceneId,
    declarationContent: input.declarationContent,
    selection: input.selection,
    frameIndex: input.frameIndex,
  })
  let assembled: ReturnType<GridAssembler>
  try {
    assembled = input.assemble(input.selection)
  } catch (e) {
    // 装配可能因文件缺陷抛错（旧实现同样捕获）。**不**穿透：
    // 返回 null + 提示，调用方保留上一次可渲染结果。
    return Object.freeze({
      identity,
      grid: null,
      notices: Object.freeze([`装配失败（已保留上一次可渲染结果）：${String(e)}`]),
      declared: false,
    })
  }
  if (assembled === null) {
    return Object.freeze({
      identity,
      grid: null,
      notices: Object.freeze(['该取值装配不出网格（未声明组合且无回落结果）']),
      declared: false,
    })
  }
  const notices: string[] = []
  if (assembled.notice !== undefined) notices.push(assembled.notice)
  return Object.freeze({
    identity,
    grid: assembled.grid,
    notices: Object.freeze(notices),
    declared: true,
  })
}

/**
 * 该求值节点的**依赖声明**（供 `computeInvalidation` 判定）。
 *
 * ## 为什么这样声明（每一条都对应一个可断言的事实）
 *
 * | 字段 | 值 | 判据 |
 * |---|---|---|
 * | `target` | `'geometry'` | 它产出的是**几何**（网格）；A11 的读数 `recomputeCounts.geometry` 正是它 |
 * | `inputs` | `[]` | **不**声明任何求值键维度 —— 尤其**不**声明 `documentVersion`（否则改注解会重算几何，G1 判红） |
 * | `collections` | 声明对象成员 | 声明集合的成员变化（增删声明）⇒ 重算 |
 * | `contentDigest` | 读集摘要 | 声明内容 + 取值变化 ⇒ 重算（由 `evaluationIdentityOf` 同源派生） |
 *
 * ## 为什么 `inputs` 是空数组而不是 `['time']`
 *
 * 帧下标确实是本节点的输入（它决定注入哪一帧）。但它**不**是 `EvaluationKey.time`：
 * 多方块的帧是**变体存储**（`variant`/`runstate`/`stepIndex`），换帧由**取值**驱动，
 * 不是由播放时间驱动。声明 `['time']` 会让"播放推进"重算几何 —— 而多方块的
 * 几何只随**取值**变。故帧下标进 `contentDigest`（它是读集的一部分），
 * 而 `inputs` 保持空。
 */
export function evaluationNodeDependency(input: {
  readonly nodeId: string
  readonly declarationMembers: readonly string[]
  readonly identity: string
}): NodeDependency {
  return Object.freeze({
    nodeId: input.nodeId,
    target: 'geometry' as const,
    inputs: Object.freeze([]) as readonly never[],
    collections: Object.freeze([
      Object.freeze({ collectionId: `${input.nodeId}:declaration`, membersDigest: membersDigestFor(input.declarationMembers) }),
    ]),
    contentDigest: input.identity,
  })
}

/** 成员身份集合摘要（转发 `invalidationPlan` 的同族实现，口径不复制）。 */
function membersDigestFor(memberIds: readonly string[]): string {
  const sorted = [...memberIds].sort()
  let hash = 0x811c9dc5
  for (const id of sorted) {
    for (let i = 0; i < id.length; i++) {
      hash ^= id.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    hash ^= 0x2c
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `m:${(hash >>> 0).toString(16).padStart(8, '0')}:${sorted.length}`
}
