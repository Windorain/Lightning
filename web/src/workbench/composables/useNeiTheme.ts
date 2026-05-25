import { ref, watch } from 'vue'

export type NeiTheme = 'light' | 'dark'

const STORAGE_KEY = 'wb-theme'
const ATTR = 'data-wb-theme'

function readStored(): NeiTheme {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark') return v
  } catch { /* noop */ }
  return 'dark'
}

function applyTheme(t: NeiTheme): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute(ATTR, t)
  }
}

const theme = ref<NeiTheme>(readStored())

// 初始应用 (only in browser)
if (typeof document !== 'undefined') {
  applyTheme(theme.value)
}

watch(theme, (t) => {
  applyTheme(t)
  try { localStorage.setItem(STORAGE_KEY, t) } catch { /* noop */ }
})

/** Module-level toggle for use outside Vue components (operators, node) */
export function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
}

export function useNeiTheme() {
  return { theme, toggleTheme }
}

export { theme }
