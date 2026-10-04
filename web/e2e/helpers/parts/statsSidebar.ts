/**
 * 部件断言包 —— 统计侧栏 DOM 读取/驱动 helper（零替身）。
 *
 * 观测面 = `BlockStatsSidebar.vue` 渲染的生产 DOM。**形态口径随 B-3（决策 C）与 B-5（#38）更新**：
 *  - B-3 移除了视图切换工具条 / 视图按钮 / 配置来源徽标 / provenance 面板 / 宿主行
 *    ⇒ 本 helper 不再有 `toolbar` / `viewButtons` / `pill` / `readProvenance` / `switchStatsView`
 *    （读已不存在的 UI 只会造出**确定性坏断言**，故整套删除而非留着）；
 *  - B-5 起物品行有**选中态集合**与会话提示：`[data-stats-selected]` / `[data-stats-unresolved]`
 *    （+ 行内色点 `[data-stats-unresolved-dot]`，title = "没有对应方块"）/ `[data-stats-anchor]`
 *    / `[data-stats-selection-notice]`；点选驱动 = 真实 DOM `click`（含 Ctrl/Shift 修饰键）。
 *
 * 行 DOM：`data-stats-row-key` / `data-stats-icon-key`（**图标键 = 物品身份键**）。
 * 旧文件（无部件）的宿主清单行**无任何 data 属性**（DOM 零新增的直接证据），
 * 且**不带** B-5 的选中态/无对应数据位。
 *
 * 行图标槽 `.nei-slot-preview-icon`：`BlockSlotPreview` 只在缓存条目 ready 时挂 canvas
 * ⇒ "槽内有 canvas" = 该图标键解析出了图标（F2 嵌入纹理通道的生产可观测结果，
 * 见 `readStatsRowIcons` / `waitStatsRowIcons`）。
 *
 * 驱动 = 生产 DOM 的真实事件注入；不触碰 src 内部函数。
 */

import { expect, type Page } from '@playwright/test'
import { pollUntil } from '../multiblock'
import { WIKI_EMBED } from './hover'

export const STATS_SIDEBAR = `${WIKI_EMBED} .nei-sidebar`
export const STATS_ROWS = `${WIKI_EMBED} .nei-slot-row`
export const STATS_ITEMLESS = `${WIKI_EMBED} [data-stats-itemless]`
export const STATS_SELECTION_NOTICE = `${WIKI_EMBED} [data-stats-selection-notice]`

export const statsRow = (key: string): string => `${WIKI_EMBED} [data-stats-row-key="${key}"]`
export const statsRowDot = (key: string): string =>
  `${WIKI_EMBED} [data-stats-row-key="${key}"] [data-stats-unresolved-dot]`

export interface StatsRowObservation {
  /** 行身份键（物品身份键 `registry:damage[#nbt]`）；旧路径行 = null。 */
  key: string | null
  /** 图标键（= 物品身份键）。旧路径行 = null。 */
  iconKey: string | null
  /** 显示名（`.nei-slot-name` 文本；无对应项的行内色点不带文本，不影响本读数）。 */
  name: string
  /** 副标题（`.nei-slot-id`，去 modid 前缀）。 */
  sub: string
  /** 计数文本（`.nei-slot-qty`）。 */
  qty: string
  /** B-5 选中态（集合语义）。 */
  selected: boolean
  /** B-5「没有对应方块」（索引无条目 / 显式无对应）。 */
  unresolved: boolean
  /** B-5 Shift 区间锚点行。 */
  anchor: boolean
}

export interface StatsSidebarObservation {
  present: boolean
  collapsed: boolean
  /** 「N 个无物品部件未计入清单」提示行（无 ⇒ null）。 */
  itemless: string | null
  /** B-5 选择状态提示（无对应项 / 命中截断；无 ⇒ null）。 */
  notice: string | null
  rows: StatsRowObservation[]
}

