import { ref, watch } from 'vue'
import type { AppLanguage, AppTheme, ShellSettings } from '@/runtime/contextAccess'
import { bindI18nLang, setLang } from '@/config/i18n'

const WB_THEME_KEY = 'wb-theme'
const WB_LANG_KEY = 'wsr-wb-lang'
const WB_THEME_ATTR = 'data-wb-theme'
const NEI_THEME_ATTR = 'data-nei-theme'

export type ShellThemeSurface = 'workbench' | 'embed'

export interface CreateShellSettingsOptions {
  /** workbench: data-wb-theme + localStorage；embed: data-nei-theme，不写 theme 存储 */
  surface?: ShellThemeSurface
  /** 覆盖初始主题（embed mount 已写 DOM 时用） */
  initialTheme?: AppTheme
  initialLang?: AppLanguage
}

function loadTheme(surface: ShellThemeSurface): AppTheme {
  if (surface === 'embed') {
    if (typeof document !== 'undefined') {
      const v = document.documentElement.getAttribute(NEI_THEME_ATTR)
        ?? document.documentElement.dataset.neiTheme
      if (v === 'light' || v === 'dark') return v
    }
    return 'dark'
  }
  try {
    const v = localStorage.getItem(WB_THEME_KEY)
    if (v === 'light' || v === 'dark') return v
  } catch { /* noop */ }
  return 'dark'
}

function loadLang(): AppLanguage {
  try {
    const v = localStorage.getItem(WB_LANG_KEY)
    if (v === 'zh' || v === 'en') return v
  } catch { /* noop */ }
  return 'zh'
}

function applyTheme(surface: ShellThemeSurface, t: AppTheme): void {
  if (typeof document === 'undefined') return
  if (surface === 'embed') {
    document.documentElement.setAttribute(NEI_THEME_ATTR, t)
    document.documentElement.dataset.neiTheme = t
  } else {
    document.documentElement.setAttribute(WB_THEME_ATTR, t)
  }
}

export function createShellSettings(opts: CreateShellSettingsOptions = {}): ShellSettings {
  const surface = opts.surface ?? 'workbench'
  const theme = ref<AppTheme>(opts.initialTheme ?? loadTheme(surface))
  const lang = ref<AppLanguage>(opts.initialLang ?? loadLang())

  applyTheme(surface, theme.value)
  bindI18nLang(lang)
  setLang(lang.value)

  watch(theme, (t) => {
    applyTheme(surface, t)
    if (surface === 'workbench') {
      try { localStorage.setItem(WB_THEME_KEY, t) } catch { /* noop */ }
    }
  })

  watch(lang, (l) => {
    setLang(l)
    if (surface === 'workbench') {
      try { localStorage.setItem(WB_LANG_KEY, l) } catch { /* noop */ }
    }
  })

  return { theme, lang }
}
