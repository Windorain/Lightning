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

/**
 * 为 Screen 树 Region 节点创建 viewer 偏好（reactive + 按实例/region 分键持久化）。
 *
 * `storageKey` 由装配层按**实例**给出（`runtime/instanceStorage#instanceUiKey`）——
 * 本模块不认识实例身份，也不该认识：同页两个嵌入各持自己的键，
 * 于是"改 A 的偏好、新实例读默认"是键形态的后果，不是运行期判断的后果。
 *
 * `flush: 'sync'`：持久化必须与变更**同拍**完成（与 `runtime/shellSettings` 同一纪律）。
 * 默认的 `flush: 'pre'` 把写入推到下一微任务 ⇒ "改设置 → 立刻重挂/读存储"会读到旧值；
 * 该竞态在单测里实测复现（e2e 的 300ms 等待把它掩盖了）。
 */
export function createViewerPreferences(storageKey = 'lightning.prefs'): ViewerPreferences {
  const prefs = reactive(load(storageKey)) as ViewerPreferences
  watch(
    prefs,
    (val) => {
      try { localStorage.setItem(storageKey, JSON.stringify(val)) } catch { /* */ }
    },
    { deep: true, flush: 'sync' },
  )
  return prefs
}
