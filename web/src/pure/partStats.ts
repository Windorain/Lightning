/**
 * pure/partStats.ts — P2.3 统计引擎（物品粒度 + 三级配置 + 三视图）。
 *
 * 契约：`docs/contracts/format-parts-contract.md`（§5 类型键与物品身份；**§9 已于部件轮决策 C 废弃**——
 * 取代口径见 §2.2 物品索引表与 §9 的兼容口径：旧 `statsTemplate`/`statsOverride` 读取后静默忽略）。
 * 计划：`docs/plan/non-full-cube-parts-plan.md` §4 P2.3。
 *
 * 纯函数、零框架依赖：输入 = 部件数据 + 宿主计数 + 规则，输出 = 清单行；UI 只负责呈现。
 * No side effects: no Vue refs, no DOM, no I/O, no mutation of arguments.
 *
 * ── 留白 #6 拍板登记（规则表达方式与三级配置存储细节，P2.3）──
 *
 * 【规则表达】规则是 JSON 可序列化的 `StatsRules` 对象（不使用 DSL/表达式字符串）：
 *  - ignore：忽略表，精确键或 `prefix*` 前缀通配；同时匹配"原始键"与"合并后键"，任一命中即丢弃；
 *  - scale：系数换算表（键 → 每件倍率，允许小数，如 FMP 半板 0.5）；先查原始键、再查合并后键；
 *  - aliases：别名合并表（from 键 → to 键），作用于粒度折叠之后的键；
 *  - keyGranularity：分组键粒度。'full' = 完整 typeKey（默认）；'damage' = 去掉 `#nbt` 判别
 *    （FMP 材料串坍缩）；'registry' = 再去掉 `:damage`（AE2 线缆颜色等 damage 变体坍缩）；
 *  - showHostRows：宿主行开关（部件/自定义视图末尾追加宿主清单组，默认关）；
 *  - sortBy：排序；groups + showOthers + othersTitle：显式分组与分组标题。
 *  理由：JSON 对象可直接落盘（文档覆盖写回文件、localStorage），无需解析器；
 *  逐键整体覆盖（不深合并数组/表）保证三级配置"互不乱序"且行为可预测。
 *
 * 【三视图语义】
 *  - parts（默认）：按 typeKey 分组计数，单位 = 可合成物品。一部件 ≠ 一物品：items[] 逐条
 *    累加 count；items[0] 的行键 = part.typeKey（契约 §5：typeKey = 计数/合并键），附加条目
 *    （AE2 升级卡等）的行键 = 物品身份键 partItemKey(entry)。items: [] 的部件计入
 *    itemlessPartCount（"无物品部件"提示），不产生物品行。本视图只应用
 *    ignore / sortBy / showHostRows 三条规则（granularity/aliases/scale/groups 是自定义视图
 *    的工具）——默认视图语义被契约钉死为"按 typeKey 分组计数"，不受合并规则影响。
 *  - hosts：旧口径，数值 = countBlocksById（适配层直接复用旧函数）；除 sortBy 外不应用任何
 *    规则（硬约束：数值与旧口径一致）。
 *  - custom：部件计数 + 全部规则（粒度/别名/系数/忽略/分组/排序/宿主行）。
 *
 * 【无部件退化语义（硬约束：无部件旧文件 = 今天行为）】
 *  输入 parts 为空（文件无部件数据）时，parts 视图退化为宿主清单：行集 = hosts 视图行集，
 *  结果带 degenerated: 'parts-to-hosts' 标记（UI 可据此提示，也可静默）。custom 视图同样退化
 *  为其宿主行（规则中的宿主行开关此时无意义）。
 *
 * 【三级配置存储】
 *  - 文档默认：文件内 `statsTemplate`（V2StatsTemplate；camelCase 落盘权威，snake_case 仅旧
 *    数据读取回退——调度者拍板）。mode 'auto' = 部件物品清单视图；'custom' = 显式分组视图。
 *  - 文档覆盖：新的可选根字段 `statsOverride`（camelCase），形状 = StatsConfigLayer 的 JSON；
 *    编辑写回文件时由 workbench 写入，随 `_extra` 兜底机制 round-trip（无需改解析器）。
 *  - 查看者本地：localStorage 键 `lightning:stats:v1:<docId>`，值 = { schema: 1, config }；
 *    只影响本机查看者，不写回文件。
 *  - 合并：字段级覆盖，查看者本地 > 文档覆盖 > 文档默认 > 内建默认；`resolveStatsConfig`
 *    返回逐字段来源（StatsConfigProvenance），"默认值来自文档"这一事实对 UI 可见。
 */

