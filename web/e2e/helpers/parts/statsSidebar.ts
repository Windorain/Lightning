/**
 * P2.5 部件断言包 —— 统计侧栏 DOM 读取/驱动 helper（零替身）。
 *
 * 观测面 = `BlockStatsSidebar.vue` 渲染的生产 DOM（**B-3 / 决策 C 后的形态**）：
 *  - 行 `.nei-slot-row`：**只有物品行一种**，带 `data-stats-row-key`（= 物品身份键
 *    `registry:damage[#nbt]`）与 `data-stats-icon-key`（= 行键恒等）；
 *    旧文件退化路径的行**无任何 data 属性**（DOM 零新增退化的直接证据）；
 *  - 「N 个无物品部件未计入清单」提示行 `[data-stats-itemless]`；
 *  - 行图标槽 `.nei-slot-preview-icon`：`BlockSlotPreview` 只在缓存条目 ready 时挂 canvas
 *    ⇒ "槽内有 canvas" = 该图标键解析出了图标（F2 嵌入纹理通道的生产可观测结果，
 *    见 `readStatsRowIcons` / `waitStatsRowIcons`）。
 *
 * ── B-4 收口（Gitea #37 顺手项，B-3 遗留）──────────────────────────────
 * B-3 已把「视图切换工具条 / 视图按钮 / 配置来源徽标 / provenance 面板 / 分组标题」整套
 * 移除（决策 C）。本文件曾按**已移除的 UI** 写有 `switchStatsView` / `readProvenance` /
 * `viewButtons` / `pill` / `data-stats-row-kind` 等读取与驱动：这些选择器在生产 DOM 里
 * 恒不存在（`row-kind` 属性 B-3 起根本不渲染），按其写的断言**永远不可能通过**——是
 * 确定性坏断言，已删除。契约 §9 的兼容口径（旧文档携带 `statsTemplate`/`statsOverride`
 * ⇒ 静默忽略）改由**移除锁**观测：`legacyToolbar` / `readLegacyStatsUiAbsent`。
 * 侧栏的「有部件 / 无部件」活性判据 = 行上有无 `data-stats-row-key`。
 */

import { expect, type Page } from '@playwright/test'
import { pollUntil } from '../multiblock'
import { WIKI_EMBED } from './hover'

export const STATS_SIDEBAR = `${WIKI_EMBED} .nei-sidebar`
export const STATS_ROWS = `${WIKI_EMBED} .nei-slot-row`

// ---------------------------------------------------------------------------
// 移除锁选择器（B-3 / 决策 C 之后必须恒不存在；负向断言用）
// ---------------------------------------------------------------------------

/** 已移除的视图切换工具条（`switchStatsView`/`readProvenance` 的宿主，B-3 整套移除）。 */
export const STATS_TOOLBAR = `${WIKI_EMBED} .nei-stats-toolbar`
/** 已移除的配置来源徽标；`data-stats-source` 取值曾为 builtin/document-default/… */
export const STATS_PILL = `${WIKI_EMBED} .nei-stats-prov-pill`
/** 已移除的 provenance 逐字段面板及其行。 */
export const STATS_PROV_PANEL = `${WIKI_EMBED} [data-stats-provenance]`
export const STATS_PROV_FIELD = `${WIKI_EMBED} [data-stats-prov-field]`
/** 已移除的「清除本机修改」按钮。 */
export const STATS_RESET_LOCAL = `${WIKI_EMBED} [data-stats-reset-local]`
/** 已移除的视图切换按钮（曾按 id 取 parts|hosts|custom）与分组标题。 */
export const STATS_VIEW_BTN = `${WIKI_EMBED} [data-stats-view-btn]`
export const STATS_GROUP_TITLE = `${WIKI_EMBED} [data-stats-group-title]`
/** 行 kind 属性（B-3 起不存在：左栏只有物品行一种）。 */
export const STATS_ROW_KIND = `${WIKI_EMBED} [data-stats-row-kind]`

export interface StatsRowObservation {
  /** 行身份键（物品行 = 物品身份键 `registry:damage[#nbt]`）。旧路径行 = null。 */
  key: string | null
  /** 图标键（P2.4 图标断言的观测点；与 `key` 恒等）。旧路径行 = null。 */
  iconKey: string | null
  /** 显示名（`.nei-slot-name`）。 */
  name: string
  /** 副标题（`.nei-slot-id`，去 modid 前缀）。 */
  sub: string
  /** 计数文本（`.nei-slot-qty`）。 */
  qty: string
}

export interface StatsSidebarObservation {
  present: boolean
  collapsed: boolean
  /**
   * 已移除的视图切换工具条是否出现。**必须恒为 false**。
   *
   * 保留该字段而非直接删：它同时是「统计栏确实渲染了（不是空跑）」的活性判据 ——
   * 组件若整体没挂载，本字段与 `rows` 会一起为空，负向断言才不会假绿。
   */
  legacyToolbar: boolean
  /** 「N 个无物品部件未计入清单」提示行（无 ⇒ null）。 */
  itemless: string | null
  rows: StatsRowObservation[]
}

