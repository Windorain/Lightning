import { reactive, watch } from 'vue'

export interface ViewerPreferences {
  highlightOnHover: boolean
  showHoverTooltip: boolean
  showAnnotations: boolean
  tooltipOffset: number
}

const DEFAULTS: ViewerPreferences = {
  highlightOnHover: true,
  showHoverTooltip: true,
  showAnnotations: true,
  tooltipOffset: 12,
}

const STORAGE_KEY = 'lightning.prefs'

function load(): ViewerPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch { /* ignore corrupt data */ }
  return { ...DEFAULTS }
}

/** 为 Screen 树 Region 节点创建 viewer 偏好（reactive + 持久化） */
export function createViewerPreferences(): ViewerPreferences {
  const prefs = reactive(load()) as ViewerPreferences
  watch(
    prefs,
    (val) => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(val)) } catch { /* */ }
    },
    { deep: true },
  )
  return prefs
}

