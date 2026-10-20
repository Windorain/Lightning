/**
 * 纯函数：由格点、当帧体素体与 tooltipPalette 解析悬停文本。
 * 无 Vue / Three.js / DOM 依赖。
 *
 * ## 本文件返回**文本**，不返回 HTML（#259 A32）
 *
 * 改动前，本文件的回退分支调用 `renderTooltipHtml(...)` 把宿主 NEI 行转成
 * **HTML 串**，再由 `ToolTipBox` 的 `v-html` 注入。现在解析统一发生在呈现边界
 * （`editors/ContentText.vue` → `domain/textContent.ts`）：本文件只负责
 * "该显示哪段文本"这个**领域**问题，不负责"这段文本能变成什么标记"这个
 * **呈现/安全**问题。职责分开后，MC 颜色码与 Markdown 的允许规则只有一处。
 */

import { TOOLTIP_GRID_NONE, type StructureDefinition } from '@/render/schema/types'

// ---- 纯类型定义（无框架依赖） ----

export type TooltipHoverSource = 'viewport' | 'sidebar'

export interface VoxelWithTooltip {
  column: number
  row: number
  zSlice: number
}

export interface PreviewTooltipHover {
  blockId: string
  clientX: number
  clientY: number
  source: TooltipHoverSource
  /** viewport 悬停时提供，与 `cellGrid[z][r][c]` 一致；侧栏不填，不显示 ToolTip */
  voxel?: VoxelWithTooltip
}

/**
 * 部件悬停信息快照（P2.2）：命中部件时由拾取链携带。
 * `tooltip` 为导出时按契约 §8 优先级链生成完毕的最终行，web 只展示、不重放生成逻辑。
 */
export interface PartTooltipInfo {
  /** 格内定位（契约 §4，`<族>:<族内定位符>`），调试/归属用 */
  localId: string
  /** 部件显示名（尊重游戏内显示名） */
  displayName: string
  /** 部件说明行（导出时已生成完毕） */
  tooltip: readonly string[]
}

/**
 * 视口悬停说明链输入（契约 §8 + P2.2 拍板）。
 */
export interface ViewportTooltipChainInput {
  /** 逐格人工说明（`cellTooltipGrid`/`tooltipPalette` 叠加层；`''` = 无） */
  cellText: string
  /** 部件命中信息（null = 宿主格命中或无部件格） */
  part: PartTooltipInfo | null
  /** 宿主方块 NEI 说明行（blockPalette 条目 tooltip） */
  hostNeiLines: readonly string[] | undefined
}

// ---- 纯函数 ----

/**
 * 由格点、当帧体素体与 `tooltipPalette` 得悬停文本；无有效映射或空文案则 `''`（不读 blockPalette / registryId）。
 */
export function resolvePreviewTooltipText(
  def: StructureDefinition,
  tooltipPalette: readonly string[],
  h: PreviewTooltipHover | null,
): string {
  if (!h) return ''
  if (h.source === 'sidebar') return ''
  const voxel = h.voxel
  if (!voxel) return ''
  if (tooltipPalette.length === 0) return ''

  const g = def.cellTooltipGrid
  if (g == null) return ''

  const { zSlice, row, column } = voxel
  const cell = g[zSlice]?.[row]?.[column]
  if (cell === undefined || cell === null) return ''
  if (typeof cell !== 'number' || !Number.isFinite(cell)) return ''
  if (cell < 0 || cell === TOOLTIP_GRID_NONE) return ''
  return tooltipPalette[cell] ?? ''
}

/**
 * 视口悬停说明优先级链（P2.2 拍板，契约 §8 末段的 web 侧实现）：
 *
 * ```
 * 逐格人工说明（叠加层，有则优先，标题取部件 displayName / 宿主 NEI 首行）
 *   → 部件说明（部件命中时；导出时已生成完毕，web 只展示；标题 = displayName，
 *      附「位于 <宿主名>」归属标注，视觉难区分时可辨认部件归属——计划 §4 建议）
 *   → 宿主 NEI 首行回退（既有行为，任何情况有话说）
 * ```
 *
 * 两条链不互相替代：逐格说明是人工叠加层，部件说明是部件命中的回退。
 * `part == null` 时输出与 P2.2 前的既有行为逐字节一致（回归锁定）。
 */
export function resolveViewportTooltipChain(input: ViewportTooltipChainInput): string {
  const { cellText, part, hostNeiLines } = input

  // ① 逐格人工说明（叠加层优先；标题 = 部件 displayName ?? 宿主 NEI 首行）
  if (cellText) {
    const nameLine = part ? part.displayName : hostNeiLines?.[0]
    if (nameLine) {
      const nl = cellText.indexOf('\n')
      const first = nl >= 0 ? cellText.slice(0, nl) : cellText
      if (first !== nameLine) return nameLine + '\n' + cellText
    }
    return cellText
  }

  // ② 部件说明（部件命中；导出时已生成完毕的最终行，只展示）
  if (part) {
    const lines = part.tooltip.filter((l) => l.length > 0)
    const out: string[] = []
    if (lines.length === 0 || lines[0] !== part.displayName) {
      if (part.displayName) out.push(part.displayName)
    }
    out.push(...lines)
    // 归属标注：宿主名与部件名不同才附（单盒方块宿主即部件自身时不附，避免噪音）
    const hostName = hostNeiLines?.[0]
    if (out.length > 0 && hostName && hostName !== part.displayName) {
      out.push(`位于 ${hostName}`)
    }
    if (out.length > 0) return out.join('\n')
    // 部件说明为空 ⇒ 继续落宿主回退（任何情况有话说）
  }

  // ③ 宿主 NEI 首行回退（既有行为不变）
  //
  // 注意：这里返回**原文**（不是 HTML 串）。改动前是
  // `renderTooltipHtml(hostNeiLines[0])`，产出 HTML 交 `v-html`；
  // 现在整条链路上的文本都由呈现边界统一解析（#259 A32）。
  if (hostNeiLines && hostNeiLines.length > 0) return hostNeiLines[0]!
  return ''
}