/** 读侧栏完整观测（DOM 原样，不做任何归一化假设）。 */
export async function readStatsSidebar(page: Page): Promise<StatsSidebarObservation> {
  return await page.evaluate(() => {
    const sidebar = document.querySelector('.wb-wiki-embed .nei-sidebar')
    if (!sidebar) {
      return { present: false, collapsed: false, legacyToolbar: false, itemless: null, rows: [] }
    }
    const rows = [...sidebar.querySelectorAll('.nei-slot-row')].map((r) => ({
      key: r.getAttribute('data-stats-row-key'),
      iconKey: r.getAttribute('data-stats-icon-key'),
      name: (r.querySelector('.nei-slot-name')?.textContent ?? '').trim(),
      sub: (r.querySelector('.nei-slot-id')?.textContent ?? '').trim(),
      qty: (r.querySelector('.nei-slot-qty')?.textContent ?? '').trim(),
    }))
    return {
      present: true,
      collapsed: sidebar.classList.contains('nei-sidebar--collapsed'),
      legacyToolbar: !!sidebar.querySelector('.nei-stats-toolbar'),
      itemless: sidebar.querySelector('[data-stats-itemless]')?.textContent?.trim() ?? null,
      rows,
    }
  })
}

/**
 * 窄布局自愈展开：折叠态就经生产折叠按钮展开，直到「未折叠且行文本渲染」。
 *
 * 为什么必须在轮询里反复纠正（不能「查一次再展开」）：
 *  1. 折叠是**异步**落定的（profile 依赖 ResizeObserver 测量）；
 *  2. 更隐蔽的是**侧栏会重挂载**：`v-if="... && blockIconCache"` 下，装配期的
 *     `loadStructureAndResources` 重跑会重建 icon cache → 组件销毁重建 →
 *     `sidebarCollapsed` 回到初值 → `watch(profile, immediate)` 在窄布局再次
 *     折叠（mobile-chrome 实证：展开窗口期之后又被折回）。
 * `dispatchEvent('click')` 而非 `click()`：800px 的嵌入预览在 393px 移动视口里
 * 被裁出可视区（布局挤压的既有限制，多方块轮对 0 宽滑杆同此口径，README §7
 * 开放项 3），Playwright actionability 会拒绝；dispatchEvent 派发的仍是真实
 * DOM click 事件，走同一 Vue @click 监听。
 */
async function expandSidebarSelfHealing(page: Page): Promise<StatsSidebarObservation | null> {
  const s = await readStatsSidebar(page)
  if (!s.present) return null
  if (s.collapsed) {
    await page.locator(`${STATS_SIDEBAR} .nei-sidebar-toggle`).dispatchEvent('click')
    return null
  }
  return s.rows.length > 0 && s.rows[0]!.name !== '' ? s : null
}

/** 等侧栏挂载、（窄布局时）展开并完成行渲染。 */
export async function waitStatsSidebarReady(page: Page, timeout = 60_000): Promise<void> {
  await expect(page.locator(STATS_SIDEBAR)).toBeVisible({ timeout })
  await pollUntil(() => expandSidebarSelfHealing(page), '统计侧栏展开并行渲染', timeout)
}

/**
 * 读侧栏（窄布局自愈展开后）。所有行断言都应经此读取 —— 快照里保证是展开态，
 * 断言打在快照上，其后的任何重挂载不影响已读数据。
 */
export async function readStatsSidebarSettled(page: Page, timeout = 30_000): Promise<StatsSidebarObservation> {
  return await pollUntil(() => expandSidebarSelfHealing(page), '统计侧栏展开态读数', timeout)
}

// ---------------------------------------------------------------------------
// 移除锁读取（B-3 / 决策 C：视图切换与三级配置 UI 已整套移除）
// ---------------------------------------------------------------------------

export interface LegacyStatsUiObservation {
  /** 侧栏是否挂载（活性；false ⇒ 其余字段的 false 不构成证据）。 */
  present: boolean
  /** 移除组件的出现次数（全部必须为 0）。 */
  counts: {
    toolbar: number
    viewButtons: number
    pill: number
    provenancePanel: number
    provenanceFields: number
    resetLocal: number
    groupTitles: number
    rowKind: number
  }
  /** 侧栏仍未读写的本机配置键（`lightning:stats:v1:*`；残留必须原样留存、无新增）。 */
  legacyLocalKeys: string[]
}

/**
 * 读「B-3 已移除 UI」的存在性（负向断言 + 兼容兜底观测）。
 *
 * 契约 §9 兼容口径：旧文档/本机残留的 `statsTemplate` / `statsOverride` / localStorage
 * 配置 ⇒ 读取后**静默忽略**。可判定的生产形态 = 这些配置入口一个都不渲染，
 * 且 `lightning:stats:v1:*` 残留键一字未动（既不清除也不新增）。
 */
