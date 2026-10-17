const LS_KEY_LEFT = 'wsr-wb-left-w'
const LS_KEY_RIGHT = 'wsr-wb-right-w'
export const DEFAULT_PANEL_LEFT = 220
export const DEFAULT_PANEL_RIGHT = 300

function readPersisted(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key)
    if (v !== null) {
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) return n
    }
  } catch { /* noop */ }
  return fallback
}

export function readPersistedPanelWidths(): { leftWidth: number; rightWidth: number } {
  return {
    leftWidth: readPersisted(LS_KEY_LEFT, DEFAULT_PANEL_LEFT),
    rightWidth: readPersisted(LS_KEY_RIGHT, DEFAULT_PANEL_RIGHT),
  }
}

export function writePersistedPanelWidth(side: 'left' | 'right', val: number): void {
  const key = side === 'left' ? LS_KEY_LEFT : LS_KEY_RIGHT
  try { localStorage.setItem(key, String(Math.round(val))) } catch { /* noop */ }
}
