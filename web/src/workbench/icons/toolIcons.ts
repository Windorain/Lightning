/**
 * Precision Workshop tool icons.
 * Inline SVG, 24x24 viewBox, 1.5px stroke, round caps/joins.
 */

export type IconState = 'inactive' | 'active' | 'hover'

const stateColors: Record<IconState, string> = {
  inactive: '#56728a',
  active: '#4dabf7',
  hover: '#c5d8e8',
}

const icons = {
  select: `<svg viewBox="0 0 24 24" fill="none" stroke="__COLOR__" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l6 16 2-6 6-2z"/></svg>`,

  move: `<svg viewBox="0 0 24 24" fill="none" stroke="__COLOR__" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M2 12h20"/><path d="M8 4l4-2 4 2M8 20l4 2 4-2M4 8l-2 4 2 4M20 8l2 4-2 4"/></svg>`,

  box: `<svg viewBox="0 0 24 24" fill="none" stroke="__COLOR__" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 12h18M12 3v18"/></svg>`,

  point: `<svg viewBox="0 0 24 24" fill="none" stroke="__COLOR__" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="3 2"/></svg>`,

  line: `<svg viewBox="0 0 24 24" fill="none" stroke="__COLOR__" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20L20 4"/><circle cx="4" cy="20" r="1.5" fill="__COLOR__" stroke="none"/><circle cx="20" cy="4" r="1.5" fill="__COLOR__" stroke="none"/></svg>`,

  text: `<svg viewBox="0 0 24 24" fill="none" stroke="__COLOR__" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M12 7v14"/><path d="M6 21h12"/><path d="M7 3h10l-1 4H8z"/></svg>`,
} as const

export type ToolIconId = keyof typeof icons

export function toolIcon(id: ToolIconId, state: IconState = 'inactive'): string {
  const color = stateColors[state]
  return icons[id].replace(/__COLOR__/g, color)
}
