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

export type UILayoutItem = UILayout | UIProperty | UIOperator | UILabel | UISeparator | UIMenu

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
