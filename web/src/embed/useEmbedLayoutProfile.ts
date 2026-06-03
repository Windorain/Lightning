import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'

export type EmbedLayoutProfile = 'desktop' | 'narrow' | 'tiny'

export type EmbedMobileProfileMode = 'auto' | 'desktop' | 'compact'

const NARROW_MAX = 640
const TINY_MAX = 400

export function parseMobileProfileAttr(
  el: HTMLElement | null | undefined,
): EmbedMobileProfileMode {
  const v = el?.getAttribute('data-wsr-mobile-profile')?.trim().toLowerCase()
  if (v === 'desktop' || v === 'compact') return v
  return 'auto'
}

function profileFromWidth(w: number, mode: EmbedMobileProfileMode): EmbedLayoutProfile {
  if (mode === 'desktop') return 'desktop'
  if (mode === 'compact') return w < TINY_MAX ? 'tiny' : 'narrow'
  if (w < TINY_MAX) return 'tiny'
  if (w < NARROW_MAX) return 'narrow'
  return 'desktop'
}

/**
 * 按挂载容器（.web-structure-renderer）宽度切换 layout profile，供 CSS / 默认侧栏折叠。
 */
export function useEmbedLayoutProfile(
  rootRef: Ref<HTMLElement | null | undefined>,
  options?: { onProfile?: (p: EmbedLayoutProfile) => void },
) {
  const profile = ref<EmbedLayoutProfile>('desktop')
  const mode = ref<EmbedMobileProfileMode>('auto')
  let ro: ResizeObserver | null = null

  const layoutClass = computed(() => `wsr-layout-${profile.value}`)

  function effectiveLayoutWidth(mount: HTMLElement | null, root: HTMLElement): number {
    if (mount && mount.clientWidth > 0) return mount.clientWidth
    const host = mount?.parentElement
    if (host?.classList.contains('wsr-fit-host') && host.clientWidth > 0) {
      return host.clientWidth
    }
    return root.clientWidth
  }

  function measure(): void {
    const root = rootRef.value
    if (!root) return
    const mount = root.closest('.web-structure-renderer') as HTMLElement | null
    mode.value = parseMobileProfileAttr(mount)
    const w = effectiveLayoutWidth(mount, root)
    const next = profileFromWidth(w, mode.value)
    if (next !== profile.value) {
      profile.value = next
      options?.onProfile?.(next)
    }
  }

  watch(
    rootRef,
    (el, _prev, onCleanup) => {
      ro?.disconnect()
      ro = null
      if (!el) return
      measure()
      const mount = el.closest('.web-structure-renderer') as HTMLElement | null
      const host = mount?.parentElement?.classList.contains('wsr-fit-host')
        ? mount.parentElement
        : null
      ro = new ResizeObserver(() => measure())
      if (host) ro.observe(host)
      else if (mount) ro.observe(mount)
      else ro.observe(el)
      const parent = (host ?? mount)?.parentElement
      if (parent) ro.observe(parent)
      onCleanup(() => {
        ro?.disconnect()
        ro = null
      })
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    ro?.disconnect()
    window.removeEventListener('wsr-fit-change', measure)
  })

  if (typeof window !== 'undefined') {
    window.addEventListener('wsr-fit-change', measure)
  }

  return { profile, layoutClass, mode }
}