export async function readLegacyStatsUiAbsent(page: Page): Promise<LegacyStatsUiObservation> {
  return await page.evaluate(() => {
    const count = (sel: string): number => document.querySelectorAll(sel).length
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!
      if (k.startsWith('lightning:stats:v1:')) keys.push(k)
    }
    return {
      present: !!document.querySelector('.wb-wiki-embed .nei-sidebar'),
      counts: {
        toolbar: count('.wb-wiki-embed .nei-stats-toolbar'),
        viewButtons: count('.wb-wiki-embed [data-stats-view-btn]'),
        pill: count('.wb-wiki-embed .nei-stats-prov-pill'),
        provenancePanel: count('.wb-wiki-embed [data-stats-provenance]'),
        provenanceFields: count('.wb-wiki-embed [data-stats-prov-field]'),
        resetLocal: count('.wb-wiki-embed [data-stats-reset-local]'),
        groupTitles: count('.wb-wiki-embed [data-stats-group-title]'),
        rowKind: count('.wb-wiki-embed [data-stats-row-kind]'),
      },
      legacyLocalKeys: keys.sort(),
    }
  })
}

// ---------------------------------------------------------------------------
// 部件行图标槽（F2：嵌入图标纹理通道的**生产可观测结果**）
// ---------------------------------------------------------------------------

export interface StatsRowIconObservation {
  /** 行身份键（同 `StatsRowObservation.key`）。 */
  key: string | null
  /** 图标键（物品行 = 物品身份键 `registry:damage[#nbt]`）。 */
  iconKey: string | null
  /**
   * 图标槽内是否已挂**就绪 canvas**。
   *
   * 生产语义（`BlockSlotPreview.vue`）：`BlockIconCache` 条目 `status==='ready'` 时把烘焙 canvas
   * `appendChild` 进 `.nei-slot-preview-icon`；`pending`/`error`（含"键不在方块调色板里 ⇒ 占位空槽"）
   * 都渲染空槽。因此"槽里有 canvas" = 该图标键**真的解析出了图标**（嵌入纹理通道或宿主回退链），
   * 这正是 F2"部件物品图标纹理生效"能对用户看见的形态。
   */
  hasCanvas: boolean
  canvasWidth: number
  canvasHeight: number
}

/** 读全部行的图标槽状态（生产 DOM，无归一化假设）。 */
export async function readStatsRowIcons(page: Page): Promise<StatsRowIconObservation[]> {
  return await page.evaluate(() => {
    const sidebar = document.querySelector('.wb-wiki-embed .nei-sidebar')
    if (!sidebar) return []
    return [...sidebar.querySelectorAll('.nei-slot-row')].map((r) => {
      const canvas = r.querySelector('.nei-slot-preview-icon canvas') as HTMLCanvasElement | null
      return {
        key: r.getAttribute('data-stats-row-key'),
        iconKey: r.getAttribute('data-stats-icon-key'),
        hasCanvas: !!canvas,
        canvasWidth: canvas?.width ?? 0,
        canvasHeight: canvas?.height ?? 0,
      }
    })
  })
}

/**
 * 等「图标键在给定集合内的**物品行**」全部渲染出 canvas（图标烘焙是异步的：base64 解码
 * 在 `BlockIconCache` 的串行队列里）。
 *
 * 「物品行」判据 = 行带 `data-stats-row-key`（B-3 后左栏行键只有物品身份键一种；
 * 旧的 `data-stats-row-kind` 属性已随决策 C 移除，不得再作为判据）。
 *
 * 超时**抛错并列出仍无 canvas 的行**（含键），不静默返回 —— 调用方据此判定
 * "嵌入纹理通道没接通"还是"某个键没有纹理来源"。
 * `coveredIconKeys` 之外的键不参与等待（它们本就该走回退链/占位）。
 */
export async function waitStatsRowIcons(
  page: Page,
  coveredIconKeys: readonly string[],
  timeout = 30_000,
): Promise<StatsRowIconObservation[]> {
  const covered = new Set(coveredIconKeys)
  const deadline = Date.now() + timeout
  let last: StatsRowIconObservation[] = []
  for (;;) {
    last = await readStatsRowIcons(page)
    const itemRows = last.filter((r) => r.key !== null)
    const pending = itemRows.filter(
      (r) => r.iconKey !== null && covered.has(r.iconKey) && !r.hasCanvas,
    )
    if (itemRows.length > 0 && pending.length === 0) return last
    if (Date.now() > deadline) {
      throw new Error(
        `P3.1：等待物品行图标就位超时（${timeout}ms）—— 仍有 ${pending.length} 行无 canvas：` +
          `${pending.map((r) => r.iconKey).join(', ') || '<物品行尚未渲染>'}` +
          `\n  最后读数：${JSON.stringify(last.slice(0, 6))}${last.length > 6 ? ` …（共 ${last.length} 行）` : ''}`,
      )
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}
