/**
 * Wiki 嵌入：当正文列比模板设计宽度窄时，等比缩小挂载盒（真实 px，不用 transform）。
 */

const HOST_CLASS = 'wsr-fit-host'
const FIT_MARGIN_PX = 16
const DEFAULT_DESIGN_W = 800
const DEFAULT_DESIGN_H = 600

export function parseMobileFitEnabled(el: HTMLElement): boolean {
  const v = el.getAttribute('data-wsr-mobile-fit')
  if (v == null || v === '') return true
  const t = v.trim().toLowerCase()
  if (t === '0' || t === 'false' || t === 'no') return false
  return true
}

function readInlinePx(el: HTMLElement, dim: 'width' | 'height'): number | null {
  const inline = el.style[dim]
  if (!inline) return null
  const m = /^([\d.]+)\s*px$/i.exec(inline.trim())
  if (!m) return null
  const n = parseFloat(m[1])
  return n > 0 && Number.isFinite(n) ? n : null
}

function getDesignSize(mountEl: HTMLElement): { w: number; h: number } {
  const storedW = mountEl.dataset.wsrDesignWidth
  const storedH = mountEl.dataset.wsrDesignHeight
  if (storedW && storedH) {
    const w = parseFloat(storedW)
    const h = parseFloat(storedH)
    if (w > 0 && h > 0) return { w, h }
  }
  const parsedW = parseFloat(getComputedStyle(mountEl).width)
  const parsedH = parseFloat(getComputedStyle(mountEl).height)
  const w = readInlinePx(mountEl, 'width') ?? (parsedW > 0 ? parsedW : DEFAULT_DESIGN_W)
  const h = readInlinePx(mountEl, 'height') ?? (parsedH > 0 ? parsedH : DEFAULT_DESIGN_H)
  mountEl.dataset.wsrDesignWidth = String(Math.max(1, w))
  mountEl.dataset.wsrDesignHeight = String(Math.max(1, h))
  return { w: Math.max(1, w), h: Math.max(1, h) }
}

function availWidthForHost(host: HTMLElement): number {
  const parent = host.parentElement
  if (parent && parent.clientWidth > 0) return parent.clientWidth
  return document.documentElement.clientWidth
}

function notifyFitChange(): void {
  window.dispatchEvent(new CustomEvent('wsr-fit-change'))
}

function restoreDesignSize(
  host: HTMLElement,
  mountEl: HTMLElement,
  designW: number,
  designH: number,
): void {
  host.style.width = ''
  host.style.height = ''
  mountEl.style.width = `${designW}px`
  mountEl.style.height = `${designH}px`
  mountEl.style.transform = ''
  mountEl.style.transformOrigin = ''
  mountEl.removeAttribute('data-wsr-fit-scale')
}

/**
 * mount 前调用；返回清理函数（测试 / HMR 用）。
 */
export function ensureMobileFitHost(mountEl: HTMLElement): () => void {
  if (!parseMobileFitEnabled(mountEl)) return () => {}

  let host = mountEl.parentElement
  if (!host?.classList.contains(HOST_CLASS)) {
    host = document.createElement('div')
    host.className = HOST_CLASS
    mountEl.parentNode?.insertBefore(host, mountEl)
    host.appendChild(mountEl)
  }

  let parentRo: ResizeObserver | null = null

  const apply = (): void => {
    const { w: designW, h: designH } = getDesignSize(mountEl)
    const avail = Math.max(1, availWidthForHost(host!) - FIT_MARGIN_PX)

    if (avail >= designW) {
      restoreDesignSize(host!, mountEl, designW, designH)
      notifyFitChange()
      return
    }

    const s = avail / designW
    const fitW = Math.round(designW * s)
    const fitH = Math.round(designH * s)
    host!.style.width = `${fitW}px`
    host!.style.height = `${fitH}px`
    mountEl.style.width = `${fitW}px`
    mountEl.style.height = `${fitH}px`
    mountEl.style.transform = ''
    mountEl.style.transformOrigin = ''
    mountEl.setAttribute('data-wsr-fit-scale', String(s))
    notifyFitChange()
  }

  apply()

  const onResize = (): void => apply()
  window.addEventListener('resize', onResize)

  const parent = host.parentElement
  if (parent) {
    parentRo = new ResizeObserver(() => apply())
    parentRo.observe(parent)
  }

  return () => {
    window.removeEventListener('resize', onResize)
    parentRo?.disconnect()
    const { w, h } = getDesignSize(mountEl)
    restoreDesignSize(host!, mountEl, w, h)
  }
}
