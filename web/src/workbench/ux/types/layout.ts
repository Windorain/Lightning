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

/**
 * 属性占位项。
 *
 * **`widget?` 字段已删除**（#253 P2，退役 #3）：布局里写死控件名，与
 * `PropertyDescriptor.uiWidget` 构成两处「控件名进核心」的入口（#251 B7 的 E-4：
 * 该字段**零读者** —— `pure/layout.ts` 从不读它，`RNAWidget` 也不读）。
 * 控件选择现由 `@/editors/property-controls` 的 `modelFor(desc)` 从 RNA 描述求值。
 *
 * 本项保留在布局类型里仅为兼容只读片段表达；真正的属性行由 `PropertyInspector`
 * 从 RNA 声明生成（`ReadonlyLayout` **不实现** `property` 分支）。
 */
export interface UIProperty {
  kind: 'property'
  rnaPath: string
  label: string
  icon?: string
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
  /** Render text as innerHTML instead of text content (for tooltip preview etc.) */
  html?: boolean
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
