/**
 * `domain/multiblockSelection` —— **多方块通道选择**的领域投影。
 *
 * ## 本模块替代什么（单一语义，不再有第二处实现）
 *
 * 同一份"声明 + 当前取值 → 选择（totalTier/values/runstate）"的换算此前有两份：
 *
 * | 旧落点 | 旧语义 | 为什么不能并存 |
 * |---|---|---|
 * | `shared/viewport/multiblockChannelUi#initialMultiblockSelection` | 面板初值（Tier 吸附 `tierSample`） | 呈现层的位置：`runtime`/`composition` 不能 import 它（方向反），于是画面侧只能另写一份 |
 * | `composition/kernelAssembly#initialSelectionOfDeclaration` | 装载期装配初值（Tier 只按域夹取） | 与面板口径**不同**：未吸附抽样 ⇒ 两侧对"初始画面"给出不同选择 |
 *
 * "通道取值 = 有效值"（不再合成时间轨道），本模块把画面也接到**同一份取值**上
 * ⇒ 若两侧初值口径继续分裂，"初始画面"与"面板初始显示"会合法地不相等。故把
 * **选择投影**下沉到 domain（纯、无 Vue/DOM/IO），面板、装载装配、画面求值**同吃一处**。
 *
 * ## 保留键为什么在 domain
 *
 * `EditContext.channelValues` 的值域是 `Record<string, number>`，总档位与运行态用保留键
 * 承载（`$totalTier` / `$runstate`；`$` 不是合法声明键 ⇒ 结构性不冲突）。保留键是
 * **取值空间的契约**，不是某个会话实现的细节 ⇒ 放 domain，会话与视口都向下 import
 * （此前它长在 `runtime/kernelSession`，domain 无法 import 它 ⇒ 投影只能留在上层）。
 *
 * 纯度：不读 I/O、不读时钟、不碰 DOM/全局，不改动入参；同输入 ⇒ 同输出。
 */

import type {
  MultiblockChannel,
  MultiblockDeclaration,
  MultiblockRunstate,
} from './multiblockDocument'

/** 多方块**总档位**在 `EditContext.channelValues` 里的保留键。 */
export const TOTAL_TIER_CHANNEL = '$totalTier'

/**
 * 多方块**运行态**在 `EditContext.channelValues` 里的保留键。
 *
 * 值是运行态在声明里的**下标**（`channelValues` 的值类型是 `number`，
 * 契约 §1 如此规定）—— 故离散选择以序数表达。该口径差异已登记为已知缺口。
 */
export const RUNSTATE_CHANNEL = '$runstate'

/**
 * 多方块通道选择（装配的输入；字段与 `context/multiblock#MultiblockSelection` 逐字同形）。
 *
 * 载荷在`values`里恒为**声明值**（未设置写 0）：有效值（0 回落总档位、域夹取、耦合）
 * 是**装配期**产物，不是选择的字段（契约 §5.1/§5.2）。
 */
export interface MultiblockSelectionState {
  readonly totalTier: number
  readonly values: Readonly<Record<string, number>>
  readonly runstate: string
}

// ---------------------------------------------------------------------------
// 声明事实的结构最小面（面板与求值都只读这些字段）
// ---------------------------------------------------------------------------

export interface MultiblockChannelFacts {
  readonly key: string
  readonly name: string
  readonly kind: string
  readonly min: number
  readonly max: number
  readonly domain: Readonly<{ readonly lo: number; readonly hi: number }>
  readonly slider: boolean
}

export interface MultiblockRunstateFacts {
  readonly id: string
  readonly name: string
}

/**
 * 声明里"通道选择真正用到的"那一部分：域声明（{@link MultiblockDeclaration}）与
 * 解析侧形状都能指派（结构最小面，读的字段逐条写在这里）。
 */
export interface MultiblockDeclarationFacts {
  readonly displayName: string
  readonly totalTierDomain: Readonly<{ readonly min: number; readonly max: number; readonly default?: number }>
  readonly tierSample: readonly number[]
  readonly channels: readonly MultiblockChannelFacts[]
  readonly runstates: readonly MultiblockRunstateFacts[]
  readonly notes: readonly Readonly<{ readonly text: string }>[]
}

/** 域声明的通道类型（`MultiblockChannelFacts` 的超集；供类型收窄断言用）。 */
export type MultiblockChannelDeclaration = MultiblockChannel
/** 域声明的运行态类型。 */
export type MultiblockRunstateDeclaration = MultiblockRunstate

