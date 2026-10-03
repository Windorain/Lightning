/**
 * P2.5 部件断言包 —— 统计侧栏 DOM 读取/驱动 helper（零替身）。
 *
 * 观测面 = `BlockStatsSidebar.vue`（P2.4）渲染的生产 DOM：
 *  - 部件模式工具条 `.nei-stats-toolbar`（无部件旧文件**不渲染**，拍板退化）；
 *  - 视图切换 `[data-stats-view-btn="parts|hosts|custom"]`（`aria-selected` = 激活）；
 *  - 配置来源徽标 `.nei-stats-prov-pill`（`data-stats-source` = builtin /
 *    document-default / document-override / viewer-local）；
 *  - provenance 面板 `[data-stats-provenance]` 的逐字段行 `[data-stats-prov-field]`；
 *  - 行 `.nei-slot-row`：部件模式带 `data-stats-row-key` / `data-stats-row-kind` /
 *    `data-stats-icon-key`（**图标键**，部件行 = 物品身份键，宿主行 = 宿主键），
 *    旧路径行无 data 属性（DOM 零新增退化的直接证据）；
 *  - 行图标槽 `.nei-slot-preview-icon`：`BlockSlotPreview` 只在缓存条目 ready 时挂 canvas
 *    ⇒ "槽内有 canvas" = 该图标键解析出了图标（F2 嵌入纹理通道的生产可观测结果，
 *    见 `readStatsRowIcons` / `waitStatsRowIcons`）。
 *
 * 驱动 = 生产按钮的真实 `click()`（DOM 事件注入）；不触碰 src 内部函数。
 */

import { expect, type Page } from '@playwright/test'
import { pollUntil } from '../multiblock'
import { WIKI_EMBED } from './hover'

export const STATS_SIDEBAR = `${WIKI_EMBED} .nei-sidebar`
export const STATS_TOOLBAR = `${WIKI_EMBED} .nei-stats-toolbar`
export const STATS_VIEW_BTN = (view: string) => `${WIKI_EMBED} [data-stats-view-btn="${view}"]`
export const STATS_PILL = `${WIKI_EMBED} .nei-stats-prov-pill`
export const STATS_PROV_PANEL = `${WIKI_EMBED} [data-stats-provenance]`
export const STATS_ROWS = `${WIKI_EMBED} .nei-slot-row`

export interface StatsRowObservation {
  /** 行身份键（部件 = typeKey / 物品身份键；宿主 = 宿主键）。旧路径行 = null。 */
  key: string | null
  /** 'part' | 'host' | null（旧路径行无此属性）。 */
  kind: string | null
  /** 图标键（P2.4 图标断言的观测点）。旧路径行 = null。 */
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
  /** 部件模式工具条是否渲染（无部件旧文件必须为 false）。 */
  toolbar: boolean
  /** 视图按钮（id + 激活态）。 */
  viewButtons: Array<{ id: string; active: boolean }>
  /** 配置来源徽标（不存在 = 旧路径）。 */
  pill: { text: string; source: string | null } | null
  /** 「N 个无物品部件未计入清单」提示行（无 ⇒ null）。 */
  itemless: string | null
  rows: StatsRowObservation[]
}

