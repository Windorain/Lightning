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

function load(storageKey: string): ViewerPreferences {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch { /* ignore corrupt data */ }
  return { ...DEFAULTS }
}

/** 为 Screen 树 Region 节点创建 viewer 偏好（reactive + 按 region 分键持久化） */
export function createViewerPreferences(storageKey = 'lightning.prefs'): ViewerPreferences {
  const prefs = reactive(load(storageKey)) as ViewerPreferences
  watch(
    prefs,
    (val) => {
      try { localStorage.setItem(storageKey, JSON.stringify(val)) } catch { /* */ }
    },
    { deep: true },
  )
  return prefs
}
