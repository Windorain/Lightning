/**
 * 区分「屏幕/笔」直接操作 vs 鼠标/触控板。
 * 笔记本电容屏手指 → `touch`；触控笔 → `pen`。
 *
 * 开发：`?touchSim=1` 时用 Alt+鼠标走同一套触控 handler（无需真机）。
 */

let touchSimActive = false

/** 本地 dev：URL `?touchSim=1` 或挂载点 `data-wsr-touch-sim="1"` */
export function initEmbedTouchSim(root?: Element | null): boolean {
  if (!import.meta.env.DEV) {
    touchSimActive = false
    return false
  }
  const params = new URLSearchParams(location.search)
  const fromUrl = params.has('touchSim') || params.get('touchSim') === '1'
  const mount = root ?? document.querySelector('.web-structure-renderer')
  const fromAttr = mount?.getAttribute('data-wsr-touch-sim') === '1'
  touchSimActive = fromUrl || fromAttr
  if (touchSimActive) {
    document.documentElement.dataset.wsrTouchSim = '1'
  }
  return touchSimActive
}

export function isTouchSimActive(): boolean {
  return touchSimActive
}

/** Alt+鼠标模拟触屏（仅 touchSim 开启时） */
export function isMouseTouchSim(pe: PointerEvent): boolean {
  return touchSimActive && pe.pointerType === 'mouse' && pe.altKey
}

export function isEmbedTouchScreenPointer(pe: PointerEvent): boolean {
  if (pe.pointerType === 'touch' || pe.pointerType === 'pen') return true
  return isMouseTouchSim(pe)
}