import type { PartItem, PartRecord } from '@/pure/partTypes'

// ---------------------------------------------------------------------------
// 视图与规则类型
// ---------------------------------------------------------------------------

/** 三视图：部件物品清单（默认）/ 宿主清单（旧口径）/ 自定义分组（规则驱动） */
export type StatsViewId = 'parts' | 'hosts' | 'custom'

/** 分组键粒度：颜色/朝向/变体的折叠粒度（见文件头拍板登记） */
export type StatsKeyGranularity = 'full' | 'damage' | 'registry'

export type StatsSortBy = 'count-desc' | 'count-asc' | 'key' | 'label'

/** 显式分组（分组标题 + 成员键；成员键支持 `prefix*` 前缀通配） */
export interface StatsRuleGroup {
  title: string
  /** 组内条目键（合并后键或原始键；`prefix*` 前缀通配）；按声明顺序先匹配先得 */
  match: string[]
}

/**
 * 规则集（JSON 可序列化；全部字段可选）。逐键整体覆盖，不深合并。
 */
export interface StatsRules {
  /** 忽略表：精确键或 `prefix*` 通配；匹配原始键或合并后键的条目不列出 */
  ignore?: string[]
  /** 系数换算：键 → 每件倍率（允许小数）；先查原始键、再查合并后键，缺省 1 */
  scale?: Record<string, number>
  /** 别名合并：from 键 → to 键（作用于粒度折叠之后） */
  aliases?: Record<string, string>
  /** 分组键粒度（默认 'full'） */
  keyGranularity?: StatsKeyGranularity
  /** 宿主行开关：部件/自定义视图末尾追加宿主清单组（默认 false） */
  showHostRows?: boolean
  /** 排序（默认：部件/自定义 'count-desc'，宿主 'key'；并列按 key 字典序） */
  sortBy?: StatsSortBy
  /** 显式分组（仅自定义视图）；声明顺序即组顺序，空组不输出 */
  groups?: StatsRuleGroup[]
  /** 显式分组时未匹配条目是否进"其他"组（默认 true） */
  showOthers?: boolean
  /** "其他"组标题（默认 '其他'） */
  othersTitle?: string
  /** 宿主清单组标题（默认 '宿主方块'） */
  hostGroupTitle?: string
}

/**
 * 一层配置（三级配置的任一层；全部字段可选，缺省 = 该层不发言）。
 * 文档覆盖（statsOverride）与查看者本地（localStorage）的落盘形状即本接口的 JSON。
 */
export interface StatsConfigLayer {
  view?: StatsViewId
  rules?: StatsRules
}

/** 解析后的完整配置（buildStatsView 的输入） */
export interface ResolvedStatsConfig {
  view: StatsViewId
  rules: StatsRules
}

/** 配置来源（"默认值来自文档"对用户可见的元信息） */
export type StatsConfigSource = 'builtin' | 'document-default' | 'document-override' | 'viewer-local'

/** 逐字段来源：view 的来源 + 每个规则键的来源 */
export interface StatsConfigProvenance {
  view: StatsConfigSource
  rules: Partial<Record<keyof StatsRules, StatsConfigSource>>
}

/** 三级配置输入（任一层可缺省/null） */
export interface StatsConfigLayers {
  documentDefault?: StatsConfigLayer | null
  documentOverride?: StatsConfigLayer | null
  viewerLocal?: StatsConfigLayer | null
}

