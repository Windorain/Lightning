/**
 * **精简遍历集**（`552 → 69`）——逐条论证的抽样，不是"跑快点"。
 *
 * ## 为什么可以删（判据上界：内容互异类）
 *
 * 遍历用例的通过判据是「`definition.cellGrid` 与参考展开网格在 `idMeta` 口径下**逐格 diff = 0**」
 * （逐格 diff 判据，见 `multiblock-channel-traversal.spec.ts` 文件头）。这条判据的**分辨力上界**
 * 就是"参考内容里有多少个互异的值"——实测（用门禁自己消费的那批参考产物复算，
 * 开发期交叉核对脚本）：
 *
 * | fixture | 声明组合 | 互异 idMeta 内容 | 类规模 |
 * |---|---|---|---|
 * | `multiblock-ebf-2ch.json` | 432 | **17** | 96,96,24,24,24,22,18,16,14,14,14,14,12,12,12,10,10 |
 * | `multiblock-tier-only.json` | 12 | **12** | 全 1 |
 * | `multiblock-lsc-overlap.json` | 108 | **14** | 12,12,10,9,9,8,8,8,6,6,6,6,4,4 |
 * | 合计 | **552** | **43** | |
 *
 * 即 552 条等式里只有 **43 条互异**，其余 509 条与其类代表**逐格相同**。逐条配对账本
 * （`omitted → sameAs`）由 `buildReducedTraversal()` 机械产出，见 `pairing`。
 *
 * ## 保留了哪些**区分力**（删减不许降判据强度）
 *
 * 精简集 `S` 由三类**职责不同**的成员取并：
 *
 * 1. `classReps` —— 每个内容类一名代表：保证"不存在没有任何组合断言过的期望内容"；
 * 2. `witnesses` —— **轴跃迁见证**：对每条轴（各通道 / 总 Tier / 运行态）的每对相邻档，
 *    取一条"其余轴固定、仅该轴不同"且**内容确实不同**的组合对。这直接守住
 *    「滑杆没接线也会绿」这条防线：任一轴失效 ⇒ 该轴必有一条见证变红；
 * 3. `levelCover` —— 逐档覆盖：每个通道的每个声明档、每个 tierSample、每个运行态
 *    至少被驱动一次 DOM（保证滑杆/下拉的**每一档**都真的走过浏览器事件路径）。
 *
 * ⚠️ 轴一律用**声明值**（DOM 实际驱动的量），**不**用"有效值"。有效值需要在本文件里
 * 复制产品侧的域夹取/回落/耦合语义才能算出来 —— 那等于在测试里写第二份实现
 * （本项目"两份实现必然漂移"已三度实测）。声明轴见证已足以让"滑杆未接线"必红。
 *
 * ## 已登记盲轴（**如实登记，不假装覆盖**）—— EBF 的运行态轴**已出盲**
 *
 * 本清单的语义是"该轴在**内容口径**下完全不改变内容 ⇒ 该轴无跃迁可验"。
 *
 * ### 旧状态（已被实测推翻）
 *
 * 原文登记：`multiblock-ebf-2ch.json` 的运行态轴在 `idMeta`（`name:meta`）口径下 216 对
 * 「仅运行态不同」的组合**全部内容相同**（盲率 100%）—— 参考侧把控制器格从并集下标 `7`
 * 写到 `8`，两条条目 `name:meta` 相同（都是 `gt.blockmachines:1000`），差异只在 `tooltip`
 * 与 `nbt.activeFace`。当时的结论"运行态在渲染面结构性不可分辨"**已不成立**（见下）。
 *
 * ### 现在：见证口径改「内容级」，盲轴清空
 *
 * 两个事实同时变了，且都是机械可复核的：
 *
 * | 事实 | 旧 | 现在 |
 * |---|---|---|
 * | **见证口径** | `idMeta`（门禁口径）—— 结构上看不见 `tooltip`/`nbt` | **`full`（内容口径）**：条目全文（含 `tooltip`/`nbt`） |
 * | **渲染面可辨性** | 实测不可辨（`cellGrid`+`blockPalette` 两次全文相同） | 已可辨（e2e 门禁：逐字节变化 + active 带 running 形态；根因是失效判定读面只含名称级调色板身份） |
 *
 * ⚠️ **两种口径各司其职，不混用**（这是本文件最容易做错的一处）：
 *
 * | 用途 | 口径 | 为什么 |
 * |---|---|---|
 * | **轴跃迁见证**（"这条轴到底改不改变内容？"） | `full`（内容级） | 内容的变化包括条目内容；用 `idMeta` 会把"改了条目内容"误判成"没变" ⇒ 造出**假盲轴** |
 * | **内容类代表 / 省略配对 / 逐格门禁** | `idMeta`（名称级） | 它是**跨实现**的稳定身份（参考侧并集调色板 ↔ 渲染侧重编号调色板）；渲染管线被要求保留的正是它，门禁的"逐格 diff=0"才有确定含义 |
 *
 * 诚实边界（不夸大防线）：见证进精简集 ⇒ 该轴的两档都会被 **DOM 驱动一次**并在门禁口径下
 * 断言收敛（"运行态装配错网格"这类缺陷会红）；而"运行态**内容**是否真的被送到渲染面"
 * 由**产品级判据**承担（`multiblock-channel-traversal.spec.ts` 的「运行态可辨（EBF，门禁）」）
 * 与单元级身份判据（`src/runtime/__tests__/runstateContentIdentity.test.ts`）——
 * `idMeta` 门禁对它**没有**分辨力，这一点不作隐瞒。
 */

