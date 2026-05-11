import { ref, watch } from 'vue'

export type NeiTheme = 'light' | 'dark'

const STORAGE_KEY = 'nei-theme'
const ATTR = 'data-nei-theme'

function readStored(): NeiTheme {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark') return v
  } catch { /* noop */ }
  return 'dark'
}

function applyTheme(t: NeiTheme): void {
  document.documentElement.setAttribute(ATTR, t)
}

const theme = ref<NeiTheme>(readStored())

// 初始应用
applyTheme(theme.value)

watch(theme, (t) => {
  applyTheme(t)
  try { localStorage.setItem(STORAGE_KEY, t) } catch { /* noop */ }
})

export function useNeiTheme() {
  function toggleTheme(): void {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
  }

  return { theme, toggleTheme }
}