// ---------------------------------------------------------------------------
// 输出类型
// ---------------------------------------------------------------------------

/** 清单行（UI 只负责呈现） */
export interface StatsRow {
  /** 行身份键：部件行 = typeKey / 物品身份键（经粒度折叠与别名合并后）；宿主行 = block_registry 键 */
  key: string
  /** 行来源：部件物品行 / 宿主方块行 */
  kind: 'part' | 'host'
  /** 显示名（部件行 = 游戏内 displayName 首见；附加物品条目/宿主行 = 键本身，UI 可另行解析） */
  label: string
  /** 数量：部件行 = 可合成物品件数（系数换算后，可为小数）；宿主行 = 方块格数 */
  count: number
  /** 图标键（P2.4 消费）：部件行 = 物品身份键 `registry:damage[#nbt]`；宿主行 = block_registry 键 */
  iconKey: string
}

export interface StatsGroupRows {
  /** 分组标题；未分组的单组为 null */
  title: string | null
  rows: StatsRow[]
}

export interface StatsViewResult {
  view: StatsViewId
  groups: StatsGroupRows[]
  /** `items: []` 的部件实例数（"无物品部件"提示；不计入物品行） */
  itemlessPartCount: number
  /** 无部件数据时部件/自定义视图退化为宿主清单（旧文件 = 今天行为） */
  degenerated?: 'parts-to-hosts'
}

// ---------------------------------------------------------------------------
// 引擎输入
// ---------------------------------------------------------------------------

/**
 * 引擎输入：宿主计数（旧口径，`countBlocksById` 结果）+ 部件实例平铺列表。
 * 分层预览等过滤由适配层在构造输入时完成；引擎只见过滤后的数据。
 */
export interface PartStatsInput {
  /** 宿主方块计数：block_registry 键 → 格数（`countBlocksById` 结果原样传入） */
  hostCounts: ReadonlyMap<string, number>
  /** 全部部件实例（跨格平铺；一格多物即多条 PartRecord） */
  parts: readonly PartRecord[]
}

// ---------------------------------------------------------------------------
// 键工具
// ---------------------------------------------------------------------------

/** 物品身份键：`registry:damage[#nbtDiscriminator]`（附加 items 条目的行键/图标键） */
export function partItemKey(item: PartItem): string {
  return item.nbtDiscriminator
    ? `${item.registry}:${item.damage}#${item.nbtDiscriminator}`
    : `${item.registry}:${item.damage}`
}

/** 粒度折叠：'full' 原样；'damage' 去 `#nbt`；'registry' 再去 `:damage`（颜色/变体坍缩） */
export function foldKeyGranularity(key: string, granularity: StatsKeyGranularity): string {
  if (granularity === 'full') return key
  const noNbt = key.split('#', 1)[0]!
  if (granularity === 'damage') return noNbt
  // registry 段 = 最后一段 `:damage` 之前（registry 本身含 modid:path 的冒号）
  const idx = noNbt.lastIndexOf(':')
  return idx > 0 ? noNbt.slice(0, idx) : noNbt
}

/** 模式匹配：精确相等，或以 `*` 结尾的前缀通配 */
function matchPattern(pattern: string, key: string): boolean {
  if (pattern.endsWith('*')) return key.startsWith(pattern.slice(0, -1))
  return pattern === key
}

function matchAnyPattern(patterns: readonly string[] | undefined, key: string): boolean {
  if (!patterns) return false
  for (const p of patterns) if (matchPattern(p, key)) return true
  return false
}

// ---------------------------------------------------------------------------
// 三级配置解析
// ---------------------------------------------------------------------------

/** 内建默认（最低层）：部件物品清单视图，无规则 */
export function builtinStatsConfig(): ResolvedStatsConfig {
  return { view: 'parts', rules: {} }
}