import {
  enumerateExpectedCombos,
  panelContractFor,
  PANEL_CONTRACTS,
  type ExpectedCombo,
} from './panelContract'
import { snapshotOrFallbackReference, type SignatureGrid, type SignatureMode } from './referenceGrids'

/** 精简集的构造与自证结果。 */
export interface ReducedTraversalSet {
  file: string
  /** 精简后的组合集（**已排序**，逐次运行稳定）。 */
  combos: ExpectedCombo[]
  /** 全量声明组合数。 */
  declared: number
  /** `idMeta` 口径下内容互异的类数。 */
  contentClasses: number
  /** 每类一名的代表键。 */
  classReps: string[]
  /** 轴跃迁见证键（去重）。 */
  witnesses: string[]
  /** 逐档覆盖键（去重）。 */
  levelCover: string[]
  /** **已知盲轴**（≥2 档、且每条相邻档对内容都不变）；须与 `KNOWN_BLIND_AXES` 一致。 */
  blindAxes: string[]
  /**
   * 见证/盲轴判定所用的**签名口径**。
   *
   * 恒为 `'full'`（内容级，含条目全文）—— 见文件头"两种口径各司其职"。保留字段是为了让
   * 口径**显式可见**（打印进自证摘要），而不是一个隐含在代码里的选择。
   */
  witnessMode: SignatureMode
  /** **单档轴**（只有一档 ⇒ 无跃迁可验；与"盲轴"是两回事，分开登记）。 */
  singleLevelAxes: string[]
  /** 逐条配对账本：`省略者 → 与其逐格相同的集合内成员`（删减论证的机械证据）。 */
  pairing: Array<{ omitted: string; sameAs: string }>
}

/**
 * 已登记的**盲轴**（内容在该轴上完全不变 ⇒ 该轴无区分力）。
 *
 * 这是"如实登记"而不是"允许忽略"：`assertReducedTraversal()` 会核对
 * 「实际盲轴集合 == 本清单」，两边任一侧多出或缺失都会抛错 ——
 * 于是"某个轴悄悄变盲"（例如调色板归并规则改了）会立刻被抓住，
 * 而不是静默退化成空转。
 */
export const KNOWN_BLIND_AXES: Record<string, string[]> = {
  // EBF 的运行态轴**已出盲**（见证口径改内容级 + 渲染面已可辨，见文件头）。
  // 空数组是"断言该 fixture 没有任何盲轴"，不是"未登记"。
  'multiblock-ebf-2ch.json': [],
  'multiblock-tier-only.json': [],
  'multiblock-lsc-overlap.json': [],
}

/** `[z][row][x]` 归一化后的内容键（只比内容，不比形状以外的东西）。 */
function sigKey(g: SignatureGrid): string {
  return JSON.stringify(g.rows)
}

/** 一条轴的定义：取值 + 其余轴的上下文键（**只用声明值**）。 */
interface Axis {
  name: string
  get: (c: ExpectedCombo) => string | number
  /** 其余轴的上下文（用于"其余轴固定"配对的唯一键）。 */
  rest: (c: ExpectedCombo, channels: string[]) => string
}

/**
 * 构造并**自证**一份 fixture 的精简遍历集。
 *
 * 自证失败即抛错（不是"返回一个更小的集合"）—— 删减论证站不住时用例必须红：
 *  1. 每个内容类都有代表进 `S`；
 *  2. 每条**内容会变**的轴跃迁都有见证对进 `S`；
 *  3. 每个被省略的组合都能指认出 `S` 内一个**逐格相同**的成员（逐条配对）；
 *  4. 实际盲轴集合与 `KNOWN_BLIND_AXES` 逐字一致。
 */