/** 读侧栏完整观测（DOM 原样，不做任何归一化假设）。 */
export async function readStatsSidebar(page: Page): Promise<StatsSidebarObservation> {
  return await page.evaluate(() => {
    const sidebar = document.querySelector('.wb-wiki-embed .nei-sidebar')
    if (!sidebar) {
      return { present: false, collapsed: false, toolbar: false, viewButtons: [], pill: null, itemless: null, rows: [] }
    }
    const rows = [...sidebar.querySelectorAll('.nei-slot-row')].map((r) => ({
      key: r.getAttribute('data-stats-row-key'),
      kind: r.getAttribute('data-stats-row-kind'),
      iconKey: r.getAttribute('data-stats-icon-key'),
      name: (r.querySelector('.nei-slot-name')?.textContent ?? '').trim(),
      sub: (r.querySelector('.nei-slot-id')?.textContent ?? '').trim(),
      qty: (r.querySelector('.nei-slot-qty')?.textContent ?? '').trim(),
    }))
    const pillEl = sidebar.querySelector('.nei-stats-prov-pill')
    return {
      present: true,
      collapsed: sidebar.classList.contains('nei-sidebar--collapsed'),
      toolbar: !!sidebar.querySelector('.nei-stats-toolbar'),
      viewButtons: [...sidebar.querySelectorAll('[data-stats-view-btn]')].map((b) => ({
        id: b.getAttribute('data-stats-view-btn') ?? '',
        active: b.getAttribute('aria-selected') === 'true',
      })),
      pill: pillEl
        ? { text: (pillEl.textContent ?? '').trim(), source: pillEl.getAttribute('data-stats-source') }
        : null,
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

/**
 * 切统计视图（生产按钮真实 click）。等待激活态落定后返回最新侧栏观测。
 * 视图切换会写查看者本地层（localStorage）—— provenance 断言依赖这一生产语义。
 */
export async function switchStatsView(
  page: Page,
  view: 'parts' | 'hosts' | 'custom',
  timeout = 15_000,
): Promise<StatsSidebarObservation> {
  // 轮询内自愈：窄布局重挂载可能把侧栏折回（见 expandSidebarSelfHealing），
  // 因此「展开 → 按钮在 → 点击 → 激活」整个链条都放进取值条件里。
  // 重复点击同一视图按钮是幂等的（setView 写同值，不影响断言）。
  const trace: string[] = []
  try {
    return await pollUntil(
      async () => {
        const s = await expandSidebarSelfHealing(page)
        if (!s || !s.toolbar) {
          trace.push(`not-ready collapsed=${s?.collapsed} toolbar=${s?.toolbar}`)
          return null
        }
        const btn = page.locator(STATS_VIEW_BTN(view))
        if ((await btn.count()) === 0) {
          trace.push('btn-missing')
          return null
        }
        // dispatchEvent 而非 click()：800px 嵌入预览在移动视口被裁（同折叠按钮的口径）
        await btn.dispatchEvent('click')
        const after = await readStatsSidebar(page)
        const storage = await page.evaluate(
          (prefix) => {
            const out: string[] = []
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i)!
              if (k.startsWith(prefix)) out.push(`${k}=${localStorage.getItem(k)}`)
            }
            return out
          },
          'lightning:stats:v1:',
        )
        const active = after.viewButtons.find((b) => b.id === view)?.active === true && !after.collapsed
        if (!active) {
          trace.push(
            `clicked-not-active active=${after.viewButtons.find((b) => b.active)?.id ?? 'none'} ` +
              `collapsed=${after.collapsed} storage=${JSON.stringify(storage)}`,
          )
        }
        return active ? after : null
      },
      `统计视图切换到 ${view}`,
      timeout,
    )
  } catch (e) {
    throw new Error(
      `${(e as Error).message}\n[switchStatsView trace] ${trace.slice(-6).join(' | ') || '<empty>'}`,
    )
  }
}

export interface ProvenanceObservation {
  /** 徽标（常驻） */
  pill: { text: string; source: string | null } | null
  /** 展开面板逐字段行（field → source/text）；未展开 = null */
  panel: Array<{ field: string; source: string | null; sourceText: string }> | null
  /** 「清除本机修改」按钮是否存在 */
  hasReset: boolean
}

/** 读配置来源（徽标 + 可选展开面板）。`openPanel=true` 时先点徽标展开（生产 click）。 */
export async function readProvenance(page: Page, openPanel: boolean, timeout = 15_000): Promise<ProvenanceObservation> {
  if (openPanel) {
    // 窄布局自愈：先保证展开态且徽标存在，再点徽标展开 provenance 面板
    await pollUntil(
      async () => {
        const s = await expandSidebarSelfHealing(page)
        if (!s || !s.pill) return null
        await page.locator(STATS_PILL).dispatchEvent('click')
        const panel = page.locator(STATS_PROV_PANEL)
        return (await panel.count()) > 0 ? s : null
      },
      'provenance 面板展开',
      timeout,
    )
  }
  return await page.evaluate(() => {
    const pillEl = document.querySelector('.wb-wiki-embed .nei-stats-prov-pill')
    const panelEl = document.querySelector('.wb-wiki-embed [data-stats-provenance]')
    return {
      pill: pillEl
        ? { text: (pillEl.textContent ?? '').trim(), source: pillEl.getAttribute('data-stats-source') }
        : null,
      panel: panelEl
        ? [...panelEl.querySelectorAll('[data-stats-prov-field]')].map((r) => ({
            field: r.getAttribute('data-stats-prov-field') ?? '',
            source: r.getAttribute('data-stats-prov-source'),
            sourceText: (r.querySelector('.nei-stats-prov-source')?.textContent ?? '').trim(),
          }))
        : null,
      hasReset: !!document.querySelector('.wb-wiki-embed [data-stats-reset-local]'),
    }
  })
}

// ---------------------------------------------------------------------------
// 部件行图标槽（F2：嵌入图标纹理通道的**生产可观测结果**）
// ---------------------------------------------------------------------------

export interface StatsRowIconObservation {
  /** 行身份键（同 `StatsRowObservation.key`）。 */
  key: string | null
  /** 'part' | 'host' | null。 */
  kind: string | null
  /** 图标键（部件行 = 物品身份键 `registry:damage[#nbt]`）。 */
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
        kind: r.getAttribute('data-stats-row-kind'),
        iconKey: r.getAttribute('data-stats-icon-key'),
        hasCanvas: !!canvas,
        canvasWidth: canvas?.width ?? 0,
        canvasHeight: canvas?.height ?? 0,
      }
    })
  })
}

/**
 * 等「图标键在给定集合内的**部件行**」全部渲染出 canvas（图标烘焙是异步的：base64 解码
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
    const partRows = last.filter((r) => r.kind === 'part')
    const pending = partRows.filter(
      (r) => r.iconKey !== null && covered.has(r.iconKey) && !r.hasCanvas,
    )
    if (partRows.length > 0 && pending.length === 0) return last
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
