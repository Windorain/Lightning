/**
 * pure/partStats.ts — 统计引擎：**纯物品清单**（B-3 决策 C 落地）。
 *
 * 契约：`docs/contracts/format-parts-contract.md`
 *   （§2.2 物品索引表、§5 类型键与物品身份；§9「统计默认值」**已废弃** —— 规则能力与三级配置
 *    整套移除的依据即该节，原文见 git 历史）。
 * 过程性计划已按 #51 裁决删除；判据真源 = `docs/contracts/format-parts-contract.md`。
 *
 * 纯函数、零框架依赖：输入 = 部件实例平铺列表；输出 = 物品行清单；UI 只负责呈现。
 * No side effects: no Vue refs, no DOM, no I/O, no mutation of arguments.
 *
 * ── 口径（决策 C，取代原「三视图 + 十条规则键 + 三级配置」）──
 *  - **行 = 物品**：行键恒等于**物品身份键** `registry:damage[#nbt]`（与 `partIconTextures` /
 *    `itemIndex` / `PartItem` 同一套键）—— 契约 §2.2「左栏行键恒等于物品身份键」。
 *    故物品级悬停说明与点选归属（#5/#7）都可直查物品索引表，不需要"折叠键 → 原始键"回退通道；
 *  - **数量口径 = 物品件数**：`PartItem.count` 逐条累加；本引擎不做系数换算，小数由导出侧给定；
 *  - **排序固定** = 数量降序，并列按行键字典序（无 sortBy 规则）；
 *  - 一部件 ≠ 一物品：`items[]` 逐条计数，附加条目（AE2 升级卡等）自成一个物品行；
 *  - `items: []` 的部件计入 `itemlessPartCount`（"N 个无物品部件未计入清单"提示），不产生物品行；
 *  - **无宿主行**：`hostCounts` / `showHostRows` / `hostGroupTitle` 已随决策 C 移除 —— 引擎不再
 *    接触宿主计数。旧口径（`blockStats.countBlocksById`）仍原样服务**旧文件**的宿主清单路径。
 *
 * ── 无部件退化（硬约束：无部件旧文件 = 今天行为）──
 *  `parts` 为空（文件无部件数据 / 当前过滤层无部件）⇒ 返回空行集 + `degenerated: 'parts-to-hosts'`，
 *  调用方（`BlockStatsSidebar`）据此**完全走旧路径**：宿主清单直接取 `entries` prop
 *  （`buildBlockStatsEntries` / `countBlocksById` 旧口径），行集/行键/文案/数量逐项与今天一致。
 */

import type { PartItem, PartRecord } from '@/pure/partTypes'

// ---------------------------------------------------------------------------
// 键工具
// ---------------------------------------------------------------------------

/** 物品身份键：`registry:damage[#nbtDiscriminator]`（行键 / 图标键 / 物品索引表键，契约 §2.2 / §5） */
export function partItemKey(item: PartItem): string {
  return item.nbtDiscriminator
    ? `${item.registry}:${item.damage}#${item.nbtDiscriminator}`
    : `${item.registry}:${item.damage}`
}

// ---------------------------------------------------------------------------
// 输出类型
// ---------------------------------------------------------------------------

/** 物品行（UI 只负责呈现） */
export interface StatsRow {
  /** 行身份键 = 物品身份键 `registry:damage[#nbt]`（契约 §2.2：恒等于物品身份键） */
  key: string
  /** 显示名：主条目 = 部件 `displayName`（游戏内显示名）；附加条目 = 其自身物品身份键 */
  label: string
  /** 数量 = 物品件数（本引擎不做系数换算，可为小数） */
  count: number
  /** 图标键（UI 消费）：物品身份键，与 `key` 恒等 */
  iconKey: string
}

export interface ItemStatsResult {
  /** 物品行（数量降序，并列按行键字典序） */
  rows: StatsRow[]
  /** `items: []` 的部件实例数（"无物品部件"提示；不计入物品行） */
  itemlessPartCount: number
  /** 无部件数据 ⇒ 调用方走旧文件的宿主清单路径（旧文件 = 今天行为） */
  degenerated?: 'parts-to-hosts'
}

// ---------------------------------------------------------------------------
// 引擎输入
// ---------------------------------------------------------------------------

/**
 * 引擎输入：部件实例平铺列表。
 * 分层预览等过滤由适配层在构造输入时完成；引擎只见过滤后的数据。
 */
export interface ItemStatsInput {
  /** 全部部件实例（跨格平铺；一格多物即多条 PartRecord） */
  parts: readonly PartRecord[]
}

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------

/**
 * 统计引擎主入口：输入 = 部件数据，输出 = 物品行清单。
 * 口径与退化语义见文件头。
 */
export function buildItemStats(input: ItemStatsInput): ItemStatsResult {
  // 无部件数据 ⇒ 退化标记；宿主清单由调用方的旧路径生成（引擎不参与）
  if (input.parts.length === 0) {
    return { rows: [], itemlessPartCount: 0, degenerated: 'parts-to-hosts' }
  }

  const acc = new Map<string, StatsRow>()
  let itemlessPartCount = 0

  for (const part of input.parts) {
    if (part.items.length === 0) {
      itemlessPartCount++
      continue
    }
    for (let i = 0; i < part.items.length; i++) {
      const item = part.items[i]!
      const key = partItemKey(item)
      const row = acc.get(key)
      if (row) {
        row.count += item.count
        continue
      }
      // 主条目（i=0）随行携带部件显示名；附加条目无部件级 displayName ⇒ 以物品身份键作 label
      acc.set(key, {
        key,
        label: i === 0 ? part.displayName : key,
        count: item.count,
        iconKey: key,
      })
    }
  }

  const rows = [...acc.values()]
  rows.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
  return { rows, itemlessPartCount }
}