const RULE_KEYS = [
  'ignore', 'scale', 'aliases', 'keyGranularity', 'showHostRows',
  'sortBy', 'groups', 'showOthers', 'othersTitle', 'hostGroupTitle',
] as const satisfies readonly (keyof StatsRules)[]

/**
 * 三级配置合成：字段级覆盖，查看者本地 > 文档覆盖 > 文档默认 > 内建默认。
 * 规则按顶层键整体覆盖（不深合并数组/表），保证互不乱序、行为可预测。
 */
export function resolveStatsConfig(layers: StatsConfigLayers): {
  config: ResolvedStatsConfig
  provenance: StatsConfigProvenance
} {
  const ordered: Array<[StatsConfigSource, StatsConfigLayer | null | undefined]> = [
    ['document-default', layers.documentDefault],
    ['document-override', layers.documentOverride],
    ['viewer-local', layers.viewerLocal],
  ]
  const config = builtinStatsConfig()
  const provenance: StatsConfigProvenance = { view: 'builtin', rules: {} }
  for (const [source, layer] of ordered) {
    if (!layer) continue
    if (layer.view !== undefined) {
      config.view = layer.view
      provenance.view = source
    }
    if (layer.rules) {
      for (const k of RULE_KEYS) {
        if (layer.rules[k] !== undefined) {
          config.rules[k] = layer.rules[k] as never
          provenance.rules[k] = source
        }
      }
    }
  }
  return { config, provenance }
}

// ---------------------------------------------------------------------------
// 计数（内部）
// ---------------------------------------------------------------------------

interface RowAcc {
  key: string
  kind: 'part' | 'host'
  label: string
  count: number
  iconKey: string
}

/** 部件实例 → 物品贡献 { rawKey, label, count }；items: [] 返回空数组（调用方累计 itemless） */
function partItemContributions(part: PartRecord): Array<{ rawKey: string; label: string; count: number }> {
  const out: Array<{ rawKey: string; label: string; count: number }> = []
  for (let i = 0; i < part.items.length; i++) {
    const item = part.items[i]!
    if (i === 0) {
      // 主条目：行键 = typeKey（契约 §5：typeKey = 计数/合并键）
      out.push({ rawKey: part.typeKey, label: part.displayName, count: item.count })
    } else {
      // 附加条目（AE2 升级卡等）：行键 = 该物品自身身份键；无独立 displayName，回退为键
      const k = partItemKey(item)
      out.push({ rawKey: k, label: k, count: item.count })
    }
  }
  return out
}

/**
 * 部件物品计数。
 * @param applyMergeRules true = 自定义视图（粒度折叠 + 别名 + 系数 + 忽略全量应用）；
 *                        false = 默认部件视图（仅 ignore；语义钉死 = 按 typeKey 分组计数）
 */
function countPartItems(
  parts: readonly PartRecord[],
  rules: StatsRules,
  applyMergeRules: boolean,
): { rows: Map<string, RowAcc>; itemlessPartCount: number } {
  const rows = new Map<string, RowAcc>()
  let itemlessPartCount = 0
  const granularity: StatsKeyGranularity = applyMergeRules ? (rules.keyGranularity ?? 'full') : 'full'

  for (const part of parts) {
    const contributions = partItemContributions(part)
    if (contributions.length === 0) {
      itemlessPartCount++
      continue
    }
    for (const c of contributions) {
      let key = foldKeyGranularity(c.rawKey, granularity)
      if (applyMergeRules) key = rules.aliases?.[key] ?? key
      // 忽略表：原始键或合并后键任一命中即丢弃
      if (matchAnyPattern(rules.ignore, c.rawKey) || matchAnyPattern(rules.ignore, key)) continue
      let scale = 1
      if (applyMergeRules) scale = rules.scale?.[c.rawKey] ?? rules.scale?.[key] ?? 1
      const acc = rows.get(key) ?? { key, kind: 'part' as const, label: c.label, count: 0, iconKey: c.rawKey }
      acc.count += c.count * scale
      rows.set(key, acc)
    }
  }
  return { rows, itemlessPartCount }
}

