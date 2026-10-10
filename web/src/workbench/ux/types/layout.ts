export type UILayout = UIRow | UIColumn | UIBox | UISplit | UIPanel | UIScroll

/** Layout containers that have an `items` array (all except UISplit) */
export type LayoutWithItems = UIRow | UIColumn | UIBox | UIPanel | UIScroll

export function hasLayoutItems(layout: UILayout): layout is LayoutWithItems {
  return layout.kind !== 'split'
}

const LAYOUT_KINDS = new Set(['row', 'column', 'box', 'split', 'panel', 'scroll'])

export function isLayoutContainer(item: UILayoutItem): item is UILayout {
  if (typeof item !== 'object' || item === null) return false
  return LAYOUT_KINDS.has((item as { kind?: string }).kind as string)
}

export interface UIRow {
  kind: 'row'
  align: boolean
  items: UILayoutItem[]
}

export interface UIColumn {
  kind: 'column'
  align: boolean
  items: UILayoutItem[]
}

export interface UIBox {
  kind: 'box'
  label: string
  items: UILayoutItem[]
}

export interface UISplit {
  kind: 'split'
  percentage: number
  left: UILayout
  right: UILayout
}

export interface UIPanel {
  kind: 'panel'
  id: string
  label: string
  icon?: string
  collapsed: boolean
  items: UILayoutItem[]
}

export interface UIScroll {
  kind: 'scroll'
  items: UILayoutItem[]
}

export type UILayoutItem = UILayout | UIProperty | UIOperator | UILabel | UISeparator | UIMenu | UIWidget

export interface UIProperty {
  kind: 'property'
  rnaPath: string
  label: string
  icon?: string
  widget?: 'text' | 'number' | 'slider' | 'stepper' | 'stepper-compact' | 'checkbox' | 'dropdown' | 'color' | 'vector'
}

export interface UIOperator {
  kind: 'operator'
  id: string
  label: string
  icon?: string
  title?: string
  props?: Record<string, unknown>
}

export interface UILabel {
  kind: 'label'
  text: string
  icon?: string
  /**
   * Render text as sanitized content instead of plain text (for tooltip preview etc.).
   *
   * 改动（#259 A32）：旧字段名是 `html`，语义是"把 `text` 原样当 HTML 注入"
   * （`UIRenderer` 里 `h('span', { innerHTML: item.text })`）。那是一条
   * **声明式的 HTML 直通**：任何进入 layout 的字符串都能变成标记。
   * 现在该开关的含义收窄为"经公共受控呈现边界解析（Markdown + MC 码 → 受控节点）"，
   * 不再存在 innerHTML 通路。字段改名为 `content`，使旧调用点必须显式改动
   * （避免"字段还在、语义已换"的静默迁移）。
   */
  content?: boolean
  /** Override default CSS class */
  class?: string
}

export interface UISeparator {
  kind: 'separator'
}

export interface UIMenu {
  kind: 'menu'
  label: string
  icon?: string
  items: (UIOperator | UILabel | UISeparator)[]
}

export interface UIWidget {
  kind: 'widget'
  widget: string
  props?: Record<string, unknown>
}
