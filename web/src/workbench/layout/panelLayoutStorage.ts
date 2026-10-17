const LS_KEY_LEFT = 'wsr-wb-left-w'
const LS_KEY_RIGHT = 'wsr-wb-right-w'
/**
 * 左栏默认宽度。
 *
 * M3-shell B1：这里的 220 是旧「左面板」的预留值 —— 那个面板从未渲染
 * （`leftWidth` 全树零消费），于是 220 只是死默认。本批把左栏接成
 * **工具架**（Blender 式窄栏），默认改 56（36px 工具按钮 + 左右内边距）；
 * 拖拽下限仍是 `panelResize.MIN_LEFT = 48`。
 */
export const DEFAULT_PANEL_LEFT = 56
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