function hostRows(hostCounts: ReadonlyMap<string, number>): RowAcc[] {
  const out: RowAcc[] = []
  for (const [key, count] of hostCounts) {
    if (count > 0) out.push({ key, kind: 'host', label: key, count, iconKey: key })
  }
  return out
}

function sortRows(rows: RowAcc[], sortBy: StatsSortBy): RowAcc[] {
  const byKey = (a: RowAcc, b: RowAcc) => a.key.localeCompare(b.key)
  const sorted = [...rows]
  switch (sortBy) {
    case 'count-desc':
      sorted.sort((a, b) => b.count - a.count || byKey(a, b))
      break
    case 'count-asc':
      sorted.sort((a, b) => a.count - b.count || byKey(a, b))
      break
    case 'label':
      sorted.sort((a, b) => a.label.localeCompare(b.label) || byKey(a, b))
      break
    case 'key':
      sorted.sort(byKey)
      break
  }
  return sorted
}

// ---------------------------------------------------------------------------
// 视图构建
// ---------------------------------------------------------------------------

/**
 * 统计引擎主入口：输入 = 部件数据 + 宿主计数 + 解析后配置，输出 = 清单行。
 * 三视图语义与无部件退化语义见文件头拍板登记。
 */
export function buildStatsView(input: PartStatsInput, config: ResolvedStatsConfig): StatsViewResult {
  const rules = config.rules

  // ── 宿主视图（旧口径，除 sortBy 外不应用任何规则）──
  if (config.view === 'hosts') {
    return {
      view: 'hosts',
      groups: [{ title: null, rows: sortRows(hostRows(input.hostCounts), rules.sortBy ?? 'key') }],
      itemlessPartCount: countItemless(input.parts),
    }
  }

  // ── 无部件退化：无部件数据 ⇒ 部件/自定义视图退化为宿主清单（旧文件 = 今天行为）──
  if (input.parts.length === 0) {
    return {
      view: config.view,
      groups: [{ title: null, rows: sortRows(hostRows(input.hostCounts), rules.sortBy ?? 'key') }],
      itemlessPartCount: 0,
      degenerated: 'parts-to-hosts',
    }
  }

  const applyMergeRules = config.view === 'custom'
  const { rows, itemlessPartCount } = countPartItems(input.parts, rules, applyMergeRules)
  const sortBy = rules.sortBy ?? 'count-desc'
  const groups: StatsGroupRows[] = []

  // ── 显式分组（仅自定义视图声明 groups 时）──
  const ruleGroups = applyMergeRules ? rules.groups : undefined
  if (ruleGroups && ruleGroups.length > 0) {
    const remaining = new Map(rows)
    for (const g of ruleGroups) {
      const members: RowAcc[] = []
      for (const [key, acc] of remaining) {
        if (matchAnyPattern(g.match, key)) {
          members.push(acc)
          remaining.delete(key)
        }
      }
      if (members.length > 0) groups.push({ title: g.title, rows: sortRows(members, sortBy) })
    }
    if (remaining.size > 0 && rules.showOthers !== false) {
      groups.push({ title: rules.othersTitle ?? '其他', rows: sortRows([...remaining.values()], sortBy) })
    }
  } else {
    groups.push({ title: null, rows: sortRows([...rows.values()], sortBy) })
  }

  // ── 宿主行开关：末尾追加宿主清单组（数值 = 旧口径，不被规则改写）──
  if (rules.showHostRows) {
    const hosts = sortRows(hostRows(input.hostCounts), sortBy)
    if (hosts.length > 0) groups.push({ title: rules.hostGroupTitle ?? '宿主方块', rows: hosts })
  }

  return { view: config.view, groups, itemlessPartCount }
}

function countItemless(parts: readonly PartRecord[]): number {
  let n = 0
  for (const p of parts) if (p.items.length === 0) n++
  return n
}