// ---------------------------------------------------------------------------
// 声明 → 滑杆域 / 初始取值 / 投影
// ---------------------------------------------------------------------------

/** 总 Tier 抽取值清单：显式 `tierSample` 优先，缺省 = 整个 `totalTierDomain`。 */
export function tierSampleValues(decl: MultiblockDeclarationFacts): number[] {
  const sample = decl.tierSample
  if (Array.isArray(sample) && sample.length > 0) {
    return [...sample].map((n) => Math.trunc(n)).sort((a, b) => a - b)
  }
  const out: number[] = []
  for (let i = Math.trunc(decl.totalTierDomain.min); i <= Math.trunc(decl.totalTierDomain.max); i++) out.push(i)
  return out
}

/**
 * Tier 吸附：把任意 Tier 值吸附到最近的**已声明**抽样值（并列取较小者）。
 *
 * 依据契约 §5.2/§5.4（装配只夹取/回落，不拒绝）。
 */
export function snapTierToSample(samples: readonly number[], tier: number): number {
  if (samples.length === 0) return Math.trunc(tier)
  const target = Math.trunc(tier)
  let best = samples[0]!
  for (const v of samples) {
    const d = Math.abs(v - target)
    const bd = Math.abs(best - target)
    if (d < bd || (d === bd && v < best)) best = v
  }
  return best
}

/** 通道取值夹到声明取值域 `0..domain.hi`；未声明的通道 key ⇒ `null`。 */
export function clampChannelValue(
  decl: MultiblockDeclarationFacts,
  key: string,
  value: number,
): number | null {
  const ch = decl.channels.find((c) => c.key === key)
  if (!ch) return null
  const v = Math.trunc(value)
  if (!Number.isFinite(v)) return 0
  return Math.min(Math.max(v, 0), ch.domain.hi)
}

/** 初始取值：Tier = `domain.default ?? max`（吸附抽样）、所有通道 Not set(0)、运行态 = 声明首项。 */
export function initialMultiblockSelection(decl: MultiblockDeclarationFacts): MultiblockSelectionState {
  const domain = decl.totalTierDomain
  const samples = tierSampleValues(decl)
  const rawDefault = Math.trunc(domain.default ?? domain.max)
  const inDomain = Math.min(Math.max(rawDefault, Math.trunc(domain.min)), Math.trunc(domain.max))
  const values: Record<string, number> = {}
  // 契约 §5.1：变体声明值**每个通道都有**（未设置写 0）——故全部通道入表。
  for (const c of decl.channels) values[c.key] = 0
  return {
    totalTier: snapTierToSample(samples, inDomain),
    values,
    runstate: decl.runstates[0]?.id ?? '',
  }
}

/**
 * **内核取值表 → 选择**（生产唯一投影）。
 *
 * ## 为什么以**声明初值**为底再叠加内核取值
 *
 * 契约 §5.1 明文：「变体声明值每个通道都有（未设置写 0）」——即 `values` 必须是**完整**表。
 * 若只回内核里出现过的键，用户只设了 `coil` 时 `{coil:2}` 会派生出**不同的变体键**
 * （缺 `height`/`glass`），面板与参考网格当场不符。
 *
 * 故：先取 {@link initialMultiblockSelection}（按契约填满），再用内核取值覆盖 ——
 * 「没设过」保持声明初值、「设过 0」保持 0（两者都写 0，但语义由内核键的存在表达）。
 */
export function projectMultiblockSelection(
  decl: MultiblockDeclarationFacts,
  values: Readonly<Record<string, number>>,
): MultiblockSelectionState {
  const base = initialMultiblockSelection(decl)
  const runstateIndex = values[RUNSTATE_CHANNEL]
  const runstate =
    typeof runstateIndex === 'number' && decl.runstates[runstateIndex] !== undefined
      ? decl.runstates[runstateIndex].id
      : base.runstate
  const totalTier = values[TOTAL_TIER_CHANNEL]
  const perChannel: Record<string, number> = { ...base.values }
  for (const [k, v] of Object.entries(values)) {
    if (k === TOTAL_TIER_CHANNEL || k === RUNSTATE_CHANNEL) continue
    perChannel[k] = v
  }
  return {
    totalTier: typeof totalTier === 'number' ? totalTier : base.totalTier,
    values: perChannel,
    runstate,
  }
}

/** 无声明时的空选择（帧为主文档 / 未装配）。**不伪造**通道值。 */
export const EMPTY_MULTIBLOCK_SELECTION: MultiblockSelectionState = Object.freeze({
  totalTier: 1,
  values: Object.freeze({}),
  runstate: '',
})