/** 读侧栏完整观测（DOM 原样，不做任何归一化假设）。 */
export async function readStatsSidebar(page: Page): Promise<StatsSidebarObservation> {
  return await page.evaluate(() => {
    const sidebar = document.querySelector('.wb-wiki-embed .nei-sidebar')
    if (!sidebar) {
      return { present: false, collapsed: false, itemless: null, notice: null, rows: [] }
    }
    const rows = [...sidebar.querySelectorAll('.nei-slot-row')].map((r) => ({
      key: r.getAttribute('data-stats-row-key'),
      iconKey: r.getAttribute('data-stats-icon-key'),
      name: (r.querySelector('.nei-slot-name')?.textContent ?? '').trim(),
      sub: (r.querySelector('.nei-slot-id')?.textContent ?? '').trim(),
      qty: (r.querySelector('.nei-slot-qty')?.textContent ?? '').trim(),
      selected: r.getAttribute('data-stats-selected') === 'true'
        || r.classList.contains('nei-slot-row--selected'),
      unresolved: r.getAttribute('data-stats-unresolved') === 'true',
      anchor: r.getAttribute('data-stats-anchor') === 'true',
    }))
    return {
      present: true,
      collapsed: sidebar.classList.contains('nei-sidebar--collapsed'),
      itemless: sidebar.querySelector('[data-stats-itemless]')?.textContent?.trim() ?? null,
      notice: sidebar.querySelector('[data-stats-selection-notice]')?.textContent?.trim() ?? null,
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
// B-5：物品行点选驱动（经典多选；语义见 `web/src/pure/itemSelection.ts`）
// ---------------------------------------------------------------------------

/** 行点击的修饰键（`ctrl` 同时覆盖 Cmd/Meta —— 与生产 `ctrlKey || metaKey` 同义） */
export interface RowClickMods {
  ctrl?: boolean
  shift?: boolean
}

/**
 * 等侧栏**稳定**：连续两次读数（相隔 `quietMs`）的行键序列一致。
 *
 * 为什么必须：装配期 `loadStructureAndResources` 重跑 → icon cache 重建 →
 * **EmbedViewport 自身重挂载**（P2.5 实证：`sidebarCollapsed` 会被重置回初值）
 * ⇒ 选择状态（B-5 的 `itemSelection`）一并归零。过早驱动点选，选中态会被
 * 随后的重挂载静默吞掉（B-5 首轮实测：单击后读到"无选中"）。故**任何点选驱动
 * 都要先越过这个窗口**；`clickStatsRow` 内部已调用本函数。
 */
export async function waitStatsSidebarStable(
  page: Page,
  quietMs = 500,
  timeout = 30_000,
): Promise<StatsSidebarObservation> {
  const deadline = Date.now() + timeout
  let last: string | null = null
  for (;;) {
    const s = await expandSidebarSelfHealing(page)
    if (!s) {
      last = null
    } else {
      const sig = `${s.collapsed}|${s.rows.map((r) => r.key).join(',')}`
      if (sig === last) return s
      last = sig
    }
    if (Date.now() > deadline) {
      throw new Error(`统计侧栏未在 ${timeout}ms 内稳定（装配期重挂载未收敛）`)
    }
    await page.waitForTimeout(quietMs)
  }
}

/**
 * 点物品行（生产 DOM 真实 `click`，带修饰键）。
 *
 * 为什么 `dispatchEvent` 而非 `click()`：同 `expandSidebarSelfHealing` 的窄布局裁剪理由；
 * 派发的仍是真实 DOM click，走同一 `@click` 监听与 Vue 的修饰键快照。
 * 点击前先等侧栏稳定（见 `waitStatsSidebarStable`），点击后等一帧让选择集与 mask 重建落定。
 */
export async function clickStatsRow(
  page: Page,
  key: string,
  mods: RowClickMods = {},
  timeout = 15_000,
): Promise<StatsSidebarObservation> {
  await pollUntil(
    async () => {
      const s = await expandSidebarSelfHealing(page)
      return s && s.rows.some((r) => r.key === key) ? s : null
    },
    `物品行 ${key} 出现在侧栏`,
    timeout,
  )
  await waitStatsSidebarStable(page, 500, timeout)
  await page.locator(statsRow(key)).dispatchEvent('click', {
    ctrlKey: mods.ctrl === true,
    metaKey: false,
    shiftKey: mods.shift === true,
  })
  await page.waitForTimeout(120)
  return await readStatsSidebar(page)
}

/** 点左栏空白（`Esc` 之外的第二条清空路径）。 */
export async function clickStatsBlank(page: Page): Promise<StatsSidebarObservation> {
  await page.locator(`${STATS_SIDEBAR} .nei-sidebar-grid`).dispatchEvent('click')
  await page.waitForTimeout(120)
  return await readStatsSidebar(page)
}

/** 按 Esc（清空选择；生产在 `document` 上监听）。 */
export async function pressStatsEscape(page: Page): Promise<StatsSidebarObservation> {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(120)
  return await readStatsSidebar(page)
}

/**
 * 选中行键（**按渲染顺序**，即左栏可见顺序）。
 * 物品行固定"数量降序 / 并列键字典序"，故该数组与点击顺序无关——断言要用可见顺序写。
 */
export function selectedRowKeys(s: StatsSidebarObservation): string[] {
  return s.rows.filter((r) => r.selected).map((r) => r.key ?? '')
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
    const pending = last.filter(
      (r) => r.iconKey !== null && covered.has(r.iconKey) && !r.hasCanvas,
    )
    if (last.length > 0 && pending.length === 0) return last
    if (Date.now() > deadline) {
      throw new Error(
        `P3.1：等待部件行图标就位超时（${timeout}ms）—— 仍有 ${pending.length} 行无 canvas：` +
          `${pending.map((r) => r.iconKey).join(', ') || '<部件行尚未渲染>'}` +
          `\n  最后读数：${JSON.stringify(last.slice(0, 6))}${last.length > 6 ? ` …（共 ${last.length} 行）` : ''}`,
      )
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}
