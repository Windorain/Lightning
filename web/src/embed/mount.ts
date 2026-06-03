/**
 * 库入口：挂载 Wiki 结构渲染器（显式 bootstrap，无隐式配置）。
 */

import { createApp } from 'vue'

import EmbedRoot from '@/embed/EmbedRoot.vue'
import { ensureMobileFitHost } from '@/embed/mobileFitHost'
import { initEmbedTouchSim } from '@/embed/touchPointer'

import type { EmbedBootstrapOptions } from './embedContract'

import '@/styles/precision-tokens.css'
import '@/styles/embed-nei-tokens.css'
import '@/styles/embed-mobile.css'
/* Wiki 外壳规则：与 scripts/huiji/StructureRender.css 同源，构建时并入 dist/StructureRender.css 末尾 */
import '../../../scripts/huiji/StructureRender.css'

export function mount(
  target: string | Element | null | undefined,
  options: EmbedBootstrapOptions,
): void {
  const el =
    target == null
      ? document.querySelector('.web-structure-renderer') ??
        document.querySelector('#web-structure-renderer')
      : typeof target === 'string'
        ? document.querySelector(target)
        : target
  if (!el) {
    console.warn(
      '[StructureRenderer] mount: 未找到挂载节点',
      target ?? '.web-structure-renderer / #web-structure-renderer',
    )
    return
  }

  // 主题：options.ui.theme > html[data-nei-theme] > 默认 'dark'
  const theme =
    options.ui?.theme ??
    (document.documentElement.dataset.neiTheme as 'light' | 'dark' | undefined) ??
    'dark'
  document.documentElement.dataset.neiTheme = theme

  const mountEl = el as HTMLElement
  ensureMobileFitHost(mountEl)
  if (import.meta.env.DEV) initEmbedTouchSim(mountEl)
  createApp(EmbedRoot, { bootstrap: options }).mount(mountEl)
}