export function buildReducedTraversal(file: string): ReducedTraversalSet {
  const p = panelContractFor(file)
  const ref = snapshotOrFallbackReference(file)
  const all = enumerateExpectedCombos(file)
  const channels = p.channels.map((ch) => ch.key)

  const sigs = new Map<string, string>()
  /** 内容级签名（`full`）—— **只**用于轴跃迁见证与盲轴判定（见文件头"两种口径各司其职"）。 */
  const contentSigs = new Map<string, string>()
  for (const combo of all) {
    const variant = ref.byVariant.get(combo.variantKey)
    if (!variant) throw new Error(`参考清单缺 ${combo.variantKey}（${file}）`)
    sigs.set(combo.variantKey, sigKey(variant.signature))
    contentSigs.set(combo.variantKey, sigKey(variant.signatureFull))
  }
  const sigOf = (key: string): string => sigs.get(key)!
  const contentSigOf = (key: string): string => contentSigs.get(key)!

  // ── 1) 内容类代表（每类取字典序最小键：稳定、可复现，不依赖运行顺序） ──
  const byContent = new Map<string, string[]>()
  for (const combo of all) {
    const s = sigOf(combo.variantKey)
    const g = byContent.get(s)
    if (g) g.push(combo.variantKey)
    else byContent.set(s, [combo.variantKey])
  }
  const classReps: string[] = []
  for (const members of byContent.values()) {
    members.sort()
    classReps.push(members[0]!)
  }

  // ── 2) 轴跃迁见证 ──
  const axes: Axis[] = [
    ...channels.map((key) => ({
      name: key,
      get: (c: ExpectedCombo) => c.values[key] ?? 0,
      rest: (c: ExpectedCombo, ks: string[]) =>
        ks
          .filter((k) => k !== key)
          .map((k) => `${k}=${c.values[k] ?? 0}`)
          .concat([`tt=${c.totalTier}`, `rs=${c.runstate}`])
          .join('|'),
    })),
    {
      name: '__tt',
      get: (c: ExpectedCombo) => c.totalTier,
      rest: (c: ExpectedCombo, ks: string[]) =>
        ks.map((k) => `${k}=${c.values[k] ?? 0}`).concat([`rs=${c.runstate}`]).join('|'),
    },
    {
      name: '__runstate',
      get: (c: ExpectedCombo) => c.runstate,
      rest: (c: ExpectedCombo, ks: string[]) =>
        ks.map((k) => `${k}=${c.values[k] ?? 0}`).concat([`tt=${c.totalTier}`]).join('|'),
    },
  ]

  const witnesses: string[] = []
  const blindAxes: string[] = []
  const singleLevelAxes: string[] = []
  for (const ax of axes) {
    const levels = [...new Set(all.map((c) => ax.get(c)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    // 单档轴**没有跃迁可验**（例如只有 `idle` 一个运行态的 fixture）—— 那是"轴不适用"，
    // 不是"轴变盲"。两者必须分开登记：把单档轴算成盲轴会让登记表失去意义。
    if (levels.length < 2) {
      singleLevelAxes.push(ax.name)
      continue
    }
    let axisHasDifference = false
    for (let i = 0; i + 1 < levels.length; i++) {
      const lo = levels[i]!
      const hi = levels[i + 1]!
      const groups = new Map<string, Map<string, ExpectedCombo>>()
      for (const c of all) {
        const v = ax.get(c)
        if (v !== lo && v !== hi) continue
        const ctx = ax.rest(c, channels)
        let g = groups.get(ctx)
        if (!g) {
          g = new Map()
          groups.set(ctx, g)
        }
        g.set(String(v), c)
      }
      let witness: [ExpectedCombo, ExpectedCombo] | null = null
      for (const g of groups.values()) {
        const a = g.get(String(lo))
        const b = g.get(String(hi))
        if (!a || !b) continue
        // **内容口径**（`full`）：轴"改不改变内容"必须按条目全文问，
        // 不能用门禁的 `name:meta` 收缩口径（那会把"改了 tooltip/nbt"误判成盲轴）。
        if (contentSigOf(a.variantKey) !== contentSigOf(b.variantKey)) {
          witness = [a, b]
          break
        }
      }
      if (witness) {
        axisHasDifference = true
        witnesses.push(witness[0].variantKey, witness[1].variantKey)
      }
    }
    if (!axisHasDifference) blindAxes.push(ax.name)
  }
  blindAxes.sort()
  singleLevelAxes.sort()

  // ── 3) 逐档覆盖（每档至少被驱动一次 DOM） ──
  const levelCover: string[] = []
  const pushFirst = (pred: (c: ExpectedCombo) => boolean): void => {
    const hit = all.find(pred)
    if (hit) levelCover.push(hit.variantKey)
  }
  for (const key of channels) {
    for (const v of [...new Set(all.map((c) => c.values[key] ?? 0))].sort((a, b) => a - b)) {
      pushFirst((c) => (c.values[key] ?? 0) === v)
    }
  }
  for (const tt of [...new Set(all.map((c) => c.totalTier))].sort((a, b) => a - b)) {
    pushFirst((c) => c.totalTier === tt)
  }
  for (const rs of [...new Set(all.map((c) => c.runstate))]) {
    pushFirst((c) => c.runstate === rs)
  }

  const keep = new Set<string>([...classReps, ...witnesses, ...levelCover])
  const byKey = new Map(all.map((c) => [c.variantKey, c]))
  const combos = [...keep].sort().map((k) => byKey.get(k)!)

  // ── 4) 自证（失败即抛，用例必红） ──
  const keptContent = new Set(combos.map((c) => sigOf(c.variantKey)))
  const uncovered = [...byContent.keys()].filter((s) => !keptContent.has(s))
  if (uncovered.length > 0) {
    throw new Error(`精简集漏掉 ${uncovered.length} 个内容类（${file}）—— 不存在"没有组合断言过"的期望内容`)
  }
  const witnessMissing = [...new Set(witnesses)].filter((k) => !keep.has(k))
  if (witnessMissing.length > 0) {
    throw new Error(`${witnessMissing.length} 个轴跃迁见证未进精简集（${file}）`)
  }
  const pairing: Array<{ omitted: string; sameAs: string }> = []
  const repByContent = new Map<string, string>()
  for (const k of classReps) repByContent.set(sigOf(k), k)
  for (const combo of all) {
    if (keep.has(combo.variantKey)) continue
    const sameAs = repByContent.get(sigOf(combo.variantKey))
    if (!sameAs) throw new Error(`省略组合 ${combo.variantKey} 找不到逐格相同的保留成员（${file}）`)
    pairing.push({ omitted: combo.variantKey, sameAs })
  }
  const expectedBlind = [...(KNOWN_BLIND_AXES[file] ?? [])].sort()
  if (JSON.stringify(blindAxes) !== JSON.stringify(expectedBlind)) {
    throw new Error(
      `${file} 的实际盲轴 ${JSON.stringify(blindAxes)} ≠ 已登记 ${JSON.stringify(expectedBlind)}。` +
        '轴"悄悄变盲"必须被抓住（否则遍历退化成空转），新盲轴须先在本文件登记并附成因。',
    )
  }

  return {
    file,
    combos,
    declared: all.length,
    contentClasses: byContent.size,
    classReps,
    witnesses: [...new Set(witnesses)],
    levelCover: [...new Set(levelCover)],
    blindAxes,
    singleLevelAxes,
    pairing,
    witnessMode: 'full',
  }
}

/** 三份 fixture 的精简集（缓存；`buildReducedTraversal` 要读 552 份参考产物）。 */
const CACHE = new Map<string, ReducedTraversalSet>()

export function reducedTraversal(file: string): ReducedTraversalSet {
  const hit = CACHE.get(file)
  if (hit) return hit
  const built = buildReducedTraversal(file)
  CACHE.set(file, built)
  return built
}

/**
 * 断言三份 fixture 的精简集自证全部成立，并打印**删减账本**（覆盖矩阵自检用，零浏览器成本）。
 * @returns 人读的多行摘要（供 spec 落日志/证据）
 */
export function assertReducedTraversal(): string {
  const lines: string[] = []
  let declared = 0
  let kept = 0
  for (const contract of PANEL_CONTRACTS) {
    const p = contract.file
    const s = reducedTraversal(p)
    declared += s.declared
    kept += s.combos.length
    lines.push(
      `[精简集] ${p}：声明 ${s.declared} → 精简 ${s.combos.length}` +
        `／内容类 ${s.contentClasses}（判据上界，门禁口径 idMeta）／见证 ${s.witnesses.length}（口径 ${s.witnessMode}）` +
        `／逐档 ${s.levelCover.length}` +
        `／省略 ${s.pairing.length}（逐条已配对）／盲轴 [${s.blindAxes.join(',') || '无'}]` +
        `／单档轴 [${s.singleLevelAxes.join(',') || '无'}]`,
    )
  }
  lines.push(`[精简集] 合计 声明 ${declared} → 精简 ${kept}（压缩 ${(declared / Math.max(kept, 1)).toFixed(2)}×）`)
  return lines.join('\n')
}
