import { reactive, watch } from 'vue'

export interface ViewerPreferences {
  /** 鼠标悬浮时高亮方块 */
  highlightOnHover: boolean
  /** 鼠标悬浮时弹出物品名称提示框 */
  showHoverTooltip: boolean
}

const DEFAULTS: ViewerPreferences = {
  highlightOnHover: true,
  showHoverTooltip: true,
}

const STORAGE_KEY = 'lightning.prefs'

function load(): ViewerPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch { /* ignore corrupt data */ }
  return { ...DEFAULTS }
}

let _instance: ViewerPreferences | null = null

export function usePreferences(): ViewerPreferences {
  if (!_instance) {
    _instance = reactive(load()) as ViewerPreferences
    watch(
      () => ({ ..._instance }),
      (val) => { localStorage.setItem(STORAGE_KEY, JSON.stringify(val)) },
      { deep: true },
    )
  }
  return _instance
}
